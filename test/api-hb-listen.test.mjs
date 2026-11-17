import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '../src/api/errors.mjs';
import {
  CUSTODY_PROFILE_ID, CUSTODY_TAIL_ID, LISTEN_PROFILE_ID, LISTEN_TAIL_ID, RENDERER_BUILD,
  custodyAvailability, custodyProfile, listenAvailability, listenProfile, requireListenProfile,
} from '../src/api/profile.mjs';
import { HouseBandApiService } from '../src/api/service.mjs';

const WIN = Object.freeze({ version: 'v24.14.0', platform: 'win32', arch: 'x64' });
const MAC = Object.freeze({ version: 'v25.9.0', platform: 'darwin', arch: 'arm64' });
const ODD = Object.freeze({ version: 'v24.14.0', platform: 'freebsd', arch: 'ia32' });

const artifacts = (job, kind) => job.artifacts.filter((artifact) => artifact.kind === kind);
const text = async (service, job, kind) => (await service.getArtifact(job.jobId, artifacts(job, kind)[0].artifactId)).bytes.toString('utf8');
const SONG = { prompt: 'A compact pulse for a listening copy.', seed: 0x1157e11, canonicalVoiceAllowlist: ['kick', 'snare', 'hat'], render: { fullMix: true } };

describe('hb-listen-render profile', () => {
  it('has its own ids and never passes custodyAvailability', () => {
    assert.equal(LISTEN_PROFILE_ID, 'hb-listen-render/1.0.0');
    assert.notEqual(LISTEN_PROFILE_ID, CUSTODY_PROFILE_ID);
    assert.notEqual(LISTEN_TAIL_ID, CUSTODY_TAIL_ID);
    for (const runtime of [WIN, MAC, ODD, process]) {
      assert.equal(custodyAvailability(listenProfile(undefined, false, runtime), runtime).available, false);
      assert.equal(custodyAvailability(listenProfile(undefined, false, runtime), runtime).checks.profileId, false);
    }
    assert.equal(listenAvailability(custodyProfile(), MAC).available, false, 'a custody profile is not a listen profile');
  });

  it('declares the actual runtime and is available on win32/x64 only where the platform is supported', () => {
    const profile = listenProfile(undefined, false, WIN);
    assert.deepEqual(profile.runtime, { node: 'v24.14.0', operatingSystem: 'win32', architecture: 'x64' });
    assert.equal(profile.custody, false);
    assert.equal(profile.renderer.build, RENDERER_BUILD);
    assert.equal(listenAvailability(profile, WIN).available, true);
    assert.equal(listenAvailability(profile, MAC).available, false, 'declared runtime must be the runtime it runs on');
    assert.equal(listenAvailability(listenProfile(undefined, false, ODD), ODD).checks.supportedPlatform, false);
    assert.throws(() => requireListenProfile(listenProfile(undefined, false, ODD), ODD), (e) => e instanceof ApiError && e.code === 'TOOLCHAIN_UNAVAILABLE');
    assert.equal(listenAvailability({ ...profile, custody: true }, WIN).available, false);
  });
});

describe('listen jobs through the API service', () => {
  let root;
  let win;
  let mac;
  let listenJob;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'house-band-hb-listen-'));
    win = await new HouseBandApiService({ storeRoot: root, runtime: WIN }).init();
    mac = await new HouseBandApiService({ storeRoot: root, runtime: MAC }).init();
    listenJob = await (await win.submitSong({ ...SONG, renderProfileId: LISTEN_PROFILE_ID })).completion;
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('health reports listen beside custody; custody stays the default', async () => {
    assert.equal(win.health().custodyRendererAvailable, false);
    assert.equal(win.health().listenRendererAvailable, true);
    assert.equal(win.health().listenProfileId, LISTEN_PROFILE_ID);
    assert.equal(mac.health().custodyRendererAvailable, true);
    assert.equal(win.capabilities().listenRenderProfiles[0].id, LISTEN_PROFILE_ID);
    assert.equal(win.capabilities().custodyRenderProfiles[0].id, CUSTODY_PROFILE_ID);
    const defaulted = await (await win.submitSong(SONG)).completion;
    assert.equal(defaulted.state, 'failed');
    assert.equal(defaulted.error.code, 'TOOLCHAIN_UNAVAILABLE');
    assert.equal(artifacts(defaulted, 'wav_mix').length, 0);
  });

  it('renders on a runtime where custody is unavailable and names only the listen profile', async () => {
    assert.equal(listenJob.state, 'succeeded', JSON.stringify(listenJob.error));
    assert.equal(artifacts(listenJob, 'wav_mix').length, 1);
    const manifest = JSON.parse(await text(win, listenJob, 'manifest'));
    const provenance = JSON.parse(await text(win, listenJob, 'provenance'));
    assert.equal(manifest.listenProfile.id, LISTEN_PROFILE_ID);
    assert.equal(manifest.custodyProfile, undefined);
    assert.deepEqual(manifest.listenProfile.runtime, { node: 'v24.14.0', operatingSystem: 'win32', architecture: 'x64' });
    assert.equal(provenance.listenProfile.id, LISTEN_PROFILE_ID);
    assert.equal(provenance.custodyProfile, undefined);
    assert.equal(listenJob.provenanceSummary.listenProfileId, LISTEN_PROFILE_ID);
    assert.equal(listenJob.provenanceSummary.custodyProfileId, undefined);
    assert.match(manifest.determinismScope, /no custody promise/);
    const everything = [await text(win, listenJob, 'manifest'), await text(win, listenJob, 'provenance'), await readFile(join(root, 'jobs', listenJob.jobId, 'job.json'), 'utf8')].join('\n');
    assert.equal(/hb-custody/.test(everything), false, 'no artifact of a listen job may carry a custody id');
    assert.equal(/custodyProfile/.test(everything), false);
  });

  it('a listen job can never be the sourceJobId of a custody render', async () => {
    const score = JSON.parse(await text(win, listenJob, 'score'));
    for (const service of [mac, win]) {
      const failed = await (await service.submitRender({ score, sourceJobId: listenJob.jobId, outputs: { fullMix: true } })).completion;
      assert.equal(failed.state, 'failed');
      assert.equal(failed.error.code, 'TOOLCHAIN_UNAVAILABLE');
      assert.match(failed.error.message, /listen render is not a custody receipt/);
      assert.equal(artifacts(failed, 'wav_mix').length, 0);
    }
  });

  it('a listen job relabelled as custody on disk is still refused', async () => {
    const path = join(root, 'jobs', listenJob.jobId, 'job.json');
    const original = await readFile(path, 'utf8');
    const record = JSON.parse(original);
    const { listenProfile: retained, renderProfileId, ...admission } = record.admission;
    record.admission = { ...admission, custodyProfile: retained };
    await writeFile(path, JSON.stringify(record));
    try {
      const score = JSON.parse(await text(win, listenJob, 'score'));
      const failed = await (await mac.submitRender({ score, sourceJobId: listenJob.jobId, outputs: { fullMix: true } })).completion;
      assert.equal(failed.state, 'failed');
      assert.equal(failed.error.code, 'TOOLCHAIN_UNAVAILABLE');
      assert.equal(artifacts(failed, 'wav_mix').length, 0);
    } finally {
      await writeFile(path, original);
    }
  });

  it('a render request cannot name the listen profile as a custody profile', async () => {
    const score = JSON.parse(await text(win, listenJob, 'score'));
    const failed = await (await mac.submitRender({ score, custodyProfileId: LISTEN_PROFILE_ID, outputs: { fullMix: true } })).completion;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error.code, 'TOOLCHAIN_UNAVAILABLE');
  });

  it('listen provenance is not accepted as a custody receipt anywhere the code reads one', async () => {
    const provenance = JSON.parse(await text(win, listenJob, 'provenance'));
    assert.equal(custodyAvailability(provenance.listenProfile, WIN).available, false);
    assert.equal(custodyAvailability(provenance.listenProfile, MAC).available, false);
    assert.equal(custodyAvailability(provenance.custodyProfile, MAC).available, false);
    assert.equal(listenJob.admission.custodyProfile, undefined);
  });

  it('rejects unknown profile ids and listen requests for sample packs', async () => {
    await assert.rejects(() => win.submitSong({ ...SONG, renderProfileId: 'hb-custody-render/9.9.9' }), (e) => e instanceof ApiError && e.code === 'INVALID_REQUEST');
    await assert.rejects(() => win.submitSong({ ...SONG, renderProfileId: LISTEN_PROFILE_ID, pack: {} }), (e) => e instanceof ApiError && e.code === 'INVALID_REQUEST');
  });

  it('a custody song is unchanged: custody profile, no listen keys', async () => {
    const custody = await (await mac.submitSong(SONG)).completion;
    assert.equal(custody.state, 'succeeded', JSON.stringify(custody.error));
    const manifest = JSON.parse(await text(mac, custody, 'manifest'));
    assert.equal(manifest.custodyProfile.id, CUSTODY_PROFILE_ID);
    assert.equal(manifest.listenProfile, undefined);
    assert.equal(custody.provenanceSummary.custodyProfileId, CUSTODY_PROFILE_ID);
    assert.equal(/hb-listen|listenProfile/.test(await text(mac, custody, 'provenance')), false);
    assert.equal(listenJob.artifacts.find((a) => a.kind === 'wav_mix').sha256, custody.artifacts.find((a) => a.kind === 'wav_mix').sha256, 'same renderer and score give the same bytes here');
  });
});
