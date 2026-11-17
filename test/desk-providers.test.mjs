import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildProfiles, PROFILE_TYPES } from '../src/desk/config.mjs';
import { CODES } from '../src/desk/errors.mjs';
import { createProvider, healthCheck } from '../src/desk/providers/index.mjs';
import { normalizeProviderResponse } from '../src/desk/providers/base.mjs';
import { canonicalJson } from '../src/provenance.mjs';
import { KIT_VERSION, SCHEMA_VERSION } from '../src/version.mjs';

const API_KEY_ENV = 'HB_DESK_PROVIDER_TEST_API_KEY';

function makeBasePrompt(overrides = {}) {
  return {
    promptTemplateRevision: 'hb-composer/1.1.0',
    task: 'Return one complete House Band score as a single JSON object.',
    scoreSchemaVersion: SCHEMA_VERSION,
    scoreContract: {
      strictUnknownFields: true,
      sampleRate: 44100,
      kitVersion: KIT_VERSION,
      register: { source: 'neutral' },
      synthesisOnly: true,
      performance: { optional: true },
      output: 'one complete JSON object; no prose, Markdown, comments, or trailing data',
    },
    canonicalVoiceAllowlist: ['kick', 'snare'],
    assetAllowlist: [],
    packIdentity: null,
    userPrompt: 'A deterministic pulse.',
    registerBrief: '',
    fixedRegister: { source: 'neutral' },
    duration: {
      targetSeconds: null,
      secondsInterval: null,
      targetBars: 4,
      barRange: Object.freeze([4, 4]),
      loopable: null,
      loopableValidation: 'nonbinding-direction',
    },
    sections: Object.freeze([]),
    seed: 0xc0ffee,
    ...overrides,
  };
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

describe('Composer\'s Desk provider adapters', () => {
  describe('base helpers', () => {
    it('normalises string, Buffer, and arbitrary responses to UTF-8 strings', () => {
      assert.equal(normalizeProviderResponse('hello'), 'hello');
      assert.equal(normalizeProviderResponse(Buffer.from('hello')), 'hello');
      assert.equal(normalizeProviderResponse({ toString: () => 'hello' }), 'hello');
      assert.equal(normalizeProviderResponse(123), '123');
    });
  });

  describe('deterministic provider', () => {
    it('returns valid score JSON for a base prompt', async () => {
      const profile = buildProfiles().find((p) => p.type === PROFILE_TYPES.DETERMINISTIC);
      const provider = createProvider(profile, {});
      const raw = await provider.generate({ request: { basePrompt: makeBasePrompt() } });
      assert.equal(typeof raw, 'string');
      const score = JSON.parse(raw);
      assert.equal(score.schemaVersion, SCHEMA_VERSION);
      assert.equal(score.kitVersion.semver, KIT_VERSION.semver);
      assert.equal(score.seed, 0xc0ffee);
      assert.ok(score.tracks);
      assert.ok(Array.isArray(score.sections));
      assert.equal(await provider.health(), 'configured');
    });
  });

  describe('claude-cli provider', () => {
    let tmpDir;
    let savedPath;

    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'house-band-desk-cli-'));
      savedPath = process.env.PATH;
    });

    after(async () => {
      process.env.PATH = savedPath;
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('reports missing configuration when the env var is absent', async () => {
      const profile = buildProfiles().find((p) => p.type === PROFILE_TYPES.CLAUDE_CLI);
      const provider = createProvider(profile, {});
      assert.equal(await provider.health(), 'missing configuration');
    });

    it('reports unreachable/limited when claude binary is missing', async () => {
      const profile = buildProfiles().find((p) => p.type === PROFILE_TYPES.CLAUDE_CLI);
      process.env.PATH = tmpDir;
      const provider = createProvider(profile, { [profile.envVar]: 'token' });
      assert.equal(await provider.health(), 'unreachable/limited');
    });

    it('reports configured when token and binary are present', async () => {
      const profile = buildProfiles().find((p) => p.type === PROFILE_TYPES.CLAUDE_CLI);
      const fakeClaude = resolve(tmpDir, 'claude');
      await writeFile(fakeClaude, '#!/bin/sh\necho fake', { mode: 0o755 });
      process.env.PATH = tmpDir;
      const provider = createProvider(profile, { [profile.envVar]: 'token' });
      assert.equal(await provider.health(), 'configured');
    });

    it('constructs the right env and argv when generating', async () => {
      const profile = buildProfiles().find((p) => p.type === PROFILE_TYPES.CLAUDE_CLI);
      const fakeClaude = resolve(tmpDir, 'claude');
      await writeFile(fakeClaude, '#!/usr/bin/env node\nconst requestJson = process.argv.slice(2).pop();\nconst result = {\n  env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN },\n  argv: process.argv.slice(2),\n  request: JSON.parse(requestJson),\n};\nconsole.log(JSON.stringify(result));\n', { mode: 0o755 });
      process.env.PATH = `${tmpDir}${delimiter}${savedPath}`;
      const env = { [profile.envVar]: 'main-token' };
      const provider = createProvider(profile, env);

      const request = { basePrompt: makeBasePrompt() };
      const raw = await provider.generate({ request });
      const captured = JSON.parse(raw);

      assert.equal(captured.env.CLAUDE_CODE_OAUTH_TOKEN, 'main-token');
      assert.deepEqual(captured.argv.slice(0, 3), ['-p', '--model', 'claude-sonnet-5']);
      assert.deepEqual(captured.request, request);
    });

    it('throws CONFIG_MISSING when the env var is absent on generate', async () => {
      const profile = buildProfiles().find((p) => p.type === PROFILE_TYPES.CLAUDE_CLI);
      const provider = createProvider(profile, {});
      try {
        await provider.generate({ request: { basePrompt: makeBasePrompt() } });
        assert.fail('expected CONFIG_MISSING');
      } catch (error) {
        assert.equal(error.code, CODES.CONFIG_MISSING);
      }
    });

    it('throws PROVIDER_UNREACHABLE when the CLI exits non-zero', async () => {
      const profile = buildProfiles().find((p) => p.type === PROFILE_TYPES.CLAUDE_CLI);
      const fakeClaude = resolve(tmpDir, 'claude-fail');
      await writeFile(fakeClaude, '#!/bin/sh\necho error >&2\nexit 1', { mode: 0o755 });
      process.env.PATH = tmpDir;
      const provider = createProvider(profile, { [profile.envVar]: 'token' });
      provider.cliCommand = 'claude-fail';
      try {
        await provider.generate({ request: { basePrompt: makeBasePrompt() } });
        assert.fail('expected PROVIDER_UNREACHABLE');
      } catch (error) {
        assert.equal(error.code, CODES.PROVIDER_UNREACHABLE);
        assert.ok(error.details.stderr.includes('error'));
      }
    });

    it('throws PROVIDER_UNREACHABLE for rate-limit phrases in stdout', async () => {
      const profile = buildProfiles().find((p) => p.type === PROFILE_TYPES.CLAUDE_CLI);
      const fakeClaude = resolve(tmpDir, 'claude-rate');
      await writeFile(fakeClaude, '#!/bin/sh\necho "rate limit exceeded"\nexit 0', { mode: 0o755 });
      process.env.PATH = tmpDir;
      const provider = createProvider(profile, { [profile.envVar]: 'token' });
      provider.cliCommand = 'claude-rate';
      try {
        await provider.generate({ request: { basePrompt: makeBasePrompt() } });
        assert.fail('expected PROVIDER_UNREACHABLE');
      } catch (error) {
        assert.equal(error.code, CODES.PROVIDER_UNREACHABLE);
        assert.equal(error.details.status, 'unreachable/limited');
      }
    });

    it('respects AbortSignal cancellation', async () => {
      const profile = buildProfiles().find((p) => p.type === PROFILE_TYPES.CLAUDE_CLI);
      const fakeClaude = resolve(tmpDir, 'claude-sleep');
      await writeFile(fakeClaude, '#!/bin/sh\nsleep 5\necho done', { mode: 0o755 });
      process.env.PATH = tmpDir;
      const provider = createProvider(profile, { [profile.envVar]: 'token' });
      provider.cliCommand = 'claude-sleep';
      provider.callTimeoutMs = 2_000;
      const controller = new AbortController();
      const promise = provider.generate({ request: { basePrompt: makeBasePrompt() }, signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      try {
        await promise;
        assert.fail('expected abort');
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    });
  });

  describe('openai-compatible provider', () => {
    async function withMock(handler, testFn) {
      const mock = await createMockServer(handler);
      try {
        await testFn(mock);
      } finally {
        await mock.close();
      }
    }

    it('hits a mock HTTP server and returns assistant content', async () => {
      await withMock((body) => {
        assert.equal(body.model, 'mock-model');
        assert.equal(body.messages[0].role, 'system');
        assert.equal(body.messages[1].role, 'user');
        assert.equal(body.max_tokens, 1024);
        assert.equal(body.num_predict, 256);
        return { choices: [{ message: { content: '{"ok":true}' } }] };
      }, async (mock) => {
        const profile = {
          id: 'test-openai',
          type: PROFILE_TYPES.OPENAI_COMPATIBLE,
          displayName: 'Test',
          model: 'mock-model',
          baseUrl: `http://127.0.0.1:${mock.port}`,
          apiKeyEnvVar: API_KEY_ENV,
          callTimeoutMs: 1_000,
          maxTransportAttempts: 1,
          totalDeadlineMs: 5_000,
          maxTokens: 1024,
          numPredict: 256,
        };
        const env = { [API_KEY_ENV]: 'test-key' };
        const provider = createProvider(profile, env);
        assert.equal(await provider.health(), 'configured');

        const raw = await provider.generate({ request: { basePrompt: makeBasePrompt() } });
        assert.equal(raw, '{"ok":true}');
        assert.equal(mock.requests[0].headers.authorization, 'Bearer test-key');
      });
    });

    it('throws CONFIG_MISSING when the API key env var is absent', async () => {
      const profile = {
        id: 'test-openai-missing',
        type: PROFILE_TYPES.OPENAI_COMPATIBLE,
        displayName: 'Test',
        model: 'mock-model',
        baseUrl: 'http://127.0.0.1:9',
        apiKeyEnvVar: API_KEY_ENV,
      };
      const provider = createProvider(profile, {});
      assert.equal(await provider.health(), 'missing configuration');
      try {
        await provider.generate({ request: { basePrompt: makeBasePrompt() } });
        assert.fail('expected CONFIG_MISSING');
      } catch (error) {
        assert.equal(error.code, CODES.CONFIG_MISSING);
      }
    });

    it('throws PROVIDER_UNREACHABLE on HTTP errors', async () => {
      await withMock((body, request, response) => {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'overloaded' }));
      }, async (mock) => {
        const profile = {
          id: 'test-openai-error',
          type: PROFILE_TYPES.OPENAI_COMPATIBLE,
          displayName: 'Test',
          model: 'mock-model',
          baseUrl: `http://127.0.0.1:${mock.port}`,
          apiKeyEnvVar: API_KEY_ENV,
          callTimeoutMs: 1_000,
        };
        const provider = createProvider(profile, { [API_KEY_ENV]: 'test-key' });
        try {
          await provider.generate({ request: { basePrompt: makeBasePrompt() } });
          assert.fail('expected PROVIDER_UNREACHABLE');
        } catch (error) {
          assert.equal(error.code, CODES.PROVIDER_UNREACHABLE);
          assert.equal(error.details.status, 503);
        }
      });
    });

    it('respects AbortSignal cancellation', async () => {
      await withMock(() => new Promise(() => {}), async (mock) => {
        const profile = {
          id: 'test-openai-abort',
          type: PROFILE_TYPES.OPENAI_COMPATIBLE,
          displayName: 'Test',
          model: 'mock-model',
          baseUrl: `http://127.0.0.1:${mock.port}`,
          apiKeyEnvVar: API_KEY_ENV,
          callTimeoutMs: 5_000,
        };
        const provider = createProvider(profile, { [API_KEY_ENV]: 'test-key' });
        const controller = new AbortController();
        const promise = provider.generate({ request: { basePrompt: makeBasePrompt() }, signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        try {
          await promise;
          assert.fail('expected abort');
        } catch (error) {
          assert.ok(error instanceof Error);
        }
      });
    });
  });

  describe('factory', () => {
    it('returns the right adapter per profile type', () => {
      const profiles = buildProfiles({
        CLAUDE_CODE_OAUTH_TOKEN: 'x',
        HOUSE_BAND_LLM_BASE_URL: 'https://example.test/v1',
        HOUSE_BAND_LLM_MODEL: 'custom-model',
        HOUSE_BAND_LLM_API_KEY: 'y',
      });
      const deterministic = createProvider(profiles.find((p) => p.id === 'deterministic'), {});
      assert.equal(deterministic.model, 'house-band-deterministic-score-author/1.0.0');

      const claude = createProvider(profiles.find((p) => p.id === 'claude-sonnet-5'), { CLAUDE_CODE_OAUTH_TOKEN: 'x' });
      assert.equal(claude.model, 'claude-sonnet-5');

      const custom = createProvider(profiles.find((p) => p.id === 'custom'), {
        HOUSE_BAND_LLM_API_KEY: 'y',
      });
      assert.equal(custom.model, 'custom-model');
    });

    it('rejects unknown profile types', () => {
      assert.throws(() => createProvider({ type: 'unknown' }), /unsupported profile type/);
    });

    it('healthCheck delegates to provider.health()', async () => {
      const profile = buildProfiles().find((p) => p.type === PROFILE_TYPES.DETERMINISTIC);
      const provider = createProvider(profile, {});
      assert.equal(await healthCheck(provider), 'configured');
    });
  });
});
