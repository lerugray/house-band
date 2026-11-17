/**
 * Minimal IT writer for OSS-20 fixtures.
 * Instrument headers carry names only; no sample PCM is written.
 * Pattern data uses mask reuse and "last note" flags.
 */
import { FIXTURE } from './write-midi.mjs';

const CHANNELS = 4;
const ROWS = 64;

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
 * Pack IT pattern with mask reuse + last-note where useful.
 * cells[row][ch] = { note?, instrument?, volume?, command?, value?, useLastNote? }
 * @returns {Buffer} 8-byte header + packed data
 */
function packPattern(cells, opts = {}) {
  /** @type {number[]} */
  const lastMask = Array.from({ length: 64 }, () => 0);
  const parts = [];

  for (let row = 0; row < ROWS; row++) {
    const rowCells = cells[row] || [];
    for (let ch = 0; ch < CHANNELS; ch++) {
      const c = rowCells[ch];
      if (!c) continue;

      let mask = 0;
      const body = [];
      if (c.useLastNote) {
        mask |= 16; // last note
        if (c.instrument != null) {
          mask |= 2;
          body.push(c.instrument);
        }
      } else {
        if (c.note != null) {
          mask |= 1;
          body.push(c.note);
        }
        if (c.instrument != null) {
          mask |= 2;
          body.push(c.instrument);
        }
      }
      if (c.volume != null) {
        mask |= 4;
        body.push(c.volume);
      }
      if (c.command != null) {
        mask |= 8;
        body.push(c.command);
        body.push(c.value ?? 0);
      }

      // Channel byte: (ch+1) | 0x80 when sending a new mask.
      const reuse = !opts.forceNewMask && lastMask[ch] === mask && mask !== 0;
      if (reuse) {
        parts.push(Buffer.from([(ch + 1) & 0x7f, ...body]));
      } else {
        parts.push(Buffer.from([(ch + 1) | 0x80, mask, ...body]));
        lastMask[ch] = mask;
      }
    }
    parts.push(Buffer.from([0])); // end of row
  }

  const packed = Buffer.concat(parts);
  // Optional poison bytes after stated length (importer must not read them).
  const poison = opts.poisonAfter ? Buffer.from(opts.poisonAfter) : Buffer.alloc(0);
  const out = Buffer.alloc(8 + packed.length + poison.length);
  writeUint16LE(out, 0, packed.length); // stated length excludes poison
  writeUint16LE(out, 2, ROWS);
  // reserved 4 bytes already 0
  packed.copy(out, 8);
  if (poison.length) poison.copy(out, 8 + packed.length);
  return out;
}

function writeInstrument(name) {
  const buf = Buffer.alloc(0x232); // enough for IMPI header with name at 0x20
  buf.write('IMPI', 0, 4, 'ascii');
  buf.write(name.slice(0, 12), 4, 12, 'ascii');
  buf.write(name.slice(0, 26), 0x20, 26, 'ascii');
  return buf;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.noteCutDemo] note-off after a melody note
 * @param {boolean} [opts.keyOffDemo] alias: IT note off 255
 * @param {boolean} [opts.poisonPattern] append unread poison notes after packed length
 * @returns {Buffer}
 */
export function writeIt(opts = {}) {
  const melody = opts.melody ?? FIXTURE.melody;
  const bass = opts.bass ?? FIXTURE.bass;
  const drums = opts.drums ?? FIXTURE.drums;
  const keyOff = opts.keyOffDemo || opts.noteCutDemo;

  const cells = Array.from({ length: ROWS }, () => Array(CHANNELS).fill(null));
  const put = (row, ch, cell) => {
    cells[row][ch] = { ...(cells[row][ch] || {}), ...cell };
  };

  // First melody/bass with full mask; later bass uses last-note + new instrument mask reuse.
  put(0, 0, { note: melody[0].midi, instrument: 1 });
  put(0, 1, { note: bass[0].midi, instrument: 2 });

  for (let i = 1; i < melody.length; i++) {
    const n = melody[i];
    const row = Math.round(n.beat * 4);
    if (keyOff && i === 1) {
      put(row, 0, { note: n.midi, instrument: 1 });
      put(row + 2, 0, { note: 255 }); // note off
    } else if (i >= 2) {
      // Mask reuse + last-note on channel 0 for some hits: same mask as prior note+inst.
      put(row, 0, { note: n.midi, instrument: 1 });
    } else {
      put(row, 0, { note: n.midi, instrument: 1 });
    }
  }

  // Bass at beat 4: use last-note flag (note C3 was last on ch1... actually last was G2's predecessor).
  // Place bass[1] with useLastNote after writing a marker that set last note — simpler: write note normally
  // then a following empty-row reuse is hard. Instead: on channel 1, first cell sets note, a later
  // cell uses useLastNote with instrument only to demonstrate the flag (same pitch retrigger).
  // For pitch accuracy we still emit real notes for bass[1]:
  for (let i = 1; i < bass.length; i++) {
    const n = bass[i];
    const row = Math.round(n.beat * 4);
    put(row, 1, { note: n.midi, instrument: 2 });
  }

  // Dedicated last-note demo on an unused late row that does not affect fixture pitches:
  // After bass note at row 16 (beat 4), row 17 retriggers last note via flag 16 (same midi) —
  // that would ADD a note and break the fixture. So instead encode melody note at beat 2
  // (index 2) as useLastNote: write note on a dummy prep... 
  // Practical approach: first melody note sets last; second melody uses useLastNote with new pitch
  // WRONG — last-note replays previous pitch.
  // So last-note demo must be a retrigger of the same pitch, not used for fixture pitches.
  // Place on channel 3 row 30: note 60, then row 30 is end marker channel — use ch3 row 15:
  put(15, 3, { note: 60, instrument: 1 });
  put(16, 3, { useLastNote: true, instrument: 1 }); // retrigger C4 via last-note; cut by next events
  put(17, 3, { note: 255 }); // off so it does not extend into B00 row

  for (const n of drums) {
    const row = Math.round(n.beat * 4);
    const isKick = n.midi === 36;
    put(row, 2, { note: 60, instrument: isKick ? 3 : 4 });
  }

  // B00 on last musical row.
  put(31, 3, { command: 2, value: 0x00 });

  const poison = opts.poisonPattern
    ? // Fake channel event that would add midi 90 on row after end if over-read
      [0x81, 0x03, 90, 1, 0]
    : null;
  const patternBuf = packPattern(cells, { poisonAfter: poison });

  const insNum = 4;
  const smpNum = 0;
  const patNum = 1;
  const ordNum = 2; // pattern 0, 255 end
  const instruments = ['Melody', 'Bass', 'BD', 'SD'].map(writeInstrument);

  // Layout: header through orders + paras, then instruments, then pattern.
  const paraBase = 0xc0 + ordNum;
  const headerEnd = paraBase + insNum * 4 + smpNum * 4 + patNum * 4;

  let cursor = (headerEnd + 15) & ~15;
  const insOffsets = [];
  for (const inst of instruments) {
    insOffsets.push(cursor);
    cursor += inst.length;
  }
  const patOffset = cursor;
  const totalLen = patOffset + patternBuf.length;

  const buf = Buffer.alloc(totalLen);
  buf.write('IMPM', 0, 4, 'ascii');
  buf.write('fixture', 4, 26, 'ascii');
  // PHilight / OrdNum / InsNum / SmpNum / PatNum
  writeUint16LE(buf, 0x20, ordNum);
  writeUint16LE(buf, 0x22, insNum);
  writeUint16LE(buf, 0x24, smpNum);
  writeUint16LE(buf, 0x26, patNum);
  writeUint16LE(buf, 0x28, 0x1000); // Cwt/v
  writeUint16LE(buf, 0x2a, 0x200); // Cmwt
  writeUint16LE(buf, 0x2c, 0x0004); // Flags: instrument mode
  writeUint16LE(buf, 0x2e, 0); // special
  buf[0x30] = 128; // GV
  buf[0x31] = 48; // MV
  buf[0x32] = 6; // speed
  buf[0x33] = 120; // tempo
  buf[0x34] = 128; // SEP
  buf[0x35] = 128; // PWD

  buf[0xc0] = 0; // order
  buf[0xc1] = 255; // end

  for (let i = 0; i < insNum; i++) writeUint32LE(buf, paraBase + i * 4, insOffsets[i]);
  writeUint32LE(buf, paraBase + insNum * 4 + smpNum * 4, patOffset);

  for (let i = 0; i < insNum; i++) {
    instruments[i].copy(buf, insOffsets[i]);
  }
  patternBuf.copy(buf, patOffset);

  return buf;
}

/** Shared fixture IT (speed 6, tempo 120, mask reuse / last-note, B00 end). */
export function writeFixtureIt(opts = {}) {
  return writeIt(opts);
}
