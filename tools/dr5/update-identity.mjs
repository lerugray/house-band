// Explicit development checkpoint: source identity only; never refreshes audio goldens.
// Kit identity = band.js + prng.js + src/timbre.mjs + every file under src/presets/ (tools/lib/kit-identity.mjs).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {kitIdentitySha} from '../lib/kit-identity.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=kitIdentitySha(root), p=path.join(root,'src/version.mjs');
fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/(export const KIT_VERSION = Object.freeze\(\{\s*semver: '\d+\.\d+\.\d+',\s*sha: ')[^']+/,`$1${sha}`));
console.log(sha);
