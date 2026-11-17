/**
 * Server-side environment loader for Composer's Desk.
 *
 * Loads the House Band env file server-side (HOUSE_BAND_ENV_FILE or
 * ~/.config/house-band/.env). Secret values are held in server memory only and
 * never sent to the browser. The browser sees only variable names, status, and
 * whether a profile is configured.
 */

import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

export function resolveEnvPath(env = process.env) {
  if (typeof env?.HOUSE_BAND_ENV_FILE === 'string' && env.HOUSE_BAND_ENV_FILE.length > 0) {
    return env.HOUSE_BAND_ENV_FILE;
  }
  return resolve(homedir(), '.config', 'house-band', '.env');
}

const ENV_PATH = resolveEnvPath(process.env);

const EXPORT_RE = /^export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const UNSET_RE = /^unset\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/;

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export async function loadEnvFile(path = ENV_PATH) {
  const env = Object.create(null);
  try {
    const fileStream = createReadStream(path, { encoding: 'utf8' });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const unset = trimmed.match(UNSET_RE);
      if (unset) {
        delete env[unset[1]];
        continue;
      }
      const match = trimmed.match(EXPORT_RE);
      if (match) {
        env[match[1]] = stripQuotes(match[2].trim());
      }
    }
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      return { path, env: Object.create(null), missing: true, error: null };
    }
    return { path, env: Object.create(null), missing: false, error: cause?.message || String(cause) };
  }
  return { path, env, missing: false, error: null };
}

export function hasEnv(env, name) {
  return typeof env[name] === 'string' && env[name].length > 0;
}

export function describeConfig(env, name) {
  return hasEnv(env, name) ? 'configured' : 'missing configuration';
}

export function redact(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}`;
}

export function publicEnvStatus({ path, missing, error, env }) {
  return Object.freeze({
    path,
    readable: !missing && error === null,
    missing,
    readError: error,
    variables: Object.freeze(Object.keys(env).map((name) => Object.freeze({ name, status: describeConfig(env, name) }))),
  });
}
