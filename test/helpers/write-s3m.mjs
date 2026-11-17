/**
 * Minimal S3M writer for OSS-19 fixtures.
 * Instrument headers carry names only; no sample PCM is written.
 */
import { FIXTURE } from './write-midi.mjs';
import { midiToS3mNote } from '../../src/cowrite/tracker-common.mjs';

const CHANNELS = 4;
const ROWS = 64;

function writeUint16LE(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}

/**
 * Pack one S3M pattern from a sparse map: cells[row][ch] = { note?, instrument?, volume?, command?, info? }
 * @returns {Buffer}
 */
function packPattern(cells) {
  const parts = [];
  for (let row = 0; row < ROWS; row++) {
    const rowCells = cells[row] || [];
    for (let ch = 0; ch < CHANNELS; ch++) {
      const c = rowCells[ch];
      if (!c) continue;
      let flags = ch & 31;
      const body = [];
      if (c.note != null || c.instrument != null) {
        flags |= 0x20;
        body.push(c.note != null ? c.note : 255);
        body.push(c.instrument != null ? c.instrument : 0);
      }
      if (c.volume != null) {
        flags |= 0x40;
        body.push(c.volume);
      }
      if (c.command != null) {
        flags |= 0x80;
        body.push(c.command);
        body.push(c.info ?? 0);
      }
      parts.push(Buffer.from([flags, ...body]));
    }
    parts.push(Buffer.from([0])); // end of row
  }
  const packed = Buffer.concat(parts);
  const out = Buffer.alloc(2 + packed.length);
  writeUint16LE(out, 0, packed.length);
  packed.copy(out, 2);
  return out;
}

/**
 * Write a minimal instrument (type 1 sample) with a name; no PCM.
 * @param {string} name
 * @returns {Buffer}
 */
function writeInstrument(name) {
  const buf = Buffer.alloc(0x50);
  buf[0] = 1; // sample
  buf.write(name.slice(0, 12), 1, 12, 'ascii');
  buf.write(name.slice(0, 28), 0x30, 28, 'ascii');
  buf.write('SCRS', 0x4c, 4, 'ascii');
  return buf;
}

/**
 * Build the shared musical fixture as an S3M Buffer.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.noteCutDemo] put SC3 on a melody note for cut tests
 * @returns {Buffer}
 */
export function writeS3m(opts = {}) {
  const melody = opts.melody ?? FIXTURE.melody;
  const bass = opts.bass ?? FIXTURE.bass;
  const drums = opts.drums ?? FIXTURE.drums;

  const insNum = 4;
  const patNum = 1;
  const ordNum = 2; // pattern 0, then 255 end
  const headerSize = 0x60 + ordNum + insNum * 2 + patNum * 2;

  // Align instrument/pattern bodies to paragraph boundaries.
  const align = (n) => (n + 15) & ~15;

  const instruments = ['Melody', 'Bass', 'BD', 'SD'].map(writeInstrument);
  const cells = Array.from({ length: ROWS }, () => Array(CHANNELS).fill(null));

  const put = (row, ch, cell) => {
    cells[row][ch] = { ...(cells[row][ch] || {}), ...cell };
  };

  // Initial notes + (header already has speed 6 / tempo 120).
  put(0, 0, { note: midiToS3mNote(melody[0].midi), instrument: 1 });
  put(0, 1, { note: midiToS3mNote(bass[0].midi), instrument: 2 });

  for (let i = 1; i < melody.length; i++) {
    const n = melody[i];
    const row = Math.round(n.beat * 4);
    if (opts.noteCutDemo && i === 1) {
      put(row, 0, {
        note: midiToS3mNote(n.midi),
        instrument: 1,
        command: 19, // S
        info: 0xc3, // SC3
      });
    } else {
      put(row, 0, { note: midiToS3mNote(n.midi), instrument: 1 });
    }
  }

  for (let i = 1; i < bass.length; i++) {
    const n = bass[i];
    const row = Math.round(n.beat * 4);
    put(row, 1, { note: midiToS3mNote(n.midi), instrument: 2 });
  }

  for (const n of drums) {
    const row = Math.round(n.beat * 4);
    const isKick = n.midi === 36;
    put(row, 2, { note: midiToS3mNote(60), instrument: isKick ? 3 : 4 });
  }

  // B00 on last musical row ends without looping.
  put(31, 3, { command: 2, info: 0x00 }); // B 00

  const patternBuf = packPattern(cells);

  // Layout: header | pad | instruments | pad | pattern
  let cursor = align(headerSize);
  const insOffsets = [];
  const insBuffers = [];
  for (const inst of instruments) {
    insOffsets.push(cursor / 16);
    insBuffers.push(inst);
    cursor = align(cursor + inst.length);
  }
  const patOffset = cursor / 16;
  const totalLen = cursor + patternBuf.length;

  const buf = Buffer.alloc(totalLen);
  buf.write('fixture', 0, 28, 'ascii');
  buf[0x1c] = 0x1a;
  buf[0x1d] = 16; // ST3
  writeUint16LE(buf, 0x20, ordNum);
  writeUint16LE(buf, 0x22, insNum);
  writeUint16LE(buf, 0x24, patNum);
  writeUint16LE(buf, 0x28, 0x1320); // cwt/v
  writeUint16LE(buf, 0x2a, 2); // ffv
  buf.write('SCRM', 0x2c, 4, 'ascii');
  buf[0x30] = 64; // global vol
  buf[0x31] = 6; // speed
  buf[0x32] = 120; // tempo
  buf[0x33] = 48; // master vol

  for (let ch = 0; ch < 32; ch++) {
    buf[0x40 + ch] = ch < CHANNELS ? ch : 255;
  }

  buf[0x60] = 0; // order: pattern 0
  buf[0x61] = 255; // end

  const paraBase = 0x60 + ordNum;
  for (let i = 0; i < insNum; i++) writeUint16LE(buf, paraBase + i * 2, insOffsets[i]);
  writeUint16LE(buf, paraBase + insNum * 2, patOffset);

  for (let i = 0; i < insNum; i++) {
    insBuffers[i].copy(buf, insOffsets[i] * 16);
  }
  patternBuf.copy(buf, patOffset * 16);

  return buf;
}

/** Shared fixture S3M (speed 6, tempo 120, B00 end). */
export function writeFixtureS3m(opts = {}) {
  return writeS3m(opts);
}
