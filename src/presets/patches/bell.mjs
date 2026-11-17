import { CLASS_VOL, makePatch } from './_dsl.mjs';

const bell = (id, engine, spec) => makePatch(id, 'bell', engine, { vol: CLASS_VOL.bell, ...spec });

export const PATCHES_BELL = [
  bell('fm-glass-bell', 'fm', {
    title: 'FM glass bell',
    character: 'the classic inharmonic FM bell: a bright strike that thins to a pure ring',
    env: { a: 0.002, d: 1.3, s: 0.0, r: 0.9 }, verb: 0.26,
    params: { ratio: 3.5, index: 5, indexEnd: 0.15, indexDecay: 0.9 },
  }),
  bell('tubular-chime', 'additive', {
    title: 'Tubular chime',
    character: 'four inharmonic tubular-bell modes, the upper ones dying first: a struck orchestral chime',
    env: { a: 0.002, d: 1.9, s: 0.0, r: 1.3 }, verb: 0.3,
    params: { partials: [{ r: 1, l: 1, d: 1 }, { r: 2.76, l: 0.6, d: 0.7 }, { r: 5.4, l: 0.35, d: 0.5 }, { r: 8.93, l: 0.18, d: 0.35 }] },
  }),
  bell('glass-harmonica', 'additive', {
    title: 'Glass harmonica',
    character: 'a slow-blooming, slightly beating glass tone with a soft octave: a bowed-glass bell',
    env: { a: 0.16, d: 0.6, s: 0.72, r: 1.6 }, verb: 0.32,
    params: { partials: [{ r: 1, l: 1 }, { r: 1, l: 0.8, det: 4 }, { r: 2, l: 0.13 }, { r: 3, l: 0.05 }] },
  }),
  bell('music-box', 'additive', {
    title: 'Music box',
    character: 'a tiny comb tine: a high pure tone with a quick metallic tick at the front',
    env: { a: 0.001, d: 0.55, s: 0.0, r: 0.35 }, verb: 0.2,
    params: { partials: [{ r: 1, l: 1, d: 1 }, { r: 6.27, l: 0.28, d: 0.16 }, { r: 9.56, l: 0.12, d: 0.1 }] },
  }),
  bell('gamelan', 'additive', {
    title: 'Gamelan metallophone',
    character: 'detuned partner pairs beat against each other in a struck metal bar: the shimmer of a metallophone',
    env: { a: 0.002, d: 2.4, s: 0.0, r: 1.5 }, verb: 0.28,
    params: {
      partials: [
        { r: 1, l: 1, d: 1, det: -9 }, { r: 1, l: 0.95, d: 1, det: 9 },
        { r: 2.31, l: 0.4, d: 0.55, det: -7 }, { r: 2.31, l: 0.38, d: 0.55, det: 7 },
        { r: 3.92, l: 0.18, d: 0.3 },
      ],
    },
  }),
];
