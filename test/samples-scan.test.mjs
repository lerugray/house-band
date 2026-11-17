import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { validateSamplesConfig } from '../src/samples/config.mjs';
import { scanSamples, tokenize, matchDrumTokens, slugify } from '../src/samples/scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const FIXTURE = join(HERE, 'fixtures', 'samples-scan');
const OUT_DIR = join(HERE, 'fixtures', 'samples-scan-out');
const OUT_JSON = join(OUT_DIR, 'house-band.samples.json');
const OUT_REPORT = join(OUT_DIR, 'house-band.samples.report.json');

const SAMPLE_RATE = 44100;

/** PCM16LE mono WAV; optional smpl unity note. */
function makeWav(durationSec, { midiUnityNote = null } = {}) {
  const frames = Math.max(1, Math.round(durationSec * SAMPLE_RATE));
  const dataSize = frames * 2;
  const smplBody = 36;
  const smplChunk = midiUnityNote != null ? 8 + smplBody : 0;
  const riffSize = 4 + (8 + 16) + smplChunk + (8 + dataSize);
  const buf = Buffer.alloc(8 + riffSize);
  let o = 0;
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(riffSize, o); o += 4;
  buf.write('WAVE', o); o += 4;
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(16, o); o += 4;
  buf.writeUInt16LE(1, o); o += 2; // PCM
  buf.writeUInt16LE(1, o); o += 2; // mono
  buf.writeUInt32LE(SAMPLE_RATE, o); o += 4;
  buf.writeUInt32LE(SAMPLE_RATE * 2, o); o += 4;
  buf.writeUInt16LE(2, o); o += 2;
  buf.writeUInt16LE(16, o); o += 2;
  if (midiUnityNote != null) {
    buf.write('smpl', o); o += 4;
    buf.writeUInt32LE(smplBody, o); o += 4;
    buf.writeUInt32LE(0, o); o += 4; // manufacturer
    buf.writeUInt32LE(0, o); o += 4; // product
    buf.writeUInt32LE(Math.round(1e9 / SAMPLE_RATE), o); o += 4; // sample period (ns)
    buf.writeUInt32LE(midiUnityNote, o); o += 4;
    buf.writeUInt32LE(0, o); o += 4; // pitch fraction
    buf.writeUInt32LE(0, o); o += 4; // SMPTE format
    buf.writeUInt32LE(0, o); o += 4; // SMPTE offset
    buf.writeUInt32LE(0, o); o += 4; // num loops
    buf.writeUInt32LE(0, o); o += 4; // sampler data
  }
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(dataSize, o); o += 4;
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE((i * 13) % 1000, o);
    o += 2;
  }
  return buf;
}

function writeFixtureTree() {
  rmSync(FIXTURE, { recursive: true, force: true });
  const files = {
    'Kicks/BD Tight.wav': makeWav(0.2),
    'Kicks/BD Long.wav': makeWav(0.4),
    'Snare 01.wav': makeWav(0.25),
    'HH closed.wav': makeWav(0.15),
    'OH.wav': makeWav(0.3),
    'perc/cowbell.wav': makeWav(0.2),
    'Keys/Rhodes C3.wav': makeWav(0.5, { midiUnityNote: 60 }),
    'Keys/Rhodes C4.wav': makeWav(0.5),
    'Pads/warm.wav': makeWav(3.0),
    'Loops/kick loop.wav': makeWav(4.0),
    'notes.aif': Buffer.from('not a real aiff'),
  };
  for (const [rel, bytes] of Object.entries(files)) {
    const abs = join(FIXTURE, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
}

describe('OSS-11 samples scan', () => {
  before(() => {
    writeFixtureTree();
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
  });

  after(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    rmSync(OUT_DIR, { recursive: true, force: true });
  });

  it('tokenizes letter/digit boundaries', () => {
    assert.deepEqual(tokenize('BD01'), ['bd', '01']);
    assert.deepEqual(tokenize('Kicks/BD Tight.wav'), ['kicks', 'bd', 'tight', 'wav']);
  });

  it('matches drum tokens in card order', () => {
    assert.equal(matchDrumTokens(['oh']).role, 'hat.open');
    assert.equal(matchDrumTokens(['hh']).role, 'hat.closed');
    assert.equal(matchDrumTokens(['bd']).role, 'kick.a');
    assert.equal(matchDrumTokens(['cowbell']).role, 'perc.cowbell');
    assert.equal(matchDrumTokens(['cb']).role, 'perc.cowbell');
    assert.equal(matchDrumTokens(['conga', 'high']).role, 'perc.conga-high');
  });

  it('slugify makes valid ids', () => {
    assert.equal(slugify('My Drums'), 'my-drums');
    assert.match(slugify('My Drums'), /^[a-z][a-z0-9-]{0,47}$/);
  });

  it('acceptance fixture: CLI maps roles, writes validating config and report', () => {
    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'tools', 'samples', 'scan.mjs'),
        FIXTURE,
        '--out',
        OUT_JSON,
        '--id',
        'scan-fixture',
      ],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(OUT_JSON));
    assert.ok(existsSync(OUT_REPORT));

    const config = JSON.parse(readFileSync(OUT_JSON, 'utf8'));
    const report = JSON.parse(readFileSync(OUT_REPORT, 'utf8'));
    const validated = validateSamplesConfig(config, { baseDir: OUT_DIR });
    assert.ok(validated);

    assert.equal(config.kit.kick.a, 'Kicks/BD Long.wav');
    assert.equal(config.kit.kick.b, 'Kicks/BD Tight.wav');
    assert.equal(config.kit.snare.a, 'Snare 01.wav');
    assert.equal(config.kit.hat.closed, 'HH closed.wav');
    assert.equal(config.kit.hat.open, 'OH.wav');
    assert.equal(config.kit.perc.cowbell, 'perc/cowbell.wav');

    assert.ok(config.patches.keys);
    assert.equal(config.patches.keys.class, 'pluck');
    assert.equal(config.patches.keys.zones, 'auto');
    assert.deepEqual(config.patches.keys.files, ['Keys/Rhodes C3.wav', 'Keys/Rhodes C4.wav']);

    assert.ok(report.unused.includes('Loops/kick loop.wav'));
    assert.ok(report.unused.includes('Pads/warm.wav'));
    assert.ok(report.unsupported.includes('notes.aif'));
    for (const lane of ['tomLow', 'ride', 'crash', 'clap', 'rim']) {
      assert.ok(report.unmapped.includes(lane), `expected unmapped ${lane}`);
    }

    assert.match(result.stdout, /MAPPED kick\.a <- Kicks\/BD Long\.wav/);
    assert.match(result.stdout, /UNMAPPED tomLow \(falls back to tr808\)/);
    assert.match(result.stdout, /UNUSED 2 files/);
    assert.match(result.stdout, /UNSUPPORTED 1 files/);
  });

  it('refuses to overwrite without --force', () => {
    writeFileSync(OUT_JSON, '{}\n');
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'tools', 'samples', 'scan.mjs'), FIXTURE, '--out', OUT_JSON],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to overwrite/);
  });

  it('pure scanSamples returns mapping for the fixture descriptors', () => {
    const files = [
      { file: 'Kicks/BD Tight.wav', durationSec: 0.2 },
      { file: 'Kicks/BD Long.wav', durationSec: 0.4 },
      { file: 'Snare 01.wav', durationSec: 0.25 },
      { file: 'HH closed.wav', durationSec: 0.15 },
      { file: 'OH.wav', durationSec: 0.3 },
      { file: 'perc/cowbell.wav', durationSec: 0.2 },
      { file: 'Keys/Rhodes C3.wav', durationSec: 0.5, midiUnityNote: 60 },
      { file: 'Keys/Rhodes C4.wav', durationSec: 0.5 },
      { file: 'Pads/warm.wav', durationSec: 3.0 },
      { file: 'Loops/kick loop.wav', durationSec: 4.0 },
    ];
    const { config, report } = scanSamples(files, {
      unsupported: ['notes.aif'],
      id: 'scan-fixture',
      displayName: 'samples-scan',
      sourcePath: FIXTURE,
    });
    assert.equal(config.kit.kick.a, 'Kicks/BD Long.wav');
    assert.equal(config.kit.kick.b, 'Kicks/BD Tight.wav');
    assert.equal(config.patches.keys.class, 'pluck');
    assert.ok(report.unused.includes('Pads/warm.wav'));
  });
});
