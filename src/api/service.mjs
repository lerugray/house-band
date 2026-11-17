import { randomUUID } from 'node:crypto';

import { generateRpp } from '../../app/reaper.mjs';
import { canonicalJson, sha256 } from '../provenance.mjs';
import { renderSpecToWav } from '../render.mjs';
import { SpecError, specDuration, validateSpec, VOICES } from '../spec.mjs';
import { SAMPLE_PACK_FORMAT, SUPPORTED_SAMPLE_PACK_VERSIONS } from '../sample-pack.mjs';
import { KIT_VERSION, SCHEMA_VERSION, SUPPORTED_CURRENT_SCHEMAS, isCurrentKitVersion } from '../version.mjs';
import { ApiError, API_VERSION } from './errors.mjs';
import { parseJsonNoDuplicates } from './json.mjs';
import { custodyProfile, CUSTODY_PROFILE_ID, listenProfile, LISTEN_PROFILE_ID, requireCustodyProfile, requireListenProfile, listenAvailability } from './profile.mjs';
import { loadPackSidecar, PackRegistry, packCustodyIdentity } from './pack-registry.mjs';
import { derivativeError, renderDerivative, validateDerivativeRecipe } from './derivative.mjs';
import { DeterministicScoreProvider } from './provider.mjs';
import { normalizeRenderRequest, normalizeSongRequest } from './requests.mjs';
import { FileJobStore } from './store.mjs';
import { WeissRunner } from './weiss.mjs';
import { loadUserTimbres } from '../user-timbres-node.mjs';
import { userPackFormatVersion } from '../user-timbres.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const NEUTRAL_REGISTER = [
  '# House Band neutral register',
  '',
  'Use a clear pulse, moderate density, balanced dynamics, and the admitted canonical synthesis voices.',
  'Prefer legible contrasts between sections. Avoid genre, artist, project, or historical preset assumptions.',
  '',
].join('\n');

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function publicError(error, jobId, stage) {
  const apiError = error instanceof ApiError
    ? error
    : new ApiError('RENDER_FAILED', error?.message || 'operation failed', { stage, cause: error });
  return new ApiError(apiError.code, apiError.message, {
    retryable: apiError.retryable,
    stage: apiError.stage || stage,
    details: apiError.details,
    validationErrors: apiError.validationErrors,
    jobId,
    cause: error,
  });
}

function artifactBody(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function stableDiagnostics(error) {
  const message = error?.message || String(error);
  const path = message.match(/^(spec(?:\.[A-Za-z0-9_-]+|\[\d+\])*)/)?.[1] ?? '$';
  return Object.freeze([{ path, code: error?.name === 'DuplicateKeyError' ? 'DUPLICATE_KEY' : 'INVALID_SCORE', message }]);
}

function voicesInScore(score) {
  const found = new Set();
  for (const track of Object.values(score.tracks)) {
    for (const event of track.steps) found.add(event.voice ?? event.v);
  }
  return VOICES.filter((voice) => found.has(voice));
}

function baseComposerContract(admission, fixedRegister, brief) {
  const assetAllowlist = admission.pack
    ? admission.pack.resolvedAssets
      .filter((asset) => !admission.pack.assetAllowlist || admission.pack.assetAllowlist.includes(asset.id))
      .map((asset) => Object.freeze({
        assetId: asset.id,
        wavSha256: asset.wavSha256,
        pcmSha256: asset.pcmSha256,
        allowedCanonicalLanes: asset.allowedCanonicalLanes,
      }))
    : Object.freeze([]);
  return Object.freeze({
    promptTemplateRevision: 'hb-composer/1.2.0',
    task: 'Return one complete House Band score as a single JSON object.',
    scoreSchemaVersion: admission.scoreSchemaVersion,
    scoreContract: Object.freeze({
      strictUnknownFields: true,
      sampleRate: 44100,
      kitVersion: KIT_VERSION,
      register: fixedRegister,
      synthesisOnly: admission.pack === null,
      performance: Object.freeze({
        optional: true,
        humanize: Object.freeze({ timingMs: 'optional [min,max] milliseconds (-50..50)', velocity: 'optional [min,max] gain fractions (-1..1)', swing: 'optional 0..1 half-step delay fraction' }),
        releaseTail: 'optional 0..30 seconds added to pad/drone note releases',
        voices: 'optional per-canonical-voice humanize/releaseTail overrides; releaseTail only for pad/drone',
      }),
      output: 'one complete JSON object; no prose, Markdown, comments, or trailing data',
    }),
    canonicalVoiceAllowlist: admission.canonicalVoiceAllowlist,
    assetAllowlist,
    packIdentity: admission.pack ? admission.pack.identity : null,
    userPrompt: admission.prompt,
    registerBrief: brief,
    fixedRegister,
    duration: admission.duration,
    sections: admission.sections,
    seed: admission.seed,
  });
}

export function composerRequest(basePrompt, priorCandidate, diagnostics, attempt, maximum) {
  if (attempt === 1) return Object.freeze({ requestFormat: 'hb-composition-request/1.0.0', attempt, maximum, basePrompt });
  return Object.freeze({
    requestFormat: 'hb-composition-repair/1.0.0',
    attempt,
    maximum,
    basePrompt,
    completePriorRawCandidate: priorCandidate,
    orderedValidatorDiagnostics: diagnostics,
    admittedConstraints: Object.freeze({
      schemaVersion: basePrompt.scoreSchemaVersion,
      seed: basePrompt.seed,
      kitVersion: basePrompt.scoreContract.kitVersion,
      register: basePrompt.fixedRegister,
      duration: basePrompt.duration,
      sections: basePrompt.sections,
      packIdentity: basePrompt.packIdentity,
    }),
    outputRequirement: 'Return one complete replacement score JSON object only.',
  });
}

function validateCandidate(raw, admission, fixedRegister) {
  const parsed = parseJsonNoDuplicates(raw);
  const artifact = validateSpec(parsed);
  if (artifact.schemaVersion !== admission.scoreSchemaVersion) throw new SpecError('spec.schemaVersion: differs from admitted schema');
  if (artifact.seed !== admission.seed) throw new SpecError('spec.seed: differs from admitted seed');
  if (canonicalJson(artifact.kitVersion) !== canonicalJson(KIT_VERSION)) throw new SpecError('spec.kitVersion: differs from admitted kit');
  if (canonicalJson(artifact.register) !== canonicalJson(fixedRegister)) throw new SpecError('spec.register: differs from admitted immutable register');
  if (admission.pack) {
    if (artifact.samplePack === undefined || artifact.sampleVoices === undefined) throw new SpecError('spec: admitted pack requires samplePack and sampleVoices');
    const id = artifact.samplePack;
    if (id.packId !== admission.pack.identity.packId
      || id.formatVersion !== admission.pack.identity.formatVersion
      || id.manifestSha256 !== admission.pack.identity.manifestSha256
      || id.contentSha256 !== admission.pack.identity.contentSha256) {
      throw new SpecError('spec.samplePack: differs from admitted pack identity');
    }
    const allowedAssets = new Map();
    for (const asset of admission.pack.resolvedAssets) {
      if (admission.pack.assetAllowlist && !admission.pack.assetAllowlist.includes(asset.id)) continue;
      for (const lane of asset.allowedCanonicalLanes) allowedAssets.set(`${lane}:${asset.id}`, asset);
    }
    for (const [voice, binding] of Object.entries(artifact.sampleVoices)) {
      if (!admission.canonicalVoiceAllowlist.includes(voice)) throw new SpecError(`spec.sampleVoices.${voice}: voice is outside admitted canonicalVoiceAllowlist`);
      const key = `${voice}:${binding.assetId}`;
      const asset = allowedAssets.get(key);
      if (!asset) throw new SpecError(`spec.sampleVoices.${voice}: asset "${binding.assetId}" is not allowed for this voice`);
      if (binding.pcmSha256 !== asset.pcmSha256) throw new SpecError(`spec.sampleVoices.${voice}: PCM SHA-256 differs from admitted asset`);
    }
  } else {
    if (artifact.samplePack !== undefined || artifact.sampleVoices !== undefined) throw new SpecError('spec.samplePack: synthesis admission forbids sample fields');
  }
  for (const [trackName, track] of Object.entries(artifact.tracks)) {
    for (let index = 0; index < track.steps.length; index++) {
      const voice = track.steps[index].voice ?? track.steps[index].v;
      if (!admission.canonicalVoiceAllowlist.includes(voice)) throw new SpecError(`spec.tracks.${trackName}.steps[${index}].voice: outside admitted canonicalVoiceAllowlist`);
    }
  }
  if (admission.sections.length > 0) {
    if (artifact.sections.length !== admission.sections.length) throw new SpecError('spec.sections: count differs from admitted section constraints');
    admission.sections.forEach((requested, index) => {
      const actual = artifact.sections[index];
      if (actual.track !== requested.name) throw new SpecError(`spec.sections[${index}].track: differs from requested section name`);
      if (requested.bars !== undefined && actual.bars !== requested.bars) throw new SpecError(`spec.sections[${index}].bars: differs from requested bar count`);
    });
  }
  const bars = artifact.sections.reduce((total, section) => total + section.bars, 0);
  if (admission.duration.targetBars !== null && bars !== admission.duration.targetBars) throw new SpecError('spec.sections: total bars differ from admitted targetBars');
  if (admission.duration.secondsInterval) {
    const duration = specDuration(artifact);
    const [min, max] = admission.duration.secondsInterval;
    if (duration < min || duration > max) throw new SpecError(`spec.sections: musical duration ${duration} is outside admitted interval ${min}..${max}`);
  }
  return artifact;
}

export class HouseBandApiService {
  constructor({
    storeRoot,
    store = storeRoot ? new FileJobStore(storeRoot) : null,
    provider = new DeterministicScoreProvider(),
    packRegistry = null,
    weiss = null,
    clock = Date.now,
    jobId = randomUUID,
    requestId = randomUUID,
    runtime = process,
    maxValidationAttempts = 5,
    eventHistoryLimit = 1000,
    packEnv = process.env,
  } = {}) {
    if (!store) throw new Error('storeRoot or store is required');
    this.store = store;
    this.provider = provider;
    this.packRegistry = packRegistry;
    this.weiss = weiss && typeof weiss.generate === 'function' ? weiss : (weiss ? new WeissRunner(weiss) : null);
    this.clock = clock;
    this.jobId = jobId;
    this.requestId = requestId;
    this.runtime = runtime;
    this.maxValidationAttempts = maxValidationAttempts;
    this.eventHistoryLimit = eventHistoryLimit;
    // OSS-13: where `user:` kits and patches are looked up (HOUSE_BAND_PACKS, src/user-timbres-node.mjs).
    this.packEnv = packEnv;
    this.running = new Map();
  }

  async init() {
    await this.store.init();
    if (!this.packRegistry) {
      this.packRegistry = await new PackRegistry().init();
    }
    return this;
  }

  setProvider(provider) {
    this.provider = provider;
  }

  health() {
    const profile = custodyProfile();
    let custodyRendererAvailable = true;
    try { requireCustodyProfile(profile, this.runtime); } catch { custodyRendererAvailable = false; }
    const listenRendererAvailable = listenAvailability(listenProfile(SCHEMA_VERSION, false, this.runtime), this.runtime).available;
    return Object.freeze({
      status: custodyRendererAvailable ? 'ok' : 'degraded',
      apiVersion: API_VERSION,
      validatorAvailable: true,
      custodyRendererAvailable,
      listenRendererAvailable,
      listenProfileId: LISTEN_PROFILE_ID,
      defaultModelLane: this.provider.laneId,
      weissAvailable: this.weiss ? this.weiss.available() : false,
      packRegistryAvailable: this.packRegistry.list().length > 0,
      custodyStoreAvailable: true,
    });
  }

  capabilities() {
    const packs = this.packRegistry.list();
    return Object.freeze({
      apiVersion: API_VERSION,
      supportedScoreSchemaVersions: SUPPORTED_CURRENT_SCHEMAS,
      defaultScoreSchemaVersion: SCHEMA_VERSION,
      compatibilityMatrix: Object.freeze([
        Object.freeze({ scoreSchemaVersion: SCHEMA_VERSION, capability: 'synthesis', kit: KIT_VERSION, custodyProfileId: CUSTODY_PROFILE_ID, packRequirement: null }),
        Object.freeze({
          scoreSchemaVersion: SCHEMA_VERSION,
          capability: 'M3 one-shot samples on canonical kick/snare/hat lanes, with optional synthesis',
          kit: KIT_VERSION,
          custodyProfileId: CUSTODY_PROFILE_ID,
          packRequirement: Object.freeze({ format: SAMPLE_PACK_FORMAT, formatVersion: SUPPORTED_SAMPLE_PACK_VERSIONS }),
        }),
      ]),
      custodyRenderProfiles: Object.freeze([custodyProfile()]),
      listenRenderProfiles: Object.freeze([listenProfile(SCHEMA_VERSION, false, this.runtime)]),
      renderer: Object.freeze({ fullMix: true, stems: true, rpp: true, derivatives: true }),
      compositionLanes: Object.freeze([Object.freeze({
        laneId: this.provider.laneId,
        model: this.provider.model,
        maxValidationAttempts: this.maxValidationAttempts,
        maxTransportAttempts: this.provider.maxTransportAttempts,
        selection: 'composition.modelLaneId must exactly match a configured lane; the deterministic test double is selected by default when no real lane is configured',
      })]),
      registerSources: Object.freeze(['supplied', ...(this.weiss?.available() ? ['command', 'weiss'] : []), 'neutral']),
      packs: Object.freeze({
        supported: true,
        installed: packs.map((pack) => Object.freeze({ packId: pack.packId, formatVersion: pack.formatVersion, manifestSha256: pack.manifestSha256, contentSha256: pack.contentSha256 })),
        link: '/v1/packs',
      }),
      deferred: Object.freeze(
        this.provider instanceof DeterministicScoreProvider
          ? [Object.freeze({ feature: 'real model transport', reason: 'deferred beyond API tranche 3' })]
          : [],
      ),
    });
  }

  listPacks() {
    return this.packRegistry.list();
  }

  async newJob(type) {
    const timestamp = nowIso(this.clock);
    const job = {
      jobId: this.jobId(),
      type,
      state: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      progress: 0,
      currentStage: 'queued',
      validationCandidateCount: 0,
      transportCallCount: 0,
      error: null,
      artifacts: [],
      provenanceSummary: null,
      admission: null,
      stageTimestamps: { queued: timestamp },
    };
    await this.store.writeJob(job);
    return job;
  }

  async transition(job, state, progress) {
    if (TERMINAL.has(job.state)) return false;
    job.state = state;
    job.currentStage = state;
    job.progress = progress;
    job.updatedAt = nowIso(this.clock);
    job.stageTimestamps[state] ??= job.updatedAt;
    await this.store.writeJob(job);
    return true;
  }

  async fail(job, error) {
    if (TERMINAL.has(job.state)) return job;
    const failure = publicError(error, job.jobId, job.currentStage);
    job.error = failure.envelope().error;
    await this.transition(job, 'failed', 1);
    return job;
  }

  async emitEvent(job, event, data = {}) {
    const events = await this.store.readEvents(job.jobId);
    const id = events.length > 0 ? events[events.length - 1].id + 1 : 1;
    const persisted = Object.freeze({
      id,
      event,
      data: Object.freeze(data),
      timestamp: nowIso(this.clock),
    });
    await this.store.appendEvent(job.jobId, persisted);
    return persisted;
  }

  async eventStream(jobId, cursor = 0) {
    const job = await this.store.readJob(jobId);
    const events = await this.store.readEvents(jobId);
    const startIndex = events.findIndex((event) => event.id > cursor);
    if (cursor > 0 && (startIndex === -1 || (startIndex > 0 && events[startIndex - 1].id !== cursor))) {
      throw new ApiError('EVENT_CURSOR_EXPIRED', 'requested SSE history can no longer be replayed contiguously', {
        details: { jobId, cursor, earliestAvailable: events.length > 0 ? events[0].id : null },
      });
    }
    const terminalEvents = new Set(['job_succeeded', 'job_failed', 'job_canceled']);
    return Object.freeze({
      job,
      events,
      startFrom: startIndex === -1 ? events.length : startIndex,
      terminal: terminalEvents.has(job.currentStage) || terminalEvents.has(job.state),
    });
  }

  track(job, work) {
    const promise = (async () => {
      try {
        await work();
      } catch (error) {
        await this.fail(job, error);
      } finally {
        this.running.delete(job.jobId);
      }
      return this.store.readJob(job.jobId);
    })();
    this.running.set(job.jobId, promise);
    return promise;
  }

  async waitForJob(jobId, timeoutMs) {
    const running = this.running.get(jobId);
    if (!running) return this.store.readJob(jobId);
    if (!timeoutMs) return running;
    let timer;
    try {
      return await Promise.race([
        running,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async resolvePackAdmission(packRequest, stage) {
    if (!packRequest) return null;
    let resolved;
    try {
      resolved = this.packRegistry.resolve(packRequest.identity);
    } catch (error) {
      if (packRequest.policy === 'preferred' && error.code === 'PACK_MISSING') {
        return Object.freeze({ fallback: true, requestedIdentity: packRequest.identity, policy: 'preferred' });
      }
      if (error instanceof ApiError) {
        throw new ApiError(error.code, error.message, {
          retryable: error.retryable,
          stage,
          details: error.details,
        });
      }
      throw error;
    }
    const assets = resolved.pack.manifest.assets.map((asset) => Object.freeze({
      id: asset.id,
      wavSha256: asset.wavSha256,
      pcmSha256: asset.pcmSha256,
      allowedCanonicalLanes: Object.freeze([asset.suggestedVoice]),
      file: asset.file,
    }));
    if (packRequest.assetAllowlist) {
      const allowed = new Set(packRequest.assetAllowlist);
      const missing = packRequest.assetAllowlist.filter((id) => !assets.some((asset) => asset.id === id));
      if (missing.length > 0) {
        throw new ApiError('PACK_IDENTITY_MISMATCH', 'assetAllowlist references assets not present in the resolved pack', {
          stage,
          details: { missing },
        });
      }
      const filtered = assets.filter((asset) => allowed.has(asset.id));
      return Object.freeze({ ...packRequest, resolvedAssets: filtered, snapshotPath: resolved.snapshotPath });
    }
    return Object.freeze({ ...packRequest, resolvedAssets: assets, snapshotPath: resolved.snapshotPath });
  }

  async submitSong(value, requestBytes = artifactBody(value)) {
    const admission = normalizeSongRequest(value, {
      maxValidationAttempts: this.maxValidationAttempts,
      modelLaneId: this.provider.laneId,
    });
    const resolvedPack = await this.resolvePackAdmission(admission.pack, 'admitting');
    let packFallback = null;
    let finalPack = resolvedPack;
    if (resolvedPack && resolvedPack.fallback) {
      packFallback = resolvedPack;
      finalPack = null;
    }
    const finalAdmission = Object.freeze({
      ...admission,
      pack: finalPack,
      packFallback,
      compatibility: finalPack === null
        ? Object.freeze({
          scoreSchemaVersion: admission.scoreSchemaVersion,
          capability: 'synthesis',
          kit: KIT_VERSION,
          ...(admission.renderProfileId === LISTEN_PROFILE_ID ? { listenProfileId: LISTEN_PROFILE_ID } : { custodyProfileId: CUSTODY_PROFILE_ID }),
          packRequirement: null,
        })
        : admission.compatibility,
    });
    const job = await this.newJob('prompt_to_song');
    job.admission = finalAdmission;
    await this.store.writeJob(job);
    const completion = this.track(job, () => this.runSong(job, finalAdmission, requestBytes));
    return Object.freeze({ job, completion, execution: finalAdmission.execution });
  }

  async runSong(job, admission, requestBytes) {
    await this.store.writeArtifact(job, { kind: 'request', filename: 'request.json', mediaType: 'application/json', acceptance: 'accepted', data: requestBytes });
    await this.transition(job, 'admitting', 0.08);
    await this.emitEvent(job, 'job_started', { type: job.type, state: job.state });
    const listen = admission.renderProfileId === LISTEN_PROFILE_ID;
    if (listen && admission.pack) {
      throw new ApiError('TOOLCHAIN_UNAVAILABLE', 'the listen render profile does not render sample packs', { stage: 'admitting', details: { listenProfileId: LISTEN_PROFILE_ID } });
    }
    const profile = listen
      ? requireListenProfile(listenProfile(admission.scoreSchemaVersion, false, this.runtime), this.runtime)
      : requireCustodyProfile(custodyProfile(admission.scoreSchemaVersion, admission.pack?.identity?.formatVersion ?? false), this.runtime);
    job.admission = Object.freeze({ ...admission, ...(listen ? { listenProfile: profile } : { custodyProfile: profile }) });
    await this.store.writeJob(job);
    await this.emitEvent(job, 'admission_completed', {
      scoreSchemaVersion: admission.scoreSchemaVersion,
      seed: admission.seed,
      modelLaneId: admission.composition.modelLaneId,
      ...(listen ? { listenProfileId: profile.id } : { custodyProfileId: profile.id }),
      packResolved: admission.pack !== null,
      packFallback: admission.packFallback ?? null,
    });

    await this.transition(job, 'resolving_register', 0.15);
    let brief;
    let weissMeta = null;
    if (admission.register.source === 'weiss') {
      const result = await this.runWeiss(job, admission);
      if (result.success) {
        brief = result.stdout;
        weissMeta = result;
      } else if (admission.register.allowNeutralFallback) {
        brief = NEUTRAL_REGISTER;
        weissMeta = { ...result, fallback: true };
      } else {
        throw new ApiError('WEISS_FAILED', 'Weiss register execution failed', {
          stage: 'resolving_register',
          details: { profile: result.profile, executable: result.executable, exitStatus: result.exitStatus, timedOut: result.timedOut },
        });
      }
    } else if (admission.register.source === 'supplied') {
      brief = admission.register.brief;
    } else {
      brief = NEUTRAL_REGISTER;
    }
    const registerSha256 = sha256(Buffer.from(brief, 'utf8'));
    const fixedRegister = Object.freeze({
      name: `r-${registerSha256.slice(0, 62)}`,
      briefRef: `docs/generated-registers/${registerSha256}.md`,
    });
    await this.store.writeArtifact(job, { kind: 'register', filename: fixedRegister.briefRef, mediaType: 'text/markdown; charset=utf-8', acceptance: 'accepted', data: brief });
    await this.emitEvent(job, 'register_resolved', { source: admission.register.source, registerName: fixedRegister.name, briefRef: fixedRegister.briefRef });

    await this.transition(job, 'composing', 0.25);
    const basePrompt = baseComposerContract(admission, fixedRegister, brief);
    const artifact = await this.compose(job, admission, fixedRegister, basePrompt);
    const scoreBytes = artifactBody(artifact);
    const scoreArtifact = await this.store.writeArtifact(job, { kind: 'score', filename: 'score.json', mediaType: 'application/json', acceptance: 'accepted', canonicalSongIdentity: true, data: scoreBytes });

    await this.transition(job, 'rendering', 0.62);
    const rendered = await this.renderAccepted(job, artifact, admission.render, profile, null, admission.pack);
    await this.transition(job, 'packaging', 0.9);
    await this.writeProvenance(job, {
      prompt: admission.prompt,
      modelLane: this.provider.laneId,
      model: this.provider.model,
      promptTemplateRevision: basePrompt.promptTemplateRevision,
      scoreArtifact,
      profile,
      rendered,
      register: { ...fixedRegister, sha256: registerSha256 },
      pack: admission.pack,
      packFallback: admission.packFallback,
      weiss: weissMeta,
    });
    await this.emitEvent(job, 'job_succeeded', { artifactSha256: scoreArtifact.sha256 });
    await this.transition(job, 'succeeded', 1);
  }

  async compose(job, admission, fixedRegister, basePrompt) {
    const maximumCandidates = admission.composition.maxValidationAttempts;
    const maximumCalls = this.provider.maxTransportAttempts ?? 1;
    const deadline = this.clock() + (this.provider.totalDeadlineMs ?? 30_000);
    const pendingResponses = [];
    let priorCandidate = null;
    let diagnostics = Object.freeze([]);
    await this.emitEvent(job, 'composition_transport_started', { maximumCandidates, maximumCalls, deadline });
    while (job.validationCandidateCount < maximumCandidates && job.transportCallCount < maximumCalls) {
      if (this.clock() >= deadline) throw new ApiError('COMPOSITION_DEADLINE_EXCEEDED', 'composition deadline elapsed', { retryable: true, stage: 'composing' });
      const attempt = job.validationCandidateCount + 1;
      const request = composerRequest(basePrompt, priorCandidate, diagnostics, attempt, maximumCandidates);
      const requestId = this.requestId();
      await this.store.writeArtifact(job, {
        kind: 'composition_request', filename: `composition-request-${String(job.transportCallCount + 1).padStart(2, '0')}.json`,
        mediaType: 'application/json', acceptance: 'attempt', data: artifactBody({ requestId, ...request }),
      });
      job.transportCallCount++;
      await this.store.writeJob(job);

      let raw;
      try {
        raw = await this.providerCall({ requestId, request, admission, fixedRegister, job, deadline, pendingResponses });
      } catch (error) {
        await this.emitEvent(job, 'composition_transport_failed', { requestId, errorCode: error instanceof ApiError ? error.code : 'RENDER_FAILED' });
        if (error?.code === 'COMPOSITION_DEADLINE_EXCEEDED') throw error;
        if (job.transportCallCount >= maximumCalls) {
          throw new ApiError('MODEL_LANE_UNAVAILABLE', 'composition provider transport attempts were exhausted', {
            retryable: true, stage: 'composing', details: { transportCallCount: job.transportCallCount }, cause: error,
          });
        }
        continue;
      }
      if (typeof raw !== 'string') raw = Buffer.from(raw).toString('utf8');
      await this.emitEvent(job, 'composition_candidate_received', { requestId, validationCandidate: job.validationCandidateCount + 1 });
      await this.store.writeArtifact(job, {
        kind: 'composition_response', filename: `composition-response-${String(job.transportCallCount).padStart(2, '0')}.txt`,
        mediaType: 'text/plain; charset=utf-8', acceptance: 'attempt', data: raw,
      });
      job.validationCandidateCount++;
      await this.transition(job, 'validating', 0.25 + (0.3 * job.validationCandidateCount / maximumCandidates));
      try {
        const artifact = validateCandidate(raw, admission, fixedRegister);
        const report = Object.freeze({
          reportFormat: 'hb-validation-report/1.0.0', valid: true, scoreSchemaVersion: artifact.schemaVersion,
          validationCandidateCount: job.validationCandidateCount, diagnostics: Object.freeze([]),
          artifactSha256: sha256(artifactBody(artifact)),
        });
        await this.store.writeArtifact(job, { kind: 'validation_report', filename: 'validation-report.json', mediaType: 'application/json', acceptance: 'accepted', data: artifactBody(report) });
        await this.emitEvent(job, 'composition_validated', { validationCandidate: job.validationCandidateCount, artifactSha256: report.artifactSha256 });
        await this.settleProviderResponses(pendingResponses, deadline);
        return artifact;
      } catch (error) {
        await this.emitEvent(job, 'composition_attempt_failed_validation', { validationCandidate: job.validationCandidateCount, errorCode: error instanceof ApiError ? error.code : 'INVALID_SCORE' });
        diagnostics = stableDiagnostics(error);
        priorCandidate = raw;
        const report = Object.freeze({
          reportFormat: 'hb-validation-report/1.0.0', valid: false,
          validationCandidate: job.validationCandidateCount, diagnostics,
        });
        await this.store.writeArtifact(job, {
          kind: 'validation_report', filename: `validation-report-attempt-${job.validationCandidateCount}.json`,
          mediaType: 'application/json', acceptance: 'attempt', data: artifactBody(report),
        });
        await this.transition(job, 'composing', 0.25 + (0.3 * job.validationCandidateCount / maximumCandidates));
      }
    }
    throw new ApiError('COMPOSITION_INVALID_AFTER_RETRIES', 'all validation candidates were rejected', {
      stage: 'validating', validationErrors: diagnostics,
      details: { validationCandidateCount: job.validationCandidateCount, transportCallCount: job.transportCallCount },
    });
  }

  async providerCall(context) {
    const remaining = context.deadline - this.clock();
    if (remaining <= 0) throw new ApiError('COMPOSITION_DEADLINE_EXCEEDED', 'composition deadline elapsed', { retryable: true, stage: 'composing' });
    const timeoutMs = Math.min(this.provider.callTimeoutMs ?? remaining, remaining);
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const call = Promise.resolve().then(() => this.provider.generate({ ...context, signal: controller.signal }));
    const retained = call.then(async (late) => {
      if (!timedOut) return;
      const raw = typeof late === 'string' ? late : Buffer.from(late).toString('utf8');
      await this.store.writeArtifact(context.job, {
        kind: 'composition_response',
        filename: `composition-response-late-${context.requestId}.txt`,
        mediaType: 'text/plain; charset=utf-8',
        acceptance: 'attempt',
        data: raw,
      });
    }, () => {});
    context.pendingResponses.push(retained);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ApiError('MODEL_LANE_UNAVAILABLE', 'composition provider call timed out', { retryable: true, stage: 'composing', details: { requestId: context.requestId, timeoutMs } }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async settleProviderResponses(pendingResponses, deadline) {
    const remaining = deadline - this.clock();
    if (remaining <= 0) throw new ApiError('COMPOSITION_DEADLINE_EXCEEDED', 'composition deadline elapsed while closing timed-out provider calls', { retryable: true, stage: 'composing' });
    let timer;
    try {
      const settled = await Promise.race([
        Promise.all(pendingResponses).then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
      ]);
      if (!settled) throw new ApiError('COMPOSITION_DEADLINE_EXCEEDED', 'composition deadline elapsed while closing timed-out provider calls', { retryable: true, stage: 'composing' });
    } finally {
      clearTimeout(timer);
    }
  }

  async submitRender(value, requestBytes = artifactBody(value)) {
    const admission = normalizeRenderRequest(value);
    const job = await this.newJob('render_score');
    const { score: _score, ...persistedAdmission } = admission;
    job.admission = persistedAdmission;
    await this.store.writeJob(job);
    const completion = this.track(job, () => this.runRender(job, admission, requestBytes));
    return Object.freeze({ job, completion, execution: admission.execution });
  }

  validateScoreRequest(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('INVALID_REQUEST', 'request must be an object');
    const allowed = new Set(['score', 'expectedSchemaVersion', 'exactPackIdentity']);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ApiError('INVALID_REQUEST', `request.${key} is an unsupported field`, { details: { field: `request.${key}` } });
    if (value.score === null || typeof value.score !== 'object' || Array.isArray(value.score)) throw new ApiError('INVALID_REQUEST', 'score is required and must be an object');
    if (value.expectedSchemaVersion !== undefined && !SUPPORTED_CURRENT_SCHEMAS.includes(value.expectedSchemaVersion)) {
      throw new ApiError('UNSUPPORTED_SCORE_SCHEMA', `score schema ${value.expectedSchemaVersion} is not supported`, { details: { supported: SUPPORTED_CURRENT_SCHEMAS } });
    }
    const scoreHasPack = value.score.samplePack !== undefined || value.score.sampleVoices !== undefined;
    let resolvedPack = null;
    if (scoreHasPack) {
      const identity = value.exactPackIdentity ?? value.score.samplePack;
      if (!identity) throw new ApiError('PACK_MISSING', 'sample-backed score requires an exact pack identity', { details: { field: 'exactPackIdentity' } });
      resolvedPack = this.packRegistry.resolve(identity);
      if (value.exactPackIdentity && value.score.samplePack) {
        const ref = value.score.samplePack;
        const req = value.exactPackIdentity;
        if (ref.packId !== req.packId || ref.formatVersion !== req.formatVersion
          || ref.manifestSha256 !== req.manifestSha256 || ref.contentSha256 !== req.contentSha256) {
          throw new ApiError('PACK_IDENTITY_MISMATCH', 'exactPackIdentity does not match score.samplePack', { details: { exactPackIdentity: req, samplePack: ref } });
        }
      }
    }
    const artifactSha256 = sha256(artifactBody(value.score));
    try {
      const artifact = validateSpec(value.score, { userTimbres: loadUserTimbres(value.score, this.packEnv) });
      if (!SUPPORTED_CURRENT_SCHEMAS.includes(artifact.schemaVersion)) throw new SpecError(`spec.schemaVersion: requires ${SCHEMA_VERSION}`);
      if (value.expectedSchemaVersion !== undefined && artifact.schemaVersion !== value.expectedSchemaVersion) throw new SpecError('spec.schemaVersion: differs from expectedSchemaVersion');
      if (scoreHasPack) {
        const packArg = resolvedPack.pack;
        const expected = artifact.samplePack;
        if (expected.packId !== packArg.manifest.packId
          || expected.formatVersion !== packArg.manifest.formatVersion
          || expected.manifestSha256 !== packArg.manifest.manifestSha256
          || expected.contentSha256 !== packArg.manifest.contentSha256) {
          throw new SpecError('spec.samplePack: identity does not match resolved pack');
        }
        for (const [voice, binding] of Object.entries(artifact.sampleVoices)) {
          const asset = packArg.assets[binding.assetId];
          if (!asset) throw new SpecError(`spec.sampleVoices.${voice}: asset "${binding.assetId}" not found in pack`);
          if (asset.metadata.pcmSha256 !== binding.pcmSha256) throw new SpecError(`spec.sampleVoices.${voice}: PCM SHA-256 mismatch`);
          if (asset.metadata.suggestedVoice !== voice) throw new SpecError(`spec.sampleVoices.${voice}: asset is declared for ${asset.metadata.suggestedVoice}`);
        }
      }
      return Object.freeze({
        valid: true,
        scoreSchemaVersion: artifact.schemaVersion,
        errors: Object.freeze([]),
        warnings: Object.freeze([]),
        artifactSha256,
        canonicalScore: artifact,
      });
    } catch (error) {
      return Object.freeze({
        valid: false,
        scoreSchemaVersion: value.score.schemaVersion ?? null,
        errors: stableDiagnostics(error),
        warnings: Object.freeze([]),
        artifactSha256,
      });
    }
  }

  async runRender(job, admission, requestBytes) {
    await this.store.writeArtifact(job, { kind: 'request', filename: 'request.json', mediaType: 'application/json', acceptance: 'accepted', data: requestBytes });
    await this.transition(job, 'admitting', 0.15);
    await this.emitEvent(job, 'job_started', { type: job.type, state: job.state });
    if (admission.custodyProfileId !== CUSTODY_PROFILE_ID) {
      throw new ApiError('TOOLCHAIN_UNAVAILABLE', `custody profile ${admission.custodyProfileId} is unavailable`, {
        stage: 'admitting', details: { requested: admission.custodyProfileId, supported: [CUSTODY_PROFILE_ID] },
      });
    }
    let profile = null;
    let expected = null;
    let resolvedPack = null;
    if (admission.sourceJobId) {
      const source = await this.store.readJob(admission.sourceJobId);
      if (source.state !== 'succeeded') throw new ApiError('INVALID_REQUEST', 'sourceJobId must identify a succeeded accepted job', { stage: 'admitting', details: { sourceJobId: admission.sourceJobId, state: source.state } });
      const savedScore = await this.store.readArtifactByKind(source.jobId, 'score');
      if (sha256(artifactBody(admission.score)) !== savedScore.artifact.sha256) throw new ApiError('INVALID_REQUEST', 'supplied score does not equal the source job canonical score', { stage: 'admitting', details: { sourceJobId: source.jobId, expectedArtifactSha256: savedScore.artifact.sha256 } });
      if (source.admission?.renderProfileId === LISTEN_PROFILE_ID || source.admission?.listenProfile) {
        throw new ApiError('TOOLCHAIN_UNAVAILABLE', 'a listen render is not a custody receipt and cannot be the source of a custody render', { stage: 'admitting', details: { sourceJobId: source.jobId, listenProfileId: LISTEN_PROFILE_ID } });
      }
      profile = source.admission?.custodyProfile;
      if (!profile) throw new ApiError('TOOLCHAIN_UNAVAILABLE', 'source job has no retained historical custody profile', { stage: 'admitting', details: { sourceJobId: source.jobId } });
      expected = source;
      resolvedPack = source.admission?.pack ?? null;
    }
    if (admission.score.samplePack || admission.score.sampleVoices) {
      const identity = {
        format: SAMPLE_PACK_FORMAT,
        formatVersion: admission.score.samplePack.formatVersion,
        packId: admission.score.samplePack.packId,
        manifestSha256: admission.score.samplePack.manifestSha256,
        contentSha256: admission.score.samplePack.contentSha256,
      };
      resolvedPack = await this.resolvePackAdmission(admission.packCustodyRef ?? { identity, policy: 'required', assetAllowlist: null }, 'admitting');
    }
    // OSS-13: user kits and patches load before validation, and a score that uses them gets the custody profile of
    // a sample-backed score (its user pack's format version), not the synthesis-only one.
    const userTimbres = loadUserTimbres(admission.score, this.packEnv);
    if (!profile) profile = custodyProfile(admission.score.schemaVersion, resolvedPack?.identity?.formatVersion ?? userPackFormatVersion(userTimbres) ?? false);
    requireCustodyProfile(profile, this.runtime);
    let artifact;
    try {
      artifact = validateSpec(admission.score, { userTimbres });
    } catch (cause) {
      throw new ApiError('INVALID_REQUEST', 'score failed strict validation', { stage: 'admitting', validationErrors: stableDiagnostics(cause), cause });
    }
    if (!isCurrentKitVersion(artifact.kitVersion)) throw new ApiError('TOOLCHAIN_UNAVAILABLE', 'historical score requires its frozen renderer or an explicit audition rebase; current API custody cannot relabel it', { stage: 'admitting' });
    if (!SUPPORTED_CURRENT_SCHEMAS.includes(artifact.schemaVersion)) throw new ApiError('UNSUPPORTED_SCORE_SCHEMA', `score schema ${artifact.schemaVersion} is not supported by tranche 1`, { stage: 'admitting', details: { supported: SUPPORTED_CURRENT_SCHEMAS } });
    const scoreArtifact = await this.store.writeArtifact(job, { kind: 'score', filename: 'score.json', mediaType: 'application/json', acceptance: 'accepted', canonicalSongIdentity: true, data: artifactBody(artifact) });
    job.admission = Object.freeze({ ...job.admission, scoreSchemaVersion: artifact.schemaVersion, seed: artifact.seed, artifactSha256: scoreArtifact.sha256, custodyProfile: profile, pack: resolvedPack });
    await this.store.writeJob(job);
    await this.transition(job, 'rendering', 0.45);
    const rendered = await this.renderAccepted(job, artifact, admission.outputs, profile, expected, resolvedPack, admission.derivativeRecipe);
    await this.transition(job, 'packaging', 0.9);
    await this.writeProvenance(job, { prompt: null, modelLane: null, model: null, promptTemplateRevision: null, scoreArtifact, profile, rendered, register: artifact.register, pack: resolvedPack, derivatives: rendered.derivatives });
    await this.emitEvent(job, 'job_succeeded', { artifactSha256: scoreArtifact.sha256 });
    await this.transition(job, 'succeeded', 1);
  }

  async renderAccepted(job, artifact, outputs, profile, expectedJob = null, pack = null, derivativeRecipe = null) {
    if (artifact.audition && outputs.rpp) throw new ApiError('INVALID_REQUEST', 'audition-only scores cannot be promoted through RPP export', { stage: 'rendering' });
    await this.emitEvent(job, 'render_started', { fullMix: true, stems: outputs.stems, rpp: outputs.rpp });
    let mix;
    const packArg = pack ? (await this.packRegistry.resolve(pack.identity)).pack : null;
    try {
      mix = await renderSpecToWav(artifact, packArg ? { samplePack: packArg } : {});
    } catch (cause) {
      throw new ApiError('RENDER_FAILED', 'custody renderer failed to produce the full mix', { stage: 'rendering', cause });
    }
    const mixArtifact = await this.store.writeArtifact(job, { kind: 'wav_mix', filename: 'mix.wav', mediaType: 'audio/wav', acceptance: 'accepted', data: mix.wav });
    const stems = [];
    if (outputs.stems) {
      for (const voice of voicesInScore(artifact)) {
        await this.emitEvent(job, 'stem_render_started', { voice });
        let stem;
        try {
          stem = await renderSpecToWav(artifact, packArg ? { voice, samplePack: packArg } : { voice });
        } catch (cause) {
          throw new ApiError('RENDER_FAILED', `custody renderer failed to produce the ${voice} stem`, { stage: 'rendering', details: { voice }, cause });
        }
        if (stem.manifest.render.frames !== mix.manifest.render.frames) throw new ApiError('RENDER_FAILED', `stem ${voice} is not sample-aligned with the full mix`, { stage: 'rendering', details: { voice } });
        const metadata = await this.store.writeArtifact(job, { kind: 'wav_stem', filename: `stem-${voice}.wav`, mediaType: 'audio/wav', acceptance: 'accepted', data: stem.wav });
        stems.push(Object.freeze({ voice, artifact: metadata, frames: stem.manifest.render.frames }));
      }
    }
    let rppArtifact = null;
    if (outputs.rpp) {
      if (stems.length === 0) throw new ApiError('INVALID_REQUEST', 'RPP output requires stems', { stage: 'rendering' });
      const rpp = generateRpp(artifact, stems.map((stem) => ({ voice: stem.voice, filename: stem.artifact.filename })), {
        frames: mix.manifest.render.frames,
        sampleRate: mix.manifest.render.sampleRate,
      });
      rppArtifact = await this.store.writeArtifact(job, { kind: 'rpp', filename: 'project.rpp', mediaType: 'text/plain; charset=utf-8', acceptance: 'accepted', data: rpp });
      await this.emitEvent(job, 'rpp_generated', { sha256: rppArtifact.sha256 });
    }
    let derivatives = null;
    if (derivativeRecipe) {
      const recipe = validateDerivativeRecipe(derivativeRecipe, sha256(artifactBody(artifact)));
      const recipeBytes = artifactBody(recipe);
      const recipeArtifact = await this.store.writeArtifact(job, { kind: 'derivative_recipe', filename: 'derivative-recipe.json', mediaType: 'application/json', acceptance: 'derivative', data: recipeBytes });
      await this.emitEvent(job, 'artifact_written', { kind: 'derivative_recipe', artifactId: recipeArtifact.artifactId, sha256: recipeArtifact.sha256 });
      let derivative;
      try {
        derivative = await renderDerivative(artifact, recipe, packArg, mix.wav);
      } catch (cause) {
        throw derivativeError(cause);
      }
      const derivativeArtifact = await this.store.writeArtifact(job, { kind: 'wav_derivative', filename: 'derivative-mix.wav', mediaType: 'audio/wav', acceptance: 'derivative', data: derivative.wav });
      await this.emitEvent(job, 'artifact_written', { kind: 'wav_derivative', artifactId: derivativeArtifact.artifactId, sha256: derivativeArtifact.sha256 });
      derivatives = Object.freeze({
        recipe: recipeArtifact,
        output: derivativeArtifact,
        outputDescriptor: derivative.output,
      });
    }
    const packCustody = pack ? await this.writePackSidecar(job, pack) : null;
    if (expectedJob) await this.compareReplay(expectedJob, mixArtifact, stems);
    const m3 = pack ? Object.freeze({
      ...packCustody.identity,
      referencedAssets: Object.freeze(Object.entries(artifact.sampleVoices).map(([voice, binding]) => Object.freeze({
        voice,
        assetId: binding.assetId,
        wavSha256: pack.resolvedAssets.find((asset) => asset.id === binding.assetId).wavSha256,
        pcmSha256: binding.pcmSha256,
      }))),
    }) : null;
    const manifest = Object.freeze({
      manifestFormatVersion: '1.0.0',
      apiVersion: API_VERSION,
      jobId: job.jobId,
      createdAt: job.createdAt,
      scoreSchemaVersion: artifact.schemaVersion,
      artifactSha256: sha256(artifactBody(artifact)),
      seed: artifact.seed,
      register: artifact.register,
      shipping: mix.manifest.shipping,
      ...(artifact.audition ? { audition: artifact.audition } : {}),
      kitVersion: artifact.kitVersion,
      renderer: profile.renderer,
      ...(profile.id === LISTEN_PROFILE_ID ? { listenProfile: profile } : { custodyProfile: profile }),
      canonicalPcm: profile.audio,
      canonicalTail: profile.tail,
      fullMix: Object.freeze({ sha256: mixArtifact.sha256, bytes: mixArtifact.sizeBytes, frames: mix.manifest.render.frames }),
      stems: Object.freeze(stems.map((stem) => Object.freeze({ voice: stem.voice, sha256: stem.artifact.sha256, bytes: stem.artifact.sizeBytes, frames: stem.frames, startFrame: 0 }))),
      commonFrameCount: mix.manifest.render.frames,
      rpp: rppArtifact ? Object.freeze({ sha256: rppArtifact.sha256, bytes: rppArtifact.sizeBytes }) : null,
      m3,
      derivatives: derivatives ? Object.freeze([Object.freeze({
        recipeSha256: derivatives.recipe.sha256,
        rendererIdentity: derivatives.outputDescriptor.rendererIdentity,
        output: Object.freeze({
          sampleRate: derivatives.outputDescriptor.sampleRate,
          bitDepth: derivatives.outputDescriptor.bitDepth,
          channelLayout: derivatives.outputDescriptor.channelLayout,
          tailSeconds: derivatives.outputDescriptor.tailSeconds,
        }),
        sha256: derivatives.output.sha256,
        bytes: derivatives.output.sizeBytes,
        frames: derivatives.outputDescriptor.frames,
      })]) : null,
      determinismScope: profile.id === LISTEN_PROFILE_ID
        ? 'Listen render: no custody promise. The WAV is a listening copy rendered by this exact build on the declared runtime and is not a custody receipt.'
        : 'WAV hashes are promised only within this exact saved custody profile and immutable score.',
    });
    const manifestArtifact = await this.store.writeArtifact(job, { kind: 'manifest', filename: 'manifest.json', mediaType: 'application/json', acceptance: 'accepted', data: artifactBody(manifest) });
    return Object.freeze({ mix: mixArtifact, stems: Object.freeze(stems), manifest: manifestArtifact, frameCount: mix.manifest.render.frames, rpp: rppArtifact, packCustody, derivatives });
  }

  async writePackSidecar(job, pack) {
    const { pack: validated, files } = await loadPackSidecar(pack.snapshotPath);
    const manifestArtifact = await this.store.writeArtifact(job, { kind: 'pack_sidecar', filename: 'pack.json', mediaType: 'application/json', acceptance: 'accepted', data: files.get('pack.json') });
    const assetArtifacts = [];
    for (const asset of validated.manifest.assets) {
      const data = files.get(asset.file);
      const metadata = await this.store.writeArtifact(job, { kind: 'pack_sidecar', filename: asset.file, mediaType: 'audio/wav', acceptance: 'accepted', data });
      assetArtifacts.push({ assetId: asset.id, artifact: metadata });
    }
    return Object.freeze({ identity: packCustodyIdentity(validated), manifestArtifact, assetArtifacts });
  }

  async compareReplay(sourceJob, mix, stems) {
    const expectedMix = sourceJob.artifacts.find((artifact) => artifact.kind === 'wav_mix' && artifact.acceptance === 'accepted');
    if (!expectedMix) throw new ApiError('TOOLCHAIN_UNAVAILABLE', 'source job has no retained canonical full-mix hash', { stage: 'admitting', details: { sourceJobId: sourceJob.jobId } });
    const mismatches = [];
    if (mix.sha256 !== expectedMix.sha256) mismatches.push({ kind: 'wav_mix', expected: expectedMix.sha256, actual: mix.sha256 });
    const expectedStems = new Map(sourceJob.artifacts.filter((artifact) => artifact.kind === 'wav_stem').map((artifact) => [artifact.filename, artifact]));
    for (const stem of stems) {
      const prior = expectedStems.get(stem.artifact.filename);
      if (prior && prior.sha256 !== stem.artifact.sha256) mismatches.push({ kind: 'wav_stem', voice: stem.voice, expected: prior.sha256, actual: stem.artifact.sha256 });
    }
    if (mismatches.length > 0) throw new ApiError('RENDER_MISMATCH', 'exact-profile replay produced unexpected bytes', { stage: 'rendering', details: { sourceJobId: sourceJob.jobId, mismatches } });
  }

  async writeProvenance(job, context) {
    const includedKinds = new Set(['request', 'register', 'composition_request', 'composition_response', 'validation_report', 'score', 'manifest', 'wav_mix', 'wav_stem', 'rpp', 'pack_sidecar']);
    const hashDomain = Object.freeze(job.artifacts
      .filter((artifact) => includedKinds.has(artifact.kind))
      .map((artifact) => Object.freeze({ artifactId: artifact.artifactId, kind: artifact.kind, filename: artifact.filename, sha256: artifact.sha256 })));
    const exactPackResolution = context.pack
      ? Object.freeze({
        format: SAMPLE_PACK_FORMAT,
        formatVersion: context.pack.identity.formatVersion,
        packId: context.pack.identity.packId,
        manifestSha256: context.pack.identity.manifestSha256,
        contentSha256: context.pack.identity.contentSha256,
        referencedAssets: context.pack.resolvedAssets
          .filter((asset) => !context.pack.assetAllowlist || context.pack.assetAllowlist.includes(asset.id))
          .map((asset) => Object.freeze({
            assetId: asset.id,
            wavSha256: asset.wavSha256,
            pcmSha256: asset.pcmSha256,
            allowedCanonicalLanes: asset.allowedCanonicalLanes,
          })),
      })
      : null;
    const derivatives = context.derivatives
      ? Object.freeze([Object.freeze({
        recipeArtifactId: context.derivatives.recipe.artifactId,
        recipeSha256: context.derivatives.recipe.sha256,
        outputArtifactId: context.derivatives.output.artifactId,
        outputSha256: context.derivatives.output.sha256,
        outputDescriptor: context.derivatives.outputDescriptor,
      })])
      : null;
    const provenance = Object.freeze({
      provenanceFormatVersion: '1.0.0',
      apiVersion: API_VERSION,
      jobId: job.jobId,
      originalPrompt: context.prompt,
      resolvedRegister: context.register,
      modelLane: context.modelLane,
      model: context.model,
      promptTemplateRevision: context.promptTemplateRevision,
      transportCallCount: job.transportCallCount,
      validationCandidateCount: job.validationCandidateCount,
      artifactSha256: context.scoreArtifact.sha256,
      exactPackResolution,
      ...(context.packFallback ? { packFallback: context.packFallback } : {}),
      scoreSeed: job.admission.seed ?? null,
      ...(context.profile.id === LISTEN_PROFILE_ID ? { listenProfile: context.profile } : { custodyProfile: context.profile }),
      stageTimestamps: job.stageTimestamps,
      hashDomain,
      excludedHashDomain: Object.freeze(['provenance.json', 'bundle archives enclosing provenance', 'external job index']),
      ...(derivatives ? { derivatives } : {}),
      ...(context.weiss ? { weiss: Object.freeze({ ...context.weiss }) } : {}),
    });
    const metadata = await this.store.writeArtifact(job, { kind: 'provenance', filename: 'provenance.json', mediaType: 'application/json', acceptance: 'accepted', data: artifactBody(provenance) });
    job.provenanceSummary = Object.freeze({
      artifactSha256: context.scoreArtifact.sha256,
      mixSha256: context.rendered.mix.sha256,
      provenanceSha256: metadata.sha256,
      ...(context.profile.id === LISTEN_PROFILE_ID ? { listenProfileId: context.profile.id } : { custodyProfileId: context.profile.id }),
      ...(context.rendered.rpp ? { rppSha256: context.rendered.rpp.sha256 } : {}),
      ...(derivatives ? { derivativeOutputSha256: derivatives[0].outputSha256 } : {}),
    });
    await this.store.writeJob(job);
    try {
      await this.store.writeIndex(job.jobId, Object.freeze({ jobId: job.jobId, provenanceSha256: metadata.sha256, updatedAt: nowIso(this.clock) }));
    } catch (cause) {
      throw new ApiError('ARTIFACT_WRITE_FAILED', 'could not retain the external job index', {
        stage: 'packaging', jobId: job.jobId, details: { provenanceSha256: metadata.sha256 }, cause,
      });
    }
  }

  async runWeiss(job, admission) {
    if (!this.weiss) {
      return {
        success: false,
        profile: null,
        executable: null,
        argv: [],
        timestamp: nowIso(this.clock),
        exitStatus: null,
        stdout: '',
        stderr: 'Weiss is not configured',
        timeout: null,
        timedOut: false,
        version: null,
      };
    }
    const packSummary = admission.pack
      ? this.packRegistry.list().find((pack) => pack.packId === admission.pack.identity.packId) ?? null
      : null;
    return this.weiss.generate({
      prompt: admission.prompt,
      titleHint: admission.titleHint ?? null,
      duration: admission.duration,
      sections: admission.sections,
      canonicalVoiceAllowlist: admission.canonicalVoiceAllowlist,
      packSummary,
    });
  }

  async getJob(jobId) {
    return this.store.readJob(jobId);
  }

  async listArtifacts(jobId) {
    return (await this.store.readJob(jobId)).artifacts;
  }

  async getArtifact(jobId, artifactId) {
    return this.store.readArtifact(jobId, artifactId);
  }
}
