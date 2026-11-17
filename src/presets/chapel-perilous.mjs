/**
 * Chapel Perilous tuning preserved from the extraction source.
 *
 * This register-specific preset intentionally lives outside src/kit. Consumers
 * opt in with createBand({ ...CHAPEL_PERILOUS_PRESET.band,
 * voiceDefaults: CHAPEL_PERILOUS_PRESET.voices }).
 */
export const CHAPEL_PERILOUS_PRESET = Object.freeze({
  band: Object.freeze({
    gain: 0.5,
    reverb: Object.freeze({ seconds: 3.4, decay: 2.6 }),
    reverbReturnGain: 0.55,
    fadeOut: 1.1,
    fadeIn: 2.2,
    retireTail: 4,
  }),
  voices: Object.freeze({
    pad: Object.freeze({ verb: 0.5, cut: 700, sweep: 1.5, q: 1.2, det: 7, vol: 0.1, wave: 'sawtooth', a: 1.2, d: 1, s: 0.7, r: 2 }),
    drone: Object.freeze({ verb: 0.25, cut: 320, q: 0.8, vol: 0.11, beat: 0, wave: 'sine', a: 2.2, d: 0.8, s: 0.85, r: 3 }),
    bell: Object.freeze({ verb: 0.8, ratios: Object.freeze([1, 2.01, 3.03, 4.78]), levels: Object.freeze([1, 0.4, 0.22, 0.1]), vol: 0.07, a: 0.006, dScale: 0.85, s: 0.02, r: 1.4, holdScale: 0.4 }),
    pluck: Object.freeze({ verb: 0.4, cut: 2400, wave: 'triangle', a: 0.005, dScale: 0.6, s: 0.06, r: 0.3, vol: 0.07, holdScale: 0.5 }),
    bass: Object.freeze({ verb: 0.1, cut: 400, q: 2.5, vol: 0.13, wave: 'sawtooth', a: 0.02, dScale: 0.4, s: 0.5, r: 0.25, holdScale: 0.85 }),
    lead: Object.freeze({ verb: 0.45, cut: 2000, q: 1.8, wave: 'square', vibrato: 4.8, vibratoDepth: 0.005, a: 0.06, d: 0.2, s: 0.7, r: 0.4, vol: 0.08 }),
    air: Object.freeze({ verb: 0.5, type: 'bandpass', bp: 500, sweep: 2.2, q: 1.4, attackScale: 0.4, decayScale: 0.3, s: 0.7, r: 1.6, vol: 0.05 }),
    kick: Object.freeze({ f0: 130, f1: 40, dur: 0.24, vol: 0.3 }),
    snare: Object.freeze({ bp: 1900, q: 0.8, dur: 0.15, vol: 0.11, verb: 0.35 }),
    hat: Object.freeze({ hp: 7000, dur: 0.05, vol: 0.04, verb: 0.2 }),
  }),
});
