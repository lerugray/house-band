/**
 * Minimal SoundFont 2.01 writer for OSS-15 acceptance fixtures.
 * Builds one preset "Test Keys", one instrument (global + two zones),
 * samples A and B as short sines, plus a right-channel sample that import skips.
 */

import { writeFileSync } from 'node:fs';

export const FIXTURE = Object.freeze({
  presetName: 'Test Keys',
  sampleRate: 44100,
  /** Sample A: 100 frames, zone keyRange 0-59, overridingRootKey 48 */
  sampleA: Object.freeze({ name: 'A', frames: 100, root: 48, lo: 0, hi: 59 }),
  /** Sample B: 200 frames, byOriginalPitch 72, zone keyRange 60-127 */
  sampleB: Object.freeze({ name: 'B', frames: 200, originalPitch: 72, lo: 60, hi: 127 }),
  /** Right-channel twin of B; must be skipped by import */
  sampleRight: Object.freeze({ name: 'B-R', frames: 200 }),
  padding: 46,
});

function writeCString(buf, offset, text, len) {
  buf.fill(0, offset, offset + len);
  Buffer.from(String(text), 'ascii').copy(buf, offset, 0, Math.min(String(text).length, len - 1));
}

function sinePcm16(frames, sampleRate, freqHz) {
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const s = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 16000))), i * 2);
  }
  return out;
}

function chunk(id, body) {
  const size = body.length;
  const pad = size % 2;
  const buf = Buffer.alloc(8 + size + pad);
  buf.write(id, 0, 4, 'ascii');
  buf.writeUInt32LE(size, 4);
  body.copy(buf, 8);
  return buf;
}

function listChunk(type, parts) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), ...parts]);
  return chunk('LIST', body);
}

function makePhdr({ name, preset, bank, bagNdx }) {
  const buf = Buffer.alloc(38);
  writeCString(buf, 0, name, 20);
  buf.writeUInt16LE(preset, 20);
  buf.writeUInt16LE(bank, 22);
  buf.writeUInt16LE(bagNdx, 24);
  buf.writeUInt32LE(0, 26);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(0, 34);
  return buf;
}

function makeBag(genNdx, modNdx = 0) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16LE(genNdx, 0);
  buf.writeUInt16LE(modNdx, 2);
  return buf;
}

function makeGen(oper, amount) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16LE(oper, 0);
  buf.writeUInt16LE(amount & 0xffff, 2);
  return buf;
}

function makeKeyRange(lo, hi) {
  return makeGen(43, (hi << 8) | lo);
}

function makeInst(name, bagNdx) {
  const buf = Buffer.alloc(22);
  writeCString(buf, 0, name, 20);
  buf.writeUInt16LE(bagNdx, 20);
  return buf;
}

function makeShdr({
  name,
  start,
  end,
  startloop,
  endloop,
  sampleRate,
  byOriginalPitch,
  sampleLink,
  sampleType,
}) {
  const buf = Buffer.alloc(46);
  writeCString(buf, 0, name, 20);
  buf.writeUInt32LE(start, 20);
  buf.writeUInt32LE(end, 24);
  buf.writeUInt32LE(startloop, 28);
  buf.writeUInt32LE(endloop, 32);
  buf.writeUInt32LE(sampleRate, 36);
  buf.writeUInt8(byOriginalPitch, 40);
  buf.writeInt8(0, 41);
  buf.writeUInt16LE(sampleLink, 42);
  buf.writeUInt16LE(sampleType, 44);
  return buf;
}

function makeModTerminal() {
  return Buffer.alloc(10); // zeroed terminal modulator
}

/**
 * Build a valid minimal SF2 buffer matching the OSS-15 acceptance fixture.
 * @returns {{ buffer: Buffer, meta: typeof FIXTURE & { sampleAStart: number, sampleBStart: number } }}
 */
export function buildTestSf2() {
  const { sampleRate, sampleA, sampleB, sampleRight, padding, presetName } = FIXTURE;

  const pcmA = sinePcm16(sampleA.frames, sampleRate, 440);
  const pcmB = sinePcm16(sampleB.frames, sampleRate, 660);
  const pcmR = sinePcm16(sampleRight.frames, sampleRate, 660);
  const pad = Buffer.alloc(padding * 2); // 46 zero sample points

  // smpl layout: A | pad | B | pad | Right | pad
  let cursor = 0;
  const startA = cursor;
  cursor += sampleA.frames;
  const endA = cursor;
  cursor += padding;
  const startB = cursor;
  cursor += sampleB.frames;
  const endB = cursor;
  cursor += padding;
  const startR = cursor;
  cursor += sampleRight.frames;
  const endR = cursor;
  cursor += padding;

  const smpl = Buffer.concat([pcmA, pad, pcmB, pad, pcmR, pad]);

  // Sample types: A mono=1, B left=4 linked to Right, Right=2 linked to B
  const shdr = Buffer.concat([
    makeShdr({
      name: sampleA.name,
      start: startA,
      end: endA,
      startloop: startA,
      endloop: endA,
      sampleRate,
      byOriginalPitch: 60,
      sampleLink: 0,
      sampleType: 1,
    }),
    makeShdr({
      name: sampleB.name,
      start: startB,
      end: endB,
      startloop: startB,
      endloop: endB,
      sampleRate,
      byOriginalPitch: sampleB.originalPitch,
      sampleLink: 2,
      sampleType: 4,
    }),
    makeShdr({
      name: sampleRight.name,
      start: startR,
      end: endR,
      startloop: startR,
      endloop: endR,
      sampleRate,
      byOriginalPitch: sampleB.originalPitch,
      sampleLink: 1,
      sampleType: 2,
    }),
    makeShdr({
      name: 'EOS',
      start: 0,
      end: 0,
      startloop: 0,
      endloop: 0,
      sampleRate: 0,
      byOriginalPitch: 0,
      sampleLink: 0,
      sampleType: 0,
    }),
  ]);

  // Instrument zones:
  //   bag0 global (empty gens) — global zone
  //   bag1 keyRange 0-59, sampleID 0, overridingRootKey 48  (gens ascending: 43,53,58)
  //   bag2 keyRange 60-127, sampleID 1
  //   bag3 zone pointing at right sample (sampleID 2) — import must skip
  //   bag4 terminal
  const igen = Buffer.concat([
    // zone 1 (local): keyRange, sampleID A, overridingRootKey
    makeKeyRange(sampleA.lo, sampleA.hi),
    makeGen(53, 0),
    makeGen(58, sampleA.root),
    // zone 2: keyRange, sampleID B
    makeKeyRange(sampleB.lo, sampleB.hi),
    makeGen(53, 1),
    // zone 3: keyRange covering all, sampleID right — skipped
    makeKeyRange(0, 127),
    makeGen(53, 2),
  ]);

  const ibag = Buffer.concat([
    makeBag(0), // global: gens [0,0) empty
    makeBag(0), // zone1: gens [0,3)
    makeBag(3), // zone2: gens [3,5)
    makeBag(5), // zone3 right: gens [5,7)
    makeBag(7), // terminal
  ]);

  const inst = Buffer.concat([
    makeInst('Test Inst', 0),
    makeInst('EOI', 4),
  ]);

  // Preset: one local zone -> instrument 0
  const pgen = Buffer.concat([makeGen(41, 0)]);
  const pbag = Buffer.concat([makeBag(0), makeBag(1)]);
  const phdr = Buffer.concat([
    makePhdr({ name: presetName, preset: 0, bank: 0, bagNdx: 0 }),
    makePhdr({ name: 'EOP', preset: 0, bank: 0, bagNdx: 1 }),
  ]);

  // Empty modulator lists (terminal only)
  const pmod = makeModTerminal();
  const imod = makeModTerminal();

  const info = listChunk('INFO', [
    chunk('ifil', (() => {
      const b = Buffer.alloc(4);
      b.writeUInt16LE(2, 0);
      b.writeUInt16LE(1, 2);
      return b;
    })()),
    chunk('isng', Buffer.from('EMU8000\0')),
    chunk('INAM', Buffer.from('Test SF2\0')),
  ]);

  const sdta = listChunk('sdta', [chunk('smpl', smpl)]);
  const pdta = listChunk('pdta', [
    chunk('phdr', phdr),
    chunk('pbag', pbag),
    chunk('pmod', pmod),
    chunk('pgen', pgen),
    chunk('inst', inst),
    chunk('ibag', ibag),
    chunk('imod', imod),
    chunk('igen', igen),
    chunk('shdr', shdr),
  ]);

  const formBody = Buffer.concat([Buffer.from('sfbk', 'ascii'), info, sdta, pdta]);
  const buffer = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    (() => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(formBody.length, 0);
      return size;
    })(),
    formBody,
  ]);

  return {
    buffer,
    meta: {
      ...FIXTURE,
      sampleAStart: startA,
      sampleBStart: startB,
      sampleAFrames: sampleA.frames,
      sampleBFrames: sampleB.frames,
    },
  };
}

/**
 * Write the fixture SF2 to disk.
 * @param {string} path
 */
export function writeTestSf2(path) {
  const { buffer, meta } = buildTestSf2();
  writeFileSync(path, buffer);
  return meta;
}
