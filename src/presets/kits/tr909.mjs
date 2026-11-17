import { bp, hp, lane, makeKit, noise, tone, variants } from './_dsl.mjs';

/** 909-style: hard-clipped punch kick, noisy bright snare, tight sizzle hats, tambourine. */
export const KIT_TR909 = makeKit('tr909', {
  title: '909-style',
  character: 'hard-clipped punchy kick, noisy bright snare, tight sizzling hats, long clap tail, tambourine',
  lineage: 'code-synthesized (original recipe; punch and clip, not the 808 boom)',
  lanes: {
    kick: lane(0.4, [
      tone(300, 50, 0.36, 1, { sweep: 0.03 }),
      tone(120, 50, 0.3, 0.4, { wave: 'triangle', sweep: 0.05 }),
      noise(0.008, 0.55, [hp(3500)]),
    ], { drive: 4, hp: 28 }),
    snare: lane(0.3, [
      tone(200, 170, 0.11, 0.7, { wave: 'triangle', sweep: 0.02 }),
      tone(350, 320, 0.08, 0.35, { wave: 'triangle', sweep: 0.02 }),
      noise(0.24, 1.1, [hp(2600)]),
    ], { drive: 1.8 }),
    hat: lane(0.07, [
      noise(0.04, 0.9, [hp(8500)]),
      tone(1, null, 0.035, 0.4, { wave: 'square', partials: [6000, 8100, 9700], fx: [hp(6000)] }),
    ]),
    tomLow: lane(0.3, [tone(190, 95, 0.28, 1, { sweep: 0.05 }), noise(0.01, 0.4, [bp(2200)])], { drive: 1.5 }),
    tomMid: lane(0.26, [tone(260, 135, 0.24, 1, { sweep: 0.045 }), noise(0.01, 0.4, [bp(2600)])], { drive: 1.5 }),
    tomHigh: lane(0.22, [tone(350, 185, 0.2, 1, { sweep: 0.04 }), noise(0.01, 0.4, [bp(3000)])], { drive: 1.5 }),
    clap: lane(0.34, [
      noise(0.2, 1, [bp(1200, 1)], { bursts: [0, 0.008, 0.016, 0.024], burstD: 0.007 }),
      noise(0.3, 0.35, [hp(800)], { a: 0.01 }),
    ]),
    rim: lane(0.05, [
      tone(1800, null, 0.02, 0.8, { wave: 'square' }),
      tone(520, null, 0.03, 0.6),
    ], { drive: 3 }),
    ride: lane(1.5, [
      noise(1.4, 0.7, [hp(5500)]),
      tone(3600, null, 1.2, 0.4, { wave: 'triangle', partials: [1, 1.34, 2.1, 2.74] }),
    ]),
    crash: lane(2.2, [
      noise(2.1, 1, [hp(3000), bp(8000, 0.5)], { a: 0.004 }),
    ]),
    perc: variants('tambourine', {
      tambourine: lane(0.2, [noise(0.12, 1, [hp(7000)], { bursts: [0, 0.012, 0.024], burstD: 0.02 })]),
      shaker: lane(0.09, [noise(0.04, 1, [bp(7500, 1)], { a: 0.01 })]),
      cowbell: lane(0.3, [
        tone(587, null, 0.25, 0.7, { wave: 'square', fx: [bp(2200, 1)] }),
        tone(845, null, 0.2, 0.7, { wave: 'square', fx: [bp(2200, 1)] }),
      ]),
    }),
  },
});
