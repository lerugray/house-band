/**
 * Source-song format helpers (OSS-17).
 * Schema docs: docs/schemas/source-song.schema.json
 */

export const SOURCE_SONG_FORMAT = 'house-band-source-song';
export const SOURCE_SONG_VERSION = 1;

const TOP_KEYS = Object.freeze([
  'format',
  'version',
  'title',
  'tempo',
  'tempoMap',
  'timeSignature',
  'lengthBeats',
  'tracks',
  'sequence',
  'provenance',
]);
const TOP_KEY_SET = new Set(TOP_KEYS);
const TRACK_KEYS = Object.freeze([
  'id',
  'name',
  'instrumentName',
  'kind',
  'roleGuess',
  'notes',
]);
const TRACK_KEY_SET = new Set(TRACK_KEYS);
const NOTE_KEYS = Object.freeze(['beat', 'lengthBeats', 'midi', 'velocity', 'offsetMs']);
const NOTE_KEY_SET = new Set(NOTE_KEYS);
const TEMPO_ENTRY_KEYS = Object.freeze(['beat', 'bpm']);
const TEMPO_ENTRY_KEY_SET = new Set(TEMPO_ENTRY_KEYS);
const PROVENANCE_KEYS = Object.freeze(['file', 'sha256', 'importer', 'importerVersion']);
const PROVENANCE_KEY_SET = new Set(PROVENANCE_KEYS);
const KINDS = new Set(['pitched', 'drums']);
const ROLES = new Set(['melody', 'bass', 'chords', 'drums', 'other']);
const SHA256_RE = /^[a-f0-9]{64}$/;

export class SourceSongError extends Error {
  /**
   * @param {string} path JSON-ish path of the bad field
   * @param {string} message Plain-English reason
   */
  constructor(path, message) {
    super(message);
    this.name = 'SourceSongError';
    this.path = path;
  }
}

function fail(path, message) {
  throw new SourceSongError(path, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertNumber(value, path, { min = null, exclusiveMin = null, max = null } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'expected a finite number');
  }
  if (min != null && value < min) fail(path, `expected >= ${min}`);
  if (exclusiveMin != null && value <= exclusiveMin) fail(path, `expected > ${exclusiveMin}`);
  if (max != null && value > max) fail(path, `expected <= ${max}`);
}

function assertInteger(value, path, { min = null, max = null } = {}) {
  if (!Number.isInteger(value)) fail(path, 'expected an integer');
  if (min != null && value < min) fail(path, `expected >= ${min}`);
  if (max != null && value > max) fail(path, `expected <= ${max}`);
}

function assertNoExtraKeys(obj, allowed, path) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(path ? `${path}.${key}` : key, 'unknown key');
  }
}

/**
 * Median of MIDI pitches. Even count: average of the two middle values.
 * @param {{ midi: number }[]} notes
 * @returns {number|null}
 */
export function medianPitch(notes) {
  if (!notes || notes.length === 0) return null;
  const pitches = notes.map((n) => n.midi).sort((a, b) => a - b);
  const mid = Math.floor(pitches.length / 2);
  if (pitches.length % 2 === 1) return pitches[mid];
  return (pitches[mid - 1] + pitches[mid]) / 2;
}

/**
 * Mean number of notes sounding, sampled at every note start.
 * @param {{ beat: number, lengthBeats: number }[]} notes
 * @returns {number}
 */
export function meanPolyphony(notes) {
  if (!notes || notes.length === 0) return 0;
  const sorted = [...notes].sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  let sum = 0;
  for (const note of sorted) {
    const t = note.beat;
    let sounding = 0;
    for (const other of sorted) {
      if (other.beat <= t && other.beat + other.lengthBeats > t) sounding += 1;
    }
    sum += sounding;
  }
  return sum / sorted.length;
}

/**
 * Local role before melody pick: drums | chords | bass | null (candidate for melody/other).
 * @param {{ kind: string, notes: object[] }} track
 * @returns {'drums'|'chords'|'bass'|null}
 */
export function localRole(track) {
  if (track.kind === 'drums') return 'drums';
  const poly = meanPolyphony(track.notes || []);
  if (poly >= 2.5) return 'chords';
  const median = medianPitch(track.notes || []);
  if (median != null && median < 48) return 'bass';
  return null;
}

/**
 * Assign roleGuess on every track of a song (mutates). Melody is the remaining
 * track with the highest median pitch; ties go to the earliest track.
 * @param {object[]} tracks
 * @returns {object[]}
 */
export function roleGuess(tracks) {
  if (!Array.isArray(tracks)) {
    fail('tracks', 'roleGuess expects an array of tracks');
  }
  const locals = tracks.map((t) => localRole(t));
  let melodyIndex = -1;
  let melodyMedian = -Infinity;
  for (let i = 0; i < tracks.length; i++) {
    if (locals[i] != null) continue;
    const median = medianPitch(tracks[i].notes || []);
    const value = median == null ? -Infinity : median;
    if (value > melodyMedian) {
      melodyMedian = value;
      melodyIndex = i;
    }
  }
  for (let i = 0; i < tracks.length; i++) {
    if (locals[i] != null) {
      tracks[i].roleGuess = locals[i];
    } else if (i === melodyIndex) {
      tracks[i].roleGuess = 'melody';
    } else {
      tracks[i].roleGuess = 'other';
    }
  }
  return tracks;
}

/**
 * Sort notes by beat, then midi (mutates array).
 * @param {object[]} notes
 */
export function sortNotes(notes) {
  notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  return notes;
}

/**
 * Beats per bar from [numerator, denominator] (quarter-note beats).
 * @param {[number, number]} timeSignature
 */
export function beatsPerBar(timeSignature) {
  const [num, den] = timeSignature;
  return num * (4 / den);
}

/**
 * Validate a source-song object. Returns a deeply frozen copy.
 * @param {object} obj
 */
export function validateSourceSong(obj) {
  if (!isPlainObject(obj)) fail('', 'expected a plain object');
  assertNoExtraKeys(obj, TOP_KEY_SET, '');

  if (obj.format !== SOURCE_SONG_FORMAT) fail('format', `expected "${SOURCE_SONG_FORMAT}"`);
  if (obj.version !== SOURCE_SONG_VERSION) fail('version', `expected ${SOURCE_SONG_VERSION}`);
  if (typeof obj.title !== 'string' || obj.title.length === 0) fail('title', 'expected a non-empty string');

  assertNumber(obj.tempo, 'tempo', { exclusiveMin: 0 });
  assertNumber(obj.lengthBeats, 'lengthBeats', { min: 0 });

  if (!Array.isArray(obj.timeSignature) || obj.timeSignature.length !== 2) {
    fail('timeSignature', 'expected [numerator, denominator]');
  }
  assertInteger(obj.timeSignature[0], 'timeSignature.0', { min: 1 });
  assertInteger(obj.timeSignature[1], 'timeSignature.1', { min: 1 });

  if (!Array.isArray(obj.tempoMap) || obj.tempoMap.length === 0) {
    fail('tempoMap', 'expected a non-empty array');
  }
  const tempoMap = [];
  for (let i = 0; i < obj.tempoMap.length; i++) {
    const entry = obj.tempoMap[i];
    const path = `tempoMap.${i}`;
    if (!isPlainObject(entry)) fail(path, 'expected a plain object');
    assertNoExtraKeys(entry, TEMPO_ENTRY_KEY_SET, path);
    assertNumber(entry.beat, `${path}.beat`, { min: 0 });
    assertNumber(entry.bpm, `${path}.bpm`, { exclusiveMin: 0 });
    tempoMap.push({ beat: entry.beat, bpm: entry.bpm });
  }
  if (tempoMap[0].beat !== 0) fail('tempoMap.0.beat', 'first tempo entry must be at beat 0');
  if (tempoMap[0].bpm !== obj.tempo) fail('tempo', 'tempo must equal tempoMap[0].bpm');

  if (obj.sequence !== null) {
    if (!Array.isArray(obj.sequence)) fail('sequence', 'expected an array of integers or null');
    for (let i = 0; i < obj.sequence.length; i++) {
      assertInteger(obj.sequence[i], `sequence.${i}`, { min: 0 });
    }
  }

  if (!isPlainObject(obj.provenance)) fail('provenance', 'expected a plain object');
  assertNoExtraKeys(obj.provenance, PROVENANCE_KEY_SET, 'provenance');
  const prov = obj.provenance;
  if (typeof prov.file !== 'string' || prov.file.length === 0) {
    fail('provenance.file', 'expected a non-empty basename');
  }
  if (prov.file.includes('/') || prov.file.includes('\\')) {
    fail('provenance.file', 'expected basename only');
  }
  if (typeof prov.sha256 !== 'string' || !SHA256_RE.test(prov.sha256)) {
    fail('provenance.sha256', 'expected a 64-char lowercase hex sha256');
  }
  if (typeof prov.importer !== 'string' || prov.importer.length === 0) {
    fail('provenance.importer', 'expected a non-empty string');
  }
  if (typeof prov.importerVersion !== 'string' || prov.importerVersion.length === 0) {
    fail('provenance.importerVersion', 'expected a non-empty string');
  }

  if (!Array.isArray(obj.tracks)) fail('tracks', 'expected an array');
  const tracks = [];
  for (let i = 0; i < obj.tracks.length; i++) {
    const t = obj.tracks[i];
    const path = `tracks.${i}`;
    if (!isPlainObject(t)) fail(path, 'expected a plain object');
    assertNoExtraKeys(t, TRACK_KEY_SET, path);
    if (typeof t.id !== 'string' || t.id.length === 0) fail(`${path}.id`, 'expected a non-empty string');
    if (typeof t.name !== 'string') fail(`${path}.name`, 'expected a string');
    if (typeof t.instrumentName !== 'string' || t.instrumentName.length === 0) {
      fail(`${path}.instrumentName`, 'expected a non-empty string');
    }
    if (!KINDS.has(t.kind)) fail(`${path}.kind`, 'expected pitched or drums');
    if (!ROLES.has(t.roleGuess)) fail(`${path}.roleGuess`, 'expected a known role');
    if (!Array.isArray(t.notes)) fail(`${path}.notes`, 'expected an array');
    const notes = [];
    for (let j = 0; j < t.notes.length; j++) {
      const n = t.notes[j];
      const np = `${path}.notes.${j}`;
      if (!isPlainObject(n)) fail(np, 'expected a plain object');
      assertNoExtraKeys(n, NOTE_KEY_SET, np);
      assertNumber(n.beat, `${np}.beat`, { min: 0 });
      assertNumber(n.lengthBeats, `${np}.lengthBeats`, { exclusiveMin: 0 });
      assertInteger(n.midi, `${np}.midi`, { min: 0, max: 127 });
      assertNumber(n.velocity, `${np}.velocity`, { min: 0, max: 1 });
      assertNumber(n.offsetMs, `${np}.offsetMs`);
      notes.push({
        beat: n.beat,
        lengthBeats: n.lengthBeats,
        midi: n.midi,
        velocity: n.velocity,
        offsetMs: n.offsetMs,
      });
    }
    for (let j = 1; j < notes.length; j++) {
      const prev = notes[j - 1];
      const cur = notes[j];
      if (cur.beat < prev.beat || (cur.beat === prev.beat && cur.midi < prev.midi)) {
        fail(`${path}.notes`, 'notes must be sorted by beat, then midi');
      }
    }
    tracks.push({
      id: t.id,
      name: t.name,
      instrumentName: t.instrumentName,
      kind: t.kind,
      roleGuess: t.roleGuess,
      notes,
    });
  }

  const out = {
    format: SOURCE_SONG_FORMAT,
    version: SOURCE_SONG_VERSION,
    title: obj.title,
    tempo: obj.tempo,
    tempoMap,
    timeSignature: [obj.timeSignature[0], obj.timeSignature[1]],
    lengthBeats: obj.lengthBeats,
    tracks,
    sequence: obj.sequence === null ? null : [...obj.sequence],
    provenance: {
      file: prov.file,
      sha256: prov.sha256,
      importer: prov.importer,
      importerVersion: prov.importerVersion,
    },
  };
  return deepFreeze(out);
}
