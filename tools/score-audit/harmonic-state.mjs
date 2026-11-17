/**
 * Label-free Harmonic-State Motion and Distinctness (HSMD), per DR2.
 *
 * Input note events use the score-audit probe's flattened schema, augmented with
 * beat-domain fields:
 *   { voice, onsetBeat, pitch, durationBeat, role, sectionIndex }
 *
 * Gain is intentionally ignored. Harmony is integrated over overlapping 1, 2,
 * and 4 beat windows so sequential/arpeggiated notes contribute to one state.
 */

export const HSMD_CONFIG = Object.freeze({
  windows: Object.freeze([1, 2, 4]),
  hopBeats: 0.5,
  changeThreshold: 0.12,
  resampleFrames: 32,
  dtwBandRatio: 0.20,
  motion: Object.freeze({ staticBelow: 0.25, movingAt: 0.50, excursionGuard: 0.05 }),
  distinctness: Object.freeze({ sameBedBelow: 0.08, distinctAt: 0.16 }),
});

export const TIV_WEIGHTS = Object.freeze([2, 11, 17, 16, 19, 7]);
const TIV_RADIUS = Math.sqrt(TIV_WEIGHTS.reduce((sum, weight) => sum + weight ** 2, 0));
const EPSILON = 1e-12;
const HARMONY_ROLES = new Set(['pad', 'chord', 'harmony', 'arp', 'arpeggio', 'accompaniment']);

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, probability) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function normalize12(vector) {
  const total = vector.reduce((sum, value) => sum + value, 0);
  if (total <= EPSILON) return null;
  return vector.map((value) => value / total);
}

function eventVoice(event) {
  return event.voiceId ?? event.voice ?? null;
}

function eventRole(event) {
  return event.role ?? eventVoice(event) ?? 'unknown';
}

function roleWeight(role, sparseCounterpoint) {
  if (role === 'drums' || role === 'unpitched') return 0;
  if (sparseCounterpoint) return 1;
  if (HARMONY_ROLES.has(role) || role === 'bass') return 1;
  if (role === 'lead' || role === 'countermelody') return 0.35;
  return 0.75;
}

function overlappingEvents(events, left, right) {
  return events.filter((event) => {
    const start = event.onsetBeat;
    const end = start + event.durationBeat;
    return Number.isFinite(event.pitch)
      && Number.isFinite(start)
      && Number.isFinite(event.durationBeat)
      && event.durationBeat > 0
      && Math.min(end, right) - Math.max(start, left) > EPSILON;
  });
}

/** Build one role-aware, temporally integrated 12-bin pitch-class state. */
export function harmonicState(events, section, centerBeat, windowBeats) {
  const left = Math.max(section.startBeat, centerBeat - windowBeats / 2);
  const right = Math.min(section.endBeat, centerBeat + windowBeats / 2);
  if (right - left <= EPSILON) return null;

  const byVoice = new Map();
  for (const event of overlappingEvents(events, left, right)) {
    const voice = eventVoice(event);
    if (!voice) continue;
    if (!byVoice.has(voice)) byVoice.set(voice, []);
    byVoice.get(voice).push(event);
  }

  const pitchedVoices = [...byVoice.values()].filter((voiceEvents) =>
    voiceEvents.some((event) => roleWeight(eventRole(event), false) > 0));
  const hasHarmonyVoice = pitchedVoices.some((voiceEvents) =>
    voiceEvents.some((event) => HARMONY_ROLES.has(eventRole(event))));
  const sparseCounterpoint = pitchedVoices.length <= 2 && !hasHarmonyVoice;

  const combined = Array(12).fill(0);
  let totalWeight = 0;

  for (const voiceEvents of pitchedVoices) {
    const duration = Array(12).fill(0);
    const presence = Array(12).fill(0);

    for (const event of voiceEvents) {
      const role = eventRole(event);
      if (roleWeight(role, false) === 0) continue;
      const start = event.onsetBeat;
      const end = start + event.durationBeat;
      const overlap = Math.max(0, Math.min(end, right) - Math.max(start, left));
      if (overlap <= EPSILON) continue;
      const pitchClass = ((Math.round(event.pitch) % 12) + 12) % 12;
      duration[pitchClass] += overlap;
      presence[pitchClass] = 1;
    }

    const normalizedDuration = normalize12(duration);
    const normalizedPresence = normalize12(presence);
    if (!normalizedDuration || !normalizedPresence) continue;

    const weight = roleWeight(eventRole(voiceEvents[0]), sparseCounterpoint);
    if (weight <= 0) continue;
    for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
      const voiceState = 0.70 * normalizedDuration[pitchClass]
        + 0.30 * normalizedPresence[pitchClass];
      combined[pitchClass] += weight * voiceState;
    }
    totalWeight += weight;
  }

  return totalWeight <= EPSILON ? null : normalize12(combined);
}

/** Return [Re1, Im1, ... Re6, Im6] for a normalized pitch-class state. */
export function tonalIntervalVector(pitchClasses) {
  const result = [];
  for (let harmonic = 1; harmonic <= 6; harmonic++) {
    let real = 0;
    let imaginary = 0;
    for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
      const angle = -2 * Math.PI * harmonic * pitchClass / 12;
      real += pitchClasses[pitchClass] * Math.cos(angle);
      imaginary += pitchClasses[pitchClass] * Math.sin(angle);
    }
    const weight = TIV_WEIGHTS[harmonic - 1];
    result.push(weight * real, weight * imaginary);
  }
  return result;
}

export function harmonicDistance(firstTiv, secondTiv) {
  let squared = 0;
  for (let index = 0; index < 12; index++) {
    squared += (firstTiv[index] - secondTiv[index]) ** 2;
  }
  return Math.sqrt(squared) / (2 * TIV_RADIUS);
}

function trajectoryForSection(events, section, windowBeats) {
  const frames = [];
  for (
    let center = section.startBeat;
    center <= section.endBeat + 1e-9;
    center += HSMD_CONFIG.hopBeats
  ) {
    const pitchClasses = harmonicState(events, section, center, windowBeats);
    if (pitchClasses) {
      frames.push({
        t: Math.min(center, section.endBeat),
        x: pitchClasses,
        z: tonalIntervalVector(pitchClasses),
      });
    }
  }
  return frames;
}

function pathRate(frames, sectionBeats) {
  let total = 0;
  for (let index = 1; index < frames.length; index++) {
    total += harmonicDistance(frames[index - 1].z, frames[index].z);
  }
  return total / sectionBeats;
}

function excursion90(frames) {
  const mean = Array(12).fill(0);
  for (const frame of frames) {
    for (let pitchClass = 0; pitchClass < 12; pitchClass++) mean[pitchClass] += frame.x[pitchClass];
  }
  for (let pitchClass = 0; pitchClass < 12; pitchClass++) mean[pitchClass] /= frames.length;
  const center = tonalIntervalVector(mean);
  return quantile(frames.map((frame) => harmonicDistance(frame.z, center)), 0.90);
}

function harmonicChangeRate(frames, sectionBeats, windowBeats) {
  const halfWindowFrames = Math.max(
    1,
    Math.round((windowBeats / 2) / HSMD_CONFIG.hopBeats),
  );
  const novelty = [];
  for (let index = halfWindowFrames; index + halfWindowFrames < frames.length; index++) {
    novelty.push({
      index,
      value: harmonicDistance(
        frames[index - halfWindowFrames].z,
        frames[index + halfWindowFrames].z,
      ),
    });
  }

  const candidates = novelty.filter((point, index) => {
    const previous = novelty[index - 1]?.value ?? -Infinity;
    const next = novelty[index + 1]?.value ?? -Infinity;
    return point.value >= HSMD_CONFIG.changeThreshold
      && point.value >= previous
      && point.value >= next;
  }).sort((a, b) => b.value - a.value || a.index - b.index);

  const minSpacingFrames = Math.ceil(
    Math.max(1, windowBeats / 2) / HSMD_CONFIG.hopBeats,
  );
  const selected = [];
  for (const candidate of candidates) {
    if (selected.every((peak) => Math.abs(peak.index - candidate.index) >= minSpacingFrames)) {
      selected.push(candidate);
    }
  }
  return 4 * selected.length / sectionBeats;
}

export function classifyMotion(score, excursion) {
  if (score < HSMD_CONFIG.motion.staticBelow) return 'STATIC_LIKE';
  if (score >= HSMD_CONFIG.motion.movingAt && excursion >= HSMD_CONFIG.motion.excursionGuard) {
    return 'MOVING';
  }
  return 'LOW_MOTION';
}

function measureSection(events, section) {
  const sectionBeats = section.endBeat - section.startBeat;
  const scales = [];

  for (const windowBeats of HSMD_CONFIG.windows) {
    if (sectionBeats < 2 * windowBeats) continue;
    const frames = trajectoryForSection(events, section, windowBeats);
    if (frames.length < 4) continue;
    scales.push({
      windowBeats,
      frames,
      pathRate: pathRate(frames, sectionBeats),
      excursion90: excursion90(frames),
      changesPer4Beats: harmonicChangeRate(frames, sectionBeats, windowBeats),
    });
  }

  if (scales.length === 0) {
    return {
      index: section.index,
      label: section.label,
      track: section.track,
      beats: sectionBeats,
      available: false,
      classification: 'INSUFFICIENT_DATA',
      scales: [],
    };
  }

  const aggregate = {
    pathRate: median(scales.map((scale) => scale.pathRate)),
    excursion90: median(scales.map((scale) => scale.excursion90)),
    changesPer4Beats: median(scales.map((scale) => scale.changesPer4Beats)),
  };
  const pathComponent = clamp01((aggregate.pathRate - 0.015) / (0.060 - 0.015));
  const excursionComponent = clamp01((aggregate.excursion90 - 0.035) / (0.120 - 0.035));
  const changeComponent = clamp01(aggregate.changesPer4Beats);
  const score = 0.45 * pathComponent + 0.35 * excursionComponent + 0.20 * changeComponent;

  return {
    index: section.index,
    label: section.label,
    track: section.track,
    beats: sectionBeats,
    available: true,
    score,
    classification: classifyMotion(score, aggregate.excursion90),
    ...aggregate,
    components: { path: pathComponent, excursion: excursionComponent, changeRate: changeComponent },
    scales,
  };
}

function interpolateVector(first, second, amount) {
  return first.map((value, index) => value * (1 - amount) + second[index] * amount);
}

function resampleFrames(frames, section, count) {
  if (frames.length === 1) return Array.from({ length: count }, () => [...frames[0].x]);
  const duration = section.endBeat - section.startBeat;
  const output = [];
  let rightIndex = 0;

  for (let sample = 0; sample < count; sample++) {
    const phase = count === 1 ? 0 : sample / (count - 1);
    const time = section.startBeat + phase * duration;
    while (rightIndex < frames.length && frames[rightIndex].t < time) rightIndex++;
    if (rightIndex === 0) {
      output.push([...frames[0].x]);
    } else if (rightIndex >= frames.length) {
      output.push([...frames.at(-1).x]);
    } else {
      const left = frames[rightIndex - 1];
      const right = frames[rightIndex];
      const span = right.t - left.t;
      const amount = span <= EPSILON ? 0 : (time - left.t) / span;
      output.push(interpolateVector(left.x, right.x, amount));
    }
  }
  return output;
}

function transposePitchClasses(states, semitones) {
  return states.map((state) => {
    const shifted = Array(12).fill(0);
    for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
      shifted[(pitchClass + semitones) % 12] = state[pitchClass];
    }
    return shifted;
  });
}

function averageCostDtw(firstStates, secondStates) {
  const first = firstStates.map(tonalIntervalVector);
  const second = secondStates.map(tonalIntervalVector);
  const size = first.length;
  const band = Math.max(1, Math.ceil(size * HSMD_CONFIG.dtwBandRatio));
  const costs = Array.from({ length: size }, () => Array(size).fill(null));

  for (let row = 0; row < size; row++) {
    const start = Math.max(0, row - band);
    const end = Math.min(size - 1, row + band);
    for (let column = start; column <= end; column++) {
      const local = harmonicDistance(first[row], second[column]);
      if (row === 0 && column === 0) {
        costs[row][column] = { total: local, length: 1 };
        continue;
      }
      const predecessors = [
        costs[row - 1]?.[column - 1],
        costs[row - 1]?.[column],
        costs[row]?.[column - 1],
      ].filter(Boolean);
      if (predecessors.length === 0) continue;
      predecessors.sort((a, b) => a.total - b.total || a.length - b.length);
      costs[row][column] = {
        total: predecessors[0].total + local,
        length: predecessors[0].length + 1,
      };
    }
  }

  const result = costs[size - 1][size - 1];
  return result ? result.total / result.length : Infinity;
}

function selfSimilarityDifference(firstStates, secondStates) {
  const first = firstStates.map(tonalIntervalVector);
  const second = secondStates.map(tonalIntervalVector);
  let total = 0;
  for (let row = 0; row < first.length; row++) {
    for (let column = 0; column < first.length; column++) {
      const firstSimilarity = 1 - harmonicDistance(first[row], first[column]);
      const secondSimilarity = 1 - harmonicDistance(second[row], second[column]);
      total += Math.abs(firstSimilarity - secondSimilarity);
    }
  }
  return total / (first.length ** 2);
}

export function classifyDistinctness(distance) {
  if (distance < HSMD_CONFIG.distinctness.sameBedBelow) return 'SAME_HARMONIC_BED';
  if (distance >= HSMD_CONFIG.distinctness.distinctAt) return 'HARMONICALLY_DISTINCT';
  return 'HARMONIC_VARIATION';
}

function compareSections(first, second, firstSection, secondSection) {
  const firstByWindow = new Map(first.scales.map((scale) => [scale.windowBeats, scale]));
  const secondByWindow = new Map(second.scales.map((scale) => [scale.windowBeats, scale]));
  const scales = [];

  for (const windowBeats of HSMD_CONFIG.windows) {
    const firstScale = firstByWindow.get(windowBeats);
    const secondScale = secondByWindow.get(windowBeats);
    if (!firstScale || !secondScale) continue;
    const firstStates = resampleFrames(
      firstScale.frames,
      firstSection,
      HSMD_CONFIG.resampleFrames,
    );
    const secondStates = resampleFrames(
      secondScale.frames,
      secondSection,
      HSMD_CONFIG.resampleFrames,
    );
    let shiftedDtw = Infinity;
    let bestTranspose = 0;
    for (let transpose = 0; transpose < 12; transpose++) {
      const distance = averageCostDtw(firstStates, transposePitchClasses(secondStates, transpose));
      if (distance < shiftedDtw) {
        shiftedDtw = distance;
        bestTranspose = transpose;
      }
    }
    const absoluteDistance = averageCostDtw(firstStates, secondStates);
    const ssmDifference = selfSimilarityDifference(firstStates, secondStates);
    scales.push({
      windowBeats,
      shiftedDtw,
      absoluteDistance,
      ssmDifference,
      shapeDistance: 0.65 * shiftedDtw + 0.35 * ssmDifference,
      bestTranspose,
    });
  }

  if (scales.length === 0) {
    return {
      sections: [first.index, second.index],
      labels: [first.label, second.label],
      available: false,
      classification: 'INSUFFICIENT_DATA',
    };
  }

  const shapeDistance = median(scales.map((scale) => scale.shapeDistance));
  const absoluteDistance = median(scales.map((scale) => scale.absoluteDistance));
  const harmonicRhythmDistance = Math.abs(first.changesPer4Beats - second.changesPer4Beats)
    / (first.changesPer4Beats + second.changesPer4Beats + 0.5);
  const distance = 0.85 * shapeDistance + 0.15 * harmonicRhythmDistance;

  return {
    sections: [first.index, second.index],
    labels: [first.label, second.label],
    available: true,
    distance,
    classification: classifyDistinctness(distance),
    shapeDistance,
    harmonicRhythmDistance,
    absoluteDistance,
    bestTranspose: Math.round(median(scales.map((scale) => scale.bestTranspose))),
    scales,
  };
}

function suggestedVerdict(sections, comparisons) {
  const availableSections = sections.filter((section) => section.available);
  const availableComparisons = comparisons.filter((comparison) => comparison.available);
  if (availableSections.length === 0) return 'INSUFFICIENT_HARMONIC_DATA';
  if (availableSections.every((section) => section.classification === 'STATIC_LIKE')) return 'STATIC';
  if (availableComparisons.some((comparison) => comparison.classification === 'SAME_HARMONIC_BED')) {
    return 'HARMONIC_BED_REUSE';
  }
  if (availableComparisons.length > 0
    && availableComparisons.every((comparison) => comparison.classification === 'HARMONICALLY_DISTINCT')) {
    return 'SECTIONS_DISTINCT';
  }
  if (availableComparisons.some((comparison) => comparison.classification === 'HARMONIC_VARIATION')) {
    return 'BORDERLINE_SECTION_VARIATION';
  }
  if (availableSections.some((section) => section.classification === 'MOVING')) return 'HARMONIC_MOTION_PRESENT';
  return 'LOW_OR_AMBIGUOUS_MOTION';
}

function publicSection(section) {
  const { scales, ...result } = section;
  return {
    ...result,
    scales: scales.map(({ frames, ...scale }) => ({ ...scale, frameCount: frames.length })),
  };
}

/** Compute the DR2 HSMD composite for all labeled sections. */
export function analyzeHarmonicState(events, sectionDefinitions) {
  const internalSections = sectionDefinitions.map((section) => {
    const sectionEvents = events.filter((event) => event.sectionIndex === section.index);
    return measureSection(sectionEvents, section);
  });
  const comparisons = [];
  for (let first = 0; first < internalSections.length; first++) {
    for (let second = first + 1; second < internalSections.length; second++) {
      comparisons.push(compareSections(
        internalSections[first],
        internalSections[second],
        sectionDefinitions[first],
        sectionDefinitions[second],
      ));
    }
  }

  const sections = internalSections.map(publicSection);
  const availableComparisons = comparisons.filter((comparison) => comparison.available);
  return {
    advisory: false,
    method: 'HSMD_DR2',
    sections,
    comparisons,
    summary: {
      suggestedVerdict: suggestedVerdict(sections, comparisons),
      minimumDistinctness: availableComparisons.length
        ? Math.min(...availableComparisons.map((comparison) => comparison.distance))
        : null,
      maximumDistinctness: availableComparisons.length
        ? Math.max(...availableComparisons.map((comparison) => comparison.distance))
        : null,
      sameBedPairs: availableComparisons.filter((comparison) =>
        comparison.classification === 'SAME_HARMONIC_BED').length,
      variationPairs: availableComparisons.filter((comparison) =>
        comparison.classification === 'HARMONIC_VARIATION').length,
      distinctPairs: availableComparisons.filter((comparison) =>
        comparison.classification === 'HARMONICALLY_DISTINCT').length,
    },
  };
}
