#!/usr/bin/env node
/**
 * Offline compose-and-render CLI.
 *   node src/compose.mjs --spec <spec.json> --out <file.wav>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { validateSpec, SpecError, shippingStatus } from './spec.mjs';
import { renderSpecToWav } from './render.mjs';
import { loadSamplePackDirectory } from './sample-pack-node.mjs';
import { siblingFindings } from './palette-node.mjs';
import { applyKitMap, parseKitMap, resolveKitMapVariants } from './kit-map.mjs';
import { canonicalJson, sha256 } from './provenance.mjs';
import { loadUserTimbres } from './user-timbres-node.mjs';
import { userKitFallbackNotes } from './user-timbres.mjs';

function usage() {
  return [
    'Usage: node src/compose.mjs --spec <spec.json> --out <file.wav> [--pack <pack-directory>] [--kit-map <map>]',
    '',
    'Offline-renders a house-band score-spec through the kit and writes',
    'a 16-bit PCM WAV. Same spec + seed yields byte-identical output.',
    '--kit-map a=b[,c=d] substitutes kit names before validation (a target may be a user kit, user:<id>).',
    'User kits and patches (user:<id>) are found along the pack search path (HOUSE_BAND_PACKS).',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { spec: null, out: null, pack: null, kitMap: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--spec') out.spec = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--pack') out.pack = argv[++i];
    else if (a === '--kit-map') out.kitMap = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(usage());
    process.exit(2);
  }

  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.spec || !args.out) {
    console.error('both --spec and --out are required');
    console.error(usage());
    process.exit(2);
  }

  const specPath = resolve(args.spec);
  const outPath = resolve(args.out);

  let raw;
  try {
    raw = readFileSync(specPath, 'utf8');
  } catch (e) {
    console.error(`cannot read spec: ${specPath}`);
    console.error(e.message);
    process.exit(1);
  }

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    console.error(`spec is not valid JSON: ${specPath}`);
    console.error(e.message);
    process.exit(1);
  }

  const originalSpec = spec;
  let kitMapParsed = null;
  let kitMapResult = null;
  let kitMapSubstitutions = [];
  if (args.kitMap != null) {
    try {
      kitMapParsed = parseKitMap(args.kitMap);
      kitMapResult = applyKitMap(spec, kitMapParsed);
      const resolved = resolveKitMapVariants(kitMapResult.spec);
      spec = resolved.spec;
      kitMapSubstitutions = resolved.substitutions;
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    for (const [from, to] of kitMapParsed) {
      const count = kitMapResult.replaced.filter((r) => r.from === from && r.to === to).length;
      if (count > 0) console.error(`kit-map: ${from} -> ${to} (${count} references)`);
    }
    for (const sub of kitMapSubstitutions) {
      if (sub.to == null) {
        console.error(`kit-map: skipped ${sub.lane} hit (variant ${sub.from}; no lane in target kit)`);
      } else {
        console.error(`kit-map: variant substitution ${sub.lane} ${sub.from} -> ${sub.to}`);
      }
    }
  }

  // OSS-13: user kits and patches load before (synchronous) validation; null for a score that names none.
  const userTimbres = loadUserTimbres(spec);
  try {
    spec = validateSpec(spec, { userTimbres });
  } catch (e) {
    if (e instanceof SpecError) {
      console.error(`spec validation failed: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  if (spec.label) console.error(`label: ${spec.label}`);
  for (const note of userKitFallbackNotes(spec)) console.error(note);
  // Timbre-Variety Law: a score that plays the same kit and patches as a sibling in
  // its directory is the violation. Warn on stderr; never change the render or the
  // exit code. HOUSE_BAND_PALETTE_CHECK=off silences it.
  if (process.env.HOUSE_BAND_PALETTE_CHECK !== 'off') {
    try {
      for (const finding of siblingFindings(specPath)) console.error(`palette ${finding.level}: ${finding.message}`);
    } catch (e) {
      console.error(`palette check skipped: ${e.message}`);
    }
  }
  const shipping = shippingStatus(spec);
  if (!shipping.shippable) console.error(`shipping: NON-SHIPPABLE (${shipping.reason})`);

  let samplePack = null;
  if (spec.sampleVoices) {
    if (!args.pack) {
      console.error('sample-backed score requires --pack <pack-directory>');
      process.exit(2);
    }
    samplePack = await loadSamplePackDirectory(args.pack);
  } else if (args.pack) {
    console.error('--pack is only valid for a sample-backed score');
    process.exit(2);
  }

  const { wav, manifest } = await renderSpecToWav(spec, { samplePack });
  const manifestPath = `${outPath}.manifest.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, wav);

  let outManifest = manifest;
  if (kitMapParsed) {
    const derivedScore = `${basename(outPath)}.score.json`;
    const scorePath = `${outPath}.score.json`;
    writeFileSync(scorePath, `${JSON.stringify(spec, null, 2)}\n`);
    outManifest = {
      ...manifest,
      kitMap: {
        map: Object.fromEntries(kitMapParsed),
        sourceArtifactSha256: sha256(canonicalJson(originalSpec)),
        derivedScore,
        replaced: kitMapResult.replaced.length,
        substitutions: kitMapSubstitutions.map((s) => ({ lane: s.lane, from: s.from, to: s.to })),
      },
    };
    console.error(`wrote ${scorePath}`);
  }

  writeFileSync(manifestPath, `${JSON.stringify(outManifest, null, 2)}\n`);
  console.error(`wrote ${outPath} (${wav.length} bytes)`);
  console.error(`wrote ${manifestPath} (sha256 ${manifest.output.sha256})`);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
