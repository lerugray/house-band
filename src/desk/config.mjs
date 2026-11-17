/**
 * Composer's Desk provider profile configuration.
 *
 * Profiles are declared server-side. The browser receives only profile ids,
 * display names, model names, adapter types, and configuration status.
 *
 * Weiss options are centralized in weissConfig(): public default explicitly
 * selects backend=openrouter (Weiss CLI's own default is home). Optional
 * user-local JSON at ~/.config/house-band/brief.json (else weiss.json), or
 * HB_WEISS_CONFIG / HOUSE_BAND_BRIEF_CONFIG, opts into Fable + music grounding.
 * No private data in-repo.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { DeskError, CODES } from './errors.mjs';

const DEFAULT_BRIEF_CONFIG_PATH = resolve(homedir(), '.config', 'house-band', 'brief.json');
const DEFAULT_WEISS_CONFIG_PATH = resolve(homedir(), '.config', 'house-band', 'weiss.json');
const DEFAULT_WEISS_TIMEOUT_MS = 420_000;

export const DEFAULT_PROFILE_ID = 'claude-sonnet-5';

export const PROFILE_TYPES = Object.freeze({
  CLAUDE_CLI: 'claude-cli',
  OPENAI_COMPATIBLE: 'openai-compatible',
  DETERMINISTIC: 'deterministic',
});

export function buildProfiles(env = Object.create(null)) {
  const claudeTokenVar = env.HOUSE_BAND_CLAUDE_TOKEN_VAR ?? 'CLAUDE_CODE_OAUTH_TOKEN';
  return Object.freeze([
    Object.freeze({
      id: DEFAULT_PROFILE_ID,
      type: PROFILE_TYPES.CLAUDE_CLI,
      displayName: 'Claude Sonnet 5',
      model: 'claude-sonnet-5',
      cliCommand: 'claude',
      cliArgs: ['-p', '--model', 'claude-sonnet-5'],
      envVar: claudeTokenVar,
      childEnvVar: 'CLAUDE_CODE_OAUTH_TOKEN',
      configured: Boolean(env[claudeTokenVar]),
      callTimeoutMs: 120_000,
      maxTransportAttempts: 3,
      totalDeadlineMs: 300_000,
    }),
    Object.freeze({
      id: 'deepseek',
      type: PROFILE_TYPES.OPENAI_COMPATIBLE,
      displayName: 'DeepSeek',
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnvVar: 'DEEPSEEK_API_KEY',
      configured: Boolean(env.DEEPSEEK_API_KEY),
      callTimeoutMs: 120_000,
      maxTransportAttempts: 3,
      totalDeadlineMs: 300_000,
      maxTokens: 16_384,
    }),
    Object.freeze({
      id: 'ollama-cloud',
      type: PROFILE_TYPES.OPENAI_COMPATIBLE,
      displayName: 'Ollama Cloud',
      model: 'qwen2.5-coder:32b',
      baseUrl: 'https://api.ollama.com/v1',
      apiKeyEnvVar: 'OLLAMA_CLOUD_API_KEY',
      configured: Boolean(env.OLLAMA_CLOUD_API_KEY),
      callTimeoutMs: 120_000,
      maxTransportAttempts: 3,
      totalDeadlineMs: 300_000,
      numPredict: 8_192,
    }),
    Object.freeze({
      id: 'custom',
      type: PROFILE_TYPES.OPENAI_COMPATIBLE,
      displayName: 'Custom (OpenAI-compatible)',
      model: env.HOUSE_BAND_LLM_MODEL ?? null,
      baseUrl: env.HOUSE_BAND_LLM_BASE_URL ?? null,
      apiKeyEnvVar: 'HOUSE_BAND_LLM_API_KEY',
      configured: Boolean(
        env.HOUSE_BAND_LLM_BASE_URL && env.HOUSE_BAND_LLM_MODEL && env.HOUSE_BAND_LLM_API_KEY,
      ),
      callTimeoutMs: 120_000,
      maxTransportAttempts: 3,
      totalDeadlineMs: 300_000,
    }),
    Object.freeze({
      id: 'anthropic',
      type: PROFILE_TYPES.OPENAI_COMPATIBLE,
      displayName: 'Anthropic API',
      model: 'claude-sonnet-5-5',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      configured: Boolean(env.ANTHROPIC_API_KEY),
      callTimeoutMs: 120_000,
      maxTransportAttempts: 3,
      totalDeadlineMs: 300_000,
    }),
    Object.freeze({
      id: 'deterministic',
      type: PROFILE_TYPES.DETERMINISTIC,
      displayName: 'Deterministic test double',
      model: 'house-band-deterministic-score-author/1.0.0',
      configured: true,
      callTimeoutMs: 5_000,
      maxTransportAttempts: 1,
      totalDeadlineMs: 30_000,
    }),
  ]);
}

export function getProfile(profiles, id) {
  return profiles.find((p) => p.id === id) || null;
}

export function defaultProfile(profiles) {
  const preferred = profiles.find((p) => p.id === DEFAULT_PROFILE_ID);
  return preferred || profiles[0] || null;
}

function parseBoolean(value, fieldName) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  }
  if (value == null) return null;
  throw new DeskError(CODES.INVALID_REQUEST, `Weiss config field ${fieldName} must be a boolean`);
}

function parseTimeoutMs(value, fieldName = 'timeoutMs') {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new DeskError(CODES.INVALID_REQUEST, `Weiss config field ${fieldName} must be a positive number`);
  }
  return Math.floor(n);
}

function parseMusicTracks(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return trimmed.split(',').map((part) => part.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      throw new DeskError(CODES.INVALID_REQUEST, 'Weiss config field musicTracks must be an array of strings');
    }
    return value.map((item) => String(item));
  }
  throw new DeskError(CODES.INVALID_REQUEST, 'Weiss config field musicTracks must be an array of strings');
}

function readWeissJsonFile(configPath) {
  if (!existsSync(configPath)) return null;
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new DeskError(CODES.INVALID_REQUEST, `Weiss config could not be read: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DeskError(CODES.INVALID_REQUEST, `Weiss config is malformed JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeskError(CODES.INVALID_REQUEST, 'Weiss config must be a JSON object');
  }
  return parsed;
}

function pickWeissFileFields(parsed) {
  if (!parsed) return {};
  const allowed = [
    'backend', 'model', 'groundMusic', 'musicTracks', 'timeoutMs',
    'executable', 'script', 'cwd', 'arm',
  ];
  const unknown = Object.keys(parsed).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new DeskError(
      CODES.INVALID_REQUEST,
      `Weiss config has unknown fields: ${unknown.join(', ')}`,
    );
  }
  const out = {};
  if (parsed.backend != null) out.backend = String(parsed.backend);
  if (parsed.model != null) out.model = String(parsed.model);
  if (parsed.arm != null) out.arm = String(parsed.arm);
  if (parsed.executable != null) out.executable = String(parsed.executable);
  if (parsed.script != null) out.script = String(parsed.script);
  if (parsed.cwd != null) out.cwd = String(parsed.cwd);
  if (parsed.groundMusic != null) out.groundMusic = parseBoolean(parsed.groundMusic, 'groundMusic');
  if (parsed.musicTracks != null) out.musicTracks = parseMusicTracks(parsed.musicTracks);
  if (parsed.timeoutMs != null) out.timeoutMs = parseTimeoutMs(parsed.timeoutMs);
  return out;
}

function pickEnvTwin(env, hbKey, briefKey) {
  if (env[hbKey] != null && env[hbKey] !== '') return String(env[hbKey]);
  if (env[briefKey] != null && env[briefKey] !== '') return String(env[briefKey]);
  return null;
}

function pickWeissEnvFields(env) {
  const out = {};
  const backend = pickEnvTwin(env, 'HB_WEISS_BACKEND', 'HOUSE_BAND_BRIEF_BACKEND');
  if (backend != null) out.backend = backend;
  const model = pickEnvTwin(env, 'HB_WEISS_MODEL', 'HOUSE_BAND_BRIEF_MODEL');
  if (model != null) out.model = model;
  const arm = pickEnvTwin(env, 'HB_WEISS_ARM', 'HOUSE_BAND_BRIEF_ARM');
  if (arm != null) out.arm = arm;
  const executable = pickEnvTwin(env, 'HB_WEISS_EXECUTABLE', 'HOUSE_BAND_BRIEF_EXECUTABLE');
  if (executable != null) out.executable = executable;
  const script = pickEnvTwin(env, 'HB_WEISS_SCRIPT', 'HOUSE_BAND_BRIEF_SCRIPT');
  if (script != null) out.script = script;
  const cwd = pickEnvTwin(env, 'HB_WEISS_CWD', 'HOUSE_BAND_BRIEF_CWD');
  if (cwd != null) out.cwd = cwd;
  const groundMusicRaw = env.HB_WEISS_GROUND_MUSIC != null && env.HB_WEISS_GROUND_MUSIC !== ''
    ? env.HB_WEISS_GROUND_MUSIC
    : (env.HOUSE_BAND_BRIEF_GROUND_MUSIC != null && env.HOUSE_BAND_BRIEF_GROUND_MUSIC !== ''
      ? env.HOUSE_BAND_BRIEF_GROUND_MUSIC
      : null);
  if (groundMusicRaw != null) {
    out.groundMusic = parseBoolean(groundMusicRaw, 'HB_WEISS_GROUND_MUSIC');
  }
  const musicTracksRaw = env.HB_WEISS_MUSIC_TRACKS != null && env.HB_WEISS_MUSIC_TRACKS !== ''
    ? env.HB_WEISS_MUSIC_TRACKS
    : (env.HOUSE_BAND_BRIEF_MUSIC_TRACKS != null && env.HOUSE_BAND_BRIEF_MUSIC_TRACKS !== ''
      ? env.HOUSE_BAND_BRIEF_MUSIC_TRACKS
      : null);
  if (musicTracksRaw != null) {
    out.musicTracks = parseMusicTracks(musicTracksRaw);
  }
  const timeoutRaw = env.HB_WEISS_TIMEOUT_MS != null && env.HB_WEISS_TIMEOUT_MS !== ''
    ? env.HB_WEISS_TIMEOUT_MS
    : (env.HOUSE_BAND_BRIEF_TIMEOUT_MS != null && env.HOUSE_BAND_BRIEF_TIMEOUT_MS !== ''
      ? env.HOUSE_BAND_BRIEF_TIMEOUT_MS
      : null);
  if (timeoutRaw != null) {
    out.timeoutMs = parseTimeoutMs(timeoutRaw, 'HB_WEISS_TIMEOUT_MS');
  }
  return out;
}

function pickWeissOverrideFields(overrides = {}) {
  const out = {};
  if (overrides.backend != null) out.backend = String(overrides.backend);
  if (overrides.model != null) out.model = String(overrides.model);
  if (overrides.arm != null) out.arm = String(overrides.arm);
  if (overrides.executable != null) out.executable = String(overrides.executable);
  if (overrides.script != null) out.script = String(overrides.script);
  if (overrides.cwd != null) out.cwd = String(overrides.cwd);
  if (overrides.workingDirectory != null && overrides.cwd == null) {
    out.cwd = String(overrides.workingDirectory);
  }
  if (overrides.groundMusic != null) {
    out.groundMusic = parseBoolean(overrides.groundMusic, 'groundMusic');
  }
  if (overrides.musicTracks != null) out.musicTracks = parseMusicTracks(overrides.musicTracks);
  if (overrides.timeoutMs != null) out.timeoutMs = parseTimeoutMs(overrides.timeoutMs);
  return out;
}

function defaultConfigPath(env) {
  if (existsSync(DEFAULT_BRIEF_CONFIG_PATH)) return DEFAULT_BRIEF_CONFIG_PATH;
  return DEFAULT_WEISS_CONFIG_PATH;
}

/**
 * Resolve Weiss CLI options.
 *
 * Precedence (highest last): built-in public defaults → user JSON → HB_WEISS_* /
 * HOUSE_BAND_BRIEF_* env → constructor/call overrides.
 *
 * Public default always sets backend=openrouter explicitly so omission cannot
 * inherit Weiss's home default. groundMusic stays false unless opted in.
 * executable/script/cwd default to null (must be configured).
 *
 * Env keys: HB_WEISS_CONFIG / HOUSE_BAND_BRIEF_CONFIG, HB_WEISS_BACKEND /
 * HOUSE_BAND_BRIEF_BACKEND, and the same twin pattern for MODEL, ARM,
 * EXECUTABLE, SCRIPT, CWD, GROUND_MUSIC, MUSIC_TRACKS, TIMEOUT_MS.
 */
export function weissConfig({
  env = process.env,
  configPath = null,
  overrides = {},
} = {}) {
  const resolvedPath = configPath
    ?? (env.HB_WEISS_CONFIG && String(env.HB_WEISS_CONFIG))
    ?? (env.HOUSE_BAND_BRIEF_CONFIG && String(env.HOUSE_BAND_BRIEF_CONFIG))
    ?? defaultConfigPath(env);

  const fromFile = pickWeissFileFields(readWeissJsonFile(resolvedPath));
  const fromEnv = pickWeissEnvFields(env);
  const fromOverrides = pickWeissOverrideFields(overrides);

  const musicTracks = fromOverrides.musicTracks
    ?? fromEnv.musicTracks
    ?? fromFile.musicTracks
    ?? [];
  const groundMusic = fromOverrides.groundMusic
    ?? fromEnv.groundMusic
    ?? fromFile.groundMusic
    ?? false;
  const timeoutExplicit = fromOverrides.timeoutMs
    ?? fromEnv.timeoutMs
    ?? fromFile.timeoutMs
    ?? null;
  const timeoutMs = timeoutExplicit ?? DEFAULT_WEISS_TIMEOUT_MS;

  const executable = fromOverrides.executable ?? fromEnv.executable ?? fromFile.executable ?? null;
  const script = fromOverrides.script ?? fromEnv.script ?? fromFile.script ?? null;
  const cwd = fromOverrides.cwd ?? fromEnv.cwd ?? fromFile.cwd ?? null;
  const arm = fromOverrides.arm ?? fromEnv.arm ?? fromFile.arm ?? 'primary';
  const backend = fromOverrides.backend ?? fromEnv.backend ?? fromFile.backend ?? 'openrouter';
  const model = fromOverrides.model ?? fromEnv.model ?? fromFile.model ?? null;

  // Legacy argv template alias (prompt placeholder) for older callers.
  const promptPlaceholder = '__PROMPT__';
  const argv = [
    script,
    promptPlaceholder,
    '--backend', backend,
    ...(model ? ['--model', model] : []),
    '--arm', arm,
    ...(groundMusic ? ['--ground-music'] : []),
    ...musicTracks.flatMap((title) => ['--music-track', title]),
    '--json',
  ];

  return Object.freeze({
    executable,
    script,
    cwd,
    workingDirectory: cwd,
    arm,
    backend,
    model,
    groundMusic,
    musicTracks: Object.freeze([...musicTracks]),
    timeoutMs,
    configPath: resolvedPath,
    promptPlaceholder,
    argv: Object.freeze(argv),
  });
}

export function publicProfiles(profiles) {
  return Object.freeze(profiles.map((p) => Object.freeze({
    id: p.id,
    displayName: p.displayName,
    model: p.model,
    type: p.type,
    configured: p.configured,
    callTimeoutMs: p.callTimeoutMs,
  })));
}
