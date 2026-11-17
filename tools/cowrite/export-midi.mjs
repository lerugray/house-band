#!/usr/bin/env node
/**
 * CLI: house-band cowrite export-midi (OSS-23).
 *
 *   node tools/cowrite/export-midi.mjs <score.json> [-o arrangement.mid] [--develop develop.json]
 *
 * Writes an SMF type 1 arrangement MIDI (PPQ 480) from a developed score.
 * With --develop, section start bars come from develop.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportArrangementMidi } from '../../src/cowrite/export-midi.mjs';

function usage() {
  return `Usage: node tools/cowrite/export-midi.mjs <score.json> [-o arrangement.mid] [--develop develop.json]

Writes arrangement.mid (SMF type 1, PPQ 480) from a developed House Band score.`;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let file = null;
  let out = null;
  let develop = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (a === '-o' || a === '--out') {
      const value = args[++i];
      if (value == null) fail(`${a} requires a path`, 2);
      out = value;
    } else if (a === '--develop') {
      const value = args[++i];
      if (value == null) fail(`${a} requires a path`, 2);
      develop = value;
    } else if (a.startsWith('-')) {
      fail(`unknown flag: ${a}`, 2);
    } else if (file == null) {
      file = a;
    } else {
      fail(`unexpected argument: ${a}`, 2);
    }
  }
  if (file == null) {
    console.error(usage());
    process.exit(2);
  }
  return { file, out, develop };
}

function main(argv) {
  const { file, out, develop } = parseArgs(argv);
  const scorePath = resolve(file);
  const outPath = resolve(out ?? 'arrangement.mid');
  let spec;
  try {
    spec = JSON.parse(readFileSync(scorePath, 'utf8'));
  } catch (err) {
    fail(`cannot read ${scorePath}: ${err.message}`);
  }
  let sections;
  let timeSignature;
  if (develop) {
    try {
      const rec = JSON.parse(readFileSync(resolve(develop), 'utf8'));
      sections = rec.sections ?? rec.record?.sections;
    } catch (err) {
      fail(`cannot read develop record: ${err.message}`);
    }
  }
  const bytes = exportArrangementMidi(spec, { sections, timeSignature });
  writeFileSync(outPath, bytes);
  console.log(`wrote ${outPath} (${bytes.length} bytes)`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(err.stack || err.message || err);
    process.exit(1);
  }
}
