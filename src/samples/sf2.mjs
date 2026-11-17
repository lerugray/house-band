/**
 * SF2 (SoundFont 2.01) import for house-band.samples.json (OSS-15).
 * Parses RIFF sfbk, extracts one preset's instrument zones to WAVs + config.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const RECORD = Object.freeze({
  phdr: 38,
  pbag: 4,
  pgen: 4,
  pmod: 10,
  inst: 22,
  ibag: 4,
  igen: 4,
  imod: 10,
  shdr: 46,
});

/** Generator operator names from SoundFont 2.01. */
export const SF2_GENERATOR_NAMES = Object.freeze({
  0: 'startAddrsOffset',
  1: 'endAddrsOffset',
  2: 'startloopAddrsOffset',
  3: 'endloopAddrsOffset',
  4: 'startAddrsCoarseOffset',
  5: 'modLfoToPitch',
  6: 'vibLfoToPitch',
  7: 'modEnvToPitch',
  8: 'initialFilterFc',
  9: 'initialFilterQ',
  10: 'modLfoToFilterFc',
  11: 'modEnvToFilterFc',
  12: 'endAddrsCoarseOffset',
  13: 'modLfoToVolume',
  14: 'unused1',
  15: 'chorusEffectsSend',
  16: 'reverbEffectsSend',
  17: 'pan',
  18: 'unused2',
  19: 'unused3',
  20: 'unused4',
  21: 'delayModLFO',
  22: 'freqModLFO',
  23: 'delayVibLFO',
  24: 'freqVibLFO',
  25: 'delayModEnv',
  26: 'attackModEnv',
  27: 'holdModEnv',
  28: 'decayModEnv',
  29: 'sustainModEnv',
  30: 'releaseModEnv',
  31: 'keynumToModEnvHold',
  32: 'keynumToModEnvDecay',
  33: 'delayVolEnv',
  34: 'attackVolEnv',
  35: 'holdVolEnv',
  36: 'decayVolEnv',
  37: 'sustainVolEnv',
  38: 'releaseVolEnv',
  39: 'keynumToVolEnvHold',
  40: 'keynumToVolEnvDecay',
  41: 'instrument',
  42: 'reserved1',
  43: 'keyRange',
  44: 'velRange',
  45: 'startloopAddrsCoarseOffset',
  46: 'keynum',
  47: 'velocity',
  48: 'initialAttenuation',
  49: 'reserved2',
  50: 'endloopAddrsCoarseOffset',
  51: 'coarseTune',
  52: 'fineTune',
  53: 'sampleID',
  54: 'sampleModes',
  55: 'reserved3',
  56: 'scaleTuning',
  57: 'exclusiveClass',
  58: 'overridingRootKey',
  59: 'unused5',
  60: 'endOper',
});

const GEN_INSTRUMENT = 41;
const GEN_KEY_RANGE = 43;
const GEN_SAMPLE_ID = 53;
const GEN_OVERRIDING_ROOT_KEY = 58;

const SAMPLE_MONO = 1;
const SAMPLE_RIGHT = 2;
const SAMPLE_LEFT = 4;

const USED_GENERATORS = new Set([GEN_INSTRUMENT, GEN_KEY_RANGE, GEN_SAMPLE_ID, GEN_OVERRIDING_ROOT_KEY]);

export class Sf2Error extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number }} [opts]
   */
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = 'Sf2Error';
    this.exitCode = exitCode;
  }
}

/**
 * Slug a name to ^[a-z][a-z0-9-]{0,47}$ or a safe filename stem.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let out = base.replace(/^[^a-z]+/, '') || 'sample';
  if (out.length > 48) out = out.slice(0, 48).replace(/-+$/, '');
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(out)) out = `s-${out}`.slice(0, 48);
  return out;
}

function readCString(buf, offset, maxLen) {
  let end = offset;
  const limit = offset + maxLen;
  while (end < limit && buf[end] !== 0) end += 1;
  return buf.toString('ascii', offset, end);
}

/**
 * Walk RIFF/LIST chunks.
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @param {(id: string, data: Buffer, listType?: string) => void} visit
 */
function walkChunks(buf, start, end, visit) {
  let offset = start;
  while (offset + 8 <= end) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > end) throw new Sf2Error(`RIFF chunk ${id} overruns buffer`);
    if (id === 'LIST') {
      if (size < 4) throw new Sf2Error('LIST chunk too short');
      const listType = buf.toString('ascii', dataStart, dataStart + 4);
      visit(id, buf.subarray(dataStart + 4, dataEnd), listType);
    } else {
      visit(id, buf.subarray(dataStart, dataEnd));
    }
    offset = dataEnd + (size % 2);
  }
}

function parseGenerators(data) {
  if (data.length % RECORD.pgen !== 0) {
    throw new Sf2Error(`generator list length ${data.length} is not a multiple of ${RECORD.pgen}`);
  }
  const out = [];
  for (let i = 0; i + RECORD.pgen <= data.length; i += RECORD.pgen) {
    const oper = data.readUInt16LE(i);
    const amount = data.readUInt16LE(i + 2);
    out.push({
      oper,
      amount,
      lo: amount & 0xff,
      hi: (amount >> 8) & 0xff,
      signed: amount > 0x7fff ? amount - 0x10000 : amount,
    });
  }
  return out;
}

function parseBags(data, size) {
  if (data.length % size !== 0) {
    throw new Sf2Error(`bag list length ${data.length} is not a multiple of ${size}`);
  }
  const out = [];
  for (let i = 0; i + size <= data.length; i += size) {
    out.push({
      genNdx: data.readUInt16LE(i),
      modNdx: data.readUInt16LE(i + 2),
    });
  }
  return out;
}

function gensForBag(bags, gens, bagIndex) {
  if (bagIndex < 0 || bagIndex >= bags.length - 1) return [];
  const start = bags[bagIndex].genNdx;
  const end = bags[bagIndex + 1].genNdx;
  return gens.slice(start, end);
}

function zoneFromGens(gens, terminalOper) {
  const map = new Map();
  for (const g of gens) map.set(g.oper, g);
  const isGlobal = !map.has(terminalOper);
  return { gens, map, isGlobal };
}

/**
 * Parse a SoundFont 2 buffer into typed tables.
 * @param {Buffer} buf
 */
export function parseSf2(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 12) throw new Sf2Error('file too short to be RIFF');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Sf2Error('not a RIFF file');
  if (buf.toString('ascii', 8, 12) !== 'sfbk') throw new Sf2Error('RIFF form is not sfbk');

  const formSize = buf.readUInt32LE(4);
  const formEnd = Math.min(buf.length, 8 + formSize);

  let inam = '';
  /** @type {Buffer | null} */
  let smpl = null;
  /** @type {Buffer | null} */
  let phdrData = null;
  /** @type {Buffer | null} */
  let pbagData = null;
  /** @type {Buffer | null} */
  let pgenData = null;
  /** @type {Buffer | null} */
  let instData = null;
  /** @type {Buffer | null} */
  let ibagData = null;
  /** @type {Buffer | null} */
  let igenData = null;
  /** @type {Buffer | null} */
  let shdrData = null;

  walkChunks(buf, 12, formEnd, (id, data, listType) => {
    if (id === 'LIST' && listType === 'INFO') {
      let o = 0;
      while (o + 8 <= data.length) {
        const infoId = data.toString('ascii', o, o + 4);
        const size = data.readUInt32LE(o + 4);
        const body = data.subarray(o + 8, o + 8 + size);
        if (infoId === 'INAM') inam = readCString(body, 0, body.length).trim();
        o += 8 + size + (size % 2);
      }
      return;
    }
    if (id === 'LIST' && listType === 'sdta') {
      let o = 0;
      while (o + 8 <= data.length) {
        const chunkId = data.toString('ascii', o, o + 4);
        const size = data.readUInt32LE(o + 4);
        const body = data.subarray(o + 8, o + 8 + size);
        if (chunkId === 'smpl') smpl = Buffer.from(body);
        // sm24 ignored
        o += 8 + size + (size % 2);
      }
      return;
    }
    if (id === 'LIST' && listType === 'pdta') {
      let o = 0;
      while (o + 8 <= data.length) {
        const chunkId = data.toString('ascii', o, o + 4);
        const size = data.readUInt32LE(o + 4);
        const body = data.subarray(o + 8, o + 8 + size);
        if (chunkId === 'phdr') phdrData = body;
        else if (chunkId === 'pbag') pbagData = body;
        else if (chunkId === 'pgen') pgenData = body;
        else if (chunkId === 'inst') instData = body;
        else if (chunkId === 'ibag') ibagData = body;
        else if (chunkId === 'igen') igenData = body;
        else if (chunkId === 'shdr') shdrData = body;
        o += 8 + size + (size % 2);
      }
    }
  });

  if (!smpl) throw new Sf2Error('missing sdta smpl chunk');
  if (!phdrData || !pbagData || !pgenData) throw new Sf2Error('missing preset pdta tables');
  if (!instData || !ibagData || !igenData) throw new Sf2Error('missing instrument pdta tables');
  if (!shdrData) throw new Sf2Error('missing shdr chunk');

  if (phdrData.length % RECORD.phdr !== 0) throw new Sf2Error('phdr size invalid');
  if (instData.length % RECORD.inst !== 0) throw new Sf2Error('inst size invalid');
  if (shdrData.length % RECORD.shdr !== 0) throw new Sf2Error('shdr size invalid');

  const pbag = parseBags(pbagData, RECORD.pbag);
  const pgen = parseGenerators(pgenData);
  const ibag = parseBags(ibagData, RECORD.ibag);
  const igen = parseGenerators(igenData);

  const presets = [];
  for (let i = 0; i + RECORD.phdr <= phdrData.length; i += RECORD.phdr) {
    presets.push({
      name: readCString(phdrData, i, 20),
      preset: phdrData.readUInt16LE(i + 20),
      bank: phdrData.readUInt16LE(i + 22),
      bagNdx: phdrData.readUInt16LE(i + 24),
    });
  }
  if (presets.length < 2) throw new Sf2Error('phdr missing terminal record');

  const instruments = [];
  for (let i = 0; i + RECORD.inst <= instData.length; i += RECORD.inst) {
    instruments.push({
      name: readCString(instData, i, 20),
      bagNdx: instData.readUInt16LE(i + 20),
    });
  }
  if (instruments.length < 2) throw new Sf2Error('inst missing terminal record');

  const samples = [];
  for (let i = 0; i + RECORD.shdr <= shdrData.length; i += RECORD.shdr) {
    samples.push({
      name: readCString(shdrData, i, 20),
      start: shdrData.readUInt32LE(i + 20),
      end: shdrData.readUInt32LE(i + 24),
      startloop: shdrData.readUInt32LE(i + 28),
      endloop: shdrData.readUInt32LE(i + 32),
      sampleRate: shdrData.readUInt32LE(i + 36),
      byOriginalPitch: shdrData.readUInt8(i + 40),
      pitchCorrection: shdrData.readInt8(i + 41),
      sampleLink: shdrData.readUInt16LE(i + 42),
      sampleType: shdrData.readUInt16LE(i + 44),
    });
  }
  if (samples.length < 2) throw new Sf2Error('shdr missing terminal record');

  return {
    inam,
    smpl,
    presets: presets.slice(0, -1),
    presetTerminal: presets[presets.length - 1],
    allPresets: presets,
    instruments: instruments.slice(0, -1),
    instrumentTerminal: instruments[instruments.length - 1],
    allInstruments: instruments,
    samples: samples.slice(0, -1),
    sampleTerminal: samples[samples.length - 1],
    pbag,
    pgen,
    ibag,
    igen,
  };
}

/**
 * Encode mono 16-bit PCM WAV at an arbitrary sample rate.
 * @param {Int16Array | Buffer} frames Int16 samples, or a Buffer of little-endian PCM16 bytes
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function encodeMonoPcm16Wav(frames, sampleRate) {
  let pcm;
  if (Buffer.isBuffer(frames)) {
    pcm = frames;
  } else {
    const frameCount = frames.length;
    pcm = Buffer.alloc(frameCount * 2);
    for (let i = 0; i < frameCount; i++) pcm.writeInt16LE(frames[i], i * 2);
  }
  const dataBytes = pcm.length;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  pcm.copy(buf, 44);
  return buf;
}

function noteRootFromSample(sample, overridingRootKey) {
  if (overridingRootKey !== undefined && overridingRootKey !== null) {
    return overridingRootKey;
  }
  const pitch = sample.byOriginalPitch;
  return pitch === 255 ? 60 : pitch;
}

function collectIgnored(gens, ignored) {
  for (const g of gens) {
    if (!USED_GENERATORS.has(g.oper)) ignored.add(g.oper);
  }
}

/**
 * Resolve preset by exact name or by index.
 * @param {ReturnType<typeof parseSf2>} sf2
 * @param {string | number} presetSpec
 */
export function findPreset(sf2, presetSpec) {
  const names = sf2.presets.map((p) => p.name);
  if (typeof presetSpec === 'string') {
    const found = sf2.presets.find((p) => p.name === presetSpec);
    if (!found) {
      const listed = names.length ? names.join(', ') : '(none)';
      throw new Sf2Error(`unknown preset "${presetSpec}"; presets: ${listed}`, { exitCode: 2 });
    }
    return { preset: found, index: sf2.presets.indexOf(found) };
  }
  const index = presetSpec;
  if (!Number.isInteger(index) || index < 0 || index >= sf2.presets.length) {
    const listed = names.length ? names.join(', ') : '(none)';
    throw new Sf2Error(`preset index ${index} out of range; presets: ${listed}`, { exitCode: 2 });
  }
  return { preset: sf2.presets[index], index };
}

/**
 * Walk one preset to instrument zones (sample zones with key range + root).
 * @param {ReturnType<typeof parseSf2>} sf2
 * @param {object} preset
 */
export function extractPresetZones(sf2, preset) {
  const ignored = new Set();
  const presetIndex = sf2.allPresets.indexOf(preset);
  const nextBag = sf2.allPresets[presetIndex + 1]?.bagNdx ?? sf2.pbag.length - 1;
  const zones = [];

  for (let bag = preset.bagNdx; bag < nextBag; bag++) {
    const gens = gensForBag(sf2.pbag, sf2.pgen, bag);
    const zone = zoneFromGens(gens, GEN_INSTRUMENT);
    collectIgnored(gens, ignored);
    if (zone.isGlobal) continue;
    const instGen = zone.map.get(GEN_INSTRUMENT);
    if (!instGen) continue;
    const instIndex = instGen.amount;
    const instrument = sf2.instruments[instIndex];
    if (!instrument) throw new Sf2Error(`instrument index ${instIndex} out of range`);

    const instPos = sf2.allInstruments.indexOf(instrument);
    const instNextBag = sf2.allInstruments[instPos + 1]?.bagNdx ?? sf2.ibag.length - 1;

    /** @type {Map<number, { oper: number, amount: number, lo: number, hi: number }>} */
    let globalDefaults = new Map();
    let first = true;
    for (let ib = instrument.bagNdx; ib < instNextBag; ib++) {
      const igens = gensForBag(sf2.ibag, sf2.igen, ib);
      collectIgnored(igens, ignored);
      const izone = zoneFromGens(igens, GEN_SAMPLE_ID);
      if (first && izone.isGlobal) {
        globalDefaults = izone.map;
        first = false;
        continue;
      }
      first = false;
      if (izone.isGlobal) continue;

      const sampleGen = izone.map.get(GEN_SAMPLE_ID);
      if (!sampleGen) continue;
      const sampleIndex = sampleGen.amount;
      const sample = sf2.samples[sampleIndex];
      if (!sample) throw new Sf2Error(`sample index ${sampleIndex} out of range`);

      // Stereo-linked: keep mono (1) or left (4); skip right (2).
      const type = sample.sampleType & 0x7fff;
      if (type === SAMPLE_RIGHT) continue;
      if (type !== SAMPLE_MONO && type !== SAMPLE_LEFT) continue;

      const keyRange =
        izone.map.get(GEN_KEY_RANGE) || globalDefaults.get(GEN_KEY_RANGE);
      const lo = keyRange ? keyRange.lo : 0;
      const hi = keyRange ? keyRange.hi : 127;

      const rootGen =
        izone.map.get(GEN_OVERRIDING_ROOT_KEY) || globalDefaults.get(GEN_OVERRIDING_ROOT_KEY);
      const rootNote = noteRootFromSample(sample, rootGen ? rootGen.amount : undefined);

      zones.push({
        sampleIndex,
        sample,
        lo,
        hi,
        rootNote,
      });
    }
  }

  return { zones, ignoredGenerators: ignored };
}

/**
 * Write WAV files for distinct samples used by zones.
 * @returns {{ file: string, sampleIndex: number, frameCount: number, sampleRate: number }[]}
 */
export function writeZoneWavs(sf2, zones, wavDir) {
  mkdirSync(wavDir, { recursive: true });
  const written = [];
  const bySample = new Map();

  for (const zone of zones) {
    if (bySample.has(zone.sampleIndex)) continue;
    const sample = zone.sample;
    const frameCount = sample.end - sample.start;
    if (frameCount < 0) throw new Sf2Error(`sample "${sample.name}" has negative length`);
    const byteStart = sample.start * 2;
    const byteEnd = sample.end * 2;
    if (byteEnd > sf2.smpl.length) {
      throw new Sf2Error(`sample "${sample.name}" extends past smpl data`);
    }
    const pcm = sf2.smpl.subarray(byteStart, byteEnd);
    const fileSlug = slugify(sample.name || `sample-${zone.sampleIndex}`);
    const file = `${fileSlug}.wav`;
    writeFileSync(join(wavDir, file), encodeMonoPcm16Wav(pcm, sample.sampleRate));
    const meta = { file, sampleIndex: zone.sampleIndex, frameCount, sampleRate: sample.sampleRate };
    bySample.set(zone.sampleIndex, meta);
    written.push(meta);
  }

  return written;
}

/**
 * Build a house-band.samples.json object (relative wav paths).
 */
export function buildSamplesConfig({
  id,
  displayName,
  wavDirForSource,
  preset,
  patchClass,
  zones,
  sampleFiles,
}) {
  const fileBySample = new Map(sampleFiles.map((s) => [s.sampleIndex, s.file]));
  const patchZones = zones.map((z) => ({
    file: fileBySample.get(z.sampleIndex),
    rootNote: z.rootNote,
    lo: z.lo,
    hi: z.hi,
  }));

  return {
    format: 'house-band-samples',
    version: 1,
    id,
    displayName,
    source: {
      type: 'sf2',
      path: wavDirForSource,
      preset,
    },
    licence: 'user-supplied; not for redistribution',
    fallbackKit: 'tr808',
    patches: {
      [id]: {
        class: patchClass,
        zones: patchZones,
      },
    },
  };
}

/**
 * Format ignored generator set for CLI output.
 * @param {Set<number>} ignored
 */
export function formatIgnoredGenerators(ignored) {
  const ops = [...ignored].sort((a, b) => a - b);
  if (ops.length === 0) return '';
  return ops.map((n) => `${n} ${SF2_GENERATOR_NAMES[n] || 'unknown'}`).join(', ');
}

/**
 * Import one SF2 preset to WAVs + house-band.samples.json.
 * @param {{
 *   sf2Path: string,
 *   patchClass: string,
 *   preset?: string | number,
 *   id?: string,
 *   outPath?: string,
 *   wavDir?: string,
 * }} options
 */
export function importSf2(options) {
  const sf2Path = resolve(options.sf2Path);
  const buf = readFileSync(sf2Path);
  const sf2 = parseSf2(buf);

  let presetSpec = options.preset ?? 0;
  if (typeof presetSpec === 'string' && /^\d+$/.test(presetSpec)) {
    presetSpec = Number(presetSpec);
  }
  const { preset, index } = findPreset(sf2, presetSpec);

  const sf2Stem = basename(sf2Path).replace(/\.sf2$/i, '');
  const id = options.id || slugify(sf2Stem);
  const displayName = sf2.inam || preset.name || sf2Stem;

  const outPath = resolve(options.outPath || join(dirname(sf2Path), 'house-band.samples.json'));
  const wavDir = resolve(options.wavDir || join(dirname(outPath), `${sf2Stem}-wav`));

  const { zones, ignoredGenerators } = extractPresetZones(sf2, preset);
  if (zones.length === 0) throw new Sf2Error(`preset "${preset.name}" produced no sample zones`);

  const sampleFiles = writeZoneWavs(sf2, zones, wavDir);

  // source.path in the written JSON: relative to the config folder when possible
  const outDir = dirname(outPath);
  const rel = relative(outDir, wavDir).replace(/\\/g, '/');
  const wavDirForSource = !rel || rel.startsWith('..') ? wavDir : rel;

  // Prefer the name when the user asked by name; otherwise store the preset's name.
  const sourcePreset =
    typeof options.preset === 'string' && !/^\d+$/.test(String(options.preset))
      ? options.preset
      : preset.name;

  const config = buildSamplesConfig({
    id,
    displayName,
    wavDirForSource,
    preset: sourcePreset,
    patchClass: options.patchClass,
    zones,
    sampleFiles,
  });

  writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    sf2,
    preset,
    presetIndex: index,
    config,
    outPath,
    wavDir,
    sampleFiles,
    zones,
    ignoredGenerators,
    ignoredText: formatIgnoredGenerators(ignoredGenerators),
  };
}
