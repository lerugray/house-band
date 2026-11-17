/**
 * ITU-R BS.1770-4 / EBU R128 integrated loudness in plain JS (no dependency).
 *
 * K-weighting is the two-stage filter of BS.1770 (a high-shelf "head" stage then
 * the RLB high-pass), with its coefficients derived for the file's own sample
 * rate by the bilinear transform (the published 48 kHz coefficients are the
 * same formulas evaluated at 48 kHz; this is how libebur128 and ffmpeg's
 * `ebur128` filter get 44.1 kHz). Gating: 400 ms blocks at a 100 ms hop, the
 * absolute gate at -70 LUFS, then the relative gate 10 LU under the mean of the
 * blocks that passed it. Channels are summed in power with unit weight (L, R).
 * Analysis only: nothing here plays audio. Validated against
 * `ffmpeg -af ebur128` in test/timbre-loudness.test.mjs and the REPORT.
 */

/** 16-bit PCM WAV bytes -> one Float32Array per channel (the sibling readWavMono averages them). */
export function readWavChannels(bytes) {
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
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) channels[c][i] = data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
  }
  return { channels, sampleRate: fmt.sampleRate };
}

/** Biquad coefficients of the two K-weighting stages at `fs` (libebur128's derivation of BS.1770). */
export function kWeightingStages(fs) {
  // Stage 1: high shelf, +4 dB above ~1.7 kHz.
  const f1 = 1681.974450955533;
  const gain1 = 3.999843853973347;
  const q1 = 0.7071752369554196;
  const k1 = Math.tan((Math.PI * f1) / fs);
  const vh = 10 ** (gain1 / 20);
  const vb = vh ** 0.4996667741545416;
  const a01 = 1 + k1 / q1 + k1 * k1;
  const shelf = {
    b: [(vh + (vb * k1) / q1 + k1 * k1) / a01, (2 * (k1 * k1 - vh)) / a01, (vh - (vb * k1) / q1 + k1 * k1) / a01],
    a: [1, (2 * (k1 * k1 - 1)) / a01, (1 - k1 / q1 + k1 * k1) / a01],
  };
  // Stage 2: RLB high-pass at ~38 Hz.
  const f2 = 38.13547087602444;
  const q2 = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * f2) / fs);
  const a02 = 1 + k2 / q2 + k2 * k2;
  const rlb = { b: [1, -2, 1], a: [1, (2 * (k2 * k2 - 1)) / a02, (1 - k2 / q2 + k2 * k2) / a02] };
  return [shelf, rlb];
}

function biquad(x, { b, a }) {
  const y = new Float64Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

const LUFS_OFFSET = -0.691;
const toLufs = (power) => (power > 0 ? LUFS_OFFSET + 10 * Math.log10(power) : -Infinity);

/**
 * Integrated loudness in LUFS (BS.1770-4 gating) of one or more channels.
 * `channels` is an array of Float32Array/Float64Array at `sampleRate`.
 * Returns -Infinity when no block clears the absolute gate (silence).
 */
export function integratedLufs(channels, sampleRate) {
  const stages = kWeightingStages(sampleRate);
  const frames = channels[0].length;
  // Per-sample K-weighted energy summed over channels (G = 1 each), then turned into a prefix sum.
  const prefix = new Float64Array(frames + 1);
  for (const channel of channels) {
    let y = Float64Array.from(channel);
    for (const stage of stages) y = biquad(y, stage);
    for (let i = 0; i < frames; i++) prefix[i + 1] += y[i] * y[i];
  }
  for (let i = 1; i <= frames; i++) prefix[i] += prefix[i - 1];

  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const powers = [];
  for (let start = 0; start + block <= frames; start += hop) powers.push((prefix[start + block] - prefix[start]) / block);
  const absolute = powers.filter((p) => toLufs(p) > -70);
  if (absolute.length === 0) return -Infinity;
  const mean = (list) => list.reduce((s, p) => s + p, 0) / list.length;
  const relativeGate = toLufs(mean(absolute)) - 10;
  const kept = absolute.filter((p) => toLufs(p) > relativeGate);
  return kept.length === 0 ? -Infinity : toLufs(mean(kept));
}

/** Integrated LUFS of 16-bit PCM WAV bytes. */
export function wavLufs(bytes) {
  const { channels, sampleRate } = readWavChannels(bytes);
  return integratedLufs(channels, sampleRate);
}
