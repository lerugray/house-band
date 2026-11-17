#!/usr/bin/env node
/**
 * Re-render every STORED Timbre Range proof score (docs/verification/timbre-variety-s383/renders/scores/,
 * each pinned to the kit it was rendered with) and compare the WAV hash with the one recorded in index.json.
 *
 *   node tools/bright-voice/proof-identity.mjs [--wavs <dir>] [--out <result.json>]
 *
 * Exit 0 only when every render is byte-identical. Nothing is played. --wavs keeps the renders for analysis.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderSpecToWav } from '../../src/render.mjs';
import { validateSpec } from '../../src/spec.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const proofDir = join(root, 'docs', 'verification', 'timbre-variety-s383', 'renders');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? resolve(process.argv[i + 1]) : null; };
const wavDir = arg('--wavs');
const out = arg('--out');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const index = JSON.parse(readFileSync(join(proofDir, 'index.json'), 'utf8'));
const results = [];
for (const row of index.files) {
  const scorePath = join(proofDir, 'scores', `${row.group}-${row.name}.score.json`);
  const score = JSON.parse(readFileSync(scorePath, 'utf8'));
  const { wav } = await renderSpecToWav(validateSpec(score), {});
  const hash = sha256(wav);
  const ok = hash === row.sha256 && wav.length === row.bytes;
  if (wavDir) { mkdirSync(dirname(join(wavDir, row.file)), { recursive: true }); writeFileSync(join(wavDir, row.file), wav); }
  results.push({ file: row.file, kit: `${score.kitVersion.semver}+${score.kitVersion.sha.slice(0, 12)}`, identical: ok, sha256: hash });
  console.log(`${row.file.padEnd(40)} ${ok ? 'IDENTICAL' : 'DIFFERENT'} ${hash.slice(0, 16)}`);
}
const identical = results.filter((r) => r.identical).length;
console.log(`${identical}/${results.length} identical`);
if (out) writeFileSync(out, `${JSON.stringify({ tool: 'tools/bright-voice/proof-identity.mjs', identical, total: results.length, results }, null, 1)}\n`);
process.exit(identical === results.length ? 0 : 1);
