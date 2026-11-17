/**
 * Authoring helpers for drum-kit data. Every helper returns a plain JSON-able
 * object: a kit is DATA interpreted by the layered drum engine in
 * src/kit/band.js, never code. (Format: the TIMBRE RANGE section there.)
 */

/** A pitched oscillator layer: f0 -> f1 over `sweep` seconds, decaying over `d`. */
export const tone = (f0, f1, d, level, extra = {}) => ({
  t: 'tone', f0, ...(f1 === null || f1 === undefined ? {} : { f1 }), d, level, ...extra,
});

/** A filtered-noise layer decaying over `d`. */
export const noise = (d, level, fx, extra = {}) => ({
  t: 'noise', d, level, ...(fx && fx.length ? { fx } : {}), ...extra,
});

export const bp = (f, q = 1, f2) => ({ type: 'bandpass', f, q, ...(f2 === undefined ? {} : { f2 }) });
export const hp = (f, q = 0.7, f2) => ({ type: 'highpass', f, q, ...(f2 === undefined ? {} : { f2 }) });
export const lp = (f, q = 0.7, f2) => ({ type: 'lowpass', f, q, ...(f2 === undefined ? {} : { f2 }) });

/** One drum lane: natural length, layers, optional lane-level shaping. */
export const lane = (dur, layers, shape, level) => ({
  dur, layers, ...(shape ? { shape } : {}), ...(level === undefined ? {} : { level }),
});

/** A perc lane with several instruments, chosen per event with opts.variant. */
export const variants = (defaultName, byName) => ({ default: defaultName, variants: byName });

/** The classic 808 metallic-hat oscillator set (Hz). */
export const METAL_808 = [205.3, 304.4, 369.6, 522.7, 540, 800];

/** Inharmonic partial ratios of a struck kettle membrane (timpani). */
export const KETTLE = [1, 1.5, 1.98, 2.44, 2.9];

/** Tubular-bell / gong style partial ratios. */
export const GONG = [1, 1.47, 2.09, 2.56, 3.4, 4.2];

/**
 * Assemble a kit definition. `kind` is derived: any lane with `sample` makes it
 * sample-backed (and `pack` must then pin the pack identity).
 */
export function makeKit(id, { title, character, lineage, lanes, pack = null, version = '1.0.0' }) {
  const sampled = Object.values(lanes).some((l) => l.sample !== undefined
    || (l.variants && Object.values(l.variants).some((v) => v.sample !== undefined)));
  return { id, version, kind: sampled ? 'sample' : 'synth', title, character, lineage, pack, lanes };
}
