#!/usr/bin/env node
/**
 * Page-only audio (decision D4): the Darkness and Appendix N soundtrack renders are all rights reserved,
 * streamed on the landing page only, and NOT in this repository. The Pages workflow copies them into the
 * deploy artifact at deploy time with this script.
 *
 * Usage:
 *   node site/tools/stage-page-audio.mjs <source audio dir>   copy every page-only file into site/audio/
 *   node site/tools/stage-page-audio.mjs --check              verify site/audio/ already holds them
 *
 * <source audio dir> is a folder laid out like site/audio/ (darkness/, appendix-n/, ab/, examples/).
 * The file list, sha256 and byte counts come from site/SOURCES.md (rows under site/audio/ whose licence
 * is "all rights reserved"). Any missing file or hash mismatch exits 1.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Rows of site/SOURCES.md for page-only audio: { rel, sha256, bytes } with rel relative to site/audio/. */
export function pageOnlyAudio(sourcesText) {
  const rows = [];
  for (const line of sourcesText.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim().replace(/^`|`$/g, ''));
    if (cells.length < 7) continue;
    const [sitePath, , , , sha256, bytes, licence] = cells;
    if (!sitePath.startsWith('site/audio/')) continue;
    if (!/^all rights reserved/i.test(licence)) continue;
    rows.push({ rel: sitePath.slice('site/audio/'.length), sha256, bytes: Number(bytes) });
  }
  return rows;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function main(argv) {
  const check = argv[0] === '--check';
  const source = check ? null : argv[0];
  if (!check && !source) {
    console.error('usage: node site/tools/stage-page-audio.mjs <source audio dir> | --check');
    process.exit(2);
  }
  const rows = pageOnlyAudio(fs.readFileSync(path.join(SITE, 'SOURCES.md'), 'utf8'));
  if (rows.length === 0) {
    console.error('stage-page-audio: site/SOURCES.md lists no page-only audio');
    process.exit(1);
  }
  const problems = [];
  for (const row of rows) {
    const from = check ? path.join(SITE, 'audio', row.rel) : path.resolve(source, row.rel);
    if (!fs.existsSync(from)) {
      problems.push(`missing ${from}`);
      continue;
    }
    const buf = fs.readFileSync(from);
    if (buf.length !== row.bytes || sha256(buf) !== row.sha256) {
      problems.push(`sha256/bytes differ from site/SOURCES.md: ${from}`);
      continue;
    }
    if (!check) {
      const to = path.join(SITE, 'audio', row.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, buf);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`stage-page-audio: ${p}`);
    process.exit(1);
  }
  console.log(`stage-page-audio: ${rows.length} page-only audio files ${check ? 'present' : 'staged'} (sha256 match site/SOURCES.md)`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2));
