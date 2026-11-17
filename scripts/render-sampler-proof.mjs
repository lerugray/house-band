#!/usr/bin/env node
/**
 * Render the kit-1.7.0 sampler proof: the full demo phrase plus one stem per
 * sampled voice, and an objective (never audible) analysis of each.
 *
 * Stems make the low chord auditable on its own, which is the part of this
 * demo the fleet's low-chord remediation actually needs to inspect.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OfflineAudioContext } from 'node-web-audio-api';
import { readFileSync } from 'node:fs';

import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { renderSpecToWav } from '../src/render.mjs';
import { validateSpec } from '../src/spec.mjs';

globalThis.OfflineAudioContext = OfflineAudioContext;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'proof', 'sampler-17-20260829');
mkdirSync(outDir, { recursive: true });

const spec = JSON.parse(readFileSync(join(root, 'examples', 'sampler-demo-spec.json'), 'utf8'));
const pack = await loadSamplePackDirectory(join(root, 'sample-packs', 'sampler-demo-17'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Peak and RMS in dBFS. Analysis only — nothing here plays audio. */
function levels(wav) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const frames = (wav.byteLength - 44) / 4;
  let peak = 0;
  let sum = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of [0, 2]) {
      const sample = view.getInt16(44 + frame * 4 + channel, true) / 32768;
      peak = Math.max(peak, Math.abs(sample));
      sum += sample * sample;
    }
  }
  const rms = Math.sqrt(sum / (frames * 2));
  const db = (value) => (value === 0 ? -Infinity : 20 * Math.log10(value));
  return { frames, seconds: frames / 44100, peakDb: db(peak), rmsDb: db(rms) };
}

const targets = [
  ['sampler-demo', {}],
  ['stem-bell-electric-piano', { voice: 'bell' }],
  ['stem-pluck-humbucker-guitar', { voice: 'pluck' }],
  ['stem-bass-ms20', { voice: 'bass' }],
  ['stem-lead-ms20-square', { voice: 'lead' }],
];

const report = [];
for (const [name, opts] of targets) {
  const artifact = validateSpec(structuredClone(spec));
  const { wav, manifest } = await renderSpecToWav(artifact, { samplePack: pack, ...opts });
  writeFileSync(join(outDir, `${name}.wav`), wav);
  writeFileSync(join(outDir, `${name}.wav.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  const level = levels(wav);
  report.push({
    file: `${name}.wav`,
    bytes: wav.length,
    seconds: Number(level.seconds.toFixed(3)),
    peakDbfs: Number(level.peakDb.toFixed(2)),
    rmsDbfs: Number(level.rmsDb.toFixed(2)),
    sha256: sha256(wav),
  });
  console.error(`${name.padEnd(30)} ${String(wav.length).padStart(9)} B  ${level.seconds.toFixed(2)}s  peak ${level.peakDb.toFixed(2)} dBFS  rms ${level.rmsDb.toFixed(2)} dBFS`);
}

writeFileSync(join(outDir, 'render-report.json'), `${JSON.stringify({
  kit: JSON.parse(readFileSync(join(outDir, 'sampler-demo.wav.manifest.json'), 'utf8')).kitVersion,
  pack: { packId: pack.manifest.packId, formatVersion: pack.manifest.formatVersion, totalWavBytes: pack.manifest.totalWavBytes, assetCount: pack.manifest.assetCount },
  renders: report,
}, null, 2)}\n`);

// Kit 1.7.1: standing LF-overload probe on demo renders (report-only — demo pack
// may sit above calibrated thresholds; do not fail the proof script on FAIL).
const probe = join(root, 'scripts', 'lf-overload-probe.py');
const lfReports = [];
for (const [name] of targets) {
  const wavPath = join(outDir, `${name}.wav`);
  const result = spawnSync('python3', [probe, wavPath, '--json'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  const body = JSON.parse(result.stdout || '{}');
  lfReports.push({ file: `${name}.wav`, verdict: body.verdict, metrics: body.metrics });
  console.error(`lf-overload ${name.padEnd(30)} ${body.verdict}`);
}
writeFileSync(join(outDir, 'lf-overload-report.json'), `${JSON.stringify({
  mode: 'report-only',
  origin: 'scripts/lf-overload-probe.py (vendored from a sibling project)',
  thresholds: 'documented in probe THRESHOLDS',
  renders: lfReports,
}, null, 2)}\n`);
