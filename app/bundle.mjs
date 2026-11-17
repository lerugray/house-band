/** Surface C accepted-take bundle. */

import { requireValidatedScoreArtifact, assertShippingPromotionAllowed } from '../src/spec.mjs';
import { canonicalJson, sha256 } from './provenance.mjs';
import { createZip } from './zip.mjs';

function datePart(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-');
}

function safePart(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'score';
}

export function bundleBaseName(artifact, date = new Date()) {
  requireValidatedScoreArtifact(artifact);
  return `house-band-${safePart(artifact.register.name)}-seed-${artifact.seed}-${datePart(date)}`;
}

export async function createAcceptedBundle(artifact, wav, manifest, opts = {}) {
  requireValidatedScoreArtifact(artifact);
  if (artifact.audition) assertShippingPromotionAllowed(artifact);
  const date = opts.date instanceof Date ? opts.date : new Date();
  const wavBytes = wav instanceof ArrayBuffer ? new Uint8Array(wav) : new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
  const artifactHash = await sha256(canonicalJson(artifact));
  const wavHash = await sha256(wavBytes);
  if (manifest.artifactSha256 !== artifactHash) throw new Error('manifest artifact hash does not match accepted spec');
  if (manifest.output?.sha256 !== wavHash || manifest.output?.bytes !== wavBytes.byteLength) {
    throw new Error('manifest output does not match accepted WAV');
  }

  const base = bundleBaseName(artifact, date);
  const entries = [
    { name: `${base}.spec.json`, data: `${JSON.stringify(artifact, null, 2)}\n` },
    { name: `${base}.wav`, data: wavBytes },
    { name: `${base}.manifest.json`, data: `${JSON.stringify(manifest, null, 2)}\n` },
  ];
  return Object.freeze({
    filename: `${base}.zip`,
    base,
    entries: Object.freeze(entries.map((entry) => entry.name)),
    bytes: createZip(entries, { date }),
  });
}
