/**
 * house-band.samples.json validator (OSS-10). Hand-written checks; no schema library.
 * Schema docs: docs/schemas/house-band.samples.schema.json
 */
import { isAbsolute, resolve } from 'node:path';

import { DRUM_LANES, PATCH_CLASSES } from '../kit/band.js';
import { KIT_IDS, KITS } from '../presets/kits/index.mjs';
import { PATCHES } from '../presets/patches/index.mjs';

const TOP_KEYS = Object.freeze([
  'format',
  'version',
  'id',
  'displayName',
  'source',
  'licence',
  'fallbackKit',
  'kit',
  'patches',
]);
const TOP_KEY_SET = new Set(TOP_KEYS);
const SOURCE_TYPES = new Set(['folder', 'sfz', 'sf2']);
const SOURCE_KEYS = new Set(['type', 'path', 'preset']);
const VARIANT_OBJECT_KEYS = new Set(['file', 'gain', 'maxSeconds']);
const PATCH_VALUE_KEYS = new Set(['class', 'files', 'zones', 'gain', 'release']);
const ZONE_KEYS = new Set(['file', 'rootNote', 'lo', 'hi']);
const PATCH_CLASS_SET = new Set(PATCH_CLASSES);
const KIT_ID_SET = new Set(KIT_IDS);
const DRUM_LANE_SET = new Set(DRUM_LANES);
const SLUG_RE = /^[a-z][a-z0-9-]{0,47}$/;
const DEFAULT_LICENCE = 'user-supplied; not for redistribution';
const DEFAULT_FALLBACK_KIT = 'tr808';
const DEFAULT_GAIN = 1;
const DEFAULT_MAX_SECONDS = 2;
const DEFAULT_RELEASE = 0.08;

const LANE_VARIANTS = Object.freeze({
  kick: Object.freeze(['a', 'b']),
  snare: Object.freeze(['a', 'b', 'flam']),
  hat: Object.freeze(['closed', 'open']),
});

/** Perc variant names used by built-in kits (collected at load time). */
const PERC_VARIANT_NAMES = (() => {
  const names = new Set();
  for (const kit of Object.values(KITS)) {
    const perc = kit.lanes?.perc;
    if (perc?.variants) {
      for (const name of Object.keys(perc.variants)) names.add(name);
    }
  }
  return Object.freeze([...names].sort());
})();
const PERC_VARIANT_SET = new Set(PERC_VARIANT_NAMES);

function allowedVariantsForLane(lane) {
  if (lane === 'perc') return PERC_VARIANT_SET;
  if (Object.hasOwn(LANE_VARIANTS, lane)) return new Set(LANE_VARIANTS[lane]);
  return new Set(['default']);
}

export class SamplesConfigError extends Error {
  /**
   * @param {string} path JSON-ish path of the bad field (for example `kit.hat.ride`)
   * @param {string} message Plain-English reason
   */
  constructor(path, message) {
    super(message);
    this.name = 'SamplesConfigError';
    this.path = path;
  }
}

function fail(path, message) {
  throw new SamplesConfigError(path, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertWavRelative(file, path) {
  if (typeof file !== 'string' || file.length === 0) {
    fail(path, 'expected a non-empty string file path');
  }
  const normalised = file.replace(/\\/g, '/');
  const segments = normalised.split('/');
  if (segments.some((seg) => seg === '..')) {
    fail(path, 'file path must not contain .. segments');
  }
  if (!/\.wav$/i.test(file)) {
    fail(path, 'file path must end in .wav');
  }
  return file;
}

function inOpenClosed(value, loExclusive, hiInclusive) {
  return typeof value === 'number' && Number.isFinite(value) && value > loExclusive && value <= hiInclusive;
}

function normalizeVariant(value, path) {
  if (typeof value === 'string') {
    const file = assertWavRelative(value, path);
    return { file, gain: DEFAULT_GAIN, maxSeconds: DEFAULT_MAX_SECONDS };
  }
  if (!isPlainObject(value)) {
    fail(path, 'variant must be a file path string or an object with file');
  }
  for (const key of Object.keys(value)) {
    if (!VARIANT_OBJECT_KEYS.has(key)) fail(`${path}.${key}`, 'unknown variant field');
  }
  if (!Object.hasOwn(value, 'file')) fail(`${path}.file`, 'required field');
  const file = assertWavRelative(value.file, `${path}.file`);
  const gain = Object.hasOwn(value, 'gain') ? value.gain : DEFAULT_GAIN;
  const maxSeconds = Object.hasOwn(value, 'maxSeconds') ? value.maxSeconds : DEFAULT_MAX_SECONDS;
  if (!inOpenClosed(gain, 0, 4)) fail(`${path}.gain`, 'gain must be a number in (0, 4]');
  if (!inOpenClosed(maxSeconds, 0, 10)) fail(`${path}.maxSeconds`, 'maxSeconds must be a number in (0, 10]');
  return { file, gain, maxSeconds };
}

function normalizeSource(source, baseDir) {
  if (!isPlainObject(source)) fail('source', 'expected an object');
  for (const key of Object.keys(source)) {
    if (!SOURCE_KEYS.has(key)) fail(`source.${key}`, 'unknown source field');
  }
  if (!Object.hasOwn(source, 'type')) fail('source.type', 'required field');
  if (!Object.hasOwn(source, 'path')) fail('source.path', 'required field');
  if (!SOURCE_TYPES.has(source.type)) {
    fail('source.type', 'type must be "folder", "sfz", or "sf2"');
  }
  if (typeof source.path !== 'string' || source.path.length === 0) {
    fail('source.path', 'expected a non-empty string');
  }
  if (source.type !== 'sf2' && Object.hasOwn(source, 'preset')) {
    fail('source.preset', 'preset is only allowed when source.type is "sf2"');
  }
  let preset = 0;
  if (source.type === 'sf2') {
    if (Object.hasOwn(source, 'preset')) {
      const p = source.preset;
      const okString = typeof p === 'string' && p.length > 0;
      const okIndex = typeof p === 'number' && Number.isInteger(p) && p >= 0;
      if (!okString && !okIndex) {
        fail('source.preset', 'preset must be a non-empty string name or a non-negative integer index');
      }
      preset = p;
    }
  }
  const absPath = isAbsolute(source.path) ? resolve(source.path) : resolve(baseDir, source.path);
  const out = { type: source.type, path: absPath };
  if (source.type === 'sf2') out.preset = preset;
  return out;
}

function normalizeKit(kit) {
  if (!isPlainObject(kit)) fail('kit', 'expected an object');
  const out = {};
  for (const [lane, variants] of Object.entries(kit)) {
    const lanePath = `kit.${lane}`;
    if (!DRUM_LANE_SET.has(lane)) fail(lanePath, `unknown drum lane "${lane}"`);
    if (!isPlainObject(variants)) fail(lanePath, 'expected an object of variants');
    const allowed = allowedVariantsForLane(lane);
    const laneOut = {};
    for (const [variant, value] of Object.entries(variants)) {
      const variantPath = `${lanePath}.${variant}`;
      if (!allowed.has(variant)) {
        fail(variantPath, `unknown variant "${variant}" for lane "${lane}"`);
      }
      laneOut[variant] = normalizeVariant(value, variantPath);
    }
    if (Object.keys(laneOut).length === 0) fail(lanePath, 'lane must list at least one variant');
    out[lane] = laneOut;
  }
  return out;
}

function normalizeZone(zone, path) {
  if (!isPlainObject(zone)) fail(path, 'expected a zone object');
  for (const key of Object.keys(zone)) {
    if (!ZONE_KEYS.has(key)) fail(`${path}.${key}`, 'unknown zone field');
  }
  for (const key of ZONE_KEYS) {
    if (!Object.hasOwn(zone, key)) fail(`${path}.${key}`, 'required field');
  }
  const file = assertWavRelative(zone.file, `${path}.file`);
  for (const noteKey of ['rootNote', 'lo', 'hi']) {
    const n = zone[noteKey];
    if (!Number.isInteger(n) || n < 0 || n > 127) {
      fail(`${path}.${noteKey}`, `${noteKey} must be an integer MIDI note 0-127`);
    }
  }
  return { file, rootNote: zone.rootNote, lo: zone.lo, hi: zone.hi };
}

function normalizePatch(id, patch) {
  const base = `patches.${id}`;
  if (!isPlainObject(patch)) fail(base, 'expected an object');
  for (const key of Object.keys(patch)) {
    if (!PATCH_VALUE_KEYS.has(key)) fail(`${base}.${key}`, 'unknown patch field');
  }
  if (!Object.hasOwn(patch, 'class')) fail(`${base}.class`, 'required field');
  if (!Object.hasOwn(patch, 'zones')) fail(`${base}.zones`, 'required field');
  if (!PATCH_CLASS_SET.has(patch.class)) {
    fail(`${base}.class`, `class must be one of ${PATCH_CLASSES.join(', ')}`);
  }

  const gain = Object.hasOwn(patch, 'gain') ? patch.gain : DEFAULT_GAIN;
  const release = Object.hasOwn(patch, 'release') ? patch.release : DEFAULT_RELEASE;
  if (typeof gain !== 'number' || !Number.isFinite(gain)) fail(`${base}.gain`, 'gain must be a finite number');
  if (typeof release !== 'number' || !Number.isFinite(release) || release < 0) {
    fail(`${base}.release`, 'release must be a non-negative finite number of seconds');
  }

  const out = { class: patch.class, gain, release };

  if (patch.zones === 'auto') {
    if (!Object.hasOwn(patch, 'files')) fail(`${base}.files`, 'files is required when zones is "auto"');
    if (!Array.isArray(patch.files)) fail(`${base}.files`, 'files must be an array of paths');
    if (patch.files.length < 1 || patch.files.length > 24) {
      fail(`${base}.files`, 'files must have between 1 and 24 entries');
    }
    out.files = patch.files.map((f, i) => assertWavRelative(f, `${base}.files.${i}`));
    out.zones = 'auto';
    return out;
  }

  if (!Array.isArray(patch.zones)) {
    fail(`${base}.zones`, 'zones must be "auto" or an array of zone objects');
  }
  if (patch.zones.length < 1) fail(`${base}.zones`, 'zones array must not be empty');
  out.zones = patch.zones.map((z, i) => normalizeZone(z, `${base}.zones.${i}`));
  return out;
}

function normalizePatches(patches) {
  if (!isPlainObject(patches)) fail('patches', 'expected an object');
  const out = {};
  for (const [id, patch] of Object.entries(patches)) {
    const path = `patches.${id}`;
    if (!SLUG_RE.test(id)) fail(path, 'patch id must match ^[a-z][a-z0-9-]{0,47}$');
    if (Object.hasOwn(PATCHES, id)) {
      fail(path, `patch id "${id}" collides with a built-in patch`);
    }
    out[id] = normalizePatch(id, patch);
  }
  return out;
}

/**
 * Validate and normalise a house-band.samples.json object.
 * @param {object} obj parsed config
 * @param {{ baseDir: string }} options baseDir is the config file's folder (for relative source.path)
 * @returns {Readonly<object>} frozen normalised config
 */
export function validateSamplesConfig(obj, { baseDir } = {}) {
  if (typeof baseDir !== 'string' || baseDir.length === 0) {
    fail('baseDir', 'baseDir is required (config file folder)');
  }
  if (!isPlainObject(obj)) fail('', 'config must be a plain object');

  for (const key of Object.keys(obj)) {
    if (!TOP_KEY_SET.has(key)) fail(key, `unknown top-level key "${key}"`);
  }

  if (!Object.hasOwn(obj, 'format')) fail('format', 'required field');
  if (obj.format !== 'house-band-samples') {
    fail('format', 'format must be "house-band-samples"');
  }

  if (!Object.hasOwn(obj, 'version')) fail('version', 'required field');
  if (obj.version !== 1) fail('version', 'version must be 1');

  if (!Object.hasOwn(obj, 'id')) fail('id', 'required field');
  if (typeof obj.id !== 'string' || !SLUG_RE.test(obj.id)) {
    fail('id', 'id must match ^[a-z][a-z0-9-]{0,47}$');
  }

  if (!Object.hasOwn(obj, 'displayName')) fail('displayName', 'required field');
  if (typeof obj.displayName !== 'string' || obj.displayName.length < 1 || obj.displayName.length > 80) {
    fail('displayName', 'displayName must be a string of 1-80 characters');
  }

  if (!Object.hasOwn(obj, 'source')) fail('source', 'required field');

  const hasKit = Object.hasOwn(obj, 'kit');
  const hasPatches = Object.hasOwn(obj, 'patches');
  if (!hasKit && !hasPatches) {
    fail('kit', 'at least one of kit or patches is required');
  }

  const licence = Object.hasOwn(obj, 'licence') ? obj.licence : DEFAULT_LICENCE;
  if (typeof licence !== 'string') fail('licence', 'licence must be a string');

  const fallbackKit = Object.hasOwn(obj, 'fallbackKit') ? obj.fallbackKit : DEFAULT_FALLBACK_KIT;
  if (typeof fallbackKit !== 'string' || !KIT_ID_SET.has(fallbackKit)) {
    fail('fallbackKit', 'fallbackKit must be a built-in kit id');
  }

  const normalised = {
    format: 'house-band-samples',
    version: 1,
    id: obj.id,
    displayName: obj.displayName,
    source: normalizeSource(obj.source, baseDir),
    licence,
    fallbackKit,
  };

  if (hasKit) normalised.kit = normalizeKit(obj.kit);
  if (hasPatches) normalised.patches = normalizePatches(obj.patches);

  return deepFreeze(normalised);
}

export const SAMPLES_CONFIG_TOP_KEYS = TOP_KEYS;
export const PERC_VARIANTS = PERC_VARIANT_NAMES;
