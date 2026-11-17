/**
 * Deterministic build-time pitch measurement.
 *
 * DETERMINISM LAW (kit 1.7.0): anything whose result reaches a sample-pack
 * manifest — and therefore the manifest/content SHA-256 a score pins — is
 * computed with IEEE-754 `+ - * /` and integer operations ONLY. Those are
 * correctly rounded and therefore bit-identical on every conforming engine.
 * Transcendentals (`Math.pow`, `Math.log`, `Math.cos`) are implementation
 * defined, so they are confined to human-facing report strings and must never
 * feed a manifest field. That rules out an FFT here: the twiddle factors would
 * need cos/sin. YIN's difference function is pure arithmetic, so it is what we
 * use.
 */

import { MIDI_MAX, MIDI_MIN, noteToMidi } from '../src/kit/band.js';

export { nearestMidi } from '../src/kit/band.js';

const YIN_THRESHOLD = 0.15;
const WINDOW_FRAMES = 8192;
const MIN_F0_HZ = 30;
const MAX_F0_HZ = 2000;

/**
 * Parse a root note out of a source filename.
 * Two conventions carry it today:
 *   INSTRUMENTS / HUMBUCKER — `<NAME>-<MIDI>-<velocity>.wav`
 *   Essential WAV From Mars — `… C3.wav` (trailing note name)
 * Returns { midi, convention } or null when the filename encodes nothing.
 */
export function parseRootNoteFromFilename(sourceFile) {
  const base = String(sourceFile).split('/').pop().replace(/\.wav$/i, '');
  const numbered = /-(\d{1,3})-(\d{1,3})$/.exec(base);
  if (numbered) {
    const midi = Number(numbered[1]);
    if (Number.isInteger(midi) && midi >= MIDI_MIN && midi <= MIDI_MAX) {
      return { midi, convention: 'midi-velocity' };
    }
  }
  const named = /(?:^|[\s_-])([A-G][#b]?-?\d)$/.exec(base);
  if (named) {
    const midi = noteToMidi(named[1]);
    if (midi !== null) return { midi, convention: 'note-name' };
  }
  return null;
}

/**
 * YIN fundamental estimate over Int16 canonical frames.
 * Pure arithmetic; no transcendental calls.
 * @returns {{ frequencyHz: number|null, confidence: number, tau: number|null }}
 */
export function measureF0(frames, sampleRate) {
  const tauMin = Math.max(2, Math.floor(sampleRate / MAX_F0_HZ));
  const tauMax = Math.min(Math.floor(sampleRate / MIN_F0_HZ), frames.length - 2);
  if (tauMax <= tauMin) return { frequencyHz: null, confidence: 0, tau: null };

  // Analyse just past the attack so a pluck transient does not dominate.
  const skip = Math.min(frames.length >> 3, Math.floor(sampleRate / 10));
  const window = Math.min(WINDOW_FRAMES, frames.length - skip - tauMax);
  if (window < 512) return { frequencyHz: null, confidence: 0, tau: null };

  // Remove DC with an exact integer mean numerator; keeps the difference
  // function honest on offset-heavy sources without a floating mean.
  let sum = 0;
  for (let i = 0; i < window + tauMax; i++) sum += frames[skip + i];
  const mean = sum / (window + tauMax);
  const signal = new Float64Array(window + tauMax);
  for (let i = 0; i < signal.length; i++) signal[i] = frames[skip + i] - mean;

  const difference = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let total = 0;
    for (let j = 0; j < window; j++) {
      const delta = signal[j] - signal[j + tau];
      total += delta * delta;
    }
    difference[tau] = total;
  }

  const normalized = new Float64Array(tauMax + 1);
  normalized[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += difference[tau];
    normalized[tau] = running === 0 ? 1 : (difference[tau] * tau) / running;
  }

  let chosen = -1;
  for (let tau = tauMin; tau < tauMax; tau++) {
    if (normalized[tau] < YIN_THRESHOLD) {
      while (tau + 1 < tauMax && normalized[tau + 1] < normalized[tau]) tau++;
      chosen = tau;
      break;
    }
  }
  if (chosen < 0) {
    let bestValue = Infinity;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (normalized[tau] < bestValue) {
        bestValue = normalized[tau];
        chosen = tau;
      }
    }
  }
  if (chosen < 0) return { frequencyHz: null, confidence: 0, tau: null };

  // Parabolic refinement around the chosen dip (arithmetic only).
  let refined = chosen;
  if (chosen > tauMin && chosen + 1 <= tauMax) {
    const a = normalized[chosen - 1];
    const b = normalized[chosen];
    const c = normalized[chosen + 1];
    const denominator = 2 * (2 * b - a - c);
    if (denominator !== 0) {
      const shift = (c - a) / denominator;
      if (shift > -1 && shift < 1) refined = chosen + shift;
    }
  }
  return {
    frequencyHz: sampleRate / refined,
    confidence: 1 - normalized[chosen],
    tau: refined,
  };
}

/** Integer millihertz, the manifest-safe form of a measured frequency. */
export function toMillihertz(frequencyHz) {
  return Math.round(frequencyHz * 1000);
}

/** Human-facing only — uses Math.log2 and must never reach a manifest field. */
export function centsBetween(frequencyHz, referenceHz) {
  return 1200 * Math.log2(frequencyHz / referenceHz);
}
