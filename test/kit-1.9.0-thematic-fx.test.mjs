/**
 * Kit 1.9.0 — THE THEMATIC SET, and the two bugs it fixes.
 *
 * The 1.8.0 file's contract carries over unchanged: every claim about an effect
 * is measured off the RENDERED PCM, never read back out of the config that
 * produced it. Where an effect has a closed form (the quantiser's lattice, the
 * zero-order hold's sinc nulls, wow/flutter's pitch deviation, ring modulation's
 * sidebands) the test asserts against the theory, not against a captured hash —
 * a golden only tells you something changed, a closed form tells you the DSP is
 * still the DSP it says it is.
 *
 * The two bug-fix sections at the end are kill-proofed: each asserts the
 * quantity that was provably WRONG before the fix (a release sweep that moved
 * the audible end by 0.0000 s; a 0.4 s note that ended 0.0588 s in; a render
 * that stopped with its last 10 ms at -24.8 dB below peak), so restoring the old
 * code reddens them rather than passing quietly.
 */
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OfflineAudioContext } from 'node-web-audio-api';

import {
  BITCRUSH_PRESETS,
  bitcrushCurve,
  createBand,
  FX_KINDS,
  FX_MAX_HISS,
  FX_VOICE_SEND,
  fxTailSeconds,
  noteFreq,
  normalizeBitcrushFx,
  normalizeFx,
  normalizeRingmodFx,
  normalizeSnesverbFx,
  normalizeSpringFx,
  normalizeTapeFx,
  RETIRE_MODES,
  RINGMOD_PRESETS,
  SNES_EDL_STEP_SECONDS,
  SNES_FIR_PRESETS,
  SNES_FIR_SCALE,
  SNES_FIR_TAPS,
  SNESVERB_PRESETS,
  SPRING_PRESETS,
  TAPE_PRESETS,
  voiceTailSeconds,
} from '../src/kit/band.js';
import { renderSpec, renderSpecToWav } from '../src/render.mjs';
import { specDuration, specTailOverhangSeconds, validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';

const SR = 44100;

// ---------------------------------------------------------------------------
// measurement helpers
// ---------------------------------------------------------------------------

/** Magnitude at one frequency, by Goertzel — no FFT, no windowing surprises. */
function magnitudeAt(x, frequency, fromSeconds = 0.3, samples = 16384) {
  const from = Math.round(fromSeconds * SR);
  const w = (2 * Math.PI * frequency) / SR;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  const end = Math.min(x.length, from + samples);
  for (let i = from; i < end; i++) {
    const t = coeff * s1 - s2 + x[i];
    s2 = s1;
    s1 = t;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / samples;
}

function envelope(x, hopSeconds = 0.01) {
  const hop = Math.max(1, Math.round(SR * hopSeconds));
  const values = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += x[j] * x[j];
    values.push(Math.sqrt(s / hop));
  }
  return { values, hopSeconds: hop / SR };
}

function tailSeconds(x, floorDb = -40) {
  const env = envelope(x, 0.01);
  const peak = Math.max(...env.values);
  if (peak <= 0) return 0;
  const floor = peak * 10 ** (floorDb / 20);
  let first = -1;
  let last = 0;
  for (let i = 0; i < env.values.length; i++) {
    if (env.values[i] >= floor) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? 0 : (last - first) * env.hopSeconds;
}

/** Lag of the strongest repeat in the amplitude envelope — an echo's period. */
function dominantLagSeconds(x, minLag, maxLag) {
  const env = envelope(x, 0.005);
  const mean = env.values.reduce((a, b) => a + b, 0) / env.values.length;
  const c = env.values.map((v) => v - mean);
  const lo = Math.max(1, Math.round(minLag / env.hopSeconds));
  const hi = Math.min(c.length - 2, Math.round(maxLag / env.hopSeconds));
  let bestLag = lo;
  let bestScore = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    const n = c.length - lag;
    for (let i = 0; i < n; i++) s += c[i] * c[i + lag];
    const score = s / n;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  return bestLag * env.hopSeconds;
}

/**
 * Peak fractional deviation of a steady tone's instantaneous frequency — the
 * signature of a modulated delay line. For `delay = base + depth*sin(2*pi*rate*t)`
 * the peak deviation is exactly `depth * 2*pi*rate`.
 */
function pitchDeviation(x, fromSeconds, toSeconds) {
  const from = Math.round(fromSeconds * SR);
  const to = Math.min(x.length, Math.round(toSeconds * SR));
  const crossings = [];
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] <= 0 && x[i] > 0) crossings.push(i - 1 + (-x[i - 1] / (x[i] - x[i - 1])));
  }
  const freqs = [];
  for (let i = 1; i < crossings.length; i++) freqs.push(SR / (crossings[i] - crossings[i - 1]));
  const width = 9;
  const smoothed = [];
  for (let i = 0; i + width <= freqs.length; i++) {
    smoothed.push([...freqs.slice(i, i + width)].sort((a, b) => a - b)[width >> 1]);
  }
  if (smoothed.length === 0) return { mean: 0, peak: 0, samples: 0 };
  const mean = smoothed.reduce((a, b) => a + b, 0) / smoothed.length;
  const peak = Math.max(Math.max(...smoothed) - mean, mean - Math.min(...smoothed)) / mean;
  return { mean, peak, samples: smoothed.length };
}

const predictedDeviation = (depth, rate) => depth * 2 * Math.PI * rate;

function channelCorrelation(L, R) {
  let dot = 0;
  let el = 0;
  let er = 0;
  for (let i = 0; i < L.length; i++) { dot += L[i] * R[i]; el += L[i] * L[i]; er += R[i] * R[i]; }
  const norm = Math.sqrt(el * er);
  return norm > 0 ? dot / norm : 1;
}

function energy(x, from = 0, to = x.length) {
  let e = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) e += x[i] * x[i];
  return e;
}

function mono(L, R) {
  const out = new Float64Array(L.length);
  for (let i = 0; i < L.length; i++) out[i] = (L[i] + R[i]) / 2;
  return out;
}

function hashChannels(L, R) {
  const h = createHash('sha256');
  h.update(Buffer.from(L.buffer, L.byteOffset, L.byteLength));
  h.update(Buffer.from(R.buffer, R.byteOffset, R.byteLength));
  return h.digest('hex');
}

/**
 * The output's amplitude lattice: the distinct levels a quantised signal settles
 * on, and the spacing between them. Reported relative to the render, so it is
 * unaffected by wherever the bus sets its gain.
 */
function amplitudeLattice(x, occupancyTolerance = 0.03) {
  const counts = new Map();
  for (let i = 2000; i < x.length; i++) {
    const key = Math.round(x[i] * 1e7);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const heavy = [...counts.entries()]
    .filter(([, n]) => n > total * 0.0005)
    .map(([k]) => k / 1e7)
    .sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < heavy.length; i++) diffs.push(heavy[i] - heavy[i - 1]);
  diffs.sort((a, b) => a - b);
  const step = diffs.length ? diffs[diffs.length >> 1] : 0;
  const onLattice = step > 0
    ? [...counts.entries()]
      .filter(([k]) => Math.abs((k / 1e7) / step - Math.round((k / 1e7) / step)) < occupancyTolerance)
      .reduce((a, [, n]) => a + n, 0)
    : 0;
  return { levels: heavy.length, step, occupancy: total > 0 ? onLattice / total : 0 };
}

async function renderFx({ fx, play, seconds = 3, seed = 9, dryVol = 0, band: bandOpts = {} }) {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const band = createBand({ ctx, seed, gain: 0.5, fx, disconnectRetired: false, ...bandOpts });
  band.registerTrack('t', {
    bpm: 120,
    len: 64,
    vol: dryVol,
    step(i, t, s) { if (i === 0) play(s, t); },
  });
  band.setTrack('t', { now: 0, fadeIn: 0 });
  band.tick(0);
  const buffer = await ctx.startRendering();
  const L = buffer.getChannelData(0).slice();
  const R = buffer.getChannelData(1).slice();
  return { L, R, m: mono(L, R), band };
}

const pluck = (opts) => (s, t) => s.v.pluck(t, noteFreq('C4'), 0.12, { vol: 0.15, verb: 0, ...opts });
const burst = (opts) => (s, t) => s.v.air(t, 0.08, {
  vol: 0.3, verb: 0, type: 'lowpass', bp: 12000, sweep: 1, q: 0.3, attackScale: 0.02, decayScale: 0.3, s: 0.2, r: 0.05, ...opts,
});
const noise = (opts) => (s, t) => s.v.air(t, 2.4, {
  vol: 0.18, verb: 0, type: 'lowpass', bp: 9000, sweep: 1, q: 0.4, attackScale: 0.005, decayScale: 0.02, s: 1, r: 0.05, ...opts,
});
/** A clean steady sine with the kit's own vibrato switched off. */
const tone = (opts) => (s, t) => s.v.lead(t, noteFreq('A4'), 2.4, {
  vol: 0.25, verb: 0, wave: 'sine', vibrato: 0, vibratoDepth: 0, cut: 14000, q: 0.5, a: 0.02, d: 0.02, s: 1, r: 0.05, ...opts,
});

function baseScore(extra = {}, steps = [{ i: 0, voice: 'pluck', note: 'C4', dur: 0.2, opts: { vol: 0.2 } }]) {
  return {
    schemaVersion: '1.1.0',
    kitVersion: KIT_VERSION,
    seed: 0x19000001,
    tempo: 120,
    sampleRate: 44100,
    gain: 0.5,
    register: { name: 'kit-demo', briefRef: 'docs/REGISTER-KIT-DEMO.md' },
    tracks: { body: { bpm: 120, len: 16, vol: 0.8, steps } },
    sections: [{ track: 'body', bars: 1, fadeIn: 0.01 }],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. the new kinds are off unless declared
// ---------------------------------------------------------------------------

describe('kit 1.9.0 defaults are off', () => {
  it('builds none of the new buses when nothing is declared', () => {
    const ctx = new OfflineAudioContext(2, 1024, SR);
    const band = createBand({ ctx, seed: 1 });
    assert.equal(band.fx, null);
    assert.equal(band.buses.fx, null);
    assert.equal(band.buses.fxMaster, null);
  });

  it('adds no bus and no tail for a score that declares only 1.8.0 effects', () => {
    const plan = normalizeFx({ bpm: 120, reverb: 'hall', delay: 'quarter', chorus: 'subtle' });
    for (const kind of ['bitcrush', 'snesverb', 'tape', 'spring', 'ringmod']) {
      assert.equal(plan[kind], undefined, `${kind} must not appear in a plan that never asked for it`);
    }
    // The 1.8.0 tail arithmetic is untouched by the new kinds existing.
    assert.equal(fxTailSeconds(plan), fxTailSeconds(normalizeFx({ bpm: 120, reverb: 'hall', delay: 'quarter', chorus: 'subtle' })));
  });

  it('extends the three tables together, so every kind has a send and a normaliser', () => {
    for (const kind of ['bitcrush', 'snesverb', 'tape', 'spring', 'ringmod']) {
      assert.ok(FX_KINDS.includes(kind), `${kind} must be a declared kind`);
      assert.equal(typeof FX_VOICE_SEND[kind], 'string');
    }
    const sends = FX_KINDS.map((kind) => FX_VOICE_SEND[kind]);
    assert.equal(new Set(sends).size, FX_KINDS.length, 'no two effects may share a send name');
  });
});

// ---------------------------------------------------------------------------
// 2. bitcrush
// ---------------------------------------------------------------------------

describe('kit 1.9.0 bitcrush', () => {
  it('quantises to a lattice whose step is exactly 2 / 2^bits', () => {
    // The curve IS the quantiser, so this is the exact claim, unscaled by any bus.
    for (const bits of [3, 4, 6, 8]) {
      const curve = bitcrushCurve(bits);
      const levels = [...new Set(Array.from(curve))].sort((a, b) => a - b);
      const step = 2 / Math.pow(2, bits);
      assert.equal(levels.length, Math.pow(2, bits) + 1, `${bits} bits should reach 2^bits+1 distinct levels`);
      for (let i = 1; i < levels.length; i++) {
        assert.ok(
          Math.abs((levels[i] - levels[i - 1]) - step) < step * 1e-5,
          `${bits} bits: level spacing ${(levels[i] - levels[i - 1]).toExponential(4)} should be ${step.toExponential(4)}`,
        );
      }
      assert.ok(levels.includes(0), 'zero must be a level, so silence stays silent');
    }
  });

  it('puts a real signal onto that lattice, halving the step for each added bit', async () => {
    const measured = [];
    for (const bits of [8, 9, 10]) {
      const { L } = await renderFx({
        fx: { master: { bitcrush: { bits, rate: null, wet: 1 }, dry: 0 } },
        play: tone({}),
        seconds: 3,
        dryVol: 0.8,
      });
      const lattice = amplitudeLattice(L);
      assert.ok(
        lattice.occupancy > 0.95,
        `${bits} bits: ${(lattice.occupancy * 100).toFixed(1)}% of samples should sit on the lattice`,
      );
      assert.ok(lattice.levels > 10, `${bits} bits: the signal must span enough levels to measure (${lattice.levels})`);
      measured.push(lattice.step);
    }
    // One more bit is half the step, exactly — and this ratio is immune to
    // wherever the master bus happens to set its gain.
    for (let i = 1; i < measured.length; i++) {
      const ratio = measured[i - 1] / measured[i];
      assert.ok(Math.abs(ratio - 2) < 0.04, `each added bit must halve the step (ratio ${ratio.toFixed(4)})`);
    }
  });

  it('coarser bit depths leave fewer distinct levels in the render', async () => {
    const count = async (bits) => {
      const { L } = await renderFx({
        fx: { master: { bitcrush: { bits, rate: null, wet: 1 }, dry: 0 } },
        play: tone({}),
        seconds: 2,
        dryVol: 0.8,
      });
      return amplitudeLattice(L).levels;
    };
    const coarse = await count(5);
    const fine = await count(10);
    assert.ok(fine > coarse * 4, `10 bits must resolve far more levels than 5 (${fine} vs ${coarse})`);
  });

  it('decimation shows the zero-order-hold spectrum: a null at the hold rate', async () => {
    for (const rate of [11025, 5512.5]) {
      const { m } = await renderFx({
        fx: { master: { bitcrush: { bits: 16, rate, wet: 1 }, dry: 0 } },
        play: burst({}),
        seconds: 2,
        dryVol: 0.8,
      });
      const passband = magnitudeAt(m, rate * 0.1, 0.02);
      const atNull = magnitudeAt(m, rate, 0.02);
      // A hold of N frames is a rectangular FIR: |H(f)| = |sinc(pi f N / fs)|,
      // which is exactly zero at fs/N. Measured 4e-6 and 1.3e-5 of the passband.
      assert.ok(
        atNull < passband * 1e-3,
        `rate ${rate}: the hold must null at fs/N (${atNull.toExponential(2)} vs passband ${passband.toExponential(2)})`,
      );
    }
  });

  it('renders identically twice and differently per preset', async () => {
    const a = await renderFx({ fx: { bitcrush: 'chip' }, play: tone({ bitcrush: 1 }), seconds: 2 });
    const b = await renderFx({ fx: { bitcrush: 'chip' }, play: tone({ bitcrush: 1 }), seconds: 2 });
    assert.equal(hashChannels(a.L, a.R), hashChannels(b.L, b.R));
    const hashes = new Set();
    for (const preset of Object.keys(BITCRUSH_PRESETS)) {
      const r = await renderFx({ fx: { bitcrush: preset }, play: tone({ bitcrush: 1 }), seconds: 2 });
      hashes.add(hashChannels(r.L, r.R));
    }
    assert.equal(hashes.size, Object.keys(BITCRUSH_PRESETS).length, 'every bitcrush preset must render differently');
  });

  it('normalises presets, overrides and a null rate', () => {
    assert.equal(normalizeBitcrushFx('chip').bits, BITCRUSH_PRESETS.chip.bits);
    assert.equal(normalizeBitcrushFx({ preset: 'chip', bits: 4 }).bits, 4);
    assert.equal(normalizeBitcrushFx({ bits: 8, rate: null }).rate, null, 'a null rate means quantise only');
    assert.equal(normalizeBitcrushFx(undefined), null);
    assert.throws(() => normalizeBitcrushFx({ bits: 0 }), /between/);
    assert.throws(() => normalizeBitcrushFx({ bits: 6.5 }), /integer/);
    assert.throws(() => normalizeBitcrushFx('mangle'), /unknown preset/);
  });
});

// ---------------------------------------------------------------------------
// 3. snesverb
// ---------------------------------------------------------------------------

describe('kit 1.9.0 snesverb', () => {
  it('echoes at the EDL step — 16 ms per unit — measured by autocorrelation', async () => {
    for (const edl of [3, 8]) {
      const { m } = await renderFx({
        fx: { snesverb: { edl, feedback: 0.7, fir: 'bypass', wet: 1 } },
        play: pluck({ snesverb: 1 }),
        seconds: 3,
      });
      const expected = edl * SNES_EDL_STEP_SECONDS;
      const lag = dominantLagSeconds(m, 0.02, 0.4);
      assert.ok(
        Math.abs(lag - expected) < 0.01,
        `edl ${edl}: echo lag ${lag.toFixed(4)}s should be ${expected.toFixed(3)}s`,
      );
    }
  });

  it('runs the 8-tap FIR in the feedback path, so the tail\'s spectrum tracks the taps', async () => {
    const ratio = async (fir) => {
      const { m } = await renderFx({
        fx: { snesverb: { edl: 4, feedback: 0.75, fir, wet: 1 } },
        play: burst({ snesverb: 1 }),
        seconds: 3,
      });
      return magnitudeAt(m, 9000, 0.3) / magnitudeAt(m, 500, 0.3);
    };
    const dark = await ratio('lowpass');
    const flat = await ratio('bypass');
    const bright = await ratio('bright');
    // The taps' own responses predict exactly this ordering — the point of the
    // FIR is that every repeat is re-filtered, so the difference compounds.
    assert.ok(dark < flat * 0.2, `the lowpass FIR must darken the tail (${dark.toExponential(2)} vs ${flat.toExponential(2)})`);
    assert.ok(bright > flat, `the bright FIR must keep more high end than bypass (${bright.toExponential(2)} vs ${flat.toExponential(2)})`);
  });

  it('carries the hardware\'s taps verbatim and accepts a custom set', () => {
    assert.equal(SNES_FIR_TAPS, 8);
    assert.equal(SNES_FIR_SCALE, 128);
    assert.deepEqual([...SNES_FIR_PRESETS.bypass], [127, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(SNES_FIR_PRESETS.lowpass.reduce((a, b) => a + b, 0), 128, 'the lowpass set must be unity at DC');
    const custom = normalizeSnesverbFx({ edl: 4, fir: [64, 32, 16, 8, 4, 2, 1, 1] });
    assert.equal(custom.fir, 'custom');
    assert.deepEqual([...custom.taps], [64, 32, 16, 8, 4, 2, 1, 1]);
    assert.throws(() => normalizeSnesverbFx({ fir: [1, 2, 3] }), /exactly 8 taps/);
    assert.throws(() => normalizeSnesverbFx({ fir: [200, 0, 0, 0, 0, 0, 0, 0] }), /signed bytes/);
    assert.throws(() => normalizeSnesverbFx({ fir: 'cathedral' }), /unknown FIR/);
    assert.throws(() => normalizeSnesverbFx({ edl: 99 }), /between/);
  });

  it('collapses the echo bus to mono when asked', async () => {
    // A chorus SEND decorrelates the sum; the snesverb then sits on the master,
    // where it can see that stereo and either keep it or fold it down.
    const measure = async (monoFlag) => {
      const { L, R } = await renderFx({
        fx: { chorus: 'lush', master: { snesverb: { edl: 5, feedback: 0.5, mono: monoFlag, wet: 1 }, dry: 0 } },
        play: noise({ chorus: 1 }),
        seconds: 3,
      });
      return channelCorrelation(L, R);
    };
    const stereo = await measure(false);
    const folded = await measure(true);
    assert.ok(stereo < 0.9, `the stereo echo should stay decorrelated (${stereo.toFixed(4)})`);
    assert.ok(folded > 0.999, `mono must collapse the channels (${folded.toFixed(5)})`);
  });

  it('feedback controls how long the echo train survives', async () => {
    const shy = await renderFx({ fx: { snesverb: { edl: 6, feedback: 0.1, fir: 'bypass', wet: 1 } }, play: pluck({ snesverb: 1 }), seconds: 3 });
    const hot = await renderFx({ fx: { snesverb: { edl: 6, feedback: 0.8, fir: 'bypass', wet: 1 } }, play: pluck({ snesverb: 1 }), seconds: 3 });
    assert.ok(
      tailSeconds(hot.m) > tailSeconds(shy.m) * 1.5,
      `higher feedback must ring longer (${tailSeconds(hot.m).toFixed(2)}s vs ${tailSeconds(shy.m).toFixed(2)}s)`,
    );
  });

  it('reserves a tail for the echo train', () => {
    const plan = normalizeFx({ snesverb: { edl: 10, feedback: 0.7 } });
    assert.ok(fxTailSeconds(plan) > 10 * SNES_EDL_STEP_SECONDS, 'the tail must cover more than one repeat');
    assert.ok(fxTailSeconds(plan) < 30, 'the tail must stay bounded');
  });
});

// ---------------------------------------------------------------------------
// 4. tape
// ---------------------------------------------------------------------------

describe('kit 1.9.0 tape', () => {
  it('wows at exactly depth * 2*pi*rate, with flutter switched off', async () => {
    for (const [rate, depth] of [[1.0, 0.004], [0.5, 0.008]]) {
      const { m } = await renderFx({
        fx: { master: { tape: { wowRate: rate, wowDepth: depth, flutterDepth: 0, drive: 0, rolloff: 20000, hiss: 0, wet: 1 }, dry: 0 } },
        play: tone({}),
        seconds: 3,
        dryVol: 0.8,
      });
      const measured = pitchDeviation(m, 0.5, 2.2);
      const predicted = predictedDeviation(depth, rate);
      assert.ok(measured.samples > 300, 'the measurement needs a sustained tone to read');
      assert.ok(
        Math.abs(measured.peak - predicted) / predicted < 0.15,
        `wow ${rate}Hz/${depth}: measured ${(measured.peak * 100).toFixed(3)}% vs predicted ${(predicted * 100).toFixed(3)}%`,
      );
      assert.ok(Math.abs(measured.mean - noteFreq('A4')) < 4, 'the centre pitch must not drift');
    }
  });

  it('flutters at exactly depth * 2*pi*rate, with wow switched off', async () => {
    const { m } = await renderFx({
      fx: { master: { tape: { wowDepth: 0, flutterRate: 6, flutterDepth: 0.002, drive: 0, rolloff: 20000, hiss: 0, wet: 1 }, dry: 0 } },
      play: tone({}),
      seconds: 3,
      dryVol: 0.8,
    });
    const measured = pitchDeviation(m, 0.5, 2.2);
    const predicted = predictedDeviation(0.002, 6);
    assert.ok(
      Math.abs(measured.peak - predicted) / predicted < 0.15,
      `flutter: measured ${(measured.peak * 100).toFixed(3)}% vs predicted ${(predicted * 100).toFixed(3)}%`,
    );
  });

  it('holds pitch when both wow and flutter are zero', async () => {
    const { m } = await renderFx({
      fx: { master: { tape: { wowDepth: 0, flutterDepth: 0, drive: 0, rolloff: 20000, hiss: 0, wet: 1 }, dry: 0 } },
      play: tone({}),
      seconds: 3,
      dryVol: 0.8,
    });
    const measured = pitchDeviation(m, 0.5, 2.2);
    assert.ok(measured.peak < 0.002, `an unmodulated transport must hold pitch (${(measured.peak * 100).toFixed(3)}%)`);
  });

  it('saturates into odd harmonics as drive rises', async () => {
    const third = async (drive) => {
      const { m } = await renderFx({
        fx: { master: { tape: { wowDepth: 0, flutterDepth: 0, drive, rolloff: 20000, hiss: 0, wet: 1 }, dry: 0 } },
        play: tone({}),
        seconds: 3,
        dryVol: 0.8,
      });
      const f = noteFreq('A4');
      return magnitudeAt(m, 3 * f, 0.6, 32768) / magnitudeAt(m, f, 0.6, 32768);
    };
    const clean = await third(0);
    const warm = await third(4);
    const hot = await third(12);
    assert.ok(warm > clean * 10, `drive must add third-harmonic distortion (${warm.toExponential(2)} vs ${clean.toExponential(2)})`);
    assert.ok(hot > warm * 3, `more drive must distort further (${hot.toExponential(2)} vs ${warm.toExponential(2)})`);
  });

  it('rolls off the high end at the declared corner', async () => {
    const hf = async (rolloff) => {
      const { m } = await renderFx({
        fx: { master: { tape: { wowDepth: 0, flutterDepth: 0, drive: 0, rolloff, hiss: 0, wet: 1 }, dry: 0 } },
        play: noise({}),
        seconds: 2,
        dryVol: 0.8,
      });
      return magnitudeAt(m, 8000, 0.3) / magnitudeAt(m, 500, 0.3);
    };
    const open = await hf(20000);
    const dull = await hf(2000);
    assert.ok(dull < open * 0.5, `a 2 kHz rolloff must lose high end (${dull.toExponential(2)} vs ${open.toExponential(2)})`);
  });

  // -- THE HISS LAW ---------------------------------------------------------
  it('adds ZERO noise at the default, to the sample', async () => {
    // A tape effect fully declared and running, over a track that plays nothing.
    // Not "quiet": exactly zero. A noise bed must never be an accidental floor.
    const ctx = new OfflineAudioContext(2, SR, SR);
    const band = createBand({ ctx, seed: 5, gain: 0.5, fx: { tape: 'worn' }, disconnectRetired: false });
    band.registerTrack('t', { bpm: 120, len: 16, vol: 0.8, step() {} });
    band.setTrack('t', { now: 0, fadeIn: 0 });
    band.tick(0);
    const buffer = await ctx.startRendering();
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0) assert.fail(`channel ${channel} frame ${i} is ${data[i]}, but no hiss was asked for`);
      }
    }
    for (const preset of Object.keys(TAPE_PRESETS)) {
      assert.equal(TAPE_PRESETS[preset].hiss, 0, `preset "${preset}" must ship with hiss at zero`);
    }
    assert.equal(normalizeTapeFx({}).hiss, 0, 'the fallback must also be zero');
  });

  it('produces hiss only when a score asks, and never above the cap', async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const band = createBand({ ctx, seed: 5, gain: 0.5, fx: { tape: { hiss: 0.02, wet: 1 } }, disconnectRetired: false });
    band.registerTrack('t', { bpm: 120, len: 16, vol: 0.8, step() {} });
    band.setTrack('t', { now: 0, fadeIn: 0 });
    band.tick(0);
    const buffer = await ctx.startRendering();
    let nonZero = 0;
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i++) if (data[i] !== 0) nonZero += 1;
    }
    assert.ok(nonZero > 1000, 'an asked-for hiss must actually appear');
    assert.throws(() => normalizeTapeFx({ hiss: FX_MAX_HISS + 0.01 }), /between/);
    assert.ok(FX_MAX_HISS <= 0.05, 'the hiss cap must stay small enough to be a texture, not a bed');
  });

  it('renders identically twice, including its hiss', async () => {
    const spec = validateSpec(baseScore({ fx: { tape: { preset: 'worn', hiss: 0.01 } } }));
    const a = await renderSpecToWav(spec);
    const b = await renderSpecToWav(spec);
    assert.equal(a.manifest.output.sha256, b.manifest.output.sha256, 'seeded hiss must be reproducible');
  });
});

// ---------------------------------------------------------------------------
// 5. PROPOSALS — spring and ringmod
// ---------------------------------------------------------------------------

describe('kit 1.9.0 spring (PROPOSAL)', () => {
  it('rings for longer than the dry note, and longer still on the long tank', async () => {
    const dry = await renderFx({ fx: undefined, play: pluck({}), seconds: 4, dryVol: 0.8 });
    const short = await renderFx({ fx: { spring: 'short' }, play: pluck({ spring: 1 }), seconds: 4 });
    const long = await renderFx({ fx: { spring: 'long' }, play: pluck({ spring: 1 }), seconds: 4 });
    assert.ok(tailSeconds(short.m) > tailSeconds(dry.m) * 3, `the tank must ring (${tailSeconds(short.m).toFixed(3)}s vs dry ${tailSeconds(dry.m).toFixed(3)}s)`);
    assert.ok(tailSeconds(long.m) > tailSeconds(short.m) * 1.5, `long must outlast short (${tailSeconds(long.m).toFixed(3)}s vs ${tailSeconds(short.m).toFixed(3)}s)`);
  });

  it('has no feedback parameter, because a feedback cycle mutes it here', () => {
    // Guards the finding, not just the code: node-web-audio-api renders exactly
    // 0.0 for any cycle enclosing the allpass sections' own cycles.
    assert.equal(SPRING_PRESETS.short.feedback, undefined);
    assert.equal(normalizeSpringFx('short').feedback, undefined);
    assert.throws(() => validateSpec(baseScore({ fx: { spring: { preset: 'short', feedback: 0.5 } } })), /unknown field/);
  });

  it('renders identically twice', async () => {
    const a = await renderFx({ fx: { spring: 'short' }, play: pluck({ spring: 1 }), seconds: 2 });
    const b = await renderFx({ fx: { spring: 'short' }, play: pluck({ spring: 1 }), seconds: 2 });
    assert.equal(hashChannels(a.L, a.R), hashChannels(b.L, b.R));
  });
});

describe('kit 1.9.0 ringmod (PROPOSAL)', () => {
  it('replaces the input with sidebands at |f - fc| and f + fc', async () => {
    const carrier = 300;
    const f = noteFreq('A4');
    const { m } = await renderFx({
      fx: { master: { ringmod: { carrier, wave: 'sine', wet: 1 }, dry: 0 } },
      play: tone({}),
      seconds: 3,
      dryVol: 0.8,
    });
    const atInput = magnitudeAt(m, f, 0.6, 32768);
    const lower = magnitudeAt(m, f - carrier, 0.6, 32768);
    const upper = magnitudeAt(m, f + carrier, 0.6, 32768);
    assert.ok(lower > atInput * 100, `the lower sideband must dominate the suppressed carrier (${lower.toExponential(2)} vs ${atInput.toExponential(2)})`);
    assert.ok(upper > atInput * 100, `the upper sideband must too (${upper.toExponential(2)} vs ${atInput.toExponential(2)})`);
    assert.ok(Math.abs(lower - upper) / lower < 0.2, 'a sine carrier gives two balanced sidebands');
  });

  it('moves the sidebands with the carrier', async () => {
    const f = noteFreq('A4');
    const { m } = await renderFx({
      fx: { master: { ringmod: { carrier: 120, wave: 'sine', wet: 1 }, dry: 0 } },
      play: tone({}),
      seconds: 3,
      dryVol: 0.8,
    });
    assert.ok(
      magnitudeAt(m, f - 120, 0.6, 32768) > magnitudeAt(m, f - 300, 0.6, 32768) * 10,
      'the sideband must follow the declared carrier',
    );
  });

  it('validates its wave and carrier', () => {
    assert.equal(normalizeRingmodFx('bell').carrier, RINGMOD_PRESETS.bell.carrier);
    assert.equal(normalizeRingmodFx({ wave: 'square' }).wave, 'square');
    assert.throws(() => normalizeRingmodFx({ wave: 'noise' }), /unknown wave/);
    assert.throws(() => normalizeRingmodFx({ carrier: 99999 }), /between/);
  });
});

// ---------------------------------------------------------------------------
// 6. architecture — the new kinds ride the 1.8.0 grain
// ---------------------------------------------------------------------------

describe('kit 1.9.0 fx architecture', () => {
  it('routes each new effect as a per-voice send, and zero sends nothing', async () => {
    for (const [kind, declaration] of [
      ['bitcrush', { bitcrush: 'chip' }],
      ['snesverb', { snesverb: 'cave' }],
      ['tape', { tape: 'worn' }],
      ['spring', { spring: 'short' }],
      ['ringmod', { ringmod: 'bell' }],
    ]) {
      const send = FX_VOICE_SEND[kind];
      const off = await renderFx({ fx: declaration, play: tone({ [send]: 0 }), seconds: 2 });
      const on = await renderFx({ fx: declaration, play: tone({ [send]: 0.9 }), seconds: 2 });
      assert.ok(
        energy(on.m) > energy(off.m) * 10,
        `${kind}: a voice with no send must stay out of the bus (${energy(on.m).toExponential(2)} vs ${energy(off.m).toExponential(2)})`,
      );
    }
  });

  it('applies each new effect as a master insert too', async () => {
    const dry = await renderFx({ fx: undefined, play: noise({}), seconds: 2, dryVol: 0.8 });
    for (const kind of ['bitcrush', 'snesverb', 'tape', 'spring', 'ringmod']) {
      const inserted = await renderFx({
        fx: { master: { [kind]: { wet: 0.9 }, dry: 1 } },
        play: noise({}),
        seconds: 2,
        dryVol: 0.8,
      });
      assert.notEqual(hashChannels(dry.L, dry.R), hashChannels(inserted.L, inserted.R), `${kind} must change the sum`);
      assert.ok(inserted.band.buses.fxMaster[kind], `${kind} must build a master unit`);
    }
  });

  it('double-renders byte-identically with every new effect engaged at once', async () => {
    const spec = validateSpec(baseScore({
      fx: {
        bitcrush: 'gentle',
        snesverb: 'cave',
        tape: { preset: 'worn', hiss: 0.008 },
        spring: 'short',
        ringmod: { carrier: 90 },
        master: { tape: { preset: 'studio', wet: 0.2 } },
      },
    }, [
      { i: [0, 8], voice: 'pluck', note: 'C4', dur: 0.2, opts: { vol: 0.2, bitcrush: 0.4, snesverb: 0.3, tape: 0.5 } },
      { i: [4], voice: 'bell', note: 'A5', dur: 0.4, opts: { vol: 0.1, spring: 0.3, ringmod: 0.2 } },
    ]));
    const a = await renderSpecToWav(spec);
    const b = await renderSpecToWav(spec);
    assert.equal(a.manifest.output.sha256, b.manifest.output.sha256, 'the thematic set must be reproducible');
    assert.equal(a.wav.length, b.wav.length);
  });

  it('validates the new declarations and rejects nonsense', () => {
    assert.doesNotThrow(() => validateSpec(baseScore({
      fx: {
        bitcrush: { bits: 6, rate: 8000 },
        snesverb: { edl: 6, fir: 'lowpass', mono: true },
        tape: { preset: 'worn', hiss: 0.01 },
        spring: 'long',
        ringmod: { carrier: 220, wave: 'square' },
      },
    })));
    assert.throws(() => validateSpec(baseScore({ fx: { bitcrush: { bits: 99 } } })), /between/);
    assert.throws(() => validateSpec(baseScore({ fx: { bitcrush: { bits: 6.5 } } })), /integer/);
    assert.throws(() => validateSpec(baseScore({ fx: { snesverb: { fir: 'cathedral' } } })), /fir/);
    assert.throws(() => validateSpec(baseScore({ fx: { snesverb: { fir: [1, 2] } } })), /8 taps/);
    assert.throws(() => validateSpec(baseScore({ fx: { tape: { hiss: 0.5 } } })), /between/);
    assert.throws(() => validateSpec(baseScore({ fx: { ringmod: { wave: 'noise' } } })), /wave/);
    assert.throws(() => validateSpec(baseScore({ fx: { tape: { wobble: 1 } } })), /unknown field/);
    // `rate` means different things per kind, and each keeps its own bounds.
    assert.throws(() => validateSpec(baseScore({ fx: { chorus: { rate: 40000 } } })), /between/);
    assert.doesNotThrow(() => validateSpec(baseScore({ fx: { bitcrush: { rate: 40000 } } })));
  });

  it('accepts the new per-voice sends on wet-tapped voices and still keeps kick out', () => {
    assert.doesNotThrow(() => validateSpec(baseScore({ fx: { tape: 'worn' } }, [
      { i: 0, voice: 'lead', note: 'E4', dur: 0.2, opts: { vol: 0.1, tape: 0.5, bitcrush: 0.25 } },
    ])));
    assert.throws(() => validateSpec(baseScore({ fx: { tape: 'worn' } }, [
      { i: 0, voice: 'lead', note: 'E4', dur: 0.2, opts: { vol: 0.1, tape: 2 } },
    ])), /between 0 and 1/);
    assert.throws(() => validateSpec(baseScore({ fx: { tape: 'worn' } }, [
      { i: 0, voice: 'kick', opts: { vol: 0.2, tape: 0.5 } },
    ])), /unknown field/);
  });
});

// ---------------------------------------------------------------------------
// 7. BUG FIX (a) — chip voices render their release
// ---------------------------------------------------------------------------

/** Last frame above -60 dB of the render's peak, in seconds. */
function audibleEndSeconds(x) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak <= 0) return 0;
  const threshold = peak * 1e-3;
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) >= threshold) return i / SR;
  return 0;
}

async function renderChip(voice, opts, dur = 0.4, seconds = 4) {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const band = createBand({ ctx, seed: 7, gain: 0.5, disconnectRetired: false });
  band.registerTrack('t', {
    bpm: 120,
    len: 64,
    vol: 0.8,
    step(i, t, s) { if (i === 0) s.v[voice](t, noteFreq('C4'), dur, { vol: 0.2, verb: 0, ...opts }); },
  });
  band.setTrack('t', { now: 0, fadeIn: 0 });
  band.tick(0);
  const buffer = await ctx.startRendering();
  return mono(buffer.getChannelData(0), buffer.getChannelData(1));
}

describe('kit 1.9.0 bug fix — chip voices render their release', () => {
  it('moves chipPulse\'s audible end with its release', async () => {
    // BEFORE THE FIX this sweep produced 0.4388s at every single release value:
    // the segment gate closed at t+dur, so the ADSR's release ran at EPS.
    const ends = [];
    for (const r of [0.05, 0.2, 0.8, 1.6]) ends.push(audibleEndSeconds(await renderChip('chipPulse', { r })));
    for (let i = 1; i < ends.length; i++) {
      assert.ok(ends[i] > ends[i - 1] + 0.05, `a longer release must ring longer (${ends.map((e) => e.toFixed(4)).join(', ')})`);
    }
    assert.ok(ends[3] > ends[0] * 3, `a 32x release sweep must move the end a long way (${ends[0].toFixed(4)}s -> ${ends[3].toFixed(4)}s)`);
  });

  it('sustains a chipNoise note for its whole length, not one tick', async () => {
    // BEFORE THE FIX a 0.4s note ended at 0.0588s — each source's gate closed at
    // the NEXT TICK rather than at the next source, so only ~20 ms ever sounded.
    const m = await renderChip('chipNoise', { r: 0.2 });
    const env = envelope(m, 0.02);
    const peak = Math.max(...env.values);
    // Windows covering 0.10s-0.35s are inside the note and must still be loud.
    const inside = env.values.slice(5, 17);
    assert.ok(
      inside.every((v) => v > peak * 0.1),
      `the note body must sustain (windows ${inside.map((v) => (20 * Math.log10(v / peak)).toFixed(0)).join(' ')} dB)`,
    );
    const ends = [];
    for (const r of [0.05, 1.6]) ends.push(audibleEndSeconds(await renderChip('chipNoise', { r })));
    assert.ok(ends[1] > ends[0] * 3, `chipNoise release must scale too (${ends[0].toFixed(4)}s -> ${ends[1].toFixed(4)}s)`);
  });

  it('still retriggers chipNoise on schedule', async () => {
    const m = await renderChip('chipNoise', { r: 0.1, fx: [{ type: 'retrig', tick: 0, every: 4 }] });
    assert.ok(audibleEndSeconds(m) > 0.3, 'a retriggered note must still fill its length');
  });

  it('leaves chipTriangle exactly as it was — it never had the gate', async () => {
    // chipTriangle connects its oscillator straight to the envelope, so the fix
    // must not touch it. This is the control that proves the fix was targeted.
    const ends = [];
    for (const r of [0.05, 0.2, 0.8, 1.6]) ends.push(audibleEndSeconds(await renderChip('chipTriangle', { r })));
    assert.deepEqual(
      ends.map((e) => Number(e.toFixed(4))),
      [0.4829, 0.6187, 1.1596, 1.8820],
      'chipTriangle\'s measured release behaviour is unchanged from before the fix',
    );
  });

  it('keeps chip renders deterministic', async () => {
    const a = await renderChip('chipPulse', { r: 0.4 });
    const b = await renderChip('chipPulse', { r: 0.4 });
    assert.equal(
      createHash('sha256').update(Buffer.from(a.buffer)).digest('hex'),
      createHash('sha256').update(Buffer.from(b.buffer)).digest('hex'),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. BUG FIX (b) — the render budget respects the score's real tail
// ---------------------------------------------------------------------------

describe('kit 1.9.0 bug fix — note tails are measured, not assumed', () => {
  it('computes each voice\'s tail from its own envelope', () => {
    // pad/drone/lead hold for `dur`; bell/pluck/bass scale hold and decay off it.
    assert.ok(Math.abs(voiceTailSeconds('pad', 3.5, { r: 0.25 }) - 3.75) < 1e-9);
    assert.ok(Math.abs(voiceTailSeconds('lead', 1.0, { a: 0.03, d: 0.15, r: 0.2 }) - 1.2) < 1e-9);
    // bell: hold = dur*holdScale (0.25), decay = dur*dScale (0.5), r = 0.35
    assert.ok(Math.abs(voiceTailSeconds('bell', 2, { }) - (Math.max(0.004 + 1, 0.5) + 0.35)) < 1e-9);
    // percussion ignores the note length entirely
    assert.equal(voiceTailSeconds('kick', 99, {}), 0.24);
    assert.equal(voiceTailSeconds('hat', 99, {}), 0.05);
    // chip voices stop at dur + max(r, 0.05)
    assert.ok(Math.abs(voiceTailSeconds('chipPulse', 0.4, { r: 1.6 }) - 2.0) < 1e-9);
    assert.ok(Math.abs(voiceTailSeconds('chipPulse', 0.4, { r: 0.01 }) - 0.45) < 1e-9);
    assert.equal(voiceTailSeconds('nosuchvoice', 1, {}), 0);
  });

  it('measures how far a score rings past its last bar', () => {
    const short = validateSpec(baseScore({}, [{ i: 0, voice: 'hat', opts: { vol: 0.1 } }]));
    assert.ok(specTailOverhangSeconds(short) < 0.1, 'a hat-only score barely overhangs');
    const long = validateSpec(baseScore({}, [{ i: 0, voice: 'pad', note: 'C3', dur: 3.5, opts: { vol: 0.1, r: 0.25 } }]));
    assert.ok(Math.abs(specTailOverhangSeconds(long) - 3.75) < 1e-6, 'a 3.75s pad tail must be seen in full');
  });

  it('reserves a buffer that actually holds the last note, and ends in silence', async () => {
    // BEFORE THE FIX the budget was a constant, so this render stopped mid-decay.
    const spec = validateSpec(baseScore({}, [
      { i: 15, voice: 'bell', note: 'A4', dur: 0.3, opts: { vol: 0.3, verb: 0, r: 2.5 } },
    ]));
    const buffer = await renderSpec(spec);
    const music = specDuration(spec);
    assert.ok(
      buffer.length / SR > music + 2.5,
      `the buffer must outlast the note (${(buffer.length / SR).toFixed(3)}s for a note ending near ${(music + 2.8).toFixed(3)}s)`,
    );
    const m = mono(buffer.getChannelData(0), buffer.getChannelData(1));
    let peak = 0;
    for (let i = 0; i < m.length; i++) peak = Math.max(peak, Math.abs(m[i]));
    const window = Math.round(0.01 * SR);
    let e = 0;
    for (let i = m.length - window; i < m.length; i++) e += m[i] * m[i];
    const edgeDb = 20 * Math.log10(Math.sqrt(e / window) / peak);
    assert.ok(edgeDb < -80, `the render must end in silence, not mid-tail (${edgeDb.toFixed(1)} dB)`);
  });

  it('never shortens a render that already fitted', async () => {
    // The budget is a max() against the historical constant, so a short score's
    // length — and therefore its bytes — cannot move.
    const spec = validateSpec(baseScore({}, [{ i: 0, voice: 'pluck', note: 'C4', dur: 0.12, opts: { vol: 0.2 } }]));
    const buffer = await renderSpec(spec);
    const music = specDuration(spec);
    assert.ok(Math.abs(buffer.length / SR - (music + 1.45)) < 0.01, 'a short score keeps the historical 1.45s tail');
  });
});

// ---------------------------------------------------------------------------
// 9. BUG FIX (b) — the section boundary is now a choice
// ---------------------------------------------------------------------------

function twoSectionScore(retire) {
  return {
    schemaVersion: '1.1.0',
    kitVersion: KIT_VERSION,
    seed: 0x1900B,
    tempo: 120,
    sampleRate: 44100,
    gain: 0.5,
    register: { name: 'kit-demo', briefRef: 'docs/REGISTER-KIT-DEMO.md' },
    tracks: {
      a: { bpm: 120, len: 16, vol: 0.8, steps: [{ i: 12, voice: 'bell', note: 'A4', dur: 0.3, opts: { vol: 0.3, verb: 0, r: 1.2 } }] },
      b: { bpm: 120, len: 16, vol: 0.8, steps: [] },
    },
    sections: [{ track: 'a', bars: 1, fadeIn: 0.01 }, { track: 'b', bars: 1, fadeIn: 0.01 }],
    ...(retire ? { retire } : {}),
    // These probes time the DRY note at the boundary; the kit 1.12.0 bright-voice dark tail (a reverb) is off here.
    brightVoice: 'off',
  };
}

describe('kit 1.9.0 section-boundary posture', () => {
  it('defaults to the historical crossfade, which still cuts the boundary note', async () => {
    // Unchanged on purpose: moving this default would re-render every
    // multi-section score in the fleet and force a re-ear-gate.
    const buffer = await renderSpec(validateSpec(twoSectionScore(null)));
    const m = mono(buffer.getChannelData(0), buffer.getChannelData(1));
    // Boundary at 2.0s, fadeOut 0.08s: the bell's 1.2s release is cut there.
    assert.ok(audibleEndSeconds(m) < 2.2, `crossfade must still end the note at the boundary (${audibleEndSeconds(m).toFixed(3)}s)`);
  });

  it('lets a score opt into ringing across the boundary', async () => {
    const buffer = await renderSpec(validateSpec(twoSectionScore({ mode: 'tail', hold: 1.5 })));
    const m = mono(buffer.getChannelData(0), buffer.getChannelData(1));
    assert.ok(
      audibleEndSeconds(m) > 2.6,
      `a 'tail' retire must let the note decay past the boundary (${audibleEndSeconds(m).toFixed(3)}s)`,
    );
  });

  it('renders a crossfade score byte-identically whether or not the mode is spelled out', async () => {
    const implicit = await renderSpecToWav(validateSpec(twoSectionScore(null)));
    const explicit = await renderSpecToWav(validateSpec(twoSectionScore({ mode: 'crossfade' })));
    assert.equal(
      implicit.manifest.output.sha256,
      explicit.manifest.output.sha256,
      'declaring the default must change nothing at all',
    );
  });

  it('reports and validates the posture', () => {
    const ctx = new OfflineAudioContext(2, 1024, SR);
    assert.deepEqual(createBand({ ctx, seed: 1 }).retire, { mode: 'crossfade', hold: 0 });
    assert.deepEqual(createBand({ ctx, seed: 1, retireMode: 'tail', retireHold: 2 }).retire, { mode: 'tail', hold: 2 });
    // A hold is meaningless without the mode, and is ignored rather than obeyed.
    assert.deepEqual(createBand({ ctx, seed: 1, retireHold: 2 }).retire, { mode: 'crossfade', hold: 0 });
    assert.throws(() => createBand({ ctx, seed: 1, retireMode: 'fade' }), /retireMode/);
    assert.throws(() => createBand({ ctx, seed: 1, retireHold: 99 }), /retireHold/);
    assert.deepEqual(RETIRE_MODES, ['crossfade', 'tail']);
    assert.throws(() => validateSpec(twoSectionScore({ mode: 'tail' })), /hold greater than 0/);
    assert.throws(() => validateSpec(twoSectionScore({ mode: 'nope', hold: 1 })), /must be one of/);
    assert.throws(() => validateSpec(twoSectionScore({ mode: 'tail', hold: 99 })), /between/);
  });
});
