/**
 * Browser-side manifest and artifact identity.
 * Mirrors src/provenance.mjs but uses Web Crypto and browser runtime fields.
 */

import { shippingStatus } from '../src/spec.mjs';
import { COMPILER_VERSION } from '../src/version.mjs';
import { brightPlan, timbreDefs, timbreRow } from '../src/timbre.mjs';

export const MANIFEST_VERSION = '1.0.0';

/** Stable JSON representation used for artifact identity. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
export async function sha256(value) {
  let bytes;
  if (typeof value === 'string') bytes = new TextEncoder().encode(value);
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Build the sidecar payload for rendered WAV bytes. */
export async function createWavManifest(artifact, wav, audioBuffer, opts = {}) {
  const runtime = typeof globalThis.navigator !== 'undefined'
    ? { kind: 'browser', userAgent: globalThis.navigator.userAgent }
    : { kind: 'node', version: globalThis.process?.version };

  const shipping = shippingStatus(artifact);

  // Kit 1.11.0: which kits and patches (and their data hashes) made the sound.
  const defs = timbreDefs(artifact);
  let timbre = null;
  if (defs) {
    const row = async (def) => timbreRow(def, await sha256(canonicalJson(def)));
    timbre = {
      ...(defs.kits.length ? { kits: await Promise.all(defs.kits.map(row)) } : {}),
      ...(defs.patches.length ? { patches: await Promise.all(defs.patches.map(row)) } : {}),
      ...(defs.defaultKit !== undefined ? { defaultKit: defs.defaultKit } : {}),
      ...(defs.defaultPatches !== undefined ? { defaultPatches: defs.defaultPatches } : {}),
      ...(defs.graphSamples ? { graphSamples: true } : {}),
    };
  }

  // Kit 1.12.0: the bright-voice treatment, when it touched this render.
  const plan = brightPlan(artifact);
  const brightVoice = plan ? {
    preset: plan.preset.id,
    version: plan.preset.version,
    sha256: await sha256(canonicalJson(plan.preset)),
    explicit: artifact.brightVoice !== undefined,
    sides: Object.fromEntries(Object.entries(plan.voices).map(([cls, v]) => [cls, v.side > 0 ? 'right' : 'left'])),
  } : null;

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    schemaVersion: artifact.schemaVersion,
    kitVersion: artifact.kitVersion,
    seed: artifact.seed,
    register: artifact.register,
    artifactSha256: await sha256(canonicalJson(artifact)),
    shipping,
    ...(['1.10.0', '1.11.0', '1.12.0'].includes(artifact.kitVersion.semver) ? { compilerVersion: COMPILER_VERSION } : {}),
    ...(timbre ? { timbre } : {}),
    ...(brightVoice ? { brightVoice } : {}),
    ...(artifact.audition ? { audition: artifact.audition } : {}),
    render: Object.freeze({
      format: 'audio/wav; codec=pcm-s16le',
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      frames: audioBuffer.length,
      dither: false,
      toolchain: Object.freeze({
        runtime,
        nodeWebAudioApi: '2.2.0',
      }),
      determinismNote: 'Browser render; environment-scoped per docs/DETERMINISM.md',
    }),
    output: Object.freeze({
      bytes: wav.byteLength,
      sha256: await sha256(new Uint8Array(wav)),
    }),
  };
  if (opts.samples) manifest.samples = opts.samples;
  return Object.freeze(manifest);
}
