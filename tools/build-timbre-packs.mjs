#!/usr/bin/env node
/**
 * Build the Timbre Range sample packs from Ray's library and generate the preset
 * data that pins them.
 *
 *   node tools/build-timbre-packs.mjs --input <sample library root> (or --ray-samples <dir>) [--only <packId>] [--force] [--presets-only]
 *
 * For each pack in tools/timbre-pack-specs.mjs this
 *   1. writes sample-packs/<packId>.build.json (the build-pack input),
 *   2. runs tools/build-pack.mjs into sample-packs/<packId>/ (only the hits the
 *      kit or patches use, trimmed to their audible part),
 *   3. writes src/presets/kits/<kit>.mjs / src/presets/patches/sampled.mjs with
 *      the pack's manifest + content SHA-256 pinned, per-asset peak-normalising
 *      gains and natural lengths.
 *
 * The library is read-only: nothing under ray-samples is ever written. Output
 * is deterministic, so a rebuild reproduces the committed packs byte for byte.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPack } from './build-pack.mjs';
import { DRUM_PACKS, DRUM_ROOT, LICENSE, PATCH_PACKS, PROVENANCE } from './timbre-pack-specs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CREATED_AT = '2026-11-03T06:00:00Z';
const round = (value, places) => Number(value.toFixed(places));

const USAGE = 'usage: node tools/build-timbre-packs.mjs --input <sample library root> (or --ray-samples <dir>) [--only <packId>] [--force] [--presets-only]';

function parseArgs(argv) {
  const args = { raySamples: process.env.HOUSE_BAND_SAMPLE_LIBRARY ?? null, only: null, force: false, presetsOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ray-samples' || argv[i] === '--input') args.raySamples = resolve(argv[++i]);
    else if (argv[i] === '--only') args.only = argv[++i];
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--presets-only') args.presetsOnly = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

/** The named export of a generated kit module (the Audition Room bundler has no default exports). */
const kitExport = (id) => `KIT_${id.toUpperCase().replaceAll('-', '_')}`;

function prettyName(prefix, id) {
  return `${prefix}: ${id.replaceAll('-', ' ')}`;
}

async function build(spec, metadata, args) {
  const outDir = join(root, 'sample-packs', spec.packId);
  // --presets-only regenerates the preset data from the packs already on disk
  // (no ray-samples needed): used when only descriptions or lane mappings change.
  if (args.presetsOnly) return JSON.parse(readFileSync(join(outDir, 'pack.json'), 'utf8'));
  const metaPath = join(root, 'sample-packs', `${spec.packId}.build.json`);
  if (existsSync(outDir)) {
    if (!args.force) throw new Error(`${outDir} exists; pass --force to rebuild a tv-* pack`);
    if (!spec.packId.startsWith('tv-')) throw new Error('refusing to remove a pack that is not a tv-* Timbre Range pack');
    rmSync(outDir, { recursive: true });
  }
  mkdirSync(dirname(metaPath), { recursive: true });
  writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const result = await buildPack({ inputDir: args.raySamples, metadataPath: metaPath, outputDir: outDir });
  for (const warning of result.warnings) console.error(`  warning: ${warning}`);
  return result.manifest;
}

// ---- drum kits ---------------------------------------------------------------
function drumMetadata(spec) {
  return {
    packId: spec.packId,
    displayName: spec.displayName,
    projectId: 'house-band',
    curator: 'Ray Weiss',
    createdAt: CREATED_AT,
    provenance: PROVENANCE,
    attribution: 'Selected by Claude from Ray Weiss\'s purchased Essential WAV From Mars collection (ray-samples) under the Timbre-Variety Law\'s named-source clause.',
    licenseRef: LICENSE,
    sourceCollection: spec.sourceCollection,
    assets: spec.kit.assets.map((a) => ({
      sourceFile: a.file,
      id: a.id,
      displayName: prettyName(spec.kit.title, a.id),
      suggestedVoice: a.voice,
      tags: a.tags,
      maxSeconds: a.maxSeconds,
      ...(a.voice === 'sampler' ? { rootNote: DRUM_ROOT } : {}),
    })),
  };
}

function kitSource(spec, manifest) {
  const byId = Object.fromEntries(manifest.assets.map((a) => [a.id, a]));
  const key = (id) => `${spec.packId}/${id}`;
  const gainOf = (id) => 32768 / Math.max(1, byId[id].peakAbs);
  const durOf = (id) => byId[id].frameCount / 44100;
  const lane = (value) => {
    if (typeof value === 'string' || Array.isArray(value)) {
      const ids = Array.isArray(value) ? value : [value];
      for (const id of ids) if (!byId[id]) throw new Error(`${spec.kit.id}: lane names unknown asset "${id}"`);
      return {
        sample: ids.length === 1 ? key(ids[0]) : ids.map(key),
        gain: round(ids.reduce((sum, id) => sum + gainOf(id), 0) / ids.length, 4),
        dur: round(Math.max(...ids.map(durOf)), 3),
      };
    }
    if (value.asset !== undefined) return { ...lane(value.asset), ...(value.tune ? { tune: value.tune } : {}) };
    const { default: chosen, ...rest } = value;
    return { default: chosen, variants: Object.fromEntries(Object.entries(rest).map(([name, v]) => [name, lane(v)])) };
  };
  const lanes = Object.fromEntries(Object.entries(spec.kit.lanes).map(([name, value]) => [name, lane(value)]));
  const def = {
    title: spec.kit.title,
    character: spec.kit.character,
    lineage: spec.kit.lineage,
    pack: { packId: spec.packId, manifestSha256: manifest.manifestSha256, contentSha256: manifest.contentSha256 },
    lanes,
  };
  return `import { makeKit } from './_dsl.mjs';

// GENERATED by tools/build-timbre-packs.mjs from tools/timbre-pack-specs.mjs.
// Do not edit by hand: rebuild instead. The pack identity below pins the exact
// samples; a pack that differs by one byte is refused at render time.
export const ${kitExport(spec.kit.id)} = makeKit(${JSON.stringify(spec.kit.id)}, ${JSON.stringify(def, null, 2)});
`;
}

// ---- sample-backed patches -----------------------------------------------------
function patchMetadata(spec) {
  return {
    packId: spec.packId,
    displayName: spec.displayName,
    projectId: 'house-band',
    curator: 'Ray Weiss',
    createdAt: CREATED_AT,
    provenance: spec.provenance,
    attribution: spec.attribution,
    licenseRef: spec.licenseRef,
    sourceCollection: spec.sourceCollection,
    assets: spec.assets.map((a) => ({
      sourceFile: a.file,
      id: a.id,
      displayName: prettyName(spec.displayName, a.id),
      suggestedVoice: 'sampler',
      tags: a.tags,
      maxSeconds: a.maxSeconds,
      ...(a.rootNote === undefined ? {} : { rootNote: a.rootNote }),
    })),
  };
}

function patchEntries(spec, manifest) {
  const byId = Object.fromEntries(manifest.assets.map((a) => [a.id, a]));
  return spec.patches.map((patch) => {
    const zones = patch.zones.map((z) => {
      const asset = byId[z.asset];
      if (!asset) throw new Error(`${patch.id}: zone names unknown asset "${z.asset}"`);
      return {
        lo: z.lo, hi: z.hi, root: asset.rootNote, key: `${spec.packId}/${z.asset}`,
        g: round(32768 / Math.max(1, asset.peakAbs), 4), dur: round(asset.frameCount / 44100, 3),
      };
    });
    return {
      id: patch.id, class: patch.class, title: patch.title, character: patch.character,
      lineage: `ray-samples: ${spec.sourceCollection}`, vol: patch.vol, env: patch.env, verb: patch.verb,
      pack: { packId: spec.packId, manifestSha256: manifest.manifestSha256, contentSha256: manifest.contentSha256 },
      params: { zones, ring: patch.ring },
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.raySamples === null && !args.presetsOnly) {
    console.error(USAGE);
    process.exit(2);
  }
  if (!args.presetsOnly && !existsSync(args.raySamples)) throw new Error(`ray-samples not found at ${args.raySamples}`);
  const sampled = [];
  for (const spec of DRUM_PACKS) {
    if (args.only && args.only !== spec.packId) continue;
    console.error(`building ${spec.packId}`);
    const manifest = await build(spec, drumMetadata(spec), args);
    writeFileSync(join(root, 'src', 'presets', 'kits', `${spec.kit.id}.mjs`), kitSource(spec, manifest));
    console.error(`  ${manifest.assetCount} assets, ${manifest.totalWavBytes} WAV bytes -> kit ${spec.kit.id}`);
  }
  for (const spec of PATCH_PACKS) {
    if (args.only && args.only !== spec.packId) continue;
    console.error(`building ${spec.packId}`);
    const manifest = await build(spec, patchMetadata(spec), args);
    sampled.push(...patchEntries(spec, manifest));
    console.error(`  ${manifest.assetCount} assets, ${manifest.totalWavBytes} WAV bytes -> ${spec.patches.length} patches`);
  }
  if (!args.only) {
    writeFileSync(join(root, 'src', 'presets', 'patches', 'sampled.mjs'), `import { makePatch } from './_dsl.mjs';

// GENERATED by tools/build-timbre-packs.mjs from tools/timbre-pack-specs.mjs.
// Do not edit by hand: rebuild instead. Each patch pins its sample pack's identity.
const SAMPLED = ${JSON.stringify(sampled, null, 2)};

export const PATCHES_SAMPLED = SAMPLED.map(({ id, class: cls, ...rest }) => makePatch(id, cls, 'sample', rest));
`);
  }
}

main().catch((error) => {
  console.error(`build-timbre-packs failed: ${error.message}`);
  process.exitCode = 1;
});
