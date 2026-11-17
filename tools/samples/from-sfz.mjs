#!/usr/bin/env node
/**
 * SFZ -> house-band.samples.json (OSS-14).
 * Usage:
 *   node tools/samples/from-sfz.mjs <file.sfz> --class <pad|bass|lead|pluck|bell>
 *     [--id <slug>] [--out house-band.samples.json]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { PATCH_CLASSES } from '../../src/kit/band.js';
import { validateSamplesConfig } from '../../src/samples/config.mjs';
import { sfzToSamplesConfig, slugifySfzName } from '../../src/samples/sfz.mjs';

const PATCH_CLASS_SET = new Set(PATCH_CLASSES);

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage: node tools/samples/from-sfz.mjs <file.sfz> --class <pad|bass|lead|pluck|bell> [--id <slug>] [--out house-band.samples.json]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let sfzFile = null;
  let patchClass = null;
  let id = null;
  let out = 'house-band.samples.json';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--class') {
      patchClass = args[++i];
      if (!patchClass) usage('--class needs a value');
    } else if (arg === '--id') {
      id = args[++i];
      if (!id) usage('--id needs a value');
    } else if (arg === '--out') {
      out = args[++i];
      if (!out) usage('--out needs a value');
    } else if (arg.startsWith('-')) {
      usage(`unknown flag ${arg}`);
    } else if (sfzFile === null) {
      sfzFile = arg;
    } else {
      usage(`unexpected argument ${arg}`);
    }
  }

  if (!sfzFile) usage('missing <file.sfz>');
  if (!patchClass) usage('missing --class');
  if (!PATCH_CLASS_SET.has(patchClass)) {
    usage(`--class must be one of ${PATCH_CLASSES.join(', ')}`);
  }

  return { sfzFile, patchClass, id, out };
}

function main() {
  const { sfzFile, patchClass, id: idOpt, out } = parseArgs(process.argv);
  const sfzPath = resolve(sfzFile);
  const text = readFileSync(sfzPath, 'utf8');
  const id = idOpt || slugifySfzName(basename(sfzPath));
  const sourcePath = dirname(sfzPath);
  const outPath = resolve(out);

  const { config, ignoredOpcodes, unsupported } = sfzToSamplesConfig({
    text,
    patchClass,
    id,
    displayName: id,
    sourcePath,
  });

  validateSamplesConfig(config, { baseDir: dirname(outPath) });

  writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  if (ignoredOpcodes.length > 0) {
    console.log(`ignored opcodes: ${ignoredOpcodes.join(', ')}`);
  }
  for (const file of unsupported) {
    console.log(`unsupported: ${file}`);
  }
  console.log(`wrote ${outPath}`);
}

main();
