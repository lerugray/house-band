#!/usr/bin/env node

/**
 * Composer's Desk local server entry point.
 *
 * Binds loopback only. Loads the House Band env file server-side (HOUSE_BAND_ENV_FILE or
 * ~/.config/house-band/.env). Opens the default browser. Handles port pre-check/reuse
 * and missing-configuration launch-in-audition-only mode.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { buildProfiles, defaultProfile, weissConfig } from './desk/config.mjs';
import { createProvider } from './desk/providers/index.mjs';
import { createDeskHttpServer } from './desk/http.mjs';
import { DeskService } from './desk/service.mjs';
import { loadEnvFile } from './desk/env.mjs';
import { SessionStore } from './desk/session-store.mjs';
import { WeissCli } from './desk/weiss.mjs';

const DEFAULT_PORT = 3782;
const FALLBACK_PORTS = [3783, 3784, 3785, 3786, 3787];
const HOUSE_BAND_HOME = process.env.HOUSE_BAND_HOME ?? resolve(homedir(), 'Music', 'House Band Composer');
const PID_FILE = resolve(HOUSE_BAND_HOME, '.desk-server.pid');
const LOG_FILE = resolve(HOUSE_BAND_HOME, 'desk-server.log');

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  console.log(line.trim());
  // Async append; ignore errors.
  import('node:fs/promises').then(({ appendFile }) => appendFile(LOG_FILE, line).catch(() => {}));
}

async function ensureAppSupportDir() {
  const dir = HOUSE_BAND_HOME;
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

async function readPidFile() {
  try {
    const text = await readFile(PID_FILE, 'utf8');
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function writePidFile(pid, port) {
  await writeFile(PID_FILE, `${pid}\n${port}\n`, 'utf8');
}

async function removePidFile() {
  try { await unlink(PID_FILE); } catch {}
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function identifyPortListener(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve('in-use');
      } else {
        resolve(`error: ${err.message}`);
      }
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve('free'));
    });
  });
}

async function probeDeskPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/desk/api/health`, { headers: { host: `127.0.0.1:${port}` } });
    if (res.ok) {
      const body = await res.json();
      return { desk: true, body };
    }
    return { desk: false };
  } catch {
    return { desk: false };
  }
}

async function findPort(preferred = DEFAULT_PORT) {
  const candidates = [preferred, ...FALLBACK_PORTS];
  for (const port of candidates) {
    const state = await identifyPortListener(port);
    if (state === 'free') return { port, reused: false };

    // Port is in use. If it's another Desk instance, reuse it.
    const probe = await probeDeskPort(port);
    if (probe.desk) {
      log(`Port ${port} is already occupied by a healthy Composer's Desk; reusing it.`);
      return { port, reused: true, health: probe.body };
    }
  }
  return { error: 'could not find a free local port' };
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
}

function args(argv) {
  const result = { port: DEFAULT_PORT, open: true };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--port') result.port = Number(argv[++i]);
    else if (value === '--no-open') result.open = false;
    else if (value === '--help' || value === '-h') result.help = true;
  }
  return result;
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node src/desk-server.mjs [--port 3782] [--no-open]');
    return;
  }

  await ensureAppSupportDir();

  const existingPid = await readPidFile();
  if (existingPid && processAlive(existingPid) && existingPid !== process.pid) {
    const existingPort = await (async () => {
      try {
        const text = await readFile(PID_FILE, 'utf8');
        const lines = text.trim().split('\n');
        return Number(lines[1]) || DEFAULT_PORT;
      } catch { return DEFAULT_PORT; }
    })();
    const probe = await probeDeskPort(existingPort);
    if (probe.desk) {
      log(`Existing Composer's Desk already running on port ${existingPort}; opening that instance.`);
      if (options.open) openBrowser(`http://127.0.0.1:${existingPort}/desk/`);
      return;
    }
  }

  const portResult = await findPort(options.port);
  if (portResult.error) {
    log(`FATAL: ${portResult.error}`);
    process.exit(1);
  }
  const { port, reused } = portResult;
  if (reused) {
    if (options.open) openBrowser(`http://127.0.0.1:${port}/desk/`);
    return;
  }

  const envResult = await loadEnvFile();
  const mergedEnv = { ...process.env, ...envResult.env };
  const profiles = buildProfiles(envResult.env);
  const profile = defaultProfile(profiles) ?? profiles[profiles.length - 1];
  const provider = profile ? createProvider(profile, envResult.env) : null;
  const weiss = new WeissCli(weissConfig({ env: mergedEnv }));
  const sessionStore = new SessionStore();
  const service = new DeskService({
    env: envResult.env,
    profiles,
    provider,
    weiss,
    sessionStore,
    logFile: LOG_FILE,
  });
  await service.init();

  const server = createDeskHttpServer(service);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  await writePidFile(process.pid, port);
  log(`Composer's Desk listening on http://127.0.0.1:${port}/desk/`);

  if (options.open) openBrowser(`http://127.0.0.1:${port}/desk/`);

  function shutdown() {
    log('Shutting down Composer\'s Desk.');
    removePidFile().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
