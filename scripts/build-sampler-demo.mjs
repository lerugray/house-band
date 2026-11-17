#!/usr/bin/env node
/**
 * Author the kit-1.7.0 sampler demo score.
 *
 * Zone maps and PCM hashes are read out of the built pack rather than typed in,
 * so the score can never drift from the assets it pins. Run after
 * `tools/build-pack.mjs` rebuilds `sample-packs/sampler-demo-17`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KIT_VERSION, SCHEMA_VERSION } from '../src/version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(join(root, 'sample-packs', 'sampler-demo-17', 'pack.json'), 'utf8'));
const asset = (id) => {
  const found = pack.assets.find((entry) => entry.id === id);
  if (!found) throw new Error(`pack is missing asset ${id}`);
  return found;
};
const zone = (id, lo, hi) => {
  const source = asset(id);
  return { lo, hi, rootNote: source.rootNote, assetId: id, pcmSha256: source.pcmSha256 };
};

/**
 * Zone boundaries sit at the midpoint between neighbouring roots, so no note
 * ever stretches further than half the sampling step. HUMBUCKER's 4-semitone
 * step means +/-2 semitones worst case; the SNES RHODES octave step means
 * +/-6, which is audible but is what an octave-spaced multisample costs.
 */
const sampleVoices = {
  // Ray's flagged guitar, in his own stacking pattern.
  pluck: {
    kind: 'sampler',
    gain: 0.62,
    release: 0.05,
    zones: [
      zone('humbucker-c3', 46, 49),
      zone('humbucker-e3', 50, 53),
      zone('humbucker-gs3', 54, 58),
    ],
  },
  // Electric piano, carrying the low chord the fleet keeps needing.
  bell: {
    kind: 'sampler',
    gain: 0.78,
    release: 0.08,
    zones: [
      zone('snes-rhodes-low', 30, 41),
      zone('snes-rhodes-mid', 42, 53),
      zone('snes-rhodes-high', 54, 66),
    ],
  },
  bass: {
    kind: 'sampler',
    gain: 0.85,
    release: 0.04,
    zones: [zone('ms20-daf-bass', 26, 48)],
  },
  lead: {
    kind: 'sampler',
    gain: 0.44,
    release: 0.06,
    zones: [zone('ms20-square-lead', 50, 74)],
  },
};

const spec = {
  schemaVersion: SCHEMA_VERSION,
  kitVersion: KIT_VERSION,
  seed: 1707,
  tempo: 84,
  sampleRate: 44100,
  gain: 0.5,
  label: 'Kit 1.7.0 sampler proof: pitched multisample zones on guitar, electric piano, bass, and lead, with a low chord voiced on sampled EP and guitar material.',
  register: {
    name: 'sampler-proof',
    briefRef: 'docs/RAY-SAMPLES-TIMBRE-CATALOG-2026-08-29.md',
  },
  samplePack: {
    packId: pack.packId,
    formatVersion: pack.formatVersion,
    manifestSha256: pack.manifestSha256,
    contentSha256: pack.contentSha256,
  },
  sampleVoices,
  performance: {
    humanize: { timingMs: [-9, 9], velocity: [-0.07, 0.07], swing: 0.04 },
  },
  tracks: {
    // A — the low chord, stated bare. EP C2/G2/Eb3 spans two zones: C2 is an
    // exact root, G2 stretches down 5 semitones, Eb3 up 3.
    lowChord: {
      bpm: 84,
      len: 16,
      vol: 0.9,
      steps: [
        { i: 0, voice: 'bell', note: 'C2', dur: 2.6, opts: { vol: 1 } },
        { i: 0, voice: 'bell', note: 'G2', dur: 2.6, opts: { vol: 0.8 } },
        { i: 0, voice: 'bell', note: 'D#3', dur: 2.6, opts: { vol: 0.7 } },
        { i: 0, voice: 'bass', note: 'C2', dur: 2.6, opts: { vol: 0.9 } },
        { i: 8, voice: 'bass', note: 'G1', dur: 1.2, opts: { vol: 0.6 } },
      ],
    },
    // B — guitar takes the harmony. Bars alternate the native augmented stack
    // (C/E/G#, three exact roots, zero resampling) against a real C minor
    // triad, whose G3 is a one-semitone stretch off the G#3 root.
    verse: {
      bpm: 84,
      len: 32,
      vol: 0.9,
      steps: [
        { i: [0, 16], voice: 'bass', note: 'C2', dur: 1.4, opts: { vol: 0.95 } },
        { i: [6, 22], voice: 'bass', note: 'G1', dur: 0.7, opts: { vol: 0.55 } },
        { i: [12], voice: 'bass', note: 'A#1', dur: 0.7, opts: { vol: 0.6 } },
        { i: [28], voice: 'bass', note: 'G#1', dur: 0.9, opts: { vol: 0.6 } },
        { i: 0, voice: 'pluck', note: 'C3', dur: 1.5, opts: { vol: 0.9 } },
        { i: 0, voice: 'pluck', note: 'E3', dur: 1.5, opts: { vol: 0.75 } },
        { i: 0, voice: 'pluck', note: 'G#3', dur: 1.5, opts: { vol: 0.7 } },
        { i: 16, voice: 'pluck', note: 'C3', dur: 1.5, opts: { vol: 0.9 } },
        { i: 16, voice: 'pluck', note: 'D#3', dur: 1.5, opts: { vol: 0.75 } },
        { i: 16, voice: 'pluck', note: 'G3', dur: 1.5, opts: { vol: 0.7 } },
        { i: [10, 26], voice: 'bell', note: 'C4', dur: 0.5, opts: { vol: 0.45 } },
        { i: [13], voice: 'bell', note: 'D#4', dur: 0.5, opts: { vol: 0.4 } },
        { i: [29], voice: 'bell', note: 'A#3', dur: 0.5, opts: { vol: 0.4 } },
      ],
    },
    // C — the lead enters over a thinned bed, walking the resampler from an
    // exact root out to a full octave up.
    turn: {
      bpm: 84,
      len: 32,
      vol: 0.9,
      steps: [
        { i: [0, 16], voice: 'bass', note: 'G#1', dur: 1.4, opts: { vol: 0.9 } },
        { i: [8, 24], voice: 'bass', note: 'A#1', dur: 0.9, opts: { vol: 0.6 } },
        { i: 0, voice: 'pluck', note: 'G#3', dur: 1.4, opts: { vol: 0.6 } },
        { i: 8, voice: 'pluck', note: 'D#3', dur: 1.4, opts: { vol: 0.55 } },
        { i: 16, voice: 'pluck', note: 'A#3', dur: 1.4, opts: { vol: 0.6 } },
        { i: 24, voice: 'pluck', note: 'D3', dur: 1.4, opts: { vol: 0.55 } },
        { i: 0, voice: 'lead', note: 'C4', dur: 0.8, opts: { vol: 0.9 } },
        { i: 4, voice: 'lead', note: 'D#4', dur: 0.5, opts: { vol: 0.8 } },
        { i: 6, voice: 'lead', note: 'G4', dur: 1.1, opts: { vol: 0.85 } },
        { i: 12, voice: 'lead', note: 'A#4', dur: 0.5, opts: { vol: 0.75 } },
        { i: 16, voice: 'lead', note: 'C5', dur: 1.3, opts: { vol: 0.9 } },
        { i: 22, voice: 'lead', note: 'G4', dur: 0.6, opts: { vol: 0.7 } },
        { i: 26, voice: 'lead', note: 'D#4', dur: 1.4, opts: { vol: 0.65 } },
      ],
    },
  },
  sections: [
    { track: 'lowChord', bars: 1, fadeIn: 0.05 },
    { track: 'verse', bars: 2 },
    { track: 'turn', bars: 2 },
    { track: 'verse', bars: 1 },
  ],
};

const out = join(root, 'examples', 'sampler-demo-spec.json');
writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
console.error(`wrote ${out}`);
