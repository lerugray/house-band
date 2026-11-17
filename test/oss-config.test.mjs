import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { normalizeSongRequest } from '../src/api/requests.mjs';
import { buildProfiles, weissConfig } from '../src/desk/config.mjs';
import { resolveEnvPath } from '../src/desk/env.mjs';
import { DeskService } from '../src/desk/service.mjs';
import { WeissCli } from '../src/desk/weiss.mjs';

describe('OSS-04 desk and API configuration', () => {
  it('buildProfiles ids are the public set in order with no KIMI fields', () => {
    const profiles = buildProfiles({});
    assert.deepEqual(
      profiles.map((p) => p.id),
      ['claude-sonnet-5', 'deepseek', 'ollama-cloud', 'custom', 'anthropic', 'deterministic'],
    );
    for (const profile of profiles) {
      assert.equal(JSON.stringify(profile).includes('KIMI'), false);
    }
  });

  it('claude-sonnet-5 configured via default or HOUSE_BAND_CLAUDE_TOKEN_VAR', () => {
    const byDefault = buildProfiles({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }).find((p) => p.id === 'claude-sonnet-5');
    assert.equal(byDefault.configured, true);
    assert.equal(byDefault.envVar, 'CLAUDE_CODE_OAUTH_TOKEN');

    const byAlias = buildProfiles({
      HOUSE_BAND_CLAUDE_TOKEN_VAR: 'MY_TOKEN',
      MY_TOKEN: 'x',
    }).find((p) => p.id === 'claude-sonnet-5');
    assert.equal(byAlias.configured, true);
    assert.equal(byAlias.envVar, 'MY_TOKEN');
  });

  it('custom is configured only with all three HOUSE_BAND_LLM_* set', () => {
    const none = buildProfiles({}).find((p) => p.id === 'custom');
    assert.equal(none.configured, false);

    const partial = buildProfiles({
      HOUSE_BAND_LLM_BASE_URL: 'https://example.test/v1',
      HOUSE_BAND_LLM_MODEL: 'm',
    }).find((p) => p.id === 'custom');
    assert.equal(partial.configured, false);

    const full = buildProfiles({
      HOUSE_BAND_LLM_BASE_URL: 'https://example.test/v1',
      HOUSE_BAND_LLM_MODEL: 'm',
      HOUSE_BAND_LLM_API_KEY: 'k',
    }).find((p) => p.id === 'custom');
    assert.equal(full.configured, true);
    assert.equal(full.baseUrl, 'https://example.test/v1');
    assert.equal(full.model, 'm');
    assert.equal(full.apiKeyEnvVar, 'HOUSE_BAND_LLM_API_KEY');
  });

  it('weissConfig without paths leaves executable null and WeissCli unavailable', () => {
    const cfg = weissConfig({ env: {}, configPath: '/nonexistent.json' });
    assert.equal(cfg.executable, null);
    assert.equal(cfg.script, null);
    assert.equal(cfg.cwd, null);
    const weiss = new WeissCli({ __resolvedConfig: cfg });
    assert.equal(weiss.available(), false);
  });

  it('HOUSE_BAND_BRIEF_* twins yield to HB_WEISS_* when both set', () => {
    const briefOnly = weissConfig({
      env: { HOUSE_BAND_BRIEF_MODEL: 'm' },
      configPath: '/nonexistent.json',
    });
    assert.equal(briefOnly.model, 'm');

    const both = weissConfig({
      env: { HOUSE_BAND_BRIEF_MODEL: 'm', HB_WEISS_MODEL: 'w' },
      configPath: '/nonexistent.json',
    });
    assert.equal(both.model, 'w');
  });

  it('register.source command normalises to weiss on admission', () => {
    const admitted = normalizeSongRequest({
      prompt: 'a short prompt',
      register: { source: 'command' },
      seed: 1,
      canonicalVoiceAllowlist: ['kick'],
      duration: { targetBars: 2 },
      render: { fullMix: true },
    });
    assert.equal(admitted.register.source, 'weiss');
  });

  it('resolveEnvPath uses HOUSE_BAND_ENV_FILE or the house-band config default', () => {
    assert.equal(
      resolveEnvPath({ HOUSE_BAND_ENV_FILE: 'C:\\tmp\\hb.env' }),
      'C:\\tmp\\hb.env',
    );
    assert.equal(
      resolveEnvPath({}),
      resolve(homedir(), '.config', 'house-band', '.env'),
    );
  });

  it('DeskService health includes logFile when provided', () => {
    const service = new DeskService({
      logFile: '/tmp/x.log',
      custodyCheck: () => {},
    });
    const health = service.health();
    assert.equal(health.logFile, '/tmp/x.log');
  });
});
