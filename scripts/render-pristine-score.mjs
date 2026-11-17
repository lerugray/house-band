#!/usr/bin/env node

// Reproducible A-side adapter: render a current doctrine score through a
// pristine pre-doctrine band.js without changing any musical score data. Only
// fields that did not exist in kit 1.3 are removed from an in-memory validation
// clone; the source score on disk remains the exact A/B artifact.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { OfflineAudioContext } from 'node-web-audio-api';

import { encodeWav } from '../src/wav.mjs';
import { compileTrackStep, specDuration, validateSpec } from '../src/spec.mjs';

const [scoreArg, kitArg, outArg] = process.argv.slice(2);
if (!scoreArg || !kitArg || !outArg) {
  console.error('Usage: node scripts/render-pristine-score.mjs <score.json> <pristine-band.js> <out.wav>');
  process.exit(2);
}

const scorePath = resolve(scoreArg);
const kitPath = resolve(kitArg);
const outPath = resolve(outArg);
const source = JSON.parse(await readFile(scorePath, 'utf8'));
const score = structuredClone(source);

score.kitVersion = {
  semver: '1.3.0',
  sha: '8ac798658c15d33ffbc6b1a4286bd155f78be4ffb825860d57958c7aca17680c',
};
delete score.register.class;
delete score.register.salientEventsPerMinute;
for (const track of Object.values(score.tracks)) {
  for (const event of track.steps) delete event.role;
}
for (const section of score.sections) delete section.execution;

const artifact = validateSpec(score);
const pristine = await import(pathToFileURL(kitPath).href);
const sampleRate = artifact.sampleRate;
const tail = pristine.RETIRE_TAIL + pristine.NEUTRAL_DEFAULTS.band.reverb.seconds
  + pristine.performanceReleaseTail(artifact.performance);
const totalSeconds = specDuration(artifact) + tail;
const context = new OfflineAudioContext(2, Math.max(1, Math.ceil(totalSeconds * sampleRate)), sampleRate);
let now = 0;
const band = pristine.createBand({
  ctx: context,
  seed: artifact.seed,
  gain: artifact.gain ?? 0.5,
  performance: artifact.performance,
  nowFn: () => now,
  strict: true,
  disconnectRetired: false,
});

for (const [name, track] of Object.entries(artifact.tracks)) {
  band.registerTrack(name, {
    bpm: track.bpm ?? artifact.tempo,
    len: track.len,
    vol: track.vol ?? 0.8,
    step: compileTrackStep(track),
  });
}

const tickStep = pristine.LOOKAHEAD / 2;
for (const section of artifact.sections) {
  const track = artifact.tracks[section.track];
  const bpm = track.bpm ?? artifact.tempo;
  const sectionSeconds = section.bars * (16 * (60 / bpm / 4));
  band.setTrack(section.track, { fadeIn: section.fadeIn ?? 0.05 });
  const end = now + sectionSeconds;
  while (now < end) {
    band.tick();
    now = Math.min(end, now + tickStep);
  }
  band.tick();
  now = end;
}
const scheduleEnd = now + Math.min(tail, pristine.LOOKAHEAD * 4);
while (now < scheduleEnd) {
  band.tick();
  now += tickStep;
}
if (band.stepErrors.length > 0) throw new AggregateError(band.stepErrors, 'pristine render step failure');

const wav = encodeWav(await context.startRendering());
band.dispose();
await writeFile(outPath, wav);
console.error(`wrote pristine kit 1.3 render ${outPath} (${wav.length} bytes)`);
