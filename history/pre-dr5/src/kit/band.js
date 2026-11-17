// band.js — THE BAND KIT. A portable procedural WebAudio band: synthesised
// instruments, a bus architecture with a send reverb, and a lookahead step
// scheduler. Zero assets, zero fetches, zero dependencies (hard rule 2: all
// assets code-generated). Register-specific tuning belongs in presets or scores,
// never in this canonical kit.
//
// ============================================================================
// THE API (this header is the kit's documentation — other games adopt this file
// verbatim and write their own tracks module beside it)
// ============================================================================
//
// NOTE TO THE READER: these examples show only calls, never the ES module lines
// that would normally head them. scripts/build-singlefile.mjs discovers each
// module's dependencies with a plain regex that does not skip comments, so
// mentioning the ES keyword — or any quoted module path — in a comment above the
// real dependency list registers as a bogus extra dependency and breaks the
// single-file build. Pull createBand / noteFreq / chord out the usual way.
//
//   const band = createBand({
//     ctx, destination: someGainNode, seed: worldSeed,
//     performance: { // optional; omitted is exactly neutral
//       humanize: { timingMs: [-8, 8], velocity: [-0.05, 0.05], swing: 0.12 },
//       releaseTail: 0.4, // added to pad/drone note releases
//       voices: { pad: { releaseTail: 0.8 } }, // per-voice overrides
//     },
//   });
//
//   band.registerTrack('example', {
//     bpm: 40,          // a STEP is a sixteenth: stepSeconds = 60 / bpm / 4
//     len: 64,          // steps in one loop (16 steps = one bar)
//     vol: 0.8,         // this track's level on the music bus
//     step(i, t, s) {   // i = step within the loop, t = ctx time to schedule AT
//       if (i === 0) s.v.drone(t, noteFreq('D1'), 16, { vol: 0.10 });
//       if (i === 23) s.v.bell(t, noteFreq('A5'), 4, { vol: 0.07 });
//     },
//   });
//
//   band.setTrack('example');   // crossfades: old track's bus down, new one up
//   band.setTrack('example', { now: 12.5, fadeIn: 0.05 }); // optional clock override
//                              // for OfflineAudioContext (currentTime frozen until render)
//   band.start();              // drive the scheduler off a timer
//   band.setParams({ intensity: 0.7 });  // live params, no track restart
//
// `step(i, t, s)` receives a step context `s`:
//   s.v        the instrument voices (see below) — call them with an absolute
//              ctx time `t`; they build and free their own nodes
//   s.i        step within the loop (0..len-1)
//   s.n        absolute step count since the track started (never wraps —
//              key long-form drift off this)
//   s.bar      bar within the loop, i.e. (i / 16 | 0)
//   s.params   the live params object from setParams (intensity layers)
//   s.rand(k)  DETERMINISTIC [0,1) for this step, salted by k. Seeded off the
//              band's seed + n via prng.hash2 — never Math.random, so a seeded
//              world always drifts the same way.
//   s.play(role, voice, ...args) schedules a voice under one of the eight
//              doctrine roles. Declarative scores use this path automatically.
//   s.clock    authored mutation clocks: micro step, phrase pass, and the
//              environment/section pass supplied by setExecutionContext().
//
// VOICES (`band.voices`, or `s.v` inside a step). All take (t, freq, dur, opts)
// except air/kick/snare/hat. `dur` is seconds of sustain; the release tail runs
// past it. Every voice routes dry to the active track bus and wet to the shared
// send reverb, so a track change cannot bleed the old track's notes back in.
//   pad    (t, freq, dur, o)  detuned saw stack + swept lowpass — the harmonic bed
//   drone  (t, freq, dur, o)  sine + sub (+ optional detuned partner / glide) — the floor
//   bell   (t, freq, dur, o)  detuned sine partial stack — sparse events
//   pluck  (t, freq, dur, o)  triangle + fast filter decay — short figures
//   bass   (t, freq, dur, o)  saw + sub through a resonant lowpass — pulse/weight
//   lead   (t, freq, dur, o)  square/triangle + vibrato — melody
//   air    (t, dur, o)        filtered noise with a swept band — texture/breath
//   kick / snare / hat        (t, o) percussion voices
// Common opts: vol, wave, cut (filter Hz), sweep (cut multiplier by end), q,
// a/d/s/r (envelope, seconds), verb (send amount 0..1), det (detune cents),
// ratios (bell partials), glide (drone end freq), hp/bp (air band).
// Kit 1.7.1 additive opts (defaults unchanged — absent ≡ historical behaviour):
//   sub:0|false  pad/drone/bass — disable the hard-wired sub-octave oscillator
//   hp:<Hz>      drone only — optional high-pass before the lowpass (off by default)
//   nudge:<ms>   any voice — per-event timing offset applied at schedule time
//
// THE FX SUITE (kit 1.8.0). Off unless declared; declaring nothing builds the
// 1.7.1 graph exactly. Buses are declared once on the band, and each voice sends
// into them with an amount 0..1 named exactly the way `verb` already is:
//
//   const band = createBand({
//     ctx, seed,
//     fx: {
//       bpm: 96,                                  // beat-synced effects read this
//       reverb: 'hall',                           // room | hall | plate
//       delay: { preset: 'dotted', feedback: 0.4 },
//       chorus: 'lush',                           // subtle | lush
//       master: { chorus: { wet: 0.1 } },         // optional insert on the sum
//     },
//   });
//   s.v.bell(t, noteFreq('A5'), 4, { verb: 0.3, delay: 0.35, chorus: 0.2 });
//
// `verb` is the reverb send (unchanged name, now feeding the upgraded room when
// fx.reverb is declared); `delay` and `chorus` are the new sends. Each effect
// takes a preset name, an options object, or `{ preset, ...overrides }`.
//
// THE THEMATIC SET (kit 1.9.0). Three more effects on the same grain — declared
// in `fx`, sent to per-voice by an option named after the kind, available as a
// master insert. Declaring none of them builds the 1.8.0 graph exactly.
//
//   fx: {
//     bitcrush: 'chip',                       // gentle | chip | destroy
//     snesverb: { edl: 8, fir: 'lowpass' },   // cave | hall | slap | dry
//     tape: { preset: 'worn', hiss: 0 },      // studio | worn | ruined
//   }
//   s.v.lead(t, noteFreq('E4'), 1, { bitcrush: 0.6, snesverb: 0.3, tape: 0.4 });
//
//   bitcrush  bit-depth quantiser (exact: the step is 2/2^bits) plus a
//             zero-order-hold decimator at `rate` Hz (exact: a rectangular FIR,
//             so the response nulls at fs/N). It does NOT model sample-and-hold
//             aliasing — see buildFxBitcrush for why that cannot be done
//             portably here.
//   snesverb  the SNES DSP's echo: a short ring buffer whose FEEDBACK PATH runs
//             through the hardware's 8-tap FIR, which is what makes a SNES echo
//             sound like one. `edl` is the hardware's 16 ms delay step; `fir`
//             takes bypass | lowpass | bright or eight signed bytes of your own.
//   tape      wow and flutter (each an exact `depth * 2*pi*rate` of pitch
//             deviation), soft saturation, HF rolloff, and `hiss`.
//
//             THE HISS LAW: `hiss` is 0 in every preset and in the fallback, is
//             capped at FX_MAX_HISS, and builds no nodes at all when zero. A
//             declared tape effect over a silent track renders exactly zero
//             samples. Noise is something a score chooses, never a floor it
//             inherits.
//
// PROPOSALS (kit 1.9.0). Built and demoed, adopted by nobody — no score uses
// them until Ray rules. They cost nothing while undeclared, exactly like the
// rest of the suite:
//
//   spring    a spring tank: allpass dispersion (the boing) into a damped IR.
//   ringmod   four-quadrant ring modulation; the input becomes sidebands at
//             |f - carrier| and f + carrier with the carrier suppressed.
//
// SECTION BOUNDARIES (kit 1.9.0). `retireMode` chooses what happens to a track
// bus when the next section arrives. 'crossfade' (the default, and the 1.8.0
// behaviour) ramps it out over `fadeOut`, which cuts any note still sounding.
// 'tail' with a `retireHold` holds the bus at level first, so a section's last
// notes ring into the next one:
//
//   createBand({ ctx, seed, retireMode: 'tail', retireHold: 1.5 });
//
// DETERMINISM. The reverb impulse response and the noise buffer are filled from
// a seeded mulberry32, and s.rand is a seeded hash — so nothing in the audio
// path calls Math.random. Same seed, same score.
//
// HEADLESS SAFETY. Nothing at module-load time touches `window`. createBand needs a
// real AudioContext; callers that may not have one guard the call (see
// audio.js). tick(now) is callable by hand, which is how the tests drive the
// scheduler without timers or a browser.

import { mulberry32, hash2 } from './prng.js';

// ---------------------------------------------------------------------------
// note names -> frequency. 'D1', 'Bb2', 'F#4'. A number passes straight through.
// ---------------------------------------------------------------------------
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteFreq(name) {
  if (typeof name === 'number') {
    if (Number.isFinite(name) && name > 0) return name;
    throw new TypeError(`noteFreq: expected a positive finite frequency, got ${name}`);
  }
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(String(name));
  if (!m) throw new TypeError(`noteFreq: invalid note name "${name}"`);
  const s = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const oct = parseInt(m[3], 10);
  return 440 * Math.pow(2, (s - 9) / 12 + (oct - 4));
}

/** Chord helper: note names -> frequencies. */
export function chord(names) { return names.map(noteFreq); }

// ---------------------------------------------------------------------------
// SAMPLER CORE (kit 1.7.0) — pitched multisample playback.
//
// This lives in the kit, not in the Node-side custody modules, because an
// embedded single-file port needs the same arithmetic to play a sampler voice
// as the offline renderer used to certify it.
//
// DETERMINISM LAW. House Band renders must be byte-identical across runs and
// platforms. IEEE-754 `+ - * /` are correctly rounded and therefore portable;
// `Math.pow` is implementation defined and is NOT. So every value on the
// sampler's audio path is an integer or an exactly-representable ratio, and
// the twelve semitone ratios are hardcoded Q16 constants rather than computed
// from `Math.pow(2, n/12)` at load time. Ratio 11 lands 0.006 from a rounding
// boundary — close enough that "it would probably round the same everywhere"
// is not an argument worth making.
// ---------------------------------------------------------------------------

/** Fixed-point scale for sampler rates, gains, and envelope ramps. */
export const SAMPLER_Q16 = 65536;
const SAMPLER_Q32 = SAMPLER_Q16 * SAMPLER_Q16;

/** round(65536 * 2^(n/12)) for n = 0..11. Verified against the ideal in test. */
export const SEMITONE_RATIO_Q16 = Object.freeze([
  65536, 69433, 73562, 77936, 82570, 87480,
  92682, 98193, 104032, 110218, 116772, 123715,
]);

export const MIDI_MIN = 0;
export const MIDI_MAX = 127;
/** Playback beyond +/- 4 octaves from a zone root is a pack-authoring error. */
export const SAMPLER_MAX_SEMITONES = 48;
/** Largest gain the integer mixer can carry without leaving exact-integer range. */
export const SAMPLER_MAX_GAIN_Q16 = 1 << 21;

const NOTE_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Note name -> MIDI number. Same grammar as noteFreq; null when unparsable. */
export function noteToMidi(name) {
  if (typeof name === 'number') return Number.isInteger(name) && name >= MIDI_MIN && name <= MIDI_MAX ? name : null;
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(String(name));
  if (!m) return null;
  const step = NOTE_SEMITONES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const midi = 12 * (parseInt(m[3], 10) + 1) + step;
  return midi >= MIDI_MIN && midi <= MIDI_MAX ? midi : null;
}

/**
 * MIDI -> Hz using the integer ratio table.
 * Only `*` and `/` by a power of two, so every engine agrees bit for bit.
 */
export function midiToFrequency(midi) {
  const offset = midi - 69;
  const octave = Math.floor(offset / 12);
  const remainder = offset - octave * 12;
  const base = (440 * SEMITONE_RATIO_Q16[remainder]) / SAMPLER_Q16;
  if (octave >= 0) return base * (1 << octave);
  return base / (1 << -octave);
}

/** Nearest MIDI note to a frequency, by exact comparison against the table. */
export function nearestMidi(frequencyHz) {
  if (!(frequencyHz > 0)) return null;
  let best = null;
  let bestDistance = Infinity;
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
    const distance = Math.abs(midiToFrequency(midi) - frequencyHz);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = midi;
    }
  }
  return best;
}

/**
 * Playback rate in Q16 for a note sounded from a sample rooted at rootMidi.
 * Integer path: table lookup for the semitone, exact power-of-two for octaves.
 */
export function samplerRateQ16(noteMidi, rootMidi) {
  if (!Number.isInteger(noteMidi) || !Number.isInteger(rootMidi)) {
    throw new TypeError('samplerRateQ16: note and root must be integer MIDI numbers');
  }
  const semitones = noteMidi - rootMidi;
  if (semitones < -SAMPLER_MAX_SEMITONES || semitones > SAMPLER_MAX_SEMITONES) {
    throw new RangeError(`samplerRateQ16: ${semitones} semitones exceeds the +/-${SAMPLER_MAX_SEMITONES} limit`);
  }
  const octave = Math.floor(semitones / 12);
  const remainder = semitones - octave * 12;
  const base = SEMITONE_RATIO_Q16[remainder];
  if (octave >= 0) return base * (1 << octave);
  return Math.round(base / (1 << -octave));
}

/**
 * Playback rate in Q16 for an explicit frequency against a rooted sample.
 * `/` and `Math.round` are exact, so this stays portable.
 */
export function samplerRateQ16FromFrequency(frequencyHz, rootMidi) {
  const rootHz = midiToFrequency(rootMidi);
  const rate = Math.round((frequencyHz / rootHz) * SAMPLER_Q16);
  if (rate < 1) throw new RangeError('samplerRateQ16FromFrequency: rate underflows Q16');
  const limit = SEMITONE_RATIO_Q16[0] * (1 << (SAMPLER_MAX_SEMITONES / 12));
  if (rate > limit) throw new RangeError('samplerRateQ16FromFrequency: rate exceeds the +4 octave limit');
  return rate;
}

/**
 * Pick the zone covering a MIDI note. Zones may overlap; the nearest root
 * wins, then the lower root, then the lexically smaller asset id — so the
 * choice never depends on array order.
 */
export function selectSamplerZone(zones, midi) {
  let best = null;
  for (const zone of zones) {
    if (midi < zone.lo || midi > zone.hi) continue;
    if (best === null) { best = zone; continue; }
    const distance = Math.abs(zone.rootNote - midi);
    const bestDistance = Math.abs(best.rootNote - midi);
    if (distance < bestDistance) { best = zone; continue; }
    if (distance > bestDistance) continue;
    if (zone.rootNote < best.rootNote) { best = zone; continue; }
    if (zone.rootNote > best.rootNote) continue;
    if (zone.assetId < best.assetId) best = zone;
  }
  return best;
}

function clampInt32Sampler(value) {
  if (value > 0x7fffffff) return 0x7fffffff;
  if (value < -0x80000000) return -0x80000000;
  return value;
}

function roundSignedSampler(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Mix one sampler (or one-shot) voice into an Int32Array bus.
 *
 * Every operation is integer arithmetic on values well inside 2^53, so the
 * result is byte-identical everywhere. At rateQ16 === SAMPLER_Q16 with no gate
 * this reduces exactly to the 1:1 one-shot copy the drum path shipped in
 * pack format 1.0.0 — the interpolation term is multiplied by a zero fraction
 * and the rounding is the same single division.
 *
 * @param {Int32Array} target output bus
 * @param {number} startFrame integer frame where the voice starts
 * @param {object} opts
 * @param {Int16Array} opts.frames source PCM
 * @param {number} opts.rateQ16 Q16 playback rate (65536 = unshifted)
 * @param {number} opts.gainQ16 Q16 gain
 * @param {number|null} opts.gateFrames output frames held at full level, or null for the whole sample
 * @param {number} opts.releaseFrames linear fade-out frames after the gate
 * @param {number} opts.fadeFrames section fade-in length, 0 for none
 * @param {number} opts.fadeOriginFrame absolute frame the section fade starts from
 * @returns {number} output frames written
 */
export function mixSamplerVoiceQ16(target, startFrame, opts) {
  const { frames, rateQ16, gainQ16 } = opts;
  const gateFrames = opts.gateFrames ?? null;
  const releaseFrames = opts.releaseFrames ?? 0;
  const fadeFrames = opts.fadeFrames ?? 0;
  const fadeOriginFrame = opts.fadeOriginFrame ?? 0;
  if (!Number.isInteger(rateQ16) || rateQ16 < 1) throw new RangeError('mixSamplerVoiceQ16: rateQ16 must be a positive integer');
  if (!Number.isInteger(gainQ16) || Math.abs(gainQ16) > SAMPLER_MAX_GAIN_Q16) {
    throw new RangeError('mixSamplerVoiceQ16: gainQ16 must be an integer within the exact-mix range');
  }
  const total = gateFrames === null ? Infinity : gateFrames + releaseFrames;

  let intPos = 0;
  let fracQ16 = 0;
  let produced = 0;
  let out = startFrame;
  while (intPos < frames.length && produced < total && out < target.length) {
    const s0 = frames[intPos];
    const s1 = intPos + 1 < frames.length ? frames[intPos + 1] : 0;
    const interpolatedQ16 = s0 * SAMPLER_Q16 + (s1 - s0) * fracQ16;
    let value = roundSignedSampler((interpolatedQ16 * gainQ16) / SAMPLER_Q32);
    if (gateFrames !== null && produced >= gateFrames) {
      // +1 so the ramp lands on exact zero at the final release frame; a fade
      // that stops one step short leaves a small step discontinuity, which is
      // the class of defect kit 1.6.0 existed to remove.
      const releaseQ16 = releaseFrames === 0
        ? 0
        : SAMPLER_Q16 - Math.floor(((produced - gateFrames + 1) * SAMPLER_Q16) / releaseFrames);
      value = releaseQ16 <= 0 ? 0 : roundSignedSampler((value * releaseQ16) / SAMPLER_Q16);
    }
    if (fadeFrames > 0) {
      const fadePosition = out - fadeOriginFrame;
      const fadeQ16 = Math.min(SAMPLER_Q16, Math.max(0, Math.floor((fadePosition * SAMPLER_Q16) / fadeFrames)));
      value = roundSignedSampler((value * fadeQ16) / SAMPLER_Q16);
    }
    target[out] = clampInt32Sampler(target[out] + value);
    fracQ16 += rateQ16;
    const advance = Math.floor(fracQ16 / SAMPLER_Q16);
    intPos += advance;
    fracQ16 -= advance * SAMPLER_Q16;
    produced += 1;
    out += 1;
  }
  return produced;
}

/** Output frames a sampler voice will occupy, for plan-length bookkeeping. */
export function samplerVoiceFrameCount(sourceFrames, rateQ16, gateFrames = null, releaseFrames = 0) {
  const fromSource = Math.ceil((sourceFrames * SAMPLER_Q16) / rateQ16);
  if (gateFrames === null) return fromSource;
  return Math.min(fromSource, gateFrames + releaseFrames);
}

// A tiny positive floor — exponential ramps cannot reach or cross zero.
const EPS = 0.0001;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const VOICE_ROLES = Object.freeze([
  'bass-pedal',
  'pulse-percussion',
  'inner-rhythm',
  'lead',
  'countervoice',
  'harmonic-color',
  'environment-transient',
  'reserve',
]);
export const REGISTER_CLASSES = Object.freeze(['dread', 'calm', 'joy']);
const VOICE_ROLE_SET = new Set(VOICE_ROLES);
const REGISTER_CLASS_SET = new Set(REGISTER_CLASSES);

// Register classes change ensemble hierarchy, never musical vocabulary. These
// narrow fixed offsets are the DR3 envelope-as-performance postures expressed
// at scheduler level: exact machinery against remote dread layers, staggered
// calm arrivals, and anticipatory joyful bass. Notes, instruments, harmony,
// mutation content, and register placement remain authored by each score.
const REGISTER_ROLE_ONSET_MS = Object.freeze({
  dread: Object.freeze({
    'bass-pedal': 0,
    'pulse-percussion': 0,
    'inner-rhythm': 0,
    lead: 5,
    countervoice: 10,
    'harmonic-color': 8,
    'environment-transient': 15,
    reserve: 0,
  }),
  calm: Object.freeze({
    'bass-pedal': 5,
    'pulse-percussion': 0,
    'inner-rhythm': 6,
    lead: 10,
    countervoice: 15,
    'harmonic-color': 8,
    'environment-transient': 12,
    reserve: 0,
  }),
  joy: Object.freeze({
    'bass-pedal': -10,
    'pulse-percussion': 0,
    'inner-rhythm': 5,
    lead: 0,
    countervoice: 8,
    'harmonic-color': 6,
    'environment-transient': 10,
    reserve: 0,
  }),
});

/** Pure register-doctrine onset posture for a role-tagged event. */
export function doctrineAdjustment(registerClass, role) {
  if (registerClass === undefined || registerClass === null) {
    return Object.freeze({ timeSeconds: 0 });
  }
  if (!REGISTER_CLASS_SET.has(registerClass)) {
    throw new TypeError(`registerClass: must be one of ${REGISTER_CLASSES.join(', ')}`);
  }
  if (!VOICE_ROLE_SET.has(role)) {
    throw new TypeError(`role: must be one of ${VOICE_ROLES.join(', ')}`);
  }
  return Object.freeze({ timeSeconds: REGISTER_ROLE_ONSET_MS[registerClass][role] / 1000 });
}
const PERFORMANCE_VOICE_NAMES = Object.freeze(['pad', 'drone', 'bell', 'pluck', 'bass', 'lead', 'air', 'kick', 'snare', 'hat', 'chipPulse', 'chipTriangle', 'chipNoise']);
const PERFORMANCE_VOICE_INDEX = Object.freeze(Object.fromEntries(PERFORMANCE_VOICE_NAMES.map((name, index) => [name, index])));
const VOICE_OPTION_INDEX = Object.freeze({ pad: 3, drone: 3, bell: 3, pluck: 3, bass: 3, lead: 3, air: 2, kick: 1, snare: 1, hat: 1, chipPulse: 3, chipTriangle: 3, chipNoise: 3 });

/** Kit 1.7.1: hard-wired sub-octave stays ON unless explicitly opted out. */
export function voiceSubEnabled(o = {}) {
  if (o.sub === false || o.sub === 0) return false;
  return true;
}
const RELEASE_VOICES = new Set(['pad', 'drone']);
const normalizedPerformanceConfigs = new WeakSet();

function normalizeRange(value, name) {
  if (value === undefined) return Object.freeze([0, 0]);
  if (!Array.isArray(value) || value.length !== 2
    || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
    || value[0] > value[1]) {
    throw new TypeError(`${name}: expected [min, max] finite numbers with min <= max`);
  }
  return Object.freeze([value[0], value[1]]);
}

function normalizeHumanize(value = {}, name = 'performance.humanize') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name}: expected an object`);
  for (const key of Object.keys(value)) {
    if (!['timingMs', 'velocity', 'swing'].includes(key)) throw new TypeError(`${name}.${key}: unknown field`);
  }
  const timingMs = normalizeRange(value.timingMs, `${name}.timingMs`);
  const velocity = normalizeRange(value.velocity, `${name}.velocity`);
  if (timingMs[0] < -50 || timingMs[1] > 50) throw new RangeError(`${name}.timingMs: values must be between -50 and 50`);
  if (velocity[0] < -1 || velocity[1] > 1) throw new RangeError(`${name}.velocity: values must be between -1 and 1`);
  const swing = value.swing ?? 0;
  if (typeof swing !== 'number' || !Number.isFinite(swing) || swing < 0 || swing > 1) {
    throw new RangeError(`${name}.swing: must be between 0 and 1`);
  }
  return Object.freeze({ timingMs, velocity, swing });
}

/** Validate and normalize the register-neutral performance tool configuration. */
export function normalizePerformance(performance) {
  if (performance === undefined) return null;
  if (performance && normalizedPerformanceConfigs.has(performance)) return performance;
  if (performance === null || typeof performance !== 'object' || Array.isArray(performance)) {
    throw new TypeError('performance: expected an object');
  }
  for (const key of Object.keys(performance)) {
    if (!['humanize', 'releaseTail', 'voices'].includes(key)) throw new TypeError(`performance.${key}: unknown field`);
  }
  const releaseTail = performance.releaseTail ?? 0;
  if (typeof releaseTail !== 'number' || !Number.isFinite(releaseTail) || releaseTail < 0 || releaseTail > 30) {
    throw new RangeError('performance.releaseTail: must be between 0 and 30 seconds');
  }
  const humanize = normalizeHumanize(performance.humanize);
  const givenVoices = performance.voices ?? {};
  if (givenVoices === null || typeof givenVoices !== 'object' || Array.isArray(givenVoices)) {
    throw new TypeError('performance.voices: expected an object');
  }
  const voices = {};
  for (const [voice, value] of Object.entries(givenVoices)) {
    if (!PERFORMANCE_VOICE_NAMES.includes(voice)) throw new TypeError(`performance.voices.${voice}: unknown voice`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`performance.voices.${voice}: expected an object`);
    for (const key of Object.keys(value)) {
      if (!['humanize', 'releaseTail'].includes(key)) throw new TypeError(`performance.voices.${voice}.${key}: unknown field`);
    }
    if (value.releaseTail !== undefined && !RELEASE_VOICES.has(voice)) {
      throw new TypeError(`performance.voices.${voice}.releaseTail: release tails are supported only for pad and drone`);
    }
    const voiceRelease = value.releaseTail ?? releaseTail;
    if (typeof voiceRelease !== 'number' || !Number.isFinite(voiceRelease) || voiceRelease < 0 || voiceRelease > 30) {
      throw new RangeError(`performance.voices.${voice}.releaseTail: must be between 0 and 30 seconds`);
    }
    let ownHumanize = humanize;
    if (value.humanize !== undefined) {
      if (value.humanize === null || typeof value.humanize !== 'object' || Array.isArray(value.humanize)) {
        throw new TypeError(`performance.voices.${voice}.humanize: expected an object`);
      }
      ownHumanize = normalizeHumanize({
        timingMs: value.humanize.timingMs ?? humanize.timingMs,
        velocity: value.humanize.velocity ?? humanize.velocity,
        swing: value.humanize.swing ?? humanize.swing,
      }, `performance.voices.${voice}.humanize`);
    }
    voices[voice] = Object.freeze({ humanize: ownHumanize, releaseTail: voiceRelease });
  }
  const normalized = Object.freeze({ humanize, releaseTail, voices: Object.freeze(voices) });
  normalizedPerformanceConfigs.add(normalized);
  return normalized;
}

function performanceForVoice(performance, voice) {
  return performance?.voices[voice] ?? Object.freeze({
    humanize: performance?.humanize ?? Object.freeze({ timingMs: Object.freeze([0, 0]), velocity: Object.freeze([0, 0]), swing: 0 }),
    releaseTail: performance?.releaseTail ?? 0,
  });
}

/** Largest additional release requested by a score, used to retain render tails. */
export function performanceReleaseTail(performance) {
  const normalized = normalizePerformance(performance);
  if (!normalized) return 0;
  return Math.max(...[...RELEASE_VOICES].map((voice) => performanceForVoice(normalized, voice).releaseTail));
}

/** Pure deterministic adjustment shared by synth scheduling and sample custody. */
export function performanceAdjustment(performance, { seed, absoluteStep, stepIndex, stepSeconds, voice, call = 0 }) {
  const normalized = normalizePerformance(performance);
  const resolved = performanceForVoice(normalized, voice);
  const { timingMs, velocity, swing } = resolved.humanize;
  const lane = (PERFORMANCE_VOICE_INDEX[voice] ?? PERFORMANCE_VOICE_NAMES.length) * 0x10000 + call;
  const timingDraw = hash2(absoluteStep, lane * 2 + 0x1000, (seed >>> 0) || 1);
  const velocityDraw = hash2(absoluteStep, lane * 2 + 0x1001, (seed >>> 0) || 1);
  const jitterSeconds = (timingMs[0] + (timingMs[1] - timingMs[0]) * timingDraw) / 1000;
  const swingSeconds = (stepIndex & 1) ? swing * stepSeconds * 0.5 : 0;
  return Object.freeze({
    timeSeconds: jitterSeconds + swingSeconds,
    velocity: velocity[0] + (velocity[1] - velocity[0]) * velocityDraw,
    releaseTail: RELEASE_VOICES.has(voice) ? resolved.releaseTail : 0,
  });
}

/**
 * Conservative register-neutral tuning. Register presets may override any of
 * these values through createBand({ ...band, voiceDefaults: voices }).
 */
export const NEUTRAL_DEFAULTS = Object.freeze({
  band: Object.freeze({
    gain: 0.5,
    reverb: Object.freeze({ seconds: 0.7, decay: 1.4 }),
    reverbReturnGain: 0.18,
    lookahead: 0.22,
    tickMs: 25,
    fadeOut: 0.08,
    fadeIn: 0.08,
    retireTail: 0.75,
  }),
  voices: Object.freeze({
    pad: Object.freeze({ verb: 0.12, cut: 1600, sweep: 1.1, q: 0.7, det: 3, vol: 0.08, wave: 'triangle', a: 0.04, d: 0.12, s: 0.65, r: 0.25 }),
    drone: Object.freeze({ verb: 0.08, cut: 800, q: 0.7, vol: 0.08, beat: 0, wave: 'sine', a: 0.03, d: 0.15, s: 0.75, r: 0.3 }),
    bell: Object.freeze({ verb: 0.2, ratios: Object.freeze([1, 2, 3, 4]), levels: Object.freeze([1, 0.35, 0.18, 0.08]), vol: 0.06, a: 0.004, dScale: 0.5, s: 0.01, r: 0.35, holdScale: 0.25 }),
    pluck: Object.freeze({ verb: 0.12, cut: 2800, wave: 'triangle', a: 0.003, dScale: 0.45, s: 0.05, r: 0.15, vol: 0.06, holdScale: 0.4 }),
    bass: Object.freeze({ verb: 0.05, cut: 600, q: 1.2, vol: 0.1, wave: 'sawtooth', a: 0.01, dScale: 0.3, s: 0.45, r: 0.12, holdScale: 0.75 }),
    lead: Object.freeze({ verb: 0.1, cut: 2400, q: 1.2, wave: 'triangle', vibrato: 4.5, vibratoDepth: 0.003, grace: 0, graceTime: 0.05, a: 0.03, d: 0.15, s: 0.65, r: 0.2, vol: 0.07 }),
    air: Object.freeze({ verb: 0.1, type: 'bandpass', bp: 1200, sweep: 1.2, q: 0.8, attackScale: 0.08, decayScale: 0.15, s: 0.5, r: 0.25, vol: 0.025 }),
    kick: Object.freeze({ f0: 130, f1: 40, dur: 0.24, vol: 0.3 }),
    snare: Object.freeze({ bp: 1900, q: 0.8, dur: 0.15, vol: 0.11, verb: 0.12 }),
    hat: Object.freeze({ hp: 7000, dur: 0.05, vol: 0.04, verb: 0.08 }),
    chipPulse: Object.freeze({ duty: 0.5, dutySweep: null, vol: 0.08, cut: 8000, q: 0.7, a: 0.005, d: 0.08, s: 0.6, r: 0.12, vibrato: 5.5, vibratoDepth: 0.004, vibratoDelay: 0.02, ticksPerRow: 6, tickDuration: 0.02, verb: 0.05 }),
    chipTriangle: Object.freeze({ vol: 0.09, cut: 7000, q: 0.7, a: 0.005, d: 0.08, s: 0.65, r: 0.12, vibrato: 5.5, vibratoDepth: 0.004, vibratoDelay: 0.02, ticksPerRow: 6, tickDuration: 0.02, verb: 0.05 }),
    chipNoise: Object.freeze({ mode: 'white', vol: 0.08, cut: 8000, q: 0.7, a: 0.005, d: 0.1, s: 0.3, r: 0.08, f0: null, f1: null, ticksPerRow: 6, tickDuration: 0.02, verb: 0.05 }),
  }),
});

// ---------------------------------------------------------------------------
// HOW LONG A NOTE LASTS (kit 1.9.0)
//
// Every sustained voice ends at `env()`'s return value: (holdEnd - t) + r, where
// holdEnd = t + max(a + d, hold). What differs per voice is which options supply
// `hold` and `d` — bell/pluck/bass scale both off `dur`, air scales its attack
// and decay off `dur`, percussion ignores the note length entirely.
//
// This table is the SINGLE SOURCE OF TRUTH for that arithmetic, so the renderer
// can reserve a buffer long enough for the score's real tail instead of a fixed
// constant. It is pure: no context, no nodes, no clock.
// ---------------------------------------------------------------------------

/** Per-voice audible tail past the note's start, in seconds. */
const VOICE_TAIL = Object.freeze({
  pad: (dur, o) => Math.max(o.a + o.d, dur) + o.r,
  drone: (dur, o) => Math.max(o.a + o.d, dur) + o.r,
  lead: (dur, o) => Math.max(o.a + o.d, dur) + o.r,
  bell: (dur, o) => Math.max(o.a + dur * o.dScale, dur * o.holdScale) + o.r,
  pluck: (dur, o) => Math.max(o.a + dur * o.dScale, dur * o.holdScale) + o.r,
  bass: (dur, o) => Math.max(o.a + dur * o.dScale, dur * o.holdScale) + o.r,
  air: (dur, o) => Math.max((o.a === undefined ? dur * o.attackScale : o.a) + dur * o.decayScale, dur) + o.r,
  kick: (dur, o) => o.dur,
  snare: (dur, o) => o.dur,
  hat: (dur, o) => o.dur,
  // Chip voices stop at `stopTime` (kit 1.9.0: the gate now holds to it).
  chipPulse: (dur, o) => dur + Math.max(o.r, 0.05),
  chipTriangle: (dur, o) => dur + Math.max(o.r, 0.05),
  chipNoise: (dur, o) => dur + Math.max(o.r, 0.05),
});

/**
 * Seconds from a note's onset to the end of its audible tail.
 * @param {string} voice voice name
 * @param {number} dur    the `dur` argument the score passes (ignored by percussion)
 * @param {object} [opts] the note's options, merged over the voice defaults
 */
export function voiceTailSeconds(voice, dur = 0, opts = {}) {
  const compute = VOICE_TAIL[voice];
  if (!compute) return 0;
  const resolved = { ...NEUTRAL_DEFAULTS.voices[voice], ...opts };
  const length = Number.isFinite(dur) && dur > 0 ? dur : 0;
  const tail = compute(length, resolved);
  return Number.isFinite(tail) && tail > 0 ? tail : 0;
}

// ---------------------------------------------------------------------------
// THE FX SUITE (kit 1.8.0) — reverb / delay / chorus, offline-deterministic.
//
// DEFAULTS ARE OFF. With no `fx` declared, createBand builds exactly the graph
// it built in 1.7.1 (the legacy send reverb and nothing else), so every existing
// render stays byte-identical. Everything below is reached only through `fx`.
//
// DETERMINISM. Reverb impulse responses are synthesised from the band's seeded
// mulberry32 — never random at render time — and damped by an arithmetic
// one-pole whose cutoff falls across the tail. Chorus modulation is an
// OscillatorNode LFO started at time 0, which is a fixed function of the pinned
// engine, exactly like every other oscillator in the kit. Delay feedback is a
// plain node graph. Nothing here reads a clock, and nothing calls Math.random.
//
// EXTENSIBILITY. Effects are declared by name in FX_KINDS and built through
// FX_BUILDERS; each kind names the per-voice send option it reads in
// FX_VOICE_SEND. A later phaser/flanger/width lands as one more entry in those
// three tables plus a preset row — no signature changes, no API break.
// ---------------------------------------------------------------------------

/** Effect kinds the suite can build, in bus order. */
export const FX_KINDS = Object.freeze([
  'reverb', 'delay', 'chorus',
  // kit 1.9.0 — the thematic set
  'bitcrush', 'snesverb', 'tape',
  // kit 1.9.0 — PROPOSALS (built, demoed, adopted by nobody; see the header)
  'spring', 'ringmod',
]);

/**
 * Per-voice send option each effect reads. `reverb` keeps the historical `verb`
 * name so scores written before 1.8.0 send into the upgraded reverb unchanged.
 */
export const FX_VOICE_SEND = Object.freeze({
  reverb: 'verb',
  delay: 'delay',
  chorus: 'chorus',
  bitcrush: 'bitcrush',
  snesverb: 'snesverb',
  tape: 'tape',
  spring: 'spring',
  ringmod: 'ringmod',
});

/** Reverb characters. seconds = IR length; damping = tail HF cutoff at onset. */
export const REVERB_PRESETS = Object.freeze({
  room: Object.freeze({ seconds: 0.85, decay: 2.4, damping: 4200, preDelay: 0.006, wet: 0.20 }),
  hall: Object.freeze({ seconds: 2.60, decay: 1.6, damping: 2600, preDelay: 0.028, wet: 0.28 }),
  plate: Object.freeze({ seconds: 1.70, decay: 1.1, damping: 7000, preDelay: 0.004, wet: 0.24 }),
});

/** Delay characters. `sync` names a beat fraction; `time` is the raw override. */
export const DELAY_PRESETS = Object.freeze({
  slap: Object.freeze({ sync: null, time: 0.11, feedback: 0.16, damping: 4500, wet: 0.18, pingPong: false }),
  eighth: Object.freeze({ sync: '1/8', time: null, feedback: 0.38, damping: 3800, wet: 0.22, pingPong: false }),
  dotted: Object.freeze({ sync: '1/8.', time: null, feedback: 0.42, damping: 3200, wet: 0.24, pingPong: true }),
  quarter: Object.freeze({ sync: '1/4', time: null, feedback: 0.34, damping: 3000, wet: 0.22, pingPong: false }),
});

/** Chorus characters. depth/spread are seconds of delay-line modulation. */
export const CHORUS_PRESETS = Object.freeze({
  subtle: Object.freeze({ voices: 2, rate: 0.45, depth: 0.0022, spread: 0.010, wet: 0.18, width: 0.6 }),
  lush: Object.freeze({ voices: 4, rate: 0.28, depth: 0.0055, spread: 0.014, wet: 0.32, width: 1.0 }),
});

/** Beat fractions -> multiples of one beat (a quarter note = 60/bpm seconds). */
export const DELAY_SYNC_FRACTIONS = Object.freeze({
  '1/2': 2,
  '1/4.': 1.5,
  '1/4': 1,
  '1/4t': 2 / 3,
  '1/8.': 0.75,
  '1/8': 0.5,
  '1/8t': 1 / 3,
  '1/16': 0.25,
});

/** Longest delay line the suite will allocate, seconds. */
export const FX_MAX_DELAY_SECONDS = 4;
/** Feedback ceiling — above this a delay line never decays inside a render. */
export const FX_MAX_FEEDBACK = 0.92;
/** How many chorus voices one bus may run. */
export const FX_MAX_CHORUS_VOICES = 6;

// ---------------------------------------------------------------------------
// THE THEMATIC SET (kit 1.9.0) — bitcrush / snesverb / tape, plus two proposals.
//
// Same three tables as 1.8.0, same send-amount grammar, same defaults-are-off
// law: declaring nothing builds the 1.7.1 graph. Nothing below reads a clock or
// calls Math.random; every noise source is a seeded mulberry32 buffer.
// ---------------------------------------------------------------------------

/** Bit depths the crusher will quantise to. Below 1 bit there is no signal. */
export const FX_MIN_BITS = 1;
export const FX_MAX_BITS = 16;
/** Hold factors for the decimator: output holds each input sample N frames. */
export const FX_MAX_HOLD = 256;
/** Hiss ceiling. The HISS LAW: a noise bed is a choice, never a floor. */
export const FX_MAX_HISS = 0.05;
/** Tape saturation drive ceiling. */
export const FX_MAX_DRIVE = 24;
/** Allpass stages a spring tank may cascade. */
export const FX_MAX_SPRING_STAGES = 12;

/**
 * Bitcrush characters. `bits` is the quantiser's depth; `rate` is the decimator's
 * target sample rate in Hz (the hold length is round(sampleRate / rate)).
 */
export const BITCRUSH_PRESETS = Object.freeze({
  gentle: Object.freeze({ bits: 10, rate: 16000, wet: 0.5 }),
  chip: Object.freeze({ bits: 6, rate: 8000, wet: 0.7 }),
  destroy: Object.freeze({ bits: 3, rate: 3500, wet: 0.9 }),
});

/**
 * SNES DSP echo characters. `edl` is the hardware's echo-delay-length step:
 * one EDL unit is 16 ms of ring buffer, so edl 4 is a 64 ms echo.
 */
export const SNESVERB_PRESETS = Object.freeze({
  cave: Object.freeze({ edl: 8, feedback: 0.55, fir: 'lowpass', wet: 0.30, mono: false }),
  hall: Object.freeze({ edl: 12, feedback: 0.62, fir: 'lowpass', wet: 0.34, mono: false }),
  slap: Object.freeze({ edl: 3, feedback: 0.28, fir: 'bright', wet: 0.24, mono: false }),
  dry: Object.freeze({ edl: 2, feedback: 0.15, fir: 'bypass', wet: 0.18, mono: true }),
});

/**
 * The 8-tap FIR the SNES DSP runs over its echo buffer — the filter that makes
 * a SNES echo sound like a SNES echo rather than a plain delay. Taps are the
 * hardware's signed bytes; the sum is divided by 128, so a set summing to 128
 * has unity gain at DC.
 *
 * `bypass` is the hardware power-on default (a single 0x7F tap = flat).
 * `lowpass` is the smoothing set games reach for; it sums to 128 at DC and
 * folds to -6/128 at Nyquist, which is the ~24 dB of HF loss per pass that
 * gives the classic muffled repeat. `bright` inverts that emphasis.
 */
export const SNES_FIR_PRESETS = Object.freeze({
  bypass: Object.freeze([127, 0, 0, 0, 0, 0, 0, 0]),
  lowpass: Object.freeze([12, 33, 43, 43, 19, -2, -13, -7]),
  bright: Object.freeze([127, -32, 16, -8, 4, -2, 1, 0]),
});

/**
 * Measured |H(f)| of the three sets, taps/128, at 44.1 kHz (computed from the
 * coefficients above; the snesverb tests assert the ordering these imply):
 *
 *            100Hz   1kHz   4kHz   8kHz  12kHz  Nyquist
 *   bypass   0.992  0.992  0.992  0.992  0.992  0.992
 *   lowpass  1.000  1.017  1.058  0.480  0.041  0.047
 *   bright   0.828  0.828  0.832  0.866  0.940  1.484
 *
 * Eight taps at 44.1 kHz span 181 us, so the response can only bend slowly and
 * concentrates its shaping near Nyquist — which is precisely why the hardware's
 * 32 kHz echo has the character it does. The axis that matters is HF RELATIVE TO
 * LF within a set: lowpass falls away (0.04x at 12 kHz), bypass is flat (1.0x),
 * bright rises (1.13x at 12 kHz, 1.79x at Nyquist). Note bright's DC gain is
 * 106/128, so it also loses ~1.7 dB of level per pass compared with bypass.
 */

/** One EDL step on the SNES DSP is 16 ms of echo buffer. */
export const SNES_EDL_STEP_SECONDS = 0.016;
/** The hardware's EDL field is four bits. */
export const SNES_MAX_EDL = 15;
/** The FIR is eight taps, always. */
export const SNES_FIR_TAPS = 8;
/** Hardware divides the FIR accumulator by 128. */
export const SNES_FIR_SCALE = 128;

/**
 * Tape characters. wow is the slow pitch drift, flutter the fast one; both are
 * a modulated delay line, so each contributes a peak pitch deviation of exactly
 * `depth * 2*pi*rate` and the two are independently measurable.
 *
 * `hiss` is 0 in every preset. See the HISS LAW note on normalizeTapeFx.
 */
export const TAPE_PRESETS = Object.freeze({
  studio: Object.freeze({
    wowRate: 0.7, wowDepth: 0.0008, flutterRate: 7.5, flutterDepth: 0.00012,
    drive: 2.0, rolloff: 12000, hiss: 0, wet: 1,
  }),
  worn: Object.freeze({
    wowRate: 0.55, wowDepth: 0.0032, flutterRate: 9.0, flutterDepth: 0.00045,
    drive: 5.0, rolloff: 6500, hiss: 0, wet: 1,
  }),
  ruined: Object.freeze({
    wowRate: 0.42, wowDepth: 0.0090, flutterRate: 11.0, flutterDepth: 0.0012,
    drive: 9.0, rolloff: 3800, hiss: 0, wet: 1,
  }),
});

/**
 * Spring-tank characters (PROPOSAL). `stages` allpass sections make the boing;
 * `seconds`/`decay` are the tank's ring.
 *
 * NO FEEDBACK PARAMETER, deliberately. A spring wants a bounce, and the obvious
 * way to get one is a feedback loop around the dispersion chain — but that mutes
 * the whole unit here. node-web-audio-api silences a cycle that ENCLOSES the
 * allpass sections' own internal cycles (probed 2026-08-30: chain -> convolver
 * renders at energy 1.8e2; the identical graph with any outer feedback gain, with
 * or without the convolver inside the loop, renders at exactly 0.0). The kit's
 * delay effect is unaffected because its cycle is flat, not nested. Rather than
 * ship a parameter that silently kills the effect, the ring comes from the damped
 * IR and the dispersion alone.
 */
export const SPRING_PRESETS = Object.freeze({
  short: Object.freeze({ stages: 6, spread: 0.0042, seconds: 0.9, decay: 2.6, wet: 0.26 }),
  long: Object.freeze({ stages: 10, spread: 0.0075, seconds: 1.8, decay: 2.0, wet: 0.30 }),
});

/** Ring-modulator characters (PROPOSAL). `carrier` is in Hz. */
export const RINGMOD_PRESETS = Object.freeze({
  bell: Object.freeze({ carrier: 220, wave: 'sine', wet: 0.4 }),
  robot: Object.freeze({ carrier: 60, wave: 'sine', wet: 0.6 }),
  clang: Object.freeze({ carrier: 1100, wave: 'square', wet: 0.5 }),
});

const RINGMOD_WAVES = Object.freeze(['sine', 'square', 'triangle', 'sawtooth']);

function fxNumber(value, fallback, min, max, path) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${path}: must be a finite number`);
  }
  if (value < min || value > max) throw new RangeError(`${path}: must be between ${min} and ${max}`);
  return value;
}

/** Resolve `'hall'` / `{ preset: 'hall', wet: 0.4 }` / `{ seconds: 2 }` alike. */
function fxResolvePreset(value, presets, kind) {
  if (value === undefined || value === null || value === false) return null;
  if (value === true) {
    const [first] = Object.keys(presets);
    return { ...presets[first], preset: first };
  }
  if (typeof value === 'string') {
    if (!Object.hasOwn(presets, value)) {
      throw new TypeError(`fx.${kind}: unknown preset "${value}" (have ${Object.keys(presets).join(', ')})`);
    }
    return { ...presets[value], preset: value };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`fx.${kind}: must be a preset name or an options object`);
  }
  const name = value.preset;
  if (name !== undefined) {
    if (typeof name !== 'string' || !Object.hasOwn(presets, name)) {
      throw new TypeError(`fx.${kind}.preset: unknown preset "${name}" (have ${Object.keys(presets).join(', ')})`);
    }
    return { ...presets[name], ...value, preset: name };
  }
  const [fallback] = Object.keys(presets);
  return { ...presets[fallback], ...value, preset: fallback };
}

/** Seconds for one synced delay repeat. Returns null for an unknown/absent sync. */
export function delaySyncSeconds(sync, bpm) {
  if (sync === undefined || sync === null) return null;
  if (!Object.hasOwn(DELAY_SYNC_FRACTIONS, sync)) {
    throw new TypeError(`fx.delay.sync: unknown beat fraction "${sync}" (have ${Object.keys(DELAY_SYNC_FRACTIONS).join(', ')})`);
  }
  const tempo = fxNumber(bpm, null, 20, 400, 'fx.delay.bpm');
  if (tempo === null) throw new TypeError('fx.delay.sync: needs a bpm (fx.bpm or fx.delay.bpm)');
  return (60 / tempo) * DELAY_SYNC_FRACTIONS[sync];
}

export function normalizeReverbFx(value) {
  const cfg = fxResolvePreset(value, REVERB_PRESETS, 'reverb');
  if (!cfg) return null;
  return Object.freeze({
    kind: 'reverb',
    preset: cfg.preset,
    seconds: fxNumber(cfg.seconds, REVERB_PRESETS.hall.seconds, 0.01, 12, 'fx.reverb.seconds'),
    decay: fxNumber(cfg.decay, REVERB_PRESETS.hall.decay, 0.1, 12, 'fx.reverb.decay'),
    damping: fxNumber(cfg.damping, REVERB_PRESETS.hall.damping, 200, 20000, 'fx.reverb.damping'),
    preDelay: fxNumber(cfg.preDelay, 0, 0, 0.5, 'fx.reverb.preDelay'),
    wet: fxNumber(cfg.wet, REVERB_PRESETS.hall.wet, 0, 1, 'fx.reverb.wet'),
  });
}

export function normalizeDelayFx(value, bpm) {
  const cfg = fxResolvePreset(value, DELAY_PRESETS, 'delay');
  if (!cfg) return null;
  const tempo = cfg.bpm === undefined ? bpm : cfg.bpm;
  const synced = cfg.sync === undefined || cfg.sync === null ? null : delaySyncSeconds(cfg.sync, tempo);
  const raw = cfg.time === undefined || cfg.time === null ? null : cfg.time;
  const timeSeconds = fxNumber(
    synced ?? raw ?? DELAY_PRESETS.quarter.time ?? 0.25,
    0.25, 0.001, FX_MAX_DELAY_SECONDS, 'fx.delay.time',
  );
  return Object.freeze({
    kind: 'delay',
    preset: cfg.preset,
    sync: synced === null ? null : cfg.sync,
    timeSeconds,
    feedback: fxNumber(cfg.feedback, 0.34, 0, FX_MAX_FEEDBACK, 'fx.delay.feedback'),
    damping: fxNumber(cfg.damping, 3000, 200, 20000, 'fx.delay.damping'),
    wet: fxNumber(cfg.wet, 0.22, 0, 1, 'fx.delay.wet'),
    pingPong: Boolean(cfg.pingPong),
  });
}

export function normalizeChorusFx(value) {
  const cfg = fxResolvePreset(value, CHORUS_PRESETS, 'chorus');
  if (!cfg) return null;
  const voices = fxNumber(cfg.voices, 2, 1, FX_MAX_CHORUS_VOICES, 'fx.chorus.voices');
  if (!Number.isInteger(voices)) throw new TypeError('fx.chorus.voices: must be an integer');
  return Object.freeze({
    kind: 'chorus',
    preset: cfg.preset,
    voices,
    rate: fxNumber(cfg.rate, 0.45, 0.01, 20, 'fx.chorus.rate'),
    depth: fxNumber(cfg.depth, 0.0022, 0, 0.05, 'fx.chorus.depth'),
    spread: fxNumber(cfg.spread, 0.010, 0, 0.08, 'fx.chorus.spread'),
    wet: fxNumber(cfg.wet, 0.18, 0, 1, 'fx.chorus.wet'),
    width: fxNumber(cfg.width, 0.6, 0, 1, 'fx.chorus.width'),
  });
}

export function normalizeBitcrushFx(value) {
  const cfg = fxResolvePreset(value, BITCRUSH_PRESETS, 'bitcrush');
  if (!cfg) return null;
  const bits = fxNumber(cfg.bits, BITCRUSH_PRESETS.chip.bits, FX_MIN_BITS, FX_MAX_BITS, 'fx.bitcrush.bits');
  if (!Number.isInteger(bits)) throw new TypeError('fx.bitcrush.bits: must be an integer');
  return Object.freeze({
    kind: 'bitcrush',
    preset: cfg.preset,
    bits,
    // `rate` null means "do not decimate" — quantise only.
    rate: cfg.rate === null || cfg.rate === undefined
      ? null
      : fxNumber(cfg.rate, BITCRUSH_PRESETS.chip.rate, 200, 96000, 'fx.bitcrush.rate'),
    wet: fxNumber(cfg.wet, 0.7, 0, 1, 'fx.bitcrush.wet'),
  });
}

export function normalizeSnesverbFx(value) {
  const cfg = fxResolvePreset(value, SNESVERB_PRESETS, 'snesverb');
  if (!cfg) return null;
  const edl = fxNumber(cfg.edl, SNESVERB_PRESETS.cave.edl, 0, SNES_MAX_EDL, 'fx.snesverb.edl');
  if (!Number.isInteger(edl)) throw new TypeError('fx.snesverb.edl: must be an integer');
  let fir = cfg.fir === undefined || cfg.fir === null ? 'lowpass' : cfg.fir;
  let taps;
  if (typeof fir === 'string') {
    if (!Object.hasOwn(SNES_FIR_PRESETS, fir)) {
      throw new TypeError(`fx.snesverb.fir: unknown FIR "${fir}" (have ${Object.keys(SNES_FIR_PRESETS).join(', ')})`);
    }
    taps = SNES_FIR_PRESETS[fir];
  } else if (Array.isArray(fir)) {
    if (fir.length !== SNES_FIR_TAPS) throw new TypeError(`fx.snesverb.fir: needs exactly ${SNES_FIR_TAPS} taps`);
    for (const tap of fir) {
      if (!Number.isInteger(tap) || tap < -128 || tap > 127) {
        throw new TypeError('fx.snesverb.fir: taps must be integers in -128..127 (the hardware\'s signed bytes)');
      }
    }
    taps = Object.freeze([...fir]);
    fir = 'custom';
  } else {
    throw new TypeError('fx.snesverb.fir: must be a FIR name or an array of 8 signed bytes');
  }
  // EDL 0 is the hardware's degenerate one-block buffer; treat it as one step so
  // the delay line is always allocatable.
  const timeSeconds = Math.max(1, edl) * SNES_EDL_STEP_SECONDS;
  return Object.freeze({
    kind: 'snesverb',
    preset: cfg.preset,
    edl,
    timeSeconds,
    fir,
    taps,
    feedback: fxNumber(cfg.feedback, 0.55, 0, FX_MAX_FEEDBACK, 'fx.snesverb.feedback'),
    wet: fxNumber(cfg.wet, 0.3, 0, 1, 'fx.snesverb.wet'),
    mono: Boolean(cfg.mono),
  });
}

/**
 * THE HISS LAW. `hiss` is a bounded, opt-in parameter that defaults to ZERO in
 * every preset and in the fallback below. A tape unit with no hiss declared adds
 * literally no samples of noise — proven by a test that renders a declared tape
 * effect over silence and asserts every output frame is exactly 0. A score that
 * wants surface noise asks for it, and cannot ask for more than FX_MAX_HISS.
 */
export function normalizeTapeFx(value) {
  const cfg = fxResolvePreset(value, TAPE_PRESETS, 'tape');
  if (!cfg) return null;
  return Object.freeze({
    kind: 'tape',
    preset: cfg.preset,
    wowRate: fxNumber(cfg.wowRate, TAPE_PRESETS.studio.wowRate, 0.01, 10, 'fx.tape.wowRate'),
    wowDepth: fxNumber(cfg.wowDepth, TAPE_PRESETS.studio.wowDepth, 0, 0.02, 'fx.tape.wowDepth'),
    flutterRate: fxNumber(cfg.flutterRate, TAPE_PRESETS.studio.flutterRate, 0.1, 40, 'fx.tape.flutterRate'),
    flutterDepth: fxNumber(cfg.flutterDepth, TAPE_PRESETS.studio.flutterDepth, 0, 0.01, 'fx.tape.flutterDepth'),
    drive: fxNumber(cfg.drive, 1, 0, FX_MAX_DRIVE, 'fx.tape.drive'),
    rolloff: fxNumber(cfg.rolloff, 12000, 200, 20000, 'fx.tape.rolloff'),
    hiss: fxNumber(cfg.hiss, 0, 0, FX_MAX_HISS, 'fx.tape.hiss'),
    wet: fxNumber(cfg.wet, 1, 0, 1, 'fx.tape.wet'),
  });
}

export function normalizeSpringFx(value) {
  const cfg = fxResolvePreset(value, SPRING_PRESETS, 'spring');
  if (!cfg) return null;
  const stages = fxNumber(cfg.stages, SPRING_PRESETS.short.stages, 1, FX_MAX_SPRING_STAGES, 'fx.spring.stages');
  if (!Number.isInteger(stages)) throw new TypeError('fx.spring.stages: must be an integer');
  return Object.freeze({
    kind: 'spring',
    preset: cfg.preset,
    stages,
    spread: fxNumber(cfg.spread, SPRING_PRESETS.short.spread, 0.0005, 0.02, 'fx.spring.spread'),
    seconds: fxNumber(cfg.seconds, SPRING_PRESETS.short.seconds, 0.05, 6, 'fx.spring.seconds'),
    decay: fxNumber(cfg.decay, SPRING_PRESETS.short.decay, 0.1, 12, 'fx.spring.decay'),
    wet: fxNumber(cfg.wet, 0.26, 0, 1, 'fx.spring.wet'),
  });
}

export function normalizeRingmodFx(value) {
  const cfg = fxResolvePreset(value, RINGMOD_PRESETS, 'ringmod');
  if (!cfg) return null;
  const wave = cfg.wave === undefined || cfg.wave === null ? 'sine' : cfg.wave;
  if (!RINGMOD_WAVES.includes(wave)) {
    throw new TypeError(`fx.ringmod.wave: unknown wave "${wave}" (have ${RINGMOD_WAVES.join(', ')})`);
  }
  return Object.freeze({
    kind: 'ringmod',
    preset: cfg.preset,
    carrier: fxNumber(cfg.carrier, RINGMOD_PRESETS.bell.carrier, 0.1, 8000, 'fx.ringmod.carrier'),
    wave,
    wet: fxNumber(cfg.wet, 0.4, 0, 1, 'fx.ringmod.wet'),
  });
}

const FX_NORMALIZERS = Object.freeze({
  reverb: (value, bpm) => normalizeReverbFx(value, bpm),
  delay: (value, bpm) => normalizeDelayFx(value, bpm),
  chorus: (value, bpm) => normalizeChorusFx(value, bpm),
  bitcrush: (value) => normalizeBitcrushFx(value),
  snesverb: (value) => normalizeSnesverbFx(value),
  tape: (value) => normalizeTapeFx(value),
  spring: (value) => normalizeSpringFx(value),
  ringmod: (value) => normalizeRingmodFx(value),
});

/**
 * Normalise an `fx` declaration into a frozen plan, or null when nothing is
 * declared. `{ bpm }` supplies the tempo that beat-synced effects need.
 */
export function normalizeFx(fx, { bpm = null } = {}) {
  if (fx === undefined || fx === null || fx === false) return null;
  if (typeof fx !== 'object' || Array.isArray(fx)) throw new TypeError('fx: must be an object');
  const tempo = fx.bpm === undefined ? bpm : fx.bpm;
  const sends = {};
  for (const kind of FX_KINDS) {
    const plan = FX_NORMALIZERS[kind](fx[kind], tempo);
    if (plan) sends[kind] = plan;
  }
  let master = null;
  if (fx.master !== undefined && fx.master !== null && fx.master !== false) {
    if (typeof fx.master !== 'object' || Array.isArray(fx.master)) throw new TypeError('fx.master: must be an object');
    const inserts = {};
    for (const kind of FX_KINDS) {
      const plan = FX_NORMALIZERS[kind](fx.master[kind], tempo);
      if (plan) inserts[kind] = plan;
    }
    const dry = fxNumber(fx.master.dry, 1, 0, 1, 'fx.master.dry');
    if (Object.keys(inserts).length > 0) master = Object.freeze({ ...inserts, dry });
  }
  if (Object.keys(sends).length === 0 && !master) return null;
  return Object.freeze({ bpm: tempo, ...sends, master });
}

/**
 * Longest tail any declared effect can add past the last note, in seconds.
 * Renderers extend their offline buffer by this so echoes and reverb tails are
 * not cut. Zero when no fx are declared — historical render lengths unchanged.
 */
export function fxTailSeconds(plan) {
  if (!plan) return 0;
  let tail = 0;
  const consider = (cfg) => {
    if (!cfg) return;
    if (cfg.kind === 'reverb') tail = Math.max(tail, cfg.seconds + cfg.preDelay);
    if (cfg.kind === 'delay') {
      // Repeats until the feedback gain falls below -60 dB, capped so a hot
      // feedback setting cannot inflate a render without bound.
      const repeats = cfg.feedback <= 0 ? 1 : Math.min(32, Math.ceil(Math.log(0.001) / Math.log(cfg.feedback)));
      tail = Math.max(tail, cfg.timeSeconds * repeats);
    }
    if (cfg.kind === 'chorus') tail = Math.max(tail, cfg.spread * cfg.voices + cfg.depth);
    // kit 1.9.0
    if (cfg.kind === 'snesverb') {
      const repeats = cfg.feedback <= 0 ? 1 : Math.min(64, Math.ceil(Math.log(0.001) / Math.log(cfg.feedback)));
      tail = Math.max(tail, cfg.timeSeconds * repeats);
    }
    if (cfg.kind === 'spring') tail = Math.max(tail, cfg.seconds + cfg.spread * cfg.stages);
    // The crusher's hold and the tape transport are both sub-frame-to-millisecond
    // structures; the ring modulator is memoryless. None of them ring.
    if (cfg.kind === 'bitcrush') tail = Math.max(tail, 0.01);
    if (cfg.kind === 'tape') tail = Math.max(tail, TAPE_BASE_DELAY + cfg.wowDepth + cfg.flutterDepth);
  };
  for (const kind of FX_KINDS) consider(plan[kind]);
  if (plan.master) for (const kind of FX_KINDS) consider(plan.master[kind]);
  return tail;
}

/** One-pole smoothing coefficient for a cutoff in Hz at a sample rate. */
function onePoleAlpha(cutoffHz, sampleRate) {
  const rc = 1 / (2 * Math.PI * Math.max(1, cutoffHz));
  const dt = 1 / sampleRate;
  return dt / (rc + dt);
}

/**
 * A damped impulse response: seeded noise under an exponential decay, run
 * through a one-pole whose cutoff falls across the tail so highs die first —
 * which is what "damping" means on a real reverb. Pure arithmetic on a seeded
 * stream: same seed, same IR, every run.
 */
function makeDampedIr(ctx, { seconds, decay, damping }, seed) {
  const rate = ctx.sampleRate || 44100;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const rnd = mulberry32((seed ^ (c * 0x9e3779b9)) >>> 0);
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      // Cutoff slides from `damping` down to an eighth of it across the tail.
      const alpha = onePoleAlpha(damping * (1 - 0.875 * x), rate);
      lp += alpha * ((rnd() * 2 - 1) - lp);
      d[i] = lp * Math.pow(1 - x, decay) * (1 - Math.exp(-i / 200));
    }
  }
  return buf;
}

/** Reverb bus: pre-delay -> convolver on a generated damped IR. */
function buildFxReverb(ctx, cfg, seed) {
  if (!ctx.createConvolver || !ctx.createBuffer) return null;
  try {
    const input = ctx.createGain();
    input.gain.value = 1;
    const convolver = ctx.createConvolver();
    convolver.buffer = makeDampedIr(ctx, cfg, seed);
    if (cfg.preDelay > 0 && ctx.createDelay) {
      const pre = ctx.createDelay(Math.max(0.5, cfg.preDelay * 2));
      pre.delayTime.value = cfg.preDelay;
      input.connect(pre);
      pre.connect(convolver);
    } else {
      input.connect(convolver);
    }
    return { input, output: convolver, nodes: [convolver], sources: [] };
  } catch (_) { return null; }
}

/** Feedback delay, optionally ping-pong across the stereo field. */
function buildFxDelay(ctx, cfg) {
  if (!ctx.createDelay) return null;
  try {
    const input = ctx.createGain();
    input.gain.value = 1;
    const output = ctx.createGain();
    output.gain.value = 1;
    const maxTime = Math.min(FX_MAX_DELAY_SECONDS, Math.max(0.05, cfg.timeSeconds * 2));
    const makeLine = () => {
      const line = ctx.createDelay(maxTime);
      line.delayTime.value = cfg.timeSeconds;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = cfg.damping;
      damp.Q.value = 0.5;
      line.connect(damp);
      return { line, damp };
    };
    if (cfg.pingPong && ctx.createStereoPanner) {
      // input -> A -> left, A -> B -> right, B -> A: echoes alternate sides.
      const a = makeLine();
      const b = makeLine();
      const panL = ctx.createStereoPanner(); panL.pan.value = -1;
      const panR = ctx.createStereoPanner(); panR.pan.value = 1;
      const cross = ctx.createGain(); cross.gain.value = 1;
      const fb = ctx.createGain(); fb.gain.value = cfg.feedback;
      input.connect(a.line);
      a.damp.connect(panL); panL.connect(output);
      a.damp.connect(cross); cross.connect(b.line);
      b.damp.connect(panR); panR.connect(output);
      b.damp.connect(fb); fb.connect(a.line);
      return { input, output, nodes: [a.line, b.line], sources: [] };
    }
    const { line, damp } = makeLine();
    const fb = ctx.createGain();
    fb.gain.value = cfg.feedback;
    input.connect(line);
    damp.connect(fb);
    fb.connect(line);
    damp.connect(output);
    return { input, output, nodes: [line], sources: [] };
  } catch (_) { return null; }
}

/**
 * Chorus: an ensemble of LFO-modulated delay lines panned across the field.
 * Alternate voices take an inverted modulation gain, which is a deterministic
 * 180-degree phase offset without needing to start an oscillator before zero.
 */
function buildFxChorus(ctx, cfg) {
  if (!ctx.createDelay || !ctx.createOscillator) return null;
  try {
    const input = ctx.createGain();
    input.gain.value = 1;
    const output = ctx.createGain();
    output.gain.value = 1;
    const sources = [];
    for (let i = 0; i < cfg.voices; i++) {
      const base = 0.008 + cfg.spread * i;
      const line = ctx.createDelay(Math.max(0.05, (base + cfg.depth) * 2));
      line.delayTime.value = base;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = cfg.rate * (1 + i * 0.17);
      const depth = ctx.createGain();
      depth.gain.value = (i % 2 === 0 ? 1 : -1) * cfg.depth;
      lfo.connect(depth);
      depth.connect(line.delayTime);
      lfo.start(0);
      sources.push(lfo);
      input.connect(line);
      if (ctx.createStereoPanner && cfg.voices > 1) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = cfg.width * (-1 + (2 * i) / (cfg.voices - 1));
        line.connect(pan);
        pan.connect(output);
      } else {
        line.connect(output);
      }
    }
    return { input, output, nodes: [], sources };
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// kit 1.9.0 builders
// ---------------------------------------------------------------------------

/** Base delay the tape transport runs at, so wow/flutter can modulate both ways. */
const TAPE_BASE_DELAY = 0.02;

/**
 * A staircase transfer curve: the exact quantiser for `bits` bits.
 *
 * A quantiser is memoryless, so a WaveShaperNode reproduces it EXACTLY rather
 * than approximating it. The curve is sampled finely enough (RESOLUTION points
 * per output level) that all but ~1.5% of input samples land inside a flat
 * plateau, where the node's linear interpolation between two equal neighbours is
 * an identity. Measured: at 4/6/8 bits the output lattice spacing is 1.2500e-1 /
 * 3.1250e-2 / 7.8130e-3 against an ideal 2/2^bits, with 98.4-98.7% occupancy.
 *
 * `oversample` stays 'none' — the 2x/4x modes resample around the curve, which
 * would both smear the steps and put a platform-defined filter on the audio path.
 */
const BITCRUSH_CURVE_RESOLUTION = 64;
const BITCRUSH_MAX_CURVE = 65537;

export function bitcrushCurve(bits) {
  const levels = Math.pow(2, bits);
  const step = 2 / levels;
  // Odd length so exact zero is a sample point and silence stays silent.
  let len = Math.min(BITCRUSH_MAX_CURVE, Math.max(257, Math.round(levels * BITCRUSH_CURVE_RESOLUTION)));
  if (len % 2 === 0) len += 1;
  const curve = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const x = -1 + (2 * i) / (len - 1);
    const q = Math.round(x / step) * step;
    curve[i] = q < -1 ? -1 : q > 1 ? 1 : q;
  }
  return curve;
}

/**
 * Bit-depth quantiser + zero-order-hold decimator.
 *
 * The hold is an N-tap rectangular FIR on a ConvolverNode, which is exactly the
 * zero-order-hold magnitude response: a sinc with nulls at multiples of
 * sampleRate/N. Measured against theory at N = 4/8/16 the null sits 250-1000x
 * below the passband.
 *
 * WHAT THIS DOES NOT MODEL, stated plainly: the imaging (aliasing) a real
 * sample-and-hold folds back above fs/N. Producing that needs a genuine
 * sample-and-hold, and WebAudio has no portable one — the obvious construction,
 * gating with a band-limited impulse train from a PeriodicWave, is not portable
 * because `disableNormalization` is honoured by browsers and ignored by
 * node-web-audio-api (probed 2026-08-30: a single harmonic of amplitude 2 renders
 * at peak 1.0 there), so the comb's amplitude — and therefore the image level —
 * would differ between the renderer and the shipped game. That is exactly the
 * class of cross-engine divergence the determinism law exists to forbid. The
 * quantiser carries the crushed character; `rate` supplies the hold's dulling.
 */
function buildFxBitcrush(ctx, cfg) {
  if (!ctx.createWaveShaper) return null;
  try {
    const input = ctx.createGain();
    input.gain.value = 1;
    const shaper = ctx.createWaveShaper();
    shaper.curve = bitcrushCurve(cfg.bits);
    try { shaper.oversample = 'none'; } catch (_) { /* stub */ }
    input.connect(shaper);
    let output = shaper;
    const rate = ctx.sampleRate || 44100;
    const hold = cfg.rate === null ? 1 : Math.min(FX_MAX_HOLD, Math.max(1, Math.round(rate / cfg.rate)));
    if (hold > 1 && ctx.createConvolver && ctx.createBuffer) {
      const ir = ctx.createBuffer(1, hold, rate);
      const taps = ir.getChannelData(0);
      for (let i = 0; i < hold; i++) taps[i] = 1 / hold;
      const conv = ctx.createConvolver();
      conv.normalize = false;
      conv.buffer = ir;
      shaper.connect(conv);
      output = conv;
    }
    return { input, output, nodes: [shaper], sources: [], hold };
  } catch (_) { return null; }
}

/**
 * SNES DSP-style echo: a short ring buffer whose FEEDBACK PATH runs through the
 * hardware's 8-tap FIR. That filter is the whole character — a plain feedback
 * delay is a delay; a delay that re-filters every pass is a SNES echo, because
 * each repeat loses (or gains) the same band again, compounding.
 *
 * The FIR is an 8-sample ConvolverNode impulse response with normalize off, so
 * the taps ARE the hardware's signed bytes over 128, not an approximation.
 */
function buildFxSnesverb(ctx, cfg) {
  if (!ctx.createDelay || !ctx.createConvolver || !ctx.createBuffer) return null;
  try {
    const input = ctx.createGain();
    input.gain.value = 1;
    const output = ctx.createGain();
    output.gain.value = 1;

    // Optional mono collapse: the SNES echo bus is a single mono ring buffer.
    let head = input;
    if (cfg.mono && ctx.createChannelSplitter && ctx.createChannelMerger) {
      const split = ctx.createChannelSplitter(2);
      const sum = ctx.createGain();
      sum.gain.value = 1;
      const gl = ctx.createGain(); gl.gain.value = 0.5;
      const gr = ctx.createGain(); gr.gain.value = 0.5;
      input.connect(split);
      split.connect(gl, 0);
      split.connect(gr, 1);
      gl.connect(sum);
      gr.connect(sum);
      head = sum;
    }

    const line = ctx.createDelay(Math.max(0.05, cfg.timeSeconds * 2));
    line.delayTime.value = cfg.timeSeconds;

    const ir = ctx.createBuffer(1, SNES_FIR_TAPS, ctx.sampleRate || 44100);
    const taps = ir.getChannelData(0);
    for (let i = 0; i < SNES_FIR_TAPS; i++) taps[i] = cfg.taps[i] / SNES_FIR_SCALE;
    const fir = ctx.createConvolver();
    fir.normalize = false;
    fir.buffer = ir;

    const fb = ctx.createGain();
    fb.gain.value = cfg.feedback;

    // head -> line -> FIR -> (out, and back into the line through feedback)
    head.connect(line);
    line.connect(fir);
    fir.connect(output);
    fir.connect(fb);
    fb.connect(line);

    return { input, output, nodes: [line, fir], sources: [] };
  } catch (_) { return null; }
}

/**
 * Tape: wow + flutter on a modulated delay line, soft saturation, HF rolloff,
 * and an opt-in hiss bed that is zero unless a score asks for it.
 *
 * Wow and flutter are separate LFOs into the same delayTime, so each contributes
 * a peak fractional pitch deviation of exactly `depth * 2*pi*rate` — the same
 * closed form the 1.8.0 chorus test uses, and independently measurable by
 * zeroing the other one.
 */
function buildFxTape(ctx, cfg, seed) {
  if (!ctx.createDelay || !ctx.createOscillator) return null;
  try {
    const input = ctx.createGain();
    input.gain.value = 1;
    const output = ctx.createGain();
    output.gain.value = 1;
    const sources = [];

    const line = ctx.createDelay(Math.max(0.05, (TAPE_BASE_DELAY + cfg.wowDepth + cfg.flutterDepth) * 4));
    line.delayTime.value = TAPE_BASE_DELAY;
    input.connect(line);

    for (const [rate, depth, phaseSign] of [[cfg.wowRate, cfg.wowDepth, 1], [cfg.flutterRate, cfg.flutterDepth, -1]]) {
      if (depth <= 0) continue;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = rate;
      const amount = ctx.createGain();
      amount.gain.value = phaseSign * depth;
      lfo.connect(amount);
      amount.connect(line.delayTime);
      lfo.start(0);
      sources.push(lfo);
    }

    let node = line;

    // Soft saturation. tanh is odd, so it makes odd harmonics and no DC.
    //
    // Normalised by `drive`, NOT by tanh(drive). Dividing by tanh(drive) is the
    // textbook "unity at full scale" normalisation and it is wrong for a send
    // effect: the small-signal gain of tanh(d*x)/tanh(d) is d/tanh(d) ~= d, so
    // `drive: 9` quietly added ~19 dB and the demo set clipped at 1.725. Dividing
    // by `drive` instead makes the small-signal gain exactly 1 and the maximum
    // output tanh(drive)/drive <= 1, which is what a saturator should do: leave
    // quiet material alone, squash loud material, never raise the level.
    if (cfg.drive > 1 && ctx.createWaveShaper) {
      const shaper = ctx.createWaveShaper();
      const len = 2049;
      const curve = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const x = -1 + (2 * i) / (len - 1);
        curve[i] = Math.tanh(cfg.drive * x) / cfg.drive;
      }
      shaper.curve = curve;
      try { shaper.oversample = 'none'; } catch (_) { /* stub */ }
      node.connect(shaper);
      node = shaper;
    }

    if (cfg.rolloff < 20000 && ctx.createBiquadFilter) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cfg.rolloff;
      lp.Q.value = 0.5;
      node.connect(lp);
      node = lp;
    }
    node.connect(output);

    // THE HISS LAW: zero by default means zero nodes built. Nothing to leak.
    if (cfg.hiss > 0 && ctx.createBuffer && ctx.createBufferSource) {
      const rate = ctx.sampleRate || 44100;
      const buf = ctx.createBuffer(1, Math.max(1, Math.floor(rate * 2)), rate);
      const rnd = mulberry32((seed ^ 0x6a09e667) >>> 0);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = cfg.hiss;
      src.connect(g);
      g.connect(output);
      src.start(0);
      sources.push(src);
    }

    return { input, output, nodes: [line], sources };
  } catch (_) { return null; }
}

/**
 * PROPOSAL — spring tank. A cascade of allpass sections disperses the signal
 * (high frequencies arrive before low ones), which is the "boing"; a damped IR
 * and a feedback path give it the tank's ring.
 */
function buildFxSpring(ctx, cfg, seed) {
  if (!ctx.createDelay || !ctx.createConvolver || !ctx.createBuffer) return null;
  try {
    const input = ctx.createGain();
    input.gain.value = 1;
    const output = ctx.createGain();
    output.gain.value = 1;

    // Schroeder allpass chain. Each stage is
    //     v[n] = x[n] + g*v[n-d]        (sum, fed back through the delay)
    //     y[n] = -g*v[n] + v[n-d]       (feedforward off the SUM, not the input)
    // which has unity magnitude at every frequency and delays each one
    // differently — dispersion, i.e. the boing, with no level change.
    //
    // Tapping the feedforward off `input` instead of `sum` is the easy mistake
    // and it is not an allpass at all: it leaves a resonant 1/(1-g^2) per stage,
    // measured here as 2.5x through-gain at 6 stages and 8.3x at 10, which
    // clipped the demo set outright.
    let node = input;
    const nodes = [];
    for (let i = 0; i < cfg.stages; i++) {
      const d = cfg.spread * (1 + (i % 4) * 0.37);
      const line = ctx.createDelay(Math.max(0.05, d * 4));
      line.delayTime.value = d;
      const g = 0.62;
      const feedforward = ctx.createGain(); feedforward.gain.value = -g;
      const feedback = ctx.createGain(); feedback.gain.value = g;
      const sum = ctx.createGain(); sum.gain.value = 1;
      const stageOut = ctx.createGain(); stageOut.gain.value = 1;
      node.connect(sum);
      sum.connect(feedforward);
      feedforward.connect(stageOut);
      sum.connect(line);
      line.connect(stageOut);
      line.connect(feedback);
      feedback.connect(sum);
      nodes.push(line);
      node = stageOut;
    }

    const conv = ctx.createConvolver();
    conv.buffer = makeDampedIr(ctx, { seconds: cfg.seconds, decay: cfg.decay, damping: 5200 }, seed);
    node.connect(conv);
    conv.connect(output);
    // No outer feedback — see SPRING_PRESETS for why it cannot exist here.
    return { input, output, nodes, sources: [] };
  } catch (_) { return null; }
}

/**
 * PROPOSAL — ring modulator. A GainNode whose gain is driven by an oscillator is
 * a true four-quadrant multiply (AudioParam gain goes negative), so the output
 * is x(t)*c(t): the input at f becomes sidebands at |f - fc| and f + fc with the
 * carrier suppressed. Memoryless and clock-free.
 */
function buildFxRingmod(ctx, cfg) {
  if (!ctx.createOscillator) return null;
  try {
    const input = ctx.createGain();
    input.gain.value = 1;
    const ring = ctx.createGain();
    ring.gain.value = 0;                 // no through-path: gain IS the carrier
    const carrier = ctx.createOscillator();
    carrier.type = cfg.wave;
    carrier.frequency.value = cfg.carrier;
    carrier.connect(ring.gain);
    carrier.start(0);
    input.connect(ring);
    return { input, output: ring, nodes: [], sources: [carrier] };
  } catch (_) { return null; }
}

const FX_BUILDERS = Object.freeze({
  reverb: buildFxReverb,
  delay: buildFxDelay,
  chorus: buildFxChorus,
  bitcrush: buildFxBitcrush,
  snesverb: buildFxSnesverb,
  tape: buildFxTape,
  spring: buildFxSpring,
  ringmod: buildFxRingmod,
});

/** Build one effect unit, salting the seed per kind so IRs never coincide. */
function buildFxUnit(ctx, kind, cfg, seed) {
  const builder = FX_BUILDERS[kind];
  if (!builder) return null;
  return builder(ctx, cfg, seed);
}

const FX_SEED_SALT = Object.freeze({
  reverb: 0x1f83d9ab,
  delay: 0x5be0cd19,
  chorus: 0x9b05688c,
  bitcrush: 0x510e527f,
  snesverb: 0xa54ff53a,
  tape: 0x3c6ef372,
  spring: 0xbb67ae85,
  ringmod: 0x6a09e667,
});

// Scheduler constants. LOOKAHEAD is how far ahead of currentTime we schedule;
// TICK_MS how often the driver wakes. MAX_STEPS_PER_TICK stops a pathological
// clock jump (tab wake, breakpoint) from scheduling thousands of notes at once.
export const LOOKAHEAD = NEUTRAL_DEFAULTS.band.lookahead;
export const TICK_MS = NEUTRAL_DEFAULTS.band.tickMs;
export const MAX_STEPS_PER_TICK = 64;

// Register-neutral crossfade and retirement defaults.
export const FADE_OUT = NEUTRAL_DEFAULTS.band.fadeOut;
export const FADE_IN = NEUTRAL_DEFAULTS.band.fadeIn;

/**
 * How a track bus leaves when the next section arrives (kit 1.9.0).
 *
 *   'crossfade' — the historical behaviour and the DEFAULT. The outgoing bus
 *                 ramps to silence over `fadeOut` (80 ms), so nothing from the
 *                 old track can bleed into the new one. A note still sounding at
 *                 the boundary is cut with it: a bell with a 1.2 s release
 *                 measured audible to 2.069 s against a boundary at 2.000 s.
 *   'tail'      — the bus holds its level for `retireHold` seconds and only then
 *                 ramps out, so a section's last notes ring into the next one.
 *
 * This is a CHOICE, not a defect, which is why the default does not move: every
 * multi-section score in the fleet would re-render, and re-renders of shipped
 * scores require re-ear-gating. A score that wants ringing boundaries asks for
 * it. See docs/KIT-CHANGELOG.md, kit 1.9.0.
 */
export const RETIRE_MODES = Object.freeze(['crossfade', 'tail']);
/** Longest a 'tail' retire may hold a bus open before ramping it out. */
export const RETIRE_MAX_HOLD = 8;
// How long a retired track bus lingers before disconnect — long enough for the
// longest voice release to finish under the fade.
export const RETIRE_TAIL = NEUTRAL_DEFAULTS.band.retireTail;

export class BandStepError extends Error {
  constructor({ track, index, absoluteStep, scheduledTime, cause }) {
    super(`track "${track}" step ${index} (absolute ${absoluteStep}, t=${scheduledTime.toFixed(6)}): ${cause?.message || cause}`);
    this.name = 'BandStepError';
    this.track = track;
    this.index = index;
    this.absoluteStep = absoluteStep;
    this.scheduledTime = scheduledTime;
    this.cause = cause;
  }
}

/**
 * Build a band on an existing AudioContext.
 * @param {object}   o
 * @param {AudioContext} o.ctx          required
 * @param {AudioNode} [o.destination]   where the band's output goes (default ctx.destination)
 * @param {number}   [o.seed]           seeds the reverb IR, the noise buffer, and s.rand
 * @param {number}   [o.gain]           the band's output level
 * @param {object}   [o.reverb]         { seconds, decay } of the generated IR
 * @param {object}   [o.fx]             kit 1.8.0 FX suite; omitted is exactly the 1.7.1 graph
 * @param {Function} [o.nowFn]          scheduler clock (default ctx.currentTime)
 * @param {boolean}  [o.strict]         collect step failures for authoring renders
 * @param {boolean}  [o.disconnectRetired] disconnect expired buses (disable while pre-scheduling offline)
 * @param {object}   [o.performance]    deterministic humanize/release tools; omitted is neutral
 * @param {string}   [o.registerClass]  opt-in dread/calm/joy execution posture
 */
export function createBand({
  ctx,
  destination = null,
  seed = 1,
  gain = NEUTRAL_DEFAULTS.band.gain,
  reverb = NEUTRAL_DEFAULTS.band.reverb,
  reverbReturnGain = NEUTRAL_DEFAULTS.band.reverbReturnGain,
  fx = undefined,
  lookahead = LOOKAHEAD,
  tickMs = TICK_MS,
  fadeOut = FADE_OUT,
  fadeIn = FADE_IN,
  retireTail = RETIRE_TAIL,
  retireMode = 'crossfade',
  retireHold = 0,
  voiceDefaults = {},
  performance = undefined,
  registerClass = undefined,
  nowFn = () => ctx.currentTime,
  strict = false,
  disconnectRetired = true,
} = {}) {
  if (!ctx) throw new Error('createBand: needs an AudioContext');
  if (typeof nowFn !== 'function') throw new Error('createBand: nowFn must be a function');
  const rngSeed = (seed >>> 0) || 1;
  const resolvedVoiceDefaults = Object.fromEntries(
    Object.entries(NEUTRAL_DEFAULTS.voices).map(([name, defaults]) => [
      name,
      { ...defaults, ...(voiceDefaults[name] || {}) },
    ]),
  );
  const resolvedPerformance = normalizePerformance(performance);
  if (registerClass !== undefined && !REGISTER_CLASS_SET.has(registerClass)) {
    throw new TypeError(`registerClass: must be one of ${REGISTER_CLASSES.join(', ')}`);
  }
  // Kit 1.9.0 section-boundary posture. Default 'crossfade' with a 0 hold is the
  // 1.8.0 retire exactly.
  const resolvedRetireMode = retireMode === undefined || retireMode === null ? 'crossfade' : retireMode;
  if (!RETIRE_MODES.includes(resolvedRetireMode)) {
    throw new TypeError(`retireMode: must be one of ${RETIRE_MODES.join(', ')}`);
  }
  if (typeof retireHold !== 'number' || !Number.isFinite(retireHold) || retireHold < 0 || retireHold > RETIRE_MAX_HOLD) {
    throw new TypeError(`retireHold: must be a finite number between 0 and ${RETIRE_MAX_HOLD}`);
  }
  const resolvedRetireHold = resolvedRetireMode === 'tail' ? retireHold : 0;
  // Kit 1.8.0 FX suite. `null` means "declared nothing", and every branch below
  // that reads it is skipped — the graph is then exactly the 1.7.1 graph.
  const fxPlan = normalizeFx(fx);

  function readNow(explicitNow) {
    const now = explicitNow === undefined ? nowFn() : explicitNow;
    if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
      throw new Error('band clock: expected a finite non-negative time');
    }
    return now;
  }

  // -- bus architecture ------------------------------------------------------
  //   voices -> trackBus.out ---------------------\
  //          \-> sendGain -> trackBus.send -> verb -> verbReturn -> out -> destination
  //                                                       music bus  ^
  // The per-track bus is what makes a scene change clean: both its dry out and
  // its reverb send are ramped down together, so nothing from the outgoing
  // track can fade back in when the incoming one rises.
  const out = ctx.createGain();
  out.gain.value = gain;

  // -- master inserts (kit 1.8.0, opt-in) ------------------------------------
  // With no fx.master the chain below is untouched: out -> comp -> destination.
  // With one, out -> masterIn -> (dry + parallel wet branches) -> masterOut,
  // and masterOut takes out's old place ahead of the compressor.
  const fxSources = [];
  let masterTail = out;
  let masterUnits = null;
  if (fxPlan?.master) {
    const masterIn = ctx.createGain(); masterIn.gain.value = 1;
    const masterOut = ctx.createGain(); masterOut.gain.value = 1;
    const dryGain = ctx.createGain(); dryGain.gain.value = fxPlan.master.dry;
    out.connect(masterIn);
    masterIn.connect(dryGain);
    dryGain.connect(masterOut);
    masterUnits = {};
    for (const kind of FX_KINDS) {
      const cfg = fxPlan.master[kind];
      if (!cfg) continue;
      const unit = buildFxUnit(ctx, kind, cfg, (rngSeed ^ FX_SEED_SALT[kind] ^ 0x2f74e1c3) >>> 0);
      if (!unit) continue;
      const wet = ctx.createGain();
      wet.gain.value = cfg.wet;
      masterIn.connect(unit.input);
      unit.output.connect(wet);
      wet.connect(masterOut);
      fxSources.push(...unit.sources);
      masterUnits[kind] = Object.freeze({ ...unit, wet, config: cfg });
    }
    masterTail = masterOut;
    masterUnits = Object.freeze(masterUnits);
  }

  const comp = ctx.createDynamicsCompressor ? ctx.createDynamicsCompressor() : null;
  if (comp) {
    // Gentle glue so overlapping ambient pads never clip the sum.
    try {
      comp.threshold.value = -16; comp.knee.value = 24; comp.ratio.value = 3;
      comp.attack.value = 0.01; comp.release.value = 0.3;
    } catch (_) { /* a stub context without full params — harmless */ }
    masterTail.connect(comp);
    comp.connect(destination || ctx.destination);
  } else {
    masterTail.connect(destination || ctx.destination);
  }

  // -- send effects ----------------------------------------------------------
  // `fx.reverb` REPLACES the legacy send reverb rather than sitting beside it,
  // so a score's existing `verb:` amounts land in the upgraded room instead of
  // feeding a second one. Without fx.reverb the legacy chain is built verbatim.
  const fxReverbUnit = fxPlan?.reverb
    ? buildFxUnit(ctx, 'reverb', fxPlan.reverb, (rngSeed ^ FX_SEED_SALT.reverb) >>> 0)
    : null;
  const verb = fxReverbUnit ? fxReverbUnit.input : makeVerb(ctx, reverb, rngSeed);
  const verbReturn = ctx.createGain();
  verbReturn.gain.value = fxPlan?.reverb ? fxPlan.reverb.wet : reverbReturnGain;
  if (fxReverbUnit) {
    fxReverbUnit.output.connect(verbReturn);
    verbReturn.connect(out);
  } else if (verb) {
    verb.connect(verbReturn);
    verbReturn.connect(out);
  }

  // Non-reverb send buses, each with a per-track send gain (built in makeBus)
  // so a track change ramps its wet down exactly as it does its dry.
  const fxBuses = new Map();
  if (fxPlan) {
    for (const kind of FX_KINDS) {
      if (kind === 'reverb') continue;      // reverb rides the historical send
      const cfg = fxPlan[kind];
      if (!cfg) continue;
      const unit = buildFxUnit(ctx, kind, cfg, (rngSeed ^ FX_SEED_SALT[kind]) >>> 0);
      if (!unit) continue;
      const returnGain = ctx.createGain();
      returnGain.gain.value = cfg.wet;
      unit.output.connect(returnGain);
      returnGain.connect(out);
      fxSources.push(...unit.sources);
      fxBuses.set(kind, Object.freeze({ ...unit, returnGain, config: cfg }));
    }
  }
  const fxSendKinds = Object.freeze([...fxBuses.keys()]);

  const noiseBuf = makeNoise(ctx, rngSeed ^ 0x5bf03635);
  const chipNoiseBufs = makeChipNoise(ctx, rngSeed ^ 0x71f3a9c2);
  const pulseWaves = new Map();
  function getPulseWave(duty) {
    const key = Math.round(duty * 1000);
    if (!pulseWaves.has(key)) {
      const wave = makePulseWave(ctx, duty);
      if (wave) pulseWaves.set(key, wave);
    }
    return pulseWaves.get(key) || null;
  }

  // -- track buses -----------------------------------------------------------
  let bus = null;        // the live track's { out, send, vol }
  const retiring = [];   // buses fading out, disposed on a later tick

  function makeBus(vol, now, fadeSeconds) {
    const o = ctx.createGain();
    o.gain.value = EPS;
    o.connect(out);
    const s = ctx.createGain();
    s.gain.value = EPS;
    if (verb) s.connect(verb);
    // One send gain per declared fx bus. Empty (and never touched) when no fx
    // are declared, so the historical bus shape is unchanged.
    const fxSends = fxSendKinds.length === 0 ? null : Object.create(null);
    for (const kind of fxSendKinds) {
      const g = ctx.createGain();
      g.gain.value = EPS;
      g.connect(fxBuses.get(kind).input);
      fxSends[kind] = g;
    }
    return { out: o, send: s, fxSends, vol, fadeStart: now, fadeSeconds };
  }

  function retire(b, now) {
    if (!b) return;
    const progress = b.fadeSeconds === 0
      ? 1
      : clamp01((now - b.fadeStart) / b.fadeSeconds);
    const outLevel = EPS + (b.vol - EPS) * progress;
    const sendLevel = EPS + (1 - EPS) * progress;
    // Kit 1.9.0: 'tail' holds the outgoing bus at level for `hold` seconds so a
    // section's last notes decay naturally, then ramps out as before. `hold` is
    // 0 under the default 'crossfade' mode, where these two calls are exactly
    // the 1.8.0 pair — same ramps, same times, same samples.
    const hold = resolvedRetireMode === 'tail' ? resolvedRetireHold : 0;
    if (hold > 0) {
      holdLevel(b.out.gain, outLevel, now, hold);
      holdLevel(b.send.gain, sendLevel, now, hold);
      if (b.fxSends) {
        for (const kind of fxSendKinds) holdLevel(b.fxSends[kind].gain, sendLevel, now, hold);
      }
    }
    ramp(b.out.gain, outLevel, EPS, now + hold, fadeOut);
    ramp(b.send.gain, sendLevel, EPS, now + hold, fadeOut);
    if (b.fxSends) {
      for (const kind of fxSendKinds) ramp(b.fxSends[kind].gain, sendLevel, EPS, now + hold, fadeOut);
    }
    retiring.push({ bus: b, disposeAt: now + hold + fadeOut + retireTail });
  }

  function sweepRetired(now) {
    for (let i = retiring.length - 1; i >= 0; i--) {
      if (retiring[i].disposeAt <= now) {
        if (disconnectRetired) {
          try {
            retiring[i].bus.out.disconnect();
            retiring[i].bus.send.disconnect();
            const sends = retiring[i].bus.fxSends;
            if (sends) for (const kind of fxSendKinds) sends[kind].disconnect();
          } catch (_) { /* ignore */ }
        }
        retiring.splice(i, 1);
      }
    }
  }

  // A voice's dry destination, and its wet tap. With no live bus (silence) the
  // voices still build correctly but land on a bus at EPS, i.e. inaudible.
  function dry() { return bus ? bus.out : out; }
  function send(node, amount) {
    if (!amount || !bus) return;
    const g = ctx.createGain();
    g.gain.value = amount;
    node.connect(g);
    g.connect(bus.send);
  }

  // Every voice's wet tap: the historical reverb send plus, for each declared
  // fx bus, the amount named on the voice options (`delay`, `chorus`, ...).
  // With no fx declared this is exactly `send(node, o.verb)` and nothing else.
  function sendAll(node, o) {
    send(node, o.verb);
    if (fxSendKinds.length === 0 || !bus) return;
    for (const kind of fxSendKinds) {
      const amount = o[FX_VOICE_SEND[kind]];
      if (!amount) continue;
      const g = ctx.createGain();
      g.gain.value = amount;
      node.connect(g);
      g.connect(bus.fxSends[kind]);
    }
  }

  // -- envelope --------------------------------------------------------------
  // Attack to peak, decay to a sustain fraction, hold to `dur`, release out.
  // Exponential attack/decay/release (musical), floored at EPS.
  //
  // Continuous automation only: never setValueAtTime mid-envelope. A coincident
  // setValueAtTime at the decay endpoint (the old hold-anchor pattern) can cancel
  // the decay ramp in OfflineAudioContext so the gain plateaus at peak until that
  // instant, then jumps to sustain — an audible one-sample click. Hold stretches
  // use linearRamp to the same sustain value; release connects to the prior ramp.
  function env(g, t, { a = 0.4, d = 0.5, s = 0.6, r = 1.0, peak = 0.1, dur = 1 }) {
    const p = Math.max(EPS * 2, peak);
    const sustain = Math.max(EPS * 2, p * s);
    const decayEnd = t + a + d;
    const holdEnd = t + Math.max(a + d, dur);
    try {
      g.gain.setValueAtTime(EPS, t);
      g.gain.exponentialRampToValueAtTime(p, t + a);
      g.gain.exponentialRampToValueAtTime(sustain, decayEnd);
      if (holdEnd > decayEnd) {
        g.gain.linearRampToValueAtTime(sustain, holdEnd);
      }
      g.gain.exponentialRampToValueAtTime(EPS, holdEnd + r);
    } catch (_) { /* param without full automation */ }
    return (holdEnd - t) + r;
  }

  function ramp(param, from, to, t, secs) {
    try {
      param.setValueAtTime(Math.max(EPS, from), t);
      param.linearRampToValueAtTime(Math.max(EPS, to), t + secs);
    } catch (_) { try { param.value = to; } catch (__) { /* ignore */ } }
  }

  /** Pin a param at `level` from `t` for `secs` — the 'tail' retire's hold. */
  function holdLevel(param, level, t, secs) {
    try {
      param.setValueAtTime(Math.max(EPS, level), t);
      param.linearRampToValueAtTime(Math.max(EPS, level), t + secs);
    } catch (_) { /* param without full automation */ }
  }

  // ==========================================================================
  // VOICES
  // ==========================================================================

  // The harmonic bed: three detuned oscillators (one an octave down) through a
  // lowpass that sweeps open across the note — the slow filter movement is what
  // keeps a long pad from reading as a held organ chord.
  // Kit 1.7.1: o.sub === 0 or o.sub === false disables the hard-wired sub
  // oscillator (freq*0.5 @ 0.7). Absent/undefined keeps the historical default.
  function pad(t, freq, dur, o = {}) {
    o = { ...resolvedVoiceDefaults.pad, ...o };
    const o1 = ctx.createGain(); o1.gain.value = 1; o1.connect(dry());
    sendAll(o1, o);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    const cut = o.cut;
    try {
      f.frequency.setValueAtTime(cut, t);
      f.frequency.linearRampToValueAtTime(cut * o.sweep, t + dur * 0.6);
      f.Q.value = o.q;
    } catch (_) { /* stub */ }
    f.connect(o1);
    const det = o.det;
    const vol = o.vol;
    const oscCount = voiceSubEnabled(o) ? 3 : 2;
    for (let i = 0; i < oscCount; i++) {
      const osc = ctx.createOscillator();
      osc.type = o.wave;
      try { osc.frequency.value = freq * (i === 2 ? 0.5 : 1); osc.detune.value = (i - 1) * det; } catch (_) { /* stub */ }
      const g = ctx.createGain();
      const tail = env(g, t, { a: o.a, d: o.d, s: o.s, r: o.r, peak: vol * (i === 2 ? 0.7 : 1), dur });
      osc.connect(g); g.connect(f);
      osc.start(t); osc.stop(t + tail + 0.2);
    }
  }

  // A sine foundation with a sub octave, optional detuned partner, and glide.
  // Kit 1.7.1: o.sub === 0/false disables the sub; o.hp:<Hz> adds an optional
  // high-pass before the lowpass (default off — no HP node when absent).
  function drone(t, freq, dur, o = {}) {
    o = { ...resolvedVoiceDefaults.drone, ...o };
    const o1 = ctx.createGain(); o1.gain.value = 1; o1.connect(dry());
    sendAll(o1, o);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    try { f.frequency.value = o.cut; f.Q.value = o.q; } catch (_) { /* stub */ }
    f.connect(o1);
    let voiceIn = f;
    if (o.hp) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      try { hp.frequency.value = o.hp; } catch (_) { /* stub */ }
      hp.connect(f);
      voiceIn = hp;
    }
    const vol = o.vol;
    const partners = o.beat ? [0, o.beat] : [0];
    const layers = voiceSubEnabled(o) ? [[1, 1], [0.5, 0.7]] : [[1, 1]];
    for (const cents of partners) {
      for (const [mult, level] of layers) {
        const osc = ctx.createOscillator();
        osc.type = o.wave;
        try {
          osc.frequency.setValueAtTime(freq * mult, t);
          if (o.glide) osc.frequency.linearRampToValueAtTime(noteFreq(o.glide) * mult, t + dur);
          osc.detune.value = cents;
        } catch (_) { /* stub */ }
        const g = ctx.createGain();
        const tail = env(g, t, { a: o.a, d: o.d, s: o.s, r: o.r, peak: vol * level, dur });
        osc.connect(g); g.connect(voiceIn);
        osc.start(t); osc.stop(t + tail + 0.2);
      }
    }
  }

  // Sparse events: a configurable stack of sine partials.
  function bell(t, freq, dur, o = {}) {
    o = { ...resolvedVoiceDefaults.bell, ...o };
    const o1 = ctx.createGain(); o1.gain.value = 1; o1.connect(dry());
    sendAll(o1, o);
    const ratios = o.ratios;
    const levels = o.levels;
    const vol = o.vol;
    for (let i = 0; i < ratios.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      try { osc.frequency.value = freq * ratios[i]; } catch (_) { /* stub */ }
      const g = ctx.createGain();
      const tail = env(g, t, { a: o.a, d: dur * o.dScale, s: o.s, r: o.r, peak: vol * (levels[i] === undefined ? 0.1 : levels[i]), dur: dur * o.holdScale });
      osc.connect(g); g.connect(o1);
      osc.start(t); osc.stop(t + tail + 0.4);
    }
  }

  function pluck(t, freq, dur, o = {}) {
    o = { ...resolvedVoiceDefaults.pluck, ...o };
    const o1 = ctx.createGain(); o1.gain.value = 1; o1.connect(dry());
    sendAll(o1, o);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    const cut = o.cut;
    try {
      f.frequency.setValueAtTime(cut, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(120, cut * 0.18), t + Math.max(0.05, dur));
    } catch (_) { /* stub */ }
    f.connect(o1);
    const osc = ctx.createOscillator();
    osc.type = o.wave;
    try { osc.frequency.value = freq; } catch (_) { /* stub */ }
    const g = ctx.createGain();
    const tail = env(g, t, { a: o.a, d: dur * o.dScale, s: o.s, r: o.r, peak: o.vol, dur: dur * o.holdScale });
    osc.connect(g); g.connect(f);
    osc.start(t); osc.stop(t + tail + 0.3);
  }

  // Kit 1.7.1: o.sub === 0/false disables the forced sine sub (freq*0.5 @ 0.6).
  function bass(t, freq, dur, o = {}) {
    o = { ...resolvedVoiceDefaults.bass, ...o };
    const o1 = ctx.createGain(); o1.gain.value = 1; o1.connect(dry());
    sendAll(o1, o);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    try { f.frequency.value = o.cut; f.Q.value = o.q; } catch (_) { /* stub */ }
    f.connect(o1);
    const vol = o.vol;
    const layers = voiceSubEnabled(o)
      ? [[o.wave, 1, 1], ['sine', 0.5, 0.6]]
      : [[o.wave, 1, 1]];
    for (const [wave, mult, level] of layers) {
      const osc = ctx.createOscillator();
      osc.type = wave;
      try { osc.frequency.value = freq * mult; } catch (_) { /* stub */ }
      const g = ctx.createGain();
      const tail = env(g, t, { a: o.a, d: dur * o.dScale, s: o.s, r: o.r, peak: vol * level, dur: dur * o.holdScale });
      osc.connect(g); g.connect(f);
      osc.start(t); osc.stop(t + tail + 0.3);
    }
  }

  function lead(t, freq, dur, o = {}) {
    o = { ...resolvedVoiceDefaults.lead, ...o };
    const o1 = ctx.createGain(); o1.gain.value = 1; o1.connect(dry());
    sendAll(o1, o);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    try { f.frequency.value = o.cut; f.Q.value = o.q; } catch (_) { /* stub */ }
    f.connect(o1);
    const osc = ctx.createOscillator();
    osc.type = o.wave;
    try {
      if (o.grace) {
        const graceFreq = freq * (2 ** (o.grace / 12));
        osc.frequency.setValueAtTime(graceFreq, t);
        osc.frequency.exponentialRampToValueAtTime(freq, t + Math.min(o.graceTime, dur));
      } else {
        osc.frequency.value = freq;
      }
    } catch (_) { /* stub */ }
    // A touch of vibrato so a sustained lead is not a test tone.
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    try { lfo.frequency.value = o.vibrato; lg.gain.value = freq * o.vibratoDepth; } catch (_) { /* stub */ }
    lfo.connect(lg); lg.connect(osc.frequency);
    const g = ctx.createGain();
    const tail = env(g, t, { a: o.a, d: o.d, s: o.s, r: o.r, peak: o.vol, dur });
    osc.connect(g); g.connect(f);
    osc.start(t); osc.stop(t + tail + 0.4);
    lfo.start(t); lfo.stop(t + tail + 0.4);
  }

  // Texture: the shared seeded noise buffer through a swept band.
  function air(t, dur, o = {}) {
    o = { ...resolvedVoiceDefaults.air, ...o };
    if (!noiseBuf) return;
    const o1 = ctx.createGain(); o1.gain.value = 1; o1.connect(dry());
    sendAll(o1, o);
    const f = ctx.createBiquadFilter();
    f.type = o.type;
    const bp = o.bp;
    try {
      f.frequency.setValueAtTime(bp, t);
      f.frequency.linearRampToValueAtTime(bp * o.sweep, t + dur);
      f.Q.value = o.q;
    } catch (_) { /* stub */ }
    // src -> filter -> envelope gain -> bus
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const g = ctx.createGain();
    const tail = env(g, t, { a: o.a === undefined ? dur * o.attackScale : o.a, d: dur * o.decayScale, s: o.s, r: o.r, peak: o.vol, dur });
    src.connect(f); f.connect(g); g.connect(o1);
    src.start(t); src.stop(t + tail + 0.3);
  }

  // --- percussion -----------------------------------------------------------
  function kick(t, o = {}) {
    o = { ...resolvedVoiceDefaults.kick, ...o };
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    try {
      osc.frequency.setValueAtTime(o.f0, t);
      osc.frequency.exponentialRampToValueAtTime(o.f1, t + 0.11);
    } catch (_) { /* stub */ }
    const g = ctx.createGain();
    const dur = o.dur;
    try {
      g.gain.setValueAtTime(o.vol, t);
      g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    } catch (_) { /* stub */ }
    osc.connect(g); g.connect(dry());
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  function snare(t, o = {}) {
    o = { ...resolvedVoiceDefaults.snare, ...o };
    if (!noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    try { f.frequency.value = o.bp; f.Q.value = o.q; } catch (_) { /* stub */ }
    const g = ctx.createGain();
    const dur = o.dur;
    try {
      g.gain.setValueAtTime(o.vol, t);
      g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    } catch (_) { /* stub */ }
    src.connect(f); f.connect(g); g.connect(dry());
    sendAll(g, o);
    src.start(t); src.stop(t + dur + 0.05);
  }

  function hat(t, o = {}) {
    o = { ...resolvedVoiceDefaults.hat, ...o };
    if (!noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    try { f.frequency.value = o.hp; } catch (_) { /* stub */ }
    const g = ctx.createGain();
    const dur = o.dur;
    try {
      g.gain.setValueAtTime(o.vol, t);
      g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    } catch (_) { /* stub */ }
    src.connect(f); f.connect(g); g.connect(dry());
    sendAll(g, o);
    src.start(t); src.stop(t + dur + 0.05);
  }

  // ==========================================================================
  // CHIP VOICES + TRACKER-FX ENGINE
  // ==========================================================================

  const FX_TYPES = new Set(['arp', 'porta', 'slideUp', 'slideDown', 'vibrato', 'cut', 'retrig', 'duty', 'dutySweep', 'volSlide', 'tremolo']);

  function validateFxEntry(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || !FX_TYPES.has(e.type)) return null;
    const tick = typeof e.tick === 'number' && Number.isFinite(e.tick) && e.tick >= 0 ? e.tick : 0;
    return { ...e, tick };
  }

  function semitonesToRatio(semitones) {
    return Math.pow(2, semitones / 12);
  }

  function ratioToSemitones(ratio) {
    return Math.log2(ratio) * 12;
  }

  function resolveFreq(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : noteFreq(value);
  }

  function buildChipTimeline(baseFreq, dur, opts) {
    const tickDur = Math.max(0.001, opts.tickDuration);
    const ticks = Math.max(1, Math.floor(dur / tickDur));
    const rawFx = Array.isArray(opts.fx) ? opts.fx.map(validateFxEntry).filter(Boolean) : [];

    const arpEntry = rawFx.find((e) => e.type === 'arp');
    const arpIntervals = Array.isArray(arpEntry?.intervals) && arpEntry.intervals.length > 0
      ? arpEntry.intervals
      : [0];

    let portaTarget = null;
    let portaRate = 0;
    let slideRate = 0;
    let volSlideRate = 0;
    let dutyEnd = opts.dutySweep;
    let cutTick = Infinity;
    const dutyEvents = [];
    const retrigTicks = new Set();
    const vibrato = rawFx.find((e) => e.type === 'vibrato') || null;
    const tremolo = rawFx.find((e) => e.type === 'tremolo') || null;

    for (const e of rawFx) {
      if (e.type === 'porta') { portaTarget = resolveFreq(e.target); portaRate = Math.abs(e.rate || 0); }
      else if (e.type === 'slideUp') slideRate = Math.abs(e.rate || 0);
      else if (e.type === 'slideDown') slideRate = -Math.abs(e.rate || 0);
      else if (e.type === 'volSlide') volSlideRate = e.rate || 0;
      else if (e.type === 'cut') cutTick = Math.min(cutTick, e.tick);
      else if (e.type === 'duty') dutyEvents.push({ tick: e.tick, value: e.value });
      else if (e.type === 'retrig') {
        let tick = e.tick ?? 0;
        const every = Math.max(1, e.every ?? 1);
        while (tick < ticks) { retrigTicks.add(tick); tick += every; }
      }
    }
    dutyEvents.sort((a, b) => a.tick - b.tick);

    const timeline = [];
    let gain = 1;
    let currentFreq = baseFreq;
    for (let tick = 0; tick < ticks; tick++) {
      // Arpeggio sets the target pitch for this tick; portamento slides toward it.
      const arpFreq = baseFreq * semitonesToRatio(arpIntervals[tick % arpIntervals.length]);
      const target = portaTarget !== null ? portaTarget : arpFreq;

      if (portaRate > 0) {
        const semitones = ratioToSemitones(currentFreq / target);
        if (Math.abs(semitones) > portaRate) {
          currentFreq *= semitonesToRatio(semitones > 0 ? -portaRate : portaRate);
        } else {
          currentFreq = target;
        }
      } else {
        currentFreq = target;
      }

      // Free pitch slide adds a per-tick offset.
      currentFreq *= semitonesToRatio(slideRate);

      // Volume slide.
      gain = Math.max(0, gain + volSlideRate);

      // Note cut.
      if (tick >= cutTick) gain = 0;

      // Duty: explicit events override a smooth sweep.
      let duty = opts.duty;
      if (dutyEnd !== null && dutyEvents.length === 0) {
        duty = opts.duty + (dutyEnd - opts.duty) * (tick / Math.max(1, ticks - 1));
      }
      for (const de of dutyEvents) {
        if (de.tick === tick) duty = de.value;
      }

      timeline.push({
        tick,
        time: t => t + tick * tickDur,
        freq: currentFreq,
        gain,
        duty: clamp01(duty),
        retrigger: retrigTicks.has(tick),
      });
    }

    return { tickDur, ticks, timeline, vibrato, tremolo };
  }

  function makeChipSegmentFilter(o) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    try { f.frequency.value = o.cut; f.Q.value = o.q; } catch (_) { /* stub */ }
    return f;
  }

  function scheduleChipGain(g, t, peak, dur, timeline, tickDur, tremolo, o) {
    const end = t + dur;
    try {
      // Main ADSR envelope — same continuous-ramp rule as env() (no mid-envelope
      // setValueAtTime anchors). Tracker fx below may still punch the gain for
      // musical cut/retrig; those are intentional transient events.
      const attack = Math.max(EPS * 2, o.a);
      const decay = Math.max(EPS * 2, o.d);
      const sustain = Math.max(EPS * 2, peak * o.s);
      const decayEnd = t + attack + decay;
      g.gain.setValueAtTime(EPS, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(sustain, decayEnd);
      if (end > decayEnd) {
        g.gain.linearRampToValueAtTime(sustain, end);
      }
      g.gain.exponentialRampToValueAtTime(EPS, end + Math.max(EPS * 2, o.r));

      // Per-tick gain changes (volume slide, note cut, retrigger gates).
      // These are intentional tracker-fx transients — not the ADSR hold-anchor class.
      for (const ev of timeline) {
        const et = ev.time(t);
        if (et >= end) break;
        g.gain.setValueAtTime(Math.max(EPS, peak * ev.gain), et);
        if (ev.retrigger && et > t) {
          g.gain.setValueAtTime(EPS, et);
          g.gain.exponentialRampToValueAtTime(Math.max(EPS, peak * ev.gain), et + 0.003);
        }
      }

      // Tremolo LFO on a separate gain node would be cleaner; schedule here as
      // a coarse amplitude wobble if no LFO is available in the stub context.
      if (tremolo && tremolo.rate > 0 && tremolo.depth > 0) {
        const delay = tremolo.delay || 0;
        const rate = tremolo.rate;
        const depth = tremolo.depth;
        const cycles = Math.floor((dur - delay) * rate);
        for (let i = 0; i <= cycles; i++) {
          const et = t + delay + i / rate;
          if (et >= end) break;
          const level = 1 - depth * 0.5 * (1 - Math.cos(i * Math.PI));
          g.gain.setValueAtTime(Math.max(EPS, peak * level), et);
        }
      }
    } catch (_) { /* stub */ }
  }

  function chipPulse(t, freq, dur, o = {}) {
    o = { ...resolvedVoiceDefaults.chipPulse, ...o };
    const tl = buildChipTimeline(freq, dur, o);
    const filter = makeChipSegmentFilter(o);
    filter.connect(dry());
    sendAll(filter, o);
    const masterGain = ctx.createGain();
    masterGain.connect(filter);
    scheduleChipGain(masterGain, t, o.vol, dur, tl.timeline, tl.tickDur, tl.tremolo, o);

    // Group timeline into segments of constant duty.
    const segments = [];
    let current = { duty: tl.timeline[0].duty, startTick: 0 };
    for (let i = 1; i <= tl.timeline.length; i++) {
      const nextDuty = i < tl.timeline.length ? tl.timeline[i].duty : null;
      if (nextDuty === null || Math.abs(nextDuty - current.duty) > 0.001) {
        segments.push({ ...current, endTick: i });
        if (nextDuty !== null) current = { duty: nextDuty, startTick: i };
      }
    }

    const stopTime = t + dur + Math.max(o.r, 0.05);
    const vibratoNodes = [];
    for (const seg of segments) {
      const wave = getPulseWave(seg.duty);
      if (!wave) continue;
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      const segGain = ctx.createGain();
      segGain.gain.value = 1;
      try {
        // Frequency track: ramp between tick frequencies.
        for (let i = seg.startTick; i < seg.endTick; i++) {
          const ev = tl.timeline[i];
          const et = ev.time(t);
          const next = tl.timeline[i + 1];
          if (i === seg.startTick) osc.frequency.setValueAtTime(ev.freq, et);
          if (next) {
            osc.frequency.linearRampToValueAtTime(next.freq, next.time(t));
          } else {
            osc.frequency.setValueAtTime(ev.freq, et);
          }
        }
      } catch (_) { /* stub */ }

      // Crossfade segment edges to avoid clicks at duty changes.
      //
      // KIT 1.9.0 BUG FIX — the release used to be inaudible. The final segment
      // closed its gate at `t + dur`, which is where the note's SUSTAIN ends;
      // masterGain's release ramp then ran from t+dur to t+dur+r against a
      // segment gain already pinned at EPS, so every chip pulse decayed at
      // -80 dB no matter what `r` said. Measured before the fix: a 32x release
      // sweep (0.05s -> 1.6s) moved the audible end of the note by 0.0000s.
      //
      // The last segment now holds open to `stopTime`, which is exactly where
      // masterGain's release reaches EPS, so the ADSR owns the note's end and
      // the gate owns only the duty-change crossfades it was written for.
      const fade = Math.min(tl.tickDur * 0.25, 0.003);
      const startT = tl.timeline[seg.startTick].time(t);
      const isFinalSegment = seg.endTick >= tl.timeline.length;
      const endT = isFinalSegment ? stopTime : tl.timeline[seg.endTick].time(t);
      try {
        segGain.gain.setValueAtTime(EPS, startT);
        segGain.gain.linearRampToValueAtTime(1, startT + fade);
        if (isFinalSegment) {
          // Hold wide open; the envelope closes the note.
          segGain.gain.setValueAtTime(1, endT);
        } else if (endT - startT > fade * 2) {
          segGain.gain.setValueAtTime(1, endT - fade);
          segGain.gain.linearRampToValueAtTime(EPS, endT);
        }
      } catch (_) { /* stub */ }

      osc.connect(segGain); segGain.connect(masterGain);
      osc.start(startT); osc.stop(stopTime);
      vibratoNodes.push(osc);
    }

    // Per-note vibrato adds an LFO on frequency above any tracker pitch effects.
    if (o.vibrato > 0 && o.vibratoDepth > 0 && vibratoNodes.length > 0) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      try {
        lfo.frequency.value = o.vibrato;
        lg.gain.value = freq * o.vibratoDepth;
        const delay = Math.max(0, o.vibratoDelay);
        if (delay > 0) {
          lg.gain.setValueAtTime(0, t);
          lg.gain.linearRampToValueAtTime(freq * o.vibratoDepth, t + delay);
        }
      } catch (_) { /* stub */ }
      lfo.connect(lg);
      for (const osc of vibratoNodes) lg.connect(osc.frequency);
      lfo.start(t); lfo.stop(stopTime);
    }
  }

  function chipTriangle(t, freq, dur, o = {}) {
    o = { ...resolvedVoiceDefaults.chipTriangle, ...o };
    const tl = buildChipTimeline(freq, dur, o);
    const filter = makeChipSegmentFilter(o);
    filter.connect(dry());
    sendAll(filter, o);
    const masterGain = ctx.createGain();
    masterGain.connect(filter);
    scheduleChipGain(masterGain, t, o.vol, dur, tl.timeline, tl.tickDur, tl.tremolo, o);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const stopTime = t + dur + Math.max(o.r, 0.05);
    try {
      for (let i = 0; i < tl.timeline.length; i++) {
        const ev = tl.timeline[i];
        const et = ev.time(t);
        const next = tl.timeline[i + 1];
        if (i === 0) osc.frequency.setValueAtTime(ev.freq, et);
        if (next) osc.frequency.linearRampToValueAtTime(next.freq, next.time(t));
      }
    } catch (_) { /* stub */ }
    osc.connect(masterGain);
    osc.start(t); osc.stop(stopTime);

    if (o.vibrato > 0 && o.vibratoDepth > 0) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      try {
        lfo.frequency.value = o.vibrato;
        lg.gain.value = freq * o.vibratoDepth;
        const delay = Math.max(0, o.vibratoDelay);
        if (delay > 0) {
          lg.gain.setValueAtTime(0, t);
          lg.gain.linearRampToValueAtTime(freq * o.vibratoDepth, t + delay);
        }
      } catch (_) { /* stub */ }
      lfo.connect(lg); lg.connect(osc.frequency);
      lfo.start(t); lfo.stop(stopTime);
    }
  }

  function chipNoise(t, freq, dur, o = {}) {
    o = { ...resolvedVoiceDefaults.chipNoise, ...o };
    const tl = buildChipTimeline(freq, dur, o);
    const filter = makeChipSegmentFilter(o);
    filter.connect(dry());
    sendAll(filter, o);
    const masterGain = ctx.createGain();
    masterGain.connect(filter);
    scheduleChipGain(masterGain, t, o.vol, dur, tl.timeline, tl.tickDur, tl.tremolo, o);

    const buf = o.mode === 'periodic' ? chipNoiseBufs.periodic : chipNoiseBufs.white;
    if (!buf) return;

    const stopTime = t + dur + Math.max(o.r, 0.05);
    const vibratoSources = [];
    // One buffer source per RETRIGGER (plus the note's own onset), so retrigger
    // and pitch envelopes restart cleanly.
    //
    // KIT 1.9.0 BUG FIX — this loop only ever starts a source at tick 0 and at
    // retrigger ticks, but it used to close each source's gate at the NEXT TICK
    // (`timeline[i + 1]`) rather than at the next source. A note with no
    // retriggers therefore sounded for one tick — 20 ms at the default
    // tickDuration — and then sat at EPS for the rest of its length, release
    // included. Measured before the fix: a 0.4 s note ended 0.0588 s in, flat
    // across a 32x release sweep. Each source now runs until the next source
    // starts, and the last one until `stopTime`, so masterGain's ADSR owns the
    // note exactly as it does for chipTriangle.
    const sourceTicks = tl.timeline
      .map((ev, index) => ((index === 0 || ev.retrigger) ? index : -1))
      .filter((index) => index >= 0);
    for (let s = 0; s < sourceTicks.length; s++) {
      const i = sourceTicks[s];
      const ev = tl.timeline[i];
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const segGain = ctx.createGain();
      segGain.gain.value = 1;
      const startT = ev.time(t);
      const isFinalSource = s + 1 >= sourceTicks.length;
      const endT = isFinalSource ? stopTime : tl.timeline[sourceTicks[s + 1]].time(t);
      try {
        // Pitch envelope: f0 -> f1 over the note, scaled by tracker pitch effects.
        const startRate = (o.f0 !== null && o.f0 !== undefined ? o.f0 : freq) / 440;
        const endRate = (o.f1 !== null && o.f1 !== undefined ? o.f1 : freq) / 440;
        const pitchScale = ev.freq / freq;
        src.playbackRate.setValueAtTime(startRate * pitchScale, startT);
        src.playbackRate.linearRampToValueAtTime(endRate * pitchScale, Math.min(endT, t + dur));
      } catch (_) { /* stub */ }
      try {
        const fade = Math.min(tl.tickDur * 0.25, 0.002);
        segGain.gain.setValueAtTime(EPS, startT);
        segGain.gain.linearRampToValueAtTime(1, startT + fade);
        if (endT - startT > fade * 2) {
          segGain.gain.setValueAtTime(1, endT - fade);
          segGain.gain.linearRampToValueAtTime(EPS, endT);
        }
      } catch (_) { /* stub */ }
      src.connect(segGain); segGain.connect(masterGain);
      src.start(startT); src.stop(stopTime);
      vibratoSources.push(src);
    }

    // Noise vibrato modulates playbackRate.
    if (o.vibrato > 0 && o.vibratoDepth > 0 && vibratoSources.length > 0) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      try {
        lfo.frequency.value = o.vibrato;
        lg.gain.value = o.vibratoDepth;
        const delay = Math.max(0, o.vibratoDelay);
        if (delay > 0) {
          lg.gain.setValueAtTime(0, t);
          lg.gain.linearRampToValueAtTime(o.vibratoDepth, t + delay);
        }
      } catch (_) { /* stub */ }
      lfo.connect(lg);
      for (const src of vibratoSources) lg.connect(src.playbackRate);
      lfo.start(t); lfo.stop(stopTime);
    }
  }

  const voices = { pad, drone, bell, pluck, bass, lead, air, kick, snare, hat, chipPulse, chipTriangle, chipNoise };

  function performanceVoices(absoluteStep, stepIndex, stepSeconds) {
    const calls = Object.create(null);
    function schedule(name, role, given) {
      const voice = voices[name];
      if (typeof voice !== 'function') throw new Error(`voice "${name}" is unavailable`);
      const args = [...given];
      const call = calls[name] ?? 0;
      calls[name] = call + 1;
      const adjusted = resolvedPerformance
        ? performanceAdjustment(resolvedPerformance, {
            seed: rngSeed, absoluteStep, stepIndex, stepSeconds, voice: name, call,
          })
        : { timeSeconds: 0, velocity: 0, releaseTail: 0 };
      const doctrine = role === undefined || registerClass === undefined
        ? { timeSeconds: 0 }
        : doctrineAdjustment(registerClass, role);
      const optionIndex = VOICE_OPTION_INDEX[name];
      const authored = args[optionIndex] || {};
      // Kit 1.7.1: per-event nudge (milliseconds) applied at schedule time.
      // Default 0 when absent — byte-identical with prior kits.
      const nudgeSeconds = (Number(authored.nudge) || 0) / 1000;
      args[0] = Math.max(0, Number(args[0]) + adjusted.timeSeconds + doctrine.timeSeconds + nudgeSeconds);
      if (adjusted.velocity !== 0 || adjusted.releaseTail !== 0) {
        const played = { ...authored };
        if (adjusted.velocity !== 0) {
          const baseVol = authored.vol === undefined ? resolvedVoiceDefaults[name].vol : authored.vol;
          played.vol = Math.max(0, baseVol * (1 + adjusted.velocity));
        }
        if (adjusted.releaseTail !== 0) {
          const baseRelease = authored.r === undefined ? resolvedVoiceDefaults[name].r : authored.r;
          played.r = baseRelease + adjusted.releaseTail;
        }
        args[optionIndex] = played;
      }
      return voice(...args);
    }
    const wrapped = Object.fromEntries(Object.keys(voices).map((name) => [name, (...given) => schedule(name, undefined, given)]));
    return Object.freeze({
      voices: wrapped,
      play(role, name, ...given) {
        if (!VOICE_ROLE_SET.has(role)) throw new TypeError(`role: must be one of ${VOICE_ROLES.join(', ')}`);
        return schedule(name, role, given);
      },
    });
  }

  // ==========================================================================
  // SCHEDULER — lookahead step scheduling against ctx.currentTime
  // ==========================================================================
  const tracks = new Map();
  let cur = null, curName = null;
  let step = 0, nextTime = 0;
  let params = {};
  let executionContext = Object.freeze({
    sectionIndex: -1,
    environmentPass: 0,
    sectionKind: null,
    mutationEvery: null,
    mutationId: null,
  });
  let timer = null;
  const stepErrors = [];

  function registerTrack(name, spec) {
    if (!name || !spec || typeof spec.step !== 'function') throw new Error('registerTrack: needs { bpm, len, step }');
    tracks.set(name, {
      bpm: spec.bpm || 60,
      len: Math.max(1, spec.len | 0 || 16),
      vol: spec.vol === undefined ? 0.8 : spec.vol,
      step: spec.step,
    });
    return name;
  }

  /**
   * Schedule every step falling inside the lookahead window. Callable by hand
   * (the tests do exactly this) or driven by start()'s timer. Returns how many
   * steps it scheduled.
   */
  function tick(now) {
    now = readNow(now);
    sweepRetired(now);
    if (!cur) return 0;
    const spb = 60 / cur.bpm / 4;
    let scheduled = 0;
    while (nextTime < now + lookahead && scheduled < MAX_STEPS_PER_TICK) {
      if (nextTime < now) nextTime = now + 0.03;
      const i = step % cur.len;
      const n = step;
      try {
        const performed = performanceVoices(n, i, spb);
        cur.step(i, nextTime, {
          v: performed.voices,
          play: performed.play,
          i, n, bar: (i / 16) | 0, params,
          registerClass,
          clock: Object.freeze({
            micro: i,
            phrase: Math.floor(n / cur.len),
            environment: executionContext.environmentPass,
            sectionIndex: executionContext.sectionIndex,
            sectionKind: executionContext.sectionKind,
            mutationEvery: executionContext.mutationEvery,
            mutationId: executionContext.mutationId,
          }),
          rand: (salt = 0) => hash2(n, salt | 0, rngSeed),
        });
      } catch (cause) {
        if (strict) {
          stepErrors.push(new BandStepError({
            track: curName,
            index: i,
            absoluteStep: n,
            scheduledTime: nextTime,
            cause,
          }));
        }
        // Tolerant live/game mode intentionally continues scheduling. Strict
        // authoring callers inspect stepErrors and fail the render as a unit.
      }
      step += 1;
      nextTime += spb;
      scheduled += 1;
    }
    return scheduled;
  }

  /**
   * Change track with a crossfade. Same name is a no-op (so a shell may call
   * this every frame). `null` fades to silence. Returns true if it switched.
   */
  function setTrack(name, o = {}) {
    if (name === curName) return false;
    // o.now lets a headless renderer drive the clock when ctx.currentTime is
    // frozen (OfflineAudioContext before startRendering). Live callers omit it.
    const now = readNow(o.now);
    retire(bus, now);
    bus = null;
    curName = name;
    cur = name ? tracks.get(name) || null : null;
    step = 0;
    if (!cur) return true;
    const incomingFade = o.fadeIn === undefined ? fadeIn : o.fadeIn;
    bus = makeBus(cur.vol, now, incomingFade);
    ramp(bus.out.gain, EPS, cur.vol, now, incomingFade);
    ramp(bus.send.gain, EPS, 1, now, incomingFade);
    if (bus.fxSends) {
      for (const kind of fxSendKinds) ramp(bus.fxSends[kind].gain, EPS, 1, now, incomingFade);
    }
    nextTime = now + 0.03;
    tick(now); // begin at once — no gap waiting for the driver's first wake
    return true;
  }

  /** Live intensity params. Merged, no track restart — steps read s.params. */
  function setParams(p) { params = { ...params, ...(p || {}) }; return params; }

  /** Phrase-boundary context for section-authored mutation schedules. */
  function setExecutionContext(value = {}) {
    const sectionIndex = value.sectionIndex ?? -1;
    const environmentPass = value.environmentPass ?? 0;
    if (!Number.isInteger(sectionIndex) || sectionIndex < -1) throw new TypeError('executionContext.sectionIndex: expected integer >= -1');
    if (!Number.isInteger(environmentPass) || environmentPass < 0) throw new TypeError('executionContext.environmentPass: expected non-negative integer');
    executionContext = Object.freeze({
      sectionIndex,
      environmentPass,
      sectionKind: value.sectionKind ?? null,
      mutationEvery: value.mutationEvery ?? null,
      mutationId: value.mutationId ?? null,
    });
    return executionContext;
  }

  function start() {
    if (timer || typeof setInterval !== 'function') return false;
    timer = setInterval(() => { try { tick(); } catch (_) { /* ignore */ } }, tickMs);
    if (timer && typeof timer.unref === 'function') timer.unref(); // never hold a node loop open
    return true;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    return true;
  }

  function dispose() {
    stop();
    const now = readNow();
    retire(bus, now);
    bus = null; cur = null; curName = null;
    // Free-running fx modulators (chorus LFOs) would otherwise outlive the band
    // on a live context. Offline renders are unaffected either way.
    for (const src of fxSources) {
      try { src.stop(); } catch (_) { /* already stopped or a stub */ }
    }
    try { out.disconnect(); } catch (_) { /* ignore */ }
  }

  return {
    voices,
    registerTrack,
    setTrack,
    setParams,
    setExecutionContext,
    tick,
    start,
    stop,
    dispose,
    setGain: (v) => { try { out.gain.value = clamp01(v); } catch (_) { /* ignore */ } },
    get track() { return curName; },
    get step() { return step; },
    get params() { return { ...params }; },
    get trackNames() { return [...tracks.keys()]; },
    get retiringCount() { return retiring.length; },
    get stepErrors() { return [...stepErrors]; },
    get buses() {
      return {
        out,
        verb,
        verbReturn,
        fx: fxPlan ? Object.freeze(Object.fromEntries(fxBuses)) : null,
        fxMaster: masterUnits,
      };
    },
    /** The resolved FX plan (frozen), or null when no fx were declared. */
    get fx() { return fxPlan; },
    /** The resolved section-boundary posture (kit 1.9.0). */
    get retire() { return Object.freeze({ mode: resolvedRetireMode, hold: resolvedRetireHold }); },
  };
}

// ---------------------------------------------------------------------------
// Generated impulse response: seeded exponentially-decaying noise. A convolver
// on a code-made IR is how you get a real reverb tail with zero assets.
// ---------------------------------------------------------------------------
function makeVerb(ctx, {
  seconds = NEUTRAL_DEFAULTS.band.reverb.seconds,
  decay = NEUTRAL_DEFAULTS.band.reverb.decay,
} = {}, seed = 1) {
  if (!ctx.createConvolver || !ctx.createBuffer) return null;
  try {
    const rate = ctx.sampleRate || 44100;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const rnd = mulberry32((seed ^ (c * 0x9e3779b9)) >>> 0);
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const x = i / len;
        d[i] = (rnd() * 2 - 1) * Math.pow(1 - x, decay) * (1 - Math.exp(-i / 200));
      }
    }
    const cv = ctx.createConvolver();
    cv.buffer = buf;
    return cv;
  } catch (_) { return null; }
}

/** Two seconds of seeded white noise, shared by every noise voice. */
function makeNoise(ctx, seed = 1) {
  if (!ctx.createBuffer) return null;
  try {
    const rate = ctx.sampleRate || 44100;
    const buf = ctx.createBuffer(1, rate * 2, rate);
    const rnd = mulberry32(seed >>> 0);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
    return buf;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Chip voice support: exact pulse waves and deterministic noise buffers.
// ---------------------------------------------------------------------------

const PULSE_DUTIES = Object.freeze([0.125, 0.25, 0.5, 0.75]);
const MAX_PULSE_HARMONICS = 128;

/** Fourier series for a unit-amplitude pulse of the given duty cycle (0..1). */
function makePulseWave(ctx, duty) {
  if (!ctx.createPeriodicWave) return null;
  duty = clamp01(duty);
  const real = new Float32Array(MAX_PULSE_HARMONICS + 1);
  const imag = new Float32Array(MAX_PULSE_HARMONICS + 1);
  real[0] = duty * 2 - 1;
  for (let n = 1; n <= MAX_PULSE_HARMONICS; n++) {
    real[n] = (4 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  }
  try {
    return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  } catch (_) { return null; }
}

/** Seeded buffers for the chip noise channel: white and periodic/looped. */
function makeChipNoise(ctx, seed = 1) {
  if (!ctx.createBuffer) return { white: null, periodic: null };
  const rate = ctx.sampleRate || 44100;
  const rnd = mulberry32(seed >>> 0);
  try {
    const whiteLen = rate * 2;
    const white = ctx.createBuffer(1, whiteLen, rate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < whiteLen; i++) wd[i] = rnd() * 2 - 1;

    // A short deterministic loop: 31 samples gives a recognisably pitched noise.
    const periodLen = 31;
    const periodic = ctx.createBuffer(1, periodLen, rate);
    const pd = periodic.getChannelData(0);
    for (let i = 0; i < periodLen; i++) pd[i] = rnd() * 2 - 1;

    return { white, periodic };
  } catch (_) { return { white: null, periodic: null }; }
}
