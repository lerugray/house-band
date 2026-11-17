import { bp, hp, KETTLE, GONG, lane, lp, makeKit, noise, tone, variants } from './_dsl.mjs';

/** Orchestral percussion: kettle-drum modes, gran cassa, wire-rattle snare, suspended cymbal, tam. */
export const KIT_ORCHESTRAL = makeKit('orchestral', {
  title: 'Orchestral percussion',
  character: 'tuned kettle-drum modes for kick and toms, wire-rattle orchestral snare, suspended-cymbal swell, tam-tam crash, triangle',
  lineage: 'code-synthesized (measured-ratio membrane and metal partials; no samples)',
  lanes: {
    kick: lane(1.4, [
      // Gran cassa: a low membrane with inharmonic modes and a dull mallet thud.
      tone(62, 55, 1.25, 1, { a: 0.004, sweep: 0.2, partials: KETTLE, plevels: [1, 0.55, 0.35, 0.22, 0.14], pd: [1, 0.75, 0.55, 0.42, 0.3] }),
      noise(0.04, 0.6, [lp(260)], { a: 0.002 }),
    ]),
    snare: lane(0.34, [
      noise(0.26, 1, [bp(5200, 0.7)], { am: { hz: 88, depth: 0.55 } }),
      tone(215, 200, 0.07, 0.35, { sweep: 0.02 }),
      noise(0.012, 0.6, [hp(4000)]),
    ]),
    hat: lane(0.18, [
      noise(0.1, 0.8, [hp(6500)], { a: 0.002 }),
      tone(4800, null, 0.16, 0.55, { partials: [1, 2.76, 5.4], plevels: [1, 0.5, 0.25], pd: [1, 0.6, 0.4] }),
    ]),
    tomLow: lane(1.0, [
      tone(82, 76, 0.9, 1, { a: 0.003, sweep: 0.15, partials: KETTLE, plevels: [1, 0.5, 0.32, 0.2, 0.12], pd: [1, 0.72, 0.52, 0.4, 0.3] }),
      noise(0.03, 0.5, [lp(420)], { a: 0.002 }),
    ]),
    tomMid: lane(0.9, [
      tone(110, 103, 0.8, 1, { a: 0.003, sweep: 0.14, partials: KETTLE, plevels: [1, 0.5, 0.32, 0.2, 0.12], pd: [1, 0.72, 0.52, 0.4, 0.3] }),
      noise(0.03, 0.5, [lp(520)], { a: 0.002 }),
    ]),
    tomHigh: lane(0.8, [
      tone(147, 138, 0.7, 1, { a: 0.003, sweep: 0.12, partials: KETTLE, plevels: [1, 0.5, 0.32, 0.2, 0.12], pd: [1, 0.72, 0.52, 0.4, 0.3] }),
      noise(0.03, 0.5, [lp(640)], { a: 0.002 }),
    ]),
    clap: lane(0.12, [
      // Slapstick: two boards, one hard crack.
      noise(0.05, 1, [bp(2600, 2)], { bursts: [0, 0.004], burstD: 0.01 }),
      tone(1250, null, 0.02, 0.5),
    ]),
    rim: lane(0.12, [tone(1480, null, 0.07, 1, { partials: [1, 2.4], plevels: [1, 0.35], pd: [1, 0.5] }), noise(0.005, 0.3, [hp(3500)])]),
    ride: lane(2.4, [
      // Suspended cymbal: a slow swell into a long shimmer.
      noise(2.2, 0.8, [hp(4200), bp(7500, 0.4)], { a: 0.28 }),
      tone(3400, null, 2.0, 0.35, { a: 0.2, partials: [1, 1.43, 1.89, 2.62, 3.4], pd: [1, 0.85, 0.7, 0.55, 0.4] }),
    ]),
    crash: lane(4.0, [
      // Tam-tam: low inharmonic modes bloom slowly under a cymbal wash.
      tone(176, null, 3.8, 1, { a: 0.03, partials: GONG, plevels: [1, 0.8, 0.65, 0.5, 0.4, 0.3], pd: [1, 0.9, 0.8, 0.7, 0.6, 0.5] }),
      noise(3.0, 0.45, [lp(3200), hp(500)], { a: 0.08 }),
    ]),
    perc: variants('triangle', {
      triangle: lane(1.0, [tone(1230, null, 0.9, 1, { partials: [1, 2.76, 5.4, 8.9], plevels: [1, 0.55, 0.3, 0.15], pd: [1, 0.65, 0.45, 0.3] }), noise(0.004, 0.2, [hp(7000)])]),
      castanets: lane(0.08, [noise(0.025, 1, [bp(3200, 2.2)], { bursts: [0, 0.011], burstD: 0.012 }), tone(1800, null, 0.015, 0.4)]),
      tambourine: lane(0.35, [noise(0.25, 1, [hp(6200)], { bursts: [0, 0.015, 0.03, 0.046], burstD: 0.03 })]),
      woodblock: lane(0.12, [tone(980, null, 0.07, 1, { partials: [1, 2.3], plevels: [1, 0.3], pd: [1, 0.5] }), noise(0.006, 0.3, [hp(2500)])]),
    }),
  },
});
