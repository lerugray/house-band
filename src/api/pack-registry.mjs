import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  SAMPLE_PACK_FORMAT,
  SAMPLE_RENDERER_VERSION,
  SUPPORTED_SAMPLE_PACK_VERSIONS,
} from '../sample-pack.mjs';
import { loadSamplePackDirectory } from '../sample-pack-node.mjs';
import { KIT_VERSION } from '../version.mjs';
import { ApiError } from './errors.mjs';
import { CUSTODY_PROFILE_ID, RENDERER_BUILD } from './profile.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const PACK_COMPATIBILITY_ROW = Object.freeze({
  scoreSchemaVersion: '1.1.0',
  capability: 'M3 one-shot samples on canonical kick/snare/hat lanes, with optional synthesis',
  exactKit: KIT_VERSION,
  rendererBuild: `${RENDERER_BUILD} plus sample renderer ${SAMPLE_RENDERER_VERSION}`,
  custodyProfile: CUSTODY_PROFILE_ID,
  packRequirement: `${SAMPLE_PACK_FORMAT} ${SUPPORTED_SAMPLE_PACK_VERSIONS.join(' or ')} exact identity`,
});

function packSnapshotRef(identity) {
  return `hb-pack-snapshot/${identity.formatVersion}/${identity.packId}/${identity.manifestSha256}/${identity.contentSha256}`;
}

function packSummary(pack, snapshotPath) {
  const manifest = pack.manifest;
  const identity = Object.freeze({
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    packId: manifest.packId,
    manifestSha256: manifest.manifestSha256,
    contentSha256: manifest.contentSha256,
  });
  return Object.freeze({
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    packId: manifest.packId,
    displayName: manifest.displayName,
    manifestSha256: manifest.manifestSha256,
    contentSha256: manifest.contentSha256,
    installed: snapshotPath,
    immutableSnapshotAvailable: true,
    custodySnapshotRef: packSnapshotRef(identity),
    schemaCompatibility: ['1.1.0'],
    rendererCompatibility: Object.freeze(['hb-custody-render/1.0.0']),
    compatibilityRows: Object.freeze([PACK_COMPATIBILITY_ROW]),
    assets: Object.freeze(manifest.assets.map((asset) => Object.freeze({
      id: asset.id,
      wavSha256: asset.wavSha256,
      pcmSha256: asset.pcmSha256,
      allowedCanonicalLanes: Object.freeze([asset.suggestedVoice]),
      file: asset.file,
      frameCount: asset.frameCount,
      sampleRate: asset.sampleRate,
      channels: asset.channels,
      bitsPerSample: asset.bitsPerSample,
      peakAbs: asset.peakAbs,
      ...(asset.attribution === undefined ? {} : { attribution: asset.attribution }),
      ...(asset.licenseRef === undefined ? {} : { license: asset.licenseRef }),
    }))),
  });
}

export class PackRegistry {
  constructor({ packsRoot = resolve('sample-packs'), scanAtInit = true } = {}) {
    this.packsRoot = resolve(packsRoot);
    this.scanAtInit = scanAtInit;
    this.packs = new Map();
  }

  async init() {
    if (!this.scanAtInit) return this;
    const entries = await readdir(this.packsRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());
    for (const dir of dirs) {
      const snapshotPath = resolve(this.packsRoot, dir.name);
      try {
        const pack = await loadSamplePackDirectory(snapshotPath);
        const identity = {
          packId: pack.manifest.packId,
          formatVersion: pack.manifest.formatVersion,
          manifestSha256: pack.manifest.manifestSha256,
          contentSha256: pack.manifest.contentSha256,
        };
        this.packs.set(this.identityKey(identity), { pack, snapshotPath });
      } catch (cause) {
        throw new ApiError('ARTIFACT_WRITE_FAILED', `pack registry could not load ${snapshotPath}`, { details: { path: snapshotPath }, cause });
      }
    }
    return this;
  }

  identityKey(identity) {
    return `${identity.packId}|${identity.formatVersion}|${identity.manifestSha256}|${identity.contentSha256}`;
  }

  list() {
    return Object.freeze([...this.packs.values()].map(({ pack, snapshotPath }) => packSummary(pack, snapshotPath)));
  }

  availablePackIds() {
    return [...new Set([...this.packs.values()].map(({ pack }) => pack.manifest.packId))];
  }

  resolve(identity) {
    const requested = identity ?? null;
    if (!requested) return null;
    if (requested.format !== SAMPLE_PACK_FORMAT) {
      throw new ApiError('PACK_INCOMPATIBLE', `pack format "${requested.format}" is not supported`, {
        details: { requestedFormat: requested.format, supported: SAMPLE_PACK_FORMAT },
      });
    }
    if (!SUPPORTED_SAMPLE_PACK_VERSIONS.includes(requested.formatVersion)) {
      throw new ApiError('PACK_INCOMPATIBLE', `pack format version "${requested.formatVersion}" is not supported`, {
        details: { requestedFormatVersion: requested.formatVersion, supported: SUPPORTED_SAMPLE_PACK_VERSIONS },
      });
    }
    const byPackId = [...this.packs.values()].filter(({ pack }) => pack.manifest.packId === requested.packId);
    if (byPackId.length === 0) {
      throw new ApiError('PACK_MISSING', `exact pack identity "${requested.packId}" is not installed`, {
        details: { requested },
      });
    }
    const found = byPackId.find(({ pack }) =>
      pack.manifest.manifestSha256 === requested.manifestSha256
      && pack.manifest.contentSha256 === requested.contentSha256);
    if (!found) {
      throw new ApiError('PACK_IDENTITY_MISMATCH', 'requested pack identity does not match installed snapshot', {
        details: { requested, installed: byPackId.map(({ pack }) => this.installedIdentity(pack)) },
      });
    }
    return Object.freeze({ pack: found.pack, snapshotPath: found.snapshotPath });
  }

  installedIdentity(pack) {
    return Object.freeze({
      format: pack.manifest.format,
      formatVersion: pack.manifest.formatVersion,
      packId: pack.manifest.packId,
      manifestSha256: pack.manifest.manifestSha256,
      contentSha256: pack.manifest.contentSha256,
    });
  }
}

export function packCustodyIdentity(pack) {
  return Object.freeze({
    format: SAMPLE_PACK_FORMAT,
    formatVersion: pack.manifest.formatVersion,
    packId: pack.manifest.packId,
    manifestSha256: pack.manifest.manifestSha256,
    contentSha256: pack.manifest.contentSha256,
    sampleRendererVersion: SAMPLE_RENDERER_VERSION,
    referencedAssets: Object.freeze(pack.manifest.assets.map((asset) => Object.freeze({
      assetId: asset.id,
      wavSha256: asset.wavSha256,
      pcmSha256: asset.pcmSha256,
      allowedCanonicalLanes: Object.freeze([asset.suggestedVoice]),
    }))),
  });
}

export async function loadPackSidecar(snapshotPath) {
  const pack = await loadSamplePackDirectory(snapshotPath);
  const files = new Map();
  files.set('pack.json', await readFile(resolve(snapshotPath, 'pack.json')));
  for (const asset of pack.manifest.assets) {
    files.set(asset.file, await readFile(resolve(snapshotPath, asset.file)));
  }
  return { pack, files };
}
