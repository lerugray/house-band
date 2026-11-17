import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { pinnedSkip } from './helpers/env.mjs';

import { HouseBandApiService } from '../src/api/service.mjs';
import { sha256 } from '../src/provenance.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function artifacts(job, kind) {
  return job.artifacts.filter((artifact) => artifact.kind === kind);
}

function mockWeiss({ brief = 'A crisp operator-voiced brief: keep the pulse tight and the register personal.', fail = false } = {}) {
  return {
    available() { return true; },
    async generate() {
      return {
        success: !fail,
        stdout: fail ? '' : brief,
        stderr: fail ? 'weiss failed intentionally' : '',
        exitStatus: fail ? 1 : 0,
        profile: 'mock-profile',
        executable: '/opt/weiss/bin/weiss',
        argv: ['--register'],
        timestamp: new Date().toISOString(),
        timeout: 10_000,
        timedOut: false,
        version: 'weiss-mock/1.0.0',
      };
    },
  };
}

describe('Weiss register execution', () => {
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'house-band-api-t3-weiss-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses Weiss stdout as the immutable register brief', { skip: pinnedSkip() }, async () => {
    const brief = 'Operator voice: sparse, syncopated, minor-key tension.';
    const service = await new HouseBandApiService({ storeRoot: root, weiss: mockWeiss({ brief }) }).init();
    const submitted = await service.submitSong({
      prompt: 'Write me a song in my own vocabulary.',
      register: { source: 'weiss' },
      seed: 0xfeedface,
      canonicalVoiceAllowlist: ['kick', 'snare'],
      render: { fullMix: true },
      duration: { targetBars: 2 },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'succeeded');

    const registerArtifact = artifacts(job, 'register')[0];
    const registerBytes = (await service.getArtifact(job.jobId, registerArtifact.artifactId)).bytes;
    assert.equal(registerBytes.toString('utf8'), brief, 'register artifact must retain exact Weiss stdout bytes');
    assert.equal(registerArtifact.sha256, sha256(Buffer.from(brief, 'utf8')));

    const scoreArtifact = artifacts(job, 'score')[0];
    const score = JSON.parse((await service.getArtifact(job.jobId, scoreArtifact.artifactId)).bytes.toString('utf8'));
    assert.equal(score.register.name, `r-${sha256(Buffer.from(brief, 'utf8')).slice(0, 62)}`);
    assert.equal(score.register.briefRef, `docs/generated-registers/${sha256(Buffer.from(brief, 'utf8'))}.md`);

    const provenanceArtifact = artifacts(job, 'provenance')[0];
    const provenance = JSON.parse((await service.getArtifact(job.jobId, provenanceArtifact.artifactId)).bytes.toString('utf8'));
    assert.ok(provenance.weiss, 'provenance must include Weiss metadata');
    assert.equal(provenance.weiss.success, true);
    assert.equal(provenance.weiss.stdout, brief);
    assert.equal(provenance.weiss.profile, 'mock-profile');
    assert.equal(provenance.weiss.executable, '/opt/weiss/bin/weiss');
    assert.deepEqual(provenance.weiss.argv, ['--register']);
    assert.equal(provenance.weiss.exitStatus, 0);
    assert.equal(provenance.weiss.timedOut, false);
    assert.equal(provenance.weiss.version, 'weiss-mock/1.0.0');
    assert.equal(Object.hasOwn(provenance.weiss, 'fallback'), false);
  });

  it('fails the job with WEISS_FAILED when Weiss fails and fallback is not allowed', { skip: pinnedSkip() }, async () => {
    const service = await new HouseBandApiService({ storeRoot: root, weiss: mockWeiss({ fail: true }) }).init();
    const submitted = await service.submitSong({
      prompt: 'This Weiss should fail.',
      register: { source: 'weiss' },
      seed: 0xdeadbeef,
      canonicalVoiceAllowlist: ['kick'],
      render: { fullMix: true },
      duration: { targetBars: 2 },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'failed');
    assert.equal(job.error.code, 'WEISS_FAILED');
    assert.equal(job.error.stage, 'resolving_register');
    assert.equal(artifacts(job, 'score').length, 0, 'no score should be composed after Weiss failure');
  });

  it('falls back to the neutral register when allowNeutralFallback is true', { skip: pinnedSkip() }, async () => {
    const service = await new HouseBandApiService({ storeRoot: root, weiss: mockWeiss({ fail: true }) }).init();
    const submitted = await service.submitSong({
      prompt: 'Weiss fails but fallback is allowed.',
      register: { source: 'weiss', allowNeutralFallback: true },
      seed: 0xcafebabe,
      canonicalVoiceAllowlist: ['kick'],
      render: { fullMix: true },
      duration: { targetBars: 2 },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'succeeded');

    const registerArtifact = artifacts(job, 'register')[0];
    const registerBytes = (await service.getArtifact(job.jobId, registerArtifact.artifactId)).bytes;
    assert.match(registerBytes.toString('utf8'), /neutral register/);

    const provenanceArtifact = artifacts(job, 'provenance')[0];
    const provenance = JSON.parse((await service.getArtifact(job.jobId, provenanceArtifact.artifactId)).bytes.toString('utf8'));
    assert.equal(provenance.weiss.success, false);
    assert.equal(provenance.weiss.fallback, true);
  });

  it('reports WEISS_FAILED when Weiss is requested but not configured', { skip: pinnedSkip() }, async () => {
    const service = await new HouseBandApiService({ storeRoot: root }).init();
    const submitted = await service.submitSong({
      prompt: 'No Weiss configured.',
      register: { source: 'weiss' },
      seed: 0xbadf00d,
      canonicalVoiceAllowlist: ['kick'],
      render: { fullMix: true },
      duration: { targetBars: 2 },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'failed');
    assert.equal(job.error.code, 'WEISS_FAILED');
  });

  it('advertises Weiss in capabilities only when configured and available', async () => {
    const withWeiss = await new HouseBandApiService({ storeRoot: root, weiss: mockWeiss() }).init();
    assert.deepEqual(withWeiss.capabilities().registerSources, ['supplied', 'command', 'weiss', 'neutral']);
    assert.equal(withWeiss.health().weissAvailable, true);

    const withoutWeiss = await new HouseBandApiService({ storeRoot: root }).init();
    assert.deepEqual(withoutWeiss.capabilities().registerSources, ['supplied', 'neutral']);
    assert.equal(withoutWeiss.health().weissAvailable, false);
  });

  it('passes the admitted composition context to Weiss as bounded stdin JSON', { skip: pinnedSkip() }, async () => {
    let received = null;
    const capturingWeiss = {
      available() { return true; },
      async generate(context) {
        received = context;
        return {
          success: true,
          stdout: 'Captured context brief.',
          stderr: '',
          exitStatus: 0,
          profile: 'capture',
          executable: '/capture',
          argv: [],
          timestamp: new Date().toISOString(),
          timeout: 10_000,
          timedOut: false,
          version: null,
        };
      },
    };
    const service = await new HouseBandApiService({ storeRoot: root, weiss: capturingWeiss }).init();
    await (await service.submitSong({
      prompt: 'Pass my context through.',
      titleHint: 'Context proof',
      register: { source: 'weiss', notes: 'test notes' },
      seed: 0x11111111,
      canonicalVoiceAllowlist: ['kick', 'hat'],
      duration: { targetBars: 2, targetSeconds: 5 },
      sections: [{ name: 'a', bars: 2 }],
      render: { fullMix: true },
      execution: { mode: 'sync_wait', waitTimeoutMs: 5_000 },
    })).completion;
    assert.ok(received);
    assert.equal(received.prompt, 'Pass my context through.');
    assert.equal(received.titleHint, 'Context proof');
    assert.equal(received.canonicalVoiceAllowlist.length, 2);
    assert.equal(received.sections.length, 1);
    assert.equal(received.sections[0].name, 'a');
    assert.equal(received.sections[0].bars, 2);
    assert.ok(received.duration);
  });
});
