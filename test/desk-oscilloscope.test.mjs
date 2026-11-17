import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  allocateBlockWidths,
  blockMode,
  buildVoiceRows,
  deriveOscilloscopeData,
} from '../desk/oscilloscope.mjs';

const ENGINE_STEPS_PER_BAR = 16;

const kitVersion = {
  semver: '1.1.0',
  sha: 'b2709519f2faf8481de28e0a5e9912cd2e80ae9e290fdfca88915c0377aaf773',
};

function baseScore() {
  return {
    schemaVersion: '1.0.0',
    kitVersion,
    seed: 1,
    tempo: 120,
    sampleRate: 44100,
    register: { name: 'test-register', briefRef: 'docs/TEST.md' },
    tracks: {},
    sections: [],
  };
}

// Test oracle modeled directly on band.js: its absolute step counter survives a
// same-name setTrack no-op, resets on a track switch, and tick wraps by track len.
// Keeping this section-level simulator separate from oscilloscope helpers makes
// the parity assertions independent of the production derivation structure.
function engineSemanticsOracle(score) {
  let previousTrack = null;
  let phase = 0;

  return score.sections.map((section) => {
    const track = score.tracks[section.track];
    if (section.track !== previousTrack) phase = 0;
    const sectionSteps = section.bars * ENGINE_STEPS_PER_BAR;
    const voiceHits = {};

    for (let rel = 0; rel < sectionSteps; rel += 1) {
      const patternIndex = (phase + rel) % track.len;
      for (const event of track.steps) {
        const indices = event.i === undefined
          ? null
          : (Array.isArray(event.i) ? event.i : [event.i]);
        const sounds = indices
          ? indices.includes(patternIndex)
          : patternIndex % event.every === 0;
        if (!sounds) continue;
        const voice = event.voice ?? event.v;
        voiceHits[voice] ??= [];
        voiceHits[voice].push(rel / sectionSteps);
      }
    }

    phase = (phase + sectionSteps) % track.len;
    previousTrack = section.track;
    return voiceHits;
  });
}

function hitPositions(section, voice) {
  return (section.voiceHits[voice] ?? []).map((hit) => hit.x);
}

describe('deriveOscilloscopeData', () => {
  it('returns empty data when no score is supplied', () => {
    const data = deriveOscilloscopeData(null);
    assert.deepEqual(data.sections, []);
    assert.equal(data.duration, 0);
    assert.deepEqual(data.voiceOrder, []);
  });

  it('returns empty data when the score has no sections', () => {
    const score = baseScore();
    const data = deriveOscilloscopeData(score);
    assert.deepEqual(data.sections, []);
    assert.equal(data.duration, 0);
    assert.deepEqual(data.voiceOrder, []);
  });

  it('maps a single section to one block with its voices and density', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [
        { i: 0, voice: 'kick', opts: { vol: 0.2 } },
        { i: 4, voice: 'bass', note: 'C2', dur: 0.2, opts: { vol: 0.1 } },
        { i: 8, voice: 'pad', note: 'C3', dur: 1, opts: { vol: 0.05 } },
      ] },
    };
    score.sections = [{ track: 'A', bars: 2 }];

    const data = deriveOscilloscopeData(score);
    assert.equal(data.sections.length, 1);
    assert.equal(data.duration, 4); // 2 bars * 2 seconds per bar at 120bpm
    assert.deepEqual(data.voiceOrder, ['kick', 'bass', 'pad']);

    const block = data.sections[0];
    assert.equal(block.label, 'A');
    assert.equal(block.bars, 2);
    assert.equal(block.bpm, 120);
    assert.equal(block.steps, 3);
    assert.equal(block.density, 3 / 16);
    assert.equal(block.stepsPerBar, 3);
    assert.deepEqual(block.voices, ['bass', 'kick', 'pad']);
    assert.equal(block.root, 'C');
    assert.equal(block.rootChanged, false);
  });

  it('sets block widths proportional to section duration', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [{ i: 0, voice: 'kick', opts: { vol: 0.2 } }] },
      B: { bpm: 120, len: 16, vol: 0.8, steps: [{ i: 0, voice: 'snare', opts: { vol: 0.2 } }] },
    };
    score.sections = [
      { track: 'A', bars: 2 },
      { track: 'B', bars: 4 },
    ];

    const data = deriveOscilloscopeData(score);
    assert.equal(data.sections[0].duration, 4);
    assert.equal(data.sections[1].duration, 8);
    assert.equal(data.sections[1].start, 4);
    assert.equal(data.duration, 12);
  });

  it('handles different BPMs across sections', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [{ i: 0, voice: 'kick', opts: { vol: 0.2 } }] },
      B: { bpm: 60, len: 16, vol: 0.8, steps: [{ i: 0, voice: 'kick', opts: { vol: 0.2 } }] },
    };
    score.sections = [
      { track: 'A', bars: 1 },
      { track: 'B', bars: 1 },
    ];

    const data = deriveOscilloscopeData(score);
    assert.equal(data.sections[0].duration, 2); // 120bpm -> 2s/bar
    assert.equal(data.sections[1].duration, 4); // 60bpm -> 4s/bar
    assert.equal(data.duration, 6);
  });

  it('derives chord roots from the lowest-priority pitched voice', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [
        { i: 0, voice: 'lead', note: 'G4', dur: 0.1, opts: {} },
        { i: 0, voice: 'pad', note: 'Eb3', dur: 1, opts: {} },
        { i: 0, voice: 'bass', note: 'C2', dur: 0.5, opts: {} },
      ] },
    };
    score.sections = [{ track: 'A', bars: 1 }];

    const data = deriveOscilloscopeData(score);
    assert.equal(data.sections[0].root, 'C');
  });

  it('falls back to any pitched voice when the priority voices are absent', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [
        { i: 0, voice: 'pluck', note: 'F#3', dur: 0.1, opts: {} },
      ] },
    };
    score.sections = [{ track: 'A', bars: 1 }];

    const data = deriveOscilloscopeData(score);
    assert.equal(data.sections[0].root, 'F#');
  });

  it('shows a dash when no pitched notes are present', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [
        { i: 0, voice: 'kick', opts: { vol: 0.2 } },
        { i: 4, voice: 'snare', opts: { vol: 0.2 } },
      ] },
    };
    score.sections = [{ track: 'A', bars: 1 }];

    const data = deriveOscilloscopeData(score);
    assert.equal(data.sections[0].root, '—');
  });

  it('flags root changes between sections', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [{ i: 0, voice: 'bass', note: 'C2', dur: 0.2, opts: {} }] },
      B: { bpm: 120, len: 16, vol: 0.8, steps: [{ i: 0, voice: 'bass', note: 'G2', dur: 0.2, opts: {} }] },
    };
    score.sections = [
      { track: 'A', bars: 1 },
      { track: 'B', bars: 1 },
    ];

    const data = deriveOscilloscopeData(score);
    assert.equal(data.sections[0].root, 'C');
    assert.equal(data.sections[0].rootChanged, false);
    assert.equal(data.sections[1].root, 'G');
    assert.equal(data.sections[1].rootChanged, true);
  });

  it('keeps voice rows stable across sections', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [
        { i: 0, voice: 'kick', opts: {} },
        { i: 0, voice: 'bass', note: 'C2', dur: 0.2, opts: {} },
      ] },
      B: { bpm: 120, len: 16, vol: 0.8, steps: [
        { i: 0, voice: 'snare', opts: {} },
        { i: 0, voice: 'bass', note: 'G2', dur: 0.2, opts: {} },
      ] },
    };
    score.sections = [
      { track: 'A', bars: 1 },
      { track: 'B', bars: 1 },
    ];

    const data = deriveOscilloscopeData(score);
    assert.deepEqual(data.voiceOrder, ['kick', 'bass', 'snare']);
    assert.deepEqual(data.sections[0].rowActivity.map((r) => [r.voice, r.active]), [
      ['kick', true],
      ['bass', true],
      ['snare', false],
    ]);
    assert.deepEqual(data.sections[1].rowActivity.map((r) => [r.voice, r.active]), [
      ['kick', false],
      ['bass', true],
      ['snare', true],
    ]);
  });

  it('respects the v alias for voice', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [{ i: 0, v: 'hat', opts: {} }] },
    };
    score.sections = [{ track: 'A', bars: 1 }];

    const data = deriveOscilloscopeData(score);
    assert.deepEqual(data.voiceOrder, ['hat']);
  });

  it('caps density at 1 for very dense sections', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: Array.from({ length: 64 }, (_, i) => ({ i, voice: 'kick', opts: {} })) },
    };
    score.sections = [{ track: 'A', bars: 1 }];

    const data = deriveOscilloscopeData(score);
    assert.equal(data.sections[0].density, 1);
    assert.equal(data.sections[0].stepsPerBar, 16);
  });

  it('numbers repeated passes and detects material variation', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [
        { i: 0, voice: 'kick', opts: {} },
        { i: 0, voice: 'bass', note: 'C2', dur: 0.2, opts: {} },
      ] },
      B: { bpm: 120, len: 16, vol: 0.8, steps: [
        { i: 0, voice: 'kick', opts: {} },
        { i: 0, voice: 'bass', note: 'G2', dur: 0.2, opts: {} },
      ] },
    };
    score.sections = [
      { track: 'A', bars: 1 },
      { track: 'A', bars: 1 },
      { track: 'B', bars: 1 },
    ];

    const data = deriveOscilloscopeData(score);
    assert.equal(data.sections[0].pass, 1);
    assert.equal(data.sections[1].pass, 2);
    assert.equal(data.sections[1].varied, false);
    assert.equal(data.sections[2].pass, 1);
    // A first pass is never a variation, even when the track changes.
    assert.equal(data.sections[2].varied, false);
  });

  it('derives per-voice rhythmic hits for traces', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 16, vol: 0.8, steps: [
        { i: 0, voice: 'kick', opts: { vol: 0.4 } },
        { i: 8, voice: 'kick', opts: { vol: 0.2 } },
        { i: 4, voice: 'bass', note: 'C2', dur: 0.2, opts: { vol: 0.15 } },
      ] },
      B: { bpm: 120, len: 16, vol: 0.8, steps: [
        { i: [0, 4, 8, 12], voice: 'snare', opts: { vol: 0.25 } },
      ] },
    };
    score.sections = [
      { track: 'A', bars: 2 },
      { track: 'B', bars: 1 },
    ];

    const data = deriveOscilloscopeData(score);
    const a = data.sections[0];
    assert.equal(a.voiceHits.kick.length, 4);
    assert.equal(a.voiceHits.bass.length, 2);
    assert.ok(a.voiceHits.kick[0].x < a.voiceHits.kick[1].x);
    assert.ok(a.voiceHits.kick[0].v > a.voiceHits.kick[1].v);

    const b = data.sections[1];
    assert.equal(b.voiceHits.snare.length, 4);
    assert.notDeepEqual(a.voiceHits, b.voiceHits);
  });

  it('expands a two-bar section across both normalized halves', () => {
    const score = baseScore();
    score.tracks.A = {
      bpm: 120,
      len: 16,
      steps: [{ i: [0, 12], voice: 'pulse', opts: {} }],
    };
    score.sections = [{ track: 'A', bars: 2 }];

    const data = deriveOscilloscopeData(score);
    assert.deepEqual(hitPositions(data.sections[0], 'pulse'), engineSemanticsOracle(score)[0].pulse);
    assert.ok(hitPositions(data.sections[0], 'pulse').some((x) => x < 0.5));
    assert.ok(hitPositions(data.sections[0], 'pulse').some((x) => x >= 0.5));
  });

  it('uses 32 engine steps for len=24 bars=2 and wraps the pattern', () => {
    const score = baseScore();
    score.tracks.A = {
      bpm: 120,
      len: 24,
      steps: [{ i: [0, 8, 16], voice: 'pulse', opts: {} }],
    };
    score.sections = [{ track: 'A', bars: 2 }];

    const data = deriveOscilloscopeData(score);
    assert.deepEqual(hitPositions(data.sections[0], 'pulse'), engineSemanticsOracle(score)[0].pulse);
    assert.deepEqual(hitPositions(data.sections[0], 'pulse'), [0, 0.25, 0.5, 0.75]);
  });

  it('truncates len=64 events beyond a one-bar section', () => {
    const score = baseScore();
    score.tracks.A = {
      bpm: 120,
      len: 64,
      steps: [
        { i: 15, voice: 'pulse', opts: {} },
        { i: 16, voice: 'pulse', opts: {} },
        { i: 63, voice: 'pulse', opts: {} },
      ],
    };
    score.sections = [{ track: 'A', bars: 1 }];

    const data = deriveOscilloscopeData(score);
    assert.deepEqual(hitPositions(data.sections[0], 'pulse'), engineSemanticsOracle(score)[0].pulse);
    assert.deepEqual(hitPositions(data.sections[0], 'pulse'), [15 / 16]);
  });

  it('includes the downbeat for every events under wrapped pattern mapping', () => {
    const score = baseScore();
    score.tracks.A = {
      bpm: 120,
      len: 24,
      steps: [{ every: 4, voice: 'hat', opts: {} }],
    };
    score.sections = [{ track: 'A', bars: 2 }];

    const data = deriveOscilloscopeData(score);
    assert.deepEqual(hitPositions(data.sections[0], 'hat'), engineSemanticsOracle(score)[0].hat);
    assert.deepEqual(hitPositions(data.sections[0], 'hat'), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
  });

  it('carries len=24 phase across adjacent same-track sections', () => {
    const score = baseScore();
    score.tracks.A = {
      bpm: 120,
      len: 24,
      steps: [{ i: 0, voice: 'pulse', opts: {} }],
    };
    score.sections = [
      { track: 'A', bars: 1 },
      { track: 'A', bars: 1 },
    ];

    const data = deriveOscilloscopeData(score);
    const expected = engineSemanticsOracle(score);
    assert.deepEqual(hitPositions(data.sections[0], 'pulse'), expected[0].pulse);
    assert.deepEqual(hitPositions(data.sections[1], 'pulse'), expected[1].pulse);
    assert.deepEqual(hitPositions(data.sections[1], 'pulse'), [0.5]);
  });

  it('resets pattern phase when the track switches', () => {
    const score = baseScore();
    score.tracks = {
      A: { bpm: 120, len: 24, steps: [{ i: 0, voice: 'pulse', opts: {} }] },
      B: { bpm: 120, len: 24, steps: [{ i: 0, voice: 'noise', opts: {} }] },
    };
    score.sections = [
      { track: 'A', bars: 1 },
      { track: 'B', bars: 1 },
      { track: 'A', bars: 1 },
    ];

    const data = deriveOscilloscopeData(score);
    const expected = engineSemanticsOracle(score);
    assert.deepEqual(hitPositions(data.sections[2], 'pulse'), expected[2].pulse);
    assert.deepEqual(hitPositions(data.sections[2], 'pulse'), [0]);
  });

  it('shows chipfx exemplar hits through the final tenth with truthful density', () => {
    const score = JSON.parse(readFileSync(new URL('../examples/chipfx-audition-spec.json', import.meta.url), 'utf8'));
    const data = deriveOscilloscopeData(score);
    const exemplarIndex = score.sections.findIndex((section) => section.track === 'exemplar');
    const exemplar = data.sections[exemplarIndex];
    const expected = engineSemanticsOracle(score)[exemplarIndex];

    assert.deepEqual(hitPositions(exemplar, 'chipPulse'), expected.chipPulse);
    assert.deepEqual(hitPositions(exemplar, 'chipNoise'), expected.chipNoise);
    assert.ok(Object.values(exemplar.voiceHits).flat().some((hit) => hit.x > 0.9));
    assert.equal(exemplar.stepsPerBar, 14);
    assert.equal(exemplar.density, 14 / 16);
  });
});

describe('oscilloscope block-width allocation', () => {
  const equal = (n) => Array.from({ length: n }, () => ({ duration: 4 }));

  it('splits equal-duration sections exactly evenly, floor or no floor', () => {
    for (const n of [2, 3, 4, 6, 8, 12]) {
      const widths = allocateBlockWidths(equal(n), 600);
      const sum = widths.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 600) < 1e-6, `widths for ${n} sections sum to ${sum}`);
      for (const w of widths) {
        assert.ok(Math.abs(w - 600 / n) < 1e-6, `uneven split at ${n} sections`);
      }
    }
  });

  it('keeps a long section visibly longer while the short ones stay usable', () => {
    // The chipfx shape: eleven one-bar sections beside a twelve-bar one.
    const sections = [...Array.from({ length: 11 }, () => ({ duration: 2 })), { duration: 24 }];
    const widths = allocateBlockWidths(sections, 550);
    const short = widths[0];
    const long = widths[11];

    assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 550) < 1e-6);
    // Pure proportion gave 23px vs 279px — data-faithful and unusable.
    assert.ok(short > 30, `short sections collapsed to ${short}px`);
    // A flat floor gave 45px vs 55px — legible but a lie about duration.
    assert.ok(long > short * 3, `long section is only ${long / short}x the short ones`);
  });

  it('falls back to pure proportion when the floor cannot be honoured', () => {
    const sections = [...Array.from({ length: 30 }, () => ({ duration: 2 })), { duration: 8 }];
    const widths = allocateBlockWidths(sections, 300);
    assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 300) < 1e-6);
    assert.ok(widths.every((w) => w > 0));
    assert.ok(widths[30] > widths[0], 'the long section must still be the widest');
  });

  it('names a rendering rung for every width', () => {
    assert.equal(blockMode(400), 'full');
    assert.equal(blockMode(190), 'full');
    assert.equal(blockMode(189), 'compact');
    assert.equal(blockMode(96), 'compact');
    assert.equal(blockMode(95), 'narrow');
    assert.equal(blockMode(26), 'narrow');
    assert.equal(blockMode(25), 'sliver');
    assert.equal(blockMode(1), 'sliver');
  });
});

describe('oscilloscope voice rows', () => {
  const voices = ['kick', 'snare', 'hat', 'bass', 'lead', 'pad', 'pluck'];

  it('gives every voice its own row when they fit', () => {
    const rows = buildVoiceRows(voices, 11);
    assert.equal(rows.length, voices.length);
    assert.deepEqual(rows.map((r) => r.label), voices);
    assert.ok(rows.every((r) => r.merged === false));
  });

  it('merges into explicitly labelled rows when they do not, losing no voice', () => {
    const many = Array.from({ length: 20 }, (_, i) => `v${i + 1}`);
    const rows = buildVoiceRows(many, 7);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.flatMap((r) => r.voices), many, 'every voice appears exactly once, in order');
    const merged = rows.filter((r) => r.merged);
    assert.ok(merged.length > 0, 'nothing was marked merged');
    for (const row of merged) {
      assert.ok(row.label.includes('+'), `merged row "${row.label}" does not say it is merged`);
      assert.equal(row.label, `${row.voices[0]}+${row.voices.length - 1}`);
    }
  });

  it('returns no rows for a score with no voices', () => {
    assert.deepEqual(buildVoiceRows([], 11), []);
    assert.deepEqual(buildVoiceRows(undefined, 11), []);
  });
});

/**
 * The oracle above is still a re-reading of band.js by hand. These tests drive
 * the REAL scheduler — same createBand, same tick loop src/render.mjs uses —
 * with a recording step function, and compare what the engine actually fires
 * against what the oscilloscope claims. This is the check that cannot be
 * satisfied by a derivation and an oracle sharing the same misunderstanding.
 */
describe('oscilloscope derivation vs the real band scheduler', () => {
  async function enginePatternIndices(spec) {
    const { OfflineAudioContext } = await import('node-web-audio-api');
    const { createBand, LOOKAHEAD } = await import('../src/kit/band.js');

    const ctx = new OfflineAudioContext(2, 44100, 44100);
    let now = 0;
    const band = createBand({
      ctx, seed: spec.seed, gain: 0.5, nowFn: () => now, strict: true, disconnectRetired: false,
    });
    // Record each step by the TRACK that fired it and the TIME it will sound.
    // Attributing steps to whichever section's loop iteration scheduled them is
    // wrong: the scheduler's lookahead runs ahead of the section boundary, so a
    // continuing track's next steps get scheduled early and a switching track
    // leaves a couple of already-scheduled steps sounding into the crossfade.
    const fired = [];
    for (const [name, track] of Object.entries(spec.tracks)) {
      band.registerTrack(name, {
        bpm: track.bpm ?? spec.tempo,
        len: track.len | 0,
        vol: 0.8,
        step: (i, time) => fired.push({ track: name, i, time }),
      });
    }
    const tickStep = LOOKAHEAD / 2;
    const windows = [];
    spec.sections.forEach((sec) => {
      const bpm = spec.tracks[sec.track].bpm ?? spec.tempo;
      const start = now;
      const end = now + sec.bars * (16 * (60 / bpm / 4));
      windows.push({ start, end, track: sec.track });
      band.setTrack(sec.track, { fadeIn: sec.fadeIn ?? 0.05 });
      while (now < end) { band.tick(); now = Math.min(end, now + tickStep); }
      band.tick();
      now = end;
    });
    band.dispose();

    const EPS = 1e-6;
    return windows.map((w) => fired
      .filter((f) => f.track === w.track && f.time >= w.start - EPS && f.time < w.end - EPS)
      .sort((a, b) => a.time - b.time)
      .map((f) => f.i));
  }

  /** What the engine's own step indices imply for each voice, as x in [0,1). */
  function hitsFromEngine(spec, indicesPerSection) {
    return spec.sections.map((sec, idx) => {
      const track = spec.tracks[sec.track];
      const steps = sec.bars * ENGINE_STEPS_PER_BAR;
      const out = {};
      indicesPerSection[idx].forEach((patternIndex, rel) => {
        for (const event of track.steps) {
          const indices = event.i === undefined
            ? null
            : (Array.isArray(event.i) ? event.i : [event.i]);
          const sounds = indices
            ? indices.includes(patternIndex)
            : patternIndex % event.every === 0;
          if (!sounds) continue;
          const voice = event.voice ?? event.v;
          (out[voice] ??= []).push(rel / steps);
        }
      });
      return out;
    });
  }

  async function assertParity(spec) {
    const indices = await enginePatternIndices(spec);
    const expected = hitsFromEngine(spec, indices);
    const data = deriveOscilloscopeData(spec);

    spec.sections.forEach((sec, idx) => {
      assert.equal(indices[idx].length, sec.bars * ENGINE_STEPS_PER_BAR,
        `engine fired ${indices[idx].length} steps for a ${sec.bars}-bar section`);
      const voices = new Set([
        ...Object.keys(expected[idx]),
        ...Object.keys(data.sections[idx].voiceHits),
      ]);
      for (const voice of voices) {
        assert.deepEqual(
          hitPositions(data.sections[idx], voice),
          (expected[idx][voice] ?? []).sort((a, b) => a - b),
          `${sec.track}/${voice} disagrees with the scheduler`,
        );
      }
    });
  }

  it('matches the scheduler on the real chipfx score', async () => {
    const spec = JSON.parse(readFileSync(new URL('../examples/chipfx-audition-spec.json', import.meta.url), 'utf8'));
    await assertParity(spec);
  });

  it('matches the scheduler when a pattern length does not divide the bar', async () => {
    // len 24 against 16-step bars: the pattern phase carries across sections
    // for the same track and resets on a switch. Getting this wrong is exactly
    // the class of bug that crammed a section's hits into its first bar.
    const spec = baseScore();
    spec.tracks = {
      A: { bpm: 120, len: 24, vol: 0.8, steps: [
        { i: [0, 5, 17], voice: 'kick', opts: { vol: 0.4 } },
        { every: 6, voice: 'hat', opts: { vol: 0.2 } },
      ] },
      B: { bpm: 120, len: 24, vol: 0.8, steps: [{ i: 0, voice: 'snare', opts: { vol: 0.4 } }] },
    };
    spec.sections = [
      { track: 'A', bars: 2 },
      { track: 'A', bars: 1 },
      { track: 'B', bars: 1 },
      { track: 'A', bars: 3 },
    ];
    await assertParity(spec);
  });
});
