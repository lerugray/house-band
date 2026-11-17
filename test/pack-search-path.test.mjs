/** OSS-07: pack search path ($HOUSE_BAND_PACKS, ~/.house-band/packs) and missing-pack messages. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findPackDir,
  loadSamplePackDirectory,
  loadTimbrePacks,
  packSearchDirs,
} from '../src/sample-pack-node.mjs';
import { validateSpec } from '../src/spec.mjs';
import { miniScore } from './helpers/timbre.mjs';

const PACKS_ROOT = fileURLToPath(new URL('../sample-packs/', import.meta.url));
const HOME_PACKS = join(homedir(), '.house-band', 'packs');

describe('pack search path', () => {
  it('packSearchDirs lists repo, HOUSE_BAND_PACKS entries, then ~/.house-band/packs', () => {
    const dirs = packSearchDirs({ HOUSE_BAND_PACKS: '/a' + delimiter + '/b' });
    assert.deepEqual(dirs, [resolve(PACKS_ROOT), resolve('/a'), resolve('/b'), HOME_PACKS]);
  });

  it('findPackDir resolves a pack from HOUSE_BAND_PACKS when repo roots are hidden', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hb-pack-search-'));
    try {
      const p1 = join(tmp, 'p1');
      cpSync(join(PACKS_ROOT, 'sampler-demo-17'), join(p1, 'sampler-demo-17'), { recursive: true });
      const env = { HOUSE_BAND_PACKS: p1 };
      const roots = [resolve(p1), HOME_PACKS];
      const dir = findPackDir('sampler-demo-17', env, roots);
      assert.equal(dir, resolve(p1, 'sampler-demo-17'));
      const pack = await loadSamplePackDirectory(dir);
      assert.equal(pack.manifest.packId, 'sampler-demo-17');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('missing pack for kit tr707 names the kit and points at --kit-map', async () => {
    const score = validateSpec(miniScore(
      [{ i: 0, voice: 'kick', opts: { vol: 0.1 } }],
      { extra: { kit: 'tr707' } },
    ));
    await assert.rejects(
      () => loadTimbrePacks(score, null, {}, []),
      (err) => {
        assert.match(err.message, /kit "tr707" needs/);
        assert.match(err.message, /--kit-map/);
        return true;
      },
    );
  });
});
