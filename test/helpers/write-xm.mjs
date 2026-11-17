/**
 * Minimal XM writer for OSS-20 fixtures.
 * Instrument headers carry names only; no sample PCM is written.
 * Packed pattern data mixes compressed (flag) and uncompressed note forms.
 */
import { FIXTURE } from './write-midi.mjs';
import { midiToXmNote } from '../../src/cowrite/import-xm.mjs';

const CHANNELS = 4;
const ROWS = 64;
const HEADER_SIZE = 276; // standard FT2 song header size from offset 60

function writeUint16LE(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}

function writeUint32LE(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

/**
 * Pack one XM channel cell.
 * @param {{ note?: number, instrument?: number, volume?: number, effect?: number, param?: number, packed?: boolean }} cell
 * @returns {Buffer}
 */
function packCell(cell = {}) {
  const note = cell.note || 0;
  const instrument = cell.instrument || 0;
  const volume = cell.volume || 0;
  const effect = cell.effect || 0;
  const param = cell.param || 0;
  // Explicit uncompressed form when requested; otherwise compress.
  if (cell.packed === false) {
    return Buffer.from([note, instrument, volume, effect, param]);
  }
  let flags = 0x80;
  const body = [];
  if (note) {
    flags |= 0x01;
    body.push(note);
  }
  if (instrument) {
    flags |= 0x02;
    body.push(instrument);
  }
  if (volume) {
    flags |= 0x04;
    body.push(volume);
  }
  if (effect || param) {
    flags |= 0x08;
    body.push(effect);
    flags |= 0x10;
    body.push(param);
  }
  return Buffer.from([flags, ...body]);
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.noteCutDemo] key-off after a melody note
 * @param {boolean} [opts.keyOffDemo] alias of noteCutDemo (XM key-off 97)
 * @returns {Buffer}
 */
export function writeXm(opts = {}) {
  const melody = opts.melody ?? FIXTURE.melody;
  const bass = opts.bass ?? FIXTURE.bass;
  const drums = opts.drums ?? FIXTURE.drums;
  const keyOff = opts.keyOffDemo || opts.noteCutDemo;

  /** @type {Record<string, any>[][]} */
  const grid = Array.from({ length: ROWS }, () =>
    Array.from({ length: CHANNELS }, () => null),
  );

  const put = (row, ch, cell) => {
    grid[row][ch] = { ...(grid[row][ch] || {}), ...cell };
  };

  // Mix packing: even melody indices uncompressed, odd compressed.
  put(0, 0, {
    note: midiToXmNote(melody[0].midi),
    instrument: 1,
    effect: 0x0f,
    param: 0x06, // F06 speed
    packed: false,
  });
  put(0, 1, {
    note: midiToXmNote(bass[0].midi),
    instrument: 2,
    effect: 0x0f,
    param: 0x78, // F78 tempo 120
    packed: true,
  });

  for (let i = 1; i < melody.length; i++) {
    const n = melody[i];
    const row = Math.round(n.beat * 4);
    const useUncompressed = i % 2 === 0;
    if (keyOff && i === 1) {
      // Note at beat 1, key-off two rows later (half a beat) ends it.
      put(row, 0, {
        note: midiToXmNote(n.midi),
        instrument: 1,
        packed: useUncompressed ? false : true,
      });
      put(row + 2, 0, { note: 97, packed: true }); // key off
    } else {
      put(row, 0, {
        note: midiToXmNote(n.midi),
        instrument: 1,
        packed: useUncompressed ? false : true,
      });
    }
  }

  for (let i = 1; i < bass.length; i++) {
    const n = bass[i];
    const row = Math.round(n.beat * 4);
    put(row, 1, {
      note: midiToXmNote(n.midi),
      instrument: 2,
      packed: true,
    });
  }

  for (const n of drums) {
    const row = Math.round(n.beat * 4);
    const isKick = n.midi === 36;
    put(row, 2, {
      note: midiToXmNote(60),
      instrument: isKick ? 3 : 4,
      packed: false,
    });
  }

  // B00 on last musical row ends without looping.
  put(31, 3, { effect: 0x0b, param: 0x00, packed: true });

  const parts = [];
  for (let row = 0; row < ROWS; row++) {
    for (let ch = 0; ch < CHANNELS; ch++) {
      parts.push(packCell(grid[row][ch] || {}));
    }
  }
  const packed = Buffer.concat(parts);

  const insNum = 4;
  const names = ['Melody', 'Bass', 'BD', 'SD'];
  // Empty instruments: header size 29, num samples 0
  const instBufs = names.map((name) => {
    const b = Buffer.alloc(29);
    writeUint32LE(b, 0, 29);
    b.write(name.slice(0, 22), 4, 22, 'ascii');
    writeUint16LE(b, 27, 0);
    return b;
  });

  const patternsStart = 60 + HEADER_SIZE;
  const patHeaderLen = 9;
  const totalLen =
    patternsStart + patHeaderLen + packed.length + instBufs.reduce((s, b) => s + b.length, 0);
  const buf = Buffer.alloc(totalLen);

  buf.write('Extended Module: ', 0, 17, 'ascii');
  buf.write('fixture', 17, 20, 'ascii');
  buf[37] = 0x1a;
  buf.write('FastTracker II', 38, 20, 'ascii');
  writeUint16LE(buf, 58, 0x0104);
  writeUint32LE(buf, 60, HEADER_SIZE);
  writeUint16LE(buf, 64, 1); // song length
  writeUint16LE(buf, 66, 0); // restart
  writeUint16LE(buf, 68, CHANNELS);
  writeUint16LE(buf, 70, 1); // patterns
  writeUint16LE(buf, 72, insNum);
  writeUint16LE(buf, 74, 1); // flags (linear freq)
  writeUint16LE(buf, 76, 6); // default speed
  writeUint16LE(buf, 78, 120); // default BPM
  buf[80] = 0; // order: pattern 0

  let o = patternsStart;
  writeUint32LE(buf, o, patHeaderLen);
  buf[o + 4] = 0; // packing type
  writeUint16LE(buf, o + 5, ROWS);
  writeUint16LE(buf, o + 7, packed.length);
  packed.copy(buf, o + patHeaderLen);
  o += patHeaderLen + packed.length;

  for (const ib of instBufs) {
    ib.copy(buf, o);
    o += ib.length;
  }

  return buf;
}

/** Shared fixture XM (speed 6, tempo 120, B00 end, mixed pack forms). */
export function writeFixtureXm(opts = {}) {
  return writeXm(opts);
}
