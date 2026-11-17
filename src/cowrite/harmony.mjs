/**
 * Harmony helpers for cowrite develop (OSS-22): key and per-bar chord estimation from a
 * user's pitched notes, House Band progressions for new sections, and voice leading.
 * Pure functions, no randomness: every choice is a deterministic function of the input.
 */

export const PC_NAMES = Object.freeze(['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);

const MAJOR_SCALE = Object.freeze([0, 2, 4, 5, 7, 9, 11]);
const MINOR_SCALE = Object.freeze([0, 2, 3, 5, 7, 8, 10]); // natural minor

// Krumhansl-Kessler key profiles.
const KK_MAJOR = Object.freeze([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]);
const KK_MINOR = Object.freeze([6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]);

/** Chord templates, simplest first (ties go to the simpler chord). */
export const CHORD_TYPES = Object.freeze([
  Object.freeze({ type: '', intervals: Object.freeze([0, 4, 7]), penalty: 0 }),
  Object.freeze({ type: 'm', intervals: Object.freeze([0, 3, 7]), penalty: 0 }),
  Object.freeze({ type: '7', intervals: Object.freeze([0, 4, 7, 10]), penalty: 0.05 }),
  Object.freeze({ type: 'maj7', intervals: Object.freeze([0, 4, 7, 11]), penalty: 0.05 }),
  Object.freeze({ type: 'm7', intervals: Object.freeze([0, 3, 7, 10]), penalty: 0.05 }),
  Object.freeze({ type: 'sus4', intervals: Object.freeze([0, 5, 7]), penalty: 0.06 }),
  Object.freeze({ type: 'sus2', intervals: Object.freeze([0, 2, 7]), penalty: 0.07 }),
  Object.freeze({ type: 'dim', intervals: Object.freeze([0, 3, 6]), penalty: 0.08 }),
  Object.freeze({ type: '5', intervals: Object.freeze([0, 7]), penalty: 0.12 }),
]);
const TYPE_INTERVALS = Object.freeze(Object.fromEntries(CHORD_TYPES.map((c) => [c.type, c.intervals])));

const ROLE_WEIGHT = Object.freeze({ bass: 1.3, chords: 1.2, other: 1.0, melody: 0.8 });

export const pc = (midi) => ((Math.round(midi) % 12) + 12) % 12;

export function scaleOf(key) {
  return (key.mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE).map((s) => (s + key.tonic) % 12);
}

export function chordName(chord) {
  return `${PC_NAMES[chord.root]}${chord.type}`;
}

export function makeChord(root, type) {
  const intervals = TYPE_INTERVALS[type];
  if (!intervals) throw new Error(`unknown chord type ${type}`);
  const r = pc(root);
  return Object.freeze({
    root: r,
    type,
    name: `${PC_NAMES[r]}${type}`,
    pcs: Object.freeze(intervals.map((i) => (r + i) % 12)),
  });
}

/**
 * Pitch-class weights of the notes sounding inside [startBeat, endBeat).
 * @param {{ notes: object[], roleGuess?: string }[]} tracks pitched tracks
 */
export function pitchClassWeights(tracks, startBeat, endBeat) {
  const w = Array(12).fill(0);
  let lowest = null;
  let lowestKey = Infinity;
  for (const track of tracks) {
    const roleW = ROLE_WEIGHT[track.roleGuess] ?? 1;
    for (const n of track.notes) {
      const a = Math.max(startBeat, n.beat);
      const b = Math.min(endBeat, n.beat + n.lengthBeats);
      if (b - a <= 1e-9) continue;
      w[pc(n.midi)] += (b - a) * (0.5 + 0.5 * n.velocity) * roleW;
      // The bass note: the lowest pitch sounding in the first half of the span.
      if (n.beat < startBeat + (endBeat - startBeat) / 2) {
        const keyed = n.midi * 1000 + Math.max(0, n.beat - startBeat);
        if (keyed < lowestKey) {
          lowestKey = keyed;
          lowest = n.midi;
        }
      }
    }
  }
  return { weights: w, bassPc: lowest === null ? null : pc(lowest), total: w.reduce((s, v) => s + v, 0) };
}

/** Krumhansl-Schmuckler key estimate over all pitched notes. */
export function estimateKey(tracks) {
  const end = Math.max(0, ...tracks.flatMap((t) => t.notes.map((n) => n.beat + n.lengthBeats)));
  const { weights, total } = pitchClassWeights(tracks, 0, end || 1);
  if (total <= 0) return Object.freeze({ tonic: 0, mode: 'major', name: 'C major', confidence: 0 });
  let best = null;
  for (const mode of ['major', 'minor']) {
    const profile = mode === 'major' ? KK_MAJOR : KK_MINOR;
    for (let tonic = 0; tonic < 12; tonic++) {
      const x = weights;
      const y = Array.from({ length: 12 }, (_, i) => profile[(i - tonic + 12) % 12]);
      const mx = x.reduce((s, v) => s + v, 0) / 12;
      const my = y.reduce((s, v) => s + v, 0) / 12;
      let num = 0;
      let dx = 0;
      let dy = 0;
      for (let i = 0; i < 12; i++) {
        num += (x[i] - mx) * (y[i] - my);
        dx += (x[i] - mx) ** 2;
        dy += (y[i] - my) ** 2;
      }
      const r = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
      if (!best || r > best.r + 1e-12) best = { tonic, mode, r };
    }
  }
  return Object.freeze({
    tonic: best.tonic,
    mode: best.mode,
    name: `${PC_NAMES[best.tonic]} ${best.mode}`,
    confidence: Math.round(best.r * 1000) / 1000,
  });
}

/** Best chord for a weight vector. Returns null when nothing sounds. */
export function bestChord({ weights, bassPc, total }, key = null) {
  if (total <= 1e-9) return null;
  const diatonic = key ? new Set(scaleOf(key)) : null;
  let best = null;
  for (let root = 0; root < 12; root++) {
    for (const tpl of CHORD_TYPES) {
      const pcs = tpl.intervals.map((i) => (root + i) % 12);
      const inSet = new Set(pcs);
      let hit = 0;
      let miss = 0;
      for (let p = 0; p < 12; p++) {
        if (inSet.has(p)) hit += weights[p];
        else miss += weights[p];
      }
      // Every chord tone should be heard; an absent third/seventh costs a little.
      const absent = pcs.filter((p) => weights[p] <= 1e-9).length;
      let score = hit - 0.6 * miss - total * (tpl.penalty + 0.08 * absent);
      if (bassPc !== null && bassPc === root) score += 0.25 * total;
      if (diatonic && pcs.every((p) => diatonic.has(p))) score += 0.05 * total;
      if (!best || score > best.score + 1e-9) best = { root, type: tpl.type, score };
    }
  }
  return makeChord(best.root, best.type);
}

/**
 * One chord per bar from the user's pitched notes. Empty bars carry the previous chord
 * (or the next one at the start, or the tonic triad when the piece has no pitched notes).
 * @returns {{ bar: number, chord: object, estimated: boolean }[]}
 */
export function estimateBarChords(tracks, bars, beatsPerBar = 4, key = null) {
  const out = [];
  for (let bar = 0; bar < bars; bar++) {
    const span = pitchClassWeights(tracks, bar * beatsPerBar, (bar + 1) * beatsPerBar);
    out.push({ bar, chord: bestChord(span, key), estimated: true });
  }
  const fallback = key ? makeChord(key.tonic, key.mode === 'minor' ? 'm' : '') : makeChord(0, '');
  let firstReal = out.find((b) => b.chord)?.chord ?? fallback;
  let prev = null;
  for (const entry of out) {
    if (entry.chord) {
      prev = entry.chord;
    } else {
      entry.chord = prev ?? firstReal;
      entry.estimated = false;
    }
  }
  return out;
}

/** Diatonic triad on a scale degree (0-based), with an optional seventh. */
export function diatonicChord(key, degree, seventh = false) {
  const scale = scaleOf(key);
  const d = ((degree % 7) + 7) % 7;
  const root = scale[d];
  const third = (scale[(d + 2) % 7] - root + 12) % 12;
  const fifth = (scale[(d + 4) % 7] - root + 12) % 12;
  let type = third === 4 ? '' : 'm';
  if (fifth === 6) type = 'dim';
  if (seventh && type !== 'dim') {
    const sev = (scale[(d + 6) % 7] - root + 12) % 12;
    if (type === '' && sev === 11) type = 'maj7';
    else if (type === '' && sev === 10) type = '7';
    else if (type === 'm' && sev === 10) type = 'm7';
  }
  return makeChord(root, type);
}

/** A chord a fixed number of semitones from the tonic (borrowed colours). */
function borrowed(key, semis, type) {
  return makeChord((key.tonic + semis) % 12, type);
}

/**
 * House Band progressions for new sections, as functions of the key. `kind` is "B"
 * (new harmony, a lift away from the user's centre) or "C" (the breathing space, darker,
 * with borrowed colours). Each list is four chords.
 */
export function progressionCandidates(key, kind) {
  const d = (deg, sev = false) => diatonicChord(key, deg, sev);
  if (kind === 'C') {
    return key.mode === 'minor'
      ? [
        [d(5, true), d(3, true), borrowed(key, 1, 'maj7'), borrowed(key, 7, '7')],
        [d(0, true), d(5, true), d(3, true), borrowed(key, 7, 'sus4')],
        [d(3, true), d(6), d(2, true), borrowed(key, 7, '7')],
      ]
      : [
        [d(3, true), borrowed(key, 10, ''), borrowed(key, 8, 'maj7'), d(4, true)],
        [d(1, true), borrowed(key, 8, 'maj7'), borrowed(key, 10, ''), d(4, true)],
        [d(5, true), d(3, true), borrowed(key, 3, 'maj7'), d(4, true)],
      ];
  }
  return key.mode === 'minor'
    ? [
      [d(5), d(2), d(6), d(0)],
      [d(3), d(5), d(4), d(0)],
      [d(2), d(6), d(5), d(4)],
      [d(5, true), d(6), d(2, true), d(3, true)],
    ]
    : [
      [d(5), d(3), d(0), d(4)],
      [d(3), d(4), d(2), d(5)],
      [d(1, true), d(4, true), d(2, true), d(5, true)],
      [d(5), d(2), d(3), d(4)],
    ];
}

/** Interval shape of a chord sequence: root steps and qualities, transposition-free. */
export function progressionShape(chords) {
  if (chords.length === 0) return '';
  const r0 = chords[0].root;
  return chords.map((c) => `${(c.root - r0 + 12) % 12}${c.type}`).join(' ');
}

/** Bars per chord change in a per-bar chord list (median run length). */
export function harmonicRhythmBars(barChords) {
  const runs = [];
  let run = 1;
  for (let i = 1; i < barChords.length; i++) {
    if (barChords[i].name === barChords[i - 1].name) run += 1;
    else {
      runs.push(run);
      run = 1;
    }
  }
  runs.push(run);
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

/**
 * Lay a four-chord progression over `bars` bars, choosing a harmonic rhythm that differs
 * from the user's (a section that changes chords at the same rate in the same shape reads
 * as the same bed). Returns one chord per bar.
 */
export function layProgression(chords, bars, userRhythmBars) {
  const perChord = userRhythmBars <= 1 ? 2 : 1;
  const out = [];
  for (let bar = 0; bar < bars; bar++) {
    out.push(chords[Math.floor(bar / perChord) % chords.length]);
  }
  return out;
}

/** Chord-tone MIDI notes of a chord between lo and hi inclusive. */
export function chordTonesInRange(chord, lo, hi) {
  const out = [];
  for (let m = lo; m <= hi; m++) if (chord.pcs.includes(pc(m))) out.push(m);
  return out;
}

/** Scale-tone MIDI notes between lo and hi inclusive. */
export function scaleTonesInRange(key, lo, hi) {
  const scale = new Set(scaleOf(key));
  const out = [];
  for (let m = lo; m <= hi; m++) if (scale.has(pc(m))) out.push(m);
  return out;
}

/**
 * Voice a chord as `count` notes inside [lo, hi], moving as little as possible from the
 * previous voicing. Deterministic: candidates are enumerated in a fixed order.
 */
export function voiceChord(chord, previous, lo, hi, count) {
  const tones = chordTonesInRange(chord, lo, hi);
  if (tones.length === 0) return [];
  const want = Math.min(count, tones.length);
  // Candidate voicings: windows of consecutive chord tones (close position and spreads).
  const candidates = [];
  for (let start = 0; start + want <= tones.length; start++) {
    candidates.push(tones.slice(start, start + want));
    if (start + want + 1 <= tones.length && want >= 3) {
      // open voicing: drop the second note an octave by skipping one tone
      const open = [tones[start], ...tones.slice(start + 2, start + want + 1)];
      candidates.push(open);
    }
  }
  const covers = (v) => new Set(v.map(pc)).size;
  const centre = (lo + hi) / 2;
  let best = null;
  for (const v of candidates) {
    let cost;
    if (previous && previous.length > 0) {
      cost = 0;
      for (const n of v) cost += Math.min(...previous.map((p) => Math.abs(p - n)));
    } else {
      cost = Math.abs(v.reduce((s, n) => s + n, 0) / v.length - centre);
    }
    // Prefer voicings that state more distinct chord tones, with the root present.
    cost -= 2 * covers(v);
    if (!v.some((n) => pc(n) === chord.root)) cost += 1.5;
    if (!best || cost < best.cost - 1e-9) best = { v, cost };
  }
  return best.v;
}

/** Nearest MIDI note to `target` whose pitch class is in `pcs`, inside [lo, hi]. */
export function nearestInSet(target, pcs, lo, hi, exclude = null) {
  let best = null;
  for (let m = lo; m <= hi; m++) {
    if (!pcs.includes(pc(m))) continue;
    if (exclude !== null && m === exclude) continue;
    const d = Math.abs(m - target);
    if (best === null || d < best.d || (d === best.d && m < best.m)) best = { m, d };
  }
  return best ? best.m : null;
}

/** Put a pitch class in the octave whose MIDI lies in [lo, lo + 11]. */
export function placeInOctave(p, lo) {
  return lo + ((pc(p) - pc(lo) + 12) % 12);
}
