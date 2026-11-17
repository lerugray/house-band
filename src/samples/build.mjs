/**
 * samples build (OSS-12): config → canonical user pack + house-band.kit.json / patches.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { validateSamplesConfig, SamplesConfigError } from './config.mjs';
import { buildPack } from '../../tools/build-pack.mjs';
import { CANONICAL_SAMPLE_RATE, parseCanonicalWav } from '../sample-pack.mjs';

const FIXED_CREATED_AT = '1970-01-01T00:00:00Z';
const FULL_SCALE = 32768;
const PITCH_HINT =
  'Hint: give that patch explicit zones with rootNote in the config.';

export class SamplesBuildError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number }} [opts]
   */
  constructor(message, { exitCode = 2 } = {}) {
    super(message);
    this.name = 'SamplesBuildError';
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = 2) {
  throw new SamplesBuildError(message, { exitCode });
}

/** Repo root (directory that contains sample-packs/). */
export function repoRootFromHere() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function samplePacksDir(repoRoot = repoRootFromHere()) {
  return resolve(repoRoot, 'sample-packs');
}

/**
 * True when absPath is the sample-packs directory or a path inside it.
 * @param {string} absPath
 * @param {string} [repoRoot]
 */
export function isInsideRepoSamplePacks(absPath, repoRoot = repoRootFromHere()) {
  const target = resolve(absPath);
  const root = samplePacksDir(repoRoot);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const t = norm(target);
  const r = norm(root);
  if (t === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

/**
 * Output packs directory: --out, else first HOUSE_BAND_PACKS entry, else ~/.house-band/packs.
 * @param {{ out?: string|null, env?: NodeJS.ProcessEnv }} opts
 */
export function resolvePacksOutDir({ out = null, env = process.env } = {}) {
  if (out != null && String(out).length > 0) return resolve(String(out));
  const raw = env.HOUSE_BAND_PACKS;
  if (typeof raw === 'string' && raw.length > 0) {
    for (const entry of raw.split(delimiter)) {
      if (entry !== '') return resolve(entry);
    }
  }
  return resolve(homedir(), '.house-band', 'packs');
}

/**
 * @param {string} lane
 * @param {string} variant
 * @returns {'kick'|'snare'|'hat'|'sampler'}
 */
export function suggestedVoiceForKitAsset(lane, variant) {
  const id = `${lane}-${variant}`;
  if (id.startsWith('kick-')) return 'kick';
  if (id.startsWith('snare-')) return 'snare';
  if (id === 'hat-closed') return 'hat';
  return 'sampler';
}

/**
 * Peak and RMS in dBFS from canonical Int16 PCM (full scale 32768).
 * @param {Int16Array} frames
 * @returns {{ peakDbfs: number, rmsDbfs: number }}
 */
export function pcmPeakRmsDbfs(frames) {
  let peak = 0;
  let sumSq = 0;
  const n = frames.length;
  for (let i = 0; i < n; i++) {
    const s = frames[i];
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  const toDb = (x) => (x <= 0 ? -Infinity : 20 * Math.log10(x / FULL_SCALE));
  return { peakDbfs: toDb(peak), rmsDbfs: toDb(rms) };
}

function roundDur(seconds, maxSeconds) {
  const capped = Math.min(seconds, maxSeconds);
  return Math.round(capped * 1000) / 1000;
}

/**
 * Midpoint zone split: sorted roots → [0..mid], (mid+1).. next, …, ..127.
 * @param {{ id: string, rootNote: number, pcmSha256: string }[]} sorted
 */
export function autoZonesFromRoots(sorted) {
  return sorted.map((entry, i, arr) => {
    const lo = i === 0 ? 0 : Math.floor((arr[i - 1].rootNote + entry.rootNote) / 2) + 1;
    const hi = i === arr.length - 1 ? 127 : Math.floor((entry.rootNote + arr[i + 1].rootNote) / 2);
    return {
      lo,
      hi,
      rootNote: entry.rootNote,
      assetId: entry.id,
      pcmSha256: entry.pcmSha256,
    };
  });
}

/**
 * Build buildPack metadata object from a normalised samples config.
 * @param {object} config validateSamplesConfig result
 */
export function buildPackMetadata(config) {
  const packId = `user-${config.id}`;
  const sourceCollection = basename(config.source.path);
  /** @type {object[]} */
  const assets = [];

  if (config.kit) {
    for (const [lane, variants] of Object.entries(config.kit)) {
      for (const [variant, spec] of Object.entries(variants)) {
        const id = `${lane}-${variant}`;
        const suggestedVoice = suggestedVoiceForKitAsset(lane, variant);
        const asset = {
          sourceFile: spec.file.replace(/\\/g, '/'),
          id,
          displayName: `${config.displayName}: ${lane} ${variant}`,
          suggestedVoice,
          tags: ['user-kit'],
          maxSeconds: spec.maxSeconds,
        };
        if (suggestedVoice === 'sampler') asset.rootNote = 60;
        assets.push(asset);
      }
    }
  }

  if (config.patches) {
    for (const [patchId, patch] of Object.entries(config.patches)) {
      if (patch.zones === 'auto') {
        patch.files.forEach((file, index) => {
          assets.push({
            sourceFile: file.replace(/\\/g, '/'),
            id: `${patchId}-${index + 1}`,
            displayName: `${config.displayName}: ${patchId} ${index + 1}`,
            suggestedVoice: 'sampler',
            tags: ['user-patch'],
          });
        });
      } else {
        patch.zones.forEach((zone, index) => {
          assets.push({
            sourceFile: zone.file.replace(/\\/g, '/'),
            id: `${patchId}-${index + 1}`,
            displayName: `${config.displayName}: ${patchId} ${index + 1}`,
            suggestedVoice: 'sampler',
            tags: ['user-patch'],
            rootNote: zone.rootNote,
          });
        });
      }
    }
  }

  if (assets.length === 0) fail('config has no kit or patch assets to build');

  return {
    packId,
    displayName: config.displayName,
    projectId: 'house-band-user',
    curator: 'user',
    createdAt: FIXED_CREATED_AT,
    provenance: 'user-supplied',
    attribution: config.licence,
    licenseRef: config.licence,
    sourceCollection,
    assets,
  };
}

function packIdentity(manifest) {
  return {
    packId: manifest.packId,
    manifestSha256: manifest.manifestSha256,
    contentSha256: manifest.contentSha256,
  };
}

function assetById(manifest) {
  const map = new Map();
  for (const a of manifest.assets) map.set(a.id, a);
  return map;
}

/**
 * @param {object} config
 * @param {object} manifest
 * @param {Map<string, object>} byId
 */
function buildKitJson(config, manifest, byId) {
  const packId = manifest.packId;
  const pack = packIdentity(manifest);
  const lanes = {};
  for (const [lane, variants] of Object.entries(config.kit)) {
    const keys = Object.keys(variants);
    if (keys.length === 1) {
      const variant = keys[0];
      const spec = variants[variant];
      const id = `${lane}-${variant}`;
      const asset = byId.get(id);
      if (!asset) fail(`built pack missing kit asset ${id}`);
      const dur = roundDur(asset.frameCount / CANONICAL_SAMPLE_RATE, spec.maxSeconds);
      lanes[lane] = {
        sample: `${packId}/${id}`,
        gain: spec.gain,
        dur,
      };
    } else {
      const variantObj = {};
      for (const variant of keys) {
        const spec = variants[variant];
        const id = `${lane}-${variant}`;
        const asset = byId.get(id);
        if (!asset) fail(`built pack missing kit asset ${id}`);
        const dur = roundDur(asset.frameCount / CANONICAL_SAMPLE_RATE, spec.maxSeconds);
        variantObj[variant] = {
          sample: `${packId}/${id}`,
          gain: spec.gain,
          dur,
        };
      }
      lanes[lane] = {
        default: keys[0],
        variants: variantObj,
      };
    }
  }
  return {
    title: config.displayName,
    character: 'user kit',
    lineage: 'user-supplied',
    pack,
    fallbackKit: config.fallbackKit,
    lanes,
  };
}

/**
 * @param {object} config
 * @param {object} manifest
 * @param {Map<string, object>} byId
 */
function buildPatchesJson(config, manifest, byId) {
  const pack = packIdentity(manifest);
  const out = {};
  for (const [patchId, patch] of Object.entries(config.patches)) {
    /** @type {object[]} */
    let zones;
    if (patch.zones === 'auto') {
      const entries = patch.files.map((_, index) => {
        const id = `${patchId}-${index + 1}`;
        const asset = byId.get(id);
        if (!asset) fail(`built pack missing patch asset ${id}`);
        if (asset.rootNote == null) {
          fail(
            `${id}: sampler asset has no measured rootNote after build. ${PITCH_HINT}`,
          );
        }
        return { id, rootNote: asset.rootNote, pcmSha256: asset.pcmSha256 };
      });
      entries.sort((a, b) => a.rootNote - b.rootNote || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      zones = autoZonesFromRoots(entries);
    } else {
      zones = patch.zones.map((zone, index) => {
        const id = `${patchId}-${index + 1}`;
        const asset = byId.get(id);
        if (!asset) fail(`built pack missing patch asset ${id}`);
        return {
          lo: zone.lo,
          hi: zone.hi,
          rootNote: zone.rootNote,
          assetId: id,
          pcmSha256: asset.pcmSha256,
        };
      });
    }
    out[patchId] = {
      id: `user:${patchId}`,
      class: patch.class,
      gain: patch.gain,
      release: patch.release,
      pack,
      zones,
    };
  }
  return out;
}

/**
 * Kit-asset peak/RMS lines from canonical WAV bytes on disk.
 * @param {string} packDir
 * @param {object} manifest
 * @param {object} config
 */
function kitAssetLevels(packDir, manifest, config) {
  if (!config.kit) return [];
  const lines = [];
  const byId = assetById(manifest);
  for (const [lane, variants] of Object.entries(config.kit)) {
    for (const variant of Object.keys(variants)) {
      const id = `${lane}-${variant}`;
      const asset = byId.get(id);
      if (!asset) continue;
      const wav = new Uint8Array(readFileSync(join(packDir, asset.file)));
      const parsed = parseCanonicalWav(wav, id);
      const { peakDbfs, rmsDbfs } = pcmPeakRmsDbfs(parsed.frames);
      lines.push({ id, peakDbfs, rmsDbfs });
    }
  }
  return lines;
}

/**
 * Build a user pack from a normalised config into outDir/user-<id>/.
 * @param {object} config from validateSamplesConfig
 * @param {{ outDir: string, force?: boolean, repoRoot?: string }} options
 */
export async function buildUserPack(config, { outDir, force = false, repoRoot = repoRootFromHere() } = {}) {
  if (typeof outDir !== 'string' || outDir.length === 0) fail('outDir is required');
  const packsRoot = resolve(outDir);
  if (isInsideRepoSamplePacks(packsRoot, repoRoot)) {
    fail(`refusing to write inside the repo sample-packs directory: ${packsRoot}`);
  }

  const packId = `user-${config.id}`;
  const packDir = join(packsRoot, packId);

  if (existsSync(packDir)) {
    if (!force) {
      fail(`pack already exists: ${packDir} (pass --force to overwrite)`);
    }
    rmSync(packDir, { recursive: true, force: true });
  }

  mkdirSync(packsRoot, { recursive: true });

  const metadata = buildPackMetadata(config);
  const metaPath = join(tmpdir(), `hb-samples-build-${process.pid}-${randomBytes(8).toString('hex')}.json`);
  writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  let result;
  try {
    try {
      result = await buildPack({
        inputDir: config.source.path,
        metadataPath: metaPath,
        outputDir: packDir,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no root-note label and no confident pitch/i.test(message)) {
        fail(`${message}\n${PITCH_HINT}`, 1);
      }
      fail(message, 1);
    }
  } finally {
    try {
      rmSync(metaPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  const { manifest } = result;
  const byId = assetById(manifest);

  if (config.kit) {
    const kitJson = buildKitJson(config, manifest, byId);
    writeFileSync(join(packDir, 'house-band.kit.json'), `${JSON.stringify(kitJson, null, 2)}\n`, 'utf8');
  }
  if (config.patches) {
    const patchesJson = buildPatchesJson(config, manifest, byId);
    writeFileSync(join(packDir, 'house-band.patches.json'), `${JSON.stringify(patchesJson, null, 2)}\n`, 'utf8');
  }

  const levels = kitAssetLevels(packDir, manifest, config);
  const fileCount = countPackFiles(packDir);

  return {
    packId,
    packDir,
    contentSha256: manifest.contentSha256,
    manifestSha256: manifest.manifestSha256,
    assetCount: manifest.assetCount,
    fileCount,
    levels,
    warnings: result.warnings,
  };
}

function countPackFiles(packDir) {
  let n = 0;
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) n += 1;
    }
  };
  if (existsSync(packDir) && statSync(packDir).isDirectory()) walk(packDir);
  return n;
}

/**
 * Load, validate, and build from a config file path.
 * @param {string} configPath
 * @param {{ out?: string|null, force?: boolean, env?: NodeJS.ProcessEnv, repoRoot?: string }} options
 */
export async function buildFromConfigFile(configPath, {
  out = null,
  force = false,
  env = process.env,
  repoRoot = repoRootFromHere(),
} = {}) {
  const absConfig = resolve(configPath);
  let raw;
  try {
    raw = JSON.parse(readFileSync(absConfig, 'utf8'));
  } catch (err) {
    fail(`cannot read config ${absConfig}: ${err.message}`, 1);
  }
  let config;
  try {
    config = validateSamplesConfig(raw, { baseDir: dirname(absConfig) });
  } catch (err) {
    if (err instanceof SamplesConfigError) {
      fail(`invalid samples config (${err.path}): ${err.message}`, 1);
    }
    throw err;
  }
  const outDir = resolvePacksOutDir({ out, env });
  return buildUserPack(config, { outDir, force, repoRoot });
}

/**
 * Format the stdout summary for a successful build.
 * @param {Awaited<ReturnType<typeof buildUserPack>>} result
 */
export function formatBuildSummary(result) {
  const lines = [
    `pack ${result.packId}`,
    `contentSha256 ${result.contentSha256.slice(0, 12)}`,
    `files ${result.fileCount}`,
  ];
  for (const { id, peakDbfs, rmsDbfs } of result.levels) {
    const peak = Number.isFinite(peakDbfs) ? peakDbfs.toFixed(1) : String(peakDbfs);
    const rms = Number.isFinite(rmsDbfs) ? rmsDbfs.toFixed(1) : String(rmsDbfs);
    lines.push(`  ${id}: peak ${peak} dBFS, RMS ${rms} dBFS`);
  }
  return lines.join('\n');
}
