/**
 * cowrite develop, `arranger` engine (OSS-22): deterministic, no network.
 *
 * Keeps every user note (the keep layer) and builds a full arrangement around it:
 * per-bar chord estimation from the user's pitched notes, a bass from the chord roots,
 * a drum part on the chosen kit, a pad and a counter-line from chord tones, and one of
 * four form templates (loop, subtractive, aba, abac). `--drafts` material becomes the
 * B and C sections; with no drafts, B and C are House Band harmony grown from the key
 * and the user's own opening motif. `lengthBars` adds sections; user material is never
 * time-stretched.
 *
 * Every choice is a pure function of (source, drafts, options). The only randomness is
 * a seeded PRNG, so a seed gives the same score byte for byte.
 */
import { SPEC_LIMITS, validateSpec } from '../spec.mjs';
import { laneVariantNames } from '../timbre.mjs';
import { KIT_VERSION, SCHEMA_VERSION } from '../version.mjs';
import { midiToNoteName, noteTiming, resolveDrumVoice } from './as-written.mjs';
import {
  chordName,
  estimateBarChords,
  estimateKey,
  harmonicRhythmBars,
  layProgression,
  nearestInSet,
  pc,
  placeInOctave,
  progressionCandidates,
  progressionShape,
  scaleOf,
  scaleTonesInRange,
  voiceChord,
} from './harmony.mjs';
import { voiceRange } from './keep-layer.mjs';
import { validateSourceSong } from './source-song.mjs';

export const FORMS = Object.freeze(['loop', 'subtractive', 'aba', 'abac']);
export const ARRANGER_VERSION = 'hb-arranger/1.0.0';
export const DEVELOP_REGISTER = Object.freeze({ name: 'cowrite-develop', briefRef: 'docs/CO-WRITE.md' });

const NUDGE_LIMIT = 50;
const MAX_TRACK_STEPS = SPEC_LIMITS.stepsPerTrack;

export class ArrangerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArrangerError';
  }
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function hashString(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 stream keyed by (seed, name): independent parts never disturb each other. */
export function rngStream(seed, name) {
  let a = (hashString(`${seed}:${name}`) ^ (seed >>> 0)) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x, places = 4) => {
  const k = 10 ** places;
  return Math.round(x * k) / k;
};

// ---------------------------------------------------------------------------
// Palette and mix
// ---------------------------------------------------------------------------

/** Synthesised patch palettes (no sample packs), chosen by seed (Timbre-Variety Law). */
export const PALETTES = Object.freeze([
  Object.freeze({ id: 'glass-and-string', patches: Object.freeze({ pad: 'glass-fm', bass: 'fm-dx-bass', lead: 'breath-flute', pluck: 'karplus-string', bell: 'fm-glass-bell' }) }),
  Object.freeze({ id: 'choir-and-reed', patches: Object.freeze({ pad: 'choir-ah', bass: 'string-bass', lead: 'reed-oboe', pluck: 'kalimba', bell: 'music-box' }) }),
  Object.freeze({ id: 'wash-and-marimba', patches: Object.freeze({ pad: 'breath-wash', bass: 'sub-sine', lead: 'pwm-square', pluck: 'fm-marimba', bell: 'glass-harmonica' }) }),
]);

/** Base levels (opts.vol) per voice. The user's notes and House Band's share one mix. */
const VOL = Object.freeze({
  lead: 0.12,
  pad: 0.05,
  pluck: 0.07,
  bell: 0.06,
  bass: 0.13,
  drone: 0.06,
  chipPulse: 0.06,
  chipTriangle: 0.08,
});
const DRUM_VOL = Object.freeze({
  kick: 0.24,
  snare: 0.16,
  clap: 0.14,
  hat: 0.075,
  rim: 0.1,
  ride: 0.06,
  crash: 0.08,
  perc: 0.08,
  tomLow: 0.14,
  tomMid: 0.13,
  tomHigh: 0.12,
});

const dbToGain = (db) => 10 ** (db / 20);

// ---------------------------------------------------------------------------
// Reading the user's material
// ---------------------------------------------------------------------------

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Stand-in voice per pitched track: the user's melody is the lead (the lead-balance subject). */
export function assignVoices(tracks) {
  const pitched = tracks.filter((t) => t.kind === 'pitched' && t.roleGuess !== 'drums');
  const melody = pitched.find((t) => t.roleGuess === 'melody') ?? null;
  const voices = {};
  for (const t of pitched) {
    if (t.roleGuess === 'melody') voices[t.id] = 'lead';
    else if (t.roleGuess === 'bass') voices[t.id] = 'bass';
    else if (t.roleGuess === 'chords') voices[t.id] = 'pad';
    else if (melody && t.instrumentName === melody.instrumentName) voices[t.id] = 'lead';
    else {
      const meanLen = t.notes.reduce((s, n) => s + n.lengthBeats, 0) / Math.max(1, t.notes.length);
      const med = median(t.notes.map((n) => n.midi)) ?? 60;
      if (meanLen >= 4 && med < 62) voices[t.id] = 'drone';
      else if (meanLen >= 2) voices[t.id] = 'pad';
      else if (med >= 72) voices[t.id] = 'bell';
      else voices[t.id] = 'pluck';
    }
  }
  return voices;
}

/** Bars of user material: long enough that every note's 16th-note step falls inside it. */
function materialBars(song) {
  let steps = Math.ceil(song.lengthBeats * 4 - 1e-9);
  for (const t of song.tracks) for (const n of t.notes) steps = Math.max(steps, Math.round(n.beat * 4) + 1);
  return Math.max(1, Math.ceil(steps / 16));
}

/** Monophonic top line of the given tracks: highest note at each onset. */
function topLine(tracks) {
  const byBeat = new Map();
  for (const t of tracks) {
    for (const n of t.notes) {
      const k = Math.round(n.beat * 1000);
      const cur = byBeat.get(k);
      if (!cur || n.midi > cur.midi) byBeat.set(k, { beat: n.beat, midi: n.midi, lengthBeats: n.lengthBeats });
    }
  }
  return [...byBeat.values()].sort((a, b) => a.beat - b.beat);
}

/** The user's opening motif: up to six top-line notes inside 16 beats of the first onset. */
function extractMotif(song, voices) {
  const pitched = song.tracks.filter((t) => voices[t.id]);
  let pool = pitched.filter((t) => voices[t.id] === 'lead');
  if (pool.length === 0) {
    pool = [...pitched].sort((a, b) => (median(b.notes.map((n) => n.midi)) ?? 0) - (median(a.notes.map((n) => n.midi)) ?? 0)).slice(0, 1);
  }
  const line = topLine(pool);
  if (line.length === 0) return null;
  const first = line[0].beat;
  const notes = line.filter((n) => n.beat < first + 16).slice(0, 6);
  if (notes.length < 2) return null;
  const spanBeats = Math.max(4, Math.ceil((notes.at(-1).beat - first + notes.at(-1).lengthBeats) / 4) * 4);
  return {
    notes: notes.map((n) => ({ rel: n.beat - first, midi: n.midi, lengthBeats: n.lengthBeats })),
    phraseBars: spanBeats <= 4 ? 1 : spanBeats <= 8 ? 2 : 4,
    median: median(notes.map((n) => n.midi)),
  };
}

function preferredVariant(kit, voice, ...names) {
  const variants = laneVariantNames(kit, voice);
  if (!variants) return null;
  const text = names.join(' ').toLowerCase();
  const direct = variants.find((v) => text.includes(v.toLowerCase()));
  if (direct) return direct;
  if (/tamb|shak|marac/.test(text)) return variants.find((v) => /tambourine|shaker|maraca/.test(v)) ?? null;
  return null;
}

/** Analyse one piece of user material (the main song or a draft). */
export function analyseMaterial(song, tempo, label) {
  const voices = assignVoices(song.tracks);
  const pitched = song.tracks.filter((t) => voices[t.id]);
  const drums = song.tracks.filter((t) => t.kind === 'drums' || t.roleGuess === 'drums');
  const bars = materialBars(song);
  const key = estimateKey(pitched);
  const barChords = estimateBarChords(pitched, bars, 4, key);
  const leadNotes = pitched.filter((t) => voices[t.id] === 'lead').flatMap((t) => t.notes.map((n) => n.midi));
  return {
    label,
    song,
    tempo,
    bars,
    voices,
    pitched,
    drums,
    key,
    barChords,
    chords: barChords.map((b) => b.chord),
    rhythmBars: harmonicRhythmBars(barChords.map((b) => b.chord)),
    motif: extractMotif(song, voices),
    hasLead: leadNotes.length > 0,
    leadMedian: median(leadNotes),
    hasBass: pitched.some((t) => voices[t.id] === 'bass'),
    hasChords: pitched.some((t) => voices[t.id] === 'pad' || voices[t.id] === 'drone'),
  };
}

// ---------------------------------------------------------------------------
// The keep layer as steps
// ---------------------------------------------------------------------------

function clampNudge(ms) {
  return Math.min(NUDGE_LIMIT, Math.max(-NUDGE_LIMIT, ms));
}

/**
 * The user's notes as score steps, built once per piece and reused in every section that
 * states it. Returns the pitched steps, the drum steps, and every change made to a note.
 */
export function userLayer(material, { kit }) {
  const { song, tempo, voices, bars } = material;
  const len = bars * 16;
  const stepMs = 60000 / tempo / 4;
  const pitched = [];
  const drums = [];
  const changes = [];
  for (const track of material.pitched) {
    const voice = voices[track.id];
    const [lo, hi] = voiceRange(voice);
    track.notes.forEach((note, noteIndex) => {
      const timing = noteTiming(note.beat, note.offsetMs, tempo);
      let i = timing.i;
      let nudgeMs = timing.nudgeMs;
      if (i >= len) {
        nudgeMs += (i - (len - 1)) * stepMs;
        i = len - 1;
      }
      const nudge = clampNudge(nudgeMs);
      if (nudge !== nudgeMs) {
        changes.push({ kind: 'nudge-clamped', track: track.id, noteIndex, beat: note.beat, fromMs: round(nudgeMs, 3), toMs: round(nudge, 3) });
      }
      let midi = note.midi;
      while (midi < lo) midi += 12;
      while (midi > hi) midi -= 12;
      if (midi !== note.midi) {
        changes.push({ kind: 'octave-fold', track: track.id, noteIndex, beat: note.beat, from: midiToNoteName(note.midi), to: midiToNoteName(midi), voice, reason: `outside the ${voice} range ${midiToNoteName(lo)}-${midiToNoteName(hi)}` });
      }
      let dur = (note.lengthBeats * 60) / tempo;
      if (dur > SPEC_LIMITS.eventDuration) {
        changes.push({ kind: 'duration-capped', track: track.id, noteIndex, beat: note.beat, fromSeconds: round(dur, 3), toSeconds: SPEC_LIMITS.eventDuration });
        dur = SPEC_LIMITS.eventDuration;
      }
      if (dur < 0.001) dur = 0.001;
      const opts = { vol: round((VOL[voice] ?? 0.08) * (0.55 + 0.45 * note.velocity)) };
      // Performance differentiation on the lead: release length follows phrase position.
      if (voice === 'lead') opts.r = round(0.16 + 0.03 * ((noteIndex * 7 + track.id.length * 3) % 5), 3);
      const step = { i, voice, note: midiToNoteName(midi), dur: round(dur, 4), opts, origin: 'user' };
      if (Math.abs(nudge) > 1e-9) step.nudge = round(nudge, 3);
      pitched.push(step);
    });
  }
  for (const track of material.drums) {
    track.notes.forEach((note) => {
      const timing = noteTiming(note.beat, note.offsetMs, tempo);
      let i = timing.i;
      let nudgeMs = timing.nudgeMs;
      if (i >= len) {
        nudgeMs += (i - (len - 1)) * stepMs;
        i = len - 1;
      }
      const nudge = clampNudge(nudgeMs);
      const { voice } = resolveDrumVoice(track, note, song);
      const opts = { vol: round((DRUM_VOL[voice] ?? 0.1) * (0.55 + 0.45 * note.velocity)) };
      const variant = preferredVariant(kit, voice, track.instrumentName, track.name);
      if (variant) opts.variant = variant;
      const step = { i, voice, opts, origin: 'user' };
      if (Math.abs(nudge) > 1e-9) step.nudge = round(nudge, 3);
      drums.push(step);
    });
  }
  return { pitched, drums, changes, drumLanes: new Set(drums.map((s) => s.voice)) };
}

// ---------------------------------------------------------------------------
// House Band parts
// ---------------------------------------------------------------------------

function hb(step) {
  return { ...step, origin: 'house-band' };
}

/** Runs of identical consecutive chords, capped at `maxBars` per run. */
function chordRuns(chords, maxBars) {
  const runs = [];
  for (let bar = 0; bar < chords.length; bar++) {
    const last = runs.at(-1);
    if (last && last.chord.name === chords[bar].name && last.bars < maxBars) last.bars += 1;
    else runs.push({ bar, bars: 1, chord: chords[bar] });
  }
  return runs;
}

/** Bass from per-bar chord roots. mode: off | pedal | pulse | sub. */
function bassPart(chords, mode, ctx, rng) {
  if (mode === 'off') return [];
  const steps = [];
  const barSec = 240 / ctx.tempo;
  const base = VOL.bass;
  if (mode === 'pedal') {
    for (const run of chordRuns(chords, 2)) {
      const root = placeInOctave(run.chord.root, 36);
      steps.push(hb({ i: run.bar * 16, voice: 'bass', note: midiToNoteName(root), dur: round(run.bars * barSec * 0.96), opts: { vol: round(base * (0.85 + 0.1 * rng())) } }));
    }
    return steps;
  }
  if (mode === 'sub') {
    for (const run of chordRuns(chords, 1)) {
      const root = placeInOctave(run.chord.root, 28);
      steps.push(hb({ i: run.bar * 16, voice: 'bass', note: midiToNoteName(root), dur: round(barSec * 0.9), opts: { vol: round(base * (0.62 + 0.08 * rng())) } }));
    }
    return steps;
  }
  // pulse: root on the downbeat, a pickup, the fifth, and an approach into the next root.
  const beat = 60 / ctx.tempo;
  for (let bar = 0; bar < chords.length; bar++) {
    const c = chords[bar];
    const next = chords[bar + 1] ?? chords[0];
    const root = placeInOctave(c.root, 36);
    const fifth = c.pcs.includes((c.root + 7) % 12) ? root + 7 : root + (c.pcs.includes((c.root + 6) % 12) ? 6 : 7);
    const o = bar * 16;
    steps.push(hb({ i: o, voice: 'bass', note: midiToNoteName(root), dur: round(beat * 1.4), opts: { vol: round(base * (0.95 + 0.05 * rng())) } }));
    if (rng() < 0.5) steps.push(hb({ i: o + 6, voice: 'bass', note: midiToNoteName(root), dur: round(beat * 0.4), opts: { vol: round(base * (0.7 + 0.08 * rng())) } }));
    steps.push(hb({ i: o + 8, voice: 'bass', note: midiToNoteName(fifth <= 52 ? fifth : fifth - 12), dur: round(beat * 1.2), opts: { vol: round(base * (0.8 + 0.08 * rng())) } }));
    const nextRoot = placeInOctave(next.root, 36);
    if (next.root !== c.root) {
      const approach = nextRoot + (rng() < 0.5 ? -1 : (scaleOf(ctx.key).includes(pc(nextRoot + 2)) ? 2 : 1));
      steps.push(hb({ i: o + 14, voice: 'bass', note: midiToNoteName(approach), dur: round(beat * 0.45), opts: { vol: round(base * (0.7 + 0.08 * rng())) } }));
    } else if (rng() < 0.6) {
      steps.push(hb({ i: o + 14, voice: 'bass', note: midiToNoteName(root + 12 <= 55 ? root + 12 : root), dur: round(beat * 0.4), opts: { vol: round(base * (0.66 + 0.08 * rng())) } }));
    }
  }
  return steps;
}

/** Pad from chord tones. level 1: high dyads every two bars; level 2: full voicings per change. */
function padPart(chords, level, ctx, rng) {
  if (level <= 0) return [];
  const steps = [];
  const barSec = 240 / ctx.tempo;
  const [lo, hi] = ctx.padRange;
  let previous = null;
  for (const run of chordRuns(chords, 2)) {
    const count = level >= 2 ? (ctx.hasChords ? 3 : 4) : 2;
    let voicing = voiceChord(run.chord, previous, lo, hi, count);
    if (level === 1 && voicing.length > 2) voicing = voicing.slice(-2);
    previous = voicing;
    const vol = VOL.pad * (level >= 2 ? 1 : 0.85) * (0.92 + 0.08 * rng());
    for (const m of voicing) {
      steps.push(hb({ i: run.bar * 16, voice: 'pad', note: midiToNoteName(m), dur: round(run.bars * barSec * 0.97), opts: { vol: round(vol) } }));
    }
  }
  return steps;
}

const COUNTER_RHYTHMS = Object.freeze({
  1: Object.freeze([[4, 10], [6, 12], [2, 8, 14], [8, 14]]),
  2: Object.freeze([[0, 6, 10, 12], [2, 4, 8, 14], [4, 6, 8, 12, 14], [2, 6, 10, 14]]),
});

/** Counter-line from chord tones, placed where the melody rests. */
function counterPart(chords, level, ctx, rng, melodySteps, voice) {
  if (level <= 0) return [];
  const steps = [];
  const beat = 60 / ctx.tempo;
  const [lo, hi] = ctx.counterRange;
  const busy = new Set();
  for (const s of melodySteps) {
    busy.add(s.i);
    busy.add(s.i + 1);
  }
  let prev = Math.round((lo + hi) / 2);
  const rhythms = COUNTER_RHYTHMS[Math.min(2, level)];
  for (let bar = 0; bar < chords.length; bar++) {
    const c = chords[bar];
    const o = bar * 16;
    // Pick the rhythm that collides least with the melody; ties broken by the seed.
    const scored = rhythms.map((r, idx) => ({ r, idx, cost: r.filter((x) => busy.has(o + x)).length + rng() * 0.5 }));
    scored.sort((a, b) => a.cost - b.cost || a.idx - b.idx);
    const rhythm = scored[0].r.filter((x) => !busy.has(o + x) || scored[0].r.length <= 2);
    if (rhythm.length === 0) continue;
    for (let k = 0; k < rhythm.length; k++) {
      const at = rhythm[k];
      const nextAt = rhythm[k + 1] ?? 16;
      let target = nearestInSet(prev + (rng() < 0.5 ? -2 : 2), c.pcs, lo, hi, prev);
      // An occasional passing tone between chord tones on a weak eighth.
      if (k > 0 && at % 4 !== 0 && rng() < 0.3) {
        const scale = scaleTonesInRange(ctx.key, lo, hi);
        const between = scale.filter((m) => m !== prev && Math.abs(m - prev) <= 2);
        if (between.length) target = between[Math.floor(rng() * between.length)];
      }
      if (target === null) continue;
      prev = target;
      const lengthSteps = Math.max(1, Math.min(16, nextAt - at));
      steps.push(hb({
        i: o + at,
        voice,
        note: midiToNoteName(target),
        dur: round(lengthSteps * beat * 0.25 * 0.92),
        opts: { vol: round((voice === 'lead' ? VOL.lead : VOL.pluck) * (k === 0 ? 1 : 0.86) * (0.9 + 0.1 * rng())) },
      }));
    }
  }
  return steps;
}

/**
 * Drums on the chosen kit. level 0 none; 1 light (hats or shaker); 2 groove (kick, backbeat,
 * eighth hats); 3 full (adds phrase-end fills, sixteenth hats and a crash on the downbeat).
 * Lanes the user's own drums already play are left to the user.
 */
function drumPart(bars, level, ctx, rng, { crash = false } = {}) {
  if (level <= 0) return [];
  const steps = [];
  const user = ctx.userDrumLanes;
  const lane = (name) => {
    if (!user.has(name)) return name;
    if (name === 'hat') return user.has('ride') ? null : 'ride';
    if (name === 'snare') return user.has('clap') ? (user.has('rim') ? null : 'rim') : 'clap';
    return null;
  };
  const hit = (i, voice, vol, extra = {}) => {
    const v = lane(voice);
    if (!v) return;
    const opts = { vol: round((DRUM_VOL[v] ?? 0.1) * vol), ...extra };
    steps.push(hb({ i, voice: v, opts }));
  };
  const shaker = preferredVariant(ctx.kit, 'perc', 'shaker maraca');
  for (let bar = 0; bar < bars; bar++) {
    const o = bar * 16;
    const phraseEnd = bar % 4 === 3;
    const lastBar = bar === bars - 1;
    if (level === 1) {
      for (const x of [2, 6, 10, 14]) hit(o + x, 'hat', 0.8 + 0.2 * rng());
      if (shaker && bar % 2 === 1) hit(o + 12, 'perc', 0.6 + 0.2 * rng(), { variant: shaker });
      continue;
    }
    // level >= 2
    hit(o, 'kick', 0.95 + 0.05 * rng());
    hit(o + 8, 'kick', 0.85 + 0.08 * rng());
    if (bar % 2 === 1 && rng() < 0.7) hit(o + 10, 'kick', 0.6 + 0.1 * rng());
    hit(o + 4, 'snare', 0.9 + 0.1 * rng());
    if (!(level >= 3 && lastBar)) hit(o + 12, 'snare', 0.92 + 0.08 * rng());
    const sixteenths = level >= 3 && phraseEnd;
    for (let x = 0; x < 16; x += sixteenths ? 1 : 2) {
      const accent = x % 4 === 0 ? 1 : x % 4 === 2 ? 0.72 : 0.5;
      hit(o + x, 'hat', accent * (0.85 + 0.15 * rng()));
    }
    if (level >= 3 && lastBar) {
      // fill into the next section
      const toms = [['tomHigh', 8], ['tomMid', 10], ['tomLow', 12], ['snare', 14], ['snare', 15]];
      for (const [voice, x] of toms) hit(o + x, voice, 0.75 + 0.2 * (x / 15) + 0.05 * rng());
    }
  }
  if (crash && level >= 2) hit(0, 'crash', 0.9);
  return steps;
}

/** Scale-degree index (octave * 7 + degree) of the nearest scale tone at or below `midi`. */
function degreeOf(midi, scale) {
  for (let d = 0; d < 12; d++) {
    const m = midi - d;
    const idx = scale.indexOf(pc(m));
    if (idx >= 0) {
      const tonicMidi = m - ((pc(m) - scale[0] + 12) % 12);
      return Math.round((tonicMidi - scale[0]) / 12) * 7 + idx;
    }
  }
  return 0;
}

function midiOfDegree(deg, scale) {
  const oct = Math.floor(deg / 7);
  const idx = ((deg % 7) + 7) % 7;
  const tonicPc = scale[0];
  const offset = (scale[idx] - tonicPc + 12) % 12;
  return oct * 12 + tonicPc + offset;
}

/**
 * A melodic line grown from the user's motif: the motif's scale-step contour and rhythm,
 * realised on new chords (call, then an inverted answer), strong beats snapped to chord
 * tones, the last note held to land on the chord.
 */
function motifLine(motif, chords, ctx, rng, { voice, register, vol, fragment = null, everyOtherPhrase = false }) {
  if (!motif) return [];
  const scale = scaleOf(ctx.key);
  const notes = fragment ? motif.notes.slice(0, fragment) : motif.notes;
  const degs = notes.map((n) => degreeOf(n.midi, scale));
  const contour = degs.map((d) => d - degs[0]);
  const phraseBars = Math.min(motif.phraseBars, chords.length);
  const beat = 60 / ctx.tempo;
  const [lo, hi] = register;
  const steps = [];
  let phrase = 0;
  for (let start = 0; start + phraseBars <= chords.length; start += phraseBars, phrase++) {
    if (everyOtherPhrase && phrase % 2 === 1) continue;
    const answer = phrase % 2 === 1;
    const chord0 = chords[start];
    const target = (lo + hi) / 2;
    const startMidi = nearestInSet(Math.round(target), chord0.pcs, lo, hi) ?? Math.round(target);
    const startDeg = degreeOf(startMidi, scale);
    const lastPhrase = start + 2 * phraseBars > chords.length;
    let line = notes.map((n, k) => {
      const deg = startDeg + (answer ? -contour[k] : contour[k]);
      let midi = midiOfDegree(deg, scale);
      const at = start * 16 + Math.round(n.rel * 4);
      const bar = Math.min(chords.length - 1, Math.floor(at / 16));
      const inBar = at % 16;
      if (inBar === 0 || inBar === 8) {
        const snapped = nearestInSet(midi, chords[bar].pcs, midi - 2, midi + 2);
        if (snapped !== null) midi = snapped;
      }
      return { at, midi, bar };
    }).filter((n) => n.at < (start + phraseBars) * 16);
    if (line.length === 0) continue;
    // Keep the phrase in register by whole octaves.
    const mean = line.reduce((s, n) => s + n.midi, 0) / line.length;
    const shift = mean > hi ? -12 * Math.ceil((mean - hi) / 12) : mean < lo ? 12 * Math.ceil((lo - mean) / 12) : 0;
    line = line.map((n) => ({ ...n, midi: n.midi + shift }));
    if (lastPhrase) {
      const last = line.at(-1);
      const landed = nearestInSet(last.midi, [chords[last.bar].root, chords[last.bar].pcs[1]], last.midi - 5, last.midi + 5);
      if (landed !== null) last.midi = landed;
    }
    line.forEach((n, k) => {
      const nextAt = line[k + 1]?.at ?? (start + phraseBars) * 16;
      const lengthSteps = Math.max(1, nextAt - n.at);
      const held = k === line.length - 1;
      steps.push(hb({
        i: n.at,
        voice,
        note: midiToNoteName(n.midi),
        dur: round(Math.min(lengthSteps, 32) * beat * 0.25 * (held ? 0.9 : 0.85)),
        opts: { vol: round(vol * (k === 0 ? 1 : 0.88 + 0.08 * rng())), ...(voice === 'lead' ? { r: round(held ? 0.32 : 0.16 + 0.04 * (k % 3), 3) } : {}) },
      }));
    });
  }
  return steps;
}

/** Tonic drone, re-struck every two bars (the breathing-space floor). */
function dronePart(bars, ctx, rng) {
  const steps = [];
  const barSec = 240 / ctx.tempo;
  const tonic = placeInOctave(ctx.key.tonic, 38);
  for (let bar = 0; bar < bars; bar += 2) {
    const len = Math.min(2, bars - bar);
    steps.push(hb({ i: bar * 16, voice: 'drone', note: midiToNoteName(tonic), dur: round(len * barSec * 0.98), opts: { vol: round(VOL.drone * (0.85 + 0.1 * rng())) } }));
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/** Per-pass plans for user-material sections. */
const USER_PLANS = Object.freeze({
  intro: Object.freeze({ name: 'intro', userDrums: true, drums: 1, bass: 'light', pad: 1, counter: 0 }),
  body: Object.freeze({ name: 'body', userDrums: true, drums: 2, bass: 'full', pad: 2, counter: 1 }),
  drop: Object.freeze({ name: 'drop', userDrums: false, drums: 0, bass: 'drop', pad: 2, counter: 2 }),
  full: Object.freeze({ name: 'full', userDrums: true, drums: 3, bass: 'full', pad: 2, counter: 1, crash: true }),
  groove: Object.freeze({ name: 'groove', userDrums: true, drums: 2, bass: 'full', pad: 1, counter: 0 }),
});

/** The section list for a form, before extension. */
function formTemplate(form, draftCount) {
  const U = (plan) => ({ kind: 'user', plan });
  const D = (index) => ({ kind: 'draft', draft: index });
  const N = (letter) => ({ kind: 'house-band', letter });
  switch (form) {
    case 'loop':
      return draftCount >= 2
        ? [U('groove'), D(0), U('full'), D(1), U('full')]
        : draftCount === 1 ? [U('groove'), D(0), U('full')] : [U('groove'), U('full')];
    case 'subtractive':
      return draftCount >= 2
        ? [U('intro'), U('body'), D(0), U('drop'), D(1), U('full')]
        : draftCount === 1 ? [U('intro'), U('body'), D(0), U('drop'), U('full')] : [U('intro'), U('body'), U('drop'), U('full')];
    case 'aba':
      return [U('body'), draftCount >= 1 ? D(0) : N('B'), U('full')];
    case 'abac':
      return [U('body'), draftCount >= 1 ? D(0) : N('B'), U('full'), draftCount >= 2 ? D(1) : N('C')];
    default:
      throw new ArrangerError(`unknown form "${form}" (have ${FORMS.join(', ')})`);
  }
}

/** Sections appended to reach `lengthBars`, cycling per form. */
function extensionEntry(form, k, unusedDrafts) {
  if (unusedDrafts.length > 0 && k % 2 === 0) return { kind: 'draft', draft: unusedDrafts.shift() };
  if (form === 'loop') return { kind: 'user', plan: ['body', 'drop', 'full'][k % 3] };
  if (k % 2 === 1) return { kind: 'user', plan: 'full' };
  return { kind: 'house-band', letter: (k / 2) % 2 === 0 ? 'C' : 'B' };
}

function sectionRecordsTrim(trims, count) {
  return Array.from({ length: count }, (_, k) => round(trims[k] ?? 0, 2));
}

function newSectionBars(mainBars) {
  return Math.min(16, Math.max(4, Math.round(mainBars / 4) * 4));
}

// ---------------------------------------------------------------------------
// The arranger
// ---------------------------------------------------------------------------

/**
 * Develop a source-song with the arranger engine.
 * @param {object} sourceInput house-band-source-song
 * @param {{ form?: string, drafts?: object[], lengthBars?: number|null, kit?: string, seed?: number,
 *   brief?: string|null, progressionVariant?: number, leadTrimDb?: number, sectionLeadTrimDb?: number[] }} [options]
 * @returns {{ spec: object, record: object }}
 */
export function arrange(sourceInput, options = {}) {
  const source = validateSourceSong(JSON.parse(JSON.stringify(sourceInput)));
  const drafts = (options.drafts ?? []).map((d) => validateSourceSong(JSON.parse(JSON.stringify(d))));
  const form = options.form ?? 'subtractive';
  if (!FORMS.includes(form)) throw new ArrangerError(`unknown form "${form}" (have ${FORMS.join(', ')})`);
  const kit = options.kit ?? 'tr808';
  const seed = options.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new ArrangerError('seed must be an unsigned 32-bit integer');
  const lengthBars = options.lengthBars ?? null;
  const variant = options.progressionVariant ?? 0;
  const leadTrimDb = options.leadTrimDb ?? 0;
  const sectionLeadTrimDb = options.sectionLeadTrimDb ?? [];

  const notes = [];
  const tempo = source.tempoMap[0].bpm;
  if (source.tempoMap.length > 1) notes.push(`tempo map flattened to ${tempo} BPM (${source.tempoMap.length - 1} changes ignored)`);
  const [num, den] = source.timeSignature;
  if (num !== 4 || den !== 4) notes.push(`time signature ${num}/${den} laid on 16-step bars`);

  const main = analyseMaterial(source, tempo, 'A');
  if (main.pitched.every((t) => t.notes.length === 0)) throw new ArrangerError('the source has no pitched notes to develop');
  if (main.bars * 16 > SPEC_LIMITS.trackLength) throw new ArrangerError(`the source is ${main.bars} bars; one section holds at most ${SPEC_LIMITS.trackLength / 16}`);
  const draftMaterial = drafts.map((d, k) => {
    const m = analyseMaterial(d, tempo, k === 0 ? 'B' : 'C');
    if (m.bars * 16 > SPEC_LIMITS.trackLength) throw new ArrangerError(`draft ${k + 1} is ${m.bars} bars; one section holds at most ${SPEC_LIMITS.trackLength / 16}`);
    return m;
  });
  drafts.forEach((d, k) => {
    if (d.tempoMap[0].bpm !== tempo) notes.push(`draft ${k + 1} (${d.title}) plays at the main tempo ${tempo} BPM, not its own ${d.tempoMap[0].bpm}`);
  });

  const palette = PALETTES[(seed + PALETTES.length - 1) % PALETTES.length];
  const mainLayer = userLayer(main, { kit });
  const draftLayers = draftMaterial.map((m) => userLayer(m, { kit }));

  // The section list.
  const entries = formTemplate(form, drafts.length);
  const usedDrafts = new Set(entries.filter((e) => e.kind === 'draft').map((e) => e.draft));
  const unusedDrafts = draftMaterial.map((_, k) => k).filter((k) => !usedDrafts.has(k));
  const entryBars = (e) => (e.kind === 'user' ? main.bars : e.kind === 'draft' ? draftMaterial[e.draft].bars : newSectionBars(main.bars));
  const baseBars = entries.reduce((s, e) => s + entryBars(e), 0);
  const added = [];
  if (lengthBars !== null) {
    let total = baseBars;
    for (let k = 0; total < lengthBars && entries.length < 60; k++) {
      const e = extensionEntry(form, k, unusedDrafts);
      entries.push(e);
      added.push(e);
      total += entryBars(e);
    }
  }
  for (const k of unusedDrafts) notes.push(`draft ${k + 1} (${draftMaterial[k].song.title}) is not used by form ${form}${lengthBars ? ' at this length' : ''}`);

  // House Band harmony for new sections: avoid the user's own progression shape.
  const userShape = progressionShape(chordRuns(main.chords, 64).map((r) => r.chord));
  const pickProgression = (letter, occurrence) => {
    const candidates = progressionCandidates(main.key, letter);
    for (let k = 0; k < candidates.length; k++) {
      const chosen = candidates[(variant + occurrence + k) % candidates.length];
      if (progressionShape(chosen) !== userShape) return chosen;
    }
    return candidates[(variant + occurrence) % candidates.length];
  };

  const baseCtx = {
    tempo,
    kit,
    key: main.key,
    userDrumLanes: new Set(),
    hasChords: false,
    padRange: [52, 76],
    counterRange: [55, 74],
  };
  const leadMedian = main.leadMedian ?? 76;
  const counterHi = Math.min(74, Math.round(leadMedian) - 5);
  const counterRange = [Math.max(43, counterHi - 19), Math.max(55, counterHi)];

  const tracks = {};
  const sections = [];
  const sectionRecords = [];
  const counts = {};
  let startBar = 0;
  let previousLevel = null;
  const letterCount = { B: 0, C: 0 };
  const changeSections = new Map();
  const draftSections = draftMaterial.map(() => []);
  const userSections = [];
  const seenMaterial = new Set();

  entries.forEach((entry, index) => {
    let steps = [];
    let bars;
    let material;
    let parts;
    let chords;
    let statesUser = false;
    const rng = (part) => rngStream(seed, `${index}:${part}`);
    if (entry.kind === 'user' || entry.kind === 'draft') {
      const m = entry.kind === 'user' ? main : draftMaterial[entry.draft];
      const layer = entry.kind === 'user' ? mainLayer : draftLayers[entry.draft];
      const plan = entry.kind === 'user' ? USER_PLANS[entry.plan] : USER_PLANS.body;
      material = entry.kind === 'user' ? 'A' : (entry.draft === 0 ? 'B' : 'C');
      bars = m.bars;
      chords = m.chords;
      const ctx = {
        ...baseCtx,
        key: m.key,
        userDrumLanes: layer.drumLanes,
        hasChords: m.hasChords,
        padRange: m.hasChords ? [64, 84] : [52, 76],
        counterRange: m.hasLead ? counterRange : [55, 76],
      };
      const lead = layer.pitched.filter((s) => s.voice === 'lead');
      steps.push(...layer.pitched);
      if (plan.userDrums) steps.push(...layer.drums);
      let bassMode;
      if (m.hasBass) bassMode = plan.bass === 'full' ? 'sub' : 'off';
      else bassMode = plan.bass === 'full' ? 'pulse' : 'pedal';
      steps.push(...bassPart(chords, bassMode, ctx, rng('bass')));
      steps.push(...padPart(chords, plan.pad, ctx, rng('pad')));
      steps.push(...counterPart(chords, plan.counter, ctx, rng('counter'), lead, m.hasLead ? 'pluck' : 'lead'));
      steps.push(...drumPart(bars, plan.drums, ctx, rng('drums'), { crash: Boolean(plan.crash) && previousLevel !== null }));
      parts = {
        user: layer.pitched.length,
        userDrums: plan.userDrums ? layer.drums.length : 0,
        houseBand: { drums: plan.drums, bass: bassMode, pad: plan.pad, counter: plan.counter },
        plan: plan.name,
      };
      statesUser = true;
      if (entry.kind === 'user') userSections.push(index);
      else draftSections[entry.draft].push(index);
      if (!plan.userDrums && layer.drums.length > 0) {
        for (const t of m.drums) {
          const key = `drum-rest:${m.label}:${t.id}`;
          if (!changeSections.has(key)) changeSections.set(key, { kind: 'drum-rest', material: m.label, track: t.id, sections: [] });
          changeSections.get(key).sections.push(index);
        }
      }
      previousLevel = plan.drums;
    } else {
      const letter = entry.letter;
      const occurrence = letterCount[letter]++;
      material = letter;
      bars = newSectionBars(main.bars);
      const progression = pickProgression(letter, occurrence);
      chords = layProgression(progression, bars, main.rhythmBars);
      const ctx = { ...baseCtx, hasChords: false, padRange: [52, 76], counterRange: [55, 74] };
      const leadRegister = [Math.max(60, Math.round(leadMedian) - 9), Math.min(88, Math.max(72, Math.round(leadMedian) + 5))];
      if (letter === 'B') {
        const tune = motifLine(main.motif, chords, ctx, rng('tune'), { voice: 'lead', register: leadRegister, vol: VOL.lead * 0.92 });
        steps.push(...tune);
        steps.push(...bassPart(chords, 'pulse', ctx, rng('bass')));
        steps.push(...padPart(chords, 2, ctx, rng('pad')));
        steps.push(...counterPart(chords, 1, ctx, rng('counter'), tune, 'pluck'));
        steps.push(...drumPart(bars, 2, ctx, rng('drums'), { crash: true }));
        parts = { user: 0, houseBand: { tune: tune.length, drums: 2, bass: 'pulse', pad: 2, counter: 1 }, plan: 'new-harmony' };
        previousLevel = 2;
      } else {
        const bells = motifLine(main.motif, chords, ctx, rng('bells'), { voice: 'bell', register: [67, 86], vol: VOL.bell, fragment: 3, everyOtherPhrase: true });
        steps.push(...bells);
        steps.push(...dronePart(bars, ctx, rng('drone')));
        steps.push(...padPart(chords, 1, ctx, rng('pad')));
        steps.push(...counterPart(chords, 1, ctx, rng('counter'), bells, main.hasLead ? 'pluck' : 'lead'));
        parts = { user: 0, houseBand: { bells: bells.length, drone: true, pad: 1, counter: 1, drums: 0 }, plan: 'breathing-space' };
        previousLevel = 0;
      }
    }
    // The mix: the lead (the user's melody, or House Band's tune) at its measured level for this section.
    const sectionTrim = leadTrimDb + (sectionLeadTrimDb[index] ?? 0);
    if (sectionTrim !== 0) {
      const g = dbToGain(sectionTrim);
      steps = steps.map((st) => (st.voice === 'lead' ? { ...st, opts: { ...st.opts, vol: round(Math.min(4, st.opts.vol * g)) } } : st));
    }
    counts[material] = (counts[material] ?? 0) + 1;
    const trackName = `${material}${counts[material]}`;
    steps.sort((a, b) => a.i - b.i || (a.origin === b.origin ? 0 : a.origin === 'user' ? -1 : 1));
    if (steps.length > MAX_TRACK_STEPS) throw new ArrangerError(`section ${trackName} has ${steps.length} steps; the score format allows ${MAX_TRACK_STEPS}`);
    tracks[trackName] = { bpm: tempo, len: bars * 16, vol: 0.8, steps };
    const harmonicClaim = seenMaterial.has(material) ? 'reuse' : 'new';
    seenMaterial.add(material);
    sections.push({ track: trackName, bars, harmonicClaim });
    sectionRecords.push({
      index,
      track: trackName,
      material,
      kind: entry.kind,
      ...(entry.kind === 'draft' ? { draft: entry.draft + 1 } : {}),
      startBar,
      bars,
      startSeconds: round((startBar * 240) / tempo, 3),
      harmonicClaim,
      statesUserMaterial: statesUser,
      chords: chordRuns(chords, 64).map((r) => ({ bar: r.bar, bars: r.bars, chord: chordName(r.chord) })),
      parts,
    });
    startBar += bars;
  });

  if (Object.keys(tracks).length > SPEC_LIMITS.tracks) throw new ArrangerError(`the arrangement needs ${Object.keys(tracks).length} sections; the score format allows ${SPEC_LIMITS.tracks}`);

  const raw = {
    schemaVersion: SCHEMA_VERSION,
    kitVersion: { semver: KIT_VERSION.semver, sha: KIT_VERSION.sha },
    seed,
    tempo,
    sampleRate: 44100,
    gain: 0.5,
    label: `Developed: ${source.title}`.slice(0, 500),
    register: { ...DEVELOP_REGISTER },
    kit,
    patches: { ...palette.patches },
    performance: {
      humanize: { timingMs: [-5, 5], velocity: [-0.05, 0.05] },
      releaseTail: 0.4,
      voices: {
        pad: { releaseTail: 1.2 },
        drone: { releaseTail: 1.5 },
        lead: { humanize: { timingMs: [-3, 3], velocity: [-0.03, 0.03] } },
      },
    },
    tracks,
    sections,
  };
  const spec = validateSpec(raw);

  // Changes to user notes: per-note changes from each layer, with the sections they apply to.
  const changes = [];
  for (const c of mainLayer.changes) changes.push({ ...c, material: 'A', sections: [...userSections] });
  draftLayers.forEach((layer, k) => {
    for (const c of layer.changes) changes.push({ ...c, material: k === 0 ? 'B' : 'C', draft: k + 1, sections: [...draftSections[k]] });
  });
  changes.push(...changeSections.values());

  const record = {
    engine: 'arranger',
    engineVersion: ARRANGER_VERSION,
    form,
    seed,
    kit,
    palette: palette.id,
    tempo,
    key: main.key.name,
    keyConfidence: main.key.confidence,
    material: {
      A: {
        title: source.title,
        bars: main.bars,
        chords: main.barChords.map((b) => ({ bar: b.bar, chord: chordName(b.chord), estimated: b.estimated })),
        voices: main.voices,
        motif: main.motif ? main.motif.notes.map((n) => midiToNoteName(n.midi)) : [],
      },
      ...Object.fromEntries(draftMaterial.map((m, k) => [k === 0 ? 'B' : 'C', {
        title: m.song.title,
        draft: k + 1,
        bars: m.bars,
        key: m.key.name,
        chords: m.barChords.map((b) => ({ bar: b.bar, chord: chordName(b.chord), estimated: b.estimated })),
        voices: m.voices,
      }])),
    },
    sections: sectionRecords,
    userSections,
    draftSections: draftSections.map((s, k) => ({ draft: k + 1, sections: s })),
    length: { requestedBars: lengthBars, formBars: baseBars, totalBars: startBar, added: added.length },
    changes,
    performance: {
      posture: 'deterministic humanize from the score seed on every voice (timing +-5 ms, lead +-3 ms; gain +-5 %, lead +-3 %); pad and drone release tails 1.2 s and 1.5 s; lead release length varies with phrase position',
      leadTrimDb: round(leadTrimDb, 2),
      sectionLeadTrimDb: sectionRecordsTrim(sectionLeadTrimDb, entries.length),
    },
    progressionVariant: variant,
    brief: options.brief ?? null,
    briefUse: options.brief ? 'recorded only: the arranger engine does not read the brief (the llm engine does)' : null,
    notes,
  };
  return { spec, record };
}

