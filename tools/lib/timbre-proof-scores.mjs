/**
 * The fixed musical material of the Timbre-Range proof: ONE 8-bar drum groove
 * (rendered through every kit) and ONE 8-bar phrase per voice class (rendered
 * through every patch of that class). The notes never change between renders;
 * only the kit or the patch does, so any difference a listener or a distance
 * measure finds is timbre. Kit-demo register: a tooling exercise, never shipped.
 */
import { KIT_VERSION } from '../../src/version.mjs';

const TEMPO = 120;
const base = (label, tracks, sections, extra = {}) => ({
  schemaVersion: '1.1.0',
  kitVersion: { ...KIT_VERSION },
  seed: 0x7157_0383,
  tempo: TEMPO,
  sampleRate: 44100,
  gain: 0.5,
  label,
  register: { name: 'kit-demo', briefRef: 'docs/REGISTER-KIT-DEMO.md' },
  tracks,
  sections,
  // Kit 1.12.0: the Timbre Range proofs measure the patch / kit itself (identity, distance, the loudness bar), so the
  // bright-voice mix treatment is off here; tools/bright-voice/ measures the treatment.
  brightVoice: 'off',
  ...extra,
});

const bars = (...perBar) => perBar.flatMap((steps, bar) => steps.map((s) => bar * 16 + s));
const evens = (barCount, except = []) => {
  const out = [];
  for (let bar = 0; bar < barCount; bar++) for (let s = 0; s < 16; s += 2) if (!except.includes(bar * 16 + s)) out.push(bar * 16 + s);
  return out;
};

/** The 8-bar groove: A (bars 1-4) then B (bars 5-8), every added lane included. */
export function grooveScore({ kit, label } = {}) {
  const openHats = [14, 30, 46, 62];
  const A = {
    bpm: TEMPO, len: 64, vol: 0.9,
    steps: [
      { i: bars([0, 10], [0, 7, 10], [0, 10], [0, 7, 10, 14]), voice: 'kick', opts: { vol: 0.3 } },
      { i: bars([4, 12], [4, 12], [4, 12], [4]), voice: 'snare', opts: { vol: 0.11 } },
      { i: [47], voice: 'snare', opts: { vol: 0.05 } },
      { i: evens(4, openHats), voice: 'hat', opts: { vol: 0.04 } },
      { i: openHats, voice: 'hat', opts: { vol: 0.045, dur: 0.3, variant: 'open' } },
      { i: bars([6], [6], [6], [6]), voice: 'rim', opts: { vol: 0.1 } },
      { i: bars([2, 6, 10, 14], [2, 6, 10, 14], [2, 6, 10, 14], [2, 6, 10, 14]), voice: 'perc', opts: { vol: 0.06 } },
      { i: [56], voice: 'tomHigh', opts: { vol: 0.2 } },
      { i: [58], voice: 'tomMid', opts: { vol: 0.22 } },
      { i: [60, 62], voice: 'tomLow', opts: { vol: 0.24 } },
      { i: [0], voice: 'crash', opts: { vol: 0.06 } },
    ],
  };
  const B = {
    bpm: TEMPO, len: 64, vol: 0.9,
    steps: [
      { i: bars([0, 6, 10], [0, 6, 10], [0, 6, 10], [0, 6, 10, 14]), voice: 'kick', opts: { vol: 0.3 } },
      { i: bars([4, 12], [4, 12], [4, 12], [4]), voice: 'snare', opts: { vol: 0.11 } },
      { i: bars([4, 12], [4, 12], [4, 12], [4]), voice: 'clap', opts: { vol: 0.12 } },
      { i: bars([0, 4, 8, 12], [0, 4, 8, 12], [0, 4, 8, 12], [0, 4, 8, 12]), voice: 'ride', opts: { vol: 0.05 } },
      { i: bars([2, 6, 10, 14], [2, 6, 10, 14], [2, 6, 10, 14], [2, 6, 10, 14]), voice: 'hat', opts: { vol: 0.036 } },
      { i: bars([15], [15], [15], [15]), voice: 'rim', opts: { vol: 0.09 } },
      { i: [56, 57], voice: 'tomHigh', opts: { vol: 0.2 } },
      { i: [58, 59], voice: 'tomMid', opts: { vol: 0.22 } },
      { i: [60, 61, 62], voice: 'tomLow', opts: { vol: 0.24 } },
      { i: [0], voice: 'crash', opts: { vol: 0.06 } },
      { i: bars([2, 10], [2, 10], [2, 10], [2, 10]), voice: 'perc', opts: { vol: 0.06 } },
    ],
  };
  return base(label ?? `timbre proof groove, kit ${kit ?? 'default'}`, { A, B }, [
    { track: 'A', bars: 4, fadeIn: 0 },
    { track: 'B', bars: 4 },
  ], {
    ...(kit ? { kit } : {}),
    performance: { humanize: { timingMs: [-3, 3], velocity: [-0.06, 0.06], swing: 0.05 } },
  });
}

// ---- phrases: chords C-Am-F-G over eight bars (two bars each) -----------------
const CHORDS = [
  { root: 'C', low: 'C2', tones: ['C4', 'E4', 'G4', 'B4'], pad: ['C3', 'G3', 'E4', 'B4'] },
  { root: 'A', low: 'A1', tones: ['A3', 'C4', 'E4', 'G4'], pad: ['A2', 'E3', 'C4', 'G4'] },
  { root: 'F', low: 'F1', tones: ['F3', 'A3', 'C4', 'E4'], pad: ['F2', 'C3', 'A3', 'E4'] },
  { root: 'G', low: 'G1', tones: ['G3', 'B3', 'D4', 'E4'], pad: ['G2', 'D3', 'B3', 'E4'] },
];

const LEAD_LINE = [ // [step, note, dur]
  [0, 'E5', 0.9], [8, 'G5', 0.45], [12, 'A5', 0.45], [16, 'G5', 0.9], [24, 'E5', 0.9],
  [32, 'C5', 0.9], [40, 'E5', 0.45], [44, 'G5', 0.45], [48, 'A5', 0.9], [56, 'G5', 0.9],
  [64, 'A5', 0.9], [72, 'C6', 0.45], [76, 'A5', 0.45], [80, 'G5', 0.9], [88, 'E5', 0.9],
  [96, 'D5', 0.45], [100, 'E5', 0.45], [104, 'G5', 0.9], [112, 'E5', 0.45], [116, 'D5', 0.45], [120, 'C5', 1.6],
];

const BELL_LINE = [
  [0, 'E6', 1.2], [10, 'G6', 1.0], [32, 'C7', 1.2], [44, 'A6', 1.0], [64, 'A6', 1.2], [74, 'E6', 1.0],
  [96, 'D6', 1.2], [108, 'G6', 1.0], [120, 'C7', 1.6],
];

/** One 8-bar phrase for a voice class; `patch` omitted = the historical voice. */
export function phraseScore({ cls, patch, label } = {}) {
  const withPatch = (opts = {}) => ({ ...(patch ? { patch } : {}), ...opts });
  const steps = [];
  if (cls === 'pad') {
    CHORDS.forEach((c, ci) => c.pad.forEach((note, ni) => steps.push({ i: ci * 32 + ni * 2, voice: 'pad', note, dur: 3.2, opts: withPatch() })));
  } else if (cls === 'bass') {
    CHORDS.forEach((c, ci) => {
      for (let bar = 0; bar < 2; bar++) {
        const o = (ci * 2 + bar) * 16;
        steps.push({ i: o, voice: 'bass', note: c.low, dur: 0.4, opts: withPatch() });
        steps.push({ i: o + 6, voice: 'bass', note: c.low, dur: 0.2, opts: withPatch() });
        steps.push({ i: o + 8, voice: 'bass', note: c.low.replace(/\d/, (d) => String(Number(d) + 1)), dur: 0.2, opts: withPatch() });
        steps.push({ i: o + 12, voice: 'bass', note: c.low, dur: 0.4, opts: withPatch() });
      }
    });
  } else if (cls === 'lead') {
    for (const [i, note, dur] of LEAD_LINE) steps.push({ i, voice: 'lead', note, dur, opts: withPatch() });
  } else if (cls === 'pluck') {
    CHORDS.forEach((c, ci) => {
      for (let bar = 0; bar < 2; bar++) {
        for (let s = 0; s < 16; s += 2) {
          steps.push({ i: (ci * 2 + bar) * 16 + s, voice: 'pluck', note: c.tones[(s / 2 + bar) % 4], dur: 0.22, opts: withPatch() });
        }
      }
    });
  } else if (cls === 'bell') {
    for (const [i, note, dur] of BELL_LINE) steps.push({ i, voice: 'bell', note, dur, opts: withPatch() });
  } else {
    throw new Error(`phraseScore: unknown voice class "${cls}"`);
  }
  return base(label ?? `timbre proof phrase, ${cls} patch ${patch ?? 'default'}`, { P: { bpm: TEMPO, len: 128, vol: 0.9, steps } }, [
    { track: 'P', bars: 8, fadeIn: 0 },
  ], { performance: { humanize: { timingMs: [-4, 4], velocity: [-0.05, 0.05] } } });
}
