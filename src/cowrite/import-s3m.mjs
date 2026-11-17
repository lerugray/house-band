/**
 * Scream Tracker 3 S3M importer (OSS-19).
 */
import { basename } from 'node:path';

import {
  bcdRow,
  flattenTrackerToSourceSong,
  readAscii,
  readUint16LE,
  s3mNoteToMidi,
} from './tracker-common.mjs';

export const S3M_IMPORTER = 's3m';
export const S3M_IMPORTER_VERSION = '1';

export class S3mImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'S3mImportError';
  }
}

function fail(message) {
  throw new S3mImportError(message);
}

/**
 * Decode S3M effect command letter index (A=1) + info into cell fields.
 * @param {import('./tracker-common.mjs').TrackerCell} cell
 * @param {number} command
 * @param {number} info
 */
function applyCommand(cell, command, info) {
  // A=1 speed, B=2 jump, C=3 break, S=19, T=20
  if (command === 1) {
    if (info > 0) cell.setSpeed = info;
  } else if (command === 2) {
    cell.positionJump = info;
  } else if (command === 3) {
    cell.patternBreak = bcdRow(info);
  } else if (command === 20) {
    if (info > 0) cell.setTempo = info;
  } else if (command === 19 && (info >> 4) === 0x0c) {
    cell.noteCutTicks = info & 0x0f;
  }
}

/**
 * Unpack one S3M pattern at para*16 into 64 rows of channel cells.
 * @param {Uint8Array} data
 * @param {number} offset
 * @param {number} channels active channel count (max 32)
 * @returns {import('./tracker-common.mjs').TrackerCell[][]}
 */
function unpackPattern(data, offset, channels) {
  if (offset + 2 > data.length) fail('truncated S3M pattern');
  const packedLen = readUint16LE(data, offset);
  let i = offset + 2;
  const end = i + packedLen;
  if (end > data.length) fail('truncated S3M pattern data');

  const rows = Array.from({ length: 64 }, () =>
    Array.from({ length: channels }, () => (/** @type {import('./tracker-common.mjs').TrackerCell} */ ({}))),
  );

  let row = 0;
  while (i < end && row < 64) {
    const b = data[i++];
    if (b === 0) {
      row += 1;
      continue;
    }
    const ch = b & 31;
    let note = null;
    let instrument = null;
    let volume = null;
    let command = null;
    let info = null;

    if (b & 0x20) {
      if (i + 2 > end) fail('truncated S3M note');
      note = data[i++];
      instrument = data[i++];
    }
    if (b & 0x40) {
      if (i >= end) fail('truncated S3M volume');
      volume = data[i++];
    }
    if (b & 0x80) {
      if (i + 2 > end) fail('truncated S3M command');
      command = data[i++];
      info = data[i++];
    }

    if (ch >= channels) continue;
    const cell = rows[row][ch];

    if (note != null) {
      const midi = s3mNoteToMidi(note);
      if (midi === -1) cell.noteCut = true;
      else if (midi != null) cell.midi = midi;
    }
    if (instrument != null && instrument > 0) cell.instrument = instrument;
    if (volume != null && volume !== 255) {
      // ST3 volume column 0..64
      cell.volume = Math.min(64, volume);
    }
    if (command != null && command > 0) applyCommand(cell, command, info ?? 0);
  }

  return rows;
}

/**
 * Import an S3M into a source-song.
 * @param {Uint8Array|Buffer} bytes
 * @param {string} fileName
 */
export function importS3m(bytes, fileName) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 0x60) fail('file too short to be an S3M');
  if (readAscii(data, 0x2c, 4) !== 'SCRM') fail('missing SCRM signature');

  const title =
    readAscii(data, 0, 28) || basename(fileName || 'song.s3m').replace(/\.s3m$/i, '');
  const ordNum = readUint16LE(data, 0x20);
  const insNum = readUint16LE(data, 0x22);
  const patNum = readUint16LE(data, 0x24);
  const initialSpeed = data[0x31] || 6;
  const initialTempo = data[0x32] || 125;

  // Channel settings: 255 = unused. Count max used channel index + 1.
  let channels = 0;
  for (let ch = 0; ch < 32; ch++) {
    if (data[0x40 + ch] !== 255) channels = ch + 1;
  }
  if (channels === 0) channels = 4;

  const order = [];
  for (let i = 0; i < ordNum; i++) {
    const o = data[0x60 + i];
    if (o === 255) break;
    if (o === 254) continue; // skip marker
    order.push(o);
  }

  const paraBase = 0x60 + ordNum;
  const insParas = [];
  for (let i = 0; i < insNum; i++) {
    insParas.push(readUint16LE(data, paraBase + i * 2));
  }
  const patParas = [];
  const patParaBase = paraBase + insNum * 2;
  for (let i = 0; i < patNum; i++) {
    patParas.push(readUint16LE(data, patParaBase + i * 2));
  }

  const instrumentNames = [];
  for (let i = 0; i < insNum; i++) {
    const para = insParas[i];
    if (!para) {
      instrumentNames.push(`instrument-${i + 1}`);
      continue;
    }
    const off = para * 16;
    if (off + 0x30 + 28 > data.length) {
      instrumentNames.push(`instrument-${i + 1}`);
      continue;
    }
    instrumentNames.push(readAscii(data, off + 0x30, 28) || `instrument-${i + 1}`);
  }

  /** @type {import('./tracker-common.mjs').TrackerCell[][][]} */
  const patterns = [];
  for (let p = 0; p < patNum; p++) {
    const para = patParas[p];
    if (!para) {
      patterns.push(
        Array.from({ length: 64 }, () =>
          Array.from({ length: channels }, () => ({})),
        ),
      );
      continue;
    }
    patterns.push(unpackPattern(data, para * 16, channels));
  }

  return flattenTrackerToSourceSong({
    bytes: data,
    fileName: fileName || 'song.s3m',
    title,
    importer: S3M_IMPORTER,
    importerVersion: S3M_IMPORTER_VERSION,
    order,
    patterns,
    instrumentNames,
    channels,
    initialSpeed,
    initialTempo,
    rowsPerPattern: 64,
  });
}
