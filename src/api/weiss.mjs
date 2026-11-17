/**
 * Weiss register-execution boundary.
 *
 * Weiss is an external local tool. This module spawns it directly with
 * shell:false, passes a bounded JSON stdin payload, and captures stdout as the
 * resolved register brief. No caller or model text is ever interpolated into an
 * executable path, argv template, environment variable, or shell command string.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { sha256 } from '../provenance.mjs';

export class WeissRunner {
  constructor({
    executable,
    argv = [],
    workingDirectory = process.cwd(),
    timeoutMs = 10_000,
    maxStdoutBytes = 64 * 1024,
    maxStderrBytes = 4 * 1024,
    versionCommand = null,
    profile = 'default',
  }) {
    if (typeof executable !== 'string' || executable.length === 0) throw new Error('Weiss executable path is required');
    if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) throw new Error('Weiss argv must be an array of strings');
    this.executable = executable;
    this.argv = argv;
    this.workingDirectory = workingDirectory;
    this.timeoutMs = timeoutMs;
    this.maxStdoutBytes = maxStdoutBytes;
    this.maxStderrBytes = maxStderrBytes;
    this.versionCommand = versionCommand;
    this.profile = profile;
    this._versionPromise = null;
  }

  available() {
    return existsSync(this.executable);
  }

  async version() {
    if (!this.versionCommand) return null;
    if (this._versionPromise) return this._versionPromise;
    this._versionPromise = this._captureVersion();
    return this._versionPromise;
  }

  async _captureVersion() {
    const [executable, ...argv] = this.versionCommand;
    return new Promise((resolve) => {
      let output = '';
      const child = spawn(executable, argv, { shell: false, cwd: this.workingDirectory });
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', () => {});
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 5_000);
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', () => { clearTimeout(timer); resolve(output.trim() || null); });
    });
  }

  _boundedStderr(stderr) {
    if (stderr.length <= this.maxStderrBytes) return { stderr };
    return { stderrSha256: sha256(stderr), stderrTruncatedBytes: this.maxStderrBytes };
  }

  /**
   * Run Weiss against the admitted composition context.
   * @param {object} context
   * @param {string} context.prompt
   * @param {string|null} context.titleHint
   * @param {object} context.duration admitted duration object
   * @param {object[]} context.sections admitted sections
   * @param {string[]} context.canonicalVoiceAllowlist
   * @param {object|null} context.packSummary installed pack summary when a pack is admitted
   * @returns {object} execution metadata; `success` is true only on exit 0 with non-empty stdout
   */
  async generate(context) {
    const timestamp = new Date().toISOString();
    const stdin = JSON.stringify({
      requestFormat: 'hb-weiss-register-request/1.0.0',
      prompt: context.prompt,
      titleHint: context.titleHint ?? null,
      duration: context.duration,
      sections: context.sections,
      canonicalVoiceAllowlist: context.canonicalVoiceAllowlist,
      packSummary: context.packSummary,
    });

    return new Promise((resolve) => {
      const child = spawn(this.executable, this.argv, {
        shell: false,
        cwd: this.workingDirectory,
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1_000);
      }, this.timeoutMs);

      child.stdin.write(stdin, 'utf8');
      child.stdin.end();

      child.stdout.on('data', (chunk) => {
        if (stdout.length < this.maxStdoutBytes) {
          stdout = Buffer.concat([stdout, chunk]).subarray(0, this.maxStdoutBytes);
        }
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < this.maxStderrBytes) {
          stderr = Buffer.concat([stderr, chunk]).subarray(0, this.maxStderrBytes);
        }
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          success: false,
          profile: this.profile,
          executable: this.executable,
          argv: this.argv,
          timestamp,
          exitStatus: null,
          stdout: '',
          ...this._boundedStderr(Buffer.from(String(error?.message || 'spawn failed'), 'utf8')),
          timeout: this.timeoutMs,
          timedOut: false,
          version: null,
        });
      });

      child.on('close', async (exitStatus) => {
        clearTimeout(timer);
        const version = await this.version();
        resolve({
          success: !killed && exitStatus === 0 && stdout.length > 0,
          profile: this.profile,
          executable: this.executable,
          argv: this.argv,
          timestamp,
          exitStatus,
          stdout: stdout.toString('utf8'),
          ...this._boundedStderr(stderr),
          timeout: this.timeoutMs,
          timedOut: killed,
          version,
        });
      });
    });
  }
}
