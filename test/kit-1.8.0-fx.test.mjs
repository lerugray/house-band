/**
 * Kit 1.8.0 — THE FX SUITE. Reverb, delay, chorus.
 *
 * Two things are under test and they pull in opposite directions:
 *
 *   1. With no `fx` declared, NOTHING changes. The golden fixtures in
 *      m1-hardening / m3-samples / api-t1 carry that proof at the byte level;
 *      here we assert the structural half (no fx nodes exist, no render length
 *      moves) so a regression names itself instead of only reddening a hash.
 *   2. With `fx` declared, each effect does the physical thing it claims —
 *      measured off the rendered audio, never trusted from the config.
 */
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OfflineAudioContext } from 'node-web-audio-api';

import {
  CHORUS_PRESETS,
  createBand,
  DELAY_PRESETS,
  DELAY_SYNC_FRACTIONS,
  delaySyncSeconds,
  FX_KINDS,
  FX_VOICE_SEND,
  fxTailSeconds,
  noteFreq,
  normalizeChorusFx,
  normalizeDelayFx,
  normalizeFx,
  normalizeReverbFx,
  REVERB_PRESETS,
} from '../src/kit/band.js';
import { renderSpecToWav } from '../src/render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';

const SR = 44100;

// ---------------------------------------------------------------------------
// measurement helpers — all operate on rendered PCM, none read the fx config
// ---------------------------------------------------------------------------

/** Short-window RMS envelope. */
function envelope(x, hopSeconds = 0.005) {
  const hop = Math.max(1, Math.round(SR * hopSeconds));
  const values = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += x[j] * x[j];
    values.push(Math.sqrt(s / hop));
  }
  return { values, hopSeconds: hop / SR };
}

/** Seconds from first to last window above `floorDb` under the peak. */
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

/** First frame whose magnitude reaches a fraction of the signal peak. */
function onsetFrame(x, fraction = 0.02) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak <= 0) return -1;
  const threshold = peak * fraction;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= threshold) return i;
  return -1;
}

function energy(x, from = 0, to = x.length) {
  let e = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) e += x[i] * x[i];
  return e;
}

/** Fraction of a span's energy above `cutoffHz`, via a one-pole highpass. */
function hfFraction(x, from, to, cutoffHz = 4000) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / SR;
  const a = rc / (rc + dt);
  const warm = Math.max(0, from - 2000);
  let prevX = 0;
  let prevY = 0;
  let hf = 0;
  let total = 0;
  for (let i = warm; i < Math.min(x.length, to); i++) {
    const y = a * (prevY + x[i] - prevX);
    prevX = x[i];
    prevY = y;
    if (i >= from) { hf += y * y; total += x[i] * x[i]; }
  }
  return total > 0 ? hf / total : 0;
}

/**
 * Lag (seconds) of the strongest repeat in an envelope — the period of an echo
 * train. Normalised by overlap count so long lags are not penalised.
 */
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
 * Peak fractional deviation of a steady tone's instantaneous frequency.
 *
 * This is THE physical signature of a modulated delay line. A delay that sweeps
 * resamples what passes through it, so the output frequency is
 * `f * (1 - d(delay)/dt)` — for `delay = base + depth*sin(2*pi*rate*t)` the peak
 * deviation is exactly `depth * 2*pi*rate`. Measuring it needs no reference
 * render and, unlike a cross-correlation lag, does not fall apart precisely
 * when the delay starts moving (a sweeping line stretches the signal, so lag
 * correlation collapses to noise and its argmax stops meaning anything).
 */
function pitchDeviation(x, fromSeconds, toSeconds) {
  const from = Math.round(fromSeconds * SR);
  const to = Math.min(x.length, Math.round(toSeconds * SR));
  const crossings = [];
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] <= 0 && x[i] > 0) {
      crossings.push(i - 1 + (-x[i - 1] / (x[i] - x[i - 1])));
    }
  }
  const freqs = [];
  for (let i = 1; i < crossings.length; i++) freqs.push(SR / (crossings[i] - crossings[i - 1]));
  // Median-smooth over a few cycles so one mis-detected crossing cannot set the peak.
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

/** What the peak deviation should be for a given chorus depth and rate. */
const predictedDeviation = (depth, rate) => depth * 2 * Math.PI * rate;

/** Pearson correlation of the two channels — 1.0 is a mono signal. */
function channelCorrelation(L, R) {
  let dot = 0;
  let el = 0;
  let er = 0;
  for (let i = 0; i < L.length; i++) { dot += L[i] * R[i]; el += L[i] * L[i]; er += R[i] * R[i]; }
  const norm = Math.sqrt(el * er);
  return norm > 0 ? dot / norm : 1;
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
 * Render one gesture through a band.
 * `dryVol` at 0 leaves the track's dry bus at EPS while its send buses run at
 * full, which isolates the wet path for measurement.
 */
async function renderFx({ fx, play, seconds = 3, seed = 9, dryVol = 0 }) {
  const frames = Math.round(seconds * SR);
  const ctx = new OfflineAudioContext(2, frames, SR);
  const band = createBand({ ctx, seed, gain: 0.5, fx, disconnectRetired: false });
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

/**
 * A short BROADBAND hit. Anything measuring how an effect treats high frequencies
 * has to be fed high frequencies: a C4 pluck through a 2800 Hz lowpass carries
 * almost nothing above 4 kHz, so a damping measurement taken on one reads the
 * same either way and proves nothing.
 */
const burst = (opts) => (s, t) => s.v.air(t, 0.08, {
  vol: 0.3, verb: 0, type: 'lowpass', bp: 12000, sweep: 1, q: 0.3, attackScale: 0.02, decayScale: 0.3, s: 0.2, r: 0.05, ...opts,
});
const noise = (opts) => (s, t) => s.v.air(t, 2.4, {
  vol: 0.18, verb: 0, type: 'lowpass', bp: 9000, sweep: 1, q: 0.4, attackScale: 0.005, decayScale: 0.02, s: 1, r: 0.05, ...opts,
});
/** A clean steady sine — the kit's own vibrato switched off. */
const tone = (opts) => (s, t) => s.v.lead(t, noteFreq('A4'), 2.2, {
  vol: 0.25, verb: 0, wave: 'sine', vibrato: 0, vibratoDepth: 0, cut: 12000, q: 0.5, a: 0.02, d: 0.02, s: 1, r: 0.05, ...opts,
});

function baseScore(extra = {}, steps = [
  { i: [0, 8], voice: 'pluck', note: 'C4', dur: 0.2, opts: { vol: 0.2, verb: 0.2, delay: 0.4, chorus: 0.3 } },
  { i: [4], voice: 'bell', note: 'A5', dur: 0.4, opts: { vol: 0.1, verb: 0.35, delay: 0.3 } },
]) {
  return {
    schemaVersion: '1.1.0',
    kitVersion: KIT_VERSION,
    seed: 0x18000001,
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
// 1. defaults are off
// ---------------------------------------------------------------------------

describe('kit 1.8.0 fx defaults are off', () => {
  it('builds no fx buses and reports no plan when fx is omitted', () => {
    const ctx = new OfflineAudioContext(2, 1024, SR);
    const band = createBand({ ctx, seed: 1 });
    assert.equal(band.fx, null);
    assert.equal(band.buses.fx, null);
    assert.equal(band.buses.fxMaster, null);
    assert.ok(band.buses.verb, 'the legacy send reverb is still built');
  });

  it('adds no render tail when nothing is declared', () => {
    assert.equal(fxTailSeconds(null), 0);
    assert.equal(fxTailSeconds(normalizeFx(undefined)), 0);
    assert.equal(fxTailSeconds(normalizeFx({})), 0);
  });

  it('treats an fx-free score as byte-identical across repeat renders', async () => {
    const spec = validateSpec(baseScore({}, [{ i: 0, voice: 'pluck', note: 'C4', dur: 0.2, opts: { vol: 0.2 } }]));
    const a = await renderSpecToWav(spec);
    const b = await renderSpecToWav(spec);
    assert.equal(a.manifest.output.sha256, b.manifest.output.sha256);
  });
});

// ---------------------------------------------------------------------------
// 2. reverb
// ---------------------------------------------------------------------------

describe('kit 1.8.0 reverb', () => {
  it('adds a decaying tail whose length tracks the preset', async () => {
    const dry = await renderFx({ fx: undefined, play: pluck({}), seconds: 4, dryVol: 0.8 });
    const room = await renderFx({ fx: { reverb: 'room' }, play: pluck({ verb: 1 }), seconds: 4 });
    const hall = await renderFx({ fx: { reverb: 'hall' }, play: pluck({ verb: 1 }), seconds: 4 });

    const dryTail = tailSeconds(dry.m);
    const roomTail = tailSeconds(room.m);
    const hallTail = tailSeconds(hall.m);

    assert.ok(roomTail > dryTail * 1.5, `room tail ${roomTail.toFixed(3)}s should exceed the dry tail ${dryTail.toFixed(3)}s`);
    assert.ok(hallTail > roomTail * 1.5, `hall tail ${hallTail.toFixed(3)}s should exceed the room tail ${roomTail.toFixed(3)}s`);
    // Within the IR's own length, allowing the source note and the -40 dB floor.
    assert.ok(
      hallTail > REVERB_PRESETS.hall.seconds * 0.5 && hallTail < REVERB_PRESETS.hall.seconds + 0.6,
      `hall tail ${hallTail.toFixed(3)}s should sit near the ${REVERB_PRESETS.hall.seconds}s IR`,
    );
  });

  it('decays monotonically across the tail rather than sustaining', async () => {
    const { m } = await renderFx({ fx: { reverb: 'hall' }, play: pluck({ verb: 1 }), seconds: 4 });
    const start = Math.round(0.3 * SR);
    const span = Math.round(0.7 * SR);
    const first = energy(m, start, start + span);
    const second = energy(m, start + span, start + 2 * span);
    const third = energy(m, start + 2 * span, start + 3 * span);
    assert.ok(first > second && second > third, `reverb tail must decay (${first.toExponential(2)} > ${second.toExponential(2)} > ${third.toExponential(2)})`);
  });

  it('damping controls how much high end survives in the tail', async () => {
    const dark = await renderFx({ fx: { reverb: { preset: 'hall', damping: 900 } }, play: burst({ verb: 1 }), seconds: 4 });
    const bright = await renderFx({ fx: { reverb: { preset: 'hall', damping: 14000 } }, play: burst({ verb: 1 }), seconds: 4 });
    const from = Math.round(0.5 * SR);
    const to = Math.round(2.5 * SR);
    const darkHf = hfFraction(dark.m, from, to);
    const brightHf = hfFraction(bright.m, from, to);
    assert.ok(brightHf > darkHf * 2, `bright damping should keep more HF (${brightHf.toFixed(4)} vs ${darkHf.toFixed(4)})`);
  });

  it('pre-delay offsets the wet onset by the declared time', async () => {
    const none = await renderFx({ fx: { reverb: { preset: 'plate', preDelay: 0 } }, play: pluck({ verb: 1 }), seconds: 2 });
    const delayed = await renderFx({ fx: { reverb: { preset: 'plate', preDelay: 0.05 } }, play: pluck({ verb: 1 }), seconds: 2 });
    const deltaMs = ((onsetFrame(delayed.m) - onsetFrame(none.m)) / SR) * 1000;
    assert.ok(Math.abs(deltaMs - 50) < 6, `pre-delay shift ${deltaMs.toFixed(2)} ms should be near 50 ms`);
  });

  it('gives each preset its own character', async () => {
    const hashes = new Set();
    for (const preset of Object.keys(REVERB_PRESETS)) {
      const { L, R } = await renderFx({ fx: { reverb: preset }, play: pluck({ verb: 1 }), seconds: 3 });
      hashes.add(hashChannels(L, R));
    }
    assert.equal(hashes.size, Object.keys(REVERB_PRESETS).length, 'every reverb preset must render differently');
  });

  it('synthesises the same impulse response for the same seed', async () => {
    const a = await renderFx({ fx: { reverb: 'hall' }, play: pluck({ verb: 1 }), seconds: 2, seed: 4242 });
    const b = await renderFx({ fx: { reverb: 'hall' }, play: pluck({ verb: 1 }), seconds: 2, seed: 4242 });
    const c = await renderFx({ fx: { reverb: 'hall' }, play: pluck({ verb: 1 }), seconds: 2, seed: 99 });
    assert.equal(hashChannels(a.L, a.R), hashChannels(b.L, b.R));
    assert.notEqual(hashChannels(a.L, a.R), hashChannels(c.L, c.R), 'a different seed must give a different room');
  });
});

// ---------------------------------------------------------------------------
// 3. delay
// ---------------------------------------------------------------------------

describe('kit 1.8.0 delay', () => {
  it('places the first echo exactly one synced interval after the note', async () => {
    const dry = await renderFx({ fx: undefined, play: pluck({}), seconds: 3, dryVol: 0.8 });
    const dryOnset = onsetFrame(dry.m);
    for (const [sync, expected] of [['1/8', 0.25], ['1/8.', 0.375], ['1/4', 0.5]]) {
      const wet = await renderFx({
        fx: { bpm: 120, delay: { preset: 'eighth', sync, feedback: 0.5, damping: 9000 } },
        play: pluck({ delay: 1 }),
        seconds: 3,
      });
      const deltaMs = ((onsetFrame(wet.m) - dryOnset) / SR) * 1000;
      assert.ok(
        Math.abs(deltaMs - expected * 1000) < 12,
        `sync ${sync}: first echo at ${deltaMs.toFixed(1)} ms should be near ${(expected * 1000).toFixed(1)} ms`,
      );
    }
  });

  it('repeats at the synced interval, measured by autocorrelation', async () => {
    for (const [sync, expected] of [['1/8', 0.25], ['1/4', 0.5]]) {
      const wet = await renderFx({
        fx: { bpm: 120, delay: { preset: 'eighth', sync, feedback: 0.62, damping: 9000 } },
        play: pluck({ delay: 1 }),
        seconds: 4,
      });
      const lag = dominantLagSeconds(wet.m, 0.08, 0.9);
      assert.ok(Math.abs(lag - expected) < 0.02, `sync ${sync}: dominant echo lag ${lag.toFixed(3)}s should be near ${expected}s`);
    }
  });

  it('feedback controls how long the echo train survives', async () => {
    const shy = await renderFx({ fx: { bpm: 120, delay: { preset: 'quarter', feedback: 0.1 } }, play: pluck({ delay: 1 }), seconds: 4 });
    const hot = await renderFx({ fx: { bpm: 120, delay: { preset: 'quarter', feedback: 0.7 } }, play: pluck({ delay: 1 }), seconds: 4 });
    assert.ok(
      tailSeconds(hot.m) > tailSeconds(shy.m) * 1.5,
      `higher feedback must ring longer (${tailSeconds(hot.m).toFixed(2)}s vs ${tailSeconds(shy.m).toFixed(2)}s)`,
    );
    // Echo energy is a geometric series in feedback SQUARED: sum = 1/(1 - fb^2),
    // so 0.7 against 0.1 is a ~1.94x ratio, not the ~7x the gain figure suggests.
    const ratio = energy(hot.m) / energy(shy.m);
    assert.ok(ratio > 1.5, `higher feedback must carry more total wet energy (ratio ${ratio.toFixed(2)})`);
  });

  it('damps the loop so later repeats are darker than earlier ones', async () => {
    const wet = await renderFx({
      fx: { bpm: 120, delay: { preset: 'quarter', feedback: 0.7, damping: 1400 } },
      play: burst({ delay: 1 }),
      seconds: 4,
    });
    const onset = onsetFrame(wet.m);
    const step = Math.round(0.5 * SR);
    const window = Math.round(0.2 * SR);
    const firstHf = hfFraction(wet.m, onset, onset + window, 3000);
    const fourthHf = hfFraction(wet.m, onset + 3 * step, onset + 3 * step + window, 3000);
    assert.ok(fourthHf < firstHf * 0.9, `later repeats must be darker (${fourthHf.toFixed(4)} vs ${firstHf.toFixed(4)})`);
  });

  it('alternates sides in ping-pong mode', async () => {
    const wet = await renderFx({
      fx: { bpm: 120, delay: { preset: 'quarter', pingPong: true, feedback: 0.6, damping: 9000 } },
      play: pluck({ delay: 1 }),
      seconds: 4,
    });
    const onset = onsetFrame(wet.m);
    const step = Math.round(0.5 * SR);
    const window = Math.round(0.25 * SR);
    const firstL = energy(wet.L, onset, onset + window);
    const firstR = energy(wet.R, onset, onset + window);
    const secondL = energy(wet.L, onset + step, onset + step + window);
    const secondR = energy(wet.R, onset + step, onset + step + window);
    assert.ok(firstL > firstR * 5, `first echo should sit left (${firstL.toExponential(2)} vs ${firstR.toExponential(2)})`);
    assert.ok(secondR > secondL * 5, `second echo should sit right (${secondR.toExponential(2)} vs ${secondL.toExponential(2)})`);
  });

  it('honours a raw time when no sync is declared', async () => {
    const dry = await renderFx({ fx: undefined, play: pluck({}), seconds: 3, dryVol: 0.8 });
    const wet = await renderFx({ fx: { delay: { sync: null, time: 0.18, feedback: 0.3 } }, play: pluck({ delay: 1 }), seconds: 3 });
    const deltaMs = ((onsetFrame(wet.m) - onsetFrame(dry.m)) / SR) * 1000;
    assert.ok(Math.abs(deltaMs - 180) < 12, `raw time echo at ${deltaMs.toFixed(1)} ms should be near 180 ms`);
  });
});

// ---------------------------------------------------------------------------
// 4. chorus
// ---------------------------------------------------------------------------

describe('kit 1.8.0 chorus', () => {
  it('modulates its delay line — a steady tone comes out wobbling, a static line does not', async () => {
    const still = await renderFx({
      fx: { chorus: { voices: 1, depth: 0, rate: 2, width: 0 } },
      play: tone({ chorus: 1 }),
      seconds: 3,
    });
    const moving = await renderFx({
      fx: { chorus: { voices: 1, depth: 0.004, rate: 2, width: 0 } },
      play: tone({ chorus: 1 }),
      seconds: 3,
    });
    const stillDev = pitchDeviation(still.m, 0.4, 2.0);
    const movingDev = pitchDeviation(moving.m, 0.4, 2.0);
    assert.ok(stillDev.samples > 300, 'the measurement needs a sustained tone to read');
    assert.ok(stillDev.peak < 0.002, `an unmodulated line must hold pitch (${(stillDev.peak * 100).toFixed(3)}%)`);

    // depth * 2*pi*rate is the closed form; hold the render to within 15% of it.
    const predicted = predictedDeviation(0.004, 2);
    assert.ok(
      Math.abs(movingDev.peak - predicted) / predicted < 0.15,
      `chorus wobble ${(movingDev.peak * 100).toFixed(2)}% should match the predicted ${(predicted * 100).toFixed(2)}%`,
    );
    assert.ok(Math.abs(movingDev.mean - noteFreq('A4')) < 3, 'the centre pitch must not drift');
  });

  it('wobbles further as depth and rate rise, in the proportion the theory gives', async () => {
    const measure = async (depth, rate) => {
      const { m } = await renderFx({ fx: { chorus: { voices: 1, depth, rate, width: 0 } }, play: tone({ chorus: 1 }), seconds: 3 });
      return pitchDeviation(m, 0.4, 2.0).peak;
    };
    const shallow = await measure(0.0015, 2);
    const deep = await measure(0.006, 2);
    const fast = await measure(0.004, 4);
    const slow = await measure(0.004, 1);

    assert.ok(deep > shallow * 2.5, `4x the depth must wobble far wider (${(deep * 100).toFixed(2)}% vs ${(shallow * 100).toFixed(2)}%)`);
    assert.ok(fast > slow * 2.5, `4x the rate must wobble far wider (${(fast * 100).toFixed(2)}% vs ${(slow * 100).toFixed(2)}%)`);
    for (const [measured, depth, rate] of [[shallow, 0.0015, 2], [deep, 0.006, 2], [fast, 0.004, 4], [slow, 0.004, 1]]) {
      const predicted = predictedDeviation(depth, rate);
      assert.ok(
        Math.abs(measured - predicted) / predicted < 0.15,
        `depth ${depth} rate ${rate}: measured ${(measured * 100).toFixed(2)}% vs predicted ${(predicted * 100).toFixed(2)}%`,
      );
    }
  });

  it('spreads the ensemble across the stereo field', async () => {
    const narrow = await renderFx({ fx: { chorus: { preset: 'lush', width: 0 } }, play: noise({ chorus: 1 }), seconds: 2 });
    const wide = await renderFx({ fx: { chorus: 'lush' }, play: noise({ chorus: 1 }), seconds: 2 });
    const narrowCorr = channelCorrelation(narrow.L, narrow.R);
    const wideCorr = channelCorrelation(wide.L, wide.R);
    assert.ok(narrowCorr > 0.99, `width 0 should stay centred (correlation ${narrowCorr.toFixed(4)})`);
    assert.ok(wideCorr < narrowCorr - 0.05, `width 1 should decorrelate the channels (${wideCorr.toFixed(4)} vs ${narrowCorr.toFixed(4)})`);
  });

  it('gives subtle and lush distinct characters', async () => {
    const subtle = await renderFx({ fx: { chorus: 'subtle' }, play: noise({ chorus: 1 }), seconds: 2 });
    const lush = await renderFx({ fx: { chorus: 'lush' }, play: noise({ chorus: 1 }), seconds: 2 });
    assert.notEqual(hashChannels(subtle.L, subtle.R), hashChannels(lush.L, lush.R));
    assert.equal(subtle.band.fx.chorus.voices, CHORUS_PRESETS.subtle.voices);
    assert.equal(lush.band.fx.chorus.voices, CHORUS_PRESETS.lush.voices);
    assert.ok(lush.band.fx.chorus.wet > subtle.band.fx.chorus.wet);
  });
});

// ---------------------------------------------------------------------------
// 5. architecture — sends, master inserts, determinism
// ---------------------------------------------------------------------------

describe('kit 1.8.0 fx architecture', () => {
  it('routes per-voice send amounts, and zero sends nothing', async () => {
    const off = await renderFx({ fx: { bpm: 120, delay: 'quarter' }, play: pluck({ delay: 0 }), seconds: 3 });
    const on = await renderFx({ fx: { bpm: 120, delay: 'quarter' }, play: pluck({ delay: 0.8 }), seconds: 3 });
    assert.ok(energy(on.m) > energy(off.m) * 10, 'a voice with no send must stay out of the effect bus');
  });

  it('names one send option per effect kind', () => {
    // The 1.8.0 kinds lead the table and keep their send names. Later kits append
    // (1.9.0 added bitcrush/snesverb/tape plus two proposals), so this asserts the
    // 1.8.0 contract rather than freezing the list against every future effect.
    assert.deepEqual(FX_KINDS.slice(0, 3), ['reverb', 'delay', 'chorus']);
    assert.equal(FX_VOICE_SEND.reverb, 'verb');
    assert.equal(FX_VOICE_SEND.delay, 'delay');
    assert.equal(FX_VOICE_SEND.chorus, 'chorus');
    // Every kind names exactly one send, and no two kinds share one.
    const sends = FX_KINDS.map((kind) => FX_VOICE_SEND[kind]);
    assert.ok(sends.every((name) => typeof name === 'string' && name.length > 0));
    assert.equal(new Set(sends).size, FX_KINDS.length);
  });

  it('replaces the legacy send reverb rather than running a second one', () => {
    const ctx = new OfflineAudioContext(2, 1024, SR);
    const plain = createBand({ ctx, seed: 1 });
    const upgraded = createBand({ ctx, seed: 1, fx: { reverb: 'hall' } });
    assert.equal(plain.fx, null);
    assert.equal(upgraded.fx.reverb.preset, 'hall');
    // AudioParam values round-trip through float32, so compare with a tolerance.
    assert.ok(Math.abs(upgraded.buses.verbReturn.gain.value - REVERB_PRESETS.hall.wet) < 1e-6);
    assert.ok(upgraded.buses.verb, 'the verb send node still exists so `verb:` amounts keep working');
  });

  it('applies a master insert to the whole sum, with no voice send at all', async () => {
    const dry = await renderFx({ fx: undefined, play: noise({}), seconds: 2, dryVol: 0.8 });
    const inserted = await renderFx({
      fx: { master: { chorus: { preset: 'lush', wet: 0.9 } } },
      play: noise({}),
      seconds: 2,
      dryVol: 0.8,
    });
    assert.notEqual(hashChannels(dry.L, dry.R), hashChannels(inserted.L, inserted.R));
    assert.ok(inserted.band.buses.fxMaster.chorus, 'the master chorus unit must exist');
    assert.ok(
      channelCorrelation(inserted.L, inserted.R) < channelCorrelation(dry.L, dry.R) - 0.01,
      'a master chorus must widen the sum',
    );
  });

  it('lets a master insert mute the dry path entirely', async () => {
    const wetOnly = await renderFx({
      fx: { bpm: 120, master: { delay: { preset: 'quarter', wet: 1 }, dry: 0 } },
      play: pluck({}),
      seconds: 3,
      dryVol: 0.8,
    });
    const dry = await renderFx({ fx: undefined, play: pluck({}), seconds: 3, dryVol: 0.8 });
    const deltaMs = ((onsetFrame(wetOnly.m) - onsetFrame(dry.m)) / SR) * 1000;
    assert.ok(deltaMs > 400, `with dry muted only the delayed sum survives (onset shifted ${deltaMs.toFixed(1)} ms)`);
  });

  it('double-renders byte-identically with every effect engaged', async () => {
    const spec = validateSpec(baseScore({
      fx: {
        reverb: 'hall',
        delay: { preset: 'dotted' },
        chorus: 'lush',
        master: { chorus: { wet: 0.12 } },
      },
    }));
    const a = await renderSpecToWav(spec);
    const b = await renderSpecToWav(spec);
    assert.equal(a.manifest.output.sha256, b.manifest.output.sha256, 'FX renders must be reproducible');
    assert.equal(a.wav.length, b.wav.length);
  });

  it('changes the render when fx are declared, and extends the tail to hold them', async () => {
    // Kit 1.12.0: the bell's bright-voice dark tail reserves tail room of its own; off here so only fx do.
    const plain = await renderSpecToWav(validateSpec(baseScore({ brightVoice: 'off' })));
    const fx = await renderSpecToWav(validateSpec(baseScore({ brightVoice: 'off', fx: { reverb: 'hall', delay: { preset: 'dotted' } } })));
    assert.notEqual(plain.manifest.output.sha256, fx.manifest.output.sha256);
    assert.ok(
      fx.manifest.render.frames > plain.manifest.render.frames,
      `an fx render must reserve tail room (${fx.manifest.render.frames} > ${plain.manifest.render.frames})`,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. the declaration surface
// ---------------------------------------------------------------------------

describe('kit 1.8.0 fx declaration', () => {
  it('converts beat fractions to seconds', () => {
    assert.equal(delaySyncSeconds('1/4', 120), 0.5);
    assert.equal(delaySyncSeconds('1/8', 120), 0.25);
    assert.equal(delaySyncSeconds('1/8.', 120), 0.375);
    assert.equal(delaySyncSeconds('1/16', 120), 0.125);
    assert.equal(delaySyncSeconds(null, 120), null);
    assert.ok(Object.keys(DELAY_SYNC_FRACTIONS).length >= 6);
    assert.throws(() => delaySyncSeconds('1/5', 120), /unknown beat fraction/);
    assert.throws(() => delaySyncSeconds('1/8', undefined), /bpm/);
  });

  it('accepts a preset name, an options object, or a preset plus overrides', () => {
    assert.equal(normalizeReverbFx('plate').seconds, REVERB_PRESETS.plate.seconds);
    assert.equal(normalizeReverbFx({ preset: 'plate', wet: 0.6 }).wet, 0.6);
    assert.equal(normalizeReverbFx({ preset: 'plate', wet: 0.6 }).decay, REVERB_PRESETS.plate.decay);
    assert.equal(normalizeChorusFx('lush').voices, CHORUS_PRESETS.lush.voices);
    assert.equal(normalizeDelayFx('quarter', 120).timeSeconds, DELAY_PRESETS.quarter.time ?? 0.5);
    assert.equal(normalizeDelayFx({ preset: 'eighth' }, 90).timeSeconds, (60 / 90) * 0.5);
    assert.equal(normalizeReverbFx(undefined), null);
    assert.equal(normalizeFx(undefined), null);
    assert.equal(normalizeFx({ bpm: 120 }), null, 'a tempo alone declares no effect');
  });

  it('rejects unknown presets and out-of-range values', () => {
    assert.throws(() => normalizeReverbFx('cathedral'), /unknown preset/);
    assert.throws(() => normalizeChorusFx({ voices: 99 }), /between/);
    assert.throws(() => normalizeChorusFx({ voices: 2.5 }), /integer/);
    assert.throws(() => normalizeDelayFx({ feedback: 1.5 }, 120), /between/);
    assert.throws(() => normalizeFx([]), /must be an object/);
  });

  it('reserves a tail long enough for the declared effects', () => {
    const plan = normalizeFx({ bpm: 120, reverb: 'hall', delay: { preset: 'quarter', feedback: 0.5 } });
    const tail = fxTailSeconds(plan);
    assert.ok(tail >= REVERB_PRESETS.hall.seconds, `tail ${tail} must cover the hall IR`);
    assert.ok(tail < 30, 'the tail must stay bounded');
    assert.ok(fxTailSeconds(normalizeFx({ bpm: 120, delay: { preset: 'quarter', feedback: 0.9 } })) > 1);
  });
});

describe('kit 1.8.0 fx score validation', () => {
  it('accepts a declared suite and per-voice sends', () => {
    assert.doesNotThrow(() => validateSpec(baseScore({
      fx: { reverb: 'hall', delay: { preset: 'dotted', feedback: 0.4 }, chorus: 'subtle', master: { reverb: { wet: 0.1 } } },
    })));
  });

  it('rejects unknown fx fields, presets and ranges', () => {
    assert.throws(() => validateSpec(baseScore({ fx: { reverb: 'hall', wobble: 1 } })), /unknown field/);
    assert.throws(() => validateSpec(baseScore({ fx: { reverb: 'cathedral' } })), /unknown preset/);
    assert.throws(() => validateSpec(baseScore({ fx: { reverb: { seconds: 99 } } })), /between/);
    assert.throws(() => validateSpec(baseScore({ fx: { delay: { sync: '1/5' } } })), /sync/);
    assert.throws(() => validateSpec(baseScore({ fx: {} })), /at least one effect/);
    assert.throws(() => validateSpec(baseScore({ fx: { master: {} } })), /at least one insert/);
  });

  it('rejects fx on the legacy schema and on an older kit', () => {
    const legacy = baseScore({ fx: { reverb: 'hall' } });
    legacy.schemaVersion = '1.0.0';
    delete legacy.tracks.body.steps[0].opts.delay;
    assert.throws(() => validateSpec(legacy), /unknown field/);

    const oldKit = baseScore({ fx: { reverb: 'hall' } });
    oldKit.kitVersion = { semver: '1.7.1', sha: 'f097bd3810ad7ebd5ab588c804892bb1e44689faa003da664899a2f458d7a1d4' };
    assert.throws(() => validateSpec(oldKit), /requires the current kit/);
  });

  it('validates per-voice send amounts and keeps kick out of the wet buses', () => {
    assert.doesNotThrow(() => validateSpec(baseScore({}, [
      { i: 0, voice: 'lead', note: 'E4', dur: 0.2, opts: { vol: 0.1, delay: 0.5, chorus: 0.25 } },
    ])));
    assert.throws(() => validateSpec(baseScore({}, [
      { i: 0, voice: 'lead', note: 'E4', dur: 0.2, opts: { vol: 0.1, delay: 2 } },
    ])), /between 0 and 1/);
    assert.throws(() => validateSpec(baseScore({}, [
      { i: 0, voice: 'kick', opts: { vol: 0.2, delay: 0.5 } },
    ])), /unknown field/);
  });

  it('requires a tempo for a beat-synced delay', () => {
    const spec = baseScore({ fx: { delay: { sync: '1/8' } } });
    delete spec.tempo;
    spec.tracks.body.bpm = 120;
    assert.throws(() => validateSpec(spec), /bpm/);
  });
});
