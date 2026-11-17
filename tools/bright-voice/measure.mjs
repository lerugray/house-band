/**
 * Bright-voice measurements (s462), adapted from the Darkness r10 helpers (docs/proposals/r10-reference/r10/lib.mjs):
 * 2-8 kHz RMS (whole file and loudest 10 s window), share of power above 2 kHz, L/R pan balance,
 * 20 dB drop-off after a release (decay20), BS.1770 integrated loudness and true peak (4x oversampled).
 * Analysis only: nothing here plays audio.
 */
import { readWavChannels, integratedLufs } from '../lib/loudness.mjs';

const db10 = (x) => (x > 0 ? 10 * Math.log10(x) : -200);

export function readStereo(bytes) {
  const { channels, sampleRate } = readWavChannels(bytes);
  const L = channels[0]; const R = channels[1] ?? channels[0];
  return { L, R, sr: sampleRate, n: L.length };
}

function biquad(x, b, a) {
  const y = new Float64Array(x.length); let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0]; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
const hpC = (f, fs) => { const w = 2 * Math.PI * f / fs; const c = Math.cos(w); const al = Math.sin(w) / (2 * Math.SQRT1_2); return [[(1 + c) / 2, -(1 + c), (1 + c) / 2], [1 + al, -2 * c, 1 - al]]; };
const lpC = (f, fs) => { const w = 2 * Math.PI * Math.min(f, fs * 0.45) / fs; const c = Math.cos(w); const al = Math.sin(w) / (2 * Math.SQRT1_2); return [[(1 - c) / 2, 1 - c, (1 - c) / 2], [1 + al, -2 * c, 1 - al]]; };

/** 4th-order band (2x 2-pole HP, 2x 2-pole LP): the r10 / lead-balance form. hi = null: high-pass only. */
export function band(x, fs, lo = 2000, hi = 8000) {
  let y = biquad(biquad(x, ...hpC(lo, fs)), ...hpC(lo, fs));
  if (hi) y = biquad(biquad(y, ...lpC(hi, fs)), ...lpC(hi, fs));
  return y;
}
export const mono = (s) => { const m = new Float64Array(s.n); for (let i = 0; i < s.n; i++) m[i] = (s.L[i] + s.R[i]) / 2; return m; };
export const rmsDb = (x, a = 0, b = x.length) => { let p = 0; for (let i = a; i < b; i++) p += x[i] * x[i]; return db10(p / Math.max(1, b - a)); };

/** Loudest `seconds` window (hop 0.5 s) of a signal's power, in dB RMS, and where it starts. */
export function loudestWindowDb(x, sr, seconds = 10) {
  const w = Math.min(x.length, Math.round(seconds * sr)); const hop = Math.round(0.5 * sr);
  const cp = new Float64Array(x.length + 1); for (let i = 0; i < x.length; i++) cp[i + 1] = cp[i] + x[i] * x[i];
  let best = -Infinity; let at = 0;
  for (let i = 0; i + w <= x.length; i += hop) { const p = (cp[i + w] - cp[i]) / w; if (p > best) { best = p; at = i; } }
  return { db: db10(best), startSeconds: at / sr };
}

/** Share of a stem's power above 2 kHz (2-pole^2 high-pass), in percent. */
export function shareAbove(s, hz = 2000) { const m = mono(s); const h = band(m, s.sr, hz, null); let pa = 0; let ph = 0; for (let i = 0; i < m.length; i++) { pa += m[i] * m[i]; ph += h[i] * h[i]; } return pa > 0 ? 100 * ph / pa : 0; }

/** L/R balance: pan % = 100 (E_R - E_L) / (E_R + E_L), positive = right of centre. */
export function balance(s) { let el = 0; let er = 0; for (let i = 0; i < s.n; i++) { el += s.L[i] * s.L[i]; er += s.R[i] * s.R[i]; } return { balanceDb: +(db10(er) - db10(el)).toFixed(2), panPct: +(100 * (er - el) / Math.max(1e-30, er + el)).toFixed(1) }; }

// decay20 exactly as r10 lib.mjs: releases found on the reference stem, the treated stem timed from the same indices.
const envOf = (s, winS = 0.040) => { const m = mono(s); const n = s.n; const hop = Math.round(0.005 * s.sr); const win = Math.round(winS * s.sr); const env = [];
  const cp = new Float64Array(n + 1); for (let i = 0; i < n; i++) cp[i + 1] = cp[i] + m[i] * m[i];
  for (let i = 0; i + win <= n; i += hop) env.push(db10((cp[i + win] - cp[i]) / win)); return { env, hop }; };
export function decay20(s, ref) {
  const { env, hop } = envOf(s); const H = 80; const sr = s.sr;
  const nextOnset = (r) => { let lo = env[r]; for (let j = r + 1; j < env.length; j++) { if (env[j] > lo + 6) return j; lo = Math.min(lo, env[j]); } return env.length; };
  const fall = (r, stop) => { const L0 = env[r]; for (let j = r + 1; j < stop; j++) if (env[j] <= L0 - 20) return { t: (j - r) * hop / sr, reached: true }; return { t: (stop - r) * hop / sr, reached: false }; };
  const out = []; const peaks = []; const stops = [];
  if (ref) ref.peaks.forEach((r, k) => out.push(fall(r, Math.min(env.length, ref.stops[k])).t));
  else { let top = -Infinity; for (const v of env) top = Math.max(top, v);
    for (let r = 4; r + H < env.length; r++) {
      let mx = -Infinity; let mn = Infinity; for (let j = r - 4; j <= r; j++) { mx = Math.max(mx, env[j]); mn = Math.min(mn, env[j]); }
      if (mx - mn > 2 || env[r] < top - 30 || env[r + H] > env[r] - 10) continue;
      const stop = nextOnset(r); if (stop <= r + H) continue;
      const f = fall(r, stop); if (f.reached) { out.push(f.t); peaks.push(r); stops.push(stop); r += H; } } }
  const v = [...out].sort((x, y) => x - y);
  return { notes: v.length, medianMs: v.length ? Math.round(1000 * v[Math.floor(v.length / 2)]) : null, peaks, stops };
}

/** True peak (dBTP): 4x oversampling with a 48-tap Kaiser-windowed sinc per phase (BS.1770-4 Annex 2 style). */
export function truePeakDb(s) {
  const taps = 48; const ph = 4; const beta = 8;
  const i0 = (x) => { let sum = 1; let t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; sum += t; } return sum; };
  const h = []; for (let p = 0; p < ph; p++) { const row = new Float64Array(taps); for (let k = 0; k < taps; k++) { const t = k - taps / 2 + 1 - p / ph; const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t); const wn = (k + p / ph) / taps; const win = i0(beta * Math.sqrt(Math.max(0, 1 - (2 * wn - 1) ** 2))) / i0(beta); row[k] = sinc * win; } h.push(row); }
  let peak = 0;
  for (const x of [s.L, s.R]) for (let i = 0; i < x.length; i++) { peak = Math.max(peak, Math.abs(x[i]));
    for (let p = 1; p < ph; p++) { let acc = 0; for (let k = 0; k < taps; k++) { const j = i + k - taps / 2 + 1; if (j >= 0 && j < x.length) acc += x[j] * h[p][k]; } peak = Math.max(peak, Math.abs(acc)); } }
  return 20 * Math.log10(Math.max(peak, 1e-12));
}

export const lufs = (s) => integratedLufs([s.L, s.R], s.sr);
