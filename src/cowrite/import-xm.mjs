/**
 * FastTracker II XM importer (OSS-20).
 * Pattern data only; sample bytes are never extracted.
 */
import { basename } from 'node:path';

import {
  bcdRow,
  flattenTrackerToSourceSong,
  readAscii,
  readUint16LE,
} from './tracker-common.mjs';

export const XM_IMPORTER = 'xm';
export const XM_IMPORTER_VERSION = '1';

const XM_MAGIC = 'Extended Module: ';

export class XmImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmImportError';
  }
}

function fail(message) {
  throw new XmImportError(message);
}

function readUint32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/**
 * XM note 1..96 -> MIDI (C-4 = 49 -> 60). 97 = key off.
 * @param {number} note
 * @returns {number|null|-1} -1 key off; null empty
 */
export function xmNoteToMidi(note) {
  if (note === 97) return -1;
  if (note < 1 || note > 96) return null;
  return note + 11;
}

/**
 * MIDI -> XM note (1 = C-0).
 * @param {number} midi
 */
export function midiToXmNote(midi) {
  return midi - 11;
}

/**
 * @param {import('./tracker-common.mjs').TrackerCell} cell
 * @param {number} effect
 * @param {number} param
 */
function applyEffect(cell, effect, param) {
  if (effect === 0x0f) {
    // Fxx: < 32 speed, else BPM
    if (param > 0 && param < 32) cell.setSpeed = param;
    else if (param >= 32) cell.setTempo = param;
  } else if (effect === 0x0b) {
    cell.positionJump = param;
  } else if (effect === 0x0d) {
    cell.patternBreak = bcdRow(param);
  } else if (effect === 0x0c) {
    cell.volume = Math.min(64, param);
  } else if (effect === 0x0e && (param >> 4) === 0x0c) {
    cell.noteCutTicks = param & 0x0f;
  }
}

/**
 * Unpack one XM pattern packed blob into rows x channels cells.
 * @param {Uint8Array} data
 * @param {number} offset start of packed data
 * @param {number} packedSize
 * @param {number} rows
 * @param {number} channels
 * @returns {import('./tracker-common.mjs').TrackerCell[][]}
 */
function unpackPattern(data, offset, packedSize, rows, channels) {
  const end = offset + packedSize;
  if (end > data.length) fail('truncated XM pattern data');

  const out = Array.from({ length: rows }, () =>
    Array.from({ length: channels }, () => (/** @type {import('./tracker-common.mjs').TrackerCell} */ ({}))),
  );

  let i = offset;
  for (let row = 0; row < rows; row++) {
    for (let ch = 0; ch < channels; ch++) {
      if (i >= end) fail('XM pattern data ended early');
      const cell = out[row][ch];
      const first = data[i++];
      let note = 0;
      let instrument = 0;
      let volume = 0;
      let effect = 0;
      let param = 0;

      if (first & 0x80) {
        if (first & 0x01) {
          if (i >= end) fail('truncated XM note');
          note = data[i++];
        }
        if (first & 0x02) {
          if (i >= end) fail('truncated XM instrument');
          instrument = data[i++];
        }
        if (first & 0x04) {
          if (i >= end) fail('truncated XM volume');
          volume = data[i++];
        }
        if (first & 0x08) {
          if (i >= end) fail('truncated XM effect');
          effect = data[i++];
        }
        if (first & 0x10) {
          if (i >= end) fail('truncated XM effect param');
          param = data[i++];
        }
      } else {
        // Uncompressed: first byte is the note; four more follow.
        note = first;
        if (i + 4 > end) fail('truncated XM uncompressed note');
        instrument = data[i++];
        volume = data[i++];
        effect = data[i++];
        param = data[i++];
      }

      if (note) {
        const midi = xmNoteToMidi(note);
        if (midi === -1) cell.noteCut = true;
        else if (midi != null) cell.midi = midi;
      }
      if (instrument > 0) cell.instrument = instrument;
      // Volume column 0x10..0x50 = volume 0..64
      if (volume >= 0x10 && volume <= 0x50) {
        cell.volume = volume - 0x10;
      }
      if (effect || param) applyEffect(cell, effect, param);
    }
  }

  return out;
}

/**
 * Skip sample headers and sample data; return instrument names.
 * Never copies sample PCM into the output.
 * @param {Uint8Array} data
 * @param {number} start
 * @param {number} instrumentCount
 * @returns {{ names: string[], nextOffset: number }}
 */
function readInstrumentNames(data, start, instrumentCount) {
  const names = [];
  let o = start;
  for (let n = 0; n < instrumentCount; n++) {
    if (o + 4 > data.length) {
      names.push(`instrument-${n + 1}`);
      continue;
    }
    const headerSize = readUint32LE(data, o);
    if (headerSize < 29 || o + headerSize > data.length) {
      names.push(`instrument-${n + 1}`);
      // Best-effort skip: advance by declared size when plausible.
      if (headerSize >= 4 && o + headerSize <= data.length) o += headerSize;
      else break;
      continue;
    }
    names.push(readAscii(data, o + 4, 22) || `instrument-${n + 1}`);
    const numSamples = o + 27 + 2 <= data.length ? readUint16LE(data, o + 27) : 0;
    let sampleHeaderSize = 40;
    if (numSamples > 0 && o + 29 + 4 <= data.length) {
      sampleHeaderSize = readUint32LE(data, o + 29) || 40;
    }
    o += headerSize;
    if (numSamples <= 0) continue;

    const sampleLengths = [];
    for (let s = 0; s < numSamples; s++) {
      if (o + sampleHeaderSize > data.length) fail('truncated XM sample header');
      const sampleLen = readUint32LE(data, o);
      sampleLengths.push(sampleLen);
      o += sampleHeaderSize;
    }
    for (const len of sampleLengths) {
      if (o + len > data.length) fail('truncated XM sample data');
      o += len; // skip; never read into output
    }
  }
  return { names, nextOffset: o };
}

/**
 * Ensure each pattern plays exactly its own row count under a shared rowsPerPattern.
 * Shorter patterns get a pattern-break on their last row so padding is never heard.
 * @param {import('./tracker-common.mjs').TrackerCell[][][]} patterns
 * @param {number} channels
 * @param {number} maxRows
 */
function normalizePatternRows(patterns, channels, maxRows) {
  for (const pattern of patterns) {
    const rows = pattern.length;
    if (rows > 0 && rows < maxRows) {
      const last = pattern[rows - 1];
      let hasNav = false;
      for (const c of last) {
        if (c && (c.patternBreak != null || c.positionJump != null)) {
          hasNav = true;
          break;
        }
      }
      if (!hasNav) {
        last[0] = { ...(last[0] || {}), patternBreak: 0 };
      }
    }
    while (pattern.length < maxRows) {
      pattern.push(Array.from({ length: channels }, () => ({})));
    }
  }
}

/**
 * Import an XM into a source-song.
 * @param {Uint8Array|Buffer} bytes
 * @param {string} fileName
 */
export function importXm(bytes, fileName) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 80) fail('file too short to be an XM');
  {
    const magic = String.fromCharCode(...data.subarray(0, 17));
    if (magic !== XM_MAGIC) fail('missing Extended Module header');
  }

  const title =
    readAscii(data, 17, 20) || basename(fileName || 'song.xm').replace(/\.xm$/i, '');
  const headerSize = readUint32LE(data, 60);
  if (headerSize < 20) fail('invalid XM header size');

  const songLength = readUint16LE(data, 64);
  const channels = readUint16LE(data, 68);
  const patternCount = readUint16LE(data, 70);
  const instrumentCount = readUint16LE(data, 72);
  const initialSpeed = readUint16LE(data, 76) || 6;
  const initialTempo = readUint16LE(data, 78) || 125;

  if (channels < 1 || channels > 32) fail('invalid XM channel count');

  const order = [];
  for (let i = 0; i < songLength; i++) {
    order.push(data[80 + i]);
  }

  let o = 60 + headerSize;
  /** @type {import('./tracker-common.mjs').TrackerCell[][][]} */
  const patterns = [];
  let maxRows = 0;

  for (let p = 0; p < patternCount; p++) {
    if (o + 9 > data.length) fail('truncated XM pattern header');
    const patHeaderLen = readUint32LE(data, o);
    // packing type at o+4 (ignored; FT2 uses 0)
    const rows = readUint16LE(data, o + 5);
    const packedSize = readUint16LE(data, o + 7);
    const dataStart = o + patHeaderLen;
    if (patHeaderLen < 9) fail('invalid XM pattern header length');
    if (dataStart + packedSize > data.length) fail('truncated XM pattern data');

    if (packedSize === 0 || rows === 0) {
      patterns.push(
        Array.from({ length: rows || 64 }, () =>
          Array.from({ length: channels }, () => ({})),
        ),
      );
    } else {
      patterns.push(unpackPattern(data, dataStart, packedSize, rows, channels));
    }
    if (rows > maxRows) maxRows = rows;
    o = dataStart + packedSize;
  }

  if (maxRows < 1) maxRows = 64;
  normalizePatternRows(patterns, channels, maxRows);

  const { names: instrumentNames } = readInstrumentNames(data, o, instrumentCount);

  return flattenTrackerToSourceSong({
    bytes: data,
    fileName: fileName || 'song.xm',
    title,
    importer: XM_IMPORTER,
    importerVersion: XM_IMPORTER_VERSION,
    order,
    patterns,
    instrumentNames,
    channels,
    initialSpeed,
    initialTempo,
    rowsPerPattern: maxRows,
  });
}
