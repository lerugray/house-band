/**
 * Shared tracker import rules (OSS-19 / OSS-20).
 * Pattern data only; sample bytes are never extracted.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
  SOURCE_SONG_FORMAT,
  SOURCE_SONG_VERSION,
  roleGuess,
  sortNotes,
} from './source-song.mjs';

/** Rows per beat (tracker convention). */
export const ROWS_PER_BEAT = 4;

/** Pitch convention message printed by the CLI. */
export const PITCH_CONVENTION_LINE = 'pitch convention: sample native rate = MIDI 60';

/** Rows-per-beat line printed by the CLI. */
export const ROWS_PER_BEAT_LINE = `rows per beat: ${ROWS_PER_BEAT}`;

/** OSS-18 drum-name regex (shared by XRNS / tracker importers). */
export const DRUM_NAME_RE = /\b(BD|SD|HH|kick|snare|hat|tom|clap|tamb|perc|drum)\b/i;

/**
 * ProTracker finetune-0 period table, C-0 .. B-4.
 * Card cites C-1 856 .. B-3 113; octaves 0 and 4 included so nearest-match
 * covers the shared fixture (bass G-0, melody C-4).
 */
export const PT_PERIODS = Object.freeze([
  1712, 1616, 1524, 1440, 1356, 1280, 1208, 1140, 1076, 1016, 960, 906,
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
  107, 101, 95, 90, 85, 80, 76, 71, 67, 63, 60, 57,
]);

/** MIDI for PT C-2 (period 428) = 60. */
const PT_C2_INDEX = 24;
const PT_C2_MIDI = 60;

/**
 * Nearest ProTracker period -> MIDI (sample native rate = 60).
 * @param {number} period
 * @returns {number|null}
 */
export function periodToMidi(period) {
  if (!period || period <= 0) return null;
  let best = 0;
  let bestDist = Math.abs(PT_PERIODS[0] - period);
  for (let i = 1; i < PT_PERIODS.length; i++) {
    const dist = Math.abs(PT_PERIODS[i] - period);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return PT_C2_MIDI + (best - PT_C2_INDEX);
}

/**
 * MIDI -> ProTracker period (exact table entry), or null.
 * @param {number} midi
 * @returns {number|null}
 */
export function midiToPeriod(midi) {
  const index = PT_C2_INDEX + (midi - PT_C2_MIDI);
  if (index < 0 || index >= PT_PERIODS.length) return null;
  return PT_PERIODS[index];
}

/**
 * S3M note byte -> MIDI. C-4 (octave 4, semitone 0) = 60.
 * @param {number} noteByte
 * @returns {number|null} null for empty (255); -1 for note cut (254)
 */
export function s3mNoteToMidi(noteByte) {
  if (noteByte === 254) return -1;
  if (noteByte === 255) return null;
  const octave = (noteByte >> 4) & 0x0f;
  const semitone = noteByte & 0x0f;
  if (semitone > 11) return null;
  return 12 * (octave + 1) + semitone;
}

/**
 * MIDI -> S3M note byte (octave in high nibble, semitone in low).
 * @param {number} midi
 * @returns {number}
 */
export function midiToS3mNote(midi) {
  const octave = Math.floor(midi / 12) - 1;
  const semitone = midi % 12;
  return ((octave & 0x0f) << 4) | (semitone & 0x0f);
}

/**
 * Effective BPM from tracker tempo and speed.
 * @param {number} tempo
 * @param {number} speed
 */
export function effectiveBpm(tempo, speed) {
  const sp = speed > 0 ? speed : 6;
  return (tempo * 6) / sp;
}

/**
 * Volume 0..64 -> velocity 0..1 (default 1 when unset).
 * @param {number|null|undefined} volume
 */
export function volumeToVelocity(volume) {
  if (volume == null) return 1;
  return Math.max(0, Math.min(1, volume / 64));
}

/**
 * @param {string} name
 * @returns {'drums'|'pitched'}
 */
export function kindFromInstrumentName(name) {
  return DRUM_NAME_RE.test(name || '') ? 'drums' : 'pitched';
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readAscii(bytes, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[offset + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trimEnd();
}

export function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function readUint16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/**
 * Decode BCD pattern-break row (high nibble * 10 + low nibble).
 * @param {number} param
 */
export function bcdRow(param) {
  return (param >> 4) * 10 + (param & 0x0f);
}

/**
 * One pattern cell after format-specific decode.
 * @typedef {object} TrackerCell
 * @property {number|null} [midi] note pitch; omit/null = no new note
 * @property {boolean} [noteCut] immediate note cut / off
 * @property {number|null} [instrument] 1-based sample/instrument index
 * @property {number|null} [volume] 0..64 from volume column or set-volume
 * @property {number|null} [setSpeed]
 * @property {number|null} [setTempo]
 * @property {number|null} [positionJump] order index
 * @property {number|null} [patternBreak] start row of next order (BCD already decoded)
 * @property {number|null} [noteCutTicks] ECx / SCx tick count
 */

/**
 * Flatten order + patterns into a source-song (notes only; no sample bytes).
 *
 * @param {object} opts
 * @param {Uint8Array|Buffer} opts.bytes raw file (for provenance hash)
 * @param {string} opts.fileName
 * @param {string} opts.title
 * @param {string} opts.importer
 * @param {string} opts.importerVersion
 * @param {number[]} opts.order pattern indices in play order (skip markers already removed)
 * @param {TrackerCell[][][]} opts.patterns patterns[pat][row][channel]
 * @param {string[]} opts.instrumentNames 0-based names; cell.instrument is 1-based
 * @param {number} opts.channels
 * @param {number} opts.initialSpeed
 * @param {number} opts.initialTempo
 * @param {number} [opts.rowsPerPattern=64]
 */
export function flattenTrackerToSourceSong(opts) {
  const {
    bytes,
    fileName,
    title,
    importer,
    importerVersion,
    order,
    patterns,
    instrumentNames,
    channels,
    initialSpeed,
    initialTempo,
    rowsPerPattern = 64,
  } = opts;

  let speed = initialSpeed > 0 ? initialSpeed : 6;
  let tempo = initialTempo > 0 ? initialTempo : 125;
  const tempoMap = [{ beat: 0, bpm: effectiveBpm(tempo, speed) }];
  let beat = 0;

  /** @type {{ startBeat: number, midi: number, velocity: number, instrument: number, endBeat: number|null }[]} */
  const open = Array.from({ length: channels }, () => null);
  /** @type {Map<number, object[]>} channel -> notes */
  const notesByCh = new Map();
  /** @type {Map<number, number>} channel -> first instrument index */
  const firstInst = new Map();

  const pushTempo = (atBeat, bpm) => {
    // Speed/tempo on row 0 replaces the seeded beat-0 entry (MOD F06/F78).
    if (atBeat === 0 && tempoMap.length > 0 && tempoMap[0].beat === 0) {
      tempoMap[0].bpm = bpm;
      // Drop any accidental duplicates at beat 0.
      while (tempoMap.length > 1 && tempoMap[1].beat === 0) tempoMap.splice(1, 1);
      return;
    }
    const last = tempoMap[tempoMap.length - 1];
    if (last && last.beat === atBeat && last.bpm === bpm) return;
    if (last && last.bpm === bpm) return;
    tempoMap.push({ beat: atBeat, bpm });
  };

  const ensureNotes = (ch) => {
    if (!notesByCh.has(ch)) notesByCh.set(ch, []);
    return notesByCh.get(ch);
  };

  const closeNote = (ch, endBeat) => {
    const n = open[ch];
    if (!n) return;
    const lengthBeats = Math.max(endBeat - n.startBeat, 1 / (ROWS_PER_BEAT * 64));
    ensureNotes(ch).push({
      beat: n.startBeat,
      lengthBeats,
      midi: n.midi,
      velocity: n.velocity,
      offsetMs: 0,
    });
    if (!firstInst.has(ch)) firstInst.set(ch, n.instrument);
    open[ch] = null;
  };

  const startNote = (ch, midi, velocity, instrument, atBeat) => {
    closeNote(ch, atBeat);
    open[ch] = {
      startBeat: atBeat,
      midi,
      velocity,
      instrument: instrument || 0,
      endBeat: null,
    };
  };

  let orderPos = 0;
  let startRow = 0;
  let ended = false;

  while (orderPos < order.length && !ended) {
    const patIndex = order[orderPos];
    const pattern = patterns[patIndex];
    if (!pattern) {
      orderPos += 1;
      startRow = 0;
      continue;
    }

    let nextOrderPos = orderPos + 1;
    let nextStartRow = 0;
    let jumped = false;

    for (let row = startRow; row < rowsPerPattern; row++) {
      const rowCells = pattern[row] || [];
      let positionJump = null;
      let patternBreak = null;

      // Pass 1: global speed / tempo / navigation effects (any channel).
      for (let ch = 0; ch < channels; ch++) {
        const cell = rowCells[ch];
        if (!cell) continue;
        if (cell.setSpeed != null && cell.setSpeed > 0) {
          speed = cell.setSpeed;
          pushTempo(beat, effectiveBpm(tempo, speed));
        }
        if (cell.setTempo != null && cell.setTempo > 0) {
          tempo = cell.setTempo;
          pushTempo(beat, effectiveBpm(tempo, speed));
        }
        if (cell.positionJump != null) positionJump = cell.positionJump;
        if (cell.patternBreak != null) patternBreak = cell.patternBreak;
      }

      // Pass 2: notes / cuts / volume per channel.
      for (let ch = 0; ch < channels; ch++) {
        const cell = rowCells[ch] || {};
        let velocity = open[ch] ? open[ch].velocity : 1;
        if (cell.volume != null) velocity = volumeToVelocity(cell.volume);

        if (cell.noteCut) {
          closeNote(ch, beat);
        } else if (cell.midi != null) {
          const inst = cell.instrument != null ? cell.instrument : open[ch] ? open[ch].instrument : 0;
          startNote(ch, cell.midi, velocity, inst, beat);
          if (cell.noteCutTicks != null && cell.noteCutTicks > 0) {
            const cutLen = cell.noteCutTicks / speed / ROWS_PER_BEAT;
            const n = open[ch];
            ensureNotes(ch).push({
              beat: n.startBeat,
              lengthBeats: cutLen,
              midi: n.midi,
              velocity: n.velocity,
              offsetMs: 0,
            });
            if (!firstInst.has(ch)) firstInst.set(ch, n.instrument);
            open[ch] = null;
          }
        } else if (cell.noteCutTicks != null && open[ch]) {
          // Cut the sounding note after N ticks into this row.
          const cutEnd = beat + cell.noteCutTicks / speed / ROWS_PER_BEAT;
          closeNote(ch, cutEnd);
        } else if (cell.instrument != null && open[ch]) {
          open[ch].instrument = cell.instrument;
          if (cell.volume != null) open[ch].velocity = velocity;
        } else if (cell.volume != null && open[ch]) {
          open[ch].velocity = velocity;
        }
      }

      // Navigation after the row's notes.
      if (positionJump != null) {
        if (positionJump <= orderPos) {
          ended = true;
          beat += 1 / ROWS_PER_BEAT;
          break;
        }
        nextOrderPos = positionJump;
        nextStartRow = patternBreak != null ? patternBreak : 0;
        jumped = true;
        beat += 1 / ROWS_PER_BEAT;
        break;
      }
      if (patternBreak != null) {
        nextOrderPos = orderPos + 1;
        nextStartRow = patternBreak;
        jumped = true;
        beat += 1 / ROWS_PER_BEAT;
        break;
      }

      beat += 1 / ROWS_PER_BEAT;
    }

    if (ended) break;
    orderPos = jumped ? nextOrderPos : orderPos + 1;
    startRow = jumped ? nextStartRow : 0;
  }

  const lengthBeats = beat;
  for (let ch = 0; ch < channels; ch++) closeNote(ch, lengthBeats);

  const tracks = [];
  const sortedCh = [...notesByCh.keys()].sort((a, b) => a - b);
  for (const ch of sortedCh) {
    const notes = notesByCh.get(ch);
    if (!notes || notes.length === 0) continue;
    sortNotes(notes);
    const instIndex = firstInst.get(ch) || 0;
    const instrumentName =
      (instIndex >= 1 && instrumentNames[instIndex - 1]) ||
      `channel-${ch + 1}`;
    const kind = kindFromInstrumentName(instrumentName);
    tracks.push({
      id: `c${ch}`,
      name: `Channel ${ch + 1}`,
      instrumentName,
      kind,
      roleGuess: 'other',
      notes,
    });
  }
  roleGuess(tracks);

  const base = basename(fileName || 'song');
  return {
    format: SOURCE_SONG_FORMAT,
    version: SOURCE_SONG_VERSION,
    title: title || base,
    tempo: tempoMap[0].bpm,
    tempoMap,
    timeSignature: [4, 4],
    lengthBeats,
    tracks,
    sequence: [...order],
    provenance: {
      file: base,
      sha256: sha256Hex(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
      importer,
      importerVersion,
    },
  };
}
