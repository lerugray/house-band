/**
 * Impulse Tracker IT importer (OSS-20).
 * Pattern data only; sample bytes are never extracted.
 */
import { basename } from 'node:path';

import {
  bcdRow,
  flattenTrackerToSourceSong,
  readAscii,
  readUint16LE,
} from './tracker-common.mjs';

export const IT_IMPORTER = 'it';
export const IT_IMPORTER_VERSION = '1';

const IT_MAX_CHANNELS = 64;

export class ItImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ItImportError';
  }
}

function fail(message) {
  throw new ItImportError(message);
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
 * IT note 0..119 -> MIDI (C-5 = 60). 255 note off, 254 note cut.
 * @param {number} note
 * @returns {number|null|-1} -1 off/cut; null empty/invalid
 */
export function itNoteToMidi(note) {
  if (note === 255 || note === 254) return -1;
  if (note > 119) return null;
  return note;
}

/**
 * @param {import('./tracker-common.mjs').TrackerCell} cell
 * @param {number} command A=1
 * @param {number} value
 */
function applyCommand(cell, command, value) {
  if (command === 1) {
    if (value > 0) cell.setSpeed = value;
  } else if (command === 2) {
    cell.positionJump = value;
  } else if (command === 3) {
    cell.patternBreak = bcdRow(value);
  } else if (command === 20) {
    if (value > 0) cell.setTempo = value;
  } else if (command === 19 && (value >> 4) === 0x0c) {
    cell.noteCutTicks = value & 0x0f;
  }
}

function cellUsed(cell) {
  if (!cell) return false;
  return (
    cell.midi != null ||
    cell.noteCut ||
    cell.instrument != null ||
    cell.volume != null ||
    cell.setSpeed != null ||
    cell.setTempo != null ||
    cell.positionJump != null ||
    cell.patternBreak != null ||
    cell.noteCutTicks != null
  );
}

/**
 * Unpack one IT pattern. Never reads past offset + 8 + packedLength.
 * @param {Uint8Array} data
 * @param {number} offset pattern start
 * @returns {{ rows: import('./tracker-common.mjs').TrackerCell[][], rowCount: number }}
 */
function unpackPattern(data, offset) {
  if (offset + 8 > data.length) fail('truncated IT pattern header');
  const packedLength = readUint16LE(data, offset);
  const rowCount = readUint16LE(data, offset + 2);
  const dataStart = offset + 8;
  const end = dataStart + packedLength;
  if (end > data.length) fail('truncated IT pattern data');

  const out = Array.from({ length: rowCount }, () =>
    Array.from({ length: IT_MAX_CHANNELS }, () => (/** @type {import('./tracker-common.mjs').TrackerCell} */ ({}))),
  );

  const lastMask = Array.from({ length: IT_MAX_CHANNELS }, () => 0);
  const lastNote = Array.from({ length: IT_MAX_CHANNELS }, () => /** @type {number|null} */ (null));
  const lastInstrument = Array.from({ length: IT_MAX_CHANNELS }, () => /** @type {number|null} */ (null));
  const lastVolume = Array.from({ length: IT_MAX_CHANNELS }, () => /** @type {number|null} */ (null));
  const lastCommand = Array.from({ length: IT_MAX_CHANNELS }, () => /** @type {number|null} */ (null));
  const lastValue = Array.from({ length: IT_MAX_CHANNELS }, () => /** @type {number|null} */ (null));

  let i = dataStart;
  let row = 0;
  while (i < end && row < rowCount) {
    const b = data[i++];
    if (b === 0) {
      row += 1;
      continue;
    }
    const ch = (b - 1) & 63;
    let mask;
    if (b & 128) {
      if (i >= end) fail('truncated IT mask');
      mask = data[i++];
      lastMask[ch] = mask;
    } else {
      mask = lastMask[ch];
    }

    let note = null;
    let instrument = null;
    let volume = null;
    let command = null;
    let value = null;

    if (mask & 1) {
      if (i >= end) fail('truncated IT note');
      note = data[i++];
      lastNote[ch] = note;
    }
    if (mask & 2) {
      if (i >= end) fail('truncated IT instrument');
      instrument = data[i++];
      lastInstrument[ch] = instrument;
    }
    if (mask & 4) {
      if (i >= end) fail('truncated IT volume');
      volume = data[i++];
      lastVolume[ch] = volume;
    }
    if (mask & 8) {
      if (i + 2 > end) fail('truncated IT command');
      command = data[i++];
      value = data[i++];
      lastCommand[ch] = command;
      lastValue[ch] = value;
    }
    if (mask & 16) note = lastNote[ch];
    if (mask & 32) instrument = lastInstrument[ch];
    if (mask & 64) volume = lastVolume[ch];
    if (mask & 128) {
      command = lastCommand[ch];
      value = lastValue[ch];
    }

    const cell = out[row][ch];
    if (note != null) {
      const midi = itNoteToMidi(note);
      if (midi === -1) cell.noteCut = true;
      else if (midi != null) cell.midi = midi;
    }
    if (instrument != null && instrument > 0) cell.instrument = instrument;
    if (volume != null && volume <= 64) cell.volume = volume;
    if (command != null && command > 0) applyCommand(cell, command, value ?? 0);
  }

  return { rows: out, rowCount };
}

/**
 * Ensure each pattern plays exactly its own row count under a shared rowsPerPattern.
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
 * Import an IT into a source-song.
 * @param {Uint8Array|Buffer} bytes
 * @param {string} fileName
 */
export function importIt(bytes, fileName) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 0xc0) fail('file too short to be an IT');
  if (readAscii(data, 0, 4) !== 'IMPM') fail('missing IMPM signature');

  const title =
    readAscii(data, 4, 26) || basename(fileName || 'song.it').replace(/\.it$/i, '');
  const ordNum = readUint16LE(data, 0x20);
  const insNum = readUint16LE(data, 0x22);
  const smpNum = readUint16LE(data, 0x24);
  const patNum = readUint16LE(data, 0x26);
  const initialSpeed = data[0x32] || 6;
  const initialTempo = data[0x33] || 125;

  const order = [];
  for (let i = 0; i < ordNum; i++) {
    const o = data[0xc0 + i];
    if (o === 255) break;
    if (o === 254) continue;
    order.push(o);
  }

  const paraBase = 0xc0 + ordNum;
  const insParas = [];
  for (let i = 0; i < insNum; i++) {
    insParas.push(readUint32LE(data, paraBase + i * 4));
  }
  const smpParaBase = paraBase + insNum * 4;
  const patParaBase = smpParaBase + smpNum * 4;
  const patParas = [];
  for (let i = 0; i < patNum; i++) {
    patParas.push(readUint32LE(data, patParaBase + i * 4));
  }

  const instrumentNames = [];
  for (let i = 0; i < insNum; i++) {
    const off = insParas[i];
    if (!off || off + 0x20 + 26 > data.length) {
      instrumentNames.push(`instrument-${i + 1}`);
      continue;
    }
    instrumentNames.push(readAscii(data, off + 0x20, 26) || `instrument-${i + 1}`);
  }

  /** @type {import('./tracker-common.mjs').TrackerCell[][][]} */
  const widePatterns = [];
  let maxRows = 0;
  let channels = 4;

  for (let p = 0; p < patNum; p++) {
    const off = patParas[p];
    if (!off) {
      widePatterns.push(
        Array.from({ length: 64 }, () =>
          Array.from({ length: IT_MAX_CHANNELS }, () => ({})),
        ),
      );
      if (64 > maxRows) maxRows = 64;
      continue;
    }
    const { rows, rowCount } = unpackPattern(data, off);
    for (const row of rows) {
      for (let ch = 0; ch < IT_MAX_CHANNELS; ch++) {
        if (cellUsed(row[ch]) && ch + 1 > channels) channels = ch + 1;
      }
    }
    widePatterns.push(rows);
    if (rowCount > maxRows) maxRows = rowCount;
  }

  if (maxRows < 1) maxRows = 64;

  const patterns = widePatterns.map((pattern) =>
    pattern.map((row) => {
      const cells = row.slice(0, channels);
      while (cells.length < channels) cells.push({});
      return cells;
    }),
  );

  normalizePatternRows(patterns, channels, maxRows);

  return flattenTrackerToSourceSong({
    bytes: data,
    fileName: fileName || 'song.it',
    title,
    importer: IT_IMPORTER,
    importerVersion: IT_IMPORTER_VERSION,
    order,
    patterns,
    instrumentNames,
    channels,
    initialSpeed,
    initialTempo,
    rowsPerPattern: maxRows,
  });
}
