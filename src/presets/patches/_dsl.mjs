/**
 * Authoring helper for instrument-patch data. A patch is DATA interpreted by
 * one of the engines in src/kit/band.js (fm, stack, additive, formant, wash,
 * karplus, pwm, sample). `vol` is the loudness-equivalent default for the voice
 * class (the same number the historical voice uses), `env` the default
 * amplitude envelope, `params` the engine's own parameters.
 */
export function makePatch(id, cls, engine, { title, character, lineage = 'code-synthesized', vol, env, cut, q, verb, params, pack = null, version = '1.0.0' }) {
  return {
    id, version, class: cls, engine, title, character, lineage, vol, env,
    ...(cut === undefined ? {} : { cut }),
    ...(q === undefined ? {} : { q }),
    ...(verb === undefined ? {} : { verb }),
    pack,
    params,
  };
}

/** Class-default loudness (matches NEUTRAL_DEFAULTS.voices[class].vol). */
export const CLASS_VOL = Object.freeze({ pad: 0.08, bass: 0.1, lead: 0.07, pluck: 0.06, bell: 0.06 });
