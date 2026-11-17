import { bp, hp, lane, lp, makeKit, METAL_808, noise, tone, variants } from './_dsl.mjs';

/** 808-style: long sub boom, two-tone snare, six-square metallic hats, spread clap. */
export const KIT_TR808 = makeKit('tr808', {
  title: '808-style',
  character: 'long sub-bass boom, snappy two-tone snare, six-square metallic hats, spread handclap, cowbell',
  lineage: 'code-synthesized (analog drum-machine topology, original recipe)',
  lanes: {
    kick: lane(1.0, [
      tone(150, 46, 0.95, 1, { sweep: 0.05 }),
      noise(0.006, 0.3, [hp(1500)]),
    ], { drive: 1.5 }),
    snare: lane(0.26, [
      tone(185, 160, 0.13, 0.7, { wave: 'triangle', sweep: 0.03 }),
      tone(330, 290, 0.09, 0.4, { wave: 'triangle', sweep: 0.03 }),
      noise(0.18, 0.85, [hp(1800)]),
    ]),
    hat: lane(0.07, [
      tone(1, null, 0.05, 0.9, { wave: 'square', partials: METAL_808, fx: [bp(10000, 0.8), hp(7000)] }),
    ]),
    tomLow: lane(0.55, [tone(115, 85, 0.5, 1, { sweep: 0.08 }), noise(0.012, 0.2, [bp(1200)])]),
    tomMid: lane(0.45, [tone(165, 122, 0.42, 1, { sweep: 0.07 }), noise(0.012, 0.2, [bp(1500)])]),
    tomHigh: lane(0.36, [tone(240, 178, 0.34, 1, { sweep: 0.06 }), noise(0.012, 0.2, [bp(1900)])]),
    clap: lane(0.26, [
      noise(0.2, 1, [bp(1000, 2)], { bursts: [0, 0.0105, 0.0215, 0.032], burstD: 0.008 }),
      noise(0.09, 0.3, [hp(3500)], { bursts: [0, 0.0105, 0.0215, 0.032], burstD: 0.008 }),
    ]),
    rim: lane(0.06, [
      tone(1667, null, 0.02, 0.6, { wave: 'square' }),
      tone(455, null, 0.04, 0.7),
      noise(0.008, 0.3, [hp(4000)]),
    ]),
    ride: lane(1.3, [
      tone(1, null, 1.2, 0.8, { wave: 'square', partials: METAL_808, fx: [bp(5500, 0.7), hp(4000)] }),
      noise(1.0, 0.25, [hp(7000)]),
    ]),
    crash: lane(2.0, [
      tone(1, null, 1.8, 0.9, { wave: 'square', partials: METAL_808.map((v) => v * 1.3), fx: [hp(3000)] }),
      noise(1.9, 0.6, [hp(4500)], { a: 0.005 }),
    ]),
    perc: variants('cowbell', {
      cowbell: lane(0.4, [
        tone(540, null, 0.35, 0.75, { wave: 'square', fx: [bp(2640, 1)] }),
        tone(800, null, 0.3, 0.75, { wave: 'square', fx: [bp(2640, 1)] }),
      ]),
      maraca: lane(0.06, [noise(0.03, 1, [hp(5000, 0.7)], { a: 0.006 })]),
      clave: lane(0.07, [tone(2500, null, 0.035, 1)]),
      conga: lane(0.35, [tone(310, 255, 0.3, 1, { sweep: 0.04 }), noise(0.01, 0.25, [bp(2000)])]),
    }),
  },
});
