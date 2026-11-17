/**
 * Composer's Desk Weiss register-authoring boundary (S91).
 *
 * Confirmed CLI shape:
 *   weiss_v0.py PROMPT --backend <backend> [--model <model>] [--arm <arm>]
 *     [--ground-music] [--music-track TITLE ...] --json
 *
 * Success stdout is JSON with a nonempty `reply`. Desk uses only `reply` as
 * brief text and retains backend/model/citations/calibration/music_evidence as
 * provenance. Transport failures exit nonzero; no successful envelope fallback.
 *
 * Local adapter owns a detached process group with SIGTERM→SIGKILL escalation.
 * It does not claim synchronous remote-backend shutdown.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { DeskError, CODES } from './errors.mjs';
import { weissConfig } from './config.mjs';

function nowIso() {
  return new Date().toISOString();
}

function asStringArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

function sanitizeCitation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of ['tag', 'title', 'source_kind', 'source_path', 'id', 'kind', 'confidence_tier', 'source_id']) {
    if (raw[key] != null) out[key] = raw[key];
  }
  return out;
}

function sanitizeMusicEvidence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (raw.selection != null) out.selection = raw.selection;
  if (raw.tracks != null) out.tracks = raw.tracks;
  if (raw.modality_limit != null) out.modality_limit = raw.modality_limit;
  if (raw.correlated_support_limit != null) out.correlated_support_limit = raw.correlated_support_limit;
  return out;
}

function publicProvenance({
  arm,
  backend,
  model,
  citations,
  calibration,
  backend_receipts: backendReceipts,
  music_evidence: musicEvidence,
  exitStatus,
  timedOut,
  timeoutMs,
  timestamp,
  canceled = false,
}) {
  return Object.freeze({
    arm: arm ?? null,
    backend: backend ?? null,
    model: model ?? null,
    citations: Array.isArray(citations) ? citations.map(sanitizeCitation).filter(Boolean) : [],
    ...(calibration !== undefined ? { calibration } : {}),
    ...(Array.isArray(backendReceipts) ? { backend_receipts: backendReceipts.map((receipt) => {
      const out = {};
      for (const key of ['model_usage_ids', 'subtype', 'num_turns']) {
        if (receipt?.[key] != null) out[key] = receipt[key];
      }
      return out;
    }) } : {}),
    ...(musicEvidence != null ? { music_evidence: sanitizeMusicEvidence(musicEvidence) } : {}),
    exitStatus: exitStatus ?? null,
    timedOut: Boolean(timedOut),
    canceled: Boolean(canceled),
    timeoutMs,
    timestamp,
  });
}

function safeFailureDetails(details) {
  const {
    executable,
    script,
    cwd,
    arm,
    backend,
    model,
    groundMusic,
    musicTracks,
    exitStatus,
    timedOut,
    canceled,
    timeoutMs,
    timestamp,
    stderr,
    stdoutPreview,
    cause,
    exists,
  } = details;
  return {
    ...(executable != null ? { executable } : {}),
    ...(script != null ? { script } : {}),
    ...(cwd != null ? { cwd } : {}),
    ...(arm != null ? { arm } : {}),
    ...(backend != null ? { backend } : {}),
    ...(model != null ? { model } : {}),
    ...(groundMusic != null ? { groundMusic } : {}),
    ...(musicTracks != null ? { musicTrackCount: asStringArray(musicTracks).length } : {}),
    ...(exitStatus !== undefined ? { exitStatus } : {}),
    ...(timedOut !== undefined ? { timedOut: Boolean(timedOut) } : {}),
    ...(canceled !== undefined ? { canceled: Boolean(canceled) } : {}),
    ...(timeoutMs != null ? { timeoutMs } : {}),
    ...(timestamp != null ? { timestamp } : {}),
    ...(stderr != null ? { stderr: String(stderr).slice(0, 500) } : {}),
    ...(stdoutPreview != null ? { stdoutPreview: String(stdoutPreview).slice(0, 500) } : {}),
    ...(cause != null ? { cause: String(cause).slice(0, 300) } : {}),
    ...(exists != null ? { exists } : {}),
  };
}

function killProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export class WeissCli {
  constructor(options = {}) {
    const { env, configPath, __resolvedConfig, signal: _signal, ...rest } = options;
    const alreadyResolved = __resolvedConfig
      || (rest.backend != null && rest.executable != null && rest.script != null
        && Object.prototype.hasOwnProperty.call(rest, 'musicTracks'));
    const base = alreadyResolved
      ? {
          model: null,
          groundMusic: false,
          arm: 'primary',
          musicTracks: [],
          timeoutMs: 420_000,
          cwd: rest.cwd,
          ...(__resolvedConfig || rest),
        }
      : weissConfig({
          env: env ?? process.env,
          configPath,
          overrides: rest,
        });

    this.executable = base.executable;
    this.script = base.script;
    this.cwd = base.cwd;
    this.timeoutMs = base.timeoutMs;
    this.arm = base.arm;
    this.backend = base.backend;
    this.model = base.model;
    this.groundMusic = Boolean(base.groundMusic);
    this.musicTracks = asStringArray(base.musicTracks);
  }

  available() {
    if (!this.executable || !this.script) return false;
    return existsSync(this.executable) && existsSync(this.script);
  }

  /**
   * Build argv for the Weiss CLI. Prompt is included for the child only;
   * public provenance never echoes it.
   */
  argv(prompt, callOptions = {}) {
    const backend = callOptions.backend ?? this.backend;
    const model = callOptions.model ?? this.model;
    const arm = callOptions.arm ?? this.arm;
    const groundMusic = callOptions.groundMusic ?? this.groundMusic;
    const musicTracks = callOptions.musicTracks != null
      ? asStringArray(callOptions.musicTracks)
      : this.musicTracks;

    const args = [this.script, String(prompt), '--backend', String(backend)];
    if (model != null && String(model).length > 0) {
      args.push('--model', String(model));
    }
    if (arm != null && String(arm).length > 0) {
      args.push('--arm', String(arm));
    }
    if (groundMusic) {
      args.push('--ground-music');
    }
    for (const track of musicTracks) {
      args.push('--music-track', String(track));
    }
    args.push('--json');
    return args;
  }

  async generate(prompt, callOptions = {}) {
    const signal = callOptions.signal;
    if (signal?.aborted) {
      throw new DeskError(CODES.WEISS_FAILED, 'Weiss call was canceled before start.', safeFailureDetails({
        canceled: true,
        timedOut: false,
        timestamp: nowIso(),
        timeoutMs: callOptions.timeoutMs ?? this.timeoutMs,
        backend: callOptions.backend ?? this.backend,
        model: callOptions.model ?? this.model,
        arm: callOptions.arm ?? this.arm,
      }));
    }

    if (!this.available()) {
      throw new DeskError(CODES.WEISS_FAILED, 'Weiss is not configured', safeFailureDetails({
        executable: this.executable,
        script: this.script,
        exists: {
          executable: existsSync(this.executable),
          script: existsSync(this.script),
        },
        backend: this.backend,
        model: this.model,
        arm: this.arm,
      }));
    }

    const timestamp = nowIso();
    const timeoutMs = callOptions.timeoutMs ?? this.timeoutMs;
    const backend = callOptions.backend ?? this.backend;
    const model = callOptions.model ?? this.model;
    const arm = callOptions.arm ?? this.arm;
    const groundMusic = callOptions.groundMusic ?? this.groundMusic;
    const musicTracks = callOptions.musicTracks != null
      ? asStringArray(callOptions.musicTracks)
      : this.musicTracks;
    const argv = this.argv(prompt, {
      backend,
      model,
      arm,
      groundMusic,
      musicTracks,
    });

    const child = spawn(this.executable, argv, {
      shell: false,
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const processGroupId = child.pid;

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const onStdout = (chunk) => { stdout += chunk; };
    const onStderr = (chunk) => { stderr += chunk; };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let canceled = false;
      let killEscalationTimer = null;
      let deadlineTimer = null;

      const detachListeners = () => {
        child.stdout.off('data', onStdout);
        child.stderr.off('data', onStderr);
        child.off('error', onError);
        child.off('close', onClose);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      const clearTimers = () => {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
        if (killEscalationTimer) {
          clearTimeout(killEscalationTimer);
          killEscalationTimer = null;
        }
      };

      const escalateKill = () => {
        killProcessGroup(processGroupId, 'SIGTERM');
        if (killEscalationTimer) clearTimeout(killEscalationTimer);
        killEscalationTimer = setTimeout(() => {
          killEscalationTimer = null;
          killProcessGroup(processGroupId, 'SIGKILL');
        }, 1_000);
        if (typeof killEscalationTimer.unref === 'function') killEscalationTimer.unref();
      };

      const fail = (message, extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimers();
        detachListeners();
        reject(new DeskError(CODES.WEISS_FAILED, message, safeFailureDetails({
          executable: this.executable,
          script: this.script,
          cwd: this.cwd,
          arm,
          backend,
          model,
          groundMusic,
          musicTracks,
          exitStatus: extra.exitStatus,
          timedOut,
          canceled,
          timeoutMs,
          timestamp,
          stderr,
          stdoutPreview: stdout,
          cause: extra.cause,
        })));
      };

      const succeed = (payload) => {
        if (settled) return;
        settled = true;
        clearTimers();
        detachListeners();
        resolve(payload);
      };

      const onAbort = () => {
        canceled = true;
        escalateKill();
      };

      const onError = (error) => {
        fail(`Weiss spawn failed: ${error.message}`, { cause: error.message });
      };

      const onClose = (exitStatus) => {
        // If we timed out or canceled, sweep the process group immediately so a
        // TERM-resistant grandchild cannot outlive a parent that exited first.
        // Then clear timers so a delayed SIGKILL cannot hit a reused PID.
        if (timedOut || canceled) {
          killProcessGroup(processGroupId, 'SIGKILL');
        }
        clearTimers();
        detachListeners();
        if (settled) return;

        if (canceled) {
          fail('Weiss call was canceled.', { exitStatus });
          return;
        }
        if (timedOut) {
          fail('Weiss did not answer in time.', { exitStatus });
          return;
        }
        if (exitStatus !== 0) {
          fail('Weiss did not answer.', { exitStatus });
          return;
        }

        const trimmed = stdout.trim();
        let envelope;
        try {
          envelope = JSON.parse(trimmed);
        } catch (error) {
          fail('Weiss returned invalid JSON.', { exitStatus, cause: error.message });
          return;
        }

        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
          fail('Weiss returned invalid JSON.', { exitStatus });
          return;
        }
        if (envelope.error != null) {
          const errText = typeof envelope.error === 'string'
            ? envelope.error
            : (envelope.error.message || 'Weiss returned an error envelope.');
          fail(String(errText), { exitStatus });
          return;
        }

        const reply = typeof envelope.reply === 'string' ? envelope.reply.trim() : '';
        if (!reply) {
          fail('Weiss returned an empty reply.', { exitStatus });
          return;
        }

        const provenance = publicProvenance({
          arm: envelope.arm ?? arm,
          backend: envelope.backend ?? backend,
          model: envelope.model ?? model,
          citations: envelope.citations,
          calibration: envelope.calibration,
          backend_receipts: envelope.backend_receipts,
          music_evidence: envelope.music_evidence,
          exitStatus,
          timedOut: false,
          timeoutMs,
          timestamp,
        });

        succeed({
          success: true,
          reply,
          briefText: reply,
          // retained for older callers that read stdout; not the brief source of truth
          stdout: reply,
          provenance,
          arm: provenance.arm,
          backend: provenance.backend,
          model: provenance.model,
          citations: provenance.citations,
          calibration: provenance.calibration,
          backend_receipts: provenance.backend_receipts,
          music_evidence: provenance.music_evidence,
          exitStatus,
          timedOut: false,
          timeoutMs,
          timestamp,
        });
      };

      deadlineTimer = setTimeout(() => {
        timedOut = true;
        escalateKill();
      }, timeoutMs);

      child.on('error', onError);
      child.on('close', onClose);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
