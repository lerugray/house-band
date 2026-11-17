// Fix round 1 (review S2-1): named kits, patches, trims and the timbre engine are inside the kit identity.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

import {kitIdentityFiles, kitIdentitySha} from '../tools/lib/kit-identity.mjs';
import {KIT_VERSION} from '../src/version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (rel) => statSync(join(root, rel)).isDirectory()
  ? readdirSync(join(root, rel)).flatMap((name) => walk(`${rel}/${name}`))
  : [rel];

describe('kit identity covers named kits and patches', () => {
  it('KIT_VERSION.sha equals the identity recomputed from disk (fails if any preset changes without update-identity)', () => {
    assert.equal(kitIdentitySha(root), KIT_VERSION.sha);
  });

  it('the hashed file set is band.js, prng.js, timbre.mjs and EVERY file under src/presets/', () => {
    const files = kitIdentityFiles(root);
    assert.deepEqual(files.slice(0, 2), ['src/kit/band.js', 'src/kit/prng.js']);
    const independent = [...walk('src/presets'), 'src/timbre.mjs'].sort();
    assert.deepEqual(files.slice(2), independent);
    for (const must of ['src/presets/trims.mjs', 'src/presets/kits/index.mjs', 'src/presets/patches/sampled.mjs', 'src/timbre.mjs']) {
      assert.ok(files.includes(must), `${must} is in the kit identity`);
    }
    assert.ok(files.filter((f) => f.startsWith('src/presets/kits/')).length >= 13, 'every named kit file is hashed');
    assert.ok(files.filter((f) => f.startsWith('src/presets/patches/')).length >= 7, 'every patch file is hashed');
  });

  it('changing one byte of any identity file changes the kit sha', () => {
    const base = kitIdentitySha(root);
    for (const target of kitIdentityFiles(root)) {
      const changed = kitIdentitySha(root, (rel) => {
        const bytes = readFileSync(join(root, rel));
        return rel === target ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
      });
      assert.notEqual(changed, base, `${target} must be inside the kit identity`);
    }
  });
});
