#!/usr/bin/env node
/**
 * CLI: house-band cowrite as-written (OSS-21).
 * Renders a source-song plainly with stand-in voices (no humanization, no added parts).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asWritten, AsWrittenError } from '../../src/cowrite/as-written.mjs';
import { SourceSongError } from '../../src/cowrite/source-song.mjs';
import { renderSpecToWav } from '../../src/render.mjs';
import { SpecError } from '../../src/spec.mjs';

function usage() {
  return `Usage: node tools/cowrite/as-written.mjs <song.source.json> -o <before.wav> [--kit tr808] [--score-out <file>]

Builds a plain as-written score from a house-band-source-song and renders it.`;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let file = null;
  let out = null;
  let kit = 'tr808';
  let scoreOut = null;
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
    } else if (a === '--kit') {
      const value = args[++i];
      if (value == null) fail(`${a} requires a kit id`, 2);
      kit = value;
    } else if (a === '--score-out') {
      const value = args[++i];
      if (value == null) fail(`${a} requires a path`, 2);
      scoreOut = value;
    } else if (a.startsWith('-')) {
      fail(`unknown flag: ${a}`, 2);
    } else if (file == null) {
      file = a;
    } else {
      fail(`unexpected argument: ${a}`, 2);
    }
  }
  if (file == null || out == null) {
    console.error(usage());
    process.exit(2);
  }
  return { file, out, kit, scoreOut };
}

async function main(argv) {
  const { file, out, kit, scoreOut } = parseArgs(argv);
  const absIn = resolve(file);
  const outPath = resolve(out);
  const scorePath = scoreOut != null ? resolve(scoreOut) : `${outPath}.score.json`;

  let raw;
  try {
    raw = readFileSync(absIn, 'utf8');
  } catch (err) {
    fail(`cannot read ${absIn}: ${err.message}`);
  }

  let source;
  try {
    source = JSON.parse(raw);
  } catch (err) {
    fail(`not valid JSON: ${absIn}: ${err.message}`);
  }

  let result;
  try {
    result = asWritten(source, { kit });
  } catch (err) {
    if (err instanceof AsWrittenError || err instanceof SourceSongError || err instanceof SpecError) {
      fail(err.message);
    }
    throw err;
  }

  for (const line of result.messages) console.log(line);

  const scoreJson = `${JSON.stringify(result.spec, null, 2)}\n`;
  mkdirSync(dirname(scorePath), { recursive: true });
  writeFileSync(scorePath, scoreJson, 'utf8');
  console.log(`wrote ${scorePath}`);

  const { wav, manifest } = await renderSpecToWav(result.spec);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, wav);
  const manifestPath = `${outPath}.manifest.json`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${outPath} (${wav.length} bytes)`);
  console.log(`wrote ${manifestPath} (sha256 ${manifest.output.sha256})`);
  console.log(`as-written: ${basename(absIn)} -> ${result.bars} bars, ${result.noteCount} notes, kit ${kit}`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv).catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
