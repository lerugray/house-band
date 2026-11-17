import { bp, hp, lane, lp, makeKit, noise, tone, variants } from './_dsl.mjs';

/** Dusty lo-fi: crushed, low-passed, boom-bap. Everything is dulled and gritty on purpose. */
export const KIT_DUSTY_LOFI = makeKit('dusty-lofi', {
  title: 'Dusty lo-fi',
  character: 'bit-crushed, low-passed boom-bap: soft thud kick, papery snare, dull hat, grainy shaker',
  lineage: 'code-synthesized (quantizer + low-pass shaping on every lane)',
  lanes: {
    kick: lane(0.32, [
      tone(110, 55, 0.28, 1, { sweep: 0.08 }),
      noise(0.05, 0.5, [lp(120)]),
    ], { drive: 1.5, crush: 9, lp: 3500 }),
    snare: lane(0.24, [
      noise(0.2, 1, [bp(1100, 0.8)]),
      tone(200, 180, 0.12, 0.5, { wave: 'triangle', sweep: 0.03 }),
    ], { crush: 8, lp: 5000 }),
    hat: lane(0.07, [noise(0.045, 1, [hp(5000), lp(9000)])], { crush: 6 }),
    tomLow: lane(0.34, [tone(105, 70, 0.3, 1, { wave: 'triangle', sweep: 0.08 }), noise(0.015, 0.2, [lp(800)])], { crush: 9, lp: 2500 }),
    tomMid: lane(0.3, [tone(150, 100, 0.26, 1, { wave: 'triangle', sweep: 0.07 }), noise(0.015, 0.2, [lp(900)])], { crush: 9, lp: 2500 }),
    tomHigh: lane(0.26, [tone(215, 150, 0.22, 1, { wave: 'triangle', sweep: 0.06 }), noise(0.015, 0.2, [lp(1000)])], { crush: 9, lp: 2800 }),
    clap: lane(0.26, [
      noise(0.2, 1, [bp(900, 1.2)], { bursts: [0, 0.014, 0.03], burstD: 0.012 }),
    ], { crush: 8, lp: 4000 }),
    rim: lane(0.05, [tone(900, null, 0.03, 1), noise(0.01, 0.4, [bp(2500)])], { crush: 7, lp: 4500 }),
    ride: lane(0.9, [noise(0.8, 1, [bp(7000, 0.6)], { a: 0.003 })], { crush: 7, lp: 9000 }),
    crash: lane(1.4, [noise(1.3, 1, [hp(3000), bp(6000, 0.5)], { a: 0.008 })], { crush: 7, lp: 7000 }),
    perc: variants('shaker', {
      shaker: lane(0.1, [noise(0.06, 1, [bp(4500, 0.9)], { a: 0.02 })], { crush: 6 }),
      tick: lane(0.04, [noise(0.012, 1, [bp(3000, 1.5)]), tone(1400, null, 0.015, 0.5)], { crush: 6, lp: 5000 }),
      thump: lane(0.2, [tone(140, 90, 0.18, 1, { sweep: 0.05 })], { crush: 8, lp: 1800 }),
    }),
  },
});
