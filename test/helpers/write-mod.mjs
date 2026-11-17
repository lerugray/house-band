/**
 * Minimal 31-sample MOD writer for OSS-19 fixtures.
 * Sample data is never written (lengths 0); importers read pattern data only.
 */
import { FIXTURE } from './write-midi.mjs';
import { midiToPeriod } from '../../src/cowrite/tracker-common.mjs';

const SIG = 'M.K.';
const CHANNELS = 4;
const ROWS = 64;

/**
 * Pack one MOD channel cell.
 * @param {{ period?: number, instrument?: number, effect?: number, param?: number }} cell
 */
function packCell(cell = {}) {
  const period = cell.period || 0;
  const instrument = cell.instrument || 0;
  const effect = cell.effect || 0;
  const param = cell.param || 0;
  const b0 = ((instrument & 0xf0) | ((period >> 8) & 0x0f)) & 0xff;
  const b1 = period & 0xff;
  const b2 = (((instrument & 0x0f) << 4) | (effect & 0x0f)) & 0xff;
  const b3 = param & 0xff;
  return Buffer.from([b0, b1, b2, b3]);
}

function emptyCell() {
  return packCell();
}

function noteCell(midi, instrument, effect = 0, param = 0) {
  const period = midiToPeriod(midi);
  if (period == null) throw new Error(`midi ${midi} out of MOD period table`);
  return packCell({ period, instrument, effect, param });
}

/**
 * Build the shared musical fixture (and optional effect tests) as a MOD Buffer.
 *
 * Layout (4 channels, 1-based in the card):
 *   ch1 melody, ch2 bass, ch3 drums (BD/SD), ch4 unused.
 * Speed/tempo: F06 then F78 on row 0 (effective BPM 120).
 * B00 on the last musical row (31) ends without looping.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.noteCutDemo] put EC3 on a long melody note for cut tests
 * @returns {Buffer}
 */
export function writeMod(opts = {}) {
  const melody = opts.melody ?? FIXTURE.melody;
  const bass = opts.bass ?? FIXTURE.bass;
  const drums = opts.drums ?? FIXTURE.drums;

  const buf = Buffer.alloc(1084 + 64 * CHANNELS * 4);
  buf.write('fixture', 0, 20, 'ascii');

  // 31 sample headers (30 bytes each). Names only; length 0.
  const names = ['Melody', 'Bass', 'BD', 'SD'];
  for (let i = 0; i < 31; i++) {
    const off = 20 + i * 30;
    const name = names[i] || '';
    buf.write(name, off, 22, 'ascii');
    // length words BE = 0; finetune 0; volume 64; loop 0/1
    buf[off + 25] = 64;
    buf.writeUInt16BE(1, off + 28); // loop length 1 word (PT convention for no loop)
  }

  buf[950] = 1; // song length
  buf[951] = 0; // restart
  buf[952] = 0; // order: pattern 0
  buf.write(SIG, 1080, 4, 'ascii');

  /** @type {Buffer[][]} rows[row][ch] */
  const grid = Array.from({ length: ROWS }, () =>
    Array.from({ length: CHANNELS }, () => emptyCell()),
  );

  // Row 0: set speed 6 and tempo 120 (F06 on ch1, F78 on ch2), with first notes.
  // Effects share the note cell when possible.
  const mel0 = melody[0];
  const bass0 = bass[0];
  grid[0][0] = noteCell(mel0.midi, 1, 0x0f, 0x06); // F06 speed
  grid[0][1] = noteCell(bass0.midi, 2, 0x0f, 0x78); // F78 tempo 120

  // Remaining melody (skip index 0 placed above)
  for (let i = 1; i < melody.length; i++) {
    const n = melody[i];
    const row = Math.round(n.beat * 4);
    if (opts.noteCutDemo && i === 1) {
      // Long note with EC3: lasts 3 ticks only.
      grid[row][0] = noteCell(n.midi, 1, 0x0e, 0xc3);
    } else {
      grid[row][0] = noteCell(n.midi, 1);
    }
  }

  for (let i = 1; i < bass.length; i++) {
    const n = bass[i];
    const row = Math.round(n.beat * 4);
    grid[row][1] = noteCell(n.midi, 2);
  }

  // Drums: BD (inst 3) on midi kicks, SD (inst 4) on snares. Pitch at native rate (60).
  for (const n of drums) {
    const row = Math.round(n.beat * 4);
    const isKick = n.midi === 36;
    grid[row][2] = noteCell(60, isKick ? 3 : 4);
  }

  // B00 on last musical row (beat 7.75 -> row 31) ends without looping.
  const lastRow = 31;
  if (grid[lastRow][3].equals(emptyCell())) {
    grid[lastRow][3] = packCell({ effect: 0x0b, param: 0x00 });
  } else {
    grid[lastRow][3] = packCell({ effect: 0x0b, param: 0x00 });
  }

  let o = 1084;
  for (let row = 0; row < ROWS; row++) {
    for (let ch = 0; ch < CHANNELS; ch++) {
      grid[row][ch].copy(buf, o);
      o += 4;
    }
  }

  return buf;
}

/** Shared fixture MOD (speed 6, tempo 120, B00 end). */
export function writeFixtureMod(opts = {}) {
  return writeMod(opts);
}
