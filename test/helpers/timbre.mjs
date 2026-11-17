/** Shared helpers for the Timbre Range tests: small scores, stereo WAV reading, spectra. Analysis only. */
import { createHash } from 'node:crypto';

import { fft, readWavMono } from '../../tools/lib/audio-features.mjs';
import { renderSpecToWav } from '../../src/render.mjs';
import { validateSpec } from '../../src/spec.mjs';
import { KIT_VERSION } from '../../src/version.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const SR = 44100;

/** A one-track score on the current kit. `steps` are plain events; extra top-level fields via `extra`. */
export function miniScore(steps, { bars = 1, tempo = 120, extra = {}, track = {}, seed = 0x5eed, fadeIn = 0 } = {}) {
  return {
    schemaVersion: '1.1.0',
    kitVersion: { ...KIT_VERSION },
    seed,
    tempo,
    sampleRate: SR,
    gain: 0.5,
    register: { name: 'kit-demo', briefRef: 'docs/REGISTER-KIT-DEMO.md' },
    tracks: { T: { bpm: tempo, len: 16, vol: 0.8, steps, ...track } },
    sections: [{ track: 'T', bars, fadeIn }],
    ...extra,
  };
}

export async function render(score, opts = {}) {
  return renderSpecToWav(validateSpec(structuredClone(score)), opts);
}

/** Stereo 16-bit PCM WAV bytes -> { left, right } Float32Arrays. */
export function stereo(wav) {
  const b = Buffer.from(wav);
  let offset = 12;
  let data = null;
  while (offset + 8 <= b.length) {
    const id = b.toString('ascii', offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    if (id === 'data') data = b.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  const frames = data.length / 4;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { left[i] = data.readInt16LE(i * 4) / 32768; right[i] = data.readInt16LE(i * 4 + 2) / 32768; }
  return { left, right };
}

export const mono = (wav) => readWavMono(wav).samples;
export const energy = (x, from = 0, to = x.length) => { let e = 0; for (let i = from; i < to && i < x.length; i++) e += x[i] * x[i]; return e; };
export const peak = (x) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p; };

/** Magnitude spectrum of x[start .. start+n) (Hann), as { bin(f) , mags, hz(k) }. */
export function spectrum(x, start, n = 8192) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[start + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const mags = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) mags[k] = Math.hypot(re[k], im[k]);
  return { mags, hz: (k) => (k * SR) / n, bin: (f) => Math.round((f * n) / SR) };
}

/** Strongest spectral peak (Hz) inside [lo, hi]. */
export function peakHz(x, start, lo, hi, n = 8192) {
  const s = spectrum(x, start, n);
  let best = 0;
  let at = 0;
  for (let k = s.bin(lo); k <= s.bin(hi); k++) if (s.mags[k] > best) { best = s.mags[k]; at = k; }
  return { hz: s.hz(at), mag: best, max: Math.max(...s.mags) };
}

/** Normalised-autocorrelation fundamental estimate in [lo, hi] Hz. */
export function autocorrF0(x, start, lo, hi, n = 4096) {
  let best = 0;
  let lag = 0;
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += x[start + i] ** 2;
  for (let L = Math.floor(SR / hi); L <= Math.ceil(SR / lo); L++) {
    let s = 0;
    let e1 = 0;
    for (let i = 0; i < n; i++) { s += x[start + i] * x[start + i + L]; e1 += x[start + i + L] ** 2; }
    const c = s / Math.sqrt(e0 * e1 + 1e-18);
    if (c > best) { best = c; lag = L; }
  }
  return { hz: SR / lag, confidence: best };
}

export const cents = (hz, target) => 1200 * Math.log2(hz / target);
