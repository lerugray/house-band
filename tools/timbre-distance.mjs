#!/usr/bin/env node
/**
 * Measured timbre distinctness of the Timbre Range proof renders.
 *
 *   node tools/timbre-distance.mjs [--renders <dir>] [--out <dir>] [--factor 2] [--floor 0.35]
 *
 * PRIMARY matrix (the one the verdict rests on): each kit is rendered lane by
 * lane (every one of the 11 drum lanes as an isolated hit) and each patch note by
 * note (three pitches per voice class). A timbre feature vector per render
 * (energy-weighted MFCC means and spreads, centroid, rolloff, flatness,
 * zero-crossings, flux) is z-scored against the other renders of the SAME lane or
 * pitch, and the distance between two kits (patches) is the mean over lanes
 * (pitches). Mixing eleven lanes into one 8-bar groove averages their character
 * away, so the whole-groove and whole-phrase matrices computed from the proof
 * WAVs are reported too, as SECONDARY context.
 *
 * THRESHOLD, and why. Two renders of the same notes through two different
 * instruments must be farther apart than the largest distance a mere RETUNE of
 * today's recipe reaches (the `controls/` renders: every lane shifted by +-4
 * semitones with different filter/wave parameters), by a safety factor. A pair
 * under the threshold is a defect: the kit or patch is a retune, not a different
 * instrument. Cross-class pairs are not compared: pad and bell phrases differ in
 * notes, so their distance says nothing about timbre.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { noteFreq } from '../src/kit/band.js';
import { KITS } from '../src/presets/kits/index.mjs';
import { PATCHES, PATCH_IDS_BY_CLASS } from '../src/presets/patches/index.mjs';
import { loadCuratedPack } from '../src/sample-pack-node.mjs';
import { corpusStats, readWavMono, timbreDistance, timbreVector } from './lib/audio-features.mjs';
import { ISOLATE_RATE, renderIsolated } from './lib/timbre-isolate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const dir = join(root, 'docs', 'verification', 'timbre-variety-s383');
  const args = { renders: join(dir, 'renders'), out: dir, factor: 1.0, floor: 0.6 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--renders') args.renders = resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = resolve(argv[++i]);
    else if (argv[i] === '--factor') args.factor = Number(argv[++i]);
    else if (argv[i] === '--floor') args.floor = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

const fmt = (n) => n.toFixed(2);

const LANES = ['kick', 'snare', 'hat', 'tomLow', 'tomMid', 'tomHigh', 'clap', 'rim', 'ride', 'crash', 'perc'];
const NOTES = { pad: [['C3', 3], ['C4', 3], ['C5', 3]], bass: [['C1', 0.7], ['C2', 0.7], ['C3', 0.7]], lead: [['C4', 1], ['C5', 1], ['C6', 1]], pluck: [['C3', 0.3], ['C4', 0.3], ['C5', 0.3]], bell: [['C5', 0.5], ['C6', 0.5], ['C7', 0.5]] };
/**
 * Retunes of today's voice: the SAME oscillator structure with its numbers moved
 * (a brighter and a darker setting of cutoff, detune/vibrato/resonance; bell
 * partial spacing). Swapping the oscillator itself (sine for triangle) changes the
 * harmonic series outright, which is a different instrument, not a retune.
 */
const RETUNE_OPTS = {
  pad: [{ cut: 2400, det: 8 }, { cut: 900, det: 1 }],
  bass: [{ cut: 900, q: 2.2 }, { cut: 380, q: 0.7 }],
  lead: [{ cut: 3600, vibrato: 6 }, { cut: 1500, vibrato: 3 }],
  pluck: [{ cut: 4200 }, { cut: 1500 }],
  bell: [{ ratios: [1, 2.1, 3.15, 4.2] }, { ratios: [1, 1.9, 2.85, 3.8] }],
};

/** Every pack bank the kits and patches need, loaded once. */
async function loadBank() {
  const bank = new Map();
  for (const def of [...Object.values(KITS), ...Object.values(PATCHES)]) {
    if (!def.pack) continue;
    const pack = await loadCuratedPack(def.pack.packId);
    for (const [id, asset] of Object.entries(pack.assets)) bank.set(`${def.pack.packId}/${id}`, asset.frames);
  }
  return bank;
}

async function laneVectors(kitId, bank, extra = () => ({})) {
  const out = {};
  for (const lane of LANES) {
    const timbre = kitId ? { kits: { [kitId]: KITS[kitId] }, kit: kitId, sampleBank: bank } : undefined;
    const x = await renderIsolated((v) => v[lane](0.05, extra(lane)), { seconds: 2.4, timbre });
    out[lane] = timbreVector(x, ISOLATE_RATE);
  }
  return out;
}

async function noteVectors(cls, patchId, bank, extra = {}) {
  const out = {};
  for (const [note, dur] of NOTES[cls]) {
    const timbre = patchId ? { patches: { [patchId]: PATCHES[patchId] }, sampleBank: bank } : undefined;
    const opts = { ...(patchId ? { patch: patchId } : {}), ...extra };
    const x = await renderIsolated((v) => v[cls](0.05, noteFreq(note), dur, opts), { seconds: dur + 3.2, timbre });
    out[note] = timbreVector(x, ISOLATE_RATE);
  }
  return out;
}

/** A member is { label, isDefault, vectors: { slot: Float64Array } }; distance = mean over slots. */
function analyseGroup(name, members, controls, args) {
  const all = [...members, ...controls];
  const slots = Object.keys(all[0].vectors);
  const stats = Object.fromEntries(slots.map((slot) => [slot, corpusStats(all.map((m) => m.vectors[slot]))]));
  const dist = (a, b) => slots.reduce((sum, slot) => sum + timbreDistance(a.vectors[slot], b.vectors[slot], stats[slot]), 0) / slots.length;
  const def = members.find((m) => m.isDefault);
  const others = members.filter((m) => !m.isDefault);
  const retune = controls.map((c) => ({ name: c.label, d: dist(def, c) }));
  const retuneMax = retune.length ? Math.max(...retune.map((r) => r.d)) : 0;
  const threshold = Math.max(args.floor, args.factor * retuneMax);
  // Controls are also candidates a kit must be far from: a "kit" that is nearer the retunes than the default is a retune.
  const pairs = [];
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) pairs.push({ a: members[i].label, b: members[j].label, d: dist(members[i], members[j]) });
  pairs.sort((x, y) => x.d - y.d);
  const closest = pairs[0];
  const fromDefault = others.map((m) => ({ name: m.label, d: dist(def, m) })).sort((x, y) => x.d - y.d);
  const below = pairs.filter((p) => p.d < threshold);
  return { name, members, stats, dist, retune, retuneMax, threshold, pairs, closest, fromDefault, below };
}

function matrixTable(group) {
  const names = group.members.map((m) => m.label);
  const head = `| | ${names.join(' | ')} |`;
  const sep = `|---|${names.map(() => '---:').join('|')}|`;
  const rows = group.members.map((a) => `| **${a.label}** | ${group.members.map((b) => (a === b ? '-' : fmt(group.dist(a, b)))).join(' | ')} |`);
  return [head, sep, ...rows].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const index = JSON.parse(readFileSync(join(args.renders, 'index.json'), 'utf8'));
  const bank = await loadBank();
  const load = (row) => {
    const { samples, sampleRate } = readWavMono(readFileSync(join(args.renders, row.file)));
    return { row, vectors: { mix: timbreVector(samples, sampleRate) } };
  };

  const primary = [];
  const kitMembers = [{ label: 'default', isDefault: true, vectors: await laneVectors(null, bank) }];
  for (const id of Object.keys(KITS)) kitMembers.push({ label: id, vectors: await laneVectors(id, bank) });
  const kitControls = [];
  for (const [label, st, factor] of [['retune-up', 4, 1.3], ['retune-down', -4, 0.7]]) {
    kitControls.push({ label, vectors: await laneVectors(null, bank, (lane) => ({
      tune: st,
      ...(lane === 'kick' ? { f0: 130 * factor, f1: 40 * factor } : {}),
      ...(lane === 'snare' ? { bp: 1900 * factor } : {}),
      ...(lane === 'hat' ? { hp: 7000 * factor } : {}),
    })) });
  }
  primary.push(analyseGroup('kits - per-lane (11 lanes as isolated hits)', kitMembers, kitControls, args));
  for (const cls of Object.keys(NOTES)) {
    const members = [{ label: 'default', isDefault: true, vectors: await noteVectors(cls, null, bank) }];
    for (const id of PATCH_IDS_BY_CLASS[cls]) members.push({ label: id, vectors: await noteVectors(cls, id, bank) });
    const controls = [];
    for (let i = 0; i < 2; i++) controls.push({ label: `retune-${i + 1}`, vectors: await noteVectors(cls, null, bank, RETUNE_OPTS[cls][i]) });
    primary.push(analyseGroup(`${cls} patches - per-note (3 pitches)`, members, controls, args));
  }

  const secondary = [];
  secondary.push(analyseGroup('kits - whole 8-bar groove',
    index.files.filter((r) => r.group === 'kits').map((r) => ({ ...load(r), label: r.name, isDefault: r.name === 'default' })),
    index.files.filter((r) => r.group === 'controls' && r.cls === 'kit').map((r) => ({ ...load(r), label: r.name })), args));
  for (const cls of Object.keys(NOTES)) {
    secondary.push(analyseGroup(`${cls} patches - whole 8-bar phrase`,
      index.files.filter((r) => r.group === 'patches' && r.cls === cls).map((r) => ({ ...load(r), label: r.patch ?? 'default', isDefault: r.name === `${cls}-default` })),
      index.files.filter((r) => r.group === 'controls' && r.cls === cls).map((r) => ({ ...load(r), label: r.name })), args));
  }

  const md = ['# Timbre distinctness matrix', '',
    'Generated by `tools/timbre-distance.mjs`. Feature vector: energy-weighted MFCC 1-12 means and spreads, spectral centroid / rolloff / flatness / zero-crossing rate / flux. Distance: RMS z-score difference (about 0 identical, about 1.4 for two unrelated renders), averaged over lanes (kits) or pitches (patches).', '',
    `**Threshold per group = max(${args.floor}, ${args.factor} x the farthest retune control from the default).** The retune controls are the most a composer could do WITHOUT this change: today's recipe retuned (every lane +-4 semitones, kick/snare/hat parameters +-30%; pitched voices with a different wave, cutoff, detune or bell ratios). A kit or patch only counts as new range if it sits farther from the default, and from every sibling, than a retune does, (margin factor ${args.factor}). A pair below the threshold is a defect to fix, not to note. Cross-class pairs are not compared: a pad and a bell play different notes, so their distance says nothing about timbre.`, ''];
  const summary = [];
  const section = (title, groups) => {
    md.push(`# ${title}`, '');
    for (const g of groups) {
      md.push(`## ${g.name}`, '',
        `Retune controls vs default: ${g.retune.map((r) => `${r.name} ${fmt(r.d)}`).join(', ') || 'none'}; threshold **${fmt(g.threshold)}**.`, '',
        `Closest pair: **${g.closest.a} / ${g.closest.b} = ${fmt(g.closest.d)}** (${g.closest.d >= g.threshold ? 'above' : 'BELOW'} threshold).`, '',
        `Each member against today's default: ${g.fromDefault.map((r) => `${r.name} ${fmt(r.d)}`).join(', ')}.`, '',
        g.below.length ? `Pairs below threshold (${g.below.length}): ${g.below.map((p) => `${p.a}/${p.b} ${fmt(p.d)}`).join(', ')}.` : 'No pair is below the threshold.', '',
        matrixTable(g), '');
      summary.push({
        group: g.name, threshold: Number(g.threshold.toFixed(3)), retuneMax: Number(g.retuneMax.toFixed(3)),
        closest: { a: g.closest.a, b: g.closest.b, d: Number(g.closest.d.toFixed(3)) },
        belowThreshold: g.below.map((p) => ({ a: p.a, b: p.b, d: Number(p.d.toFixed(3)) })),
        fromDefault: g.fromDefault.map((r) => ({ name: r.name, d: Number(r.d.toFixed(3)) })),
        matrix: Object.fromEntries(g.members.map((a) => [a.label, Object.fromEntries(g.members.filter((b) => b !== a).map((b) => [b.label, Number(g.dist(a, b).toFixed(3))]))])),
      });
    }
  };
  section('PRIMARY: per-lane (kits) and per-note (patches)', primary);
  section('SECONDARY: whole 8-bar renders (context only; mixing lanes averages character away)', secondary);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'DISTANCE-MATRIX.md'), `${md.join('\n')}\n`);
  writeFileSync(join(args.out, 'distance-matrix.json'), `${JSON.stringify({ factor: args.factor, floor: args.floor, groups: summary }, null, 1)}\n`);
  for (const s of summary) console.log(`${s.group.padEnd(48)} threshold ${s.threshold.toFixed(2)}  retuneMax ${s.retuneMax.toFixed(2)}  closest ${s.closest.a}/${s.closest.b} ${s.closest.d.toFixed(2)}  below: ${s.belowThreshold.length}`);
  const below = summary.slice(0, primary.length).reduce((n, s) => n + s.belowThreshold.length, 0);
  if (below > 0) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
