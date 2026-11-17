/** OSS-16: house-band CLI front door. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSamplesConfig } from '../src/samples/config.mjs';
import { KIT_VERSION } from '../src/version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'bin', 'house-band.mjs');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const EXAMPLE_CONFIG = join(
  ROOT,
  'examples',
  'sample-mappings',
  'generic-drum-folder',
  'house-band.samples.json',
);
const DOCS = join(ROOT, 'docs', 'BRING-YOUR-OWN-SAMPLES.md');

let tmpRoot;

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: process.env,
    ...opts,
  });
}

function relativeMarkdownLinks(markdown) {
  const links = [];
  const re = /\[[^\]]*]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const target = m[1].split('#')[0].trim();
    if (!target) continue;
    if (/^[a-z]+:/i.test(target)) continue;
    if (target.startsWith('//')) continue;
    links.push(target);
  }
  return links;
}

describe('OSS-16 CLI front door', () => {
  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hb-cli-'));
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('--help lists all subcommands', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout;
    for (const needle of [
      'render',
      'samples scan',
      'samples build',
      'samples build-mapping',
      'samples from-sfz',
      'samples from-sf2',
      'samples list',
      'cowrite',
      'desk',
      'audition',
      '--help',
      '--version',
    ]) {
      assert.match(out, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('no args prints usage', () => {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: house-band/);
  });

  it('--version prints package and kit versions', () => {
    const result = run(['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(PKG.version));
    assert.match(result.stdout, new RegExp(KIT_VERSION.semver));
  });

  it('render -o matches compose.mjs byte-for-byte', () => {
    const dir = join(tmpRoot, 'render');
    mkdirSync(dir, { recursive: true });
    const viaCli = join(dir, 'd.wav');
    const viaCompose = join(dir, 'e.wav');

    const cli = run([
      'render',
      'examples/demo-spec.json',
      '-o',
      viaCli,
    ]);
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);

    const compose = spawnSync(
      process.execPath,
      [
        join(ROOT, 'src', 'compose.mjs'),
        '--spec',
        'examples/demo-spec.json',
        '--out',
        viaCompose,
      ],
      { encoding: 'utf8', cwd: ROOT },
    );
    assert.equal(compose.status, 0, compose.stderr || compose.stdout);

    assert.ok(existsSync(viaCli));
    assert.ok(existsSync(`${viaCli}.manifest.json`));
    const a = readFileSync(viaCli);
    const b = readFileSync(viaCompose);
    assert.equal(a.equals(b), true, 'WAV bytes differ between CLI render and compose.mjs');
    const ma = readFileSync(`${viaCli}.manifest.json`);
    const mb = readFileSync(`${viaCompose}.manifest.json`);
    assert.equal(ma.equals(mb), true, 'manifest bytes differ');
  });

  it('samples list shows sampler-demo-17', () => {
    const result = run(['samples', 'list']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sampler-demo-17/);
    assert.match(result.stdout, /\brepo\b/);
  });

  it('bogus exits 2 with usage on stderr', () => {
    const result = run(['bogus']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown subcommand: bogus/);
    assert.match(result.stderr, /Usage: house-band/);
  });

  it('generic-drum-folder config passes validateSamplesConfig', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_CONFIG, 'utf8'));
    const validated = validateSamplesConfig(raw, { baseDir: dirname(EXAMPLE_CONFIG) });
    assert.ok(validated);
    assert.equal(validated.id, 'scan-fixture');
  });

  it('every relative link in BRING-YOUR-OWN-SAMPLES.md resolves', () => {
    const md = readFileSync(DOCS, 'utf8');
    const docsDir = dirname(DOCS);
    for (const rel of relativeMarkdownLinks(md)) {
      const abs = resolve(docsDir, rel);
      assert.ok(existsSync(abs), `missing link target: ${rel} -> ${abs}`);
      assert.ok(statSync(abs).isFile() || statSync(abs).isDirectory(), `not a file/dir: ${abs}`);
    }
  });
});
