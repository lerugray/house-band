import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeHarmonicState,
  harmonicDistance,
  harmonicState,
  tonalIntervalVector,
} from '../harmonic-state.mjs';

function pitchClassState(...pitchClasses) {
  const state = Array(12).fill(0);
  for (const pitchClass of pitchClasses) state[pitchClass] += 1 / pitchClasses.length;
  return state;
}

function event(sectionIndex, voice, role, onsetBeat, durationBeat, pitch) {
  return { sectionIndex, voice, role, onsetBeat, durationBeat, pitch };
}

function chordEvents(sectionIndex, startBeat, roots, transpose = 0) {
  const events = [];
  roots.forEach((root, chordIndex) => {
    for (const interval of [0, 4, 7]) {
      events.push(event(
        sectionIndex,
        'pad',
        'pad',
        startBeat + chordIndex * 4,
        4,
        48 + root + interval + transpose,
      ));
    }
  });
  return events;
}

const fourSections = (count = 2) => Array.from({ length: count }, (_, index) => ({
  index,
  label: String.fromCharCode(65 + index),
  track: String.fromCharCode(65 + index),
  startBeat: index * 16,
  endBeat: (index + 1) * 16,
}));

describe('DR2 harmonic-state metric', () => {
  it('matches the report TIV reference distances', () => {
    const cMajor = tonalIntervalVector(pitchClassState(0, 4, 7));
    const aMinor = tonalIntervalVector(pitchClassState(9, 0, 4));
    const fMajor = tonalIntervalVector(pitchClassState(5, 9, 0));

    assert.ok(Math.abs(harmonicDistance(cMajor, aMinor) - 0.261) < 0.002);
    assert.ok(Math.abs(harmonicDistance(cMajor, fMajor) - 0.389) < 0.002);
  });

  it('aggregates sequential short notes into an implied chord state', () => {
    const section = { index: 0, startBeat: 0, endBeat: 4 };
    const events = [
      event(0, 'arp', 'arpeggio', 0.25, 0.20, 60),
      event(0, 'arp', 'arpeggio', 0.75, 0.20, 64),
      event(0, 'arp', 'arpeggio', 1.25, 0.20, 67),
    ];

    const state = harmonicState(events, section, 1, 2);
    assert.ok(state[0] > 0);
    assert.ok(state[4] > 0);
    assert.ok(state[7] > 0);
    assert.ok(Math.abs(state[0] + state[4] + state[7] - 1) < 1e-12);
  });

  it('classifies a sustained single-chord bed as static-like', () => {
    const sections = fourSections(1);
    const events = chordEvents(0, 0, [0, 0, 0, 0]);
    const result = analyzeHarmonicState(events, sections);

    assert.equal(result.sections[0].classification, 'STATIC_LIKE');
    assert.ok(result.sections[0].score < 0.25);
    assert.equal(result.summary.suggestedVerdict, 'STATIC');
  });

  it('detects multi-chord motion built from non-simultaneous arpeggios', () => {
    const sections = fourSections(1);
    const roots = [0, 5, 7, 0];
    const events = [];
    roots.forEach((root, chordIndex) => {
      [0, 4, 7, 12, 7, 4, 0, 4].forEach((interval, noteIndex) => {
        events.push(event(
          0,
          'arp',
          'arpeggio',
          chordIndex * 4 + noteIndex * 0.5,
          0.20,
          48 + root + interval,
        ));
      });
    });

    const result = analyzeHarmonicState(events, sections);
    assert.equal(result.sections[0].classification, 'MOVING');
    assert.ok(result.sections[0].excursion90 >= 0.05);
  });

  it('recognizes a transposed progression as the same harmonic bed', () => {
    const sections = fourSections(2);
    const roots = [0, 9, 5, 7];
    const events = [
      ...chordEvents(0, 0, roots),
      ...chordEvents(1, 16, roots, 2),
    ];
    const result = analyzeHarmonicState(events, sections);
    const comparison = result.comparisons[0];

    assert.equal(comparison.classification, 'SAME_HARMONIC_BED');
    assert.ok(comparison.distance < 0.08);
    assert.ok(comparison.absoluteDistance > comparison.shapeDistance);
  });

  it('calls two materially different multi-section trajectories distinct', () => {
    const sections = fourSections(2);
    const firstEvents = chordEvents(0, 0, [0, 9, 5, 7]);
    const secondEvents = [];
    const roots = [1, 6, 11, 3];
    const qualities = [[0, 3, 6], [0, 4, 8], [0, 3, 7], [0, 4, 7]];
    roots.forEach((root, chordIndex) => {
      for (const interval of qualities[chordIndex]) {
        secondEvents.push(event(
          1,
          'pad',
          'pad',
          16 + chordIndex * 4,
          4,
          48 + root + interval,
        ));
      }
    });

    const result = analyzeHarmonicState([...firstEvents, ...secondEvents], sections);
    assert.equal(result.comparisons[0].classification, 'HARMONICALLY_DISTINCT');
    assert.ok(result.comparisons[0].distance >= 0.16);
    assert.equal(result.summary.suggestedVerdict, 'SECTIONS_DISTINCT');
  });

  it('never borrows notes across labeled section boundaries', () => {
    const sections = fourSections(2);
    const events = [
      ...chordEvents(0, 0, [0, 0, 0, 0]),
      ...chordEvents(1, 16, [6, 6, 6, 6]),
    ];
    const result = analyzeHarmonicState(events, sections);

    assert.equal(result.sections[0].classification, 'STATIC_LIKE');
    assert.equal(result.sections[1].classification, 'STATIC_LIKE');
    assert.ok(result.sections[0].score < 0.01);
    assert.ok(result.sections[1].score < 0.01);
  });
});
