import { CLASS_VOL, makePatch } from './_dsl.mjs';

const lead = (id, engine, spec) => makePatch(id, 'lead', engine, { vol: CLASS_VOL.lead, ...spec });

export const PATCHES_LEAD = [
  lead('fm-brass', 'fm', {
    title: 'FM brass',
    character: 'unison FM where the index swells then relaxes on every note: a bright, blatty synth-brass lead',
    env: { a: 0.045, d: 0.22, s: 0.72, r: 0.2 }, verb: 0.12, cut: 7500,
    params: { ratio: 1, index: 3.6, indexEnd: 1.3, indexDecay: 0.28, unison: 1, vibrato: { rate: 5.3, depth: 0.0035, delay: 0.2 } },
  }),
  lead('pwm-square', 'pwm', {
    title: 'PWM square',
    character: 'a pulse that slowly widens and narrows: the thick, chorused analog lead',
    env: { a: 0.02, d: 0.2, s: 0.72, r: 0.2 }, verb: 0.12,
    params: { duty: 0.5, depth: 0.55, rate: 1.1, cut: 3600, q: 0.9, vibrato: { rate: 5.2, depth: 0.003, delay: 0.25 } },
  }),
  lead('reed-oboe', 'formant', {
    title: 'Reed',
    character: 'a saw through two reedy formants with breath and a late-onset vibrato: a double-reed melody voice',
    env: { a: 0.06, d: 0.15, s: 0.85, r: 0.2 }, verb: 0.16,
    params: {
      wave: 'sawtooth', level: 1.7, breath: 0.03, track: 0.2,
      formants: [{ f: 1050, q: 7, g: 1 }, { f: 2900, q: 9, g: 0.6 }, { f: 450, q: 5, g: 0.35 }],
      vibrato: { rate: 5.6, depth: 0.0065, delay: 0.3 },
    },
  }),
  lead('breath-flute', 'wash', {
    title: 'Breath flute',
    character: 'a near-sine tone with pitched breath noise riding its pitch: a soft, airy wind lead',
    env: { a: 0.07, d: 0.12, s: 0.88, r: 0.18 }, verb: 0.18,
    params: { track: 1, f: 0, q: 22, level: 3.4, tone: 0.55, vibrato: { rate: 5, depth: 0.005, delay: 0.32 } },
  }),
  lead('supersaw-lead', 'stack', {
    title: 'Supersaw lead',
    character: 'five detuned saws with a fast filter flick on each note: the big stacked synth lead',
    env: { a: 0.015, d: 0.2, s: 0.76, r: 0.18 }, verb: 0.14,
    params: { wave: 'sawtooth', voices: 5, spread: 16, cut: 4200, q: 0.7, cutEnv: { amt: 1.6, decay: 0.3 }, vibrato: { rate: 5.4, depth: 0.003, delay: 0.2 } },
  }),
];
