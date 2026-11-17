import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSamplesConfig } from '../src/samples/config.mjs';
import {
  parseSfz,
  regionsToZones,
  sfzToSamplesConfig,
  slugifySfzName,
} from '../src/samples/sfz.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CLI = join(REPO_ROOT, 'tools', 'samples', 'from-sfz.mjs');

/** Acceptance SFZ: soft+loud velocity layers, key=c4, spaces, flac, comments, ignored opcode. */
const ACCEPTANCE_SFZ = `
<control>
default_path=samples\\

/* block comment about the instrument */

<group>
lovel=0 hivel=64
ampeg_release=0.5
<region> sample=soft-low.wav lokey=0 hikey=59 pitch_keycenter=48
<region> sample=soft mid.wav key=c4
<region> sample=soft-high.wav lokey=61 hikey=127 pitch_keycenter=72

<group>
lovel=65 hivel=127
<region> sample=loud-low.wav lokey=0 hikey=59 pitch_keycenter=48
<region> sample=Piano C4.wav lokey=60 hikey=60 pitch_keycenter=60
<region> sample=loud-high.wav lokey=61 hikey=127 pitch_keycenter=72
<region> sample=bonus.flac lokey=0 hikey=127
`;

describe('OSS-14 SFZ import', () => {
  it('parseSfz strips comments, inherits group opcodes, expands key=c4, prefixes default_path', () => {
    const parsed = parseSfz(ACCEPTANCE_SFZ);
    assert.ok(parsed.ignoredOpcodes.includes('ampeg_release'));
    assert.equal(parsed.regions.length, 7);

    const softMid = parsed.regions[1];
    assert.equal(softMid.sample, 'samples/soft mid.wav');
    assert.equal(softMid.lokey, 60);
    assert.equal(softMid.hikey, 60);
    assert.equal(softMid.pitch_keycenter, 60);
    assert.equal(softMid.hivel, 64);

    const loudMid = parsed.regions[4];
    assert.equal(loudMid.sample, 'samples/Piano C4.wav');
    assert.equal(loudMid.hivel, 127);
  });

  it('keeps three loud-group zones only; drops flac; reports ignored opcode', () => {
    const parsed = parseSfz(ACCEPTANCE_SFZ);
    const { zones, unsupported } = regionsToZones(parsed.regions);

    assert.deepEqual(
      zones.map((z) => z.file),
      ['samples/loud-low.wav', 'samples/Piano C4.wav', 'samples/loud-high.wav'],
    );
    assert.deepEqual(zones, [
      { file: 'samples/loud-low.wav', rootNote: 48, lo: 0, hi: 59 },
      { file: 'samples/Piano C4.wav', rootNote: 60, lo: 60, hi: 60 },
      { file: 'samples/loud-high.wav', rootNote: 72, lo: 61, hi: 127 },
    ]);
    assert.deepEqual(unsupported, ['samples/bonus.flac']);
    assert.deepEqual(parsed.ignoredOpcodes, ['ampeg_release']);
  });

  it('sfzToSamplesConfig output passes validateSamplesConfig', () => {
    const { config, ignoredOpcodes, unsupported } = sfzToSamplesConfig({
      text: ACCEPTANCE_SFZ,
      patchClass: 'pluck',
      id: 'test-keys',
      displayName: 'Test Keys',
      sourcePath: join(REPO_ROOT, 'examples'),
    });
    assert.equal(config.source.type, 'sfz');
    assert.equal(config.patches['test-keys'].zones.length, 3);
    assert.ok(ignoredOpcodes.includes('ampeg_release'));
    assert.ok(unsupported.includes('samples/bonus.flac'));

    const out = validateSamplesConfig(config, { baseDir: REPO_ROOT });
    assert.equal(out.patches['test-keys'].class, 'pluck');
    assert.equal(out.patches['test-keys'].zones.length, 3);
  });

  it('CLI writes config that validates and prints ignored/unsupported lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-sfz-'));
    try {
      const sfzPath = join(dir, 'Piano Pad.sfz');
      writeFileSync(sfzPath, ACCEPTANCE_SFZ, 'utf8');
      mkdirSync(join(dir, 'samples'), { recursive: true });
      const outPath = join(dir, 'house-band.samples.json');

      const run = spawnSync(
        process.execPath,
        [CLI, sfzPath, '--class', 'pad', '--out', outPath],
        { encoding: 'utf8' },
      );
      assert.equal(run.status, 0, `CLI failed: ${run.stderr || run.stdout}`);
      assert.match(run.stdout, /ignored opcodes: ampeg_release/);
      assert.match(run.stdout, /unsupported: samples\/bonus\.flac/);

      const config = JSON.parse(readFileSync(outPath, 'utf8'));
      assert.equal(config.id, slugifySfzName('Piano Pad.sfz'));
      assert.equal(config.id, 'piano-pad');
      assert.equal(config.source.type, 'sfz');
      assert.equal(config.source.path, dir);
      assert.equal(config.patches['piano-pad'].class, 'pad');
      assert.equal(config.patches['piano-pad'].zones.length, 3);

      const validated = validateSamplesConfig(config, { baseDir: dir });
      assert.equal(validated.patches['piano-pad'].zones[1].file, 'samples/Piano C4.wav');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
