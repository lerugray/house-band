import { CLASS_VOL, makePatch } from './_dsl.mjs';

const bass = (id, engine, spec) => makePatch(id, 'bass', engine, { vol: CLASS_VOL.bass, ...spec });

export const PATCHES_BASS = [
  bass('reese', 'stack', {
    title: 'Reese',
    character: 'three detuned saws beating against each other under a slowly breathing low-pass, with a sub: the dnb growl',
    env: { a: 0.012, d: 0.3, s: 0.82, r: 0.14 },
    params: { wave: 'sawtooth', voices: 3, spread: 14, cut: 540, q: 1.8, lfo: { rate: 0.38, depth: 0.55 }, sub: 0.6 },
  }),
  bass('fm-dx-bass', 'fm', {
    title: 'FM bass',
    character: 'one-to-one FM with a bright, fast-falling index: a punchy, slightly hollow digital bass',
    env: { a: 0.004, d: 0.28, s: 0.5, r: 0.1 },
    params: { ratio: 1, index: 2.7, indexEnd: 0.7, indexDecay: 0.22 },
  }),
  bass('sub-sine', 'additive', {
    title: 'Sub sine',
    character: 'a clean sine fundamental with a faint second harmonic: pure weight, nothing else',
    env: { a: 0.014, d: 0.2, s: 0.92, r: 0.16 },
    params: { partials: [{ r: 1, l: 1 }, { r: 2, l: 0.2, d: 0.6 }, { r: 3, l: 0.07, d: 0.4 }] },
  }),
  bass('pwm-growl', 'pwm', {
    title: 'PWM growl',
    character: 'a narrow, fast-sweeping pulse through a resonant low-pass that snaps shut on every note: a nasal, rubbery, vocal mono bass',
    env: { a: 0.01, d: 0.3, s: 0.66, r: 0.12 },
    params: { duty: 0.22, depth: 1.0, rate: 3.4, cut: 1500, q: 7, cutEnv: { amt: 4, decay: 0.1 } },
  }),
  bass('string-bass', 'karplus', {
    title: 'Plucked string bass',
    character: 'a physically modelled plucked string (Karplus-Strong): woody, finger-style, with a natural bright-to-dark decay',
    env: { a: 0.002, d: 0.3, s: 0.5, r: 0.22 },
    params: { decay: 1.4, bright: 0.4, blend: 0.5, level: 1, holdScale: 1.4 },
  }),
];
