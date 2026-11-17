import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { midiToFrequency } from '../src/kit/band.js';
import { encodeCanonicalWav } from '../src/sample-pack.mjs';
import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { autoZonesFromRoots } from '../src/samples/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const FIXTURE = join(HERE, 'fixtures', 'samples-build');
const OUT_DIR = join(HERE, 'fixtures', 'samples-build-out');
const CONFIG_PATH = join(FIXTURE, 'house-band.samples.json');
const CLI = join(REPO_ROOT, 'tools', 'samples', 'build.mjs');
const SAMPLE_RATE = 44100;
const PACK_ID = 'user-build-fixture';

/** Short unpitched PCM16LE mono WAV for drum lanes. */
function makeNoiseWav(durationSec) {
  const frames = Math.max(1, Math.round(durationSec * SAMPLE_RATE));
  const dataSize = frames * 2;
  const riffSize = 4 + (8 + 16) + (8 + dataSize);
  const buf = Buffer.alloc(8 + riffSize);
  let o = 0;
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(riffSize, o); o += 4;
  buf.write('WAVE', o); o += 4;
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(16, o); o += 4;
  buf.writeUInt16LE(1, o); o += 2;
  buf.writeUInt16LE(1, o); o += 2;
  buf.writeUInt32LE(SAMPLE_RATE, o); o += 4;
  buf.writeUInt32LE(SAMPLE_RATE * 2, o); o += 4;
  buf.writeUInt16LE(2, o); o += 2;
  buf.writeUInt16LE(16, o); o += 2;
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(dataSize, o); o += 4;
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(((i * 17) % 2001) - 1000, o);
    o += 2;
  }
  return buf;
}

/** One-second sine at MIDI note, canonical WAV. */
function makeToneWav(midi, seconds = 1) {
  const count = Math.round(seconds * SAMPLE_RATE);
  const frames = new Int16Array(count);
  const freq = midiToFrequency(midi);
  for (let i = 0; i < count; i++) {
    frames[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 16000);
  }
  return Buffer.from(encodeCanonicalWav(frames));
}

function writeFixture() {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  const files = {
    'kick-a.wav': makeNoiseWav(0.2),
    'kick-b.wav': makeNoiseWav(0.25),
    'snare-a.wav': makeNoiseWav(0.22),
    'hat-closed.wav': makeNoiseWav(0.15),
    'tone-048-100.wav': makeToneWav(48),
    'tone-060-100.wav': makeToneWav(60),
    'tone-072-100.wav': makeToneWav(72),
  };
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(FIXTURE, name), bytes);
  }
  const config = {
    format: 'house-band-samples',
    version: 1,
    id: 'build-fixture',
    displayName: 'Build fixture',
    source: { type: 'folder', path: '.' },
    licence: 'test fixture; not for redistribution',
    fallbackKit: 'tr808',
    kit: {
      kick: { a: 'kick-a.wav', b: 'kick-b.wav' },
      snare: { a: 'snare-a.wav' },
      hat: { closed: 'hat-closed.wav' },
    },
    patches: {
      pluck: {
        class: 'pluck',
        zones: 'auto',
        files: ['tone-048-100.wav', 'tone-060-100.wav', 'tone-072-100.wav'],
      },
    },
  };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function runBuild(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
}

function packDir() {
  return join(OUT_DIR, PACK_ID);
}

/** loadSamplePackDirectory requires only pack.json + assets; sidecars moved aside. */
async function loadPackValidatingSidecars(dir) {
  const kitPath = join(dir, 'house-band.kit.json');
  const patchesPath = join(dir, 'house-band.patches.json');
  const kitTmp = join(dir, '..', '_kit-aside.json');
  const patchesTmp = join(dir, '..', '_patches-aside.json');
  const hadKit = existsSync(kitPath);
  const hadPatches = existsSync(patchesPath);
  if (hadKit) renameSync(kitPath, kitTmp);
  if (hadPatches) renameSync(patchesPath, patchesTmp);
  try {
    return await loadSamplePackDirectory(dir);
  } finally {
    if (hadKit) renameSync(kitTmp, kitPath);
    if (hadPatches) renameSync(patchesTmp, patchesPath);
  }
}

function assertNoAbsolutePaths(value, path = '') {
  if (typeof value === 'string') {
    assert.ok(
      !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('/') && !value.startsWith('\\\\'),
      `absolute path at ${path || '(root)'}: ${value}`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoAbsolutePaths(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assertNoAbsolutePaths(v, path ? `${path}.${k}` : k);
    }
  }
}

describe('OSS-12 samples build', () => {
  before(() => {
    writeFixture();
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
  });

  after(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    rmSync(OUT_DIR, { recursive: true, force: true });
  });

  it('auto zone split matches acceptance midpoints', () => {
    const zones = autoZonesFromRoots([
      { id: 'pluck-1', rootNote: 48, pcmSha256: 'a' },
      { id: 'pluck-2', rootNote: 60, pcmSha256: 'b' },
      { id: 'pluck-3', rootNote: 72, pcmSha256: 'c' },
    ]);
    assert.deepEqual(
      zones.map((z) => [z.lo, z.hi, z.rootNote]),
      [
        [0, 54, 48],
        [55, 66, 60],
        [67, 127, 72],
      ],
    );
  });

  it('builds pack, kit, and patches; pack validates; shapes match acceptance', async () => {
    const result = runBuild([CONFIG_PATH, '--out', OUT_DIR]);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const dir = packDir();
    assert.ok(existsSync(join(dir, 'pack.json')));
    assert.ok(existsSync(join(dir, 'house-band.kit.json')));
    assert.ok(existsSync(join(dir, 'house-band.patches.json')));

    const loaded = await loadPackValidatingSidecars(dir);
    assert.equal(loaded.manifest.packId, PACK_ID);

    const kit = JSON.parse(readFileSync(join(dir, 'house-band.kit.json'), 'utf8'));
    assert.equal(kit.lanes.kick.default, 'a');
    assert.ok(kit.lanes.kick.variants.a);
    assert.ok(kit.lanes.kick.variants.b);
    assert.equal(kit.lanes.snare.sample, `${PACK_ID}/snare-a`);
    assert.equal(typeof kit.lanes.snare.gain, 'number');
    assert.equal(typeof kit.lanes.snare.dur, 'number');
    assert.equal(kit.fallbackKit, 'tr808');
    assert.equal(kit.character, 'user kit');
    assert.ok(!Object.hasOwn(kit, 'version'));
    assert.ok(!Object.hasOwn(kit, 'kind'));

    const patches = JSON.parse(readFileSync(join(dir, 'house-band.patches.json'), 'utf8'));
    const zones = patches.pluck.zones;
    assert.equal(patches.pluck.id, 'user:pluck');
    assert.equal(zones.length, 3);
    assert.deepEqual(
      zones.map((z) => [z.lo, z.hi, z.rootNote]),
      [
        [0, 54, 48],
        [55, 66, 60],
        [67, 127, 72],
      ],
    );

    const pack = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'));
    assertNoAbsolutePaths(pack);
    assertNoAbsolutePaths(kit);
    assertNoAbsolutePaths(patches);
    assert.ok(pack.assets.every((a) => a.sourceCollection === 'samples-build'));
  });

  it('building twice with --force yields the same contentSha256', () => {
    const first = runBuild([CONFIG_PATH, '--out', OUT_DIR, '--force']);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const sha1 = JSON.parse(readFileSync(join(packDir(), 'pack.json'), 'utf8')).contentSha256;

    const second = runBuild([CONFIG_PATH, '--out', OUT_DIR, '--force']);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const sha2 = JSON.parse(readFileSync(join(packDir(), 'pack.json'), 'utf8')).contentSha256;
    assert.equal(sha1, sha2);
  });

  it('refuses --out inside repo sample-packs (exit 2)', () => {
    const result = runBuild([CONFIG_PATH, '--out', join(REPO_ROOT, 'sample-packs')]);
    assert.equal(result.status, 2, result.stderr || result.stdout);
  });

  it('refuses existing pack without --force (exit 2)', () => {
    assert.ok(existsSync(packDir()));
    const result = runBuild([CONFIG_PATH, '--out', OUT_DIR]);
    assert.equal(result.status, 2, result.stderr || result.stdout);
  });
});
