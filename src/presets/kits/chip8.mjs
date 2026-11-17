import { bp, hp, lane, lp, makeKit, noise, tone, variants } from './_dsl.mjs';

/** Chip/console: pitch-drop pulse kick, periodic-noise snare and hats, square toms, blips. */
export const KIT_CHIP8 = makeKit('chip8', {
  title: 'Chip / console',
  character: '8-bit pitch-drop kick, periodic-noise snare, ticking noise hats, square-wave toms, coin-blip percussion',
  lineage: 'code-synthesized (square/triangle + the kit\'s periodic noise channel; no samples)',
  lanes: {
    kick: lane(0.2, [tone(125, 38, 0.17, 1, { wave: 'triangle', sweep: 0.09 })], { crush: 6 }),
    snare: lane(0.2, [
      noise(0.13, 1, [bp(3800, 0.7)], { src: 'periodic', rate: 34 }),
      noise(0.06, 0.6, [hp(6000)]),
    ], { crush: 5 }),
    hat: lane(0.06, [noise(0.03, 1, [hp(7500)], { src: 'periodic', rate: 70 })], { crush: 4 }),
    tomLow: lane(0.26, [tone(190, 105, 0.22, 1, { wave: 'square', sweep: 0.12, fx: [lp(2200)] })], { crush: 6 }),
    tomMid: lane(0.22, [tone(260, 150, 0.19, 1, { wave: 'square', sweep: 0.1, fx: [lp(2600)] })], { crush: 6 }),
    tomHigh: lane(0.18, [tone(370, 220, 0.15, 1, { wave: 'square', sweep: 0.08, fx: [lp(3200)] })], { crush: 6 }),
    clap: lane(0.14, [noise(0.09, 1, [bp(1700, 0.8)], { src: 'periodic', rate: 14, bursts: [0, 0.011, 0.022], burstD: 0.01 })], { crush: 5 }),
    rim: lane(0.03, [tone(1500, null, 0.014, 1, { wave: 'square' }), tone(750, null, 0.02, 0.6, { wave: 'square' })], { crush: 4 }),
    ride: lane(0.5, [noise(0.45, 1, [hp(9000)], { src: 'periodic', rate: 90, am: { hz: 38, depth: 0.6, wave: 'square' } })], { crush: 4 }),
    crash: lane(0.9, [noise(0.85, 1, [hp(5000)], { a: 0.004, am: { hz: 24, depth: 0.7, wave: 'square' } })], { crush: 4 }),
    perc: variants('blip', {
      blip: lane(0.22, [
        tone(988, null, 0.07, 0.8, { wave: 'square' }),
        tone(1319, null, 0.16, 0.8, { wave: 'square', delay: 0.06 }),
      ], { crush: 5 }),
      laser: lane(0.18, [tone(2200, 220, 0.16, 1, { wave: 'square', sweep: 0.14 })], { crush: 5 }),
      tick: lane(0.03, [tone(2800, null, 0.012, 1, { wave: 'square' })], { crush: 4 }),
    }),
  },
});
