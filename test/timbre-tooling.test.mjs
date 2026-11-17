/**
 * The tooling the distinctness claims rest on: the feature extractor and distance,
 * the loudness calibration, and the pack-spec data. Analysis only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aWeightedEnergy, corpusStats, timbreDistance, timbreVector } from '../tools/lib/audio-features.mjs';
import { DRUM_PACKS, PATCH_PACKS } from '../tools/timbre-pack-specs.mjs';
import { KITS } from '../src/presets/kits/index.mjs';
import { PATCHES } from '../src/presets/patches/index.mjs';
import { TRIMS } from '../src/presets/trims.mjs';
import { SR } from './helpers/timbre.mjs';
import { timbrePacksSkip } from './helpers/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tone = (hz, seconds = 1.5, harmonics = 1) => Float32Array.from({ length: Math.floor(seconds * SR) }, (_, i) => {
  let v = 0;
  for (let h = 1; h <= harmonics; h++) v += Math.sin((2 * Math.PI * hz * h * i) / SR) / h;
  return 0.3 * v / Math.sqrt(harmonics);
});
const noiseLike = (seconds = 1.5) => { let s = 1; return Float32Array.from({ length: Math.floor(seconds * SR) }, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return ((s / 4294967296) - 0.5) * 0.4; }); };

describe('timbre distance', () => {
  const sine = timbreVector(tone(220), SR);
  const sine2 = timbreVector(tone(220.5), SR);
  const saw = timbreVector(tone(220, 1.5, 16), SR);
  const noise = timbreVector(noiseLike(), SR);
  const stats = corpusStats([sine, sine2, saw, noise]);

  it('is zero for the same render, tiny for a near-identical one, large across timbres', () => {
    assert.equal(timbreDistance(sine, sine, stats), 0);
    const near = timbreDistance(sine, sine2, stats);
    const sawVsSine = timbreDistance(sine, saw, stats);
    const noiseVsSine = timbreDistance(sine, noise, stats);
    assert.ok(near < 0.25, `near ${near}`);
    assert.ok(sawVsSine > 4 * near && noiseVsSine > 4 * near, `${near} vs ${sawVsSine} / ${noiseVsSine}`);
    assert.ok(Math.abs(timbreDistance(sine, saw, stats) - timbreDistance(saw, sine, stats)) < 1e-12, 'symmetric');
  });

  it('A-weighted energy discounts a low rumble relative to a mid tone of equal level', () => {
    assert.ok(aWeightedEnergy(tone(1000), SR, 0, 1) > 20 * aWeightedEnergy(tone(40), SR, 0, 1));
  });
});

describe('calibration and pack specs', () => {
  it('every kit lane and patch has a trim entry, and each kit keeps its lanes balanced within 1 dB (tools/calibrate-timbre.mjs --check; the +-1.5 LU proof bar is test/timbre-loudness.test.mjs)', { skip: timbrePacksSkip() }, () => {
    const laneKeys = [];
    for (const [id, kit] of Object.entries(KITS)) for (const [lane, def] of Object.entries(kit.lanes)) {
      if (def.variants) for (const v of Object.keys(def.variants)) laneKeys.push(`kit:${id}:${lane}:${v}`);
      else laneKeys.push(`kit:${id}:${lane}`);
    }
    for (const key of [...laneKeys, ...Object.keys(PATCHES).map((id) => `patch:${id}`)]) assert.ok(TRIMS[key] > 0, `missing trim ${key}`);
    const r = spawnSync(process.execPath, [join(root, 'tools', 'calibrate-timbre.mjs'), '--check', '--skip-proof'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /0 beyond 1\.0 dB/);
  });

  it('the pack specs and the generated presets agree: every spec kit and patch exists, lean and pinned', () => {
    for (const spec of DRUM_PACKS) {
      assert.ok(KITS[spec.kit.id], `kit ${spec.kit.id} is registered`);
      assert.equal(KITS[spec.kit.id].pack.packId, spec.packId);
    }
    for (const spec of PATCH_PACKS) for (const patch of spec.patches) {
      assert.ok(PATCHES[patch.id], `patch ${patch.id} is registered`);
      assert.equal(PATCHES[patch.id].pack.packId, spec.packId);
    }
  });
});
