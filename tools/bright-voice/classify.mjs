#!/usr/bin/env node
/**
 * Which pitched voices are "bright"? Reads the patch proof renders (one fixed 8-bar phrase per class through every
 * patch, tools/timbre-proof.mjs or tools/bright-voice/proof-identity.mjs --wavs) and reports each one's share of power
 * above 2 kHz and its 2-8 kHz RMS relative to its own full-band RMS.
 *   node tools/bright-voice/classify.mjs --wavs <dir with patches/*.wav> [--out <json>]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { band, mono, readStereo, rmsDb, shareAbove } from './measure.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? resolve(process.argv[i + 1]) : null; };
const dir = join(arg('--wavs'), 'patches');
const rows = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.wav')).sort()) {
  const s = readStereo(readFileSync(join(dir, f)));
  const m = mono(s);
  rows.push({ file: `patches/${f}`, above2kPct: +shareAbove(s, 2000).toFixed(1), above1kPct: +shareAbove(s, 1000).toFixed(1), b28RelDb: +(rmsDb(band(m, s.sr)) - rmsDb(m)).toFixed(1) });
}
rows.sort((a, b) => b.above2kPct - a.above2kPct);
for (const r of rows) console.log(`${r.file.padEnd(38)} >2k ${String(r.above2kPct).padStart(5)}%  >1k ${String(r.above1kPct).padStart(5)}%  2-8k rel ${r.b28RelDb} dB`);
if (arg('--out')) writeFileSync(arg('--out'), `${JSON.stringify({ tool: 'tools/bright-voice/classify.mjs', rows }, null, 1)}\n`);
