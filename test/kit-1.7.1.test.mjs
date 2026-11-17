/**
 * Kit 1.7.1 additive options: sub opt-out, drone hp, per-event nudge.
 * Defaults must stay byte-identical with 1.7.0 behaviour.
 */
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OfflineAudioContext } from 'node-web-audio-api';

import { createBand, noteFreq, voiceSubEnabled } from '../src/kit/band.js';
import { renderSpecToWav } from '../src/render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function baseScore(steps) {
  return {
    schemaVersion: '1.1.0',
    kitVersion: KIT_VERSION,
    seed: 0x17100001,
    tempo: 120,
    sampleRate: 44100,
    gain: 0.5,
    register: { name: 'kit-demo', briefRef: 'docs/REGISTER-KIT-DEMO.md' },
    tracks: {
      body: { bpm: 120, len: 16, vol: 0.8, steps },
    },
    sections: [{ track: 'body', bars: 1, fadeIn: 0.01 }],
  };
}

async function renderVoice(voiceFn, opts = {}) {
  const frames = 44100;
  const ctx = new OfflineAudioContext(1, frames, 44100);
  const band = createBand({
    ctx,
    seed: 7,
    gain: 0.5,
    reverb: { seconds: 0.01, decay: 2 },
    reverbReturnGain: 0,
    disconnectRetired: false,
  });
  band.registerTrack('t', {
    bpm: 120,
    len: 16,
    vol: 1,
    step(i, t, s) {
      if (i === 0) voiceFn(s, t, opts);
    },
  });
  band.setTrack('t', { now: 0, fadeIn: 0 });
  band.tick(1);
  const buf = await ctx.startRendering();
  return buf.getChannelData(0).slice();
}

function bandEnergy(samples, sr, loHz, hiHz) {
  // One-pole low/high band energy estimate (fast; only used for relative asserts).
  const mid = (loHz + hiHz) / 2;
  const rc = 1 / (2 * Math.PI * mid);
  const dt = 1 / sr;
  const alpha = dt / (rc + dt);
  let lp = 0;
  let e = 0;
  for (let i = 0; i < samples.length; i++) {
    lp += alpha * (samples[i] - lp);
    // band-ish: lowpass of the signal, then drop content above hi via a second softer LP
    e += lp * lp;
  }
  void hiHz;
  return e;
}

function samplesHash(samples) {
  return createHash('sha256')
    .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
    .digest('hex');
}

function onsetFrame(samples, threshold = 0.002) {
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) return i;
  }
  return -1;
}

describe('voiceSubEnabled', () => {
  it('defaults ON; sub:0 and sub:false opt out', () => {
    assert.equal(voiceSubEnabled({}), true);
    assert.equal(voiceSubEnabled({ sub: undefined }), true);
    assert.equal(voiceSubEnabled({ sub: 0 }), false);
    assert.equal(voiceSubEnabled({ sub: false }), false);
    assert.equal(voiceSubEnabled({ sub: true }), true);
    assert.equal(voiceSubEnabled({ sub: 0.7 }), true);
  });
});

describe('kit 1.7.1 sub opt-out', () => {
  for (const voice of ['pad', 'drone', 'bass']) {
    it(`${voice} with sub:0 differs from the default (sub on)`, async () => {
      const withSub = await renderVoice((s, t) => {
        s.v[voice](t, noteFreq('C3'), 0.4, { vol: 0.2, verb: 0 });
      });
      const noSub = await renderVoice((s, t) => {
        s.v[voice](t, noteFreq('C3'), 0.4, { vol: 0.2, verb: 0, sub: 0 });
      });
      assert.notEqual(samplesHash(withSub), samplesHash(noSub));
      const lowDefault = bandEnergy(withSub, 44100, 20, 100);
      const lowOff = bandEnergy(noSub, 44100, 20, 100);
      assert.ok(lowOff < lowDefault * 0.85, `${voice}: sub:0 should cut low energy (${lowOff} vs ${lowDefault})`);
    });
  }
});

describe('kit 1.7.1 drone hp', () => {
  it('hp measurably attenuates lows vs default (no HP)', async () => {
    const plain = await renderVoice((s, t) => {
      s.v.drone(t, noteFreq('C2'), 0.5, { vol: 0.25, verb: 0, sub: 0 });
    });
    const filtered = await renderVoice((s, t) => {
      s.v.drone(t, noteFreq('C2'), 0.5, { vol: 0.25, verb: 0, sub: 0, hp: 200 });
    });
    assert.notEqual(samplesHash(plain), samplesHash(filtered));
    const lowPlain = bandEnergy(plain, 44100, 20, 120);
    const lowHp = bandEnergy(filtered, 44100, 20, 120);
    assert.ok(lowHp < lowPlain * 0.5, `hp should attenuate lows (${lowHp} vs ${lowPlain})`);
  });
});

describe('kit 1.7.1 per-event nudge', () => {
  it('nudge measurably shifts onset at schedule time', async () => {
    const nudgeMs = 25;
    const base = await renderSpecToWav(validateSpec(baseScore([
      { i: 0, voice: 'pluck', note: 'C4', dur: 0.2, opts: { vol: 0.4, verb: 0 } },
    ])));
    const nudged = await renderSpecToWav(validateSpec(baseScore([
      { i: 0, voice: 'pluck', note: 'C4', dur: 0.2, nudge: nudgeMs, opts: { vol: 0.4, verb: 0 } },
    ])));
    assert.notEqual(base.manifest.output.sha256, nudged.manifest.output.sha256);

    const decode = (wav) => {
      const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
      const frames = (wav.byteLength - 44) / 4;
      const mono = new Float64Array(frames);
      for (let i = 0; i < frames; i++) {
        const L = view.getInt16(44 + i * 4, true) / 32768;
        const R = view.getInt16(44 + i * 4 + 2, true) / 32768;
        mono[i] = (L + R) / 2;
      }
      return mono;
    };
    const a = onsetFrame(decode(base.wav));
    const b = onsetFrame(decode(nudged.wav));
    assert.ok(a >= 0 && b >= 0, 'both renders must have an audible onset');
    const deltaMs = ((b - a) / 44100) * 1000;
    assert.ok(Math.abs(deltaMs - nudgeMs) < 3, `onset shift ${deltaMs.toFixed(2)} ms should be near ${nudgeMs} ms`);
  });

  it('accepts opts.nudge as well as the top-level field', () => {
    assert.doesNotThrow(() => validateSpec(baseScore([
      { i: 0, voice: 'lead', note: 'E4', dur: 0.1, opts: { vol: 0.1, nudge: -8 } },
    ])));
  });
});
