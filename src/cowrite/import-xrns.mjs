/**
 * Renoise XRNS importer (OSS-18). Port of appendix-n parse_xrns.py + emit_js.py pitch.
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { extractMember } from './zip.mjs';
import {
  childNamed,
  childText,
  childrenNamed,
  findDescendant,
  parseXml,
} from './xml.mjs';
import {
  SOURCE_SONG_FORMAT,
  SOURCE_SONG_VERSION,
  roleGuess,
  sortNotes,
} from './source-song.mjs';

export const XRNS_IMPORTER = 'xrns';
export const XRNS_IMPORTER_VERSION = '1';

/** Renoise note-name prefixes (tracker style). */
export const NOTES = Object.freeze({
  'C-': 0,
  'C#': 1,
  'D-': 2,
  'D#': 3,
  'E-': 4,
  'F-': 5,
  'F#': 6,
  'G-': 7,
  'G#': 8,
  'A-': 9,
  'A#': 10,
  'B-': 11,
});

/** Note names for MIDI -> string (same table as emit_js.py NN). */
export const NN = Object.freeze([
  'C',
  'C#',
  'D',
  'Eb',
  'E',
  'F',
  'F#',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
]);

const DRUM_NAME_RE = /\b(BD|SD|HH|kick|snare|hat|tom|clap|tamb|perc|drum)\b/i;

export class XrnsImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XrnsImportError';
  }
}

function fail(message) {
  throw new XrnsImportError(message);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parse a Renoise note name to the tracker's MIDI number (C-4 = 60).
 * OFF / --- / empty -> null.
 * @param {string|null|undefined} note
 * @returns {number|null}
 */
export function renoiseNoteToMidi(note) {
  if (!note || note === 'OFF' || note === '---') return null;
  const prefix = note.slice(0, 2);
  const pc = NOTES[prefix];
  if (pc == null) fail(`unknown Renoise note name: ${note}`);
  const octave = Number.parseInt(note.slice(2), 10);
  if (!Number.isFinite(octave)) fail(`bad Renoise note octave: ${note}`);
  return pc + 12 * (octave + 1);
}

/**
 * MIDI number to emit_js.py note name.
 * @param {number} midi
 */
export function midiToNoteName(midi) {
  return NN[((midi % 12) + 12) % 12] + String(Math.floor(midi / 12) - 1);
}

/**
 * Volume hex 00-80 -> 0..1; empty / missing / out of range -> 1.
 * @param {string|null|undefined} vol
 */
export function volumeToVelocity(vol) {
  if (vol == null || vol === '') return 1;
  if (!/^[0-9A-Fa-f]{2}$/.test(vol)) return 1;
  const v = Number.parseInt(vol, 16);
  if (v > 0x80) return 1;
  return v / 0x80;
}

/**
 * Delay hex -> milliseconds at song tempo.
 * delay/256 * (60000 / bpm / lpb)
 * @param {string|null|undefined} delayHex
 * @param {number} bpm
 * @param {number} lpb
 */
export function delayToOffsetMs(delayHex, bpm, lpb) {
  if (delayHex == null || delayHex === '') return 0;
  if (!/^[0-9A-Fa-f]{2}$/.test(delayHex)) return 0;
  const delay = Number.parseInt(delayHex, 16);
  return (delay / 256) * (60000 / bpm / lpb);
}

function elementChildren(node) {
  return (node.children || []).filter((c) => c && c.name);
}

/**
 * @param {Uint8Array|Buffer} bytes
 * @param {string} fileName
 */
export function importXrns(bytes, fileName) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let songXmlBytes;
  try {
    songXmlBytes = extractMember(data, 'Song.xml');
  } catch (err) {
    fail(err.message || 'Song.xml missing from xrns zip');
  }
  const xmlText = Buffer.from(songXmlBytes).toString('utf8');
  const root = parseXml(xmlText);

  const global = childNamed(root, 'GlobalSongData');
  if (!global) fail('missing GlobalSongData');
  const bpm = Number.parseFloat(childText(global, 'BeatsPerMin', '120'));
  const lpb = Number.parseInt(childText(global, 'LinesPerBeat', '4'), 10);
  const songName = childText(global, 'SongName', '') || '';
  const sigNum = Number.parseInt(childText(global, 'SignatureNumerator', '4'), 10);
  const sigDen = Number.parseInt(childText(global, 'SignatureDenominator', '4'), 10);
  if (!(bpm > 0)) fail('invalid BeatsPerMin');
  if (!(lpb > 0)) fail('invalid LinesPerBeat');

  const instrumentsNode = childNamed(root, 'Instruments');
  const instruments = [];
  if (instrumentsNode) {
    for (const inst of childrenNamed(instrumentsNode, 'Instrument')) {
      const name = childText(inst, 'Name', '') || '';
      const plugin = findDescendant(inst, 'PluginDevice') != null;
      instruments.push({ name, plugin });
    }
  }

  const tracksNode = childNamed(root, 'Tracks');
  if (!tracksNode) fail('missing Tracks');
  const allTrackEls = elementChildren(tracksNode);
  const sequencerTracks = [];
  for (let ti = 0; ti < allTrackEls.length; ti++) {
    const el = allTrackEls[ti];
    if (el.name !== 'SequencerTrack') continue;
    sequencerTracks.push({
      index: ti,
      name: childText(el, 'Name', '') || '',
    });
  }
  const sequencerIndexSet = new Set(sequencerTracks.map((t) => t.index));

  const patternPool = childNamed(root, 'PatternPool');
  const patternsNode = patternPool ? childNamed(patternPool, 'Patterns') : null;
  const patterns = [];
  if (patternsNode) {
    for (const p of childrenNamed(patternsNode, 'Pattern')) {
      const numberOfLines = Number.parseInt(childText(p, 'NumberOfLines', '0'), 10);
      const pTracksNode = childNamed(p, 'Tracks');
      const pTracks = [];
      if (pTracksNode) {
        for (const pt of elementChildren(pTracksNode)) {
          const events = [];
          const linesNode = childNamed(pt, 'Lines');
          if (linesNode) {
            for (const ln of childrenNamed(linesNode, 'Line')) {
              const lineIndex = Number.parseInt(ln.attrs.index ?? '0', 10);
              const noteColumns = childNamed(ln, 'NoteColumns');
              if (!noteColumns) continue;
              const cols = childrenNamed(noteColumns, 'NoteColumn');
              for (let ci = 0; ci < cols.length; ci++) {
                const nc = cols[ci];
                const note = childText(nc, 'Note', null);
                if (note == null) continue;
                events.push({
                  line: lineIndex,
                  col: ci,
                  note,
                  inst: childText(nc, 'Instrument', null),
                  vol: childText(nc, 'Volume', null),
                  delay: childText(nc, 'Delay', null),
                });
              }
            }
          }
          pTracks.push({ events });
        }
      }
      patterns.push({ numberOfLines, tracks: pTracks });
    }
  }

  const patternSequence = childNamed(root, 'PatternSequence');
  const sequenceEntriesNode = patternSequence
    ? childNamed(patternSequence, 'SequenceEntries')
    : null;
  const sequence = [];
  if (sequenceEntriesNode) {
    for (const se of childrenNamed(sequenceEntriesNode, 'SequenceEntry')) {
      const patternIndex = Number.parseInt(childText(se, 'Pattern', '0'), 10);
      const muted = [];
      const mutedNode = childNamed(se, 'MutedTracks');
      if (mutedNode) {
        for (const m of childrenNamed(mutedNode, 'MutedTrack')) {
          const idx = Number.parseInt(m.text || '0', 10);
          if (Number.isFinite(idx)) muted.push(idx);
        }
      }
      sequence.push({ pattern: patternIndex, mutedTracks: muted });
    }
  }

  // Flatten sequence into timed notes (line units, delay as fraction of a line).
  /** @type {Map<string, object>} */
  const open = new Map();
  /** @type {object[]} */
  const rawNotes = [];
  let base = 0;

  for (let si = 0; si < sequence.length; si++) {
    const se = sequence[si];
    const pat = patterns[se.pattern];
    if (!pat) fail(`sequence entry references missing pattern ${se.pattern}`);
    const muted = new Set(se.mutedTracks);
    for (let ti = 0; ti < pat.tracks.length; ti++) {
      if (muted.has(ti)) continue;
      if (!sequencerIndexSet.has(ti)) continue;
      const pt = pat.tracks[ti];
      const noteEvents = [...pt.events].sort((a, b) => a.line - b.line || a.col - b.col);
      for (const e of noteEvents) {
        const delayFrac = e.delay ? Number.parseInt(e.delay, 16) / 256 : 0;
        const t = base + e.line + (Number.isFinite(delayFrac) ? delayFrac : 0);
        const key = `${ti}:${e.col}`;
        if (open.has(key)) {
          const prev = open.get(key);
          prev.dur = t - prev.t;
          open.delete(key);
        }
        const parsedMidi = renoiseNoteToMidi(e.note);
        if (parsedMidi == null) continue; // OFF / ---
        let instIndex = 0;
        if (e.inst != null && /^[0-9A-Fa-f]{2}$/.test(e.inst)) {
          instIndex = Number.parseInt(e.inst, 16);
        }
        const inst = instruments[instIndex] || { name: 'unknown', plugin: false };
        const soundingMidi = parsedMidi - (inst.plugin ? 12 : 0);
        const velocity = Math.round(volumeToVelocity(e.vol) * 1000) / 1000;
        const offsetMs = delayToOffsetMs(e.delay, bpm, lpb);
        const nn = {
          t,
          line: e.line + base,
          track: ti,
          col: e.col,
          midi: soundingMidi,
          instIndex,
          instName: inst.name || 'unknown',
          plugin: inst.plugin,
          velocity,
          offsetMs,
          dur: 0,
        };
        rawNotes.push(nn);
        open.set(key, nn);
      }
    }
    base += pat.numberOfLines;
  }
  for (const nn of open.values()) {
    nn.dur = base - nn.t;
  }

  /** @type {Map<string, object>} */
  const outByKey = new Map();
  const trackNameByIndex = new Map(sequencerTracks.map((t) => [t.index, t.name]));

  for (const n of rawNotes) {
    const id = `T${n.track}c${n.col}`;
    let track = outByKey.get(id);
    if (!track) {
      const instrumentName = n.instName || 'unknown';
      const kind = DRUM_NAME_RE.test(instrumentName) ? 'drums' : 'pitched';
      track = {
        id,
        name: trackNameByIndex.get(n.track) || '',
        instrumentName,
        kind,
        roleGuess: 'other',
        notes: [],
      };
      outByKey.set(id, track);
    }
    const lengthLines = n.dur > 0 ? n.dur : 1 / lpb;
    track.notes.push({
      beat: n.line / lpb,
      lengthBeats: lengthLines / lpb,
      midi: Math.max(0, Math.min(127, Math.round(n.midi))),
      velocity: n.velocity,
      offsetMs: n.offsetMs,
    });
  }

  // Stable order by track index then column (encoded in id).
  const tracks = [...outByKey.values()].sort((a, b) => {
    const ma = /^T(\d+)c(\d+)$/.exec(a.id);
    const mb = /^T(\d+)c(\d+)$/.exec(b.id);
    const ta = ma ? Number(ma[1]) : 0;
    const ca = ma ? Number(ma[2]) : 0;
    const tb = mb ? Number(mb[1]) : 0;
    const cb = mb ? Number(mb[2]) : 0;
    return ta - tb || ca - cb;
  });
  for (const t of tracks) sortNotes(t.notes);
  roleGuess(tracks);

  const lengthBeats = base / lpb;
  const baseName = basename(fileName || 'song.xrns');
  const title =
    (songName && songName !== 'Untitled' ? songName : null) ||
    baseName.replace(/\.xrns$/i, '') ||
    baseName;

  return {
    format: SOURCE_SONG_FORMAT,
    version: SOURCE_SONG_VERSION,
    title,
    tempo: bpm,
    tempoMap: [{ beat: 0, bpm }],
    timeSignature: [sigNum, sigDen],
    lengthBeats,
    tracks,
    sequence: sequence.map((s) => s.pattern),
    provenance: {
      file: baseName,
      sha256: sha256Hex(data),
      importer: XRNS_IMPORTER,
      importerVersion: XRNS_IMPORTER_VERSION,
    },
  };
}
