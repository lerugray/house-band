/**
 * User kits and patches (`user:<id>`, OSS-13): the node loader.
 *
 * loadUserTimbres(spec, env) runs BEFORE validateSpec (which stays synchronous) and returns the registry passed to
 * it as `validateSpec(spec, { userTimbres })`:
 *
 *   - `user:<id>` kit: `house-band.kit.json` in pack dir `user-<id>`, the first one found along the OSS-07 pack
 *     search path (packSearchDirs: repo sample-packs/, $HOUSE_BAND_PACKS, ~/.house-band/packs).
 *   - `user:<id>` patch: the first `house-band.patches.json` in a `user-*` pack dir (search-path order, then pack
 *     id order inside one dir) whose object has key `<id>`. A later duplicate is reported once on stderr.
 *
 * Names that are not found, or whose file is not well formed, land in `errors` with the message validation shows
 * (which files were searched, and how to build the pack). The function itself does not throw for those.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, sha256 } from './provenance.mjs';
import { packSearchDirs } from './sample-pack-node.mjs';
import {
  USER_ID_RE,
  USER_KIT_FILE,
  USER_PATCHES_FILE,
  userKitFromFile,
  userPatchFromEntry,
  userTimbreId,
  userTimbreNames,
} from './user-timbres.mjs';

const BUILD_HINT = 'Build it from your samples with `samples build` (node tools/samples/build.mjs house-band.samples.json), or point HOUSE_BAND_PACKS at the folder that holds it.';
const USER_PACK_DIR_RE = /^user-[a-z][a-z0-9-]{0,47}$/;
const reported = new Set();

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readManifest(packDir) {
  const file = join(packDir, 'pack.json');
  if (!isFile(file)) throw new Error(`pack.json is missing beside it in ${packDir}`);
  try {
    return readJson(file);
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function entryFor({ def, packId, packDir, manifest, file, entry }) {
  return {
    def,
    packId,
    packDir,
    formatVersion: manifest.formatVersion,
    manifestSha256: manifest.manifestSha256,
    contentSha256: manifest.contentSha256,
    file,
    entrySha256: sha256(canonicalJson(entry)),
  };
}

function loadKit(name, dirs) {
  const id = userTimbreId(name);
  if (!USER_ID_RE.test(id)) {
    return { error: `user kit "${name}": "${id}" is not a valid user id (lowercase letters, digits and hyphens, starting with a letter)` };
  }
  const packId = `user-${id}`;
  const searched = dirs.map((dir) => join(dir, packId, USER_KIT_FILE));
  const file = searched.find(isFile);
  if (!file) return { error: `user kit "${name}" was not found. Searched: ${searched.join(', ')}. ${BUILD_HINT}` };
  const packDir = join(file, '..');
  try {
    let raw;
    try {
      raw = readJson(file);
    } catch (error) {
      throw new Error(`not valid JSON (${error.message})`);
    }
    const manifest = readManifest(packDir);
    const def = userKitFromFile(name, raw, manifest);
    return { entry: entryFor({ def, packId, packDir, manifest, file: USER_KIT_FILE, entry: raw }) };
  } catch (error) {
    return { error: `user kit "${name}": ${file} is not a usable user kit: ${error.message}. Rebuild it with \`samples build\` (node tools/samples/build.mjs house-band.samples.json).` };
  }
}

/** Every `user-*` pack dir holding house-band.patches.json, in search order, with its parsed file (or read error). */
function patchFiles(dirs) {
  const out = [];
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const packId of names.filter((n) => USER_PACK_DIR_RE.test(n)).sort()) {
      const file = join(dir, packId, USER_PATCHES_FILE);
      if (!isFile(file)) continue;
      let data = null;
      let error = null;
      try {
        data = readJson(file);
        if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('must be a JSON object');
      } catch (e) {
        error = e.message;
        data = null;
      }
      out.push({ packId, packDir: join(dir, packId), file, data, error });
    }
  }
  return out;
}

function loadPatch(name, dirs, files, log) {
  const id = userTimbreId(name);
  if (!USER_ID_RE.test(id)) {
    return { error: `user patch "${name}": "${id}" is not a valid user id (lowercase letters, digits and hyphens, starting with a letter)` };
  }
  const hits = files.filter((f) => f.data && Object.hasOwn(f.data, id));
  if (hits.length === 0) {
    const unreadable = files.filter((f) => f.error).map((f) => `${f.file} (unreadable: ${f.error})`);
    const searched = dirs.map((dir) => join(dir, 'user-*', USER_PATCHES_FILE));
    return {
      error: `user patch "${name}" was not found. Searched: ${searched.join(', ')}${files.length ? ` (found ${files.map((f) => f.file).join(', ')})` : ''}${unreadable.length ? `; ${unreadable.join(', ')}` : ''}. ${BUILD_HINT}`,
    };
  }
  const [hit, ...dupes] = hits;
  for (const dupe of dupes) {
    const message = `user patch "${name}" is defined in more than one pack: using ${hit.file}, ignoring ${dupe.file}`;
    if (!reported.has(message)) {
      reported.add(message);
      log(message);
    }
  }
  try {
    const manifest = readManifest(hit.packDir);
    const def = userPatchFromEntry(name, hit.data[id], manifest, hit.packId);
    return { entry: entryFor({ def, packId: hit.packId, packDir: hit.packDir, manifest, file: USER_PATCHES_FILE, entry: hit.data[id] }) };
  } catch (error) {
    return { error: `user patch "${name}": ${hit.file} is not a usable user patch: ${error.message}. Rebuild it with \`samples build\` (node tools/samples/build.mjs house-band.samples.json).` };
  }
}

/**
 * The user-timbre registry for a raw (not yet validated) score, or null when it names no `user:` kit or patch
 * (then validation and rendering take exactly their historical path).
 *
 * @param {object} spec raw score object
 * @param {NodeJS.ProcessEnv} [env] supplies HOUSE_BAND_PACKS
 * @param {{ roots?: string[], log?: (message: string) => void }} [options] `roots` is a test-only override of
 *   packSearchDirs(env); `log` receives the duplicate-patch notices (default: stderr)
 * @returns {null | { kits: object, patches: object, errors: object }}
 */
export function loadUserTimbres(spec, env = process.env, { roots, log = (message) => console.error(message) } = {}) {
  const names = userTimbreNames(spec);
  if (names.kits.size === 0 && names.patches.size === 0) return null;
  const dirs = roots ?? packSearchDirs(env);
  const kits = {};
  const patches = {};
  const errors = {};
  for (const name of [...names.kits].sort()) {
    const result = loadKit(name, dirs);
    if (result.entry) kits[name] = result.entry;
    else errors[`kit:${name}`] = result.error;
  }
  if (names.patches.size > 0) {
    const files = patchFiles(dirs);
    for (const name of [...names.patches].sort()) {
      const result = loadPatch(name, dirs, files, log);
      if (result.entry) patches[name] = result.entry;
      else errors[`patch:${name}`] = result.error;
    }
  }
  return freezeDeep({ kits, patches, errors });
}
