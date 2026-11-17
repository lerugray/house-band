import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pinnedSkip } from './helpers/env.mjs';

import { buildProfiles } from '../src/desk/config.mjs';
import { createProvider } from '../src/desk/providers/index.mjs';
import { SessionStore } from '../src/desk/session-store.mjs';
import { DeskService } from '../src/desk/service.mjs';
import { loadEnvFile } from '../src/desk/env.mjs';

describe('Desk service', () => {
  let tmp;
  let service;

  before(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'hb-desk-service-'));
    const env = Object.create(null);
    const profiles = buildProfiles(env);
    const deterministic = profiles.find((p) => p.id === 'deterministic');
    const provider = createProvider(deterministic, env);
    const sessionStore = new SessionStore({ root: resolve(tmp, 'sessions') });
    service = new DeskService({ env, profiles, provider, weiss: null, sessionStore });
    await service.init();
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('creates a session', async () => {
    const session = await service.createSession({ prompt: 'a tense loop', weissEnabled: false, profileId: 'deterministic' });
    assert.equal(session.prompt, 'a tense loop');
    assert.equal(session.weissEnabled, false);
    assert.equal(session.profileId, 'deterministic');
  });

  it('composes a score from a brief', { skip: pinnedSkip() }, async () => {
    const session = await service.createSession({ prompt: 'a tense loop', weissEnabled: false, profileId: 'deterministic' });
    const { brief } = await service.makeBrief(session.sessionId, 'a tense loop for a stealth scene');
    assert.ok(brief.length > 0);
    const result = await service.composeScore(session.sessionId, { renderStems: true, renderRpp: true });
    assert.ok(result.take.score);
    assert.ok(result.take.mixSha256);
    assert.equal(result.take.hasStems, true);
    assert.equal(result.take.hasRpp, true);
  });

  it('revises a score', { skip: pinnedSkip() }, async () => {
    const session = await service.createSession({ prompt: 'a tense loop', weissEnabled: false, profileId: 'deterministic' });
    await service.makeBrief(session.sessionId);
    const first = await service.composeScore(session.sessionId);
    const second = await service.reviseScore(session.sessionId, first.take.takeId, 'make it brighter');
    assert.equal(second.take.parentTakeId, first.take.takeId);
  });
});
