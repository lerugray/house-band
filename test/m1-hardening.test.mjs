import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineAudioContext } from 'node-web-audio-api';
import { pinnedSkip } from './helpers/env.mjs';

import { createBand, noteFreq } from '../src/kit/band.js';
import { CHAPEL_PERILOUS_PRESET } from '../src/presets/chapel-perilous.mjs';
import { renderSpecToWav } from '../src/render.mjs';
import { kitIdentitySha } from '../tools/lib/kit-identity.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';
import { encodeWav } from '../src/wav.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => JSON.parse(readFileSync(join(root, 'test', 'fixtures', name), 'utf8'));

describe('kit identity', () => {
  it('declared kit SHA-256 matches the canonical source bytes', () => {
    // Kit 1.11.0: band.js, prng.js, src/timbre.mjs and every file under src/presets/ (tools/lib/kit-identity.mjs).
    assert.equal(kitIdentitySha(root), KIT_VERSION.sha);
  });

  it('rejects an artifact pinned to any other kit identity', () => {
    const wrong = fixture('golden-spec.json');
    wrong.kitVersion.sha = '0'.repeat(64);
    assert.throws(() => validateSpec(wrong), /unsupported kit/);
  });
});

describe('scoped golden render', () => {
  it('pins same artifact + seed + kitVersion to the reviewed output hash', { skip: pinnedSkip() }, async () => {
    const expected = fixture('golden-output.json');
    const artifact = validateSpec(fixture('golden-spec.json'));
    const { wav, manifest } = await renderSpecToWav(artifact);

    assert.deepEqual(manifest.kitVersion, expected.kitVersion);
    assert.deepEqual(manifest.render.toolchain, expected.toolchain, 'golden toolchain boundary changed');
    assert.equal(manifest.render.sampleRate, expected.sampleRate);
    assert.equal(manifest.render.frames, expected.frames);
    assert.equal(wav.length, expected.bytes);
    assert.equal(manifest.output.sha256, expected.outputSha256);
  });

  it('changes the output hash when the seed changes', async () => {
    const first = fixture('golden-spec.json');
    const second = fixture('golden-spec.json');
    second.seed += 1;
    const a = await renderSpecToWav(validateSpec(first));
    const b = await renderSpecToWav(validateSpec(second));
    assert.notEqual(a.manifest.output.sha256, b.manifest.output.sha256);
  });

  it('rejects any sample rate outside the pinned 44100 Hz scope', () => {
    const wrong = fixture('golden-spec.json');
    wrong.sampleRate = 48000;
    assert.throws(() => validateSpec(wrong), /fixed value 44100/);
  });
});

describe('source-register compatibility', () => {
  it('preserves the committed pre-M1 tuning behind the named external preset', { skip: pinnedSkip() }, async () => {
    // This hash was independently byte-compared against the same fragment run
    // through band.js at baselineCommit. The fixture keeps that proof hermetic.
    const expected = fixture('historical-preset-compat-output.json');
    const sampleRate = 44100;
    const context = new OfflineAudioContext(2, expected.frames, sampleRate);
    const band = createBand({
      ctx: context,
      seed: 123,
      ...CHAPEL_PERILOUS_PRESET.band,
      voiceDefaults: CHAPEL_PERILOUS_PRESET.voices,
    });
    band.registerTrack('compat', {
      bpm: 240,
      len: 16,
      vol: 0.8,
      step(index, time, state) {
        if (index === 0) {
          state.v.pad(time, noteFreq('C3'), 0.5);
          state.v.kick(time);
        }
        if (index === 4) state.v.hat(time);
        if (index === 8) state.v.bell(time, noteFreq('C4'), 0.2);
      },
    });
    let now = 0;
    band.setTrack('compat', { now });
    while (now < 1) {
      band.tick(now);
      now = Math.min(1, now + 0.11);
    }
    band.tick(1);
    const wav = encodeWav(await context.startRendering());
    band.dispose();

    assert.equal(context.sampleRate, expected.sampleRate);
    assert.equal(wav.length, expected.bytes);
    assert.equal(createHash('sha256').update(wav).digest('hex'), expected.outputSha256);
  });
});
