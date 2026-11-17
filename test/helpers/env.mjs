/** Environmental skips for portable CI: pinned toolchain, Playwright browser, sample packs, private fixtures, Python modules. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { custodyAvailability, custodyProfile } from '../../src/api/profile.mjs';
import { findPackDir } from '../../src/sample-pack-node.mjs';
import { KITS } from '../../src/presets/kits/index.mjs';
import { PATCHES } from '../../src/presets/patches/index.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export const PINNED = custodyAvailability(custodyProfile()).available;
export const REQUIRE_PINNED = process.env.HOUSE_BAND_REQUIRE_PINNED === '1';

export function pinnedSkip(reason = 'render hash pinned to Node v25.9.0 darwin/arm64') {
  if (PINNED || REQUIRE_PINNED) return false;
  return `skipped: ${reason}; run on the pinned toolchain or set HOUSE_BAND_REQUIRE_PINNED=1`;
}

export async function browserSkip() {
  if (REQUIRE_PINNED) return false;
  try {
    const { chromium } = await import('playwright');
    const path = chromium.executablePath();
    if (existsSync(path)) return false;
  } catch {
    // Playwright package or browser binary missing.
  }
  return 'skipped: Playwright browser not installed (npx playwright install chromium)';
}

export function packSkip(packId) {
  if (findPackDir(packId)) return false;
  return `skipped: sample pack ${packId} not installed (see docs/BRING-YOUR-OWN-SAMPLES.md)`;
}

/** Every sample pack a built-in kit or patch needs (the From Mars kits are not in the public repo). */
export function timbrePacksSkip() {
  const ids = new Set();
  for (const def of [...Object.values(KITS), ...Object.values(PATCHES)]) if (def.pack?.packId) ids.add(def.pack.packId);
  for (const id of [...ids].sort()) {
    const skip = packSkip(id);
    if (skip) return skip;
  }
  return false;
}

export function dataSkip(relPath) {
  if (existsSync(join(repoRoot, relPath))) return false;
  return `skipped: private fixture ${relPath} is not in the public repo`;
}

/** A host-only Python dependency (e.g. numpy for scripts/lf-overload-probe.py). */
export function pythonModuleSkip(moduleName) {
  if (REQUIRE_PINNED) return false;
  const probe = spawnSync('python3', ['-c', `import ${moduleName}`], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) return false;
  return `skipped: python3 module ${moduleName} not installed (pip install ${moduleName}); run on the pinned toolchain or set HOUSE_BAND_REQUIRE_PINNED=1`;
}
