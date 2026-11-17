import { COMPILER_VERSION } from './version.mjs';
import { brightProvenance } from './timbre.mjs';
import { timbreProvenanceWithUser } from './user-timbres.mjs';
import { createHash } from 'node:crypto';

import { requireValidatedScoreArtifact, shippingStatus } from './spec.mjs';

export const MANIFEST_VERSION = '1.0.0';

/** Stable JSON representation used for artifact identity. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Build the sidecar payload for rendered WAV bytes. */
export function createWavManifest(artifact, wav, audioBuffer, opts = {}) {
  requireValidatedScoreArtifact(artifact);
  const shipping = shippingStatus(artifact);
  // Kit 1.11.0: which kits and patches (and their data hashes) made the sound.
  // null, and therefore absent, for a score that names none.
  // OSS-13: the same block for every score that names no `user:` timbre; user rows add their pack custody.
  const timbre = timbreProvenanceWithUser(artifact, sha256, canonicalJson);
  // Kit 1.12.0: the bright-voice treatment, when it touched this render (absent otherwise).
  const brightVoice = brightProvenance(artifact, sha256, canonicalJson);
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    schemaVersion: artifact.schemaVersion,
    kitVersion: artifact.kitVersion,
    seed: artifact.seed,
    register: artifact.register,
    artifactSha256: sha256(canonicalJson(artifact)),
    shipping,
    ...(artifact.audition ? { audition: artifact.audition } : {}),
    ...(['1.10.0', '1.11.0', '1.12.0'].includes(artifact.kitVersion.semver) ? { compilerVersion: COMPILER_VERSION } : {}),
    ...(timbre ? { timbre } : {}),
    ...(brightVoice ? { brightVoice } : {}),
    render: Object.freeze({
      format: 'audio/wav; codec=pcm-s16le',
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      frames: audioBuffer.length,
      dither: false,
      toolchain: Object.freeze({
        node: process.version,
        nodeWebAudioApi: '2.2.0',
        platform: process.platform,
        arch: process.arch,
      }),
    }),
    output: Object.freeze({
      bytes: wav.length,
      sha256: sha256(wav),
    }),
  };
  if (opts.samples) manifest.samples = opts.samples;
  return Object.freeze(manifest);
}
