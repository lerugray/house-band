/**
 * Phrase-level loudness of the Timbre Range proof renders (ITU-R BS.1770
 * integrated loudness, tools/lib/loudness.mjs). The proof set is ONE 8-bar groove
 * through every kit and ONE 8-bar phrase per voice class through every patch of
 * that class (tools/lib/timbre-proof-scores.mjs); the class default (kit-less /
 * patch-less) render of the same notes is the reference. Swapping a kit or patch
 * must not move that part's level: every render lands within LOUDNESS_TOLERANCE_LU
 * of its class default. Shared by tools/calibrate-timbre.mjs (solves the trims),
 * tools/timbre-proof.mjs (reports) and test/timbre-loudness.test.mjs (gate).
 * Analysis only: nothing here plays audio.
 */
import { KITS } from '../../src/presets/kits/index.mjs';
import { PATCHES, PATCH_IDS_BY_CLASS } from '../../src/presets/patches/index.mjs';
import { renderSpecToWav } from '../../src/render.mjs';
import { loadTimbrePacks } from '../../src/sample-pack-node.mjs';
import { validateSpec } from '../../src/spec.mjs';
import { resolveTimbre } from '../../src/timbre.mjs';
import { integratedLufs, readWavChannels } from './loudness.mjs';
import { grooveScore, phraseScore } from './timbre-proof-scores.mjs';

/** A kit or patch proof render may sit this far (LU, integrated) from its class default. */
export const LOUDNESS_TOLERANCE_LU = 1.5;
export const PHRASE_CLASSES = Object.freeze(['pad', 'bass', 'lead', 'pluck', 'bell']);

/** Scale a kit's lane levels (sample lanes: gain) by `factor(laneName, variantName | null)`, on top of the baked trims. */
export function scaleKit(kit, factor) {
  const scaleLane = (lane, laneName, variant) => {
    if (lane.variants) {
      return { ...lane, variants: Object.fromEntries(Object.entries(lane.variants).map(([name, v]) => [name, scaleLane(v, laneName, name)])) };
    }
    const f = factor(laneName, variant);
    return lane.sample !== undefined ? { ...lane, gain: (lane.gain ?? 1) * f } : { ...lane, level: (lane.level ?? 1) * f };
  };
  return { ...kit, lanes: Object.fromEntries(Object.entries(kit.lanes).map(([name, lane]) => [name, scaleLane(lane, name, null)])) };
}

/** Scale a patch's output gain by a linear factor, on top of the baked trim. */
export const scalePatch = (patch, factor) => ({ ...patch, gain: (patch.gain ?? 1) * factor });

/**
 * Render one proof score to WAV bytes. `kitFactor(laneName, variantName)` and
 * `patchFactor` multiply the baked trims for the kit / patch the score names
 * (omitted = the shipped presets, byte-identical to timbre-proof.mjs).
 */
export async function renderProof(score, { kitFactor, patchFactor } = {}) {
  const spec = validateSpec(score);
  const packs = await loadTimbrePacks(spec, null);
  const base = resolveTimbre(spec, packs);
  let timbre = base;
  if (base && (kitFactor || patchFactor !== undefined)) {
    timbre = {
      ...base,
      kits: Object.fromEntries(Object.entries(base.kits).map(([id, kit]) => [id, kitFactor ? scaleKit(kit, kitFactor) : kit])),
      patches: Object.fromEntries(Object.entries(base.patches).map(([id, patch]) => [id, patchFactor !== undefined ? scalePatch(patch, patchFactor) : patch])),
    };
  }
  const { wav } = await renderSpecToWav(spec, base ? { timbre, timbrePacks: packs } : {});
  return wav;
}

/** Integrated LUFS and sample peak (dBFS) of WAV bytes. */
export function measureWav(wav) {
  const { channels, sampleRate } = readWavChannels(wav);
  let peak = 0;
  for (const channel of channels) for (const v of channel) peak = Math.max(peak, Math.abs(v));
  return { lufs: integratedLufs(channels, sampleRate), peakDb: 20 * Math.log10(Math.max(peak, 1e-9)) };
}

/** Every proof render the loudness bar covers, with the class default it is judged against. */
export function proofJobs() {
  const jobs = [{ id: 'kit:default', group: 'kit', cls: 'kit', ref: 'kit:default', score: grooveScore({}) }];
  for (const id of Object.keys(KITS)) jobs.push({ id: `kit:${id}`, group: 'kit', cls: 'kit', kit: id, ref: 'kit:default', score: grooveScore({ kit: id }) });
  for (const cls of PHRASE_CLASSES) {
    jobs.push({ id: `${cls}:default`, group: 'patch', cls, ref: `${cls}:default`, score: phraseScore({ cls }) });
    for (const id of PATCH_IDS_BY_CLASS[cls]) jobs.push({ id: `${cls}:${id}`, group: 'patch', cls, patch: id, ref: `${cls}:default`, score: phraseScore({ cls, patch: id }) });
  }
  return jobs;
}

/** LUFS of every proof render under the shipped presets: { [job.id]: { lufs, peakDb, ref, deltaLu } }. */
export async function measureProofSet() {
  const out = {};
  for (const job of proofJobs()) out[job.id] = { ...measureWav(await renderProof(job.score)), ref: job.ref, group: job.group, cls: job.cls };
  for (const row of Object.values(out)) row.deltaLu = row.lufs - out[row.ref].lufs;
  return out;
}
