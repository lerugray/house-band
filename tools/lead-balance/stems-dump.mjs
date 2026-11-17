// Persist in-memory game-render stems and measure them with the fleet lead-balance gate.
// Dependency-free Node/ESM: probes can call this directly after OfflineAudioContext renders.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { measureLeadBalance, sha256File, sumStems } from './lead-balance.mjs';

function isSampleBuffer(value) {
  return value instanceof Float32Array || value instanceof Float64Array;
}

function monoStem(value, name) {
  if (isSampleBuffer(value)) {
    if (!value.length) throw new Error(`${name} stem is empty`);
    for (let i = 0; i < value.length; i += 1) {
      if (!Number.isFinite(value[i])) throw new Error(`${name} stem has a non-finite sample at index ${i}`);
    }
    return value instanceof Float64Array ? value : Float64Array.from(value);
  }
  if (!Array.isArray(value)) throw new TypeError(`${name} must be a Float32Array, Float64Array, or array of channel buffers`);
  if (!value.length) throw new Error(`${name} channel array is empty`);
  if (!value.every(isSampleBuffer)) throw new TypeError(`${name} channels must be Float32Array or Float64Array buffers`);
  const length = value[0].length;
  if (!length) throw new Error(`${name} channel buffers are empty`);
  if (value.some((channel) => channel.length !== length)) throw new Error(`${name} channel lengths must match`);
  const mono = new Float64Array(length);
  for (const channel of value) {
    for (let i = 0; i < length; i += 1) {
      const sample = channel[i];
      if (!Number.isFinite(sample)) throw new Error(`${name} stem has a non-finite sample at index ${i}`);
      mono[i] += sample / value.length;
    }
  }
  return mono;
}

function pcm16MonoWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const wav = Buffer.allocUnsafe(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const pcm = Math.max(-0x8000, Math.min(0x7fff, Math.round(sample * 0x8000)));
    wav.writeInt16LE(pcm, 44 + i * 2);
  }
  return wav;
}

/**
 * Write rendered lead/bed stems as mono PCM16 WAVs and run the fleet metric in memory.
 * Measurement fields are returned at top level; `stems`, `sha256`, and `inputs` carry
 * the persisted-file custody metadata. GREEN and RED are both normal return values.
 *
 * @param {object} opts
 * @param {Float32Array|Float64Array|Array<Float32Array|Float64Array>} opts.lead
 * @param {Float32Array|Float64Array|Array<Float32Array|Float64Array>} opts.bed
 * @param {Float32Array|Float64Array|Array<Float32Array|Float64Array>} [opts.full]
 * @param {number} opts.sampleRate
 * @param {string} opts.outDir
 * @param {string} opts.tag
 * @param {boolean} [opts.writeFull=true]
 * @param {number} [opts.sectionSeconds]
 * @param {object} [opts.caps]
 * @param {string} [opts.jsonOut]
 * @param {string} [opts.label]
 * @returns {object} fleet measurement fields plus stem paths, hashes, and CLI-shaped inputs
 */
export function dumpLeadBalanceStems(opts = {}) {
  const { outDir, tag, sampleRate } = opts;
  if (typeof outDir !== 'string' || !outDir.trim()) throw new TypeError('outDir is required');
  if (typeof tag !== 'string' || !tag.trim()) throw new TypeError('tag is required');
  if (/[\\/\0]/.test(tag)) throw new Error('tag must be a filename prefix without path separators');
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || sampleRate > 0xffffffff) {
    throw new TypeError('sampleRate must be a positive integer');
  }
  if (opts.jsonOut !== undefined && (typeof opts.jsonOut !== 'string' || !opts.jsonOut.trim())) {
    throw new TypeError('jsonOut must be a non-empty path when provided');
  }

  const lead = monoStem(opts.lead, 'lead');
  const bed = monoStem(opts.bed, 'bed');
  const length = Math.min(lead.length, bed.length);
  let full;
  if (opts.full === undefined) {
    full = sumStems([lead, bed]);
  } else {
    full = monoStem(opts.full, 'full');
    if (full.length < length) throw new Error('full stem is shorter than the shared lead/bed length');
  }

  const directory = resolve(outDir);
  mkdirSync(directory, { recursive: true });
  const leadPath = join(directory, `${tag}-lead.wav`);
  const bedPath = join(directory, `${tag}-bed.wav`);
  const shouldWriteFull = opts.writeFull !== false;
  const fullPath = shouldWriteFull ? join(directory, `${tag}-full.wav`) : null;
  writeFileSync(leadPath, pcm16MonoWav(lead, sampleRate));
  writeFileSync(bedPath, pcm16MonoWav(bed, sampleRate));
  if (fullPath) writeFileSync(fullPath, pcm16MonoWav(full, sampleRate));

  const measurement = measureLeadBalance({
    lead, bed, full, sampleRate,
    sectionSeconds: opts.sectionSeconds,
    caps: opts.caps,
  });
  const sha256 = {
    lead: sha256File(leadPath),
    bed: sha256File(bedPath),
    full: fullPath ? sha256File(fullPath) : null,
  };
  const stems = { leadPath, bedPath, fullPath };
  const inputs = {
    lead: [{ file: leadPath, sha256: sha256.lead }],
    bed: [{ file: bedPath, sha256: sha256.bed }],
    ...(fullPath ? { full: { file: fullPath, sha256: sha256.full } } : {}),
  };

  if (opts.jsonOut) {
    const jsonPath = resolve(opts.jsonOut);
    mkdirSync(dirname(jsonPath), { recursive: true });
    const report = {
      label: opts.label || '',
      generated: new Date().toISOString(),
      inputs,
      ...measurement,
    };
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return { ...measurement, stems, sha256, inputs };
}
