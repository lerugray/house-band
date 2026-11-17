// The kit identity: one SHA-256 over every file that decides what a score that names a kit renders as.
// Kit 1.11.0 (Fix round 1, review S2-1): the named kits, instrument patches, generated trims and the
// timbre engine are INSIDE the identity, so editing a preset or regenerating trims changes the kit sha
// instead of silently changing every 1.11.0 score that names a kit.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Always first, in this order (the pre-1.11.0 identity covered exactly these two). */
export const KIT_CORE_FILES = Object.freeze(['src/kit/band.js', 'src/kit/prng.js']);
/** Hashed after the core files, sorted: src/timbre.mjs plus every file under src/presets/ (recursively). */
export const KIT_DATA_ROOTS = Object.freeze(['src/presets', 'src/timbre.mjs']);

function walk(root, rel) {
  const abs = path.join(root, rel);
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs, {withFileTypes: true}).flatMap((entry) => walk(root, `${rel}/${entry.name}`));
}

/** Repo-relative POSIX paths in hash order: core files, then data files sorted by code point. */
export function kitIdentityFiles(root) {
  const data = KIT_DATA_ROOTS.flatMap((rel) => walk(root, rel));
  data.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...KIT_CORE_FILES, ...data];
}

/** path NUL bytes NUL for each file. `read` is injectable so a test can mutate one file in memory. */
export function kitIdentitySha(root, read = (rel) => fs.readFileSync(path.join(root, rel))) {
  const hash = createHash('sha256');
  for (const rel of kitIdentityFiles(root)) hash.update(rel + '\0').update(read(rel)).update('\0');
  return hash.digest('hex');
}
