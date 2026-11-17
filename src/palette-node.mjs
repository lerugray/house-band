import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { checkPalette, scorePalette } from './palette.mjs';

/** Parsed House Band scores from a mix of files and directories (non-recursive). */
export function loadScores(paths) {
  const scores = [];
  for (const raw of paths) {
    const path = resolve(raw);
    const files = statSync(path).isDirectory()
      ? readdirSync(path).filter((f) => extname(f) === '.json' && !f.endsWith('.manifest.json')).sort().map((f) => join(path, f))
      : [path];
    for (const file of files) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
      const palette = scorePalette(parsed);
      if (palette) scores.push({ file, name: basename(file), palette, mtimeMs: statSync(file).mtimeMs });
    }
  }
  return scores;
}

/** Compose-time check of one score against the other scores in its directory. */
export function siblingFindings(specPath, { minDiff = 1 } = {}) {
  const self = resolve(specPath);
  const own = loadScores([self])[0];
  if (!own) return [];
  const siblings = loadScores([dirname(self)]).filter((s) => s.file !== self);
  return checkPalette(own.name, own.palette, siblings.map((s) => [s.name, s.palette]), { minDiff })
    .filter((f) => f.level !== 'info');
}
