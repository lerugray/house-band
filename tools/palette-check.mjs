#!/usr/bin/env node
/**
 * Timbre-Variety Law check: flag a score whose palette (kit + patch names) is
 * identical to a sibling score's in the same repo.
 *
 *   node tools/palette-check.mjs <score.json | dir> [more...] [--against <dir>] [--min-diff N] [--json]
 *
 * With one score file and --against (or its own directory), that score is the
 * candidate and the others are its siblings. With several files or a directory,
 * every score is checked against every other. Exit 0: clean (warnings allowed);
 * exit 1: an identical (or too-close) palette; exit 2: usage.
 */
import { dirname, resolve } from 'node:path';
import { statSync } from 'node:fs';

import { checkPalette, describePalette } from '../src/palette.mjs';
import { loadScores } from '../src/palette-node.mjs';

function parse(argv) {
  const args = { paths: [], against: null, minDiff: 1, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--against') args.against = argv[++i];
    else if (argv[i] === '--min-diff') args.minDiff = Number(argv[++i]);
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`);
    else args.paths.push(argv[i]);
  }
  if (args.paths.length === 0 || !Number.isInteger(args.minDiff) || args.minDiff < 1) throw new Error('usage: palette-check <score.json|dir> [more] [--against <dir>] [--min-diff N] [--json]');
  return args;
}

let args;
try { args = parse(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }

const candidates = loadScores(args.paths);
const singleFile = args.paths.length === 1 && !statSync(resolve(args.paths[0])).isDirectory();
const siblingDirs = args.against ? [args.against] : singleFile ? [dirname(resolve(args.paths[0]))] : args.paths;
const pool = loadScores(siblingDirs);
const findings = [];
const rows = [];
for (const candidate of candidates) {
  const siblings = pool.filter((s) => s.file !== candidate.file).map((s) => [s.name, s.palette]);
  const mine = checkPalette(candidate.name, candidate.palette, siblings, { minDiff: args.minDiff });
  rows.push({ score: candidate.name, palette: describePalette(candidate.palette), findings: mine });
  findings.push(...mine);
}
// Report each identical pair once.
const seen = new Set();
const reported = findings.filter((f) => {
  if (f.code !== 'palette-identical') return true;
  const key = [f.message.split(':')[0], f.sibling].sort().join('<>');
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

if (args.json) {
  console.log(JSON.stringify({ scores: rows, findings: reported }, null, 2));
} else {
  for (const row of rows) console.log(`${row.score}: ${row.palette}`);
  for (const f of reported) console.log(`${f.level.toUpperCase()} ${f.message}`);
  if (reported.length === 0) console.log('palette-check: clean');
}
process.exit(reported.some((f) => f.level === 'error') ? 1 : 0);
