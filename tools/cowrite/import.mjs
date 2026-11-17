#!/usr/bin/env node
/**
 * CLI: house-band cowrite import (OSS-17 / OSS-18 / OSS-19 / OSS-20).
 * Dispatches by extension; formats not built yet exit 3 (none at the moment).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importMidi } from '../../src/cowrite/import-midi.mjs';
import { importMod } from '../../src/cowrite/import-mod.mjs';
import { importS3m } from '../../src/cowrite/import-s3m.mjs';
import { importXm } from '../../src/cowrite/import-xm.mjs';
import { importIt } from '../../src/cowrite/import-it.mjs';
import { importXrns } from '../../src/cowrite/import-xrns.mjs';
import { beatsPerBar, validateSourceSong } from '../../src/cowrite/source-song.mjs';
import {
  PITCH_CONVENTION_LINE,
  ROWS_PER_BEAT_LINE,
} from '../../src/cowrite/tracker-common.mjs';

const BUILT = new Set(['.mid', '.midi', '.mod', '.s3m', '.xm', '.it', '.xrns']);
const TRACKER_EXTS = new Set(['.mod', '.s3m', '.xm', '.it']);
const KNOWN_NOT_BUILT = new Set();

function usage() {
  return `Usage: node tools/cowrite/import.mjs <file> [-o <out.source.json>]

Imports a user piece to house-band-source-song JSON.
Supported: .mid / .midi / .mod / .s3m / .xm / .it / .xrns`;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let file = null;
  let out = null;
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
  return { file, out };
}

function printSummary(song, ext) {
  if (TRACKER_EXTS.has(ext)) {
    console.log(PITCH_CONVENTION_LINE);
    console.log(ROWS_PER_BEAT_LINE);
  }
  const bars = song.lengthBeats / beatsPerBar(song.timeSignature);
  const [num, den] = song.timeSignature;
  console.log(`title: ${song.title}`);
  console.log(`tempo: ${song.tempo}`);
  console.log(`timeSignature: ${num}/${den}`);
  console.log(`lengthBars: ${bars}`);
  for (const t of song.tracks) {
    let low = null;
    let high = null;
    for (const n of t.notes) {
      if (low == null || n.midi < low) low = n.midi;
      if (high == null || n.midi > high) high = n.midi;
    }
    const range = low == null ? 'n/a' : `${low}-${high}`;
    console.log(
      `${t.id} ${t.name || '-'} ${t.kind} ${t.roleGuess} notes=${t.notes.length} range=${range}`,
    );
  }
}

function importByExt(ext, bytes, name) {
  if (ext === '.mid' || ext === '.midi') return importMidi(bytes, name);
  if (ext === '.mod') return importMod(bytes, name);
  if (ext === '.s3m') return importS3m(bytes, name);
  if (ext === '.xm') return importXm(bytes, name);
  if (ext === '.it') return importIt(bytes, name);
  if (ext === '.xrns') return importXrns(bytes, name);
  fail(`unsupported file type: ${ext || '(none)'}`);
}

function defaultOutPath(abs, ext) {
  const base = basename(abs).replace(/\.(mid|midi|mod|s3m|xm|it|xrns)$/i, '');
  return join(dirname(abs), `${base}.source.json`);
}

function main(argv) {
  const { file, out } = parseArgs(argv);
  const abs = resolve(file);
  const ext = extname(abs).toLowerCase();

  if (KNOWN_NOT_BUILT.has(ext)) {
    fail('importer not built yet', 3);
  }
  if (!BUILT.has(ext)) {
    fail(`unsupported file type: ${ext || '(none)'}`, 1);
  }

  let bytes;
  try {
    bytes = readFileSync(abs);
  } catch (err) {
    fail(`cannot read ${abs}: ${err.message}`);
  }

  let song;
  try {
    song = importByExt(ext, bytes, basename(abs));
    song = validateSourceSong(song);
  } catch (err) {
    fail(err.message || String(err));
  }

  const outPath = out != null ? resolve(out) : defaultOutPath(abs, ext);

  // validateSourceSong freezes; clone for JSON.stringify
  const payload = JSON.parse(JSON.stringify(song));
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  printSummary(song, ext);
  console.log(`wrote ${outPath}`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main(process.argv);
