/** Surface D sample-aligned mix and isolated per-voice render passes. */

import { ALL_VOICES, requireValidatedScoreArtifact } from '../src/spec.mjs';
import { renderScoreToWav } from './render.mjs';

export function voicesInArtifact(artifact) {
  requireValidatedScoreArtifact(artifact);
  const used = new Set();
  for (const track of Object.values(artifact.tracks)) {
    for (const event of track.steps) used.add(event.voice ?? event.v);
  }
  return Object.freeze(ALL_VOICES.filter((voice) => used.has(voice)));
}

export async function renderStemSet(artifact, opts = {}) {
  requireValidatedScoreArtifact(artifact);
  const voices = voicesInArtifact(artifact);
  const [mix, ...isolated] = await Promise.all([
    renderScoreToWav(artifact, opts),
    ...voices.map((voice) => renderScoreToWav(artifact, { ...opts, voice })),
  ]);
  const frames = mix.manifest.render.frames;
  const sampleRate = mix.manifest.render.sampleRate;
  const stems = voices.map((voice, index) => {
    const stem = isolated[index];
    if (stem.manifest.artifactSha256 !== mix.manifest.artifactSha256) {
      throw new Error(`stem ${voice} does not share the mix artifact identity`);
    }
    if (stem.manifest.render.frames !== frames || stem.manifest.render.sampleRate !== sampleRate) {
      throw new Error(`stem ${voice} is not sample-aligned with the mix`);
    }
    return Object.freeze({ voice, wav: stem.wav, manifest: stem.manifest });
  });
  return Object.freeze({ mix, stems: Object.freeze(stems), frames, sampleRate });
}
