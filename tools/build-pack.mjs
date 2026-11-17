#!/usr/bin/env node
/** Build a strict House Band 1.1.0 sample-pack directory (one-shots + sampler). */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { midiToFrequency, MIDI_MAX, MIDI_MIN } from '../src/kit/band.js';
import {
  CANONICAL_ASSET_FORMAT,
  CANONICAL_SAMPLE_RATE,
  SAMPLE_PACK_FORMAT,
  SAMPLE_PACK_VERSION,
  SAMPLER_VOICE_CLASS,
  VOICE_CLASSES,
  encodeCanonicalWav,
  manifestIdentityBytes,
  packContentBytes,
  parseCanonicalWav,
} from '../src/sample-pack.mjs';
import { centsBetween, measureF0, nearestMidi, parseRootNoteFromFilename, toMillihertz } from './pitch.mjs';

const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const METADATA_FIELDS = new Set([
  'packId', 'displayName', 'projectId', 'curator', 'createdAt', 'provenance',
  'attribution', 'licenseRef', 'sourceCollection', 'assets',
]);
const METADATA_ASSET_REQUIRED = new Set(['sourceFile', 'id', 'displayName', 'suggestedVoice', 'tags']);
const METADATA_ASSET_OPTIONAL = new Set(['rootNote', 'maxSeconds']);
/** Below this YIN confidence the source is not reliably pitched; keep the label. */
const MIN_PITCH_CONFIDENCE = 0.5;
/** Fade applied to a trimmed tail so the truncation cannot click. */
const TRIM_FADE_FRAMES = 441;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, fields, path) {
  if (!isObject(value)) fail(`${path}: must be an object`);
  for (const key of Object.keys(value)) if (!fields.has(key)) fail(`${path}.${key}: unknown field`);
  for (const key of fields) if (!Object.hasOwn(value, key)) fail(`${path}.${key}: required field`);
}

function requiredAndOptionalFields(value, required, optional, path) {
  if (!isObject(value)) fail(`${path}: must be an object`);
  for (const key of Object.keys(value)) {
    if (!required.has(key) && !optional.has(key)) fail(`${path}.${key}: unknown field`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}: required field`);
}

function stringField(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path}: required non-empty string`);
}

function safeRelative(value, path) {
  stringField(value, path);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) fail(`${path}: must be a safe relative path`);
  return normalized;
}

function validateMetadata(metadata) {
  exactFields(metadata, METADATA_FIELDS, 'metadata');
  if (!SLUG.test(metadata.packId)) fail('metadata.packId: required lowercase slug');
  if (!SLUG.test(metadata.projectId)) fail('metadata.projectId: required lowercase slug');
  for (const key of ['displayName', 'curator', 'provenance', 'attribution', 'licenseRef', 'sourceCollection']) {
    stringField(metadata[key], `metadata.${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(metadata.createdAt)) {
    fail('metadata.createdAt: required UTC timestamp without fractional seconds');
  }
  if (!Array.isArray(metadata.assets) || metadata.assets.length === 0) fail('metadata.assets: required non-empty array');
  const ids = new Set();
  const sourceFiles = new Set();
  for (let index = 0; index < metadata.assets.length; index++) {
    const asset = metadata.assets[index];
    const path = `metadata.assets[${index}]`;
    requiredAndOptionalFields(asset, METADATA_ASSET_REQUIRED, METADATA_ASSET_OPTIONAL, path);
    asset.sourceFile = safeRelative(asset.sourceFile, `${path}.sourceFile`);
    if (!asset.sourceFile.toLowerCase().endsWith('.wav')) fail(`${path}.sourceFile: must name a WAV file`);
    if (!SLUG.test(asset.id)) fail(`${path}.id: required lowercase slug`);
    if (ids.has(asset.id)) fail(`${path}.id: duplicate asset id "${asset.id}"`);
    if (sourceFiles.has(asset.sourceFile)) fail(`${path}.sourceFile: duplicate source file`);
    ids.add(asset.id);
    sourceFiles.add(asset.sourceFile);
    stringField(asset.displayName, `${path}.displayName`);
    if (!VOICE_CLASSES.has(asset.suggestedVoice)) fail(`${path}.suggestedVoice: must be kick, snare, hat, or sampler`);
    if (!Array.isArray(asset.tags) || asset.tags.some((tag) => typeof tag !== 'string' || !tag)) {
      fail(`${path}.tags: must be an array of non-empty strings`);
    }
    if (Object.hasOwn(asset, 'rootNote')) {
      if (asset.suggestedVoice !== SAMPLER_VOICE_CLASS) fail(`${path}.rootNote: only sampler assets carry a root note`);
      if (!Number.isInteger(asset.rootNote) || asset.rootNote < MIDI_MIN || asset.rootNote > MIDI_MAX) {
        fail(`${path}.rootNote: must be an integer MIDI note from ${MIDI_MIN} to ${MIDI_MAX}`);
      }
    }
    if (Object.hasOwn(asset, 'maxSeconds')) {
      if (!Number.isFinite(asset.maxSeconds) || asset.maxSeconds <= 0 || asset.maxSeconds > 600) {
        fail(`${path}.maxSeconds: must be a positive number of seconds up to 600`);
      }
    }
  }
  return metadata;
}

function chunkAscii(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** Decode common uncompressed WAV sources for deterministic build-time conversion. */
export function decodeSourceWav(value, path = 'source WAV') {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength < 44 || chunkAscii(bytes, 0) !== 'RIFF' || chunkAscii(bytes, 8) !== 'WAVE') {
    fail(`${path}: must be a RIFF/WAVE file`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format = null;
  let dataOffset = null;
  let dataBytes = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = chunkAscii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) fail(`${path}: chunk ${id} exceeds file length`);
    if (id === 'fmt ') {
      if (format) fail(`${path}: duplicate fmt chunk`);
      if (size < 16) fail(`${path}: fmt chunk is too short`);
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (dataOffset !== null) fail(`${path}: duplicate data chunk`);
      dataOffset = body;
      dataBytes = size;
    }
    offset = body + size + (size % 2);
  }
  if (!format) fail(`${path}: missing fmt chunk`);
  if (dataOffset === null) fail(`${path}: missing data chunk`);
  if (![1, 3].includes(format.audioFormat)) fail(`${path}: only integer PCM (1) and IEEE float (3) are supported`);
  if (![1, 2].includes(format.channels)) fail(`${path}: only mono or stereo sources can be made canonical`);
  if (!Number.isInteger(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 192000) {
    fail(`${path}: sample rate must be between 8000 and 192000 Hz`);
  }
  if (format.audioFormat === 1 && ![8, 16, 24, 32].includes(format.bitsPerSample)) {
    fail(`${path}: integer PCM bit depth must be 8, 16, 24, or 32`);
  }
  if (format.audioFormat === 3 && format.bitsPerSample !== 32) fail(`${path}: IEEE float source must be 32-bit`);
  const bytesPerSample = format.bitsPerSample / 8;
  const expectedAlign = format.channels * bytesPerSample;
  if (format.blockAlign !== expectedAlign || format.byteRate !== format.sampleRate * expectedAlign) {
    fail(`${path}: inconsistent WAV block alignment or byte rate`);
  }
  if (dataBytes % expectedAlign !== 0) fail(`${path}: data chunk is not frame-aligned`);
  const frameCount = dataBytes / expectedAlign;
  if (frameCount === 0) fail(`${path}: contains no sample frames`);
  const mono = new Float64Array(frameCount);
  const readSample = (sampleOffset) => {
    if (format.audioFormat === 3) {
      const value = view.getFloat32(sampleOffset, true);
      if (!Number.isFinite(value)) fail(`${path}: contains a non-finite float sample`);
      return value;
    }
    if (format.bitsPerSample === 8) return (view.getUint8(sampleOffset) - 128) / 128;
    if (format.bitsPerSample === 16) return view.getInt16(sampleOffset, true) / 32768;
    if (format.bitsPerSample === 24) {
      let value = view.getUint8(sampleOffset) | (view.getUint8(sampleOffset + 1) << 8) | (view.getUint8(sampleOffset + 2) << 16);
      if (value & 0x800000) value -= 0x1000000;
      return value / 8388608;
    }
    return view.getInt32(sampleOffset, true) / 2147483648;
  };
  for (let frame = 0; frame < frameCount; frame++) {
    const base = dataOffset + frame * expectedAlign;
    const left = readSample(base);
    const sample = format.channels === 1 ? left : (left + readSample(base + bytesPerSample)) / 2;
    if (sample < -1 || sample > 1) fail(`${path}: source sample exceeds normalized PCM range`);
    mono[frame] = sample;
  }
  return Object.freeze({ ...format, frameCount, mono });
}

function roundSigned(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function canonicalizeSource(decoded, path = 'source WAV') {
  const outputFrames = Math.max(1, Math.round(decoded.frameCount * CANONICAL_SAMPLE_RATE / decoded.sampleRate));
  const canonical = new Int16Array(outputFrames);
  for (let frame = 0; frame < outputFrames; frame++) {
    const position = frame * decoded.sampleRate / CANONICAL_SAMPLE_RATE;
    const left = Math.min(decoded.frameCount - 1, Math.floor(position));
    const right = Math.min(decoded.frameCount - 1, left + 1);
    const fraction = position - left;
    const sample = decoded.mono[left] + (decoded.mono[right] - decoded.mono[left]) * fraction;
    const quantized = roundSigned(sample * 32768);
    if (quantized < -32768 || quantized > 32767) fail(`${path}: conversion would clip; lower the source gain before building`);
    canonical[frame] = quantized;
  }
  return canonical;
}

/**
 * Head-trim to `maxSeconds` with a short linear fade so the cut cannot click.
 * Embed cost is the binding constraint on sampled voices in single-file game
 * builds — a 6 s MicroFreak note is 529 kB canonical and roughly 176 kB once
 * its audible content is kept and the silent decay tail dropped.
 */
export function trimCanonical(frames, maxSeconds) {
  const limit = Math.max(1, Math.round(maxSeconds * CANONICAL_SAMPLE_RATE));
  if (limit >= frames.length) return frames;
  const trimmed = frames.slice(0, limit);
  const fade = Math.min(TRIM_FADE_FRAMES, trimmed.length);
  for (let index = 0; index < fade; index++) {
    const position = trimmed.length - fade + index;
    const gainQ16 = 65536 - Math.floor(((index + 1) * 65536) / fade);
    trimmed[position] = roundSigned((trimmed[position] * gainQ16) / 65536);
  }
  return trimmed;
}

/**
 * Establish an asset's root note.
 *
 * Filename labels are a convenience, not evidence: the timbre catalog found
 * three of four "Essential WAV From Mars" octave labels wrong. So a parsed
 * label is VERIFIED against a measured f0 and the measurement wins. An
 * explicit `rootNote` in the pack metadata is an operator decision and does
 * win over the measurement — but a disagreement is still recorded, because a
 * silently overridden measurement is exactly the thing this check exists to
 * surface.
 */
export function resolveRootNote(asset, frames, warnings) {
  if (asset.suggestedVoice !== SAMPLER_VOICE_CLASS) {
    return { rootNote: null, rootNoteSource: 'none', measuredF0Millihertz: null, notes: [], disagreed: false };
  }
  const measured = measureF0(frames, CANONICAL_SAMPLE_RATE);
  const confident = measured.frequencyHz !== null && measured.confidence >= MIN_PITCH_CONFIDENCE;
  const measuredMidi = confident ? nearestMidi(measured.frequencyHz) : null;
  const measuredMillihertz = measured.frequencyHz === null ? null : toMillihertz(measured.frequencyHz);
  const declared = Object.hasOwn(asset, 'rootNote') ? { midi: asset.rootNote, convention: 'declared' } : null;
  const label = declared ?? parseRootNoteFromFilename(asset.sourceFile);
  const notes = [];

  if (!label && !confident) {
    fail(`${asset.id}: sampler asset has no root-note label and no confident pitch measurement (confidence ${measured.confidence.toFixed(3)}); declare rootNote explicitly`);
  }
  if (!label) {
    notes.push(`root note ${measuredMidi} measured from audio (no filename label); f0 ${measuredMillihertz} millihertz`);
    return { rootNote: measuredMidi, rootNoteSource: 'measured', measuredF0Millihertz: measuredMillihertz, notes, disagreed: false };
  }
  if (!confident) {
    notes.push(`root note ${label.midi} taken from ${label.convention}; pitch measurement was not confident enough to verify`);
    warnings.push(`${asset.id}: pitch measurement unreliable (confidence ${measured.confidence.toFixed(3)}); kept the ${label.convention} root ${label.midi}`);
    return {
      rootNote: label.midi,
      rootNoteSource: declared ? 'declared' : 'filename',
      measuredF0Millihertz: measuredMillihertz,
      notes,
      disagreed: false,
    };
  }
  if (measuredMidi === label.midi) {
    notes.push(`root note ${label.midi} from ${label.convention}, verified against measured f0 ${measuredMillihertz} millihertz`);
    return {
      rootNote: label.midi,
      rootNoteSource: declared ? 'declared' : 'filename',
      measuredF0Millihertz: measuredMillihertz,
      notes,
      disagreed: false,
    };
  }
  const cents = centsBetween(measured.frequencyHz, midiToFrequency(label.midi));
  if (declared) {
    notes.push(`root note ${label.midi} declared by the operator; measured f0 ${measuredMillihertz} millihertz reads as MIDI ${measuredMidi} (${measuredMidi - label.midi} semitones away)`);
    warnings.push(`${asset.id}: DISAGREEMENT — declared root ${label.midi}, measured MIDI ${measuredMidi} (${cents.toFixed(1)} cents); operator declaration kept`);
    return { rootNote: label.midi, rootNoteSource: 'declared', measuredF0Millihertz: measuredMillihertz, notes, disagreed: true };
  }
  notes.push(`filename label claimed MIDI ${label.midi}; measured f0 ${measuredMillihertz} millihertz reads as MIDI ${measuredMidi}, and the measurement wins`);
  warnings.push(`${asset.id}: DISAGREEMENT — filename label ${label.midi}, measured MIDI ${measuredMidi} (${cents.toFixed(1)} cents); measurement wins`);
  return { rootNote: measuredMidi, rootNoteSource: 'measured-override', measuredF0Millihertz: measuredMillihertz, notes, disagreed: true };
}

function ensureOutputDirectory(outDir) {
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory()) fail(`output exists and is not a directory: ${outDir}`);
    if (readdirSync(outDir).length > 0) fail(`output directory is not empty: ${outDir}`);
  }
  mkdirSync(join(outDir, 'assets'), { recursive: true });
}

export async function buildPack({ inputDir, metadataPath, outputDir }) {
  const sourceRoot = resolve(inputDir);
  const metadata = validateMetadata(JSON.parse(readFileSync(resolve(metadataPath), 'utf8')));
  const outDir = resolve(outputDir);
  ensureOutputDirectory(outDir);
  const assets = [];
  const contentEntries = [];
  const warnings = [];
  let labelDisagreements = 0;
  let totalWavBytes = 0;
  let totalPcmBytes = 0;
  for (const source of [...metadata.assets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const sourcePath = resolve(sourceRoot, source.sourceFile.split('/').join(sep));
    const relativePath = relative(sourceRoot, sourcePath);
    if (relativePath.startsWith('..') || relativePath === '') fail(`metadata source escapes input directory: ${source.sourceFile}`);
    let sourceBytes;
    try {
      sourceBytes = new Uint8Array(readFileSync(sourcePath));
    } catch (error) {
      fail(`cannot read source WAV ${source.sourceFile}: ${error.message}`);
    }
    const decoded = decodeSourceWav(sourceBytes, source.sourceFile);
    const canonical = canonicalizeSource(decoded, source.sourceFile);
    // Measure before trimming: the trim is an embed-cost decision, not a
    // statement about pitch, and the full note gives YIN more to work with.
    const root = resolveRootNote(source, canonical, warnings);
    if (root.disagreed) labelDisagreements += 1;
    const frames = source.maxSeconds === undefined ? canonical : trimCanonical(canonical, source.maxSeconds);
    const wav = encodeCanonicalWav(frames);
    const parsed = parseCanonicalWav(wav, source.id);
    const file = `assets/${source.id}.wav`;
    writeFileSync(join(outDir, file), wav);
    totalWavBytes += wav.byteLength;
    totalPcmBytes += parsed.pcmBytes.byteLength;
    contentEntries.push([source.id, wav]);
    const transformLog = [
      `decoded RIFF/WAVE format=${decoded.audioFormat} channels=${decoded.channels} rate=${decoded.sampleRate} bits=${decoded.bitsPerSample}`,
      decoded.channels === 2 ? 'downmixed stereo to mono by arithmetic mean' : 'preserved mono channel',
      decoded.sampleRate === CANONICAL_SAMPLE_RATE ? 'preserved 44100 Hz sample rate' : `resampled ${decoded.sampleRate} Hz to 44100 Hz with build-pack linear-v1`,
      'quantized to signed PCM16LE with nearest, ties away from zero; no dither; gain 1',
      ...(frames.length === canonical.length
        ? []
        : [`trimmed ${canonical.length} frames to ${frames.length} with a ${TRIM_FADE_FRAMES}-frame linear tail fade`]),
      ...root.notes,
    ];
    assets.push({
      id: source.id,
      displayName: source.displayName,
      file,
      sourceCollection: metadata.sourceCollection,
      sourcePath: source.sourceFile,
      sourceSha256: sha256(sourceBytes),
      wavSha256: sha256(wav),
      pcmSha256: sha256(parsed.pcmBytes),
      sampleRate: CANONICAL_SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      frameCount: frames.length,
      peakAbs: parsed.peakAbs,
      suggestedVoice: source.suggestedVoice,
      rootNote: root.rootNote,
      rootNoteSource: root.rootNoteSource,
      measuredF0Millihertz: root.measuredF0Millihertz,
      tags: source.tags,
      transformLog,
    });
  }
  const manifest = {
    format: SAMPLE_PACK_FORMAT,
    formatVersion: SAMPLE_PACK_VERSION,
    packId: metadata.packId,
    displayName: metadata.displayName,
    projectId: metadata.projectId,
    curator: metadata.curator,
    createdAt: metadata.createdAt,
    builderVersion: SAMPLE_PACK_VERSION,
    sampleRate: CANONICAL_SAMPLE_RATE,
    assetFormat: CANONICAL_ASSET_FORMAT,
    provenance: metadata.provenance,
    attribution: metadata.attribution,
    licenseRef: metadata.licenseRef,
    assetCount: assets.length,
    totalWavBytes,
    totalPcmBytes,
    contentSha256: sha256(packContentBytes(contentEntries)),
    assets,
  };
  manifest.manifestSha256 = sha256(manifestIdentityBytes(manifest));
  writeFileSync(join(outDir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze({
    manifest,
    outputDir: outDir,
    warnings: Object.freeze(warnings),
    labelDisagreements,
  });
}

function usage() {
  return [
    'Usage: node tools/build-pack.mjs --input <wav-root> --metadata <pack-build.json> --out <empty-directory>',
    '',
    'Converts the metadata-listed WAV files to exact PCM16LE RIFF/WAVE 44.1 kHz mono assets.',
    'Supported sources: mono/stereo uncompressed PCM 8/16/24/32-bit or IEEE float32 WAV.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { inputDir: null, metadataPath: null, outputDir: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--input') args.inputDir = argv[++index];
    else if (arg === '--metadata') args.metadataPath = argv[++index];
    else if (arg === '--out') args.outputDir = argv[++index];
    else fail(`unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.inputDir || !args.metadataPath || !args.outputDir) fail(`--input, --metadata, and --out are required\n${usage()}`);
  const result = await buildPack(args);
  console.error(`wrote ${result.outputDir} (${result.manifest.assetCount} assets, ${result.manifest.totalWavBytes} WAV bytes)`);
  for (const warning of result.warnings) console.error(`  warning: ${warning}`);
  console.error(`root-note label disagreements: ${result.labelDisagreements}`);
  console.error(`manifest sha256 ${result.manifest.manifestSha256}`);
  console.error(`content sha256 ${result.manifest.contentSha256}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`build-pack failed: ${error.message}`);
    process.exitCode = 1;
  });
}
