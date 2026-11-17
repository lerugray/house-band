import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSamplePack } from './sample-pack.mjs';
import { requiredPackIdsWithUser, requiredPackUsersWithUser, userTimbresOf, USER_KIT_FILE, USER_PATCHES_FILE } from './user-timbres.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const USER_SIDECARS = new Set([USER_KIT_FILE, USER_PATCHES_FILE]);

export async function loadSamplePackDirectory(directory) {
  const root = resolve(directory);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(root, 'pack.json'), 'utf8'));
  } catch (error) {
    throw new Error(`cannot read sample pack manifest ${resolve(root, 'pack.json')}: ${error.message}`);
  }
  // A user pack (samples build, OSS-12) also holds its user kit / patch files beside pack.json. They describe how
  // scores use the pack and are not part of its identity, so they are the only other entries allowed.
  const rootEntries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !(USER_SIDECARS.has(entry.name) && entry.isFile()));
  if (rootEntries.length !== 2
    || !rootEntries.some((entry) => entry.name === 'pack.json' && entry.isFile())
    || !rootEntries.some((entry) => entry.name === 'assets' && entry.isDirectory())) {
    throw new Error('sample pack directory must contain only pack.json and the assets directory');
  }
  const expectedAssetNames = new Set((manifest.assets || []).map((asset) => `${asset.id}.wav`));
  const assetEntries = readdirSync(resolve(root, 'assets'), { withFileTypes: true });
  if (assetEntries.length !== expectedAssetNames.size
    || assetEntries.some((entry) => !entry.isFile() || !expectedAssetNames.has(entry.name))) {
    throw new Error('sample pack assets directory contains a missing, unreferenced, or non-file entry');
  }
  const files = new Map();
  for (const asset of manifest.assets || []) {
    if (typeof asset?.file !== 'string' || asset.file.startsWith('/') || asset.file.split('/').includes('..')) {
      throw new Error('sample pack manifest contains an unsafe asset path');
    }
    try {
      files.set(asset.file, new Uint8Array(readFileSync(resolve(root, asset.file))));
    } catch (error) {
      throw new Error(`cannot read sample pack asset ${asset.file}: ${error.message}`);
    }
  }
  return validateSamplePack(manifest, files, sha256);
}

const PACKS_ROOT = fileURLToPath(new URL('../sample-packs/', import.meta.url));
const packCache = new Map();

const PACK_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** Search roots for curated packs: repo sample-packs/, $HOUSE_BAND_PACKS, ~/.house-band/packs. */
export function packSearchDirs(env = process.env) {
  const dirs = [];
  const seen = new Set();
  const add = (dir) => {
    const abs = resolve(dir);
    if (seen.has(abs)) return;
    seen.add(abs);
    dirs.push(abs);
  };
  add(PACKS_ROOT);
  const raw = env.HOUSE_BAND_PACKS;
  if (typeof raw === 'string' && raw.length > 0) {
    for (const entry of raw.split(delimiter)) {
      if (entry === '') continue;
      add(entry);
    }
  }
  add(join(homedir(), '.house-band', 'packs'));
  return dirs;
}

/**
 * First directory among the search roots that contains packId/pack.json, or null.
 * `roots` is a test-only override of packSearchDirs(env).
 */
export function findPackDir(packId, env = process.env, roots) {
  if (!PACK_ID_RE.test(packId)) throw new Error(`invalid sample pack id "${packId}"`);
  const dirs = roots ?? packSearchDirs(env);
  for (const dir of dirs) {
    const candidate = resolve(dir, packId);
    if (existsSync(resolve(candidate, 'pack.json'))) return candidate;
  }
  return null;
}

function missingPackError(packId, dirs) {
  return new Error(
    `sample pack "${packId}" is not installed. Looked in: ${dirs.join(', ')}. Build it from your own library (docs/BRING-YOUR-OWN-SAMPLES.md) or render with --kit-map to a synth kit.`,
  );
}

function formatPackUsers(labels) {
  return labels.map((label) => {
    const i = label.indexOf(':');
    const kind = label.slice(0, i);
    const name = label.slice(i + 1);
    return `${kind} "${name}"`;
  }).join(', ');
}

/**
 * Load (and cache) a curated sample pack from the pack search path.
 * Packs are immutable by identity, so one validated copy serves every render.
 * `roots` is a test-only override forwarded to findPackDir.
 */
export async function loadCuratedPack(packId, env = process.env, roots) {
  if (!PACK_ID_RE.test(packId)) throw new Error(`invalid sample pack id "${packId}"`);
  const dirs = roots ?? packSearchDirs(env);
  const dir = findPackDir(packId, env, roots);
  if (!dir) throw missingPackError(packId, dirs);
  // Test-only roots bypass the process-wide cache so a hidden pack stays missing.
  if (roots !== undefined) return loadSamplePackDirectory(dir);
  if (!packCache.has(packId)) packCache.set(packId, loadSamplePackDirectory(dir));
  return packCache.get(packId);
}

/**
 * The packs a score's kits, patches and graph-routed samples need, by pack id,
 * or null when it needs none (the neutral path never touches the disk).
 * `scorePack` is the legacy `samplePack` the caller already loaded, if any.
 * `env` / `roots` are forwarded to loadCuratedPack (roots is test-only).
 */
export async function loadTimbrePacks(spec, scorePack = null, env = process.env, roots) {
  const ids = requiredPackIdsWithUser(spec);
  if (ids.length === 0) return null;
  const users = requiredPackUsersWithUser(spec);
  // User packs (OSS-13) load from the exact directory their kit or patch file was found in. Not cached: a user may
  // rebuild a pack between renders, and the definition pins the hashes it was loaded with.
  const userDirs = new Map();
  const registry = userTimbresOf(spec);
  if (registry) for (const entry of [...Object.values(registry.kits), ...Object.values(registry.patches)]) userDirs.set(entry.packId, entry.packDir);
  const packs = new Map();
  for (const id of ids) {
    if (scorePack && scorePack.manifest.packId === id) {
      packs.set(id, scorePack);
      continue;
    }
    if (userDirs.has(id)) {
      packs.set(id, await loadSamplePackDirectory(userDirs.get(id)));
      continue;
    }
    try {
      packs.set(id, await loadCuratedPack(id, env, roots));
    } catch (error) {
      const labels = users.get(id);
      if (labels && labels.length > 0) {
        throw new Error(`${formatPackUsers(labels)} needs ${error.message}`);
      }
      throw error;
    }
  }
  return packs;
}
