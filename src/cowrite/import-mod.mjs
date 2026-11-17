/**
 * Amiga ProTracker MOD importer (OSS-19). 31-sample forms only.
 */
import { basename } from 'node:path';

import {
  bcdRow,
  flattenTrackerToSourceSong,
  periodToMidi,
  readAscii,
} from './tracker-common.mjs';

export const MOD_IMPORTER = 'mod';
export const MOD_IMPORTER_VERSION = '1';

const SIGNATURES = new Set(['M.K.', 'M!K!', '4CHN', '6CHN', '8CHN', 'FLT4', 'FLT8']);

const CHANNELS_FOR_SIG = Object.freeze({
  'M.K.': 4,
  'M!K!': 4,
  '4CHN': 4,
  FLT4: 4,
  '6CHN': 6,
  '8CHN': 8,
  FLT8: 8,
});

export class ModImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModImportError';
  }
}

function fail(message) {
  throw new ModImportError(message);
}

/**
 * Decode one MOD channel cell (4 bytes).
 * @returns {import('./tracker-common.mjs').TrackerCell}
 */
function decodeCell(b0, b1, b2, b3) {
  const period = ((b0 & 0x0f) << 8) | b1;
  const instrument = (b0 & 0xf0) | (b2 >> 4);
  const effect = b2 & 0x0f;
  const param = b3;

  /** @type {import('./tracker-common.mjs').TrackerCell} */
  const cell = {};
  if (period > 0) {
    const midi = periodToMidi(period);
    if (midi != null) cell.midi = midi;
  }
  if (instrument > 0) cell.instrument = instrument;

  if (effect === 0x0c) {
    cell.volume = Math.min(64, param);
  } else if (effect === 0x0f) {
    if (param > 0 && param < 32) cell.setSpeed = param;
    else if (param >= 32) cell.setTempo = param;
  } else if (effect === 0x0b) {
    cell.positionJump = param;
  } else if (effect === 0x0d) {
    cell.patternBreak = bcdRow(param);
  } else if (effect === 0x0e && (param >> 4) === 0x0c) {
    cell.noteCutTicks = param & 0x0f;
  }

  return cell;
}

/**
 * Import a 31-sample MOD into a source-song.
 * @param {Uint8Array|Buffer} bytes
 * @param {string} fileName
 */
export function importMod(bytes, fileName) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 1084) fail('file too short to be a MOD');

  const sig = readAscii(data, 1080, 4);
  if (!SIGNATURES.has(sig)) fail('not a 31-sample MOD');
  const channels = CHANNELS_FOR_SIG[sig] || 4;

  const title = readAscii(data, 0, 20) || basename(fileName || 'song.mod').replace(/\.mod$/i, '');

  const instrumentNames = [];
  for (let i = 0; i < 31; i++) {
    const off = 20 + i * 30;
    instrumentNames.push(readAscii(data, off, 22) || `sample-${i + 1}`);
  }

  const songLength = data[950];
  const order = [];
  let maxPat = 0;
  for (let i = 0; i < songLength; i++) {
    const p = data[952 + i];
    order.push(p);
    if (p > maxPat) maxPat = p;
  }
  const numPatterns = maxPat + 1;
  const patternSize = 64 * channels * 4;
  const patternsStart = 1084;
  if (patternsStart + numPatterns * patternSize > data.length) {
    fail('truncated MOD pattern data');
  }

  /** @type {import('./tracker-common.mjs').TrackerCell[][][]} */
  const patterns = [];
  for (let p = 0; p < numPatterns; p++) {
    const base = patternsStart + p * patternSize;
    const rows = [];
    for (let row = 0; row < 64; row++) {
      const cells = [];
      for (let ch = 0; ch < channels; ch++) {
        const o = base + (row * channels + ch) * 4;
        cells.push(decodeCell(data[o], data[o + 1], data[o + 2], data[o + 3]));
      }
      rows.push(cells);
    }
    patterns.push(rows);
  }

  return flattenTrackerToSourceSong({
    bytes: data,
    fileName: fileName || 'song.mod',
    title,
    importer: MOD_IMPORTER,
    importerVersion: MOD_IMPORTER_VERSION,
    order,
    patterns,
    instrumentNames,
    channels,
    initialSpeed: 6,
    initialTempo: 125,
    rowsPerPattern: 64,
  });
}
