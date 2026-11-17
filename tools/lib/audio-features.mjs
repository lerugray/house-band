/**
 * Plain-JS audio analysis used by the Timbre Range tooling: WAV reading, FFT,
 * A-weighted energy (loudness matching), and a timbre feature vector (MFCC
 * statistics plus spectral shape) for the distinctness matrix. Analysis only:
 * nothing here plays audio.
 */

export function readWavMono(bytes) {
  const b = Buffer.from(bytes);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= b.length) {
    const id = b.toString('ascii', offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(offset + 10), sampleRate: b.readUInt32LE(offset + 12), bits: b.readUInt16LE(offset + 22) };
    if (id === 'data') data = b.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('expected 16-bit PCM WAV');
  const frames = data.length / (2 * fmt.channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = sum / fmt.channels / 32768;
  }
  return { samples: mono, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b2 = i + j + len / 2;
        const vr = re[b2] * cr - im[b2] * ci;
        const vi = re[b2] * ci + im[b2] * cr;
        re[b2] = re[a] - vr; im[b2] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** IEC A-weighting, linear amplitude gain at f Hz. */
export function aWeight(f) {
  if (f <= 0) return 0;
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return ra * 1.2589; // +2.0 dB so 1 kHz reads unity
}

/** A-weighted energy of samples[start .. start+length): Parseval over a zero-padded FFT. */
export function aWeightedEnergy(samples, sampleRate, startSec, durSec) {
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const len = Math.min(samples.length - start, Math.floor(durSec * sampleRate));
  let n = 1;
  while (n < len) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < len; i++) re[i] = samples[start + i];
  fft(re, im);
  let energy = 0;
  for (let k = 1; k < n / 2; k++) {
    const w = aWeight((k * sampleRate) / n);
    energy += (re[k] ** 2 + im[k] ** 2) * w * w;
  }
  return (2 * energy) / n;
}

const FRAME = 2048;
const HOP = 512;
const MELS = 40;
const COEFFS = 13;

const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);

function melBank(sampleRate) {
  const lo = hz2mel(40);
  const hi = hz2mel(Math.min(16000, sampleRate / 2));
  const points = Array.from({ length: MELS + 2 }, (_, i) => mel2hz(lo + ((hi - lo) * i) / (MELS + 1)));
  const bins = points.map((f) => Math.floor(((FRAME + 1) * f) / sampleRate));
  const bank = [];
  for (let m = 1; m <= MELS; m++) {
    const row = new Float64Array(FRAME / 2 + 1);
    for (let k = bins[m - 1]; k < bins[m]; k++) row[k] = (k - bins[m - 1]) / Math.max(1, bins[m] - bins[m - 1]);
    for (let k = bins[m]; k < bins[m + 1]; k++) row[k] = (bins[m + 1] - k) / Math.max(1, bins[m + 1] - bins[m]);
    bank.push(row);
  }
  return bank;
}

const dct = Array.from({ length: COEFFS }, (_, c) => Float64Array.from({ length: MELS }, (_, m) => Math.cos((Math.PI * c * (m + 0.5)) / MELS)));
const hann = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));

/** Per-frame MFCC and spectral descriptors; silent frames (-55 dB below the peak frame) are dropped. */
export function analyseFrames(samples, sampleRate) {
  const bank = melBank(sampleRate);
  const rows = [];
  let prevMag = null;
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let peakEnergy = 0;
  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    let e = 0;
    for (let i = 0; i < FRAME; i++) { re[i] = samples[start + i] * hann[i]; im[i] = 0; e += samples[start + i] ** 2; }
    peakEnergy = Math.max(peakEnergy, e);
    fft(re, im);
    const mag = new Float64Array(FRAME / 2 + 1);
    for (let k = 0; k <= FRAME / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    let zc = 0;
    for (let i = 1; i < FRAME; i++) if ((samples[start + i] >= 0) !== (samples[start + i - 1] >= 0)) zc++;
    let sum = 0; let weighted = 0; let logSum = 0;
    for (let k = 1; k <= FRAME / 2; k++) { const p = mag[k] ** 2; sum += p; weighted += p * ((k * sampleRate) / FRAME); logSum += Math.log(p + 1e-12); }
    let acc = 0; let rolloff = 0;
    for (let k = 1; k <= FRAME / 2; k++) { acc += mag[k] ** 2; if (acc >= 0.85 * sum) { rolloff = (k * sampleRate) / FRAME; break; } }
    const mel = bank.map((row) => { let s = 0; for (let k = 0; k <= FRAME / 2; k++) s += row[k] * mag[k] ** 2; return Math.log(s + 1e-10); });
    const mfcc = dct.map((row) => { let s = 0; for (let m = 0; m < MELS; m++) s += row[m] * mel[m]; return s; });
    let flux = 0;
    if (prevMag) for (let k = 1; k <= FRAME / 2; k++) flux += Math.max(0, mag[k] - prevMag[k]) ** 2;
    prevMag = mag;
    rows.push({
      energy: e,
      mfcc,
      centroid: sum > 0 ? weighted / sum : 0,
      rolloff,
      flatness: sum > 0 ? Math.exp(logSum / (FRAME / 2)) / (sum / (FRAME / 2)) : 0,
      zcr: zc / FRAME,
      flux: Math.sqrt(flux),
    });
  }
  const floor = peakEnergy * 10 ** (-55 / 10);
  return rows.filter((r) => r.energy > floor);
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
const std = (values) => { const m = mean(values); return Math.sqrt(mean(values.map((v) => (v - m) ** 2))); };

export const FEATURE_NAMES = Object.freeze([
  ...Array.from({ length: 12 }, (_, i) => `mfcc${i + 1}.mean`),
  ...Array.from({ length: 12 }, (_, i) => `mfcc${i + 1}.std`),
  'centroid.log', 'centroid.std', 'rolloff.log', 'flatness', 'zcr', 'flux',
]);

/** The timbre feature vector of a render (energy-weighted over its non-silent frames). */
export function timbreVector(samples, sampleRate) {
  const frames = analyseFrames(samples, sampleRate);
  if (frames.length === 0) return new Float64Array(FEATURE_NAMES.length);
  const weights = frames.map((f) => Math.sqrt(f.energy));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const wmean = (pick) => frames.reduce((acc, f, i) => acc + pick(f) * weights[i], 0) / wsum;
  const vec = [];
  for (let c = 1; c <= 12; c++) vec.push(wmean((f) => f.mfcc[c]));
  for (let c = 1; c <= 12; c++) vec.push(std(frames.map((f) => f.mfcc[c])));
  vec.push(Math.log(wmean((f) => f.centroid) + 1));
  vec.push(std(frames.map((f) => f.centroid)) / 1000);
  vec.push(Math.log(wmean((f) => f.rolloff) + 1));
  vec.push(wmean((f) => f.flatness));
  vec.push(wmean((f) => f.zcr));
  vec.push(Math.log(mean(frames.map((f) => f.flux)) + 1e-6));
  return Float64Array.from(vec);
}

/** z-score statistics of a corpus of feature vectors. */
export function corpusStats(vectors) {
  const dims = vectors[0].length;
  const mu = new Float64Array(dims);
  const sigma = new Float64Array(dims);
  for (let d = 0; d < dims; d++) {
    const col = vectors.map((v) => v[d]);
    mu[d] = mean(col);
    sigma[d] = std(col) || 1;
  }
  return { mu, sigma };
}

/** RMS z-score distance: ~0 identical, ~1.4 for two unrelated members of the corpus. */
export function timbreDistance(a, b, stats) {
  let sum = 0;
  for (let d = 0; d < a.length; d++) sum += (((a[d] - b[d]) / stats.sigma[d]) ** 2);
  return Math.sqrt(sum / a.length);
}
