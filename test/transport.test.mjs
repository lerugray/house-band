import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pinnedSkip } from './helpers/env.mjs';

import { HouseBandApiService } from '../src/api/service.mjs';
import { canonicalJson, sha256 } from '../src/provenance.mjs';
import { deterministicScore, DeterministicScoreProvider, OpenAiCompatibleProvider } from '../src/api/provider.mjs';

const API_KEY_ENV = 'HB_TRANSPORT_TEST_API_KEY';

function basePromptFromBody(body) {
  const user = body.messages?.find((message) => message.role === 'user');
  assert.ok(user, 'mock request must include a user message');
  return JSON.parse(user.content);
}

async function createMockServer(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ url: request.url, headers: request.headers, body: parsed });
      try {
        const result = await handler(parsed, request, response);
        if (result !== undefined) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(result));
        }
      } catch (error) {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: error.message }));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise((resolve) => server.close(resolve));
  return { server, port: server.address().port, requests, close };
}

function makeProvider(baseUrl, overrides = {}) {
  return new OpenAiCompatibleProvider({
    baseUrl,
    apiKeyEnvVar: API_KEY_ENV,
    model: 'mock-model',
    maxTransportAttempts: 3,
    callTimeoutMs: 1_000,
    totalDeadlineMs: 5_000,
    ...overrides,
  });
}

function artifacts(job, kind) {
  return job.artifacts.filter((artifact) => artifact.kind === kind);
}

describe('real model transport adapter', () => {
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'house-band-transport-'));
    process.env[API_KEY_ENV] = 'test-api-key';
  });

  after(async () => {
    delete process.env[API_KEY_ENV];
    await rm(root, { recursive: true, force: true });
  });

  it('produces a validated canonical score through a mock OpenAI-compatible server', { skip: pinnedSkip() }, async () => {
    const mock = await createMockServer((body) => {
      const base = basePromptFromBody(body);
      const admission = {
        seed: base.seed,
        duration: base.duration,
        sections: base.sections,
        canonicalVoiceAllowlist: base.canonicalVoiceAllowlist,
        pack: null,
      };
      const score = deterministicScore(admission, base.fixedRegister);
      return { choices: [{ message: { content: canonicalJson(score) } }] };
    });
    try {
      const provider = makeProvider(`http://127.0.0.1:${mock.port}`);
      const service = await new HouseBandApiService({ storeRoot: root, provider }).init();
      const request = {
        prompt: 'A deterministic pulse for real transport validation.',
        seed: 0xc0ffee,
        canonicalVoiceAllowlist: ['kick'],
        render: { fullMix: true },
      };
      const job = await (await service.submitSong(request)).completion;
      assert.equal(job.state, 'succeeded');
      assert.equal(job.transportCallCount, 1);
      assert.equal(job.validationCandidateCount, 1);
      assert.equal(job.admission.composition.modelLaneId, 'openai-compatible');

      const scoreArtifact = artifacts(job, 'score')[0];
      assert.ok(scoreArtifact);

      const deterministic = await new HouseBandApiService({ storeRoot: root, provider: new DeterministicScoreProvider() }).init();
      const reference = await (await deterministic.submitSong(request)).completion;
      assert.equal(reference.state, 'succeeded');
      assert.equal(artifacts(reference, 'score')[0].sha256, scoreArtifact.sha256, 'score identity must match the deterministic stub');
      assert.equal(artifacts(reference, 'wav_mix')[0].sha256, artifacts(job, 'wav_mix')[0].sha256, 'render must be byte-identical to the deterministic stub');

      const provenanceArtifact = artifacts(job, 'provenance')[0];
      const provenance = JSON.parse((await service.getArtifact(job.jobId, provenanceArtifact.artifactId)).bytes);
      assert.equal(provenance.modelLane, 'openai-compatible');
      assert.equal(provenance.model, 'mock-model');
      assert.equal(provenance.transportCallCount, 1);
      assert.equal(provenance.validationCandidateCount, 1);

      const caps = service.capabilities();
      assert.ok(!caps.deferred.map((entry) => entry.feature).includes('real model transport'));
      const lane = caps.compositionLanes[0];
      assert.equal(lane.laneId, 'openai-compatible');
      assert.ok(lane.selection);
    } finally {
      await mock.close();
    }
  });

  it('treats malformed assistant content as a validation failure, not a transport failure', { skip: pinnedSkip() }, async () => {
    const mock = await createMockServer(() => ({
      choices: [{ message: { content: 'This is not a valid House Band score.' } }],
    }));
    try {
      const provider = makeProvider(`http://127.0.0.1:${mock.port}`, { maxTransportAttempts: 3 });
      const service = await new HouseBandApiService({ storeRoot: root, provider, maxValidationAttempts: 1 }).init();
      const job = await (await service.submitSong({
        prompt: 'malformed response test',
        seed: 1,
        render: { fullMix: true },
        composition: { maxValidationAttempts: 1 },
      })).completion;
      assert.equal(job.state, 'failed');
      assert.equal(job.error.code, 'COMPOSITION_INVALID_AFTER_RETRIES');
      assert.equal(job.transportCallCount, 1);
      assert.equal(job.validationCandidateCount, 1);
      assert.equal(artifacts(job, 'wav_mix').length, 0);
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });

  it('times out slow provider calls and retries until transport attempts are exhausted', { skip: pinnedSkip() }, async () => {
    const mock = await createMockServer(() => new Promise(() => {}));
    try {
      const provider = makeProvider(`http://127.0.0.1:${mock.port}`, { callTimeoutMs: 50, maxTransportAttempts: 2 });
      const service = await new HouseBandApiService({ storeRoot: root, provider }).init();
      const job = await (await service.submitSong({
        prompt: 'timeout test',
        seed: 2,
        render: { fullMix: true },
      })).completion;
      assert.equal(job.state, 'failed');
      assert.equal(job.error.code, 'MODEL_LANE_UNAVAILABLE');
      assert.equal(job.transportCallCount, 2);
      assert.equal(job.validationCandidateCount, 0);
      assert.equal(artifacts(job, 'wav_mix').length, 0);
      assert.equal(mock.requests.length, 2);
      const events = await service.store.readEvents(job.jobId);
      assert.ok(events.some((event) => event.event === 'composition_transport_started'));
      assert.equal(events.filter((event) => event.event === 'composition_transport_failed').length, 2);
    } finally {
      await mock.close();
    }
  });

  it('retries on HTTP 5xx and exhausts maxTransportAttempts', { skip: pinnedSkip() }, async () => {
    let calls = 0;
    const mock = await createMockServer((body, request, response) => {
      calls++;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'provider overloaded' }));
    });
    try {
      const provider = makeProvider(`http://127.0.0.1:${mock.port}`, { maxTransportAttempts: 3 });
      const service = await new HouseBandApiService({ storeRoot: root, provider }).init();
      const job = await (await service.submitSong({
        prompt: 'retry exhaustion test',
        seed: 3,
        render: { fullMix: true },
      })).completion;
      assert.equal(job.state, 'failed');
      assert.equal(job.error.code, 'MODEL_LANE_UNAVAILABLE');
      assert.equal(job.transportCallCount, 3);
      assert.equal(job.validationCandidateCount, 0);
      assert.equal(calls, 3);
    } finally {
      await mock.close();
    }
  });

  it('fails with COMPOSITION_DEADLINE_EXCEEDED when the total deadline elapses', { skip: pinnedSkip() }, async () => {
    const mock = await createMockServer(() => new Promise(() => {}));
    try {
      const provider = makeProvider(`http://127.0.0.1:${mock.port}`, { callTimeoutMs: 200, totalDeadlineMs: 80, maxTransportAttempts: 3 });
      const service = await new HouseBandApiService({ storeRoot: root, provider }).init();
      const job = await (await service.submitSong({
        prompt: 'deadline test',
        seed: 4,
        render: { fullMix: true },
      })).completion;
      assert.equal(job.state, 'failed');
      assert.equal(job.error.code, 'COMPOSITION_DEADLINE_EXCEEDED');
      assert.equal(job.validationCandidateCount, 0);
    } finally {
      await mock.close();
    }
  });

  it('keeps real model transport deferred when only the deterministic stub is configured', async () => {
    const service = await new HouseBandApiService({ storeRoot: root, provider: new DeterministicScoreProvider() }).init();
    const caps = service.capabilities();
    assert.ok(caps.deferred.map((entry) => entry.feature).includes('real model transport'));
    assert.equal(caps.compositionLanes[0].laneId, 'deterministic-test-double');
  });

  it('redacts credentials from persisted artifacts while recording provider/model identity', { skip: pinnedSkip() }, async () => {
    const mock = await createMockServer((body) => {
      const base = basePromptFromBody(body);
      const admission = {
        seed: base.seed,
        duration: base.duration,
        sections: base.sections,
        canonicalVoiceAllowlist: base.canonicalVoiceAllowlist,
        pack: null,
      };
      return { choices: [{ message: { content: canonicalJson(deterministicScore(admission, base.fixedRegister)) } }] };
    });
    try {
      const provider = makeProvider(`http://127.0.0.1:${mock.port}`);
      const service = await new HouseBandApiService({ storeRoot: root, provider }).init();
      const job = await (await service.submitSong({
        prompt: 'credential redaction test',
        seed: 5,
        render: { fullMix: true },
      })).completion;
      assert.equal(job.state, 'succeeded');
      for (const artifact of job.artifacts) {
        if (artifact.kind === 'composition_request') {
          const bytes = (await service.getArtifact(job.jobId, artifact.artifactId)).bytes.toString('utf8');
          assert.equal(bytes.includes('test-api-key'), false, 'composition_request must not contain the API key');
        }
      }
      const provenanceArtifact = artifacts(job, 'provenance')[0];
      const provenance = JSON.parse((await service.getArtifact(job.jobId, provenanceArtifact.artifactId)).bytes);
      assert.equal(provenance.modelLane, 'openai-compatible');
      assert.equal(provenance.model, 'mock-model');
    } finally {
      await mock.close();
    }
  });
});
