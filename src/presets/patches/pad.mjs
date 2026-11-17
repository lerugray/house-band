import { CLASS_VOL, makePatch } from './_dsl.mjs';

const pad = (id, engine, spec) => makePatch(id, 'pad', engine, { vol: CLASS_VOL.pad, ...spec });

export const PATCHES_PAD = [
  pad('glass-fm', 'fm', {
    title: 'Glass FM pad',
    character: 'two detuned FM voices at an octave ratio; the index sinks slowly so the pad darkens from glassy to hollow',
    env: { a: 0.55, d: 0.9, s: 0.72, r: 1.5 }, cut: 7000, verb: 0.2,
    params: { ratio: 2, index: 1.7, indexEnd: 0.45, indexDecay: 3, unison: 2, detune: 7 },
  }),
  pad('supersaw-wall', 'stack', {
    title: 'Supersaw wall',
    character: 'seven detuned saws and a sub, filter blooming open then settling: a wide trance-style wall',
    env: { a: 0.35, d: 0.6, s: 0.82, r: 1.3 }, verb: 0.16,
    params: { wave: 'sawtooth', voices: 7, spread: 24, cut: 2600, q: 0.6, cutEnv: { amt: 1.9, decay: 1.4 }, sub: 0.3 },
  }),
  pad('choir-ah', 'formant', {
    title: 'Formant choir',
    character: 'a vibrato-wavering saw through three vowel formants with breath: a synthetic "ah" choir',
    env: { a: 0.65, d: 0.5, s: 0.88, r: 1.1 }, verb: 0.24,
    params: {
      wave: 'sawtooth', level: 1, breath: 0.035, track: 0.45,
      formants: [{ f: 800, q: 8, g: 1 }, { f: 1150, q: 10, g: 0.55 }, { f: 2900, q: 12, g: 0.25 }],
      vibrato: { rate: 5.1, depth: 0.0055, delay: 0.5 },
    },
  }),
  pad('drawbar-organ', 'additive', {
    title: 'Drawbar organ',
    character: 'nine sine drawbars, no filter and no decay: a steady, hollow organ bed',
    env: { a: 0.03, d: 0.1, s: 1, r: 0.14 }, verb: 0.1,
    params: {
      partials: [
        { r: 0.5, l: 0.45 }, { r: 1, l: 1 }, { r: 1.5, l: 0.25 }, { r: 2, l: 0.7 }, { r: 3, l: 0.3 },
        { r: 4, l: 0.4 }, { r: 5, l: 0.14 }, { r: 6, l: 0.2 }, { r: 8, l: 0.14 },
      ],
    },
  }),
  pad('breath-wash', 'wash', {
    title: 'Breath wash',
    character: 'pitched noise through a resonant band that follows the note, with a soft sine root: airy and unvoiced',
    env: { a: 1.0, d: 0.8, s: 0.8, r: 1.8 }, verb: 0.3,
    params: { track: 2, f: 0, q: 3.5, sweep: 1.3, level: 3.2, tone: 0.28 },
  }),
];
