/**
 * Standing render-probe: gain envelopes must not produce one-sample step
 * discontinuities (plateau-then-drop clicks from mid-envelope setValueAtTime).
 *
 * Detector (compose round on a sample project, 2026-08-29):
 *   |Δ| > ABS_FLOOR (0.02 full-scale) AND Δ / local_median(Δ, 2048) > RATIO (60).
 * Absolute floor: jumps under ~0.02 FS are not audible as clicks.
 * Ratio gate: rejects legitimate high-frequency sample-to-sample motion whose
 * local neighbourhood already has large deltas (bell partials, attacks after
 * silence are further ignored via SKIP_LEADING_SECONDS).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderSpecToWav } from '../src/render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ABS_FLOOR = 0.02;
export const RATIO_THRESHOLD = 60;
export const LOCAL_WIN = 2048;
export const SKIP_LEADING_SECONDS = 0.1;

/** Decode PCM16LE WAV to mono float64 in [-1, 1]. */
export function wavMono(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const dataIdx = buf.indexOf(Buffer.from('data'));
  const fmtIdx = buf.indexOf(Buffer.from('fmt '));
  assert.ok(dataIdx >= 0 && fmtIdx >= 0, 'wavMono: missing fmt/data chunk');
  const channels = buf.readUInt16LE(fmtIdx + 10);
  const sampleRate = buf.readUInt32LE(fmtIdx + 12);
  const dataSize = buf.readUInt32LE(dataIdx + 4);
  const start = dataIdx + 8;
  const frames = Math.floor(dataSize / 2 / channels);
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += buf.readInt16LE(start + (i * channels + c) * 2) / 32768;
    }
    mono[i] = sum / channels;
  }
  return { mono, sampleRate };
}

/**
 * @returns {{ count: number, times: number[] }}
 */
export function countStepDiscontinuities(mono, sampleRate, {
  absFloor = ABS_FLOOR,
  ratioThreshold = RATIO_THRESHOLD,
  win = LOCAL_WIN,
  skipLeadingSeconds = SKIP_LEADING_SECONDS,
} = {}) {
  const n = mono.length;
  if (n < 2) return { count: 0, times: [] };
  const diffs = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) diffs[i] = Math.abs(mono[i + 1] - mono[i]);

  const pad = Math.floor(diffs.length / win) * win;
  const local = new Float64Array(diffs.length);
  if (pad === 0) {
    let med = 0;
    const sorted = Float64Array.from(diffs).sort();
    med = sorted[sorted.length >> 1] || 0;
    local.fill(med);
  } else {
    for (let block = 0; block < pad / win; block++) {
      const slice = diffs.subarray(block * win, (block + 1) * win);
      const sorted = Float64Array.from(slice).sort();
      const med = sorted[sorted.length >> 1] || 0;
      local.fill(med, block * win, (block + 1) * win);
    }
    let med = 0;
    const sorted = Float64Array.from(diffs).sort();
    med = sorted[sorted.length >> 1] || 0;
    local.fill(med, pad);
  }

  const skip = Math.floor(skipLeadingSeconds * sampleRate);
  const times = [];
  for (let i = skip; i < diffs.length; i++) {
    const d = diffs[i];
    if (d <= absFloor) continue;
    if (d / Math.max(local[i], 1e-7) > ratioThreshold) times.push(i / sampleRate);
  }
  return { count: times.length, times };
}

describe('envelope continuity (standing render-probe)', () => {
  it('stress score renders with zero mid-piece step discontinuities', async () => {
    const raw = JSON.parse(readFileSync(join(root, 'test/fixtures/bell-envelope-stress-spec.json'), 'utf8'));
    raw.kitVersion = KIT_VERSION;
    const spec = validateSpec(raw);
    const { wav } = await renderSpecToWav(spec, { tailSeconds: 2 });
    const { mono, sampleRate } = wavMono(wav);
    const { count, times } = countStepDiscontinuities(mono, sampleRate);
    assert.equal(
      count,
      0,
      `expected 0 step discontinuities, got ${count} (first: ${times.slice(0, 5).map((t) => t.toFixed(3)).join(', ')})`,
    );
  });
});
