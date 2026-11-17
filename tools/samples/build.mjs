#!/usr/bin/env node
/**
 * CLI: house-band samples build (OSS-12).
 * Builds a canonical user pack + house-band.kit.json / house-band.patches.json.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFromConfigFile,
  formatBuildSummary,
  SamplesBuildError,
} from '../../src/samples/build.mjs';

function usage() {
  return `Usage: node tools/samples/build.mjs <config.json> [--out <packs dir>] [--force]

Loads house-band.samples.json, builds pack user-<id> into --out (or the first
HOUSE_BAND_PACKS entry, or ~/.house-band/packs), and writes house-band.kit.json
/ house-band.patches.json beside pack.json. Refuses to write inside the repo
sample-packs/ directory.`;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(usage());
    process.exit(args.length === 0 ? 1 : 0);
  }
  const configPath = args[0];
  let out = null;
  let force = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') {
      out = args[++i];
      if (!out) fail('--out requires a path');
    } else if (a === '--force') {
      force = true;
    } else {
      fail(`unknown argument: ${a}\n${usage()}`);
    }
  }
  return { configPath, out, force };
}

export async function main(argv = process.argv) {
  const { configPath, out, force } = parseArgs(argv);
  try {
    const result = await buildFromConfigFile(configPath, { out, force });
    console.log(formatBuildSummary(result));
    for (const warning of result.warnings || []) {
      console.error(`  warning: ${warning}`);
    }
    return result;
  } catch (err) {
    if (err instanceof SamplesBuildError) {
      fail(err.message, err.exitCode);
    }
    fail(err instanceof Error ? err.message : String(err), 1);
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
