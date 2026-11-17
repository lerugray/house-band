import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { pinnedSkip } from './helpers/env.mjs';

import { ApiError } from '../src/api/errors.mjs';
import { assertLoopbackBind, createApiHttpServer } from '../src/api/http.mjs';
import { parseJsonNoDuplicates } from '../src/api/json.mjs';
import { CUSTODY_PROFILE_ID, custodyProfile } from '../src/api/profile.mjs';
import { deterministicScore, DeterministicScoreProvider } from '../src/api/provider.mjs';
import { HouseBandApiService } from '../src/api/service.mjs';
import { canonicalJson, sha256 } from '../src/provenance.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const replayFixture = JSON.parse(readFileSync(join(repoRoot, 'test/fixtures/api-t1-dr5-replay-output.json'), 'utf8'));

class RepairProofProvider extends DeterministicScoreProvider {
  constructor() {
    super();
    this.laneId = 'repair-proof-provider';
    this.model = 'repair-proof-model/1.0.0';
    this.calls = [];
  }

  async generate(context) {
    this.calls.push(context);
    if (this.calls.length === 1) return '{"schemaVersion":"1.1.0","schemaVersion":"1.1.0"}';
    return canonicalJson(deterministicScore(context.admission, context.fixedRegister));
  }
}

function artifacts(job, kind) {
  return job.artifacts.filter((artifact) => artifact.kind === kind);
}

function invokeServer(server, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const request = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(request, {
      method,
      url: path,
      headers: { host: '127.0.0.1:3781', ...headers },
      socket: { localPort: 3781 },
    });
    const chunks = [];
    const response = {
      headersSent: false,
      status: null,
      headers: null,
      writeHead(status, responseHeaders) {
        this.status = status;
        this.headers = responseHeaders;
        this.headersSent = true;
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      end(responseBody = Buffer.alloc(0)) {
        if (responseBody.length > 0) chunks.push(Buffer.from(responseBody));
        resolve({ status: this.status, headers: this.headers, body: Buffer.concat(chunks) });
      },
      on() {},
      destroy: reject,
    };
    server.emit('request', request, response);
  });
}

describe('House Band API tranche 1', { skip: pinnedSkip() }, () => {
  let root;
  let provider;
  let service;
  let song;
  let score;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'house-band-api-t1-'));
    provider = new RepairProofProvider();
    service = await new HouseBandApiService({ storeRoot: root, provider }).init();
    const submitted = await service.submitSong({
      prompt: 'A compact deterministic pulse for replay custody.',
      titleHint: 'Replay proof',
      seed: 0xdecafbad,
      canonicalVoiceAllowlist: ['kick', 'snare', 'hat'],
      composition: { maxValidationAttempts: 3 },
      render: { fullMix: true, stems: true },
    });
    song = await submitted.completion;
    const scoreMetadata = artifacts(song, 'score')[0];
    score = JSON.parse((await service.getArtifact(song.jobId, scoreMetadata.artifactId)).bytes);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs prompt → pluggable provider → duplicate-aware repair → canonical persisted score', async () => {
    assert.equal(song.state, 'succeeded');
    assert.equal(song.transportCallCount, 2);
    assert.equal(song.validationCandidateCount, 2);
    assert.equal(provider.calls.length, 2);
    assert.equal(song.admission.composition.modelLaneId, 'repair-proof-provider');
    assert.equal(provider.calls[0].request.basePrompt, provider.calls[1].request.basePrompt, 'repair must reuse the immutable base prompt object');
    assert.match(provider.calls[1].request.completePriorRawCandidate, /"schemaVersion".*"schemaVersion"/);
    assert.deepEqual(provider.calls[1].request.orderedValidatorDiagnostics.map((entry) => entry.code), ['DUPLICATE_KEY']);
    assert.match(provider.calls[1].request.outputRequirement, /complete replacement score/);

    const responses = artifacts(song, 'composition_response');
    assert.equal(responses.length, 2);
    assert.equal(responses.every((artifact) => artifact.acceptance === 'attempt'), true);
    const firstRaw = (await service.getArtifact(song.jobId, responses[0].artifactId)).bytes.toString('utf8');
    assert.equal(firstRaw, '{"schemaVersion":"1.1.0","schemaVersion":"1.1.0"}');

    const scoreArtifact = artifacts(song, 'score')[0];
    const scoreBytes = (await service.getArtifact(song.jobId, scoreArtifact.artifactId)).bytes;
    assert.equal(scoreBytes.toString('utf8'), canonicalJson(score));
    assert.equal(scoreBytes.at(-1) === 0x0a, false, 'canonical score must have no trailing newline');
    assert.equal(scoreArtifact.sha256, sha256(scoreBytes));
    assert.equal(scoreArtifact.canonicalSongIdentity, true);
    assert.equal(score.schemaVersion, '1.1.0');
    assert.equal(score.seed, 0xdecafbad);
    assert.deepEqual(score.register, provider.calls[0].fixedRegister);
  });

  it('keeps the persisted terminal job record authoritative', async () => {
    const persisted = await service.getJob(song.jobId);
    assert.equal(persisted.state, 'succeeded');
    assert.equal(persisted.currentStage, 'succeeded');
    assert.equal(persisted.error, null);
    assert.ok(persisted.provenanceSummary.artifactSha256);
    assert.equal(await service.transition(song, 'failed', 1), false);
    assert.equal((await service.getJob(song.jobId)).state, 'succeeded');
  });

  it('captures the versioned custody profile and the exact non-circular provenance hash domain', async () => {
    const manifestArtifact = artifacts(song, 'manifest')[0];
    const manifest = JSON.parse((await service.getArtifact(song.jobId, manifestArtifact.artifactId)).bytes);
    assert.equal(manifest.custodyProfile.id, CUSTODY_PROFILE_ID);
    assert.deepEqual(manifest.custodyProfile.runtime, { node: 'v25.9.0', operatingSystem: 'darwin', architecture: 'arm64' });
    assert.deepEqual(manifest.custodyProfile.webAudioEngine, { name: 'node-web-audio-api', version: '2.2.0' });
    assert.equal(manifest.custodyProfile.audio.sampleRate, 44100);
    assert.equal(manifest.custodyProfile.audio.channelCount, 2);
    assert.equal(manifest.custodyProfile.audio.sampleRepresentation, 'signed 16-bit little-endian PCM');
    assert.equal(manifest.custodyProfile.audio.dither, false);
    assert.equal(manifest.custodyProfile.tail.seconds, 1.45);
    assert.equal(manifest.commonFrameCount, manifest.fullMix.frames);
    assert.ok(manifest.stems.every((stem) => stem.frames === manifest.commonFrameCount && stem.startFrame === 0));

    const provenanceArtifact = artifacts(song, 'provenance')[0];
    const provenance = JSON.parse((await service.getArtifact(song.jobId, provenanceArtifact.artifactId)).bytes);
    assert.equal(provenance.hashDomain.some((entry) => entry.kind === 'provenance'), false);
    assert.equal(provenance.hashDomain.some((entry) => entry.kind === 'bundle'), false);
    assert.equal(provenance.hashDomain.length, song.artifacts.length - 1);
    assert.equal(provenance.hashDomain.every((entry) => entry.sha256 === song.artifacts.find((artifact) => artifact.artifactId === entry.artifactId).sha256), true);
    const index = await service.store.readIndex(song.jobId);
    assert.equal(index.provenanceSha256, provenanceArtifact.sha256);
    assert.equal(Object.hasOwn(provenance, 'provenanceSha256'), false);
    assert.equal(Object.hasOwn(provenance, 'bundleSha256'), false);
  });

  it('replays one persisted score twice with identical full-mix and per-stem hashes', async () => {
    const request = {
      score,
      sourceJobId: song.jobId,
      custodyProfileId: CUSTODY_PROFILE_ID,
      outputs: { fullMix: true, stems: true },
    };
    const first = await (await service.submitRender(request)).completion;
    const second = await (await service.submitRender(request)).completion;
    assert.equal(first.state, 'succeeded');
    assert.equal(second.state, 'succeeded');
    assert.equal(artifacts(first, 'wav_mix')[0].sha256, artifacts(second, 'wav_mix')[0].sha256);
    assert.equal(artifacts(first, 'wav_mix')[0].sha256, artifacts(song, 'wav_mix')[0].sha256);
    const firstStems = Object.fromEntries(artifacts(first, 'wav_stem').map((artifact) => [artifact.filename, artifact.sha256]));
    const secondStems = Object.fromEntries(artifacts(second, 'wav_stem').map((artifact) => [artifact.filename, artifact.sha256]));
    const sourceStems = Object.fromEntries(artifacts(song, 'wav_stem').map((artifact) => [artifact.filename, artifact.sha256]));
    assert.deepEqual(firstStems, secondStems);
    assert.deepEqual(firstStems, sourceStems);
    assert.equal(artifacts(song, 'score')[0].sha256, replayFixture.scoreArtifactSha256);
    assert.equal(artifacts(first, 'wav_mix')[0].sha256, replayFixture.mixSha256);
    assert.equal(artifacts(first, 'wav_mix')[0].sizeBytes, replayFixture.wavBytes);
    assert.deepEqual(firstStems, replayFixture.stemSha256);
  });

  it('rejects score-conflicting render overrides and distinguishes unavailable toolchains from render mismatches', async () => {
    await assert.rejects(
      () => service.submitRender({ score, seed: score.seed + 1, outputs: { fullMix: true } }),
      (error) => error instanceof ApiError && error.code === 'INVALID_REQUEST' && /authoritative/.test(error.message),
    );

    const unavailableRoot = await mkdtemp(join(tmpdir(), 'house-band-api-unavailable-'));
    try {
      const unavailable = await new HouseBandApiService({
        storeRoot: unavailableRoot,
        runtime: { version: 'v0.0.0', platform: 'darwin', arch: 'arm64' },
      }).init();
      const failed = await (await unavailable.submitRender({ score, outputs: { fullMix: true } })).completion;
      assert.equal(failed.state, 'failed');
      assert.equal(failed.error.code, 'TOOLCHAIN_UNAVAILABLE');
      assert.equal(artifacts(failed, 'wav_mix').length, 0, 'toolchain failure must occur before rendering');
    } finally {
      await rm(unavailableRoot, { recursive: true, force: true });
    }

    await assert.rejects(
      () => service.compareReplay({ jobId: 'source', artifacts: [{ kind: 'wav_mix', acceptance: 'accepted', sha256: '0'.repeat(64) }] }, { sha256: '1'.repeat(64) }, []),
      (error) => error instanceof ApiError && error.code === 'RENDER_MISMATCH' && error.stage === 'rendering',
    );
  });

  it('rejects malformed pack identities and still defends duplicate keys, origin, and loopback bind', async () => {
    await assert.rejects(
      () => service.submitSong({ prompt: 'pack please', pack: {} }),
      (error) => error.code === 'INVALID_REQUEST' && /pack\.format/.test(error.message),
    );
    await assert.rejects(
      () => service.submitSong({ prompt: 'rpp without stems', render: { rpp: true, stems: false } }),
      (error) => error.code === 'INVALID_REQUEST' && /rpp requires stems/.test(error.message),
    );

    const server = createApiHttpServer(service, { allowedHosts: ['127.0.0.1:3781'] });
    const events = await invokeServer(server, { path: `/v1/jobs/${song.jobId}/events` });
    assert.equal(events.status, 200);
    assert.equal(events.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(Object.keys(events.headers).some((header) => header.toLowerCase() === 'access-control-allow-origin'), false);

    const duplicate = await invokeServer(server, {
      method: 'POST', path: '/v1/songs', headers: { 'content-type': 'application/json' },
      body: '{"prompt":"first","prompt":"second"}',
    });
    assert.equal(duplicate.status, 400);
    assert.match(JSON.parse(duplicate.body).error.message, /duplicate object key/);
    assert.throws(() => parseJsonNoDuplicates('{"nested":{"x":1,"x":2}}'), /duplicate object key/);

    const wrongOrigin = await invokeServer(server, { path: '/v1/health', headers: { origin: 'http://example.test' } });
    assert.equal(wrongOrigin.status, 400);
    assert.equal(Object.keys(wrongOrigin.headers).some((header) => header.toLowerCase() === 'access-control-allow-origin'), false);
    assert.throws(() => assertLoopbackBind('0.0.0.0'), /must bind exactly to 127\.0\.0\.1/);
  });

  it('routes POST /v1/songs and authoritative GET status through the HTTP surface', async () => {
    const server = createApiHttpServer(service, { allowedHosts: ['127.0.0.1:3781'] });
    const created = await invokeServer(server, {
      method: 'POST',
      path: '/v1/songs',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'HTTP route proof', seed: 7, canonicalVoiceAllowlist: ['kick'],
        execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
      }),
    });
    assert.equal(created.status, 200);
    const accepted = JSON.parse(created.body);
    assert.equal(accepted.state, 'succeeded');
    assert.ok(accepted.links.status);
    assert.ok(accepted.links.artifacts);
    assert.ok(accepted.links.events, 'SSE events link must be advertised as available');

    const status = await invokeServer(server, { path: accepted.links.status });
    assert.equal(status.status, 200);
    const persisted = JSON.parse(status.body);
    assert.equal(persisted.jobId, accepted.jobId);
    assert.equal(persisted.state, 'succeeded');
    assert.equal(persisted.artifacts.some((artifact) => artifact.kind === 'score'), true);

    const rendered = await invokeServer(server, {
      method: 'POST',
      path: '/v1/renders',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        score,
        outputs: { fullMix: true },
        execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
      }),
    });
    assert.equal(rendered.status, 200);
    const renderAccepted = JSON.parse(rendered.body);
    assert.equal(renderAccepted.state, 'succeeded');
    const renderStatus = JSON.parse((await invokeServer(server, { path: renderAccepted.links.status })).body);
    assert.equal(renderStatus.type, 'render_score');
    assert.equal(renderStatus.artifacts.some((artifact) => artifact.kind === 'wav_mix'), true);
  });

  it('enforces finite validation and transport bounds independently and never renders a rejected composition', async () => {
    const validationRoot = await mkdtemp(join(tmpdir(), 'house-band-api-invalid-'));
    const transportRoot = await mkdtemp(join(tmpdir(), 'house-band-api-transport-'));
    try {
      const invalidProvider = {
        laneId: 'invalid-proof', model: 'invalid-proof/1.0.0', maxTransportAttempts: 5, callTimeoutMs: 100, totalDeadlineMs: 1_000,
        calls: 0,
        async generate() { this.calls++; return '{}'; },
      };
      const invalidService = await new HouseBandApiService({ storeRoot: validationRoot, provider: invalidProvider }).init();
      const invalid = await (await invalidService.submitSong({
        prompt: 'must fail validation', composition: { maxValidationAttempts: 2 },
      })).completion;
      assert.equal(invalid.state, 'failed');
      assert.equal(invalid.error.code, 'COMPOSITION_INVALID_AFTER_RETRIES');
      assert.equal(invalid.validationCandidateCount, 2);
      assert.equal(invalid.transportCallCount, 2);
      assert.equal(invalidProvider.calls, 2);
      assert.equal(artifacts(invalid, 'wav_mix').length, 0);

      const transportProvider = {
        laneId: 'transport-proof', model: 'transport-proof/1.0.0', maxTransportAttempts: 2, callTimeoutMs: 100, totalDeadlineMs: 1_000,
        calls: 0,
        async generate() { this.calls++; throw new Error('offline'); },
      };
      const transportService = await new HouseBandApiService({ storeRoot: transportRoot, provider: transportProvider }).init();
      const unavailable = await (await transportService.submitSong({ prompt: 'must exhaust transport' })).completion;
      assert.equal(unavailable.state, 'failed');
      assert.equal(unavailable.error.code, 'MODEL_LANE_UNAVAILABLE');
      assert.equal(unavailable.validationCandidateCount, 0);
      assert.equal(unavailable.transportCallCount, 2);
      assert.equal(transportProvider.calls, 2);
      assert.equal(artifacts(unavailable, 'wav_mix').length, 0);
    } finally {
      await Promise.all([
        rm(validationRoot, { recursive: true, force: true }),
        rm(transportRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('discards timed-out late responses deterministically while retaining their raw bytes as diagnostics', async () => {
    const lateRoot = await mkdtemp(join(tmpdir(), 'house-band-api-late-'));
    try {
      const lateProvider = {
        laneId: 'late-proof', model: 'late-proof/1.0.0', maxTransportAttempts: 3, callTimeoutMs: 5, totalDeadlineMs: 1_000,
        calls: 0,
        async generate(context) {
          this.calls++;
          if (this.calls === 1) return new Promise((resolve) => setTimeout(() => resolve('{"late":true}'), 30));
          return canonicalJson(deterministicScore(context.admission, context.fixedRegister));
        },
      };
      const lateService = await new HouseBandApiService({ storeRoot: lateRoot, provider: lateProvider }).init();
      const completed = await (await lateService.submitSong({
        prompt: 'late transport proof', seed: 9, canonicalVoiceAllowlist: ['kick'],
      })).completion;
      assert.equal(completed.state, 'succeeded');
      assert.equal(completed.transportCallCount, 2);
      assert.equal(completed.validationCandidateCount, 1, 'timed-out response must never count as a validation candidate');
      const withLateDiagnostic = await lateService.getJob(completed.jobId);
      const responses = artifacts(withLateDiagnostic, 'composition_response');
      assert.equal(responses.length, 2);
      const late = responses.find((artifact) => artifact.filename.includes('-late-'));
      assert.ok(late);
      assert.equal((await lateService.getArtifact(completed.jobId, late.artifactId)).bytes.toString('utf8'), '{"late":true}');
      assert.equal(withLateDiagnostic.state, 'succeeded', 'late response must not replace terminal authority');
      assert.equal(withLateDiagnostic.validationCandidateCount, 1);
      const provenanceMetadata = artifacts(withLateDiagnostic, 'provenance')[0];
      const provenance = JSON.parse((await lateService.getArtifact(completed.jobId, provenanceMetadata.artifactId)).bytes);
      assert.equal(provenance.hashDomain.some((entry) => entry.artifactId === late.artifactId), true, 'retained late response belongs to the enumerated provenance domain');
    } finally {
      await rm(lateRoot, { recursive: true, force: true });
    }
  });

  it('ships a deterministic test double as the default pluggable provider', async () => {
    const deterministic = new DeterministicScoreProvider();
    const admission = provider.calls[0].admission;
    const fixedRegister = provider.calls[0].fixedRegister;
    const first = await deterministic.generate({ admission, fixedRegister });
    const second = await deterministic.generate({ admission, fixedRegister });
    assert.equal(first, second);
    assert.equal(deterministic.laneId, 'deterministic-test-double');
    assert.equal(service.capabilities().renderer.rpp, true);
    assert.deepEqual(custodyProfile(), service.capabilities().custodyRenderProfiles[0]);
  });

  it('exposes strict score validation without mutating the caller score', () => {
    const callerScore = structuredClone(score);
    const result = service.validateScoreRequest({ score: callerScore, expectedSchemaVersion: '1.1.0' });
    assert.equal(result.valid, true);
    assert.equal(result.artifactSha256, artifacts(song, 'score')[0].sha256);
    assert.deepEqual(callerScore, score);
    assert.notEqual(result.canonicalScore, callerScore);

    callerScore.seed = -1;
    const invalid = service.validateScoreRequest({ score: callerScore });
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors[0].message, /seed/);
  });
});
