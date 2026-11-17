import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { writeTestSf2, FIXTURE } from './helpers/write-sf2.mjs';
import { validateSamplesConfig } from '../src/samples/config.mjs';
import { importSf2, parseSf2 } from '../src/samples/sf2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'tools', 'samples', 'from-sf2.mjs');

function readWavInfo(path) {
  const b = readFileSync(path);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let fmt = null;
  let dataSize = null;
  while (offset + 8 <= b.length) {
    const id = b.toString('ascii', offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: b.readUInt16LE(offset + 8),
        channels: b.readUInt16LE(offset + 10),
        sampleRate: b.readUInt32LE(offset + 12),
        bits: b.readUInt16LE(offset + 22),
      };
    }
    if (id === 'data') dataSize = size;
    offset += 8 + size + (size % 2);
  }
  assert.ok(fmt, 'missing fmt');
  assert.ok(dataSize !== null, 'missing data');
  return {
    ...fmt,
    frameCount: dataSize / (fmt.channels * (fmt.bits / 8)),
  };
}

describe('OSS-15 SF2 import', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let sf2Path;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hb-sf2-'));
    sf2Path = join(dir, 'test-keys.sf2');
    writeTestSf2(sf2Path);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fixture SF2 parses with preset Test Keys and three samples', () => {
    const sf2 = parseSf2(readFileSync(sf2Path));
    assert.equal(sf2.presets.length, 1);
    assert.equal(sf2.presets[0].name, 'Test Keys');
    assert.equal(sf2.samples.length, 3);
    assert.equal(sf2.samples[0].sampleType, 1);
    assert.equal(sf2.samples[1].sampleType, 4);
    assert.equal(sf2.samples[2].sampleType, 2);
  });

  it('writes two WAVs with expected frames/rate and zones 0-59/48 and 60-127/72', () => {
    const out = join(dir, 'by-index', 'house-band.samples.json');
    const wavDir = join(dir, 'by-index', 'test-keys-wav');
    const result = importSf2({
      sf2Path,
      patchClass: 'pluck',
      preset: 0,
      id: 'test-keys',
      outPath: out,
      wavDir,
    });

    assert.equal(result.sampleFiles.length, 2);
    const wavA = readWavInfo(join(wavDir, 'a.wav'));
    const wavB = readWavInfo(join(wavDir, 'b.wav'));
    assert.equal(wavA.sampleRate, FIXTURE.sampleRate);
    assert.equal(wavB.sampleRate, FIXTURE.sampleRate);
    assert.equal(wavA.channels, 1);
    assert.equal(wavA.bits, 16);
    assert.equal(wavA.frameCount, FIXTURE.sampleA.frames);
    assert.equal(wavB.frameCount, FIXTURE.sampleB.frames);

    const zones = result.config.patches['test-keys'].zones;
    assert.deepEqual(zones, [
      { file: 'a.wav', rootNote: 48, lo: 0, hi: 59 },
      { file: 'b.wav', rootNote: 72, lo: 60, hi: 127 },
    ]);

    const validated = validateSamplesConfig(result.config, { baseDir: dirname(out) });
    assert.equal(validated.patches['test-keys'].zones.length, 2);
    assert.equal(validated.source.type, 'sf2');
    assert.equal(validated.source.preset, 'Test Keys');
  });

  it('--preset 0 and --preset "Test Keys" give the same zones', () => {
    const outA = join(dir, 'preset-idx', 'house-band.samples.json');
    const outB = join(dir, 'preset-name', 'house-band.samples.json');
    const a = importSf2({
      sf2Path,
      patchClass: 'pluck',
      preset: 0,
      id: 'test-keys',
      outPath: outA,
      wavDir: join(dir, 'preset-idx', 'wav'),
    });
    const b = importSf2({
      sf2Path,
      patchClass: 'pluck',
      preset: 'Test Keys',
      id: 'test-keys',
      outPath: outB,
      wavDir: join(dir, 'preset-name', 'wav'),
    });
    assert.deepEqual(a.config.patches['test-keys'].zones, b.config.patches['test-keys'].zones);
  });

  it('unknown preset name exits 2 listing preset names', () => {
    const r = spawnSync(process.execPath, [CLI, sf2Path, '--class', 'pluck', '--preset', 'Nope'], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Test Keys/);
    assert.match(r.stderr, /unknown preset/i);
  });

  it('CLI writes a config that validates', () => {
    const outDir = join(dir, 'cli');
    const out = join(outDir, 'house-band.samples.json');
    const r = spawnSync(
      process.execPath,
      [CLI, sf2Path, '--class', 'pluck', '--preset', 'Test Keys', '--id', 'test-keys', '--out', out],
      { encoding: 'utf8', cwd: ROOT },
    );
    assert.equal(r.status, 0, `cli failed: ${r.stderr}`);
    const config = JSON.parse(readFileSync(out, 'utf8'));
    validateSamplesConfig(config, { baseDir: dirname(out) });
    assert.match(r.stdout, /ignored generators/i);
  });
});
