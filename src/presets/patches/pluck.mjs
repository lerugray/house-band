import { CLASS_VOL, makePatch } from './_dsl.mjs';

const pluck = (id, engine, spec) => makePatch(id, 'pluck', engine, { vol: CLASS_VOL.pluck, ...spec });

export const PATCHES_PLUCK = [
  pluck('karplus-string', 'karplus', {
    title: 'Karplus-Strong string',
    character: 'a physically modelled plucked string: a noise burst circulating in a damped delay line, bright then mellow',
    env: { a: 0.001, d: 0.3, s: 0.4, r: 0.2 }, verb: 0.14,
    params: { decay: 1.9, bright: 0.85, blend: 0.5, level: 1, holdScale: 3 },
  }),
  pluck('fm-marimba', 'fm', {
    title: 'FM marimba',
    character: 'a carrier with a quickly dying inharmonic modulator: a woody, mallet-struck bar',
    env: { a: 0.001, d: 0.7, s: 0.0, r: 0.3 }, verb: 0.18,
    params: { ratio: 3.99, index: 3.4, indexEnd: 0.03, indexDecay: 0.05, ratio2: 9.2, index2: 1.3, index2End: 0.0, index2Decay: 0.03 },
  }),
  pluck('kalimba', 'additive', {
    title: 'Kalimba',
    character: 'a pure tine with a short, nasal inharmonic ping on top: a thumb-piano pluck',
    env: { a: 0.001, d: 0.75, s: 0.0, r: 0.3 }, verb: 0.2,
    params: { partials: [{ r: 1, l: 1, d: 1 }, { r: 5.43, l: 0.38, d: 0.22 }, { r: 11.9, l: 0.1, d: 0.1 }] },
  }),
  pluck('bottle-tick', 'wash', {
    title: 'Bottle tick',
    character: 'a click of noise ringing a very narrow resonance at the note: a blown-bottle / tuned-wood tick',
    env: { a: 0.001, d: 0.22, s: 0.0, r: 0.1 }, verb: 0.14,
    params: { track: 1, f: 0, q: 55, level: 6, tone: 0.08 },
  }),
];
