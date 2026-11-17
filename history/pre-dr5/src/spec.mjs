/**
 * PatternSpec validation and compilation.
 *
 * This is deliberately a strict, bounded JSON surface. A typo must not turn
 * into a plausible but incorrect render, and hostile artifacts must be
 * rejected before an audio graph is allocated.
 */

import {
  BITCRUSH_PRESETS,
  CHORUS_PRESETS,
  DELAY_PRESETS,
  DELAY_SYNC_FRACTIONS,
  FX_KINDS,
  FX_VOICE_SEND,
  FX_MAX_CHORUS_VOICES,
  FX_MAX_DELAY_SECONDS,
  FX_MAX_DRIVE,
  FX_MAX_FEEDBACK,
  FX_MAX_HISS,
  FX_MAX_SPRING_STAGES,
  RINGMOD_PRESETS,
  SNES_FIR_PRESETS,
  SNES_FIR_TAPS,
  SNES_MAX_EDL,
  SNESVERB_PRESETS,
  SPRING_PRESETS,
  TAPE_PRESETS,
  nearestMidi,
  noteFreq,
  noteToMidi,
  normalizeFx,
  REGISTER_CLASSES,
  RETIRE_MAX_HOLD,
  RETIRE_MODES,
  REVERB_PRESETS,
  SAMPLER_MAX_SEMITONES,
  selectSamplerZone,
  voiceTailSeconds,
  VOICE_ROLES,
} from './kit/band.js';
import { isCompatibleKitVersion, KIT_VERSION, LEGACY_SCHEMA_VERSION, SCHEMA_VERSION, SCORE_COMPATIBILITY } from './version.mjs';

export const VOICES = Object.freeze([
  'pad', 'drone', 'bell', 'pluck', 'bass', 'lead', 'air', 'kick', 'snare', 'hat',
  'chipPulse', 'chipTriangle', 'chipNoise',
]);

export const SPEC_LIMITS = Object.freeze({
  tracks: 64,
  stepsPerTrack: 8192,
  sections: 1024,
  trackLength: 4096,
  barsPerSection: 4096,
  renderSeconds: 3600,
  eventDuration: 120,
});

const LEGACY_TOP_FIELDS = new Set(['schemaVersion', 'kitVersion', 'seed', 'tempo', 'sampleRate', 'gain', 'label', 'register', 'tracks', 'sections']);
const TOP_FIELDS = new Set([...LEGACY_TOP_FIELDS, 'samplePack', 'sampleVoices', 'performance', 'fx', 'retire']);
const RETIRE_FIELDS = new Set(['mode', 'hold']);
const KIT_VERSION_FIELDS = new Set(['semver', 'sha']);
const REGISTER_FIELDS = new Set(['name', 'briefRef', 'class', 'salientEventsPerMinute', 'harmonicArchitecture', 'staticBedAuthorization']);
const STATIC_BED_AUTHORIZATION_FIELDS = new Set(['operator', 'date', 'briefRef']);
const TRACK_FIELDS = new Set(['bpm', 'len', 'vol', 'steps']);
const STEP_FIELDS = new Set(['i', 'every', 'voice', 'v', 'role', 'note', 'freq', 'dur', 'opts', 'o', 'nudge']);
const SECTION_FIELDS = new Set(['track', 'bars', 'fadeIn', 'harmonicClaim', 'execution']);
const SECTION_EXECUTION_FIELDS = new Set(['kind', 'every', 'id']);
const PERC = new Set(['kick', 'snare', 'hat']);
const AIR = new Set(['air']);
const SAMPLE_DRUMS = new Set(['kick', 'snare', 'hat']);
/**
 * Pitched voices a sampler binding may shadow (kit 1.7.0). Chip voices are
 * excluded on purpose: their whole identity is synthesised, and a sampled
 * chipPulse would be a lie about what the score is doing.
 */
export const SAMPLER_VOICES = Object.freeze(['pad', 'drone', 'bell', 'pluck', 'bass', 'lead']);
const SAMPLER_VOICE_SET = new Set(SAMPLER_VOICES);
const SUPPORTED_PACK_FORMATS = new Set(['1.0.0', '1.1.0']);
const SAMPLE_PACK_FIELDS = new Set(['packId', 'formatVersion', 'manifestSha256', 'contentSha256']);
const SAMPLE_VOICE_FIELDS = new Set(['kind', 'assetId', 'pcmSha256', 'gain']);
const SAMPLER_VOICE_FIELDS = new Set(['kind', 'zones', 'gain', 'release']);
const SAMPLER_ZONE_FIELDS = new Set(['lo', 'hi', 'rootNote', 'assetId', 'pcmSha256']);
const MAX_SAMPLE_BINDINGS = 10;
const MAX_SAMPLER_ZONES = 32;
const PERFORMANCE_FIELDS = new Set(['humanize', 'releaseTail', 'voices']);
const HUMANIZE_FIELDS = new Set(['timingMs', 'velocity', 'swing']);
const VOICE_PERFORMANCE_FIELDS = new Set(['humanize', 'releaseTail']);
const RELEASE_VOICES = new Set(['pad', 'drone']);
const HEX_256 = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;

const CHIP_FX_FIELDS = Object.freeze({
  arp: new Set(['type', 'intervals']),
  porta: new Set(['type', 'target', 'rate', 'tick']),
  slideUp: new Set(['type', 'rate', 'tick']),
  slideDown: new Set(['type', 'rate', 'tick']),
  vibrato: new Set(['type', 'rate', 'depth', 'delay', 'tick']),
  cut: new Set(['type', 'tick']),
  retrig: new Set(['type', 'tick', 'every']),
  duty: new Set(['type', 'tick', 'value']),
  dutySweep: new Set(['type', 'end']),
  volSlide: new Set(['type', 'rate', 'tick']),
  tremolo: new Set(['type', 'rate', 'depth', 'delay', 'tick']),
});

// -- FX suite (kit 1.8.0) ----------------------------------------------------
// A strict mirror of the kit's fx surface. The kit normaliser is the single
// source of resolution; this layer exists so a typo in a persisted score is a
// validation error rather than a silently-ignored field.
const FX_FIELDS = new Set(['bpm', ...FX_KINDS, 'master']);
const FX_MASTER_FIELDS = new Set([...FX_KINDS, 'dry']);
const FX_EFFECT_FIELDS = Object.freeze({
  reverb: new Set(['preset', 'seconds', 'decay', 'damping', 'preDelay', 'wet']),
  delay: new Set(['preset', 'sync', 'time', 'bpm', 'feedback', 'damping', 'wet', 'pingPong']),
  chorus: new Set(['preset', 'voices', 'rate', 'depth', 'spread', 'wet', 'width']),
  // kit 1.9.0
  bitcrush: new Set(['preset', 'bits', 'rate', 'wet']),
  snesverb: new Set(['preset', 'edl', 'fir', 'feedback', 'wet', 'mono']),
  tape: new Set(['preset', 'wowRate', 'wowDepth', 'flutterRate', 'flutterDepth', 'drive', 'rolloff', 'hiss', 'wet']),
  spring: new Set(['preset', 'stages', 'spread', 'seconds', 'decay', 'wet']),
  ringmod: new Set(['preset', 'carrier', 'wave', 'wet']),
});
const FX_PRESET_NAMES = Object.freeze({
  reverb: new Set(Object.keys(REVERB_PRESETS)),
  delay: new Set(Object.keys(DELAY_PRESETS)),
  chorus: new Set(Object.keys(CHORUS_PRESETS)),
  bitcrush: new Set(Object.keys(BITCRUSH_PRESETS)),
  snesverb: new Set(Object.keys(SNESVERB_PRESETS)),
  tape: new Set(Object.keys(TAPE_PRESETS)),
  spring: new Set(Object.keys(SPRING_PRESETS)),
  ringmod: new Set(Object.keys(RINGMOD_PRESETS)),
});
const FX_NUMERIC_RANGES = Object.freeze({
  seconds: [0.01, 12], decay: [0.1, 12], damping: [200, 20000], preDelay: [0, 0.5],
  wet: [0, 1], time: [0.001, FX_MAX_DELAY_SECONDS], bpm: [20, 400],
  feedback: [0, FX_MAX_FEEDBACK], voices: [1, FX_MAX_CHORUS_VOICES],
  rate: [0.01, 96000], depth: [0, 0.05], spread: [0, 0.08], width: [0, 1], dry: [0, 1],
  // kit 1.9.0
  bits: [1, 16], edl: [0, SNES_MAX_EDL], stages: [1, FX_MAX_SPRING_STAGES],
  wowRate: [0.01, 10], wowDepth: [0, 0.02], flutterRate: [0.1, 40], flutterDepth: [0, 0.01],
  drive: [0, FX_MAX_DRIVE], rolloff: [200, 20000], hiss: [0, FX_MAX_HISS],
  carrier: [0.1, 8000],
});

/**
 * `rate` means two different things: chorus/tape LFO speed (0.01-20 Hz) and the
 * bitcrusher's target sample rate (200-96000 Hz). The shared range above is the
 * union; these per-kind entries are the real bounds, so `chorus: { rate: 40000 }`
 * is still rejected.
 */
const FX_KIND_NUMERIC_RANGES = Object.freeze({
  chorus: Object.freeze({ rate: [0.01, 20] }),
  bitcrush: Object.freeze({ rate: [200, 96000] }),
  spring: Object.freeze({ spread: [0.0005, 0.02], seconds: [0.05, 6] }),
});

const BASE_VOICE_OPTIONS = Object.freeze({
  pad: new Set(['verb', 'cut', 'sweep', 'q', 'det', 'vol', 'wave', 'a', 'd', 's', 'r', 'sub', 'nudge']),
  drone: new Set(['verb', 'cut', 'q', 'vol', 'beat', 'wave', 'glide', 'a', 'd', 's', 'r', 'sub', 'hp', 'nudge']),
  bell: new Set(['verb', 'ratios', 'levels', 'vol', 'a', 'dScale', 's', 'r', 'holdScale', 'nudge']),
  pluck: new Set(['verb', 'cut', 'wave', 'a', 'dScale', 's', 'r', 'vol', 'holdScale', 'nudge']),
  bass: new Set(['verb', 'cut', 'q', 'vol', 'wave', 'a', 'dScale', 's', 'r', 'holdScale', 'sub', 'nudge']),
  lead: new Set(['verb', 'cut', 'q', 'wave', 'vibrato', 'vibratoDepth', 'grace', 'graceTime', 'a', 'd', 's', 'r', 'vol', 'nudge']),
  air: new Set(['verb', 'type', 'bp', 'sweep', 'q', 'a', 'attackScale', 'decayScale', 's', 'r', 'vol', 'nudge']),
  kick: new Set(['f0', 'f1', 'dur', 'vol', 'nudge']),
  snare: new Set(['bp', 'q', 'dur', 'vol', 'verb', 'nudge']),
  hat: new Set(['hp', 'dur', 'vol', 'verb', 'nudge']),
  chipPulse: new Set(['verb', 'cut', 'q', 'duty', 'dutySweep', 'vol', 'a', 'd', 's', 'r', 'vibrato', 'vibratoDepth', 'vibratoDelay', 'ticksPerRow', 'tickDuration', 'fx', 'nudge']),
  chipTriangle: new Set(['verb', 'cut', 'q', 'vol', 'a', 'd', 's', 'r', 'vibrato', 'vibratoDepth', 'vibratoDelay', 'ticksPerRow', 'tickDuration', 'fx', 'nudge']),
  chipNoise: new Set(['verb', 'cut', 'q', 'mode', 'f0', 'f1', 'vol', 'a', 'd', 's', 'r', 'vibrato', 'vibratoDepth', 'vibratoDelay', 'ticksPerRow', 'tickDuration', 'fx', 'nudge']),
});

/**
 * Kit 1.8.0: the per-voice send option each fx bus reads, minus `verb` (which
 * every wet-tapped voice already accepts). A future effect adds its send name
 * here by appearing in FX_KINDS — no per-voice edits.
 */
const FX_VOICE_SEND_OPTIONS = Object.freeze(
  FX_KINDS.map((kind) => FX_VOICE_SEND[kind]).filter((name) => name !== 'verb'),
);

/**
 * Any voice with a reverb send also accepts the fx sends. `kick` has no wet tap
 * at all in the kit, so it is deliberately left without one here too.
 */
const VOICE_OPTIONS = Object.freeze(Object.fromEntries(
  Object.entries(BASE_VOICE_OPTIONS).map(([voice, options]) => [
    voice,
    options.has('verb') ? new Set([...options, ...FX_VOICE_SEND_OPTIONS]) : options,
  ]),
));

const OPTION_RANGES = Object.freeze({
  // Every effect's per-voice send amount is 0..1, derived from FX_KINDS so a new
  // effect is bounded the moment it joins the table. Kit 1.8.0 promised this in
  // a comment but listed the three ranges by hand, which left the five kinds
  // added in 1.9.0 accepting any number at all.
  ...Object.fromEntries(FX_KINDS.map((kind) => [FX_VOICE_SEND[kind], [0, 1]])),
  cut: [1, 24000], bp: [1, 24000], hp: [1, 24000],
  f0: [1, 24000], f1: [1, 24000], sweep: [0.01, 16], q: [0, 100],
  det: [-2400, 2400], beat: [-2400, 2400], vol: [0, 4],
  a: [0, 120], d: [0, 120], r: [0, 120], dur: [0.001, 120],
  s: [0, 1], dScale: [0, 4], holdScale: [0, 4],
  attackScale: [0, 4], decayScale: [0, 4],
  vibrato: [0, 100], vibratoDepth: [0, 1], vibratoDelay: [0, 10],
  grace: [-24, 24], graceTime: [0, 1],
  duty: [0.001, 0.999], dutySweep: [0.001, 0.999],
  ticksPerRow: [1, 32], tickDuration: [0.001, 1],
  nudge: [-50, 50],
});
const WAVES = new Set(['sine', 'square', 'sawtooth', 'triangle']);
const FILTER_TYPES = new Set(['lowpass', 'highpass', 'bandpass', 'notch', 'allpass']);

export class SpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpecError';
  }
}

const validatedArtifacts = new WeakSet();

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function isValidatedScoreArtifact(value) {
  return isPlainObject(value) && validatedArtifacts.has(value);
}

export function requireValidatedScoreArtifact(value) {
  if (!isValidatedScoreArtifact(value)) {
    throw new SpecError('render input: expected an immutable validated score artifact; call validateSpec first');
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assert(condition, message) {
  if (!condition) throw new SpecError(message);
}

function assertKnownFields(value, allowed, path) {
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${path}.${key}: unknown field`);
  }
}

function assertFiniteInRange(value, min, max, path) {
  assert(typeof value === 'number' && Number.isFinite(value), `${path}: must be a finite number`);
  assert(value >= min && value <= max, `${path}: must be between ${min} and ${max}`);
}

function validateNote(value, path) {
  assert(typeof value === 'string', `${path}: must be a string`);
  try {
    noteFreq(value);
  } catch {
    throw new SpecError(`${path}: unrecognised note name "${value}"`);
  }
}

function validateFxEntry(entry, path) {
  assert(isPlainObject(entry), `${path}: must be an object`);
  assert(typeof entry.type === 'string', `${path}.type: required string`);
  assert(CHIP_FX_FIELDS[entry.type] !== undefined, `${path}.type: unknown tracker-fx type`);
  assertKnownFields(entry, CHIP_FX_FIELDS[entry.type], path);
  if (entry.intervals !== undefined) {
    assert(Array.isArray(entry.intervals) && entry.intervals.length >= 1 && entry.intervals.length <= 16, `${path}.intervals: must be an array of 1..16 numbers`);
    entry.intervals.forEach((v, i) => assertFiniteInRange(v, -48, 48, `${path}.intervals[${i}]`));
  }
  if (entry.target !== undefined) {
    if (typeof entry.target === 'string') validateNote(entry.target, `${path}.target`);
    else assertFiniteInRange(entry.target, 1, 24000, `${path}.target`);
  }
  if (entry.rate !== undefined) assertFiniteInRange(entry.rate, -100, 100, `${path}.rate`);
  if (entry.tick !== undefined) assert(Number.isInteger(entry.tick) && entry.tick >= 0, `${path}.tick: must be a non-negative integer`);
  if (entry.every !== undefined) assert(Number.isInteger(entry.every) && entry.every >= 1, `${path}.every: must be a positive integer`);
  if (entry.value !== undefined) assertFiniteInRange(entry.value, 0.001, 0.999, `${path}.value`);
  if (entry.end !== undefined) assertFiniteInRange(entry.end, 0.001, 0.999, `${path}.end`);
  if (entry.depth !== undefined) assertFiniteInRange(entry.depth, 0, 1, `${path}.depth`);
  if (entry.delay !== undefined) assertFiniteInRange(entry.delay, 0, 10, `${path}.delay`);
}

function validateOptions(opts, voice, path) {
  assert(isPlainObject(opts), `${path}: must be an object`);
  assertKnownFields(opts, VOICE_OPTIONS[voice], path);
  for (const [key, value] of Object.entries(opts)) {
    if (key === 'sub') {
      assert(value === false || value === true || (typeof value === 'number' && Number.isFinite(value)),
        `${path}.sub: must be a boolean or finite number (0/false disables the hard-wired sub)`);
      continue;
    }
    if (OPTION_RANGES[key]) {
      assertFiniteInRange(value, OPTION_RANGES[key][0], OPTION_RANGES[key][1], `${path}.${key}`);
    } else if (key === 'wave') {
      assert(typeof value === 'string' && WAVES.has(value), `${path}.wave: unsupported oscillator type`);
    } else if (key === 'type') {
      assert(typeof value === 'string' && FILTER_TYPES.has(value), `${path}.type: unsupported filter type`);
    } else if (key === 'mode') {
      assert(typeof value === 'string' && (value === 'white' || value === 'periodic'), `${path}.mode: must be "white" or "periodic"`);
    } else if (key === 'glide') {
      validateNote(value, `${path}.glide`);
    } else if (key === 'ratios' || key === 'levels') {
      assert(Array.isArray(value) && value.length > 0 && value.length <= 32, `${path}.${key}: must be an array of 1..32 numbers`);
      const max = key === 'ratios' ? 64 : 4;
      const min = key === 'ratios' ? 0.01 : 0;
      value.forEach((entry, index) => assertFiniteInRange(entry, min, max, `${path}.${key}[${index}]`));
    } else if (key === 'fx') {
      assert(Array.isArray(value) && value.length <= 16, `${path}.fx: must be an array of at most 16 entries`);
      value.forEach((entry, index) => validateFxEntry(entry, `${path}.fx[${index}]`));
    }
  }
  if (opts.ratios && opts.levels) {
    assert(opts.ratios.length === opts.levels.length, `${path}: ratios and levels must have equal lengths`);
  }
}

function validateRange(value, min, max, path) {
  assert(Array.isArray(value) && value.length === 2, `${path}: must be a [min, max] pair`);
  value.forEach((entry, index) => assertFiniteInRange(entry, min, max, `${path}[${index}]`));
  assert(value[0] <= value[1], `${path}: min must be less than or equal to max`);
}

function validateHumanize(value, path) {
  assert(isPlainObject(value), `${path}: must be an object`);
  assertKnownFields(value, HUMANIZE_FIELDS, path);
  if (value.timingMs !== undefined) validateRange(value.timingMs, -50, 50, `${path}.timingMs`);
  if (value.velocity !== undefined) validateRange(value.velocity, -1, 1, `${path}.velocity`);
  if (value.swing !== undefined) assertFiniteInRange(value.swing, 0, 1, `${path}.swing`);
}

function validatePerformance(value) {
  assert(isPlainObject(value), 'spec.performance: must be an object');
  assertKnownFields(value, PERFORMANCE_FIELDS, 'spec.performance');
  if (value.humanize !== undefined) validateHumanize(value.humanize, 'spec.performance.humanize');
  if (value.releaseTail !== undefined) assertFiniteInRange(value.releaseTail, 0, 30, 'spec.performance.releaseTail');
  if (value.voices === undefined) return;
  assert(isPlainObject(value.voices), 'spec.performance.voices: must be an object');
  for (const [voice, settings] of Object.entries(value.voices)) {
    const path = `spec.performance.voices.${voice}`;
    assert(VOICES.includes(voice), `${path}: unknown voice`);
    assert(isPlainObject(settings), `${path}: must be an object`);
    assertKnownFields(settings, VOICE_PERFORMANCE_FIELDS, path);
    if (settings.humanize !== undefined) validateHumanize(settings.humanize, `${path}.humanize`);
    if (settings.releaseTail !== undefined) {
      assert(RELEASE_VOICES.has(voice), `${path}.releaseTail: release tails are supported only for pad and drone`);
      assertFiniteInRange(settings.releaseTail, 0, 30, `${path}.releaseTail`);
    }
  }
}

/** One effect declaration: a preset name, or an options object. */
function validateFxEffect(value, kind, path) {
  if (typeof value === 'string') {
    assert(FX_PRESET_NAMES[kind].has(value), `${path}: unknown preset "${value}" (have ${[...FX_PRESET_NAMES[kind]].join(', ')})`);
    return;
  }
  assert(isPlainObject(value), `${path}: must be a preset name or an options object`);
  assertKnownFields(value, FX_EFFECT_FIELDS[kind], path);
  if (value.preset !== undefined) {
    assert(
      typeof value.preset === 'string' && FX_PRESET_NAMES[kind].has(value.preset),
      `${path}.preset: unknown preset "${value.preset}" (have ${[...FX_PRESET_NAMES[kind]].join(', ')})`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'preset') continue;
    if (key === 'pingPong') {
      assert(typeof entry === 'boolean', `${path}.pingPong: must be a boolean`);
      continue;
    }
    if (key === 'sync') {
      assert(
        entry === null || (typeof entry === 'string' && Object.hasOwn(DELAY_SYNC_FRACTIONS, entry)),
        `${path}.sync: must be null or one of ${Object.keys(DELAY_SYNC_FRACTIONS).join(', ')}`,
      );
      continue;
    }
    if (key === 'time' && entry === null) continue;
    // kit 1.9.0 non-numeric fields
    if (key === 'mono') {
      assert(typeof entry === 'boolean', `${path}.mono: must be a boolean`);
      continue;
    }
    if (key === 'fir') {
      if (Array.isArray(entry)) {
        assert(entry.length === SNES_FIR_TAPS, `${path}.fir: needs exactly ${SNES_FIR_TAPS} taps`);
        entry.forEach((tap, index) => assert(
          Number.isInteger(tap) && tap >= -128 && tap <= 127,
          `${path}.fir[${index}]: must be an integer from -128 to 127`,
        ));
        continue;
      }
      assert(
        typeof entry === 'string' && Object.hasOwn(SNES_FIR_PRESETS, entry),
        `${path}.fir: must be one of ${Object.keys(SNES_FIR_PRESETS).join(', ')}, or an array of ${SNES_FIR_TAPS} signed bytes`,
      );
      continue;
    }
    if (key === 'wave') {
      assert(
        typeof entry === 'string' && ['sine', 'square', 'triangle', 'sawtooth'].includes(entry),
        `${path}.wave: must be sine, square, triangle or sawtooth`,
      );
      continue;
    }
    if (key === 'rate' && kind === 'bitcrush' && entry === null) continue;
    const range = FX_KIND_NUMERIC_RANGES[kind]?.[key] ?? FX_NUMERIC_RANGES[key];
    assert(range !== undefined, `${path}.${key}: unsupported field`);
    assertFiniteInRange(entry, range[0], range[1], `${path}.${key}`);
    if (key === 'voices') assert(Number.isInteger(entry), `${path}.voices: must be an integer`);
    if (key === 'bits' || key === 'edl' || key === 'stages') {
      assert(Number.isInteger(entry), `${path}.${key}: must be an integer`);
    }
  }
}

/**
 * Section-boundary posture (kit 1.9.0). Omitted is the historical crossfade, so
 * every score written before 1.9.0 keeps its boundaries — and its bytes.
 */
function validateRetire(value) {
  assert(isPlainObject(value), 'spec.retire: must be an object');
  assertKnownFields(value, RETIRE_FIELDS, 'spec.retire');
  assert(
    typeof value.mode === 'string' && RETIRE_MODES.includes(value.mode),
    `spec.retire.mode: must be one of ${RETIRE_MODES.join(', ')}`,
  );
  if (value.hold !== undefined) assertFiniteInRange(value.hold, 0, RETIRE_MAX_HOLD, 'spec.retire.hold');
  assert(
    value.mode !== 'tail' || (typeof value.hold === 'number' && value.hold > 0),
    'spec.retire: mode "tail" needs a hold greater than 0, or it is just a crossfade',
  );
}

function validateFx(value, spec) {
  assert(isPlainObject(value), 'spec.fx: must be an object');
  assertKnownFields(value, FX_FIELDS, 'spec.fx');
  if (value.bpm !== undefined) assertFiniteInRange(value.bpm, 20, 400, 'spec.fx.bpm');
  let declared = 0;
  for (const kind of FX_KINDS) {
    if (value[kind] === undefined) continue;
    validateFxEffect(value[kind], kind, `spec.fx.${kind}`);
    declared += 1;
  }
  if (value.master !== undefined) {
    assert(isPlainObject(value.master), 'spec.fx.master: must be an object');
    assertKnownFields(value.master, FX_MASTER_FIELDS, 'spec.fx.master');
    if (value.master.dry !== undefined) assertFiniteInRange(value.master.dry, 0, 1, 'spec.fx.master.dry');
    let inserts = 0;
    for (const kind of FX_KINDS) {
      if (value.master[kind] === undefined) continue;
      validateFxEffect(value.master[kind], kind, `spec.fx.master.${kind}`);
      inserts += 1;
    }
    assert(inserts > 0, 'spec.fx.master: declare at least one insert effect, or omit master');
    declared += inserts;
  }
  assert(declared > 0, 'spec.fx: declare at least one effect, or omit fx');
  // Resolve through the kit so a beat-synced delay without a tempo fails here
  // rather than at render time, and so both layers agree on what is legal.
  try {
    normalizeFx(value, { bpm: spec.tempo });
  } catch (cause) {
    throw new SpecError(`spec.fx: ${cause.message}`);
  }
}

function validateStepEvent(event, path, trackLength, sampleVoices = null, requireRole = false) {
  assert(isPlainObject(event), `${path}: must be an object`);
  assertKnownFields(event, STEP_FIELDS, path);
  assert(!(event.voice !== undefined && event.v !== undefined), `${path}: use voice or v, not both`);
  const voice = event.voice ?? event.v;
  assert(typeof voice === 'string' && VOICES.includes(voice), `${path}.voice: must be one of ${VOICES.join(', ')}`);
  if (event.role !== undefined) {
    assert(typeof event.role === 'string' && VOICE_ROLES.includes(event.role), `${path}.role: must be one of ${VOICE_ROLES.join(', ')}`);
  } else if (requireRole) {
    throw new SpecError(`${path}.role: required when spec.register.class is declared`);
  }

  assert(!(event.i !== undefined && event.every !== undefined), `${path}: use i or every, not both`);
  if (event.i !== undefined) {
    if (Array.isArray(event.i)) {
      assert(event.i.length > 0 && event.i.length <= trackLength, `${path}.i: array must contain 1..${trackLength} entries`);
      const seen = new Set();
      for (const index of event.i) {
        assert(Number.isInteger(index) && index >= 0 && index < trackLength, `${path}.i: entries must be integers within track length`);
        assert(!seen.has(index), `${path}.i: duplicate step index ${index}`);
        seen.add(index);
      }
    } else {
      assert(Number.isInteger(event.i) && event.i >= 0 && event.i < trackLength, `${path}.i: must be an integer within track length or an array of them`);
    }
  } else if (event.every !== undefined) {
    assert(Number.isInteger(event.every) && event.every >= 1 && event.every <= trackLength, `${path}.every: must be an integer from 1 to track length`);
  } else {
    throw new SpecError(`${path}: needs i (step index) or every (stride)`);
  }

  if (!PERC.has(voice)) {
    if (AIR.has(voice)) {
      assertFiniteInRange(event.dur, 0.001, SPEC_LIMITS.eventDuration, `${path}.dur`);
      assert(event.note === undefined && event.freq === undefined, `${path}: air does not accept note or freq`);
    } else {
      assert(!(event.note !== undefined && event.freq !== undefined), `${path}: use note or freq, not both`);
      assert(event.note !== undefined || event.freq !== undefined, `${path}: pitched voice needs note (e.g. "C3") or freq (Hz)`);
      if (event.note !== undefined) validateNote(event.note, `${path}.note`);
      if (event.freq !== undefined) assertFiniteInRange(event.freq, 1, 24000, `${path}.freq`);
      assertFiniteInRange(event.dur, 0.001, SPEC_LIMITS.eventDuration, `${path}.dur`);
    }
  } else {
    assert(event.note === undefined && event.freq === undefined && event.dur === undefined, `${path}: percussion timing belongs in opts`);
  }

  assert(!(event.opts !== undefined && event.o !== undefined), `${path}: use opts or o, not both`);
  if (event.nudge !== undefined) assertFiniteInRange(event.nudge, -50, 50, `${path}.nudge`);
  const opts = event.opts ?? event.o;
  if (opts !== undefined) {
    const optsPath = `${path}.${event.opts !== undefined ? 'opts' : 'o'}`;
    if (sampleVoices && Object.hasOwn(sampleVoices, voice)) {
      assert(isPlainObject(opts), `${optsPath}: must be an object`);
      assertKnownFields(opts, new Set(['vol', 'nudge']), optsPath);
      if (opts.vol !== undefined) assertFiniteInRange(opts.vol, 0, 4, `${optsPath}.vol`);
      if (opts.nudge !== undefined) assertFiniteInRange(opts.nudge, -50, 50, `${optsPath}.nudge`);
    } else {
      validateOptions(opts, voice, optsPath);
    }
  }
}

/**
 * A sampler event whose note falls outside every zone would render silence.
 * Catch it at validation, where the author can still see it, rather than
 * letting a hole in the zone map ship as a missing note.
 */
export function samplerEventMidi(event) {
  if (event.note !== undefined) return noteToMidi(event.note);
  if (event.freq !== undefined) return nearestMidi(event.freq);
  return null;
}

function assertSamplerZoneCoverage(event, path, sampleVoices) {
  if (!sampleVoices) return;
  const voice = event.voice ?? event.v;
  const binding = sampleVoices[voice];
  if (!binding || binding.kind !== 'sampler') return;
  const midi = samplerEventMidi(event);
  assert(midi !== null, `${path}: sampler voice needs a note or frequency that resolves to a MIDI pitch`);
  const zone = selectSamplerZone(binding.zones, midi);
  assert(zone !== null, `${path}: no zone in spec.sampleVoices.${voice} covers MIDI ${midi}`);
  const semitones = midi - zone.rootNote;
  assert(
    semitones >= -SAMPLER_MAX_SEMITONES && semitones <= SAMPLER_MAX_SEMITONES,
    `${path}: MIDI ${midi} is ${semitones} semitones from its zone root, beyond the sampler limit`,
  );
}

function validateSampleFields(spec) {
  const hasPack = spec.samplePack !== undefined;
  const hasVoices = spec.sampleVoices !== undefined;
  assert(hasPack === hasVoices, 'spec: samplePack and sampleVoices must either both be present or both be absent');
  if (!hasPack) return;

  assert(isPlainObject(spec.samplePack), 'spec.samplePack: must be an object');
  assertKnownFields(spec.samplePack, SAMPLE_PACK_FIELDS, 'spec.samplePack');
  for (const field of SAMPLE_PACK_FIELDS) assert(Object.hasOwn(spec.samplePack, field), `spec.samplePack.${field}: required field`);
  assert(typeof spec.samplePack.packId === 'string' && SLUG.test(spec.samplePack.packId), 'spec.samplePack.packId: required lowercase slug');
  assert(SUPPORTED_PACK_FORMATS.has(spec.samplePack.formatVersion), 'spec.samplePack.formatVersion: required supported version "1.0.0" or "1.1.0"');
  for (const key of ['manifestSha256', 'contentSha256']) {
    assert(typeof spec.samplePack[key] === 'string' && HEX_256.test(spec.samplePack[key]), `spec.samplePack.${key}: required lowercase SHA-256`);
  }

  assert(isPlainObject(spec.sampleVoices), 'spec.sampleVoices: must be an object');
  const entries = Object.entries(spec.sampleVoices);
  assert(
    entries.length > 0 && entries.length <= MAX_SAMPLE_BINDINGS,
    `spec.sampleVoices: must contain 1..${MAX_SAMPLE_BINDINGS} bindings`,
  );
  for (const [voice, binding] of entries) {
    const path = `spec.sampleVoices.${voice}`;
    assert(isPlainObject(binding), `${path}: must be an object`);
    assert(
      binding.kind === 'one-shot' || binding.kind === 'sampler',
      `${path}.kind: must be "one-shot" or "sampler"`,
    );
    if (binding.kind === 'sampler') {
      assert(
        SAMPLER_VOICE_SET.has(voice),
        `spec.sampleVoices.${voice}: sampler bindings are supported only for ${SAMPLER_VOICES.join(', ')}`,
      );
      assert(spec.samplePack.formatVersion !== '1.0.0', `${path}: sampler bindings require pack format "1.1.0"`);
      assertKnownFields(binding, SAMPLER_VOICE_FIELDS, path);
      for (const field of ['kind', 'zones', 'gain']) assert(Object.hasOwn(binding, field), `${path}.${field}: required field`);
      assertFiniteInRange(binding.gain, 0, 4, `${path}.gain`);
      if (binding.release !== undefined) assertFiniteInRange(binding.release, 0, 2, `${path}.release`);
      assert(Array.isArray(binding.zones), `${path}.zones: must be an array`);
      assert(
        binding.zones.length > 0 && binding.zones.length <= MAX_SAMPLER_ZONES,
        `${path}.zones: must contain 1..${MAX_SAMPLER_ZONES} zones`,
      );
      const covered = new Set();
      binding.zones.forEach((zone, index) => {
        const zonePath = `${path}.zones[${index}]`;
        assert(isPlainObject(zone), `${zonePath}: must be an object`);
        assertKnownFields(zone, SAMPLER_ZONE_FIELDS, zonePath);
        for (const field of SAMPLER_ZONE_FIELDS) assert(Object.hasOwn(zone, field), `${zonePath}.${field}: required field`);
        for (const field of ['lo', 'hi', 'rootNote']) {
          assert(
            Number.isInteger(zone[field]) && zone[field] >= 0 && zone[field] <= 127,
            `${zonePath}.${field}: required MIDI integer from 0 to 127`,
          );
        }
        assert(zone.lo <= zone.hi, `${zonePath}: lo must not exceed hi`);
        assert(
          zone.rootNote >= zone.lo - 48 && zone.rootNote <= zone.hi + 48,
          `${zonePath}: root note is more than four octaves outside the zone`,
        );
        assert(typeof zone.assetId === 'string' && SLUG.test(zone.assetId), `${zonePath}.assetId: required lowercase slug`);
        assert(typeof zone.pcmSha256 === 'string' && HEX_256.test(zone.pcmSha256), `${zonePath}.pcmSha256: required lowercase SHA-256`);
        const key = `${zone.lo}:${zone.hi}:${zone.rootNote}:${zone.assetId}`;
        assert(!covered.has(key), `${zonePath}: duplicate zone`);
        covered.add(key);
      });
      continue;
    }
    assert(SAMPLE_DRUMS.has(voice), `spec.sampleVoices.${voice}: one-shot bindings support only kick, snare, and hat`);
    assertKnownFields(binding, SAMPLE_VOICE_FIELDS, path);
    for (const field of SAMPLE_VOICE_FIELDS) assert(Object.hasOwn(binding, field), `${path}.${field}: required field`);
    assert(typeof binding.assetId === 'string' && SLUG.test(binding.assetId), `${path}.assetId: required lowercase slug`);
    assert(typeof binding.pcmSha256 === 'string' && HEX_256.test(binding.pcmSha256), `${path}.pcmSha256: required lowercase SHA-256`);
    assertFiniteInRange(binding.gain, 0, 4, `${path}.gain`);
  }
}

/** Validate a parsed PatternSpec. Returns the same value for M0 compatibility. */
export function validateSpec(spec) {
  if (isValidatedScoreArtifact(spec)) return spec;
  assert(isPlainObject(spec), 'spec: must be a JSON object');
  assert(Object.hasOwn(SCORE_COMPATIBILITY, spec.schemaVersion), `spec.schemaVersion: supported versions are "${LEGACY_SCHEMA_VERSION}" and "${SCHEMA_VERSION}"`);
  assertKnownFields(spec, spec.schemaVersion === LEGACY_SCHEMA_VERSION ? LEGACY_TOP_FIELDS : TOP_FIELDS, 'spec');
  if (spec.schemaVersion === LEGACY_SCHEMA_VERSION) {
    assert(spec.samplePack === undefined && spec.sampleVoices === undefined, 'spec: sample fields require schemaVersion "1.1.0"');
  } else {
    validateSampleFields(spec);
  }
  assert(isPlainObject(spec.kitVersion), 'spec.kitVersion: required object with semver and sha');
  assertKnownFields(spec.kitVersion, KIT_VERSION_FIELDS, 'spec.kitVersion');
  assert(typeof spec.kitVersion.semver === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec.kitVersion.semver), 'spec.kitVersion.semver: required semantic version');
  assert(typeof spec.kitVersion.sha === 'string' && /^[a-f0-9]{64}$/.test(spec.kitVersion.sha), 'spec.kitVersion.sha: required lowercase SHA-256');
  assert(isCompatibleKitVersion(spec.schemaVersion, spec.kitVersion), `spec.kitVersion: unsupported kit for schema ${spec.schemaVersion}; renderer requires ${KIT_VERSION.semver}+${KIT_VERSION.sha}`);
  assert(Number.isInteger(spec.seed) && spec.seed >= 0 && spec.seed <= 0xffffffff, 'spec.seed: required unsigned 32-bit integer');
  assert(isPlainObject(spec.register), 'spec.register: required object with name and briefRef');
  assertKnownFields(spec.register, REGISTER_FIELDS, 'spec.register');
  assert(typeof spec.register.name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(spec.register.name), 'spec.register.name: required lowercase slug');
  assert(
    typeof spec.register.briefRef === 'string'
      && /^docs\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/.test(spec.register.briefRef)
      && !spec.register.briefRef.split('/').includes('..'),
    'spec.register.briefRef: required safe repository-relative docs/*.md path',
  );
  if (spec.register.harmonicArchitecture !== undefined) {
    assert(
      ['root-static', 'pedal-dominant', 'static-bed'].includes(spec.register.harmonicArchitecture),
      'spec.register.harmonicArchitecture: must be "root-static", "pedal-dominant", or "static-bed"',
    );
  }
  if (spec.register.class !== undefined) {
    assert(REGISTER_CLASSES.includes(spec.register.class), `spec.register.class: must be one of ${REGISTER_CLASSES.join(', ')}`);
    assert(
      spec.kitVersion.semver === '1.4.0'
        || (spec.kitVersion.semver === KIT_VERSION.semver && spec.kitVersion.sha === KIT_VERSION.sha),
      `spec.register.class: requires doctrine kit 1.4.0 or current kit ${KIT_VERSION.semver}+${KIT_VERSION.sha}`,
    );
  }
  if (spec.register.salientEventsPerMinute !== undefined) {
    assertFiniteInRange(spec.register.salientEventsPerMinute, 0, 240, 'spec.register.salientEventsPerMinute');
    assert(spec.register.class === 'calm', 'spec.register.salientEventsPerMinute: valid only for register class "calm"');
  } else if (spec.register.class === 'calm') {
    throw new SpecError('spec.register.salientEventsPerMinute: required for register class "calm"');
  }
  if (spec.register.staticBedAuthorization !== undefined) {
    const authorization = spec.register.staticBedAuthorization;
    assert(isPlainObject(authorization), 'spec.register.staticBedAuthorization: must be an object');
    assertKnownFields(authorization, STATIC_BED_AUTHORIZATION_FIELDS, 'spec.register.staticBedAuthorization');
    assert(spec.register.harmonicArchitecture === 'static-bed', 'spec.register.staticBedAuthorization: requires harmonicArchitecture "static-bed"');
    assert(typeof authorization.operator === 'string' && authorization.operator.trim(), 'spec.register.staticBedAuthorization.operator: required non-empty string');
    assert(typeof authorization.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(authorization.date), 'spec.register.staticBedAuthorization.date: required YYYY-MM-DD date');
    assert(authorization.briefRef === spec.register.briefRef, 'spec.register.staticBedAuthorization.briefRef: must match spec.register.briefRef');
  }
  assert(isPlainObject(spec.tracks), 'spec.tracks: required non-empty object');
  const trackEntries = Object.entries(spec.tracks);
  assert(trackEntries.length > 0 && trackEntries.length <= SPEC_LIMITS.tracks, `spec.tracks: must contain 1..${SPEC_LIMITS.tracks} tracks`);
  assert(Array.isArray(spec.sections) && spec.sections.length > 0 && spec.sections.length <= SPEC_LIMITS.sections, `spec.sections: must contain 1..${SPEC_LIMITS.sections} sections`);

  if (spec.tempo !== undefined) assertFiniteInRange(spec.tempo, 20, 400, 'spec.tempo');
  assert(spec.sampleRate === 44100, 'spec.sampleRate: required fixed value 44100 for this deterministic toolchain');
  if (spec.gain !== undefined) assertFiniteInRange(spec.gain, 0, 1, 'spec.gain');
  if (spec.label !== undefined) assert(typeof spec.label === 'string' && spec.label.length <= 500, 'spec.label: must be a string of at most 500 characters');
  if (spec.performance !== undefined) {
    assert(
      spec.kitVersion.semver !== '1.1.0',
      'spec.performance: requires kit 1.2.0 or newer',
    );
    validatePerformance(spec.performance);
  }
  if (spec.fx !== undefined) {
    assert(
      spec.kitVersion.semver === KIT_VERSION.semver && spec.kitVersion.sha === KIT_VERSION.sha,
      `spec.fx: requires the current kit ${KIT_VERSION.semver}+${KIT_VERSION.sha}`,
    );
    validateFx(spec.fx, spec);
  }
  if (spec.retire !== undefined) {
    assert(
      spec.kitVersion.semver === KIT_VERSION.semver && spec.kitVersion.sha === KIT_VERSION.sha,
      `spec.retire: requires the current kit ${KIT_VERSION.semver}+${KIT_VERSION.sha}`,
    );
    validateRetire(spec.retire);
  }

  for (const [name, track] of trackEntries) {
    assert(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name), `spec.tracks.${name}: invalid track name`);
    assert(isPlainObject(track), `spec.tracks.${name}: must be an object`);
    assertKnownFields(track, TRACK_FIELDS, `spec.tracks.${name}`);
    const bpm = track.bpm ?? spec.tempo;
    assertFiniteInRange(bpm, 20, 400, `spec.tracks.${name}.bpm`);
    assert(Number.isInteger(track.len) && track.len >= 1 && track.len <= SPEC_LIMITS.trackLength, `spec.tracks.${name}.len: required integer from 1 to ${SPEC_LIMITS.trackLength}`);
    assert(Array.isArray(track.steps) && track.steps.length <= SPEC_LIMITS.stepsPerTrack, `spec.tracks.${name}.steps: required array with at most ${SPEC_LIMITS.stepsPerTrack} events`);
    if (track.vol !== undefined) assertFiniteInRange(track.vol, 0, 1, `spec.tracks.${name}.vol`);
    track.steps.forEach((event, index) => validateStepEvent(event, `spec.tracks.${name}.steps[${index}]`, track.len, spec.sampleVoices, spec.register.class !== undefined));
    track.steps.forEach((event, index) => assertSamplerZoneCoverage(event, `spec.tracks.${name}.steps[${index}]`, spec.sampleVoices));
    const reserveSteps = new Set();
    const trackStepSeconds = 60 / (track.bpm ?? spec.tempo) / 4;
    for (const event of track.steps) {
      if (event.role !== 'reserve') continue;
      const starts = event.i !== undefined
        ? (Array.isArray(event.i) ? event.i : [event.i])
        : Array.from({ length: Math.ceil(track.len / event.every) }, (_, index) => index * event.every);
      const authoredDuration = event.dur ?? (event.opts ?? event.o)?.dur ?? trackStepSeconds;
      const occupiedSteps = Math.max(1, Math.ceil(authoredDuration / trackStepSeconds));
      for (const start of starts) {
        for (let offset = 0; offset < occupiedSteps; offset++) reserveSteps.add((start + offset) % track.len);
      }
    }
    assert(
      reserveSteps.size <= Math.floor(track.len / 4),
      `spec.tracks.${name}: reserve role must remain silent through most of the microcycle (max 25% onset steps)`,
    );
  }

  let duration = 0;
  let environmentPass = 0;
  let introTrack = null;
  let bodySections = 0;
  const usesExecutionSchedule = spec.sections.some((section) => section.execution !== undefined);
  spec.sections.forEach((section, index) => {
    const path = `spec.sections[${index}]`;
    assert(isPlainObject(section), `${path}: must be an object`);
    assertKnownFields(section, SECTION_FIELDS, path);
    assert(typeof section.track === 'string' && section.track, `${path}.track: required string`);
    assert(Object.hasOwn(spec.tracks, section.track), `${path}.track: unknown track "${section.track}"`);
    assert(Number.isInteger(section.bars) && section.bars >= 1 && section.bars <= SPEC_LIMITS.barsPerSection, `${path}.bars: required integer from 1 to ${SPEC_LIMITS.barsPerSection}`);
    if (section.fadeIn !== undefined) assertFiniteInRange(section.fadeIn, 0, 30, `${path}.fadeIn`);
    if (section.harmonicClaim !== undefined) {
      assert(['new', 'reuse'].includes(section.harmonicClaim), `${path}.harmonicClaim: must be "new" or "reuse"`);
    }
    if (usesExecutionSchedule) {
      assert(isPlainObject(section.execution), `${path}.execution: required on every section when a mutation schedule is declared`);
      assertKnownFields(section.execution, SECTION_EXECUTION_FIELDS, `${path}.execution`);
      const kind = section.execution.kind;
      assert(['intro', 'body', 'mutation'].includes(kind), `${path}.execution.kind: must be "intro", "body", or "mutation"`);
      if (kind === 'intro') {
        assert(index === 0, `${path}.execution.kind: intro must be the first section and therefore plays once`);
        assert(section.execution.every === undefined && section.execution.id === undefined, `${path}.execution: intro cannot declare every or id`);
        introTrack = section.track;
      } else {
        environmentPass += 1;
        assert(section.track !== introTrack, `${path}.track: the intro track may play only once`);
      }
      if (kind === 'body') {
        bodySections += 1;
        assert(section.execution.every === undefined && section.execution.id === undefined, `${path}.execution: body cannot declare every or id`);
      }
      if (kind === 'mutation') {
        assert(Number.isInteger(section.execution.every) && section.execution.every >= 2, `${path}.execution.every: mutation stride must be an integer >= 2`);
        assert(typeof section.execution.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(section.execution.id), `${path}.execution.id: required lowercase slug`);
        assert(environmentPass % section.execution.every === 0, `${path}.execution.every: mutation is not scheduled on environment pass ${environmentPass}`);
        assert(section.harmonicClaim === 'reuse', `${path}.harmonicClaim: mutation variants reprising a bed must declare "reuse"`);
      }
    }
    const track = spec.tracks[section.track];
    duration += section.bars * barSeconds(track.bpm ?? spec.tempo);
  });
  if (usesExecutionSchedule) assert(bodySections > 0, 'spec.sections: mutation schedule requires at least one body section');
  assert(duration <= SPEC_LIMITS.renderSeconds, `spec.sections: musical duration exceeds ${SPEC_LIMITS.renderSeconds} seconds`);
  const artifact = deepFreeze(structuredClone(spec));
  validatedArtifacts.add(artifact);
  return artifact;
}

/** Mechanical shipping classification derived from the validated register. */
export function shippingStatus(spec) {
  requireValidatedScoreArtifact(spec);
  if (spec.register.name === 'kit-demo') {
    return Object.freeze({
      shippable: false,
      reason: 'register "kit-demo" is a tooling exercise, not a shippable musical register',
    });
  }
  return Object.freeze({ shippable: true, reason: null });
}

/** Seconds for one 16-step bar at bpm. */
export function barSeconds(bpm) {
  return 16 * (60 / bpm / 4);
}

/** Total musical duration of all sections (no reverb tail). */
export function specDuration(spec) {
  const artifact = validateSpec(spec);
  return artifact.sections.reduce((total, section) => {
    const track = artifact.tracks[section.track];
    return total + section.bars * barSeconds(track.bpm ?? artifact.tempo);
  }, 0);
}

/**
 * How far the score's longest note rings PAST the end of the music, in seconds.
 *
 * KIT 1.9.0 BUG FIX. The render buffer used to be budgeted at a constant —
 * RETIRE_TAIL (0.75 s) plus the reverb IR — regardless of what the score
 * actually played, so a section-final note with a long release was cut off by
 * the end of the file. Measured before the fix: a bell at the last step with
 * r = 2.5 s ended mid-decay with 10 ms of audio still at -58 dB against its own
 * peak, i.e. a hard edge, not a tail.
 *
 * The bound per section is `sectionEnd + voiceTail`, since no event in a section
 * can start after that section ends. That is exact for the final section (where
 * sectionEnd is the end of the music) and conservative by at most one section
 * for earlier ones — which costs nothing, because the renderer only ever takes
 * the LARGER of this and the historical budget. A score whose tails already fit
 * keeps its old length, and therefore its old bytes.
 */
export function specTailOverhangSeconds(spec) {
  const artifact = validateSpec(spec);
  const musicSeconds = artifact.sections.reduce((total, section) => {
    const track = artifact.tracks[section.track];
    return total + section.bars * barSeconds(track.bpm ?? artifact.tempo);
  }, 0);
  const sampleVoices = artifact.sampleVoices || {};
  let overhang = 0;
  let sectionEnd = 0;
  for (const section of artifact.sections) {
    const track = artifact.tracks[section.track];
    sectionEnd += section.bars * barSeconds(track.bpm ?? artifact.tempo);
    for (const event of track.steps) {
      const voice = event.voice ?? event.v;
      // Sample voices are laid out by the integer sample renderer, which sizes
      // its own plan from the assets; they do not ride this budget.
      if (Object.hasOwn(sampleVoices, voice)) continue;
      const tail = voiceTailSeconds(voice, event.dur, event.opts ?? event.o ?? {});
      overhang = Math.max(overhang, sectionEnd + tail - musicSeconds);
    }
  }
  return overhang > 0 ? overhang : 0;
}

/** Compile declarative events into a registerTrack step callback. */
export function compileTrackStep(track) {
  const events = track.steps.map((event) => {
    const baseOpts = event.opts ?? event.o ?? {};
    const opts = event.nudge !== undefined && baseOpts.nudge === undefined
      ? { ...baseOpts, nudge: event.nudge }
      : baseOpts;
    return {
      voice: event.voice ?? event.v,
      indices: event.i !== undefined ? (Array.isArray(event.i) ? event.i : [event.i]) : null,
      every: event.every ?? null,
      role: event.role,
      note: event.note,
      freq: event.freq,
      dur: event.dur,
      opts,
    };
  });

  return function step(index, time, state) {
    for (const event of events) {
      const hit = event.indices ? event.indices.includes(index) : index % event.every === 0;
      if (!hit) continue;
      const voice = event.role === undefined
        ? state.v[event.voice]
        : (...args) => state.play(event.role, event.voice, ...args);
      if (typeof voice !== 'function') throw new Error(`compiled voice "${event.voice}" is unavailable`);
      if (PERC.has(event.voice)) {
        voice(time, event.opts);
      } else if (AIR.has(event.voice)) {
        voice(time, event.dur, event.opts);
      } else {
        voice(time, event.freq ?? noteFreq(event.note), event.dur, event.opts);
      }
    }
  };
}
