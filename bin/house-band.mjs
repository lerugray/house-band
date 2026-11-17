#!/usr/bin/env node
/**
 * House Band CLI front door (OSS-16).
 *   house-band render | samples | cowrite | desk | audition
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { packSearchDirs } from '../src/sample-pack-node.mjs';
import { KIT_VERSION } from '../src/version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function usage() {
  return [
    'Usage: house-band <command> [args]',
    '',
    'Commands:',
    '  render <spec.json> -o <out.wav> [--pack <dir>] [--kit-map <map>]',
    '      Runs src/compose.mjs --spec <spec> --out <out> ... (-o is an alias for --out)',
    '  samples scan <folder> [...]',
    '      Runs tools/samples/scan.mjs',
    '  samples build <config> [...]',
    '      Runs tools/samples/build.mjs',
    '  samples build-mapping --mapping <dir> --input <root> [...]',
    '      Runs tools/samples/build-mapping.mjs',
    '  samples from-sfz ...',
    '      Runs tools/samples/from-sfz.mjs',
    '  samples from-sf2 ...',
    '      Runs tools/samples/from-sf2.mjs',
    '  samples list',
    '      Prints every pack on the search path: packId, folder, content sha (12), user/repo',
    '  cowrite <import|as-written|develop|export-midi> ...',
    '      Runs tools/cowrite/<sub>.mjs (not built yet until M3 lands)',
    '  desk',
    '      Runs src/desk-server.mjs',
    '  audition',
    '      Runs app/build.mjs, then prints the file:// path of dist/audition-room.html',
    '  --help',
    '      Show this usage',
    '  --version',
    '      Print package.json version and KIT_VERSION.semver',
  ].join('\n');
}

function exitWithUsage(code, stream = console.error) {
  stream(usage());
  process.exit(code);
}

function runNodeScript(relPath, args) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    console.error('not built yet');
    process.exit(3);
  }
  const result = spawnSync(process.execPath, [abs, ...args], {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status == null ? 1 : result.status);
}

/** Translate `render <spec> -o <out> ...` into compose.mjs argv. */
function translateRenderArgs(args) {
  const flags = [];
  let spec = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--out') {
      const value = args[++i];
      if (value == null) throw new Error(`${a} requires a path`);
      flags.push('--out', value);
    } else if (a === '--spec') {
      const value = args[++i];
      if (value == null) throw new Error('--spec requires a path');
      if (spec != null) throw new Error('spec already set');
      spec = value;
    } else if (a === '--pack' || a === '--kit-map') {
      const value = args[++i];
      if (value == null) throw new Error(`${a} requires a value`);
      flags.push(a, value);
    } else if (a.startsWith('-')) {
      flags.push(a);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.push(args[++i]);
      }
    } else if (spec == null) {
      spec = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  if (spec == null) throw new Error('render requires a <spec.json> path');
  return ['--spec', spec, ...flags];
}

function samplesList() {
  const roots = packSearchDirs();
  const repoPacks = resolve(roots[0]);
  const seen = new Set();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const packDir = join(root, ent.name);
      const packJsonPath = join(packDir, 'pack.json');
      if (!existsSync(packJsonPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(packJsonPath, 'utf8'));
      } catch {
        continue;
      }
      const packId = typeof manifest.packId === 'string' ? manifest.packId : ent.name;
      if (seen.has(packId)) continue;
      seen.add(packId);
      const sha12 = typeof manifest.contentSha256 === 'string'
        ? manifest.contentSha256.slice(0, 12)
        : '';
      const origin = resolve(root) === repoPacks ? 'repo' : 'user';
      console.log(`${packId}\t${packDir}\t${sha12}\t${origin}`);
    }
  }
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    exitWithUsage(0, console.log);
  }
  if (args[0] === '--version' || args[0] === '-V') {
    console.log(`${PKG.version} kit ${KIT_VERSION.semver}`);
    process.exit(0);
  }

  const [cmd, ...rest] = args;

  if (cmd === 'render') {
    let composeArgs;
    try {
      composeArgs = translateRenderArgs(rest);
    } catch (e) {
      console.error(e.message);
      exitWithUsage(2);
    }
    runNodeScript('src/compose.mjs', composeArgs);
  }

  if (cmd === 'samples') {
    const sub = rest[0];
    const subArgs = rest.slice(1);
    if (sub === 'list') {
      samplesList();
      process.exit(0);
    }
    const map = {
      scan: 'tools/samples/scan.mjs',
      build: 'tools/samples/build.mjs',
      'build-mapping': 'tools/samples/build-mapping.mjs',
      'from-sfz': 'tools/samples/from-sfz.mjs',
      'from-sf2': 'tools/samples/from-sf2.mjs',
    };
    if (!sub || !map[sub]) {
      console.error(sub ? `unknown samples subcommand: ${sub}` : 'samples requires a subcommand');
      exitWithUsage(2);
    }
    runNodeScript(map[sub], subArgs);
  }

  if (cmd === 'cowrite') {
    const sub = rest[0];
    const allowed = new Set(['import', 'as-written', 'develop', 'export-midi']);
    if (!sub || !allowed.has(sub)) {
      console.error(sub ? `unknown cowrite subcommand: ${sub}` : 'cowrite requires a subcommand');
      exitWithUsage(2);
    }
    runNodeScript(`tools/cowrite/${sub}.mjs`, rest.slice(1));
  }

  if (cmd === 'desk') {
    runNodeScript('src/desk-server.mjs', rest);
  }

  if (cmd === 'audition') {
    const build = spawnSync(process.execPath, [join(ROOT, 'app', 'build.mjs'), ...rest], {
      stdio: 'inherit',
      cwd: ROOT,
      env: process.env,
    });
    if (build.error) {
      console.error(build.error.message);
      process.exit(1);
    }
    if (build.status !== 0) process.exit(build.status == null ? 1 : build.status);
    const html = join(ROOT, 'dist', 'audition-room.html');
    console.log(pathToFileURL(html).href);
    process.exit(0);
  }

  console.error(`unknown subcommand: ${cmd}`);
  exitWithUsage(2);
}

main(process.argv);
