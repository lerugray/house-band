/**
 * SFZ v1 subset importer (OSS-14).
 * Headers: control, global, master, group, region.
 * Opcodes: sample, key, lokey, hikey, pitch_keycenter, lovel, hivel; plus control default_path.
 */

import { noteToMidi } from '../kit/band.js';

const SUPPORTED_HEADERS = new Set(['control', 'global', 'master', 'group', 'region']);
const SUPPORTED_OPCODES = new Set([
  'sample',
  'key',
  'lokey',
  'hikey',
  'pitch_keycenter',
  'lovel',
  'hivel',
  'default_path',
]);

const HEADER_OR_OPCODE_RE = /<(control|global|master|group|region)>|([a-zA-Z_][a-zA-Z0-9_]*)=/gi;

/**
 * Strip line comments (double slash) and block comments.
 * @param {string} text
 * @returns {string}
 */
export function stripSfzComments(text) {
  const withoutBlocks = String(text).replace(/\/\*[\s\S]*?\*\//g, ' ');
  return withoutBlocks.replace(/\/\/[^\n\r]*/g, '');
}

/**
 * Parse a MIDI key number or note name (c4, f#3, eb2; C4 = 60).
 * @param {string|number} value
 * @returns {number|null}
 */
export function parseSfzKey(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 127 ? value : null;
  }
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n >= 0 && n <= 127 ? n : null;
  }
  const m = /^([a-g])([#b]?)(-?\d+)$/i.exec(trimmed);
  if (!m) return null;
  return noteToMidi(`${m[1].toUpperCase()}${m[2] || ''}${m[3]}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Apply SFZ `key` and note-name coercion; fill defaults.
 * @param {Record<string, string>} opcodes
 * @returns {{ sample: string|undefined, lokey: number, hikey: number, pitch_keycenter: number, lovel: number, hivel: number }}
 */
function normaliseRegionOpcodes(opcodes) {
  const out = { ...opcodes };
  if (Object.hasOwn(out, 'key')) {
    const k = parseSfzKey(out.key);
    if (k !== null) {
      out.lokey = String(k);
      out.hikey = String(k);
      out.pitch_keycenter = String(k);
    }
    delete out.key;
  }

  const lokey = Object.hasOwn(out, 'lokey') ? parseSfzKey(out.lokey) : 0;
  const hikey = Object.hasOwn(out, 'hikey') ? parseSfzKey(out.hikey) : 127;
  const pitch = Object.hasOwn(out, 'pitch_keycenter') ? parseSfzKey(out.pitch_keycenter) : 60;
  const lovel = Object.hasOwn(out, 'lovel') ? parseSfzKey(out.lovel) : 0;
  const hivel = Object.hasOwn(out, 'hivel') ? parseSfzKey(out.hivel) : 127;

  return {
    sample: typeof out.sample === 'string' ? out.sample : undefined,
    lokey: lokey === null ? 0 : lokey,
    hikey: hikey === null ? 127 : hikey,
    pitch_keycenter: pitch === null ? 60 : pitch,
    lovel: lovel === null ? 0 : lovel,
    hivel: hivel === null ? 127 : hivel,
  };
}

function joinDefaultPath(defaultPath, sample) {
  const sampleNorm = String(sample).replace(/\\/g, '/');
  if (!defaultPath) return sampleNorm;
  const prefix = String(defaultPath).replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(sampleNorm) || sampleNorm.startsWith('/')) return sampleNorm;
  return `${prefix}${sampleNorm}`.replace(/\\/g, '/');
}

/**
 * Parse SFZ text into regions with inheritance applied.
 * @param {string} text
 * @returns {{ defaultPath: string, regions: object[], ignoredOpcodes: string[] }}
 */
export function parseSfz(text) {
  const body = stripSfzComments(text);
  const ignored = new Set();
  let defaultPath = '';
  /** @type {Record<string, string>} */
  let globalOps = {};
  /** @type {Record<string, string>} */
  let masterOps = {};
  /** @type {Record<string, string>} */
  let groupOps = {};
  /** @type {Record<string, string>|null} */
  let sectionOps = null;
  /** @type {'control'|'global'|'master'|'group'|'region'|null} */
  let section = null;
  /** @type {object[]} */
  const regions = [];

  function commitRegion() {
    if (section !== 'region' || !sectionOps) return;
    const merged = { ...globalOps, ...masterOps, ...groupOps, ...sectionOps };
    const normalised = normaliseRegionOpcodes(merged);
    if (normalised.sample !== undefined) {
      normalised.sample = joinDefaultPath(defaultPath, normalised.sample);
    }
    regions.push(normalised);
    sectionOps = null;
  }

  HEADER_OR_OPCODE_RE.lastIndex = 0;
  let match;
  const matches = [];
  while ((match = HEADER_OR_OPCODE_RE.exec(body)) !== null) {
    matches.push({
      index: match.index,
      end: match.index + match[0].length,
      header: match[1] ? match[1].toLowerCase() : null,
      opcode: match[2] || null,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const tok = matches[i];
    if (tok.header) {
      if (!SUPPORTED_HEADERS.has(tok.header)) continue;
      commitRegion();
      section = tok.header;
      if (section === 'control') {
        sectionOps = {};
      } else if (section === 'global') {
        globalOps = {};
        masterOps = {};
        groupOps = {};
        sectionOps = globalOps;
      } else if (section === 'master') {
        masterOps = {};
        groupOps = {};
        sectionOps = masterOps;
      } else if (section === 'group') {
        groupOps = {};
        sectionOps = groupOps;
      } else if (section === 'region') {
        sectionOps = {};
      }
      continue;
    }

    const name = tok.opcode.toLowerCase();
    const valueStart = tok.end;
    const valueEnd = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const value = body.slice(valueStart, valueEnd).trim();

    if (!SUPPORTED_OPCODES.has(name)) {
      ignored.add(name);
      continue;
    }

    if (section === 'control' && name === 'default_path') {
      defaultPath = value;
      continue;
    }

    if (name === 'default_path') {
      // Only <control> default_path is used for sample prefixing.
      continue;
    }

    if (!sectionOps) continue;
    sectionOps[name] = value;
  }

  commitRegion();

  return {
    defaultPath: defaultPath.replace(/\\/g, '/'),
    regions,
    ignoredOpcodes: [...ignored].sort(),
  };
}

function keyRangesOverlap(a, b) {
  return a.lokey <= b.hikey && b.lokey <= a.hikey;
}

/**
 * Keep only .wav regions; among overlapping key ranges keep highest hivel.
 * @param {object[]} regions
 * @returns {{ zones: { file: string, rootNote: number, lo: number, hi: number }[], unsupported: string[] }}
 */
export function regionsToZones(regions) {
  const unsupported = [];
  const wavRegions = [];
  for (const region of regions) {
    if (!region.sample) continue;
    if (!/\.wav$/i.test(region.sample)) {
      unsupported.push(region.sample);
      continue;
    }
    wavRegions.push(region);
  }

  const kept = wavRegions.filter((region) => {
    return !wavRegions.some(
      (other) => other !== region && keyRangesOverlap(region, other) && other.hivel > region.hivel,
    );
  });

  const zones = kept.map((region) => ({
    file: region.sample.replace(/\\/g, '/'),
    rootNote: region.pitch_keycenter,
    lo: region.lokey,
    hi: region.hikey,
  }));

  return { zones, unsupported: [...new Set(unsupported)] };
}

/**
 * Build a house-band.samples.json object from SFZ text.
 * @param {{ text: string, patchClass: string, id: string, displayName?: string, sourcePath: string }} opts
 */
export function sfzToSamplesConfig(opts) {
  if (!isPlainObject(opts)) throw new TypeError('opts must be an object');
  const { text, patchClass, id, sourcePath } = opts;
  const displayName = opts.displayName || id;
  const parsed = parseSfz(text);
  const { zones, unsupported } = regionsToZones(parsed.regions);
  const config = {
    format: 'house-band-samples',
    version: 1,
    id,
    displayName,
    source: { type: 'sfz', path: sourcePath },
    licence: 'user-supplied; not for redistribution',
    fallbackKit: 'tr808',
    patches: {
      [id]: {
        class: patchClass,
        zones,
      },
    },
  };
  return {
    config,
    ignoredOpcodes: parsed.ignoredOpcodes,
    unsupported,
  };
}

/**
 * Slug for --id default: SFZ file basename.
 * @param {string} name
 * @returns {string}
 */
export function slugifySfzName(name) {
  let s = String(name)
    .toLowerCase()
    .replace(/\.sfz$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s) s = 'sfz';
  if (!/^[a-z]/.test(s)) s = `s-${s}`;
  if (s.length > 48) s = s.slice(0, 48).replace(/-+$/g, '');
  return s;
}
