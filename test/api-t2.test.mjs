import { createHash } from 'node:crypto';
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
import { canonicalJson, sha256 } from '../src/provenance.mjs';
import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { validateRpp } from '../app/reaper.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packRoot = join(repoRoot, 'sample-packs', 'hb-synth-oneshots');

function artifacts(job, kind) {
  return job.artifacts.filter((artifact) => artifact.kind === kind);
}

function parseSse(buffer) {
  const text = buffer.toString('utf8');
  const events = [];
  const blocks = text.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    const event = { id: null, event: null, data: null };
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) event.id = Number(line.slice(4));
      else if (line.startsWith('event: ')) event.event = line.slice(7);
      else if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6));
      else if (line.startsWith(':')) continue;
    }
    if (event.event) events.push(event);
  }
  return events;
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

async function httpSse(base, path, { headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { headers });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    events: response.headers.get('content-type')?.includes('text/event-stream') ? parseSse(body) : [],
    body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(body.toString('utf8')) : null,
  };
}

describe('House Band API tranche 2', { skip: packSkip('hb-synth-oneshots') }, () => {
  let root;
  let service;
  let pack;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'house-band-api-t2-'));
    service = await new HouseBandApiService({ storeRoot: root }).init();
    pack = await loadSamplePackDirectory(packRoot);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('GET /v1/packs lists every installed pack with exact identities and lane bindings', async () => {
    await withServer(service, async (base) => {
      const response = await httpJson(base, { path: '/v1/packs' });
      assert.equal(response.status, 200);
      // The registry scans sample-packs/, so the roster grows as packs are
      // added; assert by pack id rather than by count.
      const entry = response.body.packs.find((row) => row.packId === 'hb-synth-oneshots');
      assert.ok(entry, 'the M3 one-shot pack must still be listed');
      assert.equal(entry.format, 'house-band-sample-pack');
      assert.equal(entry.formatVersion, '1.1.0');
      assert.equal(entry.manifestSha256, pack.manifest.manifestSha256);
      assert.equal(entry.contentSha256, pack.manifest.contentSha256);
      assert.equal(entry.immutableSnapshotAvailable, true);
      assert.deepEqual(entry.schemaCompatibility, ['1.1.0']);
      assert.ok(entry.assets.length >= 3);
      for (const asset of entry.assets) {
        assert.ok(Array.isArray(asset.allowedCanonicalLanes));
        assert.ok(asset.allowedCanonicalLanes.every((lane) => ['kick', 'snare', 'hat'].includes(lane)));
        assert.equal(typeof asset.wavSha256, 'string');
        assert.equal(typeof asset.pcmSha256, 'string');
      }

      // Kit 1.7.0: a pitched 1.1.0 pack lists alongside it on the sampler lane.
      const sampler = response.body.packs.find((row) => row.packId === 'sampler-demo-17');
      assert.ok(sampler, 'the pitched sampler pack must be listed');
      assert.equal(sampler.formatVersion, '1.1.0');
      assert.ok(sampler.assets.every((asset) => asset.allowedCanonicalLanes.includes('sampler')));
    });
  });

  it('submits a pack-backed song, emits events, and includes pack custody in manifest and provenance', { skip: pinnedSkip() }, async () => {
    const packRequest = {
      format: 'house-band-sample-pack',
      formatVersion: '1.1.0',
      packId: pack.manifest.packId,
      manifestSha256: pack.manifest.manifestSha256,
      contentSha256: pack.manifest.contentSha256,
      policy: 'required',
    };
    const submitted = await service.submitSong({
      prompt: 'A deterministic TR-606 pulse for pack custody proof.',
      seed: 0xdecafbad,
      canonicalVoiceAllowlist: ['kick', 'snare', 'hat'],
      pack: packRequest,
      render: { fullMix: true, stems: true, rpp: true },
      composition: { maxValidationAttempts: 3 },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'succeeded');

    const manifestArtifact = artifacts(job, 'manifest')[0];
    const manifest = JSON.parse((await service.getArtifact(job.jobId, manifestArtifact.artifactId)).bytes);
    assert.ok(manifest.m3, 'manifest must include M3 custody block');
    assert.equal(manifest.m3.packId, pack.manifest.packId);
    assert.equal(manifest.m3.format, 'house-band-sample-pack');
    assert.equal(manifest.m3.formatVersion, '1.1.0');
    assert.equal(manifest.m3.manifestSha256, pack.manifest.manifestSha256);
    assert.equal(manifest.m3.contentSha256, pack.manifest.contentSha256);
    assert.ok(manifest.m3.referencedAssets.length > 0);
    for (const ref of manifest.m3.referencedAssets) {
      const asset = pack.manifest.assets.find((a) => a.id === ref.assetId);
      assert.ok(asset, `referenced asset ${ref.assetId} must exist in pack`);
      assert.equal(ref.wavSha256, asset.wavSha256);
      assert.equal(ref.pcmSha256, ref.pcmSha256);
    }
    assert.ok(manifest.rpp, 'manifest must include RPP hash block');
    assert.equal(typeof manifest.rpp.sha256, 'string');
    assert.equal(typeof manifest.rpp.bytes, 'number');

    const provenanceArtifact = artifacts(job, 'provenance')[0];
    const provenance = JSON.parse((await service.getArtifact(job.jobId, provenanceArtifact.artifactId)).bytes);
    assert.ok(provenance.exactPackResolution, 'provenance must include exact pack resolution');
    assert.equal(provenance.exactPackResolution.packId, pack.manifest.packId);
    assert.ok(provenance.hashDomain.some((entry) => entry.kind === 'pack_sidecar' && entry.filename === 'pack.json'));
    assert.ok(provenance.hashDomain.some((entry) => entry.kind === 'rpp'));

    const scoreArtifact = artifacts(job, 'score')[0];
    const score = JSON.parse((await service.getArtifact(job.jobId, scoreArtifact.artifactId)).bytes);
    assert.ok(score.samplePack);
    assert.ok(score.sampleVoices);
    assert.equal(score.samplePack.packId, pack.manifest.packId);
  });

  it('rejects a non-existent or mismatched pack identity before rendering', async () => {
    await assert.rejects(
      () => service.submitSong({
        prompt: 'missing pack',
        pack: {
          format: 'house-band-sample-pack',
          formatVersion: '1.0.0',
          packId: 'no-such-pack',
          manifestSha256: '0'.repeat(64),
          contentSha256: '0'.repeat(64),
          policy: 'required',
        },
      }),
      (error) => error.code === 'PACK_MISSING',
    );
    await assert.rejects(
      () => service.submitSong({
        prompt: 'mismatched pack',
        pack: {
          format: 'house-band-sample-pack',
          formatVersion: '1.1.0',
          packId: pack.manifest.packId,
          manifestSha256: pack.manifest.manifestSha256,
          contentSha256: '0'.repeat(64),
          policy: 'required',
        },
      }),
      (error) => error.code === 'PACK_IDENTITY_MISMATCH',
    );
    await assert.rejects(
      () => service.submitSong({ prompt: 'malformed pack', pack: { packId: pack.manifest.packId } }),
      (error) => error.code === 'INVALID_REQUEST' && /pack\.format/.test(error.message),
    );
  });

  it('streams job events with ordered replay, cursor resume, and expired-cursor failure', { skip: pinnedSkip() }, async () => {
    const submitted = await service.submitSong({
      prompt: 'SSE event stream proof',
      seed: 0xbaddcafe,
      canonicalVoiceAllowlist: ['kick'],
      execution: { mode: 'async' },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'succeeded');

    await withServer(service, async (base) => {
      const live = await httpSse(base, `/v1/jobs/${job.jobId}/events`);
      assert.equal(live.status, 200);
      assert.equal(live.events.length > 0, true);
      assert.equal(live.events[0].event, 'job_started');
      assert.equal(live.events[live.events.length - 1].event, 'job_succeeded');
      const ids = live.events.map((event) => event.id);
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'event ids must increase monotonically');

      const cursor = live.events[2].id;
      const replay = await httpSse(base, `/v1/jobs/${job.jobId}/events?after=${cursor}`);
      assert.equal(replay.status, 200);
      assert.equal(replay.events[0].id, cursor + 1);
      assert.equal(replay.events[replay.events.length - 1].event, 'job_succeeded');

      const headerReplay = await httpSse(base, `/v1/jobs/${job.jobId}/events`, { headers: { 'Last-Event-ID': String(cursor) } });
      assert.equal(headerReplay.status, 200);
      assert.equal(headerReplay.events[0].id, cursor + 1);

      const expired = await httpSse(base, `/v1/jobs/${job.jobId}/events?after=99999`);
      assert.equal(expired.status, 409);
      assert.equal(expired.body.error.code, 'EVENT_CURSOR_EXPIRED');
    });
  });

  it('generates an RPP that obeys the content law and appears in the manifest', { skip: pinnedSkip() }, async () => {
    const packRequest = {
      format: 'house-band-sample-pack',
      formatVersion: '1.1.0',
      packId: pack.manifest.packId,
      manifestSha256: pack.manifest.manifestSha256,
      contentSha256: pack.manifest.contentSha256,
      policy: 'required',
    };
    const submitted = await service.submitSong({
      prompt: 'RPP content law proof',
      seed: 0xc0ffee,
      canonicalVoiceAllowlist: ['kick', 'snare', 'hat'],
      pack: packRequest,
      render: { fullMix: true, rpp: true },
      duration: { targetBars: 4 },
    });
    const job = await submitted.completion;
    assert.equal(job.state, 'succeeded');

    const rppArtifact = artifacts(job, 'rpp')[0];
    assert.ok(rppArtifact, 'RPP artifact must exist');
    const rppBytes = (await service.getArtifact(job.jobId, rppArtifact.artifactId)).bytes;
    const rpp = rppBytes.toString('utf8');
    assert.ok(rpp.startsWith('<REAPER_PROJECT'), 'RPP must be plain text REAPER project');
    assert.ok(rpp.includes('TEMPO'), 'RPP must include project tempo');
    assert.ok(!rpp.includes('FXCHAIN'), 'RPP must contain no plug-in assumptions');
    assert.ok(!rpp.includes('VST '), 'RPP must contain no plug-in assumptions');

    const scoreArtifact = artifacts(job, 'score')[0];
    const score = JSON.parse((await service.getArtifact(job.jobId, scoreArtifact.artifactId)).bytes);
    const manifestArtifact = artifacts(job, 'manifest')[0];
    const manifest = JSON.parse((await service.getArtifact(job.jobId, manifestArtifact.artifactId)).bytes);
    const stemArtifacts = artifacts(job, 'wav_stem');
    const structure = validateRpp(rpp, {
      tempo: score.tempo,
      voices: stemArtifacts.map((artifact) => artifact.filename.replace('stem-', '').replace('.wav', '')),
      filenames: stemArtifacts.map((artifact) => artifact.filename),
      length: manifest.commonFrameCount / 44100,
    });
    assert.equal(structure.tracks, stemArtifacts.length, 'one track per stem');
    assert.ok(structure.markers >= score.sections.length, 'RPP has section markers where representable');

    assert.equal(manifest.rpp.sha256, rppArtifact.sha256);
  });

  it('replays a pack-backed job twice with byte-identical mix and stems', { skip: pinnedSkip() }, async () => {
    const packRequest = {
      format: 'house-band-sample-pack',
      formatVersion: '1.1.0',
      packId: pack.manifest.packId,
      manifestSha256: pack.manifest.manifestSha256,
      contentSha256: pack.manifest.contentSha256,
      policy: 'required',
    };
    const submitted = await service.submitSong({
      prompt: 'Replay determinism proof with pack',
      seed: 0xdecafbad,
      canonicalVoiceAllowlist: ['kick', 'snare', 'hat'],
      pack: packRequest,
      render: { fullMix: true, stems: true },
      duration: { targetBars: 4 },
    });
    const source = await submitted.completion;
    assert.equal(source.state, 'succeeded');
    const scoreArtifact = artifacts(source, 'score')[0];
    const score = JSON.parse((await service.getArtifact(source.jobId, scoreArtifact.artifactId)).bytes);

    const request = {
      score,
      sourceJobId: source.jobId,
      custodyProfileId: CUSTODY_PROFILE_ID,
      outputs: { fullMix: true, stems: true },
    };
    const first = await (await service.submitRender(request)).completion;
    const second = await (await service.submitRender(request)).completion;
    assert.equal(first.state, 'succeeded');
    assert.equal(second.state, 'succeeded');
    assert.equal(artifacts(first, 'wav_mix')[0].sha256, artifacts(second, 'wav_mix')[0].sha256);
    assert.equal(artifacts(first, 'wav_mix')[0].sha256, artifacts(source, 'wav_mix')[0].sha256);
    const firstStems = Object.fromEntries(artifacts(first, 'wav_stem').map((artifact) => [artifact.filename, artifact.sha256]));
    const secondStems = Object.fromEntries(artifacts(second, 'wav_stem').map((artifact) => [artifact.filename, artifact.sha256]));
    assert.deepEqual(firstStems, secondStems);
  });

  it('advertises implemented capabilities and an honest deferred list', () => {
    const caps = service.capabilities();
    assert.equal(caps.renderer.fullMix, true);
    assert.equal(caps.renderer.stems, true);
    assert.equal(caps.renderer.rpp, true);
    assert.equal(caps.renderer.derivatives, true);
    assert.equal(caps.packs.supported, true);
    assert.ok(caps.packs.installed.length > 0);
    assert.deepEqual(caps.registerSources, ['supplied', 'neutral']);
    const deferred = caps.deferred.map((entry) => entry.feature);
    assert.ok(!deferred.includes('derivative renders'));
    assert.ok(!deferred.includes('Weiss register execution'));
    assert.ok(!deferred.includes('registry/release-range pack selection'));
    assert.ok(deferred.includes('real model transport'));
  });
});
