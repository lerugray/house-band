/**
 * Structural score-audit library.
 *
 * Consumes a composed House Band score artifact (JSON or ES module) and measures
 * mechanical tells from note DATA — no audio rendering, no listening.
 */

import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeHarmonicState } from './harmonic-state.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Amendment A applies prospectively. These were the repository's complete set
// of score-shaped artifacts when Ray ratified the gate on 2026-08-21.
export const HSMD_GRANDFATHERED_SCORE_PATHS = Object.freeze([
  'examples/chipfx-audition-spec.json',
  'examples/demo-spec.json',
  'examples/m3-sample-spec.json',
  'listen/house-band-performance-pass-after-2026-08-15.score.json',
  'listen/house-band-performance-pass-before-2026-08-15.score.json',
  'test/fixtures/golden-spec.json',
  'tools/score-audit/fixtures/humanized.json',
  'tools/score-audit/fixtures/mechanical.json',
  'tools/score-audit/fixtures/score-module.mjs',
]);
const HSMD_GRANDFATHERED_SCORE_SET = new Set(HSMD_GRANDFATHERED_SCORE_PATHS);

// ---------------------------------------------------------------------------
// Thresholds — chosen to catch obvious mechanical tells without chasing nuance.
// ---------------------------------------------------------------------------
export const THRESHOLDS = Object.freeze({
  // Onset residuals tighter than this are treated as "on the grid".
  gridMs: 1.0,
  // Velocity/gain range smaller than this is "constant".
  velocity: 0.001,
  // Lead note total length (dur + release) range smaller than this is "constant".
  releaseSeconds: 0.01,
  // Minimum note count before variance metrics are meaningful.
  minNotes: 2,
  // Lead-release constancy is only judged on voices with a real melodic line;
  // short accent voices (8-note bell/chipTriangle stabs) legitimately hold one
  // authored release and must not trip the flag (false-positive on a sample project, 2026-08-21).
  minLeadNotes: 12,
});

export const LEAD_VOICES = Object.freeze(new Set(['lead', 'chipPulse', 'chipTriangle']));
export const PITCHED_VOICES = Object.freeze(new Set([
  'pad', 'drone', 'bell', 'pluck', 'bass', 'lead', 'air',
  'chipPulse', 'chipTriangle', 'chipNoise',
]));

// Default release values from src/kit/band.js NEUTRAL_DEFAULTS, used only when
// a lead voice omits opts.r.
const DEFAULT_RELEASE = Object.freeze({
  lead: 0.2,
  chipPulse: 0.12,
  chipTriangle: 0.12,
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadScore(path) {
  if (!path) throw new Error('loadScore: path is required');
  if (path.endsWith('.json')) {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text);
  }
  if (path.endsWith('.mjs') || path.endsWith('.js')) {
    const url = pathToFileURL(path).href;
    const mod = await import(url);
    const score = mod.default ?? mod.score ?? null;
    if (!score || typeof score !== 'object') {
      throw new Error(`loadScore: module ${path} must export a default score object or a named "score" export`);
    }
    return score;
  }
  throw new Error(`loadScore: unsupported score format for ${path}; expected .json or .mjs`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPitched(voice) {
  return PITCHED_VOICES.has(voice);
}

function eventVoice(event) {
  return event.voice ?? event.v ?? null;
}

function eventOpts(event) {
  return event.opts ?? event.o ?? {};
}

function resolveBpm(score, track) {
  return track.bpm ?? score.tempo ?? 120;
}

function stepSeconds(bpm) {
  return 60 / bpm / 4;
}

function expandIndices(event, trackLen) {
  if (event.i !== undefined) {
    return Array.isArray(event.i) ? [...event.i] : [event.i];
  }
  if (event.every !== undefined) {
    const out = [];
    for (let i = 0; i < trackLen; i += event.every) out.push(i);
    return out;
  }
  return [];
}

function noteRoot(note) {
  if (!note || typeof note !== 'string') return null;
  const m = /^([A-G][#b]?)/.exec(note);
  return m ? m[1] : null;
}

function notePitch(note, freq) {
  if (typeof note === 'string') {
    const match = /^([A-G])([#b]?)(-?\d)$/.exec(note);
    if (match) {
      const naturals = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
      const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
      return 12 * (Number(match[3]) + 1) + naturals[match[1]] + accidental;
    }
  }
  if (Number.isFinite(freq) && freq > 0) return Math.round(69 + 12 * Math.log2(freq / 440));
  return null;
}

function harmonicRole(voice) {
  if (voice === 'chipNoise') return 'unpitched';
  if (voice === 'drone') return 'harmony';
  if (voice === 'chipPulse' || voice === 'chipTriangle') return 'lead';
  return voice;
}

function uniqueRoots(events) {
  const roots = new Set();
  for (const ev of events) {
    const root = noteRoot(ev.note);
    if (root) roots.add(root);
  }
  return roots;
}

function hasHumanizeTiming(score, voice) {
  const global = score.performance?.humanize?.timingMs;
  if (global && Array.isArray(global) && global[1] - global[0] > 0) return true;
  const perVoice = score.performance?.voices?.[voice]?.humanize?.timingMs;
  if (perVoice && Array.isArray(perVoice) && perVoice[1] - perVoice[0] > 0) return true;
  return false;
}

function hasHumanizeVelocity(score, voice) {
  const global = score.performance?.humanize?.velocity;
  if (global && Array.isArray(global) && global[1] - global[0] > 0) return true;
  const perVoice = score.performance?.voices?.[voice]?.humanize?.velocity;
  if (perVoice && Array.isArray(perVoice) && perVoice[1] - perVoice[0] > 0) return true;
  return false;
}

function range(values) {
  if (values.length === 0) return 0;
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Event expansion across sections
// ---------------------------------------------------------------------------

/**
 * Flatten every authored note-on event in the score into a single array.
 * Each item carries: voice, onsetSeconds, stepSeconds (of its track), note/freq,
 * dur, vol, release, sectionIndex, loopIndex.
 */
function flattenEvents(score) {
  const events = [];
  let sectionStart = 0;
  let sectionStartBeat = 0;
  const sections = score.sections ?? [];

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex];
    const track = score.tracks?.[section.track];
    if (!track) {
      sectionStartBeat += (section.bars ?? 1) * 4;
      continue;
    }
    const bpm = resolveBpm(score, track);
    const sStep = stepSeconds(bpm);
    const trackLen = track.len ?? 16;
    const loopSeconds = trackLen * sStep;
    const bars = section.bars ?? 1;
    const sectionSeconds = bars * 16 * sStep;
    const sectionBeats = bars * 4;
    const loopCount = sectionSeconds / loopSeconds;

    for (let loopIndex = 0; loopIndex < loopCount; loopIndex++) {
      for (const stepEvent of track.steps ?? []) {
        const voice = eventVoice(stepEvent);
        if (!voice) continue;
        const indices = expandIndices(stepEvent, trackLen);
        const opts = eventOpts(stepEvent);
        for (const idx of indices) {
          const onset = sectionStart + loopIndex * loopSeconds + idx * sStep;
          events.push({
            voice,
            onset,
            onsetBeat: sectionStartBeat + loopIndex * trackLen / 4 + idx / 4,
            stepSeconds: sStep,
            note: stepEvent.note ?? null,
            freq: stepEvent.freq ?? null,
            pitch: notePitch(stepEvent.note, stepEvent.freq),
            dur: stepEvent.dur ?? null,
            durationBeat: stepEvent.dur === undefined ? null : stepEvent.dur * bpm / 60,
            vol: opts.vol ?? null,
            release: opts.r ?? null,
            role: harmonicRole(voice),
            sectionIndex,
            loopIndex,
            stepIndex: idx,
          });
        }
      }
    }

    sectionStart += sectionSeconds;
    sectionStartBeat += sectionBeats;
  }

  return events;
}

function harmonicSections(score) {
  const definitions = [];
  let startBeat = 0;
  for (let index = 0; index < (score.sections ?? []).length; index++) {
    const section = score.sections[index];
    const beats = (section.bars ?? 1) * 4;
    definitions.push({
      index,
      label: section.label ?? section.name ?? `${section.track}#${index + 1}`,
      track: section.track,
      startBeat,
      endBeat: startBeat + beats,
    });
    startBeat += beats;
  }
  return definitions;
}

// ---------------------------------------------------------------------------
// Signature for section-similarity
// ---------------------------------------------------------------------------

function sectionSignature(score, section) {
  const track = score.tracks?.[section.track];
  if (!track) return JSON.stringify({ track: section.track, empty: true });
  const trackLen = track.len ?? 16;
  const descriptors = [];

  for (const stepEvent of track.steps ?? []) {
    const voice = eventVoice(stepEvent);
    if (!voice) continue;
    const indices = expandIndices(stepEvent, trackLen).sort((a, b) => a - b);
    const opts = eventOpts(stepEvent);
    descriptors.push({
      voice,
      positions: indices,
      note: stepEvent.note ?? null,
      freq: stepEvent.freq ?? null,
      dur: stepEvent.dur ?? null,
      release: opts.r ?? null,
      hasFx: Array.isArray(opts.fx) && opts.fx.length > 0,
    });
  }

  descriptors.sort((a, b) => {
    if (a.voice !== b.voice) return a.voice.localeCompare(b.voice);
    if (a.note !== b.note) return (a.note ?? '').localeCompare(b.note ?? '');
    return (a.positions[0] ?? 0) - (b.positions[0] ?? 0);
  });

  return JSON.stringify(descriptors);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function measureOnsetVariance(score, events) {
  const byVoice = new Map();
  for (const ev of events) {
    if (!byVoice.has(ev.voice)) byVoice.set(ev.voice, []);
    byVoice.get(ev.voice).push(ev);
  }

  const result = {};
  for (const [voice, evs] of byVoice) {
    if (evs.length < THRESHOLDS.minNotes) continue;
    const residuals = evs.map((ev) => {
      const cycles = Math.round(ev.onset / ev.stepSeconds);
      return ev.onset - cycles * ev.stepSeconds;
    });
    const r = range(residuals);
    const humanized = hasHumanizeTiming(score, voice);
    result[voice] = {
      count: evs.length,
      residualRangeMs: r * 1000,
      humanized,
      mechanical: !humanized && r * 1000 <= THRESHOLDS.gridMs,
    };
  }
  return result;
}

function measureVelocitySpread(score, events) {
  const byVoice = new Map();
  for (const ev of events) {
    if (ev.vol === null) continue; // ignore notes without explicit velocity
    if (!byVoice.has(ev.voice)) byVoice.set(ev.voice, []);
    byVoice.get(ev.voice).push(ev.vol);
  }

  const result = {};
  for (const [voice, vols] of byVoice) {
    if (vols.length < THRESHOLDS.minNotes) continue;
    const r = range(vols);
    const humanized = hasHumanizeVelocity(score, voice);
    result[voice] = {
      count: vols.length,
      range: r,
      humanized,
      mechanical: !humanized && r <= THRESHOLDS.velocity,
    };
  }

  // Also flag voices with multiple notes but zero explicit vol entries:
  // they rely entirely on kit defaults, i.e. constant velocity.
  const allByVoice = new Map();
  for (const ev of events) {
    if (!allByVoice.has(ev.voice)) allByVoice.set(ev.voice, []);
    allByVoice.get(ev.voice).push(ev);
  }
  for (const [voice, evs] of allByVoice) {
    if (evs.length < THRESHOLDS.minNotes) continue;
    if (result[voice]) continue; // already measured
    const humanized = hasHumanizeVelocity(score, voice);
    result[voice] = {
      count: evs.length,
      explicitVelocities: 0,
      range: 0,
      humanized,
      mechanical: !humanized,
    };
  }

  return result;
}

function measureLeadReleases(events) {
  const byVoice = new Map();
  for (const ev of events) {
    if (!LEAD_VOICES.has(ev.voice)) continue;
    if (!isPitched(ev.voice)) continue;
    if (ev.dur === null) continue;
    if (!byVoice.has(ev.voice)) byVoice.set(ev.voice, []);
    const release = ev.release ?? DEFAULT_RELEASE[ev.voice] ?? 0;
    byVoice.get(ev.voice).push({
      dur: ev.dur,
      release,
      total: ev.dur + release,
    });
  }

  const result = {};
  for (const [voice, notes] of byVoice) {
    if (notes.length < THRESHOLDS.minLeadNotes) continue;
    const durs = notes.map((n) => n.dur);
    const releases = notes.map((n) => n.release);
    const totals = notes.map((n) => n.total);
    result[voice] = {
      count: notes.length,
      durRange: range(durs),
      releaseRange: range(releases),
      totalRange: range(totals),
      mechanical: range(totals) <= THRESHOLDS.releaseSeconds,
    };
  }
  return result;
}

function measureSections(score) {
  const sections = score.sections ?? [];
  const signatures = sections.map((s) => sectionSignature(score, s));
  const distinct = new Set(signatures);

  return {
    count: sections.length,
    distinctTracks: new Set(sections.map((s) => s.track)).size,
    distinctSignatures: distinct.size,
    allSame: signatures.length > 0 && signatures.every((s) => s === signatures[0]),
  };
}

function measureHarmonicMovement(events) {
  const pitched = events.filter((ev) => ev.note && isPitched(ev.voice));
  const roots = uniqueRoots(pitched);
  return {
    pitchedNoteCount: pitched.length,
    distinctRoots: [...roots].sort(),
    distinctRootCount: roots.size,
  };
}

function repositoryScorePath(sourcePath) {
  if (!sourcePath) return null;
  const absolute = resolve(sourcePath);
  const repoRelative = relative(REPO_ROOT, absolute).split('\\').join('/');
  if (repoRelative.startsWith('../') || repoRelative === '..') return null;
  return repoRelative;
}

function hasStaticBedAuthorization(score) {
  const register = score.register ?? {};
  const authorization = register.staticBedAuthorization;
  return register.harmonicArchitecture === 'static-bed'
    && authorization !== null
    && typeof authorization === 'object'
    && typeof authorization.operator === 'string'
    && authorization.operator.trim().length > 0
    && typeof authorization.date === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(authorization.date)
    && typeof register.briefRef === 'string'
    && authorization.briefRef === register.briefRef;
}

function enforceHarmonicState(score, metrics, sourcePath) {
  const scorePath = repositoryScorePath(sourcePath);
  const grandfathered = scorePath !== null && HSMD_GRANDFATHERED_SCORE_SET.has(scorePath);
  const staticBedAuthorized = hasStaticBedAuthorization(score);
  const staticSections = metrics.sections
    .filter((section) => section.available && section.classification === 'STATIC_LIKE')
    .map((section) => ({ index: section.index, label: section.label }));
  const lowMotionSections = metrics.sections
    .filter((section) => section.available && section.classification === 'LOW_MOTION')
    .map((section) => ({ index: section.index, label: section.label }));
  const insufficientSections = metrics.sections
    .filter((section) => !section.available)
    .map((section) => ({ index: section.index, label: section.label }));
  const sameBedPairs = metrics.comparisons
    .filter((comparison) => comparison.available
      && comparison.classification === 'SAME_HARMONIC_BED');
  const presentedAsNewPairs = sameBedPairs.filter((comparison) =>
    comparison.sections.every((index) => score.sections?.[index]?.harmonicClaim !== 'reuse'));
  const reportedReusePairs = sameBedPairs.filter((comparison) =>
    comparison.sections.some((index) => score.sections?.[index]?.harmonicClaim === 'reuse'));
  const operatorJudgmentPairs = metrics.comparisons
    .filter((comparison) => comparison.available
      && comparison.classification === 'HARMONIC_VARIATION')
    .map((comparison) => ({
      sections: comparison.sections,
      labels: comparison.labels,
      distance: comparison.distance,
    }));

  const flags = [];
  if (!grandfathered && !staticBedAuthorized) {
    if (staticSections.length > 0) flags.push('static-harmonic-bed');
    if (lowMotionSections.length > 0) flags.push('low-harmonic-motion');
    if (presentedAsNewPairs.length > 0) flags.push('harmonic-bed-reuse');
  }

  return {
    mode: grandfathered ? 'grandfathered' : 'gating',
    grandfatheredPath: grandfathered ? scorePath : null,
    architecture: score.register?.harmonicArchitecture ?? 'default',
    staticBedAuthorized,
    staticSections,
    lowMotionSections,
    insufficientSections,
    presentedAsNewPairs: presentedAsNewPairs.map((comparison) => ({
      sections: comparison.sections,
      labels: comparison.labels,
      distance: comparison.distance,
    })),
    reportedReusePairs: reportedReusePairs.map((comparison) => ({
      sections: comparison.sections,
      labels: comparison.labels,
      distance: comparison.distance,
    })),
    operatorJudgmentPairs,
    flags,
  };
}

// ---------------------------------------------------------------------------
// Public audit
// ---------------------------------------------------------------------------

export function auditScore(score, { sourcePath = null } = {}) {
  if (!score || typeof score !== 'object') {
    throw new Error('auditScore: expected a score object');
  }

  const events = flattenEvents(score);
  const onsetMetrics = measureOnsetVariance(score, events);
  const velocityMetrics = measureVelocitySpread(score, events);
  const leadMetrics = measureLeadReleases(events);
  const sectionMetrics = measureSections(score);
  const harmonicMetrics = measureHarmonicMovement(events);
  const harmonicStateMetrics = analyzeHarmonicState(events, harmonicSections(score));
  const harmonicStateEnforcement = enforceHarmonicState(score, harmonicStateMetrics, sourcePath);

  const flags = [];

  const mechanicalOnsetVoices = Object.entries(onsetMetrics)
    .filter(([, m]) => m.mechanical)
    .map(([voice]) => voice);
  if (mechanicalOnsetVoices.length > 0) flags.push('mechanical-onsets');

  const mechanicalVelocityVoices = Object.entries(velocityMetrics)
    .filter(([, m]) => m.mechanical)
    .map(([voice]) => voice);
  if (mechanicalVelocityVoices.length > 0) flags.push('mechanical-velocities');

  const mechanicalLeadVoices = Object.entries(leadMetrics)
    .filter(([, m]) => m.mechanical)
    .map(([voice]) => voice);
  if (mechanicalLeadVoices.length > 0) flags.push('constant-lead-releases');

  if (sectionMetrics.count < 2) flags.push('single-section');
  else if (sectionMetrics.allSame) flags.push('constant-arrangement');

  flags.push(...harmonicStateEnforcement.flags);

  return {
    pass: flags.length === 0,
    flags,
    metrics: {
      onset: onsetMetrics,
      velocity: velocityMetrics,
      leadReleases: leadMetrics,
      sections: sectionMetrics,
      harmony: harmonicMetrics,
      harmonicState: {
        ...harmonicStateMetrics,
        enforcement: harmonicStateEnforcement,
      },
    },
  };
}
