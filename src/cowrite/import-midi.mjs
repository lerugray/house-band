/**
 * MIDI SMF importer (OSS-17). Types 0 and 1; PPQ division only.
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
  SOURCE_SONG_FORMAT,
  SOURCE_SONG_VERSION,
  roleGuess,
  sortNotes,
} from './source-song.mjs';

export const MIDI_IMPORTER = 'midi';
export const MIDI_IMPORTER_VERSION = '1';

/** General MIDI Level 1 program names (index 0 = program 0). */
export const GM_PROGRAM_NAMES = Object.freeze([
  'Acoustic Grand Piano',
  'Bright Acoustic Piano',
  'Electric Grand Piano',
  'Honky-tonk Piano',
  'Electric Piano 1',
  'Electric Piano 2',
  'Harpsichord',
  'Clavi',
  'Celesta',
  'Glockenspiel',
  'Music Box',
  'Vibraphone',
  'Marimba',
  'Xylophone',
  'Tubular Bells',
  'Dulcimer',
  'Drawbar Organ',
  'Percussive Organ',
  'Rock Organ',
  'Church Organ',
  'Reed Organ',
  'Accordion',
  'Harmonica',
  'Tango Accordion',
  'Acoustic Guitar (nylon)',
  'Acoustic Guitar (steel)',
  'Electric Guitar (jazz)',
  'Electric Guitar (clean)',
  'Electric Guitar (muted)',
  'Overdriven Guitar',
  'Distortion Guitar',
  'Guitar harmonics',
  'Acoustic Bass',
  'Electric Bass (finger)',
  'Electric Bass (pick)',
  'Fretless Bass',
  'Slap Bass 1',
  'Slap Bass 2',
  'Synth Bass 1',
  'Synth Bass 2',
  'Violin',
  'Viola',
  'Cello',
  'Contrabass',
  'Tremolo Strings',
  'Pizzicato Strings',
  'Orchestral Harp',
  'Timpani',
  'String Ensemble 1',
  'String Ensemble 2',
  'SynthStrings 1',
  'SynthStrings 2',
  'Choir Aahs',
  'Voice Oohs',
  'Synth Voice',
  'Orchestra Hit',
  'Trumpet',
  'Trombone',
  'Tuba',
  'Muted Trumpet',
  'French Horn',
  'Brass Section',
  'SynthBrass 1',
  'SynthBrass 2',
  'Soprano Sax',
  'Alto Sax',
  'Tenor Sax',
  'Baritone Sax',
  'Oboe',
  'English Horn',
  'Bassoon',
  'Clarinet',
  'Piccolo',
  'Flute',
  'Recorder',
  'Pan Flute',
  'Blown Bottle',
  'Shakuhachi',
  'Whistle',
  'Ocarina',
  'Lead 1 (square)',
  'Lead 2 (sawtooth)',
  'Lead 3 (calliope)',
  'Lead 4 (chiff)',
  'Lead 5 (charang)',
  'Lead 6 (voice)',
  'Lead 7 (fifths)',
  'Lead 8 (bass + lead)',
  'Pad 1 (new age)',
  'Pad 2 (warm)',
  'Pad 3 (polysynth)',
  'Pad 4 (choir)',
  'Pad 5 (bowed)',
  'Pad 6 (metallic)',
  'Pad 7 (halo)',
  'Pad 8 (sweep)',
  'FX 1 (rain)',
  'FX 2 (soundtrack)',
  'FX 3 (crystal)',
  'FX 4 (atmosphere)',
  'FX 5 (brightness)',
  'FX 6 (goblins)',
  'FX 7 (echoes)',
  'FX 8 (sci-fi)',
  'Sitar',
  'Banjo',
  'Shamisen',
  'Koto',
  'Kalimba',
  'Bag pipe',
  'Fiddle',
  'Shanai',
  'Tinkle Bell',
  'Agogo',
  'Steel Drums',
  'Woodblock',
  'Taiko Drum',
  'Melodic Tom',
  'Synth Drum',
  'Reverse Cymbal',
  'Guitar Fret Noise',
  'Breath Noise',
  'Seashore',
  'Bird Tweet',
  'Telephone Ring',
  'Helicopter',
  'Applause',
  'Gunshot',
]);

export class MidiImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MidiImportError';
  }
}

function fail(message) {
  throw new MidiImportError(message);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readAscii(bytes, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

function readUint16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

/** Read a MIDI variable-length quantity. Returns [value, bytesConsumed]. */
export function readVarLen(bytes, offset) {
  let value = 0;
  let i = offset;
  for (let n = 0; n < 4; n++) {
    if (i >= bytes.length) fail('truncated variable-length quantity');
    const b = bytes[i++];
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return [value, i - offset];
  }
  fail('variable-length quantity too long');
}

const CHANNEL_DATA_LEN = Object.freeze({
  0x8: 2,
  0x9: 2,
  0xa: 2,
  0xb: 2,
  0xc: 1,
  0xd: 1,
  0xe: 2,
});

/**
 * Parse one MTrk body into timed events.
 * @returns {{
 *   name: string,
 *   tempos: { tick: number, bpm: number }[],
 *   timeSignatures: { tick: number, num: number, den: number }[],
 *   programs: Map<number, number>,
 *   notes: { channel: number, tick: number, lengthTicks: number, midi: number, velocity: number }[],
 *   endTick: number,
 * }}
 */
function parseTrack(bytes, start, length) {
  const end = start + length;
  let offset = start;
  let tick = 0;
  let runningStatus = null;
  let name = '';
  const tempos = [];
  const timeSignatures = [];
  const programs = new Map();
  /** @type {Map<string, { tick: number, velocity: number }[]>} */
  const open = new Map();
  const notes = [];

  const key = (ch, midi) => `${ch}:${midi}`;

  const closeNote = (ch, midi, offTick) => {
    const k = key(ch, midi);
    const queue = open.get(k);
    if (!queue || queue.length === 0) return;
    const on = queue.shift();
    const lengthTicks = Math.max(0, offTick - on.tick);
    notes.push({
      channel: ch,
      tick: on.tick,
      lengthTicks,
      midi,
      velocity: on.velocity,
    });
  };

  while (offset < end) {
    const [delta, deltaLen] = readVarLen(bytes, offset);
    offset += deltaLen;
    tick += delta;
    if (offset >= end) fail('truncated MIDI track event');

    let status = bytes[offset];
    if (status < 0x80) {
      if (runningStatus == null) fail('running status used with no prior status');
      status = runningStatus;
    } else {
      offset += 1;
      if (status < 0xf0) runningStatus = status;
      else if (status === 0xff || status === 0xf0 || status === 0xf7) runningStatus = null;
    }

    if (status === 0xff) {
      if (offset + 1 > end) fail('truncated meta event');
      const type = bytes[offset++];
      const [metaLen, metaLenSize] = readVarLen(bytes, offset);
      offset += metaLenSize;
      if (offset + metaLen > end) fail('truncated meta event data');
      const dataStart = offset;
      offset += metaLen;

      if (type === 0x2f) {
        // End of track
        break;
      } else if (type === 0x51 && metaLen === 3) {
        const usPerQuarter =
          (bytes[dataStart] << 16) | (bytes[dataStart + 1] << 8) | bytes[dataStart + 2];
        if (usPerQuarter > 0) {
          tempos.push({ tick, bpm: 60_000_000 / usPerQuarter });
        }
      } else if (type === 0x58 && metaLen >= 2) {
        const num = bytes[dataStart];
        const denPow = bytes[dataStart + 1];
        timeSignatures.push({ tick, num, den: 2 ** denPow });
      } else if (type === 0x03) {
        let s = '';
        for (let i = 0; i < metaLen; i++) s += String.fromCharCode(bytes[dataStart + i]);
        if (!name) name = s;
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const [sysexLen, sysexLenSize] = readVarLen(bytes, offset);
      offset += sysexLenSize + sysexLen;
      if (offset > end) fail('truncated sysex event');
      continue;
    }

    const high = status >> 4;
    const channel = status & 0x0f;
    const dataLen = CHANNEL_DATA_LEN[high];
    if (dataLen == null) fail(`unsupported MIDI status ${status}`);
    if (offset + dataLen > end) fail('truncated channel message');
    const d1 = bytes[offset];
    const d2 = dataLen === 2 ? bytes[offset + 1] : 0;
    offset += dataLen;

    if (high === 0x9) {
      if (d2 === 0) {
        closeNote(channel, d1, tick);
      } else {
        const k = key(channel, d1);
        if (!open.has(k)) open.set(k, []);
        open.get(k).push({ tick, velocity: d2 / 127 });
      }
    } else if (high === 0x8) {
      closeNote(channel, d1, tick);
    } else if (high === 0xc) {
      if (!programs.has(channel)) programs.set(channel, d1);
    }
    // other channel messages skipped by length above
  }

  // Notes still open at track end close there
  for (const [k, queue] of open) {
    const [chStr, midiStr] = k.split(':');
    const ch = Number(chStr);
    const midi = Number(midiStr);
    while (queue.length) {
      const on = queue.shift();
      notes.push({
        channel: ch,
        tick: on.tick,
        lengthTicks: Math.max(0, tick - on.tick),
        midi,
        velocity: on.velocity,
      });
    }
  }

  return { name, tempos, timeSignatures, programs, notes, endTick: tick };
}

/**
 * Import a Standard MIDI File into a source-song.
 * @param {Uint8Array|Buffer} bytes
 * @param {string} fileName Path or basename (provenance uses basename only)
 */
export function importMidi(bytes, fileName) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 14) fail('file too short to be an SMF');
  if (readAscii(data, 0, 4) !== 'MThd') fail('missing MThd header');
  const headerLen = readUint32BE(data, 4);
  if (headerLen < 6) fail('invalid MThd length');
  const format = readUint16BE(data, 8);
  const nTracks = readUint16BE(data, 10);
  const division = readUint16BE(data, 12);
  if (format === 2) fail('SMF type 2 not supported');
  if (format !== 0 && format !== 1) fail(`unsupported SMF type ${format}`);
  if (division & 0x8000) fail('SMPTE division not supported');
  const ppq = division;
  if (ppq <= 0) fail('invalid PPQ division');

  let offset = 8 + headerLen;
  const parsedTracks = [];
  for (let t = 0; t < nTracks; t++) {
    if (offset + 8 > data.length) fail('truncated track header');
    if (readAscii(data, offset, 4) !== 'MTrk') fail('missing MTrk header');
    const trackLen = readUint32BE(data, offset + 4);
    offset += 8;
    if (offset + trackLen > data.length) fail('truncated track data');
    parsedTracks.push(parseTrack(data, offset, trackLen));
    offset += trackLen;
  }

  const tempoMap = [];
  let timeSignature = [4, 4];
  let sawTimeSig = false;

  for (const tr of parsedTracks) {
    for (const te of tr.tempos) {
      tempoMap.push({ beat: te.tick / ppq, bpm: te.bpm });
    }
    for (const ts of tr.timeSignatures) {
      if (!sawTimeSig || ts.tick === 0) {
        timeSignature = [ts.num, ts.den];
        sawTimeSig = true;
      }
    }
  }
  tempoMap.sort((a, b) => a.beat - b.beat);
  if (tempoMap.length === 0 || tempoMap[0].beat !== 0) {
    tempoMap.unshift({ beat: 0, bpm: 120 });
  }
  // Deduplicate identical consecutive bpms at the same beat
  const deduped = [];
  for (const entry of tempoMap) {
    const last = deduped[deduped.length - 1];
    if (last && last.beat === entry.beat && last.bpm === entry.bpm) continue;
    deduped.push(entry);
  }
  // Ensure first is beat 0
  if (deduped[0].beat !== 0) deduped.unshift({ beat: 0, bpm: 120 });

  /** @type {Map<string, object>} */
  const outByKey = new Map();
  let maxEndBeat = 0;

  for (let ti = 0; ti < parsedTracks.length; ti++) {
    const tr = parsedTracks[ti];
    maxEndBeat = Math.max(maxEndBeat, tr.endTick / ppq);
    for (const note of tr.notes) {
      const ch = note.channel;
      const mapKey = `${ti}:${ch}`;
      let out = outByKey.get(mapKey);
      if (!out) {
        const isDrums = ch === 9;
        let instrumentName = 'unknown';
        if (isDrums) {
          instrumentName = 'GM drums';
        } else if (tr.programs.has(ch)) {
          const prog = tr.programs.get(ch);
          instrumentName = GM_PROGRAM_NAMES[prog] || 'unknown';
        }
        out = {
          id: `t${ti}c${ch}`,
          name: tr.name || '',
          instrumentName,
          kind: isDrums ? 'drums' : 'pitched',
          roleGuess: 'other',
          notes: [],
        };
        outByKey.set(mapKey, out);
      }
      const beat = note.tick / ppq;
      const lengthBeats = note.lengthTicks / ppq;
      const endBeat = beat + lengthBeats;
      maxEndBeat = Math.max(maxEndBeat, endBeat);
      out.notes.push({
        beat,
        lengthBeats: lengthBeats > 0 ? lengthBeats : 1 / ppq,
        midi: note.midi,
        velocity: note.velocity,
        offsetMs: 0,
      });
    }
  }

  const tracks = [...outByKey.values()];
  // Stable order: by MIDI track index then channel (encoded in id)
  tracks.sort((a, b) => {
    const [ta, ca] = a.id.slice(1).split('c').map(Number);
    const [tb, cb] = b.id.slice(1).split('c').map(Number);
    return ta - tb || ca - cb;
  });
  for (const t of tracks) sortNotes(t.notes);
  roleGuess(tracks);

  const base = basename(fileName || 'song.mid');
  const title = base.replace(/\.(mid|midi)$/i, '') || base;

  return {
    format: SOURCE_SONG_FORMAT,
    version: SOURCE_SONG_VERSION,
    title,
    tempo: deduped[0].bpm,
    tempoMap: deduped,
    timeSignature,
    lengthBeats: maxEndBeat,
    tracks,
    sequence: null,
    provenance: {
      file: base,
      sha256: sha256Hex(data),
      importer: MIDI_IMPORTER,
      importerVersion: MIDI_IMPORTER_VERSION,
    },
  };
}
