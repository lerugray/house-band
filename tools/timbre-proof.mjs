#!/usr/bin/env node
/**
 * Render the Timbre Range proof set: ONE 8-bar groove through every kit and ONE
 * 8-bar phrase per voice class through every patch of that class, plus the
 * historical (kit-less, patch-less) render of each as the reference, plus the
 * "retune" controls the distinctness threshold is measured against.
 *
 *   node tools/timbre-proof.mjs [--out <dir>] [--only kits|patches] [--no-controls]
 *
 * Writes <out>/{kits,patches,controls,scores}/..., index.json (hashes, durations,
 * kit/patch metadata) and INDEX.md. The notes never change between renders; only
 * the kit or patch does. Nothing is played: files are written for analysis, and
 * for a listen set the seat stages later.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderSpecToWav } from '../src/render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KITS } from '../src/presets/kits/index.mjs';
import { PATCHES, PATCH_IDS_BY_CLASS } from '../src/presets/patches/index.mjs';
import { readWavMono } from './lib/audio-features.mjs';
import { wavLufs } from './lib/loudness.mjs';
import { grooveScore, phraseScore } from './lib/timbre-proof-scores.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { out: join(root, 'docs', 'verification', 'timbre-variety-s383', 'renders'), only: null, controls: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = resolve(argv[++i]);
    else if (argv[i] === '--only') args.only = argv[++i];
    else if (argv[i] === '--no-controls') args.controls = false;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

/**
 * Retune controls: what you get by merely retuning today's recipes. Every event
 * is shifted by `semitones` and the historical kick/snare/hat get different
 * frequency parameters; pitched voices change wave and filter. A kit or patch
 * only counts as a different instrument if it is farther from the default than
 * these are.
 */
function retunedGroove(shift) {
  const score = grooveScore({ label: `retune control ${shift > 0 ? '+' : ''}${shift} st` });
  const factor = shift > 0 ? 1.3 : 0.7;
  for (const track of Object.values(score.tracks)) {
    for (const event of track.steps) {
      event.opts = { ...event.opts, tune: shift };
      if (event.voice === 'kick') Object.assign(event.opts, { f0: 130 * factor, f1: 40 * factor, dur: 0.24 * (shift > 0 ? 0.85 : 1.2) });
      if (event.voice === 'snare') Object.assign(event.opts, { bp: 1900 * factor, q: shift > 0 ? 1.2 : 0.6 });
      if (event.voice === 'hat') Object.assign(event.opts, { hp: 7000 * factor });
    }
  }
  return score;
}

const RETUNE_OPTS = {
  pad: [{ cut: 2400, det: 8 }, { cut: 900, det: 1 }],
  bass: [{ cut: 900, q: 2.2 }, { cut: 380, q: 0.7 }],
  lead: [{ cut: 3600, vibrato: 6 }, { cut: 1500, vibrato: 3 }],
  pluck: [{ cut: 4200 }, { cut: 1500 }],
  bell: [{ ratios: [1, 2.1, 3.15, 4.2] }, { ratios: [1, 1.9, 2.85, 3.8] }],
};

function retunedPhrase(cls, index) {
  const score = phraseScore({ cls, label: `retune control ${cls} ${index + 1}` });
  for (const track of Object.values(score.tracks)) for (const event of track.steps) event.opts = { ...event.opts, ...RETUNE_OPTS[cls][index] };
  return score;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function renderTo(args, rows, group, name, score, meta) {
  const spec = validateSpec(score);
  const { wav, manifest } = await renderSpecToWav(spec, {});
  const file = `${group}/${name}.wav`;
  mkdirSync(dirname(join(args.out, file)), { recursive: true });
  writeFileSync(join(args.out, file), wav);
  mkdirSync(join(args.out, 'scores'), { recursive: true });
  writeFileSync(join(args.out, 'scores', `${group}-${name}.score.json`), `${JSON.stringify(score, null, 1)}\n`);
  const { samples } = readWavMono(wav);
  let peak = 0; let sum = 0;
  for (const v of samples) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  const db = (x) => Number((20 * Math.log10(Math.max(x, 1e-9))).toFixed(1));
  rows.push({
    group, name, file, bytes: wav.length, sha256: sha256(wav), seconds: Number((manifest.render.frames / manifest.render.sampleRate).toFixed(2)),
    peakDb: db(peak), rmsDb: db(Math.sqrt(sum / samples.length)), lufs: Number(wavLufs(wav).toFixed(2)),
    timbre: manifest.timbre ?? null, ...meta,
  });
  console.error(`  ${file}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const rows = [];
  if (!args.only || args.only === 'kits') {
    console.error('kits (8-bar groove)');
    await renderTo(args, rows, 'kits', 'default', grooveScore({}), { cls: 'kit', title: 'Historical default (no kit)', character: 'today\'s kick / snare / hat; the added lanes use their neutral recipes' });
    for (const [id, kit] of Object.entries(KITS)) {
      await renderTo(args, rows, 'kits', id, grooveScore({ kit: id }), { cls: 'kit', title: kit.title, character: kit.character, kind: kit.kind });
    }
    if (args.controls) {
      await renderTo(args, rows, 'controls', 'kit-retune-up', retunedGroove(4), { cls: 'kit', control: true, title: 'Retune control +4 st', character: 'default recipes, every lane retuned up' });
      await renderTo(args, rows, 'controls', 'kit-retune-down', retunedGroove(-4), { cls: 'kit', control: true, title: 'Retune control -4 st', character: 'default recipes, every lane retuned down' });
    }
  }
  if (!args.only || args.only === 'patches') {
    for (const cls of ['pad', 'bass', 'lead', 'pluck', 'bell']) {
      console.error(`${cls} patches (8-bar phrase)`);
      await renderTo(args, rows, 'patches', `${cls}-default`, phraseScore({ cls }), { cls, title: `Historical ${cls}`, character: 'today\'s voice with its default parameters' });
      for (const id of PATCH_IDS_BY_CLASS[cls]) {
        await renderTo(args, rows, 'patches', `${cls}-${id}`, phraseScore({ cls, patch: id }), { cls, patch: id, title: PATCHES[id].title, character: PATCHES[id].character, engine: PATCHES[id].engine });
      }
      if (args.controls) {
        for (let i = 0; i < 2; i++) {
          await renderTo(args, rows, 'controls', `${cls}-retune-${i + 1}`, retunedPhrase(cls, i), { cls, control: true, title: `Retune control ${i + 1}`, character: `historical ${cls} with filter / detune / ratio numbers moved` });
        }
      }
    }
  }
  // Integrated loudness (ITU-R BS.1770) against the class default of the same notes: the bar is +-1.5 LU (test/timbre-loudness.test.mjs).
  const lufsOf = Object.fromEntries(rows.map((r) => [r.file, r.lufs]));
  for (const r of rows) {
    if (r.control) continue;
    const ref = r.group === 'kits' ? 'kits/default.wav' : `patches/${r.cls}-default.wav`;
    if (lufsOf[ref] !== undefined) r.deltaLu = Number((r.lufs - lufsOf[ref]).toFixed(2));
  }
  writeFileSync(join(args.out, 'index.json'), `${JSON.stringify({ generator: 'tools/timbre-proof.mjs', files: rows }, null, 1)}\n`);
  const lines = ['# Timbre Range proof renders', '',
    'One fixed 8-bar groove through every kit; one fixed 8-bar phrase per voice class through every patch of that class.',
    'The notes never change between renders, only the kit or the patch. Reference = the historical voices (kit-less / patch-less).',
    'Retune controls (`controls/`) are today\'s recipes merely retuned: the distinctness threshold is measured against them.',
    'Analysis only. Nothing here was played; a listen set for Ray is staged by the seat afterwards.', '',
    'LUFS = integrated loudness (ITU-R BS.1770, K-weighted); "vs default" = LU from the kit-less / patch-less render of the same notes (bar: within +-1.5 LU).', '',
    '| file | what | seconds | peak dBFS | RMS dBFS | LUFS | vs default (LU) | sha256 (first 16) |', '|---|---|---:|---:|---:|---:|---:|---|'];
  for (const r of rows) lines.push(`| \`${r.file}\` | ${r.title}${r.control ? ' (control)' : ''} | ${r.seconds} | ${r.peakDb} | ${r.rmsDb} | ${r.lufs} | ${r.deltaLu === undefined ? '' : `${r.deltaLu >= 0 ? '+' : ''}${r.deltaLu}`} | ${r.sha256.slice(0, 16)} |`);
  lines.push('', 'Scores that produced these renders: `scores/`. Regenerate everything: `node tools/timbre-proof.mjs`.', '');
  writeFileSync(join(args.out, 'INDEX.md'), lines.join('\n'));
  console.error(`wrote ${rows.length} renders -> ${args.out}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
