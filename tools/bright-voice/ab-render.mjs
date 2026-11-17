#!/usr/bin/env node
/**
 * Bright-voice A/B (s462): render one existing score as pinned (its own kit, no bright-voice treatment) and with the
 * kit 1.12.0 bright-voice defaults, whole mix and one isolated stem per bright voice; then measure.
 *
 *   node tools/bright-voice/ab-render.mjs render --score <score.json> --variant old|new|default --part mix|<voice> --out <dir>
 *   node tools/bright-voice/ab-render.mjs report --dir <dir> --voices bell,pluck,lead [--json <out.json>] [--md <out.md>]
 *
 * old = the score as pinned; new = the same score with `brightVoice: "r10"` (the explicit opt-in);
 * default = the same score relabelled to the current kit (1.12.0), where the treatment is the default.
 * Stems are isolated voice renders of the same artifact (app/stems.mjs semantics: opts.voice), sample-aligned with
 * the mix. Nothing is played.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { renderSpecToWav } from '../../src/render.mjs';
import { validateSpec } from '../../src/spec.mjs';
import { KIT_VERSION } from '../../src/version.mjs';
import { band, balance, decay20, loudestWindowDb, lufs, mono, readStereo, rmsDb, truePeakDb } from './measure.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const r2 = (x) => (x === null || x === undefined ? null : +x.toFixed(2));

export function variantScore(score, variant) {
  if (variant === 'old') return score;
  if (variant === 'new') return { ...score, brightVoice: 'r10' };
  if (variant === 'default') return { ...score, kitVersion: { ...KIT_VERSION } };
  throw new Error(`variant ${variant}`);
}

if (cmd === 'render') {
  const score = JSON.parse(readFileSync(resolve(arg('--score')), 'utf8'));
  const variant = arg('--variant'); const part = arg('--part', 'mix'); const out = resolve(arg('--out'));
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const { wav, manifest } = await renderSpecToWav(validateSpec(variantScore(score, variant)), part === 'mix' ? {} : { voice: part });
  const name = `${variant}.${part}`;
  writeFileSync(join(out, `${name}.wav`), wav);
  writeFileSync(join(out, `${name}.manifest.json`), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${name} ${sha256(wav).slice(0, 16)} ${Math.round((Date.now() - t0) / 1000)} s`);
} else if (cmd === 'report') {
  const dir = resolve(arg('--dir')); const voices = arg('--voices').split(',');
  const load = (name) => readStereo(readFileSync(join(dir, `${name}.wav`)));
  const res = { tool: 'tools/bright-voice/ab-render.mjs', stems: [], mix: {} };
  for (const v of voices) {
    if (!existsSync(join(dir, `old.${v}.wav`))) continue;
    const A = load(`old.${v}`); const B = load(`new.${v}`);
    const bA = band(mono(A), A.sr); const bB = band(mono(B), B.sr);
    const wA = loudestWindowDb(bA, A.sr, 10); const wB = loudestWindowDb(bB, B.sr, 10);
    const sameWin = rmsDb(bB, Math.round(wA.startSeconds * B.sr), Math.round((wA.startSeconds + 10) * B.sr));
    const bodyA = rmsDb(band(mono(A), A.sr, 200, 4000)); const bodyB = rmsDb(band(mono(B), B.sr, 200, 4000));
    const dA = decay20(A); const dB = decay20(B, dA);
    const row = {
      voice: v,
      stemSha256: { old: sha256(readFileSync(join(dir, `old.${v}.wav`))), new: sha256(readFileSync(join(dir, `new.${v}.wav`))) },
      b28Loudest10sOldDb: r2(wA.db), b28Loudest10sNewDb: r2(wB.db), b28DeltaDb: r2(wB.db - wA.db),
      b28SameWindowNewDb: r2(sameWin), b28SameWindowDeltaDb: r2(sameWin - wA.db), windowStartOld: wA.startSeconds, windowStartNew: wB.startSeconds,
      body200to4kOldDb: r2(bodyA), body200to4kNewDb: r2(bodyB), bodyDeltaDb: r2(bodyB - bodyA),
      panOldPct: balance(A).panPct, panNewPct: balance(B).panPct,
      decay20OldMs: dA.medianMs, decay20NewMs: dB.medianMs, decayNotes: dA.notes,
      lufsOld: r2(lufs(A)), lufsNew: r2(lufs(B)),
    };
    row.pass = { b28AtLeast3dBLower: row.b28DeltaDb <= -3, pan25to40: Math.abs(row.panNewPct) >= 25 && Math.abs(row.panNewPct) <= 40, longerTail: dB.medianMs !== null && dA.medianMs !== null && dB.medianMs > dA.medianMs };
    res.stems.push(row);
    console.log(JSON.stringify(row));
  }
  for (const variant of ['old', 'new', 'default']) {
    if (!existsSync(join(dir, `${variant}.mix.wav`))) continue;
    const bytes = readFileSync(join(dir, `${variant}.mix.wav`)); const M = readStereo(bytes);
    res.mix[variant] = { sha256: sha256(bytes), seconds: r2(M.n / M.sr), lufs: r2(lufs(M)), dBTP: r2(truePeakDb(M)), panPct: balance(M).panPct };
    console.log(variant, JSON.stringify(res.mix[variant]));
  }
  if (arg('--json')) writeFileSync(resolve(arg('--json')), `${JSON.stringify(res, null, 1)}\n`);
} else {
  console.error('usage: ab-render.mjs render|report ...'); process.exit(2);
}
