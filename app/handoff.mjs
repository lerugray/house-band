/** Surface D stems + REAPER handoff bundle. */

import { requireValidatedScoreArtifact, assertShippingPromotionAllowed } from '../src/spec.mjs';
import { bundleBaseName } from './bundle.mjs';
import { canonicalJson, sha256 } from './provenance.mjs';
import { generateRpp, sectionMarkers, validateRpp } from './reaper.mjs';
import { renderStemSet } from './stems.mjs';
import { createZip } from './zip.mjs';

export const STEM_SET_VERSION = '1.0.0';

export async function createHandoffBundle(artifact, opts = {}) {
  requireValidatedScoreArtifact(artifact);
  if (artifact.audition) assertShippingPromotionAllowed(artifact);
  const date = opts.date instanceof Date ? opts.date : new Date();
  const base = bundleBaseName(artifact, date);
  const rendered = await renderStemSet(artifact, { tailSeconds: opts.tailSeconds });
  const mixFilename = `${base}.mix.wav`;
  const stemFiles = rendered.stems.map((stem) => Object.freeze({
    voice: stem.voice,
    filename: `${base}.stem-${stem.voice}.wav`,
    stem,
  }));
  const rppFilename = `${base}.RPP`;
  const rpp = generateRpp(artifact, stemFiles, {
    frames: rendered.frames,
    sampleRate: rendered.sampleRate,
  });
  const markers = sectionMarkers(artifact);
  const rppStructure = validateRpp(rpp, {
    tempo: artifact.tempo ?? artifact.tracks[artifact.sections[0].track].bpm,
    voices: stemFiles.map((stem) => stem.voice),
    filenames: stemFiles.map((stem) => stem.filename),
    markers,
    length: rendered.frames / rendered.sampleRate,
  });
  const rppBytes = new TextEncoder().encode(rpp);
  const artifactSha256 = await sha256(canonicalJson(artifact));
  const manifestFilename = `${base}.stems.manifest.json`;
  const specFilename = `${base}.spec.json`;
  const manifest = Object.freeze({
    manifestVersion: STEM_SET_VERSION,
    kind: 'house-band-stem-set',
    schemaVersion: artifact.schemaVersion,
    kitVersion: artifact.kitVersion,
    seed: artifact.seed,
    register: artifact.register,
    artifactSha256,
    shipping: rendered.mix.manifest.shipping,
    render: Object.freeze({
      ...rendered.mix.manifest.render,
      alignment: Object.freeze({
        startFrame: 0,
        frames: rendered.frames,
        lengthSeconds: rendered.frames / rendered.sampleRate,
        tailIncluded: true,
        renderPasses: 'same validated artifact; full mix plus one voice-isolated pass per used voice',
      }),
    }),
    outputs: Object.freeze({
      mix: Object.freeze({
        filename: mixFilename,
        startFrame: 0,
        frames: rendered.frames,
        ...rendered.mix.manifest.output,
      }),
      stems: Object.freeze(stemFiles.map(({ voice, filename, stem }) => Object.freeze({
        voice,
        filename,
        startFrame: 0,
        frames: rendered.frames,
        ...stem.manifest.output,
      }))),
    }),
    reaperProject: Object.freeze({
      filename: rppFilename,
      bytes: rppBytes.byteLength,
      sha256: await sha256(rpp),
      tempo: artifact.tempo ?? artifact.tracks[artifact.sections[0].track].bpm,
      tracks: rppStructure.tracks,
      markers: Object.freeze(markers.map((marker) => ({ ...marker }))),
    }),
  });

  const entries = [
    { name: specFilename, data: `${JSON.stringify(artifact, null, 2)}\n` },
    { name: mixFilename, data: rendered.mix.wav },
    ...stemFiles.map(({ filename, stem }) => ({ name: filename, data: stem.wav })),
    { name: manifestFilename, data: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: rppFilename, data: rppBytes },
  ];

  return Object.freeze({
    filename: `${base}-stems-reaper.zip`,
    base,
    bytes: createZip(entries, { date }),
    entries: Object.freeze(entries.map((entry) => entry.name)),
    manifest,
    rpp,
  });
}
