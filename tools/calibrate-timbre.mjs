#!/usr/bin/env node
/**
 * Loudness-match every kit and patch to the historical voices they replace, in
 * two layers (swapping a patch or kit must not move that part's level).
 *
 *   node tools/calibrate-timbre.mjs            # measure, print both tables
 *   node tools/calibrate-timbre.mjs --write    # also rewrite src/presets/trims.mjs
 *   node tools/calibrate-timbre.mjs --check    # exit 1 on a balance miss (> 1.0 dB) or a proof miss (> 1.5 LU)
 *   node tools/calibrate-timbre.mjs --json <file>   # also save the proof-render LUFS table
 *   node tools/calibrate-timbre.mjs --skip-proof    # layer 1 only (the proof bar has its own test, test/timbre-loudness.test.mjs)
 *
 * 1. KIT LANE BALANCE (per hit). The A-weighted energy of one isolated hit is
 *    matched to the historical kick / snare / hat at its default `vol`; the added
 *    lanes have no historical twin, so each is pinned to a neighbour by a fixed
 *    dB offset (REF_OFFSETS below). This fixes how the lanes of ONE kit sit
 *    against each other, and the offsets never change afterwards.
 * 2. PHRASE LOUDNESS (ITU-R BS.1770 integrated LUFS, tools/lib/loudness.mjs). A
 *    single note's attack energy does not predict how loud a phrase is (s383: a
 *    sawbells bell phrase sat 9.8 LU under the default bell, a linndrum groove
 *    4.7 LU under the default kit). So the trims are solved on the SAME proof
 *    material the proof renders use (tools/lib/timbre-proof-scores.mjs): each
 *    patch's own 8-bar phrase is matched to its class default's phrase, and each
 *    kit takes ONE gain across all its lanes so its 8-bar groove matches the
 *    kit-less groove. A uniform kit gain keeps every lane-vs-twin offset of layer 1.
 *
 * Trims are linear gains applied after shaping; the band's glue compressor makes
 * the full mix very slightly non-linear, so the solve iterates (it converges in
 * two or three passes). Analysis only: nothing plays.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NEUTRAL_LANES, TIMBRE_LANES } from '../src/kit/band.js';
import { KITS } from '../src/presets/kits/index.mjs';
import { PATCHES } from '../src/presets/patches/index.mjs';
import { TRIMS } from '../src/presets/trims.mjs';
import { loadCuratedPack } from '../src/sample-pack-node.mjs';
import { aWeightedEnergy } from './lib/audio-features.mjs';
import { ISOLATE_RATE, renderIsolated } from './lib/timbre-isolate.mjs';
import { LOUDNESS_TOLERANCE_LU, measureProofSet, measureWav, proofJobs, renderProof } from './lib/timbre-loudness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Added lanes have no twin: pin each to a historical lane by a dB offset of A-weighted energy. */
const REF_OFFSETS = Object.freeze({
  kick: ['kick', 0], snare: ['snare', 0], hat: ['hat', 0],
  tomLow: ['kick', 0], tomMid: ['kick', -0.5], tomHigh: ['kick', -1.5],
  clap: ['snare', 0], rim: ['snare', -2], ride: ['hat', 2], crash: ['hat', 3], perc: ['hat', -1],
});
const LANE_WINDOW = [0.05, 0.7];
/** The per-hit lane balance of one kit must hold to this many dB once the kit's single loudness gain is removed. */
const BALANCE_TOLERANCE_DB = 1.0;
/** The phrase solve stops once a render is this close (LU) to its target; far inside LOUDNESS_TOLERANCE_LU. */
const SOLVE_TOLERANCE_LU = 0.05;
const SOLVE_PASSES = 8;

const dB = (ratio) => 10 * Math.log10(ratio);

async function packBank() {
  const ids = new Set();
  for (const def of [...Object.values(KITS), ...Object.values(PATCHES)]) if (def.pack) ids.add(def.pack.packId);
  const bank = new Map();
  for (const id of ids) {
    const pack = await loadCuratedPack(id);
    for (const [assetId, asset] of Object.entries(pack.assets)) bank.set(`${id}/${assetId}`, asset.frames);
  }
  return bank;
}

const energy = (x, window) => aWeightedEnergy(x, ISOLATE_RATE, window[0], window[1]);
const median = (values) => { const v = [...values].sort((a, b) => a - b); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const signed = (x, digits = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;

/** Layer 1: the per-hit lane balance. `perHit[key]` is the trim that puts the lane exactly on its target with no kit gain. */
async function measureLaneBalance(sampleBank) {
  const refs = {};
  for (const lane of ['kick', 'snare', 'hat']) {
    refs[lane] = energy(await renderIsolated((v) => v[lane](0.05, {}), { seconds: 1.0 }), LANE_WINDOW);
  }
  const perHit = {};
  const rows = [];
  for (const [kitId, kit] of Object.entries(KITS)) {
    for (const [laneName, laneDef] of Object.entries(kit.lanes)) {
      const variants = laneDef.variants ? Object.keys(laneDef.variants) : [null];
      for (const variant of variants) {
        const [twin, offset] = REF_OFFSETS[laneName];
        const target = refs[twin] * 10 ** (offset / 10);
        const opts = variant ? { variant } : {};
        const x = await renderIsolated((v) => v[laneName](0.05, opts), { seconds: 1.0, timbre: { kits: { [kitId]: kit }, kit: kitId, sampleBank } });
        const measured = energy(x, LANE_WINDOW);
        const key = `kit:${kitId}:${laneName}${variant ? `:${variant}` : ''}`;
        // Presets already carry the current trim, so the correction multiplies it.
        const correction = measured > 1e-14 ? Math.sqrt(target / measured) : 1;
        perHit[key] = (TRIMS[key] ?? 1) * correction;
        rows.push({ key, kit: kitId, offDb: dB(measured / target) });
      }
    }
  }
  // The neutral recipes (no kit named) live in band.js and carry their own `level`;
  // they are measured here so a drift is visible, but never auto-rewritten.
  for (const laneName of TIMBRE_LANES) {
    const [twin, offset] = REF_OFFSETS[laneName];
    const target = refs[twin] * 10 ** (offset / 10);
    const variants = laneName === 'perc' ? Object.keys(NEUTRAL_LANES.perc.variants) : [null];
    for (const variant of variants) {
      const x = await renderIsolated((v) => v[laneName](0.05, variant ? { variant } : {}), { seconds: 1.0 });
      rows.push({ key: `neutral:${laneName}${variant ? `:${variant}` : ''}`, offDb: dB(energy(x, LANE_WINDOW) / target), neutral: true });
    }
  }
  // A kit's loudness gain (layer 2) moves all its lanes together: judge the balance after removing it.
  for (const kitId of Object.keys(KITS)) {
    const mine = rows.filter((r) => r.kit === kitId);
    const gain = median(mine.map((r) => r.offDb));
    for (const r of mine) { r.kitGainDb = gain; r.balanceDb = r.offDb - gain; }
  }
  for (const r of rows) if (r.neutral) r.balanceDb = r.offDb;
  return { perHit, rows };
}

/** Layer 2: scale `makeFactors(f)` until the proof render of `job` sits on `target` LUFS. Returns the linear factor. */
async function solveFactor(job, makeFactors, target) {
  let f = 1;
  let lufs = NaN;
  for (let pass = 0; pass < SOLVE_PASSES; pass++) {
    lufs = measureWav(await renderProof(job.score, makeFactors(f))).lufs;
    const err = target - lufs;
    if (!Number.isFinite(err)) throw new Error(`${job.id}: render is silent, cannot calibrate`);
    if (Math.abs(err) <= SOLVE_TOLERANCE_LU) return { f, lufs };
    f *= 10 ** (err / 20);
  }
  return { f, lufs };
}

async function main() {
  const args = process.argv.slice(2);
  const has = (flag) => args.includes(flag);
  const jsonPath = has('--json') ? resolve(args[args.indexOf('--json') + 1]) : null;
  const sampleBank = await packBank();

  const { perHit, rows } = await measureLaneBalance(sampleBank);
  const worst = rows.reduce((a, b) => (Math.abs(b.balanceDb) > Math.abs(a.balanceDb) ? b : a));
  const off = rows.filter((r) => Math.abs(r.balanceDb) > BALANCE_TOLERANCE_DB);
  console.log(`${rows.length} entries; worst ${worst.key} at ${worst.balanceDb.toFixed(2)} dB; ${off.length} beyond ${BALANCE_TOLERANCE_DB.toFixed(1)} dB`);
  console.log('  (per-hit lane balance; each kit measured against its own median, i.e. with its loudness gain removed)');
  for (const r of off) console.log(`  ${r.key.padEnd(44)} ${signed(r.balanceDb)} dB`);

  if (has('--skip-proof') && has('--write')) throw new Error('--write needs the proof renders: drop --skip-proof');
  const proof = has('--skip-proof') ? {} : await measureProofSet();
  const proofOff = Object.entries(proof).filter(([, r]) => Math.abs(r.deltaLu) > LOUDNESS_TOLERANCE_LU);
  if (!has('--skip-proof')) {
    const proofWorst = Object.entries(proof).reduce((a, b) => (Math.abs(b[1].deltaLu) > Math.abs(a[1].deltaLu) ? b : a));
    console.log(`${Object.keys(proof).length} proof renders; worst ${proofWorst[0]} at ${signed(proofWorst[1].deltaLu)} LU; ${proofOff.length} beyond ${LOUDNESS_TOLERANCE_LU.toFixed(1)} LU of the class default`);
    for (const [id, r] of proofOff) console.log(`  ${id.padEnd(34)} ${r.lufs.toFixed(2)} LUFS  ${signed(r.deltaLu)} LU`);
  }
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(proof, null, 1)}\n`);

  const next = {};
  if (has('--write')) {
    const jobs = proofJobs();
    // Patches: one factor each on top of the baked trim, so the patch's own phrase meets the class default's.
    for (const job of jobs.filter((j) => j.patch)) {
      const { f, lufs } = await solveFactor(job, (factor) => ({ patchFactor: factor }), proof[job.ref].lufs);
      const key = `patch:${job.patch}`;
      next[key] = Number(((TRIMS[key] ?? 1) * f).toFixed(4));
      console.log(`  ${key.padEnd(34)} ${proof[job.id].lufs.toFixed(2)} -> ${lufs.toFixed(2)} LUFS  (x${f.toFixed(3)})`);
    }
    // Kits: the per-hit balance trims, then ONE gain across every lane of the kit.
    for (const job of jobs.filter((j) => j.kit)) {
      const prefix = `kit:${job.kit}:`;
      const base = (lane, variant) => { const key = `${prefix}${lane}${variant ? `:${variant}` : ''}`; return perHit[key] / (TRIMS[key] ?? 1); };
      const { f, lufs } = await solveFactor(job, (factor) => ({ kitFactor: (lane, variant) => base(lane, variant) * factor }), proof[job.ref].lufs);
      for (const key of Object.keys(perHit).filter((k) => k.startsWith(prefix))) next[key] = Number((perHit[key] * f).toFixed(4));
      console.log(`  ${`kit:${job.kit}`.padEnd(34)} ${proof[job.id].lufs.toFixed(2)} -> ${lufs.toFixed(2)} LUFS  (x${f.toFixed(3)} on the balanced lanes)`);
    }
    const body = Object.keys(next).sort().map((k) => `  ${JSON.stringify(k)}: ${next[k]},`).join('\n');
    writeFileSync(join(root, 'src', 'presets', 'trims.mjs'), `/**
 * Loudness trims for the Timbre Range presets. GENERATED by
 * tools/calibrate-timbre.mjs; do not edit by hand. Two layers:
 *   1. kit lanes sit against each other by per-hit A-weighted energy (the added
 *      lanes pinned to a historical twin by a fixed dB offset, REF_OFFSETS);
 *   2. each kit then takes ONE gain across all its lanes, and each patch its own,
 *      so the proof groove / phrase (tools/lib/timbre-proof-scores.mjs) measures
 *      the same ITU-R BS.1770 integrated LUFS as the kit-less / patch-less
 *      render of the same notes (tools/lib/timbre-loudness.mjs).
 * Keys:  kit:<kit>:<lane>[:<variant>]   patch:<patch>
 */
export const TRIMS = Object.freeze({
${body}
});
`);
    console.log('wrote src/presets/trims.mjs');
  }
  if (has('--check') && (off.length > 0 || proofOff.length > 0)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
