import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HouseBandApiService } from '../src/api/service.mjs';
import { normalizePerformance, performanceAdjustment } from '../src/kit/band.js';
import { renderSpecToWav } from '../src/render.mjs';
import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { sampleRenderPlan } from '../src/sample-render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => JSON.parse(readFileSync(join(root, 'test', 'fixtures', name), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function score(performance) {
  return {
    schemaVersion: '1.1.0',
    kitVersion: KIT_VERSION,
    seed: 0x51a7c0de,
    tempo: 240,
    sampleRate: 44100,
    gain: 0.42,
    register: { name: 'kit-demo', briefRef: 'docs/REGISTER-KIT-DEMO.md' },
    ...(performance === undefined ? {} : { performance }),
    tracks: {
      proof: {
        bpm: 240,
        len: 16,
        vol: 0.8,
        steps: [
          { i: [0, 8], voice: 'pad', note: 'C3', dur: 0.35, opts: { vol: 0.05, verb: 0, r: 0.1 } },
          { i: [1, 5, 9, 13], voice: 'pluck', note: 'G4', dur: 0.08, opts: { vol: 0.05, verb: 0 } },
          { i: [1, 5, 9, 13], voice: 'hat', opts: { vol: 0.035, verb: 0 } },
        ],
      },
    },
    sections: [{ track: 'proof', bars: 1, fadeIn: 0.01 }],
  };
}

async function wavFor(performance, opts = { tailSeconds: 0.6 }) {
  return (await renderSpecToWav(validateSpec(score(performance)), opts)).wav;
}

describe('Performance-Pass API', () => {
  it('renders an opted-in performance pass byte-identically for the same seed', async () => {
    const performance = {
      humanize: { timingMs: [-9, 7], velocity: [-0.08, 0.06], swing: 0.16 },
      releaseTail: 0.45,
      voices: { pad: { humanize: { timingMs: [-3, 5] }, releaseTail: 0.8 } },
    };
    const first = await wavFor(performance, { tailSeconds: 1.2 });
    const second = await wavFor(performance, { tailSeconds: 1.2 });
    assert.ok(first.equals(second), 'same score seed and performance knobs must produce identical PCM');
  });

  it('makes timing, velocity, swing, and release knobs independently audible in the render bytes', async () => {
    const baseline = await wavFor(undefined, { tailSeconds: 1.2 });
    const variants = {
      timing: await wavFor({ humanize: { timingMs: [-12, 12] } }, { tailSeconds: 1.2 }),
      velocity: await wavFor({ humanize: { velocity: [-0.15, 0.15] } }, { tailSeconds: 1.2 }),
      swing: await wavFor({ humanize: { swing: 0.4 } }, { tailSeconds: 1.2 }),
      release: await wavFor({ releaseTail: 0.7 }, { tailSeconds: 1.2 }),
    };
    for (const [knob, wav] of Object.entries(variants)) {
      assert.notEqual(hash(wav), hash(baseline), `${knob} knob did not change rendered PCM`);
    }
  });

  it('supports per-voice neutral overrides of score-level humanization', async () => {
    const baselineHat = await renderSpecToWav(validateSpec(score()), { voice: 'hat', tailSeconds: 0.6 });
    const overriddenHat = await renderSpecToWav(validateSpec(score({
      humanize: { timingMs: [10, 10], velocity: [0.2, 0.2], swing: 0.3 },
      voices: { hat: { humanize: { timingMs: [0, 0], velocity: [0, 0], swing: 0 } } },
    })), { voice: 'hat', tailSeconds: 0.6 });
    assert.ok(Buffer.from(baselineHat.wav).equals(Buffer.from(overriddenHat.wav)));
  });

  it('keeps the neutral opt-in path byte-identical to an undeclared score', async () => {
    const undeclared = await wavFor(undefined, { tailSeconds: 0.6 });
    const explicitNeutral = await wavFor({}, { tailSeconds: 0.6 });
    assert.ok(undeclared.equals(explicitNeutral));
  });

  it('validates ranges, release voice scope, and current-kit custody', () => {
    assert.doesNotThrow(() => validateSpec(score({ humanize: { timingMs: [-5, 8], velocity: [-0.1, 0.05], swing: 0.2 }, releaseTail: 0.5 })));

    const reversed = score({ humanize: { timingMs: [5, -5] } });
    assert.throws(() => validateSpec(reversed), /min must be less than or equal to max/);

    const wrongRelease = score({ voices: { lead: { releaseTail: 1 } } });
    assert.throws(() => validateSpec(wrongRelease), /only for pad and drone/);

    const historicalKit = score({ releaseTail: 0.5 });
    historicalKit.kitVersion = fixture('golden-spec.json').kitVersion;
    assert.throws(() => validateSpec(historicalKit), /requires kit 1\.2\.0 or newer/);
  });

  it('admits performance settings through the public score-validation API', () => {
    const service = new HouseBandApiService({ store: {} });
    const result = service.validateScoreRequest({
      expectedSchemaVersion: '1.1.0',
      score: score({ humanize: { timingMs: [-7, 6], velocity: [-0.04, 0.05], swing: 0.1 }, voices: { pad: { releaseTail: 0.75 } } }),
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.canonicalScore.performance.voices.pad, { releaseTail: 0.75 });
  });

  it('applies the same deterministic timing and velocity contract to sample-backed voices', async () => {
    const source = JSON.parse(readFileSync(join(root, 'examples', 'm3-sample-spec.json'), 'utf8'));
    source.kitVersion = KIT_VERSION;
    source.performance = { humanize: { timingMs: [-8, 8], velocity: [-0.1, 0.1], swing: 0.15 } };
    const artifact = validateSpec(source);
    const pack = await loadSamplePackDirectory(join(root, 'sample-packs', 'hb-synth-oneshots'));
    const first = sampleRenderPlan(artifact, pack);
    const second = sampleRenderPlan(artifact, pack);
    assert.deepEqual(first.events, second.events);

    const neutral = structuredClone(source);
    delete neutral.performance;
    const neutralPlan = sampleRenderPlan(validateSpec(neutral), pack);
    assert.notDeepEqual(
      first.events.map(({ startFrame, gainQ16 }) => [startFrame, gainQ16]),
      neutralPlan.events.map(({ startFrame, gainQ16 }) => [startFrame, gainQ16]),
    );
  });

  it('derives stable, voice-addressed values without call-order coupling across voices', () => {
    const performance = normalizePerformance({ humanize: { timingMs: [-10, 10], velocity: [-0.2, 0.2], swing: 0.25 } });
    const input = { seed: 91, absoluteStep: 7, stepIndex: 7, stepSeconds: 0.125, voice: 'pad', call: 2 };
    assert.deepEqual(performanceAdjustment(performance, input), performanceAdjustment(performance, input));
    assert.notDeepEqual(
      performanceAdjustment(performance, input),
      performanceAdjustment(performance, { ...input, voice: 'pluck' }),
    );
  });
});
