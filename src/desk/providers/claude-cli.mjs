/**
 * Claude CLI provider adapter for the Composer's Desk.
 *
 * Spawns the local `claude` binary in pass-through (`-p`) mode and sends
 * the full composer request as a JSON prompt. Authentication is provided
 * exclusively through the `CLAUDE_CODE_OAUTH_TOKEN` environment variable;
 * this adapter never uses keychain or interactive login.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';

import { CODES } from '../errors.mjs';
import { BaseProvider, normalizeProviderResponse, providerError } from './base.mjs';

async function commandExists(command) {
  const isWindows = platform() === 'win32';
  const candidates = isWindows ? [command, `${command}.exe`, `${command}.cmd`] : [command];
  const pathDirs = (process.env.PATH ?? '').split(isWindows ? ';' : ':').filter(Boolean);
  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      try {
        await access(resolve(dir, candidate), constants.X_OK);
        return true;
      } catch {
        // continue searching
      }
    }
  }
  return false;
}

const RATE_LIMIT_PHRASES = [
  'rate limit',
  'rate-limit',
  'cap',
  'unavailable',
  'capacity',
  'too many requests',
];

function looksRateLimited(text) {
  const lower = text.toLowerCase();
  return RATE_LIMIT_PHRASES.some((phrase) => lower.includes(phrase));
}

export class ClaudeCliProvider extends BaseProvider {
  constructor(profile = {}, env = Object.create(null)) {
    super({
      laneId: profile.id ?? 'claude-cli',
      model: profile.model ?? 'claude-sonnet-5',
      maxTransportAttempts: profile.maxTransportAttempts ?? 3,
      callTimeoutMs: profile.callTimeoutMs ?? 120_000,
      totalDeadlineMs: profile.totalDeadlineMs ?? 300_000,
    });
    this.profile = profile;
    this.env = env;
    this.cliCommand = profile.cliCommand ?? 'claude';
    this.cliArgs = profile.cliArgs ?? ['-p', '--model', this.model];
    this.envVar = profile.envVar ?? 'CLAUDE_CODE_OAUTH_TOKEN';
    this.childEnvVar = profile.childEnvVar ?? 'CLAUDE_CODE_OAUTH_TOKEN';
    this._deadline = null;
  }

  async health() {
    const configured = Boolean(this.env[this.envVar]);
    if (!configured) return 'missing configuration';

    const exists = await commandExists(this.cliCommand);
    return exists ? 'configured' : 'unreachable/limited';
  }

  async generate({ request, signal }) {
    const apiKey = this.env[this.envVar];
    if (!apiKey) {
      throw providerError(CODES.CONFIG_MISSING, `environment variable ${this.envVar} is not set`, { envVar: this.envVar });
    }

    const now = Date.now();
    if (this._deadline === null) this._deadline = now + this.totalDeadlineMs;
    if (now >= this._deadline) {
      throw providerError(CODES.PROVIDER_TIMEOUT, 'total deadline elapsed', { totalDeadlineMs: this.totalDeadlineMs });
    }

    if (signal?.aborted) {
      throw signal.reason ?? new Error('cancelled');
    }

    const prompt = typeof request === 'string' ? request : JSON.stringify(request);
    // Pass the JSON prompt as the final argv argument. shell:false means Node
    // handles escaping, and claude -p concatenates positional args into one
    // prompt. stdin would also work, but argv is less ambiguous for short
    // prompts and avoids the child having to drain stdin before parsing.
    const argv = [...this.cliArgs, prompt];

    const childEnv = { ...process.env, [this.childEnvVar]: apiKey };
    const callTimeout = Math.min(this.callTimeoutMs, this._deadline - now);

    const child = spawn(this.cliCommand, argv, {
      shell: false,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const cleanup = (reason) => {
      try { child.kill(reason === 'timeout' ? 'SIGTERM' : 'SIGKILL'); } catch {}
    };

    const abortHandler = () => cleanup('abort');
    signal?.addEventListener('abort', abortHandler);

    const exitPromise = new Promise((resolve, reject) => {
      child.on('error', (error) => {
        signal?.removeEventListener('abort', abortHandler);
        if (error.code === 'ENOENT') {
          reject(providerError(CODES.PROVIDER_UNREACHABLE, `${this.cliCommand} not found on PATH`, { cause: error.message }));
        } else {
          reject(providerError(CODES.PROVIDER_UNREACHABLE, `failed to spawn ${this.cliCommand}: ${error.message}`, { cause: error.message }));
        }
      });
      child.on('close', (code) => {
        signal?.removeEventListener('abort', abortHandler);
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('cancelled'));
          return;
        }
        if (code !== 0) {
          reject(providerError(CODES.PROVIDER_UNREACHABLE, `${this.cliCommand} exited with code ${code}`, {
            status: code,
            stderr: stderr.slice(0, 500),
          }));
          return;
        }
        if (!stdout || stdout.trim().length === 0) {
          reject(providerError(CODES.PROVIDER_UNREACHABLE, `${this.cliCommand} produced no stdout`, {
            stderr: stderr.slice(0, 500),
          }));
          return;
        }
        if (looksRateLimited(stdout) || looksRateLimited(stderr)) {
          reject(providerError(CODES.PROVIDER_UNREACHABLE, 'provider reports rate limit or unavailability', {
            status: 'unreachable/limited',
            stdout: stdout.slice(0, 500),
            stderr: stderr.slice(0, 500),
          }));
          return;
        }
        resolve(normalizeProviderResponse(stdout));
      });
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup('timeout');
        reject(providerError(CODES.PROVIDER_TIMEOUT, `claude-cli call exceeded ${callTimeout}ms`, { timeoutMs: callTimeout }));
      }, callTimeout);

      exitPromise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
