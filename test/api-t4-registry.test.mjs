import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { pinnedSkip, packSkip } from './helpers/env.mjs';

import { createApiHttpServer, listenLoopback } from '../src/api/http.mjs';
import { PackRegistry } from '../src/api/pack-registry.mjs';
import { HouseBandApiService } from '../src/api/service.mjs';
import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packRoot = join(repoRoot, 'sample-packs', 'hb-synth-oneshots');

function artifacts(job, kind) {
  return job.artifacts.filter((artifact) => artifact.kind === kind);
}

async function withServer(service, fn) {
  const server = createApiHttpServer(service, { allowedHosts: [] });
  const address = await listenLoopback(server, { host: '127.0.0.1', port: 0 });
  const base = `http://${address.address}:${address.port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function httpJson(base, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

describe('House Band API tranche 4 — pack registry', { skip: packSkip('hb-synth-oneshots') }, () => {
  let root;
  let service;
  let pack;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'house-band-api-t4-'));
    service = await new HouseBandApiService({ storeRoot: root }).init();
    pack = await loadSamplePackDirectory(packRoot);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('GET /v1/packs returns validated entries with exact identity, custody snapshot ref, and compatibility rows', async () => {
    await withServer(service, async (base) => {
      const response = await httpJson(base, { path: '/v1/packs' });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(response.body.packs));
      assert.ok(response.body.packs.length >= 1);
      const entry = response.body.packs.find((p) => p.packId === 'hb-synth-oneshots');
      assert.ok(entry, 'hb-synth-oneshots entry must be present');
      assert.equal(entry.format, 'house-band-sample-pack');
      assert.equal(entry.formatVersion, '1.1.0');
      assert.equal(entry.manifestSha256, pack.manifest.manifestSha256);
      assert.equal(entry.contentSha256, pack.manifest.contentSha256);
      assert.equal(entry.immutableSnapshotAvailable, true);
      assert.equal(typeof entry.custodySnapshotRef, 'string');
      assert.ok(entry.custodySnapshotRef.startsWith('hb-pack-snapshot/'));
      assert.ok(Array.isArray(entry.compatibilityRows));
      assert.ok(entry.compatibilityRows.length >= 1);
      for (const row of entry.compatibilityRows) {
        assert.equal(row.scoreSchemaVersion, '1.1.0');
        assert.equal(typeof row.capability, 'string');
        assert.equal(row.custodyProfile, 'hb-custody-render/1.0.0');
        assert.ok(row.packRequirement.includes('house-band-sample-pack'));
      }
      assert.ok(entry.assets.length >= 3);
      for (const asset of entry.assets) {
        assert.ok(Array.isArray(asset.allowedCanonicalLanes));
        assert.equal(typeof asset.wavSha256, 'string');
        assert.equal(typeof asset.pcmSha256, 'string');
      }
    });
  });

  it('resolves a required exact pack identity and binds assets with exact hashes and lane bindings', { skip: pinnedSkip() }, async () => {
    const packRequest = {
      format: 'house-band-sample-pack',
      formatVersion: '1.1.0',
      packId: pack.manifest.packId,
      manifestSha256: pack.manifest.manifestSha256,
      contentSha256: pack.manifest.contentSha256,
      policy: 'required',
      assetAllowlist: ['kick'],
    };
    const submitted = await service.submitSong({
      prompt: 'Registry resolution proof with asset allowlist.',
      seed: 0xdecafbad,
      canonicalVoiceAllowlist: ['kick'],
      pack: packRequest,
      render: { fullMix: true },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'succeeded');
    assert.equal(job.admission.pack.resolvedAssets.length, 1);
    assert.equal(job.admission.pack.resolvedAssets[0].id, 'kick');
    assert.equal(job.admission.pack.resolvedAssets[0].pcmSha256, pack.assets.kick.metadata.pcmSha256);
    assert.deepEqual(job.admission.pack.resolvedAssets[0].allowedCanonicalLanes, ['kick']);
  });

  it('falls back to synthesis when a preferred exact pack identity is unavailable', { skip: pinnedSkip() }, async () => {
    const submitted = await service.submitSong({
      prompt: 'Preferred pack fallback proof.',
      seed: 0xdecafbad,
      canonicalVoiceAllowlist: ['kick', 'snare', 'hat'],
      pack: {
        format: 'house-band-sample-pack',
        formatVersion: '1.0.0',
        packId: 'no-such-pack-installed',
        manifestSha256: '0000000000000000000000000000000000000000000000000000000000000000',
        contentSha256: '0000000000000000000000000000000000000000000000000000000000000000',
        policy: 'preferred',
      },
      render: { fullMix: true },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'succeeded');
    assert.equal(job.admission.pack, null);
    assert.ok(job.admission.packFallback, 'fallback must be recorded in admission');
    assert.equal(job.admission.packFallback.policy, 'preferred');
    assert.equal(job.admission.compatibility.packRequirement, null);
    assert.equal(job.admission.compatibility.capability, 'synthesis');

    const scoreArtifact = artifacts(job, 'score')[0];
    const score = JSON.parse((await service.getArtifact(job.jobId, scoreArtifact.artifactId)).bytes);
    assert.equal(score.samplePack, undefined);
    assert.equal(score.sampleVoices, undefined);

    const manifestArtifact = artifacts(job, 'manifest')[0];
    const manifest = JSON.parse((await service.getArtifact(job.jobId, manifestArtifact.artifactId)).bytes);
    assert.equal(manifest.m3, null);

    const eventResponse = await service.eventStream(job.jobId, 0);
    const admissionEvent = eventResponse.events.find((e) => e.event === 'admission_completed');
    assert.ok(admissionEvent);
    assert.equal(admissionEvent.data.packResolved, false);
    assert.equal(admissionEvent.data.packFallback.policy, 'preferred');

    const provenanceArtifact = artifacts(job, 'provenance')[0];
    const provenance = JSON.parse((await service.getArtifact(job.jobId, provenanceArtifact.artifactId)).bytes);
    assert.ok(provenance.packFallback);
    assert.equal(provenance.packFallback.policy, 'preferred');
    assert.equal(provenance.exactPackResolution, null);
  });

  it('fails before composition with PACK_MISSING for a required unavailable pack', async () => {
    await assert.rejects(
      () => service.submitSong({
        prompt: 'required pack missing',
        pack: {
          format: 'house-band-sample-pack',
          formatVersion: '1.0.0',
          packId: 'also-not-installed',
          manifestSha256: '0000000000000000000000000000000000000000000000000000000000000000',
          contentSha256: '0000000000000000000000000000000000000000000000000000000000000000',
          policy: 'required',
        },
      }),
      (error) => error.code === 'PACK_MISSING' && error.stage === 'admitting',
    );
  });

  it('fails before composition with PACK_IDENTITY_MISMATCH for a mismatched exact identity', async () => {
    await assert.rejects(
      () => service.submitSong({
        prompt: 'mismatched pack',
        pack: {
          format: 'house-band-sample-pack',
          formatVersion: '1.1.0',
          packId: pack.manifest.packId,
          manifestSha256: pack.manifest.manifestSha256,
          contentSha256: '0000000000000000000000000000000000000000000000000000000000000000',
          policy: 'required',
        },
      }),
      (error) => error.code === 'PACK_IDENTITY_MISMATCH' && error.stage === 'admitting',
    );
  });

  it('fails before composition with INVALID_REQUEST for an unsupported pack format or version', async () => {
    await assert.rejects(
      () => service.submitSong({
        prompt: 'bad pack format',
        pack: {
          format: 'other-pack-format',
          formatVersion: '1.0.0',
          packId: pack.manifest.packId,
          manifestSha256: pack.manifest.manifestSha256,
          contentSha256: pack.manifest.contentSha256,
          policy: 'required',
        },
      }),
      (error) => error.code === 'INVALID_REQUEST',
    );
    await assert.rejects(
      () => service.submitSong({
        prompt: 'bad pack version',
        pack: {
          format: 'house-band-sample-pack',
          formatVersion: '2.0.0',
          packId: pack.manifest.packId,
          manifestSha256: pack.manifest.manifestSha256,
          contentSha256: pack.manifest.contentSha256,
          policy: 'required',
        },
      }),
      (error) => error.code === 'INVALID_REQUEST',
    );
  });

  it('PackRegistry.resolve reports the spec error codes for registry surface failures', async () => {
    const registry = new PackRegistry({ scanAtInit: false });
    await registry.init();
    assert.throws(
      () => registry.resolve({
        format: 'other-pack-format',
        formatVersion: '1.0.0',
        packId: 'any',
        manifestSha256: '0000000000000000000000000000000000000000000000000000000000000000',
        contentSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      }),
      (error) => error.code === 'PACK_INCOMPATIBLE',
    );
    assert.throws(
      () => registry.resolve({
        format: 'house-band-sample-pack',
        formatVersion: '2.0.0',
        packId: 'any',
        manifestSha256: '0000000000000000000000000000000000000000000000000000000000000000',
        contentSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      }),
      (error) => error.code === 'PACK_INCOMPATIBLE',
    );
    assert.throws(
      () => registry.resolve({
        format: 'house-band-sample-pack',
        formatVersion: '1.0.0',
        packId: 'not-installed',
        manifestSha256: '0000000000000000000000000000000000000000000000000000000000000000',
        contentSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      }),
      (error) => error.code === 'PACK_MISSING',
    );
  });
});
