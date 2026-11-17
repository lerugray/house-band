/**
 * The keep layer (OSS-22): every user note of every pitched source track must appear in
 * the developed score, in every section that states the user's material, at the same
 * pitch class and beat (16th-note step from the section start), as a step tagged
 * `"origin": "user"`. An octave fold is allowed only when it moves a note into the range
 * of the voice that plays it; anything else counts as missing.
 *
 * checkKeepLayer(source, score[, { sections }]) -> { ok, missing, moved, extra, sections }
 */
import { noteFreq } from '../kit/band.js';
import { validateSourceSong } from './source-song.mjs';

/** Comfortable MIDI range per voice. A fold may only move a note INTO this range. */
export const VOICE_RANGES = Object.freeze({
  lead: Object.freeze([48, 96]),
  pad: Object.freeze([36, 96]),
  pluck: Object.freeze([36, 96]),
  bell: Object.freeze([48, 108]),
  bass: Object.freeze([24, 60]),
  drone: Object.freeze([24, 72]),
  chipPulse: Object.freeze([36, 96]),
  chipTriangle: Object.freeze([24, 84]),
});
const DEFAULT_RANGE = Object.freeze([12, 115]);

/** Share of a source's notes a section must carry to count as stating the material. */
export const STATES_MATERIAL_SHARE = 0.5;

export function voiceRange(voice) {
  return VOICE_RANGES[voice] ?? DEFAULT_RANGE;
}

export function inVoiceRange(voice, midi) {
  const [lo, hi] = voiceRange(voice);
  return midi >= lo && midi <= hi;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function nameOf(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function stepMidi(step) {
  if (typeof step.note === 'string') {
    const f = noteFreq(step.note);
    if (Number.isFinite(f) && f > 0) return Math.round(69 + 12 * Math.log2(f / 440));
    return null;
  }
  if (Number.isFinite(step.freq) && step.freq > 0) return Math.round(69 + 12 * Math.log2(step.freq / 440));
  return null;
}

const pcOf = (m) => ((m % 12) + 12) % 12;

/** The source's pitched notes as keep-layer expectations (step index from section start). */
export function expectedUserNotes(source) {
  const out = [];
  source.tracks.forEach((track, trackIndex) => {
    if (track.kind !== 'pitched' || track.roleGuess === 'drums') return;
    track.notes.forEach((note, noteIndex) => {
      out.push({
        track: track.id,
        trackIndex,
        noteIndex,
        beat: note.beat,
        i: Math.round(note.beat * 4),
        midi: note.midi,
      });
    });
  });
  return out;
}

/** Audible origin:user pitched steps of one section, as { i, midi, voice, stepIndex }. */
function sectionUserSteps(score, sectionIndex) {
  const section = score.sections[sectionIndex];
  const track = score.tracks?.[section.track];
  if (!track || !Array.isArray(track.steps)) return [];
  if (track.vol === 0) return [];
  const sectionLen = section.bars * 16;
  const len = track.len;
  const out = [];
  track.steps.forEach((step, stepIndex) => {
    if (step.origin !== 'user') return;
    const voice = step.voice ?? step.v;
    const midi = stepMidi(step);
    if (midi === null) return; // unpitched user steps (drums) are not keep-layer notes
    const opts = step.opts ?? step.o ?? {};
    if (opts.vol === 0) return;
    if (section.mute?.includes(voice)) return;
    let indices;
    if (step.i !== undefined) indices = Array.isArray(step.i) ? step.i : [step.i];
    else if (step.every !== undefined) indices = Array.from({ length: Math.ceil(len / step.every) }, (_, k) => k * step.every);
    else return;
    for (const idx of indices) {
      for (let at = idx; at < sectionLen; at += len) {
        const bar = Math.floor(at / 16);
        if (section.dropouts?.some((d) => bar >= d.from && bar < d.to && d.voices.includes(voice))) continue;
        out.push({ i: at, midi, voice, stepIndex });
      }
    }
  });
  return out;
}

/** Match expectations against one section's user steps. */
function matchSection(expected, steps, sectionIndex) {
  const byI = new Map();
  for (const s of steps) {
    if (!byI.has(s.i)) byI.set(s.i, []);
    byI.get(s.i).push({ ...s, used: false });
  }
  const missing = [];
  const moved = [];
  let matched = 0;
  const pending = [];
  // Exact pitch first, so an octave pair (C3 + C4 at one beat) never cross-matches.
  for (const e of expected) {
    const pool = byI.get(e.i) ?? [];
    const exact = pool.find((s) => !s.used && s.midi === e.midi);
    if (exact) {
      exact.used = true;
      matched += 1;
    } else {
      pending.push(e);
    }
  }
  for (const e of pending) {
    const pool = byI.get(e.i) ?? [];
    const folded = pool.find((s) => !s.used && pcOf(s.midi) === pcOf(e.midi));
    const base = { track: e.track, noteIndex: e.noteIndex, beat: e.beat, midi: e.midi, note: nameOf(e.midi), section: sectionIndex };
    if (folded && !inVoiceRange(folded.voice, e.midi) && inVoiceRange(folded.voice, folded.midi)) {
      folded.used = true;
      matched += 1;
      moved.push({ ...base, to: folded.midi, toNote: nameOf(folded.midi), voice: folded.voice });
    } else if (folded) {
      missing.push({ ...base, reason: `octave changed to ${nameOf(folded.midi)} without a range need on ${folded.voice}` });
    } else {
      missing.push({ ...base, reason: 'no origin:user step at this beat and pitch class' });
    }
  }
  const extra = [];
  for (const pool of byI.values()) {
    for (const s of pool) {
      if (!s.used) extra.push({ section: sectionIndex, i: s.i, midi: s.midi, note: nameOf(s.midi), voice: s.voice, stepIndex: s.stepIndex });
    }
  }
  return { matched, missing, moved, extra };
}

/**
 * Check the keep layer.
 * @param {object} source house-band-source-song
 * @param {object} score score spec (validated or raw)
 * @param {{ sections?: number[] }} [options] section indexes that state the user's material;
 *   by default every section whose origin:user steps carry at least half the source's notes.
 */
export function checkKeepLayer(source, score, options = {}) {
  const song = validateSourceSong(JSON.parse(JSON.stringify(source)));
  const expected = expectedUserNotes(song);
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  const results = sections.map((_, index) => matchSection(expected, sectionUserSteps(score, index), index));
  let checked;
  if (Array.isArray(options.sections)) {
    checked = [...options.sections];
  } else {
    checked = [];
    results.forEach((r, index) => {
      if (expected.length > 0 && r.matched >= Math.ceil(expected.length * STATES_MATERIAL_SHARE)) checked.push(index);
    });
  }
  const missing = [];
  const moved = [];
  const extra = [];
  if (expected.length > 0 && checked.length === 0) {
    for (const e of expected) {
      missing.push({ track: e.track, noteIndex: e.noteIndex, beat: e.beat, midi: e.midi, note: nameOf(e.midi), section: null, reason: 'no section states the user material' });
    }
  }
  for (const index of checked) {
    const r = results[index];
    if (!r) {
      missing.push({ track: null, noteIndex: null, beat: null, midi: null, note: null, section: index, reason: 'section does not exist' });
      continue;
    }
    missing.push(...r.missing);
    moved.push(...r.moved);
    extra.push(...r.extra);
  }
  return {
    ok: missing.length === 0 && extra.length === 0,
    expectedNotes: expected.length,
    sections: checked,
    missing,
    moved,
    extra,
  };
}

/** One-line plain-English summary of a keep-layer result (for diagnostics and logs). */
export function describeKeepLayer(result, limit = 8) {
  if (result.ok) {
    return `keep layer ok: ${result.expectedNotes} user notes in ${result.sections.length} section(s), ${result.moved.length} octave fold(s)`;
  }
  const parts = [];
  if (result.missing.length) {
    const list = result.missing.slice(0, limit)
      .map((m) => (m.track === null ? `section ${m.section}: ${m.reason}` : `${m.track}#${m.noteIndex} ${m.note} beat ${m.beat} in section ${m.section ?? '-'} (${m.reason})`));
    parts.push(`${result.missing.length} user note(s) missing: ${list.join('; ')}${result.missing.length > limit ? '; ...' : ''}`);
  }
  if (result.extra.length) {
    const list = result.extra.slice(0, limit).map((x) => `${x.note} at step ${x.i} in section ${x.section}`);
    parts.push(`${result.extra.length} step(s) tagged origin "user" that are not the user's notes: ${list.join('; ')}${result.extra.length > limit ? '; ...' : ''}`);
  }
  return `keep layer broken: ${parts.join('. ')}`;
}
