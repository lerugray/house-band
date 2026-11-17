#!/usr/bin/env node
/**
 * Strip an .xrns to notes-only: write a zip holding only Song.xml
 * (byte-identical member content) and print removed member names.
 * Usage: node tools/cowrite/strip-xrns.mjs <in.xrns> <out.xrns>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractMember,
  listMembers,
  writeZipStored,
} from '../../src/cowrite/zip.mjs';

function usage() {
  return 'Usage: node tools/cowrite/strip-xrns.mjs <in.xrns> <out.xrns>';
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 2 || args[0] === '-h' || args[0] === '--help') {
    console.error(usage());
    process.exit(args.length === 2 ? 0 : 2);
  }
  const inPath = resolve(args[0]);
  const outPath = resolve(args[1]);
  const bytes = readFileSync(inPath);
  const members = listMembers(bytes);
  if (!members.includes('Song.xml')) {
    console.error('Song.xml missing from input');
    process.exit(1);
  }
  const songXml = extractMember(bytes, 'Song.xml');
  const removed = members.filter((n) => n !== 'Song.xml');
  for (const name of removed) {
    console.log(name);
  }
  const out = writeZipStored([{ name: 'Song.xml', data: songXml }]);
  writeFileSync(outPath, out);
}

const invoked =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main(process.argv);
