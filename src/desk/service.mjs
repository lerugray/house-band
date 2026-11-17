/**
 * Composer's Desk service.
 *
 * Orchestrates brief authoring, score composition, custody rendering, session
 * persistence, and export bundling. Reuses the existing HouseBandApiService for
 * canonical render jobs and pack registry.
 */

import { randomUUID, randomInt } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { HouseBandApiService } from '../api/service.mjs';
import { custodyProfile, requireCustodyProfile } from '../api/profile.mjs';
import { canonicalJson, sha256 } from '../provenance.mjs';
import { CODES, DeskError } from './errors.mjs';
import { buildProfiles, defaultProfile, publicProfiles, weissConfig } from './config.mjs';
import { createProvider } from './providers/index.mjs';
import { SessionStore } from './session-store.mjs';
import { WeissCli } from './weiss.mjs';

function nowIso() {
  return new Date().toISOString();
}

function artifactBody(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function buildBriefPrompt(rawPrompt, context = {}) {
  return {
    requestFormat: 'hb-desk-brief/1.0.0',
    task: 'Write a concise register/direction brief for a House Band score. Return only plain text. No JSON, no Markdown, no code.',
    rawPrompt,
    context: context.previousBrief ?? null,
    revision: context.revision ?? null,
    output: 'plain-language direction brief',
  };
}

const DEFAULT_DESK_SECTIONS = Object.freeze([
  Object.freeze({ name: 'A', bars: 2 }),
  Object.freeze({ name: 'B', bars: 2 }),
]);

const DEFAULT_DESK_VOICES = Object.freeze(['kick', 'snare', 'hat', 'bass', 'lead', 'pad', 'pluck']);

function buildSongRequest(session, brief, options = {}) {
  const sections = options.sections ?? DEFAULT_DESK_SECTIONS;
  const targetBars = sections.reduce((sum, s) => sum + s.bars, 0);
  return {
    prompt: session.prompt,
    titleHint: options.titleHint ?? session.prompt.slice(0, 40),
    register: {
      source: 'supplied',
      brief,
    },
    ...(options.pack ? { pack: options.pack } : {}),
    canonicalVoiceAllowlist: options.canonicalVoiceAllowlist ?? DEFAULT_DESK_VOICES,
    sections,
    duration: { targetBars },
    composition: {
      modelLaneId: options.modelLaneId ?? session.profileId,
      maxValidationAttempts: options.maxValidationAttempts ?? 3,
    },
    render: {
      fullMix: true,
      stems: options.stems ?? false,
      rpp: options.rpp ?? false,
    },
    execution: {
      mode: 'async',
    },
  };
}

export class DeskService {
  constructor({
    env = Object.create(null),
    profiles = [],
    provider = null,
    weiss = null,
    sessionStore = null,
    apiService = null,
    custodyCheck = requireCustodyProfile,
    logFile = null,
  } = {}) {
    this.env = env;
    this.profiles = profiles;
    this.provider = provider;
    this.weiss = weiss;
    this.sessionStore = sessionStore ?? new SessionStore();
    this.apiService = apiService;
    this.custodyCheck = custodyCheck;
    this.logFile = logFile;
  }

  async init() {
    await this.sessionStore.init();
    if (!this.apiService) {
      this.apiService = await new HouseBandApiService({
        storeRoot: this.sessionStore.root.replace('/Sessions', '/Jobs'),
        provider: this.provider,
      }).init();
    }
    return this;
  }

  health() {
    const profile = this.provider
      ? this.profiles.find((p) => p.id === this.provider.laneId) ?? null
      : null;
    const custodyRendererAvailable = (() => {
      try {
        this.custodyCheck(custodyProfile());
        return true;
      } catch {
        return false;
      }
    })();

    return Object.freeze({
      status: custodyRendererAvailable ? 'ok' : 'degraded',
      provider: profile ? { id: profile.id, displayName: profile.displayName, model: profile.model } : null,
      providerHealth: profile ? (profile.configured ? 'configured' : 'missing configuration') : 'none',
      weissAvailable: this.weiss ? this.weiss.available() : false,
      custodyRendererAvailable,
      ...(this.logFile ? { logFile: this.logFile } : {}),
    });
  }

  capabilities() {
    return Object.freeze({
      profiles: publicProfiles(this.profiles),
      defaultProfileId: (defaultProfile(this.profiles) ?? this.profiles[0])?.id ?? null,
      weissAvailable: this.weiss ? this.weiss.available() : false,
      voices: this.apiService?.capabilities?.().canonicalVoiceAllowlist ?? [],
      packs: this.apiService?.listPacks?.() ?? [],
    });
  }

  async createSession({ prompt = '', weissEnabled = true, profileId = null } = {}) {
    const resolvedProfileId = profileId || defaultProfile(this.profiles)?.id;
    const session = await this.sessionStore.create({ prompt, weissEnabled, profileId: resolvedProfileId });
    return this.publicSession(session);
  }

  async getSession(sessionId) {
    const session = await this.sessionStore.read(sessionId);
    return this.publicSession(session);
  }

  async listSessions() {
    return this.sessionStore.list();
  }

  async setSessionProfile(sessionId, profileId) {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) throw new DeskError(CODES.INVALID_REQUEST, `Unknown profile ${profileId}`);
    const session = await this.sessionStore.update(sessionId, (s) => {
      s.profileId = profileId;
      return s;
    });
    return this.publicSession(session);
  }

  async setWeissEnabled(sessionId, enabled) {
    const session = await this.sessionStore.update(sessionId, (s) => {
      s.weissEnabled = Boolean(enabled);
      return s;
    });
    return this.publicSession(session);
  }

  providerFor(session) {
    const profileId = session.profileId;
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) throw new DeskError(CODES.INVALID_REQUEST, `Unknown profile ${profileId}`);
    return createProvider(profile, this.env);
  }

  async authorBriefText(session, promptText, { signal } = {}) {
    if (session.weissEnabled) {
      if (!this.weiss) {
        throw new DeskError(CODES.WEISS_FAILED, 'Weiss is enabled but not configured.');
      }
      if (!this.weiss.available()) {
        throw new DeskError(CODES.WEISS_FAILED, 'Weiss is enabled but unavailable.', {
          executable: this.weiss.executable,
          script: this.weiss.script,
        });
      }
      const result = await this.weiss.generate(promptText, { signal });
      const brief = result.reply ?? result.briefText ?? '';
      if (!brief || brief.length === 0) {
        throw new DeskError(CODES.WEISS_FAILED, 'Weiss returned an empty reply.');
      }
      return {
        brief,
        source: 'weiss',
        weissMeta: result.provenance,
      };
    }

    const provider = this.providerFor(session);
    const request = buildBriefPrompt(promptText);
    const raw = await provider.generate({ request, signal });
    const brief = typeof raw === 'string' ? raw.trim() : String(raw).trim();
    return { brief, source: 'model', weissMeta: null };
  }

  async makeBrief(sessionId, prompt, { signal } = {}) {
    const session = await this.sessionStore.read(sessionId);
    const effectivePrompt = prompt ?? session.prompt;

    const authored = await this.authorBriefText(session, effectivePrompt, { signal });
    if (!authored.brief || authored.brief.length === 0) {
      throw new DeskError(
        authored.source === 'weiss' ? CODES.WEISS_FAILED : CODES.COMPOSITION_FAILED,
        'The brief was empty.',
      );
    }

    session.prompt = effectivePrompt;
    session.brief = {
      text: authored.brief,
      source: authored.source,
      createdAt: nowIso(),
      weissMeta: authored.weissMeta,
    };
    session.workflow.currentStage = 'brief';
    await this.sessionStore.write(session);

    return {
      brief: authored.brief,
      source: authored.source,
      weissMeta: authored.weissMeta,
    };
  }

  async composeScore(sessionId, { brief = null, renderStems = false, renderRpp = false } = {}) {
    const session = await this.sessionStore.read(sessionId);
    const usedBrief = brief ?? session.brief?.text;
    if (!usedBrief) {
      throw new DeskError(CODES.INVALID_REQUEST, 'A direction brief is required before composing.');
    }

    const provider = this.providerFor(session);
    this.apiService.setProvider(provider);
    const options = { stems: renderStems || renderRpp, rpp: renderRpp, modelLaneId: provider.laneId };
    const songRequest = buildSongRequest(session, usedBrief, options);
    const { job, completion } = await this.apiService.submitSong(songRequest);
    const completed = await completion;
    if (!completed || completed.state !== 'succeeded') {
      const message = completed?.error?.message || 'Composition or rendering failed.';
      throw new DeskError(CODES.COMPOSITION_FAILED, message, { jobId: job.jobId });
    }

    const take = await this.takeFromJob(session, completed, { parentTakeId: null });
    session.takes.push(take);
    session.activeTakeId = take.takeId;
    session.workflow.currentStage = 'audition';
    await this.sessionStore.write(session);

    return { take: this.publicTake(take), session: this.publicSession(session) };
  }

  async reviseScore(sessionId, takeId, direction, { renderStems = false, renderRpp = false, signal } = {}) {
    const session = await this.sessionStore.read(sessionId);
    const parent = session.takes.find((t) => t.takeId === takeId);
    if (!parent) throw new DeskError(CODES.TAKE_NOT_FOUND, `Take ${takeId} not found`);

    const revisionPrompt = `Previous direction: ${session.brief?.text || ''}\n\nRevision: ${direction}`;

    let authored;
    if (session.weissEnabled) {
      authored = await this.authorBriefText(session, revisionPrompt, { signal });
    } else {
      const provider = this.providerFor(session);
      const request = buildBriefPrompt(session.prompt, {
        previousBrief: session.brief?.text,
        revision: direction,
      });
      const raw = await provider.generate({ request, signal });
      const briefText = typeof raw === 'string' ? raw.trim() : String(raw).trim();
      authored = { brief: briefText, source: 'model', weissMeta: null };
    }

    const brief = authored.brief;
    if (!brief || brief.length === 0) {
      throw new DeskError(
        authored.source === 'weiss' ? CODES.WEISS_FAILED : CODES.COMPOSITION_FAILED,
        'The brief was empty.',
      );
    }

    session.revisionInstructions.push({ direction, previousBrief: session.brief?.text, createdAt: nowIso() });
    session.brief = {
      text: brief,
      source: authored.source,
      createdAt: nowIso(),
      weissMeta: authored.weissMeta,
    };

    const provider = this.providerFor(session);
    this.apiService.setProvider(provider);
    const options = { stems: renderStems || renderRpp, rpp: renderRpp, modelLaneId: provider.laneId };
    const songRequest = buildSongRequest(session, brief, options);
    const { job, completion } = await this.apiService.submitSong(songRequest);
    const completed = await completion;
    if (!completed || completed.state !== 'succeeded') {
      const message = completed?.error?.message || 'Revision composition or rendering failed.';
      throw new DeskError(CODES.COMPOSITION_FAILED, message, { jobId: job.jobId });
    }

    const take = await this.takeFromJob(session, completed, { parentTakeId: parent.takeId });
    session.takes.push(take);
    session.activeTakeId = take.takeId;
    session.workflow.currentStage = 'audition';
    await this.sessionStore.write(session);

    return { take: this.publicTake(take), session: this.publicSession(session) };
  }

  async setActiveTake(sessionId, takeId) {
    const session = await this.sessionStore.read(sessionId);
    const take = session.takes.find((t) => t.takeId === takeId);
    if (!take) throw new DeskError(CODES.TAKE_NOT_FOUND, `Take ${takeId} not found`);
    session.activeTakeId = takeId;
    await this.sessionStore.write(session);
    return { take: this.publicTake(take), session: this.publicSession(session) };
  }

  async rerollSeed(sessionId, takeId, seed = null) {
    const session = await this.sessionStore.read(sessionId);
    const parent = session.takes.find((t) => t.takeId === takeId);
    if (!parent) throw new DeskError(CODES.TAKE_NOT_FOUND, `Take ${takeId} not found`);

    const newSeed = seed !== null && seed !== undefined && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff
      ? seed
      : randomInt(0, 0xffffffff + 1);

    const score = structuredClone(parent.score);
    score.seed = newSeed;

    const { validateSpec } = await import('../spec.mjs');
    const artifact = validateSpec(score);

    const renderRequest = {
      score: artifact,
      custodyProfileId: 'hb-custody-render/1.0.0',
      outputs: { fullMix: true, stems: false, rpp: false },
      execution: { mode: 'async' },
    };
    const { job: renderJob, completion } = await this.apiService.submitRender(renderRequest);
    const job = await completion;
    if (!job || job.state !== 'succeeded') {
      throw new DeskError(CODES.RENDER_FAILED, job?.error?.message || 'Seed reroll render failed.');
    }

    const artifacts = await this.apiService.listArtifacts(job.jobId);
    const scoreArtifact = artifacts.find((a) => a.kind === 'score' && a.acceptance === 'accepted');
    const mixArtifact = artifacts.find((a) => a.kind === 'wav_mix' && a.acceptance === 'accepted');
    const manifestArtifact = artifacts.find((a) => a.kind === 'manifest' && a.acceptance === 'accepted');
    if (!scoreArtifact || !mixArtifact || !manifestArtifact) {
      throw new DeskError(CODES.RENDER_FAILED, 'Seed reroll job is missing required artifacts.');
    }

    const take = {
      takeId: randomUUID(),
      jobId: job.jobId,
      parentTakeId: parent.takeId,
      createdAt: nowIso(),
      prompt: session.prompt,
      brief: session.brief,
      score: artifact,
      scoreSha256: scoreArtifact.sha256,
      mixSha256: mixArtifact.sha256,
      manifestSha256: manifestArtifact.sha256,
      hasStems: false,
      hasRpp: false,
      model: parent.model,
    };
    session.takes.push(take);
    session.activeTakeId = take.takeId;
    await this.sessionStore.write(session);
    return { take: this.publicTake(take), session: this.publicSession(session) };
  }

  async exportBundle(sessionId, takeId, { stems = false, rpp = false } = {}) {
    const session = await this.sessionStore.read(sessionId);
    const take = session.takes.find((t) => t.takeId === takeId);
    if (!take) throw new DeskError(CODES.TAKE_NOT_FOUND, `Take ${takeId} not found`);

    if (take.score?.audition) throw new DeskError(CODES.EXPORT_FAILED, 'audition-only scores cannot be promoted through Desk export; retain the custody-marked listen packet');
    const needsRpp = rpp;
    const needsStems = stems || needsRpp;

    // If the take was not rendered with the requested outputs, render now.
    let job = take.jobId ? await this.apiService.getJob(take.jobId) : null;
    if (!job || job.state !== 'succeeded') {
      throw new DeskError(CODES.RENDER_FAILED, 'Take has no successful render job.');
    }

    const artifacts = await this.apiService.listArtifacts(job.jobId);
    const hasStems = artifacts.some((a) => a.kind === 'wav_stem');
    const hasRpp = artifacts.some((a) => a.kind === 'rpp');

    if ((needsStems && !hasStems) || (needsRpp && !hasRpp)) {
      const renderRequest = {
        score: take.score,
        custodyProfileId: 'hb-custody-render/1.0.0',
        outputs: { fullMix: true, stems: needsStems, rpp: needsRpp },
        execution: { mode: 'async' },
      };
      const { job: renderJob, completion } = await this.apiService.submitRender(renderRequest);
      job = await completion;
      if (!job || job.state !== 'succeeded') {
        throw new DeskError(CODES.RENDER_FAILED, job?.error?.message || 'Render failed.');
      }
    }

    const bundle = await this.buildBundle(session, take, job);
    session.exports.push({
      exportId: randomUUID(),
      takeId,
      exportedAt: nowIso(),
      stems,
      rpp,
      bundleSha256: bundle.sha256,
    });
    await this.sessionStore.write(session);
    return bundle;
  }

  async takeFromJob(session, job, { parentTakeId = null } = {}) {
    const artifacts = await this.apiService.listArtifacts(job.jobId);
    const scoreArtifact = artifacts.find((a) => a.kind === 'score' && a.acceptance === 'accepted');
    const manifestArtifact = artifacts.find((a) => a.kind === 'manifest' && a.acceptance === 'accepted');
    const mixArtifact = artifacts.find((a) => a.kind === 'wav_mix' && a.acceptance === 'accepted');
    if (!scoreArtifact || !manifestArtifact || !mixArtifact) {
      throw new DeskError(CODES.COMPOSITION_FAILED, 'Completed job is missing required artifacts.');
    }

    const scoreBytes = await this.apiService.getArtifact(job.jobId, scoreArtifact.artifactId);
    const score = JSON.parse(scoreBytes.bytes.toString('utf8'));

    return {
      takeId: randomUUID(),
      jobId: job.jobId,
      parentTakeId,
      createdAt: nowIso(),
      prompt: session.prompt,
      brief: session.brief,
      score,
      scoreSha256: scoreArtifact.sha256,
      mixSha256: mixArtifact.sha256,
      manifestSha256: manifestArtifact.sha256,
      hasStems: artifacts.some((a) => a.kind === 'wav_stem'),
      hasRpp: artifacts.some((a) => a.kind === 'rpp'),
      model: job.admission?.modelLaneId ?? session.profileId,
    };
  }

  listPacks() {
    return this.apiService.listPacks();
  }

  async getPackAsset(packId, assetId) {
    const packs = this.apiService.listPacks();
    const pack = packs.find((p) => p.packId === packId);
    if (!pack) throw new DeskError(CODES.PACK_MISSING, `Pack ${packId} is not installed`);
    const asset = pack.assets.find((a) => a.id === assetId);
    if (!asset) throw new DeskError(CODES.PACK_MISSING, `Asset ${assetId} not found in pack ${packId}`);
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const bytes = await readFile(resolve(pack.installed, asset.file));
    return { bytes, mediaType: 'audio/wav' };
  }

  async getTakeMix(sessionId, takeId) {
    const session = await this.sessionStore.read(sessionId);
    const take = session.takes.find((t) => t.takeId === takeId);
    if (!take) throw new DeskError(CODES.TAKE_NOT_FOUND, `Take ${takeId} not found`);
    if (!take.jobId) throw new DeskError(CODES.RENDER_FAILED, 'Take has no render job');
    const artifacts = await this.apiService.listArtifacts(take.jobId);
    const mixArtifact = artifacts.find((a) => a.kind === 'wav_mix' && a.acceptance === 'accepted');
    if (!mixArtifact) throw new DeskError(CODES.RENDER_FAILED, 'Take has no rendered mix');
    const mixBytes = await this.apiService.getArtifact(take.jobId, mixArtifact.artifactId);
    return { bytes: mixBytes.bytes, sha256: mixArtifact.sha256, mediaType: 'audio/wav' };
  }

  async applySuggestion(sessionId, takeId, { packId, manifestSha256, contentSha256, assetId, voice }) {
    const session = await this.sessionStore.read(sessionId);
    const parent = session.takes.find((t) => t.takeId === takeId);
    if (!parent) throw new DeskError(CODES.TAKE_NOT_FOUND, `Take ${takeId} not found`);

    const packs = this.apiService.listPacks();
    const pack = packs.find((p) => p.packId === packId);
    if (!pack) throw new DeskError(CODES.PACK_MISSING, `Pack ${packId} is not installed`);
    if (pack.manifestSha256 !== manifestSha256 || pack.contentSha256 !== contentSha256) {
      throw new DeskError(CODES.PACK_IDENTITY_MISMATCH, 'Pack identity does not match the installed snapshot');
    }
    const asset = pack.assets.find((a) => a.id === assetId);
    if (!asset) throw new DeskError(CODES.PACK_MISSING, `Asset ${assetId} not found in pack ${packId}`);
    if (!asset.allowedCanonicalLanes.includes(voice)) {
      throw new DeskError(CODES.INVALID_REQUEST, `Asset ${assetId} is not allowed for voice ${voice}`);
    }

    const score = structuredClone(parent.score);
    if (score.samplePack && (score.samplePack.manifestSha256 !== manifestSha256 || score.samplePack.contentSha256 !== contentSha256)) {
      throw new DeskError(CODES.PACK_IDENTITY_MISMATCH, 'A score can reference only one canonical pack at a time');
    }
    score.samplePack = {
      packId: pack.packId,
      formatVersion: pack.formatVersion,
      manifestSha256: pack.manifestSha256,
      contentSha256: pack.contentSha256,
    };
    score.sampleVoices ??= {};
    score.sampleVoices[voice] = {
      kind: 'one-shot',
      assetId: asset.id,
      pcmSha256: asset.pcmSha256,
      gain: 0.8,
    };

    const { validateSpec } = await import('../spec.mjs');
    const artifact = validateSpec(score);

    const renderRequest = {
      score: artifact,
      custodyProfileId: 'hb-custody-render/1.0.0',
      outputs: { fullMix: true, stems: false, rpp: false },
      execution: { mode: 'async' },
    };
    const { job: renderJob, completion } = await this.apiService.submitRender(renderRequest);
    const job = await completion;
    if (!job || job.state !== 'succeeded') {
      throw new DeskError(CODES.RENDER_FAILED, job?.error?.message || 'Sample suggestion render failed.');
    }

    const take = await this.takeFromJob(session, job, { parentTakeId: parent.takeId });
    take.changeSummary = `Applied ${asset.id} (${voice}) from ${pack.packId}`;
    session.takes.push(take);
    session.activeTakeId = take.takeId;
    await this.sessionStore.write(session);

    return { take: this.publicTake(take), session: this.publicSession(session) };
  }

  async buildBundle(session, take, job) {
    const artifacts = await this.apiService.listArtifacts(job.jobId);
    const entries = [];

    const scoreArtifact = artifacts.find((a) => a.kind === 'score' && a.acceptance === 'accepted');
    const scoreBytes = await this.apiService.getArtifact(job.jobId, scoreArtifact.artifactId);
    entries.push({ name: `${take.takeId}.spec.json`, data: scoreBytes.bytes });

    const brief = session.brief?.text ?? '';
    entries.push({ name: `${take.takeId}.brief.md`, data: Buffer.from(brief, 'utf8') });

    const mixArtifact = artifacts.find((a) => a.kind === 'wav_mix' && a.acceptance === 'accepted');
    const mixBytes = await this.apiService.getArtifact(job.jobId, mixArtifact.artifactId);
    entries.push({ name: 'mix.wav', data: mixBytes.bytes });

    const manifestArtifact = artifacts.find((a) => a.kind === 'manifest' && a.acceptance === 'accepted');
    const manifestBytes = await this.apiService.getArtifact(job.jobId, manifestArtifact.artifactId);
    entries.push({ name: `${take.takeId}.manifest.json`, data: manifestBytes.bytes });

    const stemArtifacts = artifacts.filter((a) => a.kind === 'wav_stem' && a.acceptance === 'accepted');
    for (const stem of stemArtifacts) {
      const stemBytes = await this.apiService.getArtifact(job.jobId, stem.artifactId);
      entries.push({ name: `stems/${stem.filename}`, data: stemBytes.bytes });
    }

    const rppArtifact = artifacts.find((a) => a.kind === 'rpp' && a.acceptance === 'accepted');
    if (rppArtifact) {
      const rppBytes = await this.apiService.getArtifact(job.jobId, rppArtifact.artifactId);
      entries.push({ name: 'project.rpp', data: rppBytes.bytes });
    }

    const zip = await this.encodeZip(entries);
    return {
      bytes: zip,
      filename: `house-band-${session.sessionId.slice(0, 8)}-${take.takeId.slice(0, 8)}.zip`,
      sha256: sha256(zip),
    };
  }

  async encodeZip(entries) {
    const { createZip } = await import('../../app/zip.mjs');
    return createZip(entries);
  }

  publicSession(session) {
    return Object.freeze({
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      prompt: session.prompt,
      weissEnabled: session.weissEnabled,
      profileId: session.profileId,
      brief: session.brief,
      takes: session.takes.map((t) => this.publicTake(t)),
      activeTakeId: session.activeTakeId,
      workflow: session.workflow,
      exportCount: session.exports.length,
    });
  }

  publicTake(take) {
    return Object.freeze({
      takeId: take.takeId,
      parentTakeId: take.parentTakeId,
      createdAt: take.createdAt,
      prompt: take.prompt,
      brief: take.brief,
      score: take.score,
      scoreSha256: take.scoreSha256,
      mixSha256: take.mixSha256,
      manifestSha256: take.manifestSha256,
      hasStems: take.hasStems,
      hasRpp: take.hasRpp,
      model: take.model,
    });
  }
}

export function createDeskService(env) {
  const profiles = buildProfiles(env);
  const profile = defaultProfile(profiles);
  const provider = profile ? createProvider(profile, env) : null;
  const weiss = new WeissCli(weissConfig({ env: { ...process.env, ...env } }));
  return new DeskService({ env, profiles, provider, weiss });
}
