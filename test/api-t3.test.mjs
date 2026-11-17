import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { pinnedSkip, packSkip } from './helpers/env.mjs';

import { createApiHttpServer, listenLoopback } from '../src/api/http.mjs';
import { CUSTODY_PROFILE_ID } from '../src/api/profile.mjs';
import { HouseBandApiService } from '../src/api/service.mjs';
import { readWavHeader } from '../src/wav.mjs';
import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { sha256 } from '../src/provenance.mjs';

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

async function httpBuffer(base, path) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
}

describe('House Band API tranche 3', { skip: packSkip('hb-synth-oneshots') || pinnedSkip() }, () => {
  let root;
  let service;
  let score;
  let scoreArtifactSha256;
  let pack;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'house-band-api-t3-'));
    service = await new HouseBandApiService({ storeRoot: root }).init();
    pack = await loadSamplePackDirectory(packRoot);

    const submitted = await service.submitSong({
      prompt: 'A deterministic pulse for derivative render proof.',
      seed: 0xdecafbad,
      canonicalVoiceAllowlist: ['kick', 'snare', 'hat'],
      render: { fullMix: true, stems: false },
      duration: { targetBars: 4 },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'succeeded');
    const scoreArtifact = artifacts(job, 'score')[0];
    scoreArtifactSha256 = scoreArtifact.sha256;
    score = JSON.parse((await service.getArtifact(job.jobId, scoreArtifact.artifactId)).bytes.toString('utf8'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function recipe(overrides = {}) {
    return {
      rendererIdentity: 'house-band-derivative-processor/1.0.0',
      sourceArtifactSha256: scoreArtifactSha256,
      output: {
        sampleRate: 22050,
        bitDepth: 16,
        channelLayout: 'mono',
        tailSeconds: 0.75,
        ...overrides,
      },
    };
  }

  it('rejects derivative mode request errors before rendering', async () => {
    await assert.rejects(
      () => service.submitRender({ score, mode: 'derivative' }),
      (error) => error.code === 'INVALID_REQUEST' && /derivativeRecipe is required/.test(error.message),
    );
    await assert.rejects(
      () => service.submitRender({ score, mode: 'canonical', derivativeRecipe: recipe() }),
      (error) => error.code === 'INVALID_REQUEST' && /forbidden for canonical mode/.test(error.message),
    );
    await assert.rejects(
      () => service.submitRender({ score, mode: 'derivative', derivativeRecipe: recipe(), outputs: { stems: true } }),
      (error) => error.code === 'INVALID_REQUEST' && /derivative mode.*fullMix only/.test(error.message),
    );
    await assert.rejects(
      () => service.submitRender({ score, mode: 'derivative', derivativeRecipe: { ...recipe(), sourceArtifactSha256: '0'.repeat(64) } }),
      (error) => error.code === 'INVALID_REQUEST' && /sourceArtifactSha256/.test(error.message),
    );
  });

  it('renders a noncanonical derivative output with a complete recipe and distinct hash', async () => {
    const submitted = await service.submitRender({
      score,
      mode: 'derivative',
      derivativeRecipe: recipe(),
      outputs: { fullMix: true },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'succeeded');

    const recipeArtifact = artifacts(job, 'derivative_recipe')[0];
    const derivativeArtifact = artifacts(job, 'wav_derivative')[0];
    const mixArtifact = artifacts(job, 'wav_mix')[0];
    assert.ok(recipeArtifact, 'derivative recipe artifact must exist');
    assert.ok(derivativeArtifact, 'derivative wav artifact must exist');
    assert.ok(mixArtifact, 'canonical mix artifact must still exist');
    assert.equal(recipeArtifact.acceptance, 'derivative');
    assert.equal(derivativeArtifact.acceptance, 'derivative');
    assert.equal(mixArtifact.acceptance, 'accepted');
    assert.notEqual(derivativeArtifact.sha256, mixArtifact.sha256, 'derivative hash must differ from canonical mix hash');

    const derivativeBytes = (await service.getArtifact(job.jobId, derivativeArtifact.artifactId)).bytes;
    const header = readWavHeader(derivativeBytes);
    assert.equal(header.sampleRate, 22050);
    assert.equal(header.bitsPerSample, 16);
    assert.equal(header.numChannels, 1);

    const manifestArtifact = artifacts(job, 'manifest')[0];
    const manifest = JSON.parse((await service.getArtifact(job.jobId, manifestArtifact.artifactId)).bytes.toString('utf8'));
    assert.ok(manifest.derivatives, 'manifest must include derivatives array');
    assert.equal(manifest.derivatives.length, 1);
    assert.equal(manifest.derivatives[0].recipeSha256, recipeArtifact.sha256);
    assert.equal(manifest.derivatives[0].sha256, derivativeArtifact.sha256);
    assert.equal(manifest.derivatives[0].output.sampleRate, 22050);
    assert.equal(manifest.derivatives[0].output.bitDepth, 16);
    assert.equal(manifest.derivatives[0].output.channelLayout, 'mono');
    assert.equal(manifest.derivatives[0].output.tailSeconds, 0.75);
    assert.equal(manifest.fullMix.sha256, mixArtifact.sha256);

    const provenanceArtifact = artifacts(job, 'provenance')[0];
    const provenance = JSON.parse((await service.getArtifact(job.jobId, provenanceArtifact.artifactId)).bytes.toString('utf8'));
    assert.ok(provenance.derivatives, 'provenance must record derivatives');
    assert.equal(provenance.derivatives[0].recipeSha256, recipeArtifact.sha256);
    assert.equal(provenance.derivatives[0].outputSha256, derivativeArtifact.sha256);
    assert.equal(provenance.hashDomain.some((entry) => entry.kind === 'derivative_recipe' || entry.kind === 'wav_derivative'), false,
      'derivative artifacts must not be in the canonical provenance hash domain');
    assert.equal(job.provenanceSummary.derivativeOutputSha256, derivativeArtifact.sha256);
  });

  it('produces deterministic derivative hashes for the same recipe and score', async () => {
    const request = {
      score,
      mode: 'derivative',
      derivativeRecipe: recipe(),
      outputs: { fullMix: true },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    };
    const first = await (await service.submitRender(request)).completion;
    const second = await (await service.submitRender(request)).completion;
    assert.equal(first.state, 'succeeded');
    assert.equal(second.state, 'succeeded');
    assert.equal(artifacts(first, 'wav_derivative')[0].sha256, artifacts(second, 'wav_derivative')[0].sha256);
    assert.equal(artifacts(first, 'derivative_recipe')[0].sha256, artifacts(second, 'derivative_recipe')[0].sha256);
  });

  it('derivatives from a pack-backed score use the admitted pack and remain noncanonical', async () => {
    const packRequest = {
      format: 'house-band-sample-pack',
      formatVersion: '1.1.0',
      packId: pack.manifest.packId,
      manifestSha256: pack.manifest.manifestSha256,
      contentSha256: pack.manifest.contentSha256,
      policy: 'required',
    };
    const submitted = await service.submitSong({
      prompt: 'Pack-backed derivative source.',
      seed: 0xc0ffee,
      canonicalVoiceAllowlist: ['kick', 'snare', 'hat'],
      pack: packRequest,
      render: { fullMix: true, stems: false },
      duration: { targetBars: 4 },
    });
    const source = await submitted.completion;
    assert.equal(source.state, 'succeeded');
    const sourceScoreArtifact = artifacts(source, 'score')[0];
    const sourceScore = JSON.parse((await service.getArtifact(source.jobId, sourceScoreArtifact.artifactId)).bytes.toString('utf8'));

    const derivativeJob = await (await service.submitRender({
      score: sourceScore,
      mode: 'derivative',
      derivativeRecipe: {
        rendererIdentity: 'house-band-derivative-processor/1.0.0',
        sourceArtifactSha256: sourceScoreArtifact.sha256,
        output: { sampleRate: 48000, bitDepth: 24, channelLayout: 'stereo', tailSeconds: 1.45 },
      },
      outputs: { fullMix: true },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    })).completion;
    assert.equal(derivativeJob.state, 'succeeded');

    const derivativeArtifact = artifacts(derivativeJob, 'wav_derivative')[0];
    const derivativeBytes = (await service.getArtifact(derivativeJob.jobId, derivativeArtifact.artifactId)).bytes;
    const header = readWavHeader(derivativeBytes);
    assert.equal(header.sampleRate, 48000);
    assert.equal(header.bitsPerSample, 24);
    assert.equal(header.numChannels, 2);

    const manifest = JSON.parse((await service.getArtifact(derivativeJob.jobId, artifacts(derivativeJob, 'manifest')[0].artifactId)).bytes.toString('utf8'));
    assert.ok(manifest.m3, 'pack-backed derivative manifest must still retain M3 identity');
    assert.ok(manifest.derivatives);
    assert.notEqual(manifest.derivatives[0].sha256, manifest.fullMix.sha256);
  });

  it('emits artifact_written events for derivative artifacts', async () => {
    const submitted = await service.submitRender({
      score,
      mode: 'derivative',
      derivativeRecipe: recipe(),
      outputs: { fullMix: true },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    });
    const job = await submitted.completion;
    const eventsResponse = await service.eventStream(job.jobId, 0);
    const artifactEvents = eventsResponse.events.filter((event) => event.event === 'artifact_written');
    assert.equal(artifactEvents.length, 2);
    assert.ok(artifactEvents.some((event) => event.data.kind === 'derivative_recipe'));
    assert.ok(artifactEvents.some((event) => event.data.kind === 'wav_derivative'));
  });

  it('exposes derivative renders through the HTTP surface', async () => {
    await withServer(service, async (base) => {
      const response = await httpJson(base, {
        method: 'POST',
        path: '/v1/renders',
        body: {
          score,
          mode: 'derivative',
          derivativeRecipe: recipe(),
          outputs: { fullMix: true },
          execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
        },
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.state, 'succeeded');

      const status = await httpJson(base, { path: response.body.links.status });
      const job = status.body;
      const derivativeArtifact = job.artifacts.find((artifact) => artifact.kind === 'wav_derivative');
      assert.ok(derivativeArtifact);

      const download = await httpBuffer(base, `/v1/jobs/${job.jobId}/artifacts/${derivativeArtifact.artifactId}`);
      assert.equal(download.status, 200);
      assert.equal(download.body.length, derivativeArtifact.sizeBytes);
      const header = readWavHeader(download.body);
      assert.equal(header.sampleRate, 22050);
    });
  });

  it('keeps the canonical render hash unchanged when a derivative is produced from the same score', async () => {
    const canonical = await (await service.submitRender({
      score,
      custodyProfileId: CUSTODY_PROFILE_ID,
      outputs: { fullMix: true },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    })).completion;
    assert.equal(canonical.state, 'succeeded');

    const derivative = await (await service.submitRender({
      score,
      mode: 'derivative',
      derivativeRecipe: recipe({ sampleRate: 44100, bitDepth: 16, channelLayout: 'stereo', tailSeconds: 1.45 }),
      outputs: { fullMix: true },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    })).completion;
    assert.equal(derivative.state, 'succeeded');

    const canonicalMix = artifacts(canonical, 'wav_mix')[0];
    const derivativeCanonicalMix = artifacts(derivative, 'wav_mix')[0];
    assert.equal(canonicalMix.sha256, derivativeCanonicalMix.sha256,
      'canonical mix rendered alongside a derivative must match a plain canonical render');
  });
});
