import { bp, hp, lane, lp, makeKit, noise, tone, variants } from './_dsl.mjs';

/** Industrial: FM kick and clank, ring-mod snare, hard-clipped noise, machine-gun clap. */
export const KIT_INDUSTRIAL = makeKit('industrial', {
  title: 'Industrial / metallic',
  character: 'FM-clank kick, ring-modulated snare, inharmonic metal hats, machine-gun clap, hard-clipped anvil percussion',
  lineage: 'code-synthesized (frequency modulation, inharmonic partials, hard clipping)',
  lanes: {
    kick: lane(0.5, [
      tone(72, 38, 0.46, 1, { sweep: 0.1, fm: { ratio: 1.41, index: 5, decay: 0.09 } }),
      noise(0.1, 0.5, [lp(300)]),
    ], { drive: 6 }),
    snare: lane(0.26, [
      tone(340, 300, 0.16, 0.8, { wave: 'square', sweep: 0.05, fm: { ratio: 1.5, index: 8, decay: 0.12 } }),
      tone(190, 170, 0.1, 0.5, { wave: 'square', sweep: 0.04 }),
      noise(0.2, 0.9, [hp(3000)]),
    ], { drive: 3 }),
    hat: lane(0.08, [
      tone(3000, null, 0.06, 1, { wave: 'square', partials: [1, 1.3, 1.78, 2.53, 3.11], fx: [bp(9000, 0.8), hp(5000)] }),
    ], { crush: 5 }),
    tomLow: lane(0.42, [tone(100, 62, 0.4, 1, { sweep: 0.1, fm: { ratio: 1.4, index: 3, decay: 0.1 } })], { drive: 3 }),
    tomMid: lane(0.36, [tone(150, 95, 0.34, 1, { sweep: 0.09, fm: { ratio: 1.4, index: 3, decay: 0.09 } })], { drive: 3 }),
    tomHigh: lane(0.3, [tone(225, 145, 0.28, 1, { sweep: 0.08, fm: { ratio: 1.4, index: 3, decay: 0.08 } })], { drive: 3 }),
    clap: lane(0.16, [
      noise(0.1, 1, [hp(1000)], { bursts: [0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03], burstD: 0.004 }),
    ], { crush: 6, drive: 2 }),
    rim: lane(0.04, [tone(2400, null, 0.015, 0.8, { wave: 'square' }), noise(0.008, 0.5, [hp(3500)])], { crush: 4 }),
    ride: lane(1.3, [
      tone(1800, null, 1.2, 1, { wave: 'sawtooth', partials: [1, 1.504, 1.742, 2.0, 2.54, 3.0], fx: [hp(2500)] }),
      noise(0.9, 0.3, [hp(6000)]),
    ], { drive: 2 }),
    crash: lane(2.0, [
      noise(1.9, 1, [hp(2000)], { a: 0.003 }),
      tone(900, null, 1.5, 0.5, { wave: 'sawtooth', partials: [1, 1.35, 1.78, 2.4, 3.1], pd: [1, 0.8, 0.6, 0.5, 0.4] }),
    ], { drive: 4 }),
    perc: variants('anvil', {
      anvil: lane(0.7, [tone(520, null, 0.6, 1, { partials: [1, 2.76, 5.4, 8.93], plevels: [1, 0.6, 0.4, 0.25], pd: [1, 0.7, 0.5, 0.35] }), noise(0.008, 0.5, [hp(3000)])], { drive: 2 }),
      clang: lane(0.35, [tone(310, null, 0.3, 1, { wave: 'square', fm: { ratio: 2.76, index: 4, decay: 0.2 } })], { drive: 3, crush: 6 }),
      hiss: lane(0.18, [noise(0.14, 1, [hp(6000)], { a: 0.02 })], { crush: 5 }),
    }),
  },
});
