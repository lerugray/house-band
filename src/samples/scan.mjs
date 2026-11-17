/**
 * samples scan pure logic (OSS-11): map WAV file lists to kit/patch roles and a report.
 */
import { DRUM_LANES } from '../kit/band.js';
import { parseRootNoteFromFilename } from '../../tools/pitch.mjs';
import { PERC_VARIANTS } from './config.mjs';

const DRUM_MAX_SECONDS = 2.0;
const UNSUPPORTED_HINT = 'ffmpeg -i in.aif -c:a pcm_s16le out.wav';

const PERC_ALIASES = Object.freeze({
  cb: 'cowbell',
  shk: 'shaker',
});

const PERC_VARIANT_SET = new Set(PERC_VARIANTS);

/**
 * Lower-case text, split on non-alphanumeric and letter/digit boundaries.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const lower = String(text).toLowerCase();
  const parts = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = [];
  for (const part of parts) {
    const pieces = part.match(/[a-z]+|[0-9]+/g);
    if (pieces) tokens.push(...pieces);
  }
  return tokens;
}

/**
 * Slug for ids / patch names: leading letter, then [a-z0-9-], max 48 chars.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  let s = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  if (!s) s = 'samples';
  if (!/^[a-z]/.test(s)) s = `s-${s}`;
  return s.slice(0, 48);
}

function hasToken(tokens, name) {
  return tokens.includes(name);
}

function hasAny(tokens, names) {
  return names.some((n) => tokens.includes(n));
}

/**
 * First matching drum rule wins. Returns { group, role, token } where group buckets
 * kick/snare for .a/.b assignment; role is the primary role id (kick.a, hat.open, ...).
 * @param {string[]} tokens
 * @returns {{ group: string, role: string, token: string } | null}
 */
export function matchDrumTokens(tokens) {
  if (!tokens.length) return null;
  const set = tokens;

  // hat.open
  if (hasAny(set, ['ohh', 'oh', 'openhat']) || (hasToken(set, 'open') && hasAny(set, ['hat', 'hh', 'hihat']))) {
    const token = hasToken(set, 'ohh')
      ? 'ohh'
      : hasToken(set, 'oh')
        ? 'oh'
        : hasToken(set, 'openhat')
          ? 'openhat'
          : 'open';
    return { group: 'hat.open', role: 'hat.open', token };
  }

  // hat.closed
  if (hasAny(set, ['chh', 'ch', 'closedhat', 'hh', 'hihat', 'hat'])) {
    const token = ['chh', 'ch', 'closedhat', 'hh', 'hihat', 'hat'].find((t) => hasToken(set, t));
    return { group: 'hat.closed', role: 'hat.closed', token };
  }

  // kick
  if (hasAny(set, ['kick', 'kik', 'kck', 'bd', 'bassdrum'])) {
    const token = ['kick', 'kik', 'kck', 'bd', 'bassdrum'].find((t) => hasToken(set, t));
    return { group: 'kick', role: 'kick.a', token };
  }

  // snare
  if (hasAny(set, ['snare', 'snr', 'sd', 'sn'])) {
    const token = ['snare', 'snr', 'sd', 'sn'].find((t) => hasToken(set, t));
    return { group: 'snare', role: 'snare.a', token };
  }

  // clap
  if (hasAny(set, ['clap', 'clp', 'cp', 'handclap'])) {
    const token = ['clap', 'clp', 'cp', 'handclap'].find((t) => hasToken(set, t));
    return { group: 'clap.default', role: 'clap.default', token };
  }

  // rim
  if (hasAny(set, ['rim', 'rimshot', 'rs', 'sidestick', 'stick'])) {
    const token = ['rim', 'rimshot', 'rs', 'sidestick', 'stick'].find((t) => hasToken(set, t));
    return { group: 'rim.default', role: 'rim.default', token };
  }

  // toms
  if (hasAny(set, ['lt', 'ft', 'floortom', 'lowtom']) || (hasToken(set, 'tom') && hasAny(set, ['low', 'lo', 'l', '1']))) {
    const token = ['lt', 'ft', 'floortom', 'lowtom', 'tom'].find((t) => hasToken(set, t));
    return { group: 'tomLow.default', role: 'tomLow.default', token };
  }
  if (hasAny(set, ['mt', 'midtom']) || (hasToken(set, 'tom') && hasAny(set, ['mid', 'm', '2']))) {
    const token = ['mt', 'midtom', 'tom'].find((t) => hasToken(set, t));
    return { group: 'tomMid.default', role: 'tomMid.default', token };
  }
  if (hasAny(set, ['ht', 'hightom']) || (hasToken(set, 'tom') && hasAny(set, ['high', 'hi', 'h', '3']))) {
    const token = ['ht', 'hightom', 'tom'].find((t) => hasToken(set, t));
    return { group: 'tomHigh.default', role: 'tomHigh.default', token };
  }

  // ride
  if (hasAny(set, ['ride', 'rd'])) {
    const token = hasToken(set, 'ride') ? 'ride' : 'rd';
    return { group: 'ride.default', role: 'ride.default', token };
  }

  // crash
  if (hasAny(set, ['crash', 'cr', 'cym', 'cymbal'])) {
    const token = ['crash', 'cr', 'cym', 'cymbal'].find((t) => hasToken(set, t));
    return { group: 'crash.default', role: 'crash.default', token };
  }

  // perc: two-token hyphen joins first, then singles / aliases
  for (let i = 0; i < set.length - 1; i++) {
    const joined = `${set[i]}-${set[i + 1]}`;
    if (PERC_VARIANT_SET.has(joined)) {
      return { group: `perc.${joined}`, role: `perc.${joined}`, token: joined };
    }
  }
  for (const tok of set) {
    if (PERC_VARIANT_SET.has(tok)) {
      return { group: `perc.${tok}`, role: `perc.${tok}`, token: tok };
    }
    const alias = PERC_ALIASES[tok];
    if (alias && PERC_VARIANT_SET.has(alias)) {
      return { group: `perc.${alias}`, role: `perc.${alias}`, token: tok };
    }
  }

  return null;
}

function pathParts(relativePath) {
  const norm = String(relativePath).replace(/\\/g, '/');
  const segments = norm.split('/');
  const base = segments[segments.length - 1] || '';
  const dir = segments.slice(0, -1).join('/');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return { norm, base, dir, stem };
}

function compareCandidates(a, b) {
  const lenA = a.file.length;
  const lenB = b.file.length;
  if (lenA !== lenB) return lenA - lenB;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

function guessPatchClass(folderTokens) {
  if (hasToken(folderTokens, 'bass')) return 'bass';
  if (hasAny(folderTokens, ['pad', 'strings', 'choir'])) return 'pad';
  if (hasAny(folderTokens, ['lead', 'synth'])) return 'lead';
  if (hasAny(folderTokens, ['bell', 'mallet', 'glock', 'vibes'])) return 'bell';
  return 'pluck';
}

function roleToKitPath(role) {
  const dot = role.indexOf('.');
  if (dot < 0) return { lane: role, variant: 'default' };
  return { lane: role.slice(0, dot), variant: role.slice(dot + 1) };
}

/**
 * Scan a list of WAV descriptors and optional unsupported paths.
 *
 * @param {Array<{ file: string, durationSec: number, midiUnityNote?: number|null }>} files
 * @param {{ unsupported?: string[], id: string, displayName?: string, sourcePath: string, fallbackKit?: string, licence?: string }} options
 * @returns {{ config: object, report: object, lines: string[] }}
 */
export function scanSamples(files, options) {
  const unsupported = [...(options.unsupported || [])].map((f) => f.replace(/\\/g, '/')).sort();
  const fallbackKit = options.fallbackKit || 'tr808';
  const id = options.id;
  const displayName = options.displayName || id;
  const sourcePath = options.sourcePath;
  const licence = options.licence || 'user-supplied; not for redistribution';

  /** @type {Map<string, Array<{ file: string, token: string, durationSec: number }>>} */
  const buckets = new Map();
  /** @type {Map<string, Array<{ file: string, rootNote: number }>>} */
  const pitchedByFolder = new Map();
  /** @type {Set<string>} */
  const claimed = new Set();
  /** @type {string[]} */
  const unused = [];

  const sortedFiles = [...files].sort((a, b) => {
    const fa = a.file.replace(/\\/g, '/');
    const fb = b.file.replace(/\\/g, '/');
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });

  for (const entry of sortedFiles) {
    const file = entry.file.replace(/\\/g, '/');
    const durationSec = entry.durationSec;
    const { dir, stem } = pathParts(file);
    const fileTokens = tokenize(stem);
    const folderTokens = tokenize(dir);

    let drum = matchDrumTokens(fileTokens);
    if (!drum) drum = matchDrumTokens(folderTokens);

    if (drum && durationSec <= DRUM_MAX_SECONDS) {
      const list = buckets.get(drum.group) || [];
      list.push({ file, token: drum.token, durationSec });
      buckets.set(drum.group, list);
      continue;
    }

    const fromName = parseRootNoteFromFilename(file);
    const midi =
      typeof entry.midiUnityNote === 'number' && Number.isInteger(entry.midiUnityNote)
        ? entry.midiUnityNote
        : fromName
          ? fromName.midi
          : null;

    if (midi !== null && midi >= 0 && midi <= 127) {
      const folderKey = dir || '.';
      const list = pitchedByFolder.get(folderKey) || [];
      list.push({ file, rootNote: midi });
      pitchedByFolder.set(folderKey, list);
      continue;
    }

    unused.push(file);
  }

  /** @type {Array<{ role: string, file: string, reason: string }>} */
  const mapped = [];
  /** @type {Array<{ role: string, picked: string, others: string[] }>} */
  const ambiguous = [];

  const assignSingle = (group, role) => {
    const list = (buckets.get(group) || []).slice().sort(compareCandidates);
    if (list.length === 0) return;
    const winner = list[0];
    mapped.push({ role, file: winner.file, reason: `token "${winner.token}"` });
    claimed.add(winner.file);
    if (list.length > 1) {
      ambiguous.push({
        role,
        picked: winner.file,
        others: list.slice(1).map((c) => c.file),
      });
      for (const c of list.slice(1)) claimed.add(c.file);
    }
  };

  const assignKickOrSnare = (group, roleA, roleB) => {
    const list = (buckets.get(group) || []).slice().sort(compareCandidates);
    if (list.length === 0) return;
    mapped.push({ role: roleA, file: list[0].file, reason: `token "${list[0].token}"` });
    claimed.add(list[0].file);
    if (list.length >= 2) {
      mapped.push({ role: roleB, file: list[1].file, reason: `token "${list[1].token}"` });
      claimed.add(list[1].file);
    }
    if (list.length > 2) {
      ambiguous.push({
        role: roleA,
        picked: list[0].file,
        others: list.slice(1).map((c) => c.file),
      });
      for (const c of list.slice(2)) claimed.add(c.file);
    }
  };

  // Assignment order follows drum rule order (stable report).
  assignSingle('hat.open', 'hat.open');
  assignSingle('hat.closed', 'hat.closed');
  assignKickOrSnare('kick', 'kick.a', 'kick.b');
  assignKickOrSnare('snare', 'snare.a', 'snare.b');
  assignSingle('clap.default', 'clap.default');
  assignSingle('rim.default', 'rim.default');
  assignSingle('tomLow.default', 'tomLow.default');
  assignSingle('tomMid.default', 'tomMid.default');
  assignSingle('tomHigh.default', 'tomHigh.default');
  assignSingle('ride.default', 'ride.default');
  assignSingle('crash.default', 'crash.default');

  const percGroups = [...buckets.keys()].filter((g) => g.startsWith('perc.')).sort();
  for (const group of percGroups) {
    assignSingle(group, group);
  }

  // Pitched patches: folders with 2+ pitched files.
  /** @type {Record<string, { class: string, zones: 'auto', files: string[] }>} */
  const patches = {};
  const folderKeys = [...pitchedByFolder.keys()].sort();
  for (const folderKey of folderKeys) {
    const list = pitchedByFolder.get(folderKey).slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    if (list.length < 2) {
      for (const item of list) unused.push(item.file);
      continue;
    }
    const folderSlug = slugify(folderKey === '.' ? 'root' : folderKey.split('/').pop());
    const folderTokens = tokenize(folderKey === '.' ? '' : folderKey.split('/').pop());
    const patchClass = guessPatchClass(folderTokens);
    const patchFiles = list.map((item) => item.file);
    patches[folderSlug] = { class: patchClass, zones: 'auto', files: patchFiles };
    for (const item of list) {
      mapped.push({
        role: `patch.${folderSlug}`,
        file: item.file,
        reason: 'pitched',
      });
      claimed.add(item.file);
    }
  }

  // Build kit object from mapped drum roles.
  /** @type {Record<string, Record<string, string>>} */
  const kit = {};
  for (const row of mapped) {
    if (row.role.startsWith('patch.')) continue;
    const { lane, variant } = roleToKitPath(row.role);
    if (!kit[lane]) kit[lane] = {};
    kit[lane][variant] = row.file;
  }

  const mappedLanes = new Set(Object.keys(kit));
  const unmapped = DRUM_LANES.filter((lane) => !mappedLanes.has(lane));

  unused.sort();
  // Files that were in ambiguous losers are claimed; ensure unused has no claimed files.
  const unusedFinal = unused.filter((f) => !claimed.has(f)).sort();

  const report = {
    mapped: mapped.map((m) => ({ role: m.role, file: m.file, reason: m.reason })),
    unmapped: [...unmapped],
    ambiguous: ambiguous.map((a) => ({ role: a.role, picked: a.picked, others: [...a.others] })),
    unused: unusedFinal,
    unsupported: [...unsupported],
  };

  const config = {
    format: 'house-band-samples',
    version: 1,
    id,
    displayName,
    source: { type: 'folder', path: sourcePath },
    licence,
    fallbackKit,
  };
  if (Object.keys(kit).length > 0) config.kit = kit;
  if (Object.keys(patches).length > 0) config.patches = patches;

  const lines = [];
  for (const m of mapped) {
    if (m.role.startsWith('patch.')) {
      lines.push(`MAPPED ${m.role} <- ${m.file} (${m.reason})`);
    } else {
      lines.push(`MAPPED ${m.role} <- ${m.file} (${m.reason})`);
    }
  }
  for (const lane of unmapped) {
    lines.push(`UNMAPPED ${lane} (falls back to ${fallbackKit})`);
  }
  for (const a of ambiguous) {
    lines.push(`AMBIGUOUS ${a.role}: ${a.others.length + 1} candidates, picked ${a.picked}`);
  }
  lines.push(`UNUSED ${unusedFinal.length} files`);
  lines.push(`UNSUPPORTED ${unsupported.length} files`);
  if (unsupported.length > 0) {
    lines.push(`HINT ${UNSUPPORTED_HINT}`);
  }

  return { config, report, lines };
}

export { UNSUPPORTED_HINT, DRUM_MAX_SECONDS };
