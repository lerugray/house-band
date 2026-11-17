#!/usr/bin/env node
/**
 * Generate examples/sample-mappings/samples-from-mars/*.mapping.json from the
 * private repo's sample-packs build metadata and pack.json hashes.
 * No audio is copied. Run once where the From Mars packs exist.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKS = join(ROOT, 'sample-packs');
const OUT = join(ROOT, 'examples', 'sample-mappings', 'samples-from-mars');

const PACK_IDS = [
  'm3-tr606-demo',
  'tv-kit-cr78',
  'tv-kit-dystopian-tech',
  'tv-kit-found-wood',
  'tv-kit-linndrum',
  'tv-kit-synare-sds',
  'tv-kit-tr707',
  'tv-kit-vinyl-indie',
];

const M3_PROVENANCE = 'purchased commercial sample collection (Samples From Mars)';
const TV_HINT = "the folder that contains 'Essential WAV From Mars'";
const M3_HINT = "the 'Essential WAV From Mars' folder itself";

function libraryRootHint(packId) {
  return packId === 'm3-tr606-demo' ? M3_HINT : TV_HINT;
}

export function buildMapping(packId, buildMeta, packManifest) {
  const byId = new Map(packManifest.assets.map((asset) => [asset.id, asset]));
  const assets = buildMeta.assets.map((asset) => {
    const built = byId.get(asset.id);
    if (!built) throw new Error(`${packId}: pack.json missing asset id ${asset.id}`);
    if (typeof built.sourceSha256 !== 'string' || !built.sourceSha256) {
      throw new Error(`${packId}: pack.json asset ${asset.id} has no sourceSha256`);
    }
    return { ...asset, expectedSourceSha256: built.sourceSha256 };
  });
  const mapping = {
    ...buildMeta,
    assets,
    libraryRootHint: libraryRootHint(packId),
    expected: {
      manifestSha256: packManifest.manifestSha256,
      contentSha256: packManifest.contentSha256,
    },
  };
  if (packId === 'm3-tr606-demo') mapping.provenance = M3_PROVENANCE;
  return mapping;
}

export function generateAll({ packsDir = PACKS, outDir = OUT } = {}) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const packId of PACK_IDS) {
    const buildPath = join(packsDir, `${packId}.build.json`);
    const packPath = join(packsDir, packId, 'pack.json');
    if (!existsSync(buildPath)) throw new Error(`missing build metadata: ${buildPath}`);
    if (!existsSync(packPath)) throw new Error(`missing pack.json: ${packPath}`);
    const buildMeta = JSON.parse(readFileSync(buildPath, 'utf8'));
    const packManifest = JSON.parse(readFileSync(packPath, 'utf8'));
    if (buildMeta.packId !== packId) throw new Error(`${buildPath}: packId mismatch`);
    if (packManifest.packId !== packId) throw new Error(`${packPath}: packId mismatch`);
    const mapping = buildMapping(packId, buildMeta, packManifest);
    const outPath = join(outDir, `${packId}.mapping.json`);
    writeFileSync(outPath, `${JSON.stringify(mapping, null, 2)}\n`);
    written.push(outPath);
  }
  return written;
}

function main() {
  const written = generateAll();
  for (const path of written) console.log(`wrote ${path}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(`make-from-mars-mappings failed: ${error.message}`);
    process.exitCode = 1;
  }
}
