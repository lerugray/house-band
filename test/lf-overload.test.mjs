/**
 * Standing LF-overload gate (kit 1.7.1).
 *
 * Runs scripts/lf-overload-probe.py against the kit demo / sampler-demo render.
 * REPORT-ONLY for the demo pack: a FAIL verdict is recorded but does not fail
 * the suite (demo material may legitimately sit above calibrated thresholds).
 * Thresholds are documented in the probe script itself.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OfflineAudioContext } from 'node-web-audio-api';

import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { renderSpecToWav } from '../src/render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';
import { pythonModuleSkip } from './helpers/env.mjs';

globalThis.OfflineAudioContext = OfflineAudioContext;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const probe = join(root, 'scripts', 'lf-overload-probe.py');

describe('LF-overload standing gate (report-only for demo pack)', () => {
  let outDir;

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('vendors the probe with documented thresholds and origin credit', () => {
    const src = readFileSync(probe, 'utf8');
    assert.match(src, /ORIGIN: vendored into house-band kit 1\.7\.1/);
    assert.match(src, /ported from a sibling project's probe of the same name/);
    assert.match(src, /THRESHOLDS\s*=/);
    assert.match(src, /sub150_share_pct/);
    assert.match(src, /sub60_share_pct/);
    assert.match(src, /lf_headroom_margin_db/);
  });

  it('probes the sampler demo render and records a report (does not fail the suite)', { skip: pythonModuleSkip('numpy') }, async () => {
    const packRoot = join(root, 'sample-packs', 'sampler-demo-17');
    const demoSpec = join(root, 'examples', 'sampler-demo-spec.json');
    assert.ok(existsSync(packRoot), 'sampler-demo-17 pack must exist');
    assert.ok(existsSync(demoSpec), 'sampler-demo-spec.json must exist');

    const raw = JSON.parse(readFileSync(demoSpec, 'utf8'));
    raw.kitVersion = KIT_VERSION;
    const pack = await loadSamplePackDirectory(packRoot);
    const { wav } = await renderSpecToWav(validateSpec(raw), { samplePack: pack });

    outDir = mkdtempSync(join(tmpdir(), 'hb-lf-'));
    const wavPath = join(outDir, 'sampler-demo-lf-probe.wav');
    writeFileSync(wavPath, wav);

    const result = spawnSync('python3', [probe, wavPath, '--json'], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, String(result.error));
    // Probe exits 1 on FAIL — report-only, so we parse stdout regardless.
    const report = JSON.parse(result.stdout);
    assert.ok(report.metrics);
    assert.ok('sub150_share_pct' in report.metrics);
    assert.ok(['PASS', 'WARN', 'FAIL'].includes(report.verdict));

    writeFileSync(join(outDir, 'lf-overload-report.json'), `${JSON.stringify({
      kit: KIT_VERSION,
      mode: 'report-only',
      thresholdsDocumentedIn: 'scripts/lf-overload-probe.py',
      ...report,
    }, null, 2)}\n`);
  });
});
