#!/usr/bin/env node
/**
 * CLI: house-band samples scan (OSS-11).
 * Walks a folder, reads WAV headers, writes house-band.samples.json + report.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanSamples, slugify, UNSUPPORTED_HINT } from '../../src/samples/scan.mjs';
import { validateSamplesConfig } from '../../src/samples/config.mjs';

const WAV_EXT = new Set(['.wav']);
const UNSUPPORTED_EXT = new Set(['.aif', '.aiff', '.flac', '.mp3', '.ogg']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  return `Usage: node tools/samples/scan.mjs <folder> [--out house-band.samples.json] [--id <slug>] [--force]

Walks <folder> recursively (skips dot-folders), maps WAV roles, writes a samples
config and a .report.json. Unsupported audio extensions are listed with:
  ${UNSUPPORTED_HINT}`;
}

/**
 * Read fmt / data / smpl from a WAV without decoding PCM.
 * @param {string} absPath
 * @returns {{ durationSec: number, midiUnityNote: number|null }}
 */
export function readWavHeader(absPath) {
  const bytes = new Uint8Array(readFileSync(absPath));
  if (bytes.byteLength < 44) fail(`${absPath}: too short to be a WAV`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') fail(`${absPath}: must be a RIFF/WAVE file`);

  let offset = 12;
  let sampleRate = null;
  let blockAlign = null;
  let dataBytes = null;
  let midiUnityNote = null;

  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) fail(`${absPath}: chunk ${id} exceeds file length`);

    if (id === 'fmt ') {
      if (size < 16) fail(`${absPath}: fmt chunk is too short`);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
    } else if (id === 'data') {
      dataBytes = size;
    } else if (id === 'smpl' && size >= 16) {
      const note = view.getUint32(body + 12, true);
      if (Number.isInteger(note) && note <= 127) midiUnityNote = note;
    }

    offset = body + size + (size % 2);
  }

  if (sampleRate === null || blockAlign === null) fail(`${absPath}: missing fmt chunk`);
  if (dataBytes === null) fail(`${absPath}: missing data chunk`);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || blockAlign <= 0) {
    fail(`${absPath}: invalid fmt values`);
  }

  const frameCount = dataBytes / blockAlign;
  const durationSec = frameCount / sampleRate;
  return { durationSec, midiUnityNote };
}

/**
 * Recursive walk; skip dot-folders. Returns relative POSIX paths.
 * @param {string} rootAbs
 * @returns {{ wavs: string[], unsupported: string[] }}
 */
export function walkAudioFiles(rootAbs) {
  const wavs = [];
  const unsupported = [];

  function walk(dirAbs) {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      fail(`${dirAbs}: ${err.message}`);
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const abs = join(dirAbs, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = extname(ent.name).toLowerCase();
      const rel = relative(rootAbs, abs).split(sep).join('/');
      if (WAV_EXT.has(ext)) wavs.push(rel);
      else if (UNSUPPORTED_EXT.has(ext)) unsupported.push(rel);
    }
  }

  walk(rootAbs);
  wavs.sort();
  unsupported.sort();
  return { wavs, unsupported };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(usage());
    process.exit(args.length === 0 ? 1 : 0);
  }
  const folder = args[0];
  let out = 'house-band.samples.json';
  let id = null;
  let force = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') {
      out = args[++i];
      if (!out) fail('--out requires a path');
    } else if (a === '--id') {
      id = args[++i];
      if (!id) fail('--id requires a slug');
    } else if (a === '--force') {
      force = true;
    } else {
      fail(`unknown argument: ${a}\n${usage()}`);
    }
  }
  return { folder, out, id, force };
}

function reportPathFor(outFile) {
  if (outFile.toLowerCase().endsWith('.json')) {
    return `${outFile.slice(0, -'.json'.length)}.report.json`;
  }
  return `${outFile}.report.json`;
}

export function main(argv = process.argv) {
  const { folder, out, id: idOpt, force } = parseArgs(argv);
  const folderAbs = resolve(folder);
  if (!existsSync(folderAbs) || !statSync(folderAbs).isDirectory()) {
    fail(`folder not found: ${folderAbs}`);
  }

  const outAbs = resolve(out);
  if (existsSync(outAbs) && !force) {
    fail(`refusing to overwrite ${outAbs} (pass --force)`);
  }

  const { wavs, unsupported } = walkAudioFiles(folderAbs);
  const files = wavs.map((rel) => {
    const header = readWavHeader(join(folderAbs, rel));
    return {
      file: rel,
      durationSec: header.durationSec,
      midiUnityNote: header.midiUnityNote,
    };
  });

  const id = idOpt || slugify(basename(folderAbs));
  const displayName = basename(folderAbs);
  const { config, report, lines } = scanSamples(files, {
    unsupported,
    id,
    displayName,
    sourcePath: folderAbs,
  });

  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const reportAbs = resolve(reportPathFor(out));
  writeFileSync(reportAbs, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  validateSamplesConfig(JSON.parse(readFileSync(outAbs, 'utf8')), { baseDir: dirname(outAbs) });

  for (const line of lines) console.log(line);
  return { outAbs, reportAbs, config, report };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
