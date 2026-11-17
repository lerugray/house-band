import { bp, hp, lane, lp, makeKit, noise, tone, variants } from './_dsl.mjs';

/** Brushed jazz: felt-beater kick, brush-sweep snare, ride cymbal with a ping, cross-stick. */
export const KIT_BRUSHED_JAZZ = makeKit('brushed-jazz', {
  title: 'Brushed jazz',
  character: 'soft felt-beater kick, slow brush-sweep snare, inharmonic ride with a stick ping, wooden cross-stick, finger snap',
  lineage: 'code-synthesized (membrane partials and swept-noise brush; no samples)',
  lanes: {
    kick: lane(0.26, [
      tone(78, 56, 0.24, 1, { a: 0.004, sweep: 0.06 }),
      noise(0.05, 0.55, [lp(160)], { a: 0.003 }),
    ], { lp: 700 }),
    snare: lane(0.26, [
      // The brush: noise swept up through a band, slow attack, then gone.
      noise(0.16, 1, [bp(3200, 0.7, 5400)], { a: 0.05 }),
      tone(210, 190, 0.05, 0.12, { sweep: 0.02 }),
    ]),
    hat: lane(0.09, [noise(0.05, 1, [bp(7800, 0.7)], { a: 0.008 }), tone(2200, null, 0.02, 0.15)], { lp: 11000 }),
    tomLow: lane(0.7, [
      tone(96, 80, 0.62, 1, { a: 0.003, sweep: 0.1, partials: [1, 1.59, 2.14], plevels: [1, 0.35, 0.18], pd: [1, 0.6, 0.4] }),
      noise(0.03, 0.3, [bp(900)], { a: 0.002 }),
    ]),
    tomMid: lane(0.6, [
      tone(138, 115, 0.52, 1, { a: 0.003, sweep: 0.09, partials: [1, 1.59, 2.14], plevels: [1, 0.35, 0.18], pd: [1, 0.6, 0.4] }),
      noise(0.03, 0.3, [bp(1100)], { a: 0.002 }),
    ]),
    tomHigh: lane(0.5, [
      tone(196, 165, 0.42, 1, { a: 0.003, sweep: 0.08, partials: [1, 1.59, 2.14], plevels: [1, 0.35, 0.18], pd: [1, 0.6, 0.4] }),
      noise(0.03, 0.3, [bp(1400)], { a: 0.002 }),
    ]),
    clap: lane(0.16, [noise(0.1, 1, [bp(1800, 1.4)], { bursts: [0, 0.014, 0.031], burstD: 0.01 })], { lp: 5500 }),
    rim: lane(0.08, [
      tone(700, null, 0.045, 0.8),
      tone(1050, null, 0.03, 0.55),
      noise(0.012, 0.35, [bp(2600, 1.5)]),
    ], { lp: 6500 }),
    ride: lane(2.4, [
      tone(3150, null, 2.2, 0.9, { a: 0.002, partials: [1, 1.18, 1.62, 2.07, 2.61, 3.16], plevels: [1, 0.7, 0.55, 0.4, 0.3, 0.2], pd: [1, 0.85, 0.7, 0.55, 0.45, 0.35] }),
      noise(1.6, 0.22, [hp(6000)], { a: 0.002 }),
      tone(5200, null, 0.06, 0.6),
    ]),
    crash: lane(2.8, [
      noise(2.6, 0.9, [bp(5200, 0.4), hp(2800)], { a: 0.012 }),
      tone(2400, null, 2.4, 0.5, { partials: [1, 1.35, 1.9, 2.5, 3.3], pd: [1, 0.8, 0.6, 0.5, 0.4] }),
    ]),
    perc: variants('snap', {
      snap: lane(0.1, [noise(0.04, 1, [bp(2400, 3)], { bursts: [0, 0.006], burstD: 0.01 }), tone(1700, null, 0.015, 0.4)]),
      brush: lane(0.2, [noise(0.14, 1, [bp(4800, 0.6, 3500)], { a: 0.06 })]),
      woodblock: lane(0.1, [tone(1320, null, 0.05, 1, { partials: [1, 2.4], plevels: [1, 0.3] }), noise(0.006, 0.3, [hp(3000)])]),
    }),
  },
});
