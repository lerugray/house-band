/**
 * House Band sample-pack format 1.0.0.
 *
 * This module is runtime-neutral: Node and the browser provide only a SHA-256
 * function. Canonical WAV parsing, manifest validation, and content framing
 * are otherwise the exact same code in both custody paths.
 */

export const SAMPLE_PACK_FORMAT = 'house-band-sample-pack';
export const SAMPLE_PACK_VERSION = '1.0.0';
export const SAMPLE_RENDERER_VERSION = '1.0.0';
export const CANONICAL_SAMPLE_RATE = 44100;
export const CANONICAL_ASSET_FORMAT = 'PCM16LE RIFF/WAVE 44100Hz mono';

const PACK_FIELDS = new Set([
  'format', 'formatVersion', 'packId', 'displayName', 'projectId', 'curator',
  'createdAt', 'builderVersion', 'sampleRate', 'assetFormat', 'provenance',
  'attribution', 'licenseRef', 'assetCount', 'totalWavBytes', 'totalPcmBytes',
  'contentSha256', 'manifestSha256', 'assets',
]);
const ASSET_FIELDS = new Set([
  'id', 'displayName', 'file', 'sourceCollection', 'sourcePath', 'sourceSha256',
  'wavSha256', 'pcmSha256', 'sampleRate', 'channels', 'bitsPerSample',
  'frameCount', 'peakAbs', 'suggestedVoice', 'tags', 'transformLog',
]);
const DRUM_VOICES = new Set(['kick', 'snare', 'hat']);
const HEX_256 = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;

export class SamplePackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SamplePackError';
  }
}

function fail(message) {
  throw new SamplePackError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function knownFields(value, fields, path) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) fail(`${path}.${key}: unknown field`);
  }
}

function exactFields(value, fields, path) {
  knownFields(value, fields, path);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) fail(`${path}.${field}: required field`);
  }
}

function stringField(value, path, max = 500) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(`${path}: required non-empty string of at most ${max} characters`);
  }
}

function uintField(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${path}: required non-negative safe integer`);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail('sample bytes: expected ArrayBuffer or typed array');
}

function ascii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

/** Stable sorted-key JSON used by the manifest hash law. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Strict canonical asset parser. Canonical assets are exactly a 44-byte-header
 * PCM16LE RIFF/WAVE, 44.1 kHz, mono file with no extra chunks or padding.
 */
export function parseCanonicalWav(value, path = 'WAV') {
  const bytes = asBytes(value);
  if (bytes.byteLength < 44) fail(`${path}: shorter than the canonical 44-byte header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== 'RIFF') fail(`${path}: missing RIFF signature`);
  if (view.getUint32(4, true) !== bytes.byteLength - 8) fail(`${path}: RIFF length is not canonical`);
  if (ascii(bytes, 8, 4) !== 'WAVE') fail(`${path}: missing WAVE signature`);
  if (ascii(bytes, 12, 4) !== 'fmt ' || view.getUint32(16, true) !== 16) {
    fail(`${path}: fmt chunk must be first and exactly 16 bytes`);
  }
  if (view.getUint16(20, true) !== 1) fail(`${path}: audio format must be integer PCM (1)`);
  if (view.getUint16(22, true) !== 1) fail(`${path}: channel count must be mono (1)`);
  if (view.getUint32(24, true) !== CANONICAL_SAMPLE_RATE) fail(`${path}: sample rate must be 44100`);
  if (view.getUint32(28, true) !== 88200) fail(`${path}: byte rate must be 88200`);
  if (view.getUint16(32, true) !== 2) fail(`${path}: block alignment must be 2`);
  if (view.getUint16(34, true) !== 16) fail(`${path}: bit depth must be 16`);
  if (ascii(bytes, 36, 4) !== 'data') fail(`${path}: data chunk must immediately follow fmt`);
  const dataBytes = view.getUint32(40, true);
  if (dataBytes % 2 !== 0 || dataBytes !== bytes.byteLength - 44) fail(`${path}: data length is not canonical`);

  const frames = new Int16Array(dataBytes / 2);
  let peakAbs = 0;
  for (let index = 0; index < frames.length; index++) {
    const sample = view.getInt16(44 + index * 2, true);
    frames[index] = sample;
    peakAbs = Math.max(peakAbs, Math.abs(sample));
  }
  return Object.freeze({
    bytes,
    pcmBytes: bytes.subarray(44),
    frames,
    frameCount: frames.length,
    peakAbs,
    sampleRate: CANONICAL_SAMPLE_RATE,
    channels: 1,
    bitsPerSample: 16,
  });
}

/** Write the one allowed runtime asset representation. */
export function encodeCanonicalWav(frames) {
  if (!(frames instanceof Int16Array)) fail('canonical WAV encoder: frames must be Int16Array');
  const dataBytes = frames.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, CANONICAL_SAMPLE_RATE, true);
  view.setUint32(28, 88200, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < frames.length; index++) view.setInt16(44 + index * 2, frames[index], true);
  return bytes;
}

/** Manifest identity is canonical JSON with only manifestSha256 omitted. */
export function manifestIdentityBytes(manifest) {
  const copy = structuredClone(manifest);
  delete copy.manifestSha256;
  return new TextEncoder().encode(canonicalJson(copy));
}

/**
 * Content identity is SHA input framed as:
 *   u32be(asset-id UTF-8 length), asset-id UTF-8,
 *   u32be(canonical WAV byte length), canonical WAV bytes
 * repeated in lexical asset-id order.
 */
export function packContentBytes(entries) {
  const encoder = new TextEncoder();
  const sorted = [...entries]
    .map(([id, value]) => [id, asBytes(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let length = 0;
  const framed = sorted.map(([id, bytes]) => {
    const idBytes = encoder.encode(id);
    if (idBytes.byteLength > 0xffffffff || bytes.byteLength > 0xffffffff) fail(`asset ${id}: too large for u32 framing`);
    length += 8 + idBytes.byteLength + bytes.byteLength;
    return { idBytes, bytes };
  });
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const { idBytes, bytes } of framed) {
    view.setUint32(offset, idBytes.byteLength, false);
    offset += 4;
    out.set(idBytes, offset);
    offset += idBytes.byteLength;
    view.setUint32(offset, bytes.byteLength, false);
    offset += 4;
    out.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return out;
}

function validateAssetMetadata(asset, index) {
  const path = `pack.assets[${index}]`;
  if (!isPlainObject(asset)) fail(`${path}: must be an object`);
  exactFields(asset, ASSET_FIELDS, path);
  if (typeof asset.id !== 'string' || !SLUG.test(asset.id)) fail(`${path}.id: required lowercase slug`);
  stringField(asset.displayName, `${path}.displayName`);
  if (asset.file !== `assets/${asset.id}.wav`) fail(`${path}.file: must be "assets/${asset.id}.wav"`);
  stringField(asset.sourceCollection, `${path}.sourceCollection`);
  stringField(asset.sourcePath, `${path}.sourcePath`, 1000);
  if (asset.sourcePath.startsWith('/') || asset.sourcePath.split('/').includes('..')) fail(`${path}.sourcePath: must be safe and relative`);
  for (const key of ['sourceSha256', 'wavSha256', 'pcmSha256']) {
    if (typeof asset[key] !== 'string' || !HEX_256.test(asset[key])) fail(`${path}.${key}: required lowercase SHA-256`);
  }
  if (asset.sampleRate !== CANONICAL_SAMPLE_RATE) fail(`${path}.sampleRate: must be 44100`);
  if (asset.channels !== 1) fail(`${path}.channels: must be 1`);
  if (asset.bitsPerSample !== 16) fail(`${path}.bitsPerSample: must be 16`);
  uintField(asset.frameCount, `${path}.frameCount`);
  if (!Number.isInteger(asset.peakAbs) || asset.peakAbs < 0 || asset.peakAbs > 32768) fail(`${path}.peakAbs: must be an integer from 0 to 32768`);
  if (!DRUM_VOICES.has(asset.suggestedVoice)) fail(`${path}.suggestedVoice: must be kick, snare, or hat`);
  if (!Array.isArray(asset.tags) || asset.tags.some((tag) => typeof tag !== 'string' || !tag)) fail(`${path}.tags: must be an array of non-empty strings`);
  if (!Array.isArray(asset.transformLog) || asset.transformLog.some((entry) => typeof entry !== 'string' || !entry)) fail(`${path}.transformLog: must be an array of non-empty strings`);
}

/** Validate all bytes and return the parsed pack used by custody rendering. */
export async function validateSamplePack(manifest, files, sha256) {
  if (typeof sha256 !== 'function') fail('pack validator: SHA-256 function is required');
  if (!isPlainObject(manifest)) fail('pack: manifest must be an object');
  exactFields(manifest, PACK_FIELDS, 'pack');
  if (manifest.format !== SAMPLE_PACK_FORMAT) fail(`pack.format: must be "${SAMPLE_PACK_FORMAT}"`);
  if (manifest.formatVersion !== SAMPLE_PACK_VERSION) fail(`pack.formatVersion: unsupported version "${manifest.formatVersion}"`);
  if (typeof manifest.packId !== 'string' || !SLUG.test(manifest.packId)) fail('pack.packId: required lowercase slug');
  stringField(manifest.displayName, 'pack.displayName');
  if (typeof manifest.projectId !== 'string' || !SLUG.test(manifest.projectId)) fail('pack.projectId: required lowercase slug');
  stringField(manifest.curator, 'pack.curator');
  if (typeof manifest.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.createdAt)) fail('pack.createdAt: required UTC timestamp without fractional seconds');
  if (manifest.builderVersion !== SAMPLE_PACK_VERSION) fail(`pack.builderVersion: must be "${SAMPLE_PACK_VERSION}"`);
  if (manifest.sampleRate !== CANONICAL_SAMPLE_RATE) fail('pack.sampleRate: must be 44100');
  if (manifest.assetFormat !== CANONICAL_ASSET_FORMAT) fail(`pack.assetFormat: must be "${CANONICAL_ASSET_FORMAT}"`);
  stringField(manifest.provenance, 'pack.provenance');
  stringField(manifest.attribution, 'pack.attribution');
  stringField(manifest.licenseRef, 'pack.licenseRef');
  uintField(manifest.assetCount, 'pack.assetCount');
  uintField(manifest.totalWavBytes, 'pack.totalWavBytes');
  uintField(manifest.totalPcmBytes, 'pack.totalPcmBytes');
  if (typeof manifest.contentSha256 !== 'string' || !HEX_256.test(manifest.contentSha256)) fail('pack.contentSha256: required lowercase SHA-256');
  if (typeof manifest.manifestSha256 !== 'string' || !HEX_256.test(manifest.manifestSha256)) fail('pack.manifestSha256: required lowercase SHA-256');
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) fail('pack.assets: required non-empty array');
  if (manifest.assetCount !== manifest.assets.length) fail('pack.assetCount: does not match assets length');

  const fileMap = files instanceof Map ? files : new Map(Object.entries(files || {}));
  const ids = new Set();
  const parsedAssets = {};
  const contentEntries = [];
  let totalWavBytes = 0;
  let totalPcmBytes = 0;
  for (let index = 0; index < manifest.assets.length; index++) {
    const asset = manifest.assets[index];
    validateAssetMetadata(asset, index);
    if (ids.has(asset.id)) fail(`pack.assets[${index}].id: duplicate asset id "${asset.id}"`);
    ids.add(asset.id);
    if (!fileMap.has(asset.file)) fail(`pack asset missing: ${asset.file}`);
    const bytes = asBytes(fileMap.get(asset.file));
    const parsed = parseCanonicalWav(bytes, asset.file);
    if (parsed.frameCount !== asset.frameCount) fail(`${asset.file}: frame count does not match manifest`);
    if (parsed.peakAbs !== asset.peakAbs) fail(`${asset.file}: peak does not match manifest`);
    if (await sha256(bytes) !== asset.wavSha256) fail(`${asset.file}: canonical WAV SHA-256 mismatch`);
    if (await sha256(parsed.pcmBytes) !== asset.pcmSha256) fail(`${asset.file}: raw PCM SHA-256 mismatch`);
    totalWavBytes += bytes.byteLength;
    totalPcmBytes += parsed.pcmBytes.byteLength;
    contentEntries.push([asset.id, bytes]);
    parsedAssets[asset.id] = Object.freeze({ metadata: asset, frames: parsed.frames });
  }
  if (fileMap.size !== manifest.assets.length) fail('pack files: unreferenced or unexpected asset file present');
  if (totalWavBytes !== manifest.totalWavBytes) fail('pack.totalWavBytes: does not match canonical assets');
  if (totalPcmBytes !== manifest.totalPcmBytes) fail('pack.totalPcmBytes: does not match canonical assets');
  if (await sha256(packContentBytes(contentEntries)) !== manifest.contentSha256) fail('pack.contentSha256: length-prefixed content hash mismatch');
  if (await sha256(manifestIdentityBytes(manifest)) !== manifest.manifestSha256) fail('pack.manifestSha256: canonical manifest hash mismatch');
  return Object.freeze({ manifest, assets: Object.freeze(parsedAssets) });
}

export function assertScorePackMatch(artifact, pack) {
  if (!artifact.samplePack || !artifact.sampleVoices) return;
  if (!pack?.manifest || !pack?.assets) fail('sample-backed score requires a loaded and validated sample pack');
  const ref = artifact.samplePack;
  const manifest = pack.manifest;
  if (ref.packId !== manifest.packId) fail(`loaded pack id "${manifest.packId}" does not match score "${ref.packId}"`);
  if (ref.formatVersion !== manifest.formatVersion) fail('loaded pack format version does not match score');
  if (ref.manifestSha256 !== manifest.manifestSha256) fail('loaded pack manifest SHA-256 does not match score');
  if (ref.contentSha256 !== manifest.contentSha256) fail('loaded pack content SHA-256 does not match score');
  for (const [voice, binding] of Object.entries(artifact.sampleVoices)) {
    const asset = pack.assets[binding.assetId];
    if (!asset) fail(`sample voice ${voice}: asset "${binding.assetId}" is missing from loaded pack`);
    if (asset.metadata.pcmSha256 !== binding.pcmSha256) fail(`sample voice ${voice}: PCM SHA-256 mismatch`);
    if (asset.metadata.suggestedVoice !== voice) fail(`sample voice ${voice}: asset is declared for ${asset.metadata.suggestedVoice}`);
  }
}
