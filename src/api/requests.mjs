import { randomBytes } from 'node:crypto';

import { canonicalJson, sha256 } from '../provenance.mjs';
import { SAMPLE_PACK_FORMAT, SUPPORTED_SAMPLE_PACK_VERSIONS } from '../sample-pack.mjs';
import { VOICES } from '../spec.mjs';
import { KIT_VERSION, SCHEMA_VERSION, SUPPORTED_CURRENT_SCHEMAS } from '../version.mjs';
import { ApiError, unsupportedFeature } from './errors.mjs';
import { CUSTODY_PROFILE_ID, LISTEN_PROFILE_ID } from './profile.mjs';

const SONG_FIELDS = new Set(['prompt', 'titleHint', 'scoreSchemaVersion', 'register', 'pack', 'canonicalVoiceAllowlist', 'seed', 'duration', 'sections', 'composition', 'render', 'execution', 'renderProfileId']);
const REGISTER_FIELDS = new Set(['source', 'brief', 'notes', 'allowNeutralFallback']);
const DURATION_FIELDS = new Set(['targetSeconds', 'minSeconds', 'maxSeconds', 'targetBars', 'loopable']);
const SECTION_FIELDS = new Set(['name', 'bars', 'direction']);
const COMPOSITION_FIELDS = new Set(['modelLaneId', 'maxValidationAttempts']);
const SONG_RENDER_FIELDS = new Set(['fullMix', 'stems', 'rpp']);
const EXECUTION_FIELDS = new Set(['mode', 'waitTimeoutMs']);
const RENDER_FIELDS = new Set(['score', 'sourceJobId', 'custodyProfileId', 'packCustodyRef', 'mode', 'outputs', 'derivativeRecipe', 'execution']);
const FORBIDDEN_RENDER_OVERRIDES = new Set(['seed', 'sampleRate', 'bitDepth', 'tailSeconds']);
const TRACK_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PACK_FIELDS = new Set(['format', 'formatVersion', 'packId', 'manifestSha256', 'contentSha256', 'policy', 'assetAllowlist']);
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const HEX_256 = /^[a-f0-9]{64}$/;

function invalid(message, details = {}) {
  throw new ApiError('INVALID_REQUEST', message, { details });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function known(value, fields, path) {
  if (!isObject(value)) invalid(`${path} must be an object`);
  for (const key of Object.keys(value)) if (!fields.has(key)) invalid(`${path}.${key} is an unsupported field`, { field: `${path}.${key}` });
}

function finiteSeconds(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 3600) invalid(`${path} must be a finite number greater than zero and no greater than 3600`);
}

function positiveInteger(value, path, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 1 || value > max) invalid(`${path} must be an integer from 1 through ${max}`);
}

function normalizeExecution(value) {
  if (value === undefined) return Object.freeze({ mode: 'async' });
  known(value, EXECUTION_FIELDS, 'execution');
  const mode = value.mode ?? 'async';
  if (!['async', 'sync_wait'].includes(mode)) invalid('execution.mode must be async or sync_wait');
  if (mode === 'async' && value.waitTimeoutMs !== undefined) invalid('execution.waitTimeoutMs is allowed only for sync_wait');
  const waitTimeoutMs = mode === 'sync_wait' ? (value.waitTimeoutMs ?? 5_000) : undefined;
  if (mode === 'sync_wait') positiveInteger(waitTimeoutMs, 'execution.waitTimeoutMs', 60_000);
  return Object.freeze({ mode, ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }) });
}

function normalizeDuration(value, sections) {
  if (value === undefined) value = {};
  known(value, DURATION_FIELDS, 'duration');
  for (const field of ['targetSeconds', 'minSeconds', 'maxSeconds']) if (value[field] !== undefined) finiteSeconds(value[field], `duration.${field}`);
  if (value.targetBars !== undefined) positiveInteger(value.targetBars, 'duration.targetBars', 4096);
  if (value.loopable !== undefined && typeof value.loopable !== 'boolean') invalid('duration.loopable must be a boolean');
  if (value.minSeconds !== undefined && value.maxSeconds !== undefined && value.minSeconds > value.maxSeconds) invalid('duration.minSeconds must not exceed duration.maxSeconds');

  let secondsMin = 0;
  let secondsMax = 3600;
  if (value.targetSeconds !== undefined) {
    const tolerance = Math.max(1, value.targetSeconds * 0.02);
    secondsMin = Math.max(secondsMin, value.targetSeconds - tolerance);
    secondsMax = Math.min(secondsMax, value.targetSeconds + tolerance);
  }
  if (value.minSeconds !== undefined) secondsMin = Math.max(secondsMin, value.minSeconds);
  if (value.maxSeconds !== undefined) secondsMax = Math.min(secondsMax, value.maxSeconds);
  if (secondsMin > secondsMax || secondsMax <= 0) invalid('duration seconds constraints have an empty intersection');

  const suppliedBars = sections.reduce((sum, section) => sum + (section.bars ?? 0), 0);
  const unspecified = sections.filter((section) => section.bars === undefined).length;
  let barMin = sections.length === 0 ? 1 : suppliedBars + unspecified;
  let barMax = sections.length === 0 ? 4096 : suppliedBars + unspecified * 4096;
  let bindingBars = value.targetBars;
  if (sections.length > 0 && unspecified === 0) {
    if (bindingBars !== undefined && bindingBars !== suppliedBars) invalid('duration.targetBars must equal the sum of fully specified section bars');
    bindingBars = suppliedBars;
  }
  if (bindingBars !== undefined) {
    if (bindingBars < barMin || bindingBars > barMax) invalid('duration.targetBars is infeasible for the requested sections');
    barMin = bindingBars;
    barMax = bindingBars;
  }

  const hasSecondsConstraint = ['targetSeconds', 'minSeconds', 'maxSeconds'].some((key) => value[key] !== undefined);
  if (hasSecondsConstraint && (secondsMax < 0.6 * barMin || secondsMin > 12 * barMax)) {
    invalid('duration seconds constraints are infeasible for the permitted bar range');
  }
  if (0.6 * barMin > 3600) invalid('requested section bars cannot fit within the 3600-second score limit at any supported BPM');
  return Object.freeze({
    targetSeconds: value.targetSeconds ?? null,
    secondsInterval: hasSecondsConstraint ? Object.freeze([secondsMin, secondsMax]) : null,
    targetBars: bindingBars ?? null,
    barRange: Object.freeze([barMin, barMax]),
    loopable: value.loopable ?? null,
    loopableValidation: 'nonbinding-direction',
  });
}

function normalizeSections(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 1024) invalid('sections must be an array with at most 1024 entries');
  const sections = value.map((section, index) => {
    known(section, SECTION_FIELDS, `sections[${index}]`);
    if (typeof section.name !== 'string' || !TRACK_NAME.test(section.name)) invalid(`sections[${index}].name must match the score track-name grammar`);
    if (section.bars !== undefined) positiveInteger(section.bars, `sections[${index}].bars`, 4096);
    if (section.direction !== undefined && (typeof section.direction !== 'string' || section.direction.length > 2000)) invalid(`sections[${index}].direction must be a string of at most 2000 characters`);
    return Object.freeze({ ...section });
  });
  return Object.freeze(sections);
}

function normalizePackRequest(value) {
  if (value === undefined) return null;
  known(value, PACK_FIELDS, 'pack');
  if (value.format !== SAMPLE_PACK_FORMAT) invalid(`pack.format must be "${SAMPLE_PACK_FORMAT}"`);
  if (!SUPPORTED_SAMPLE_PACK_VERSIONS.includes(value.formatVersion)) invalid(`pack.formatVersion must be one of ${SUPPORTED_SAMPLE_PACK_VERSIONS.map((version) => `"${version}"`).join(', ')}`);
  if (typeof value.packId !== 'string' || !SLUG.test(value.packId)) invalid('pack.packId must be a lowercase slug');
  for (const field of ['manifestSha256', 'contentSha256']) {
    if (typeof value[field] !== 'string' || !HEX_256.test(value[field])) invalid(`pack.${field} must be a lowercase SHA-256`);
  }
  const policy = value.policy ?? 'required';
  if (!['required', 'preferred'].includes(policy)) invalid('pack.policy must be required or preferred');
  let assetAllowlist = null;
  if (value.assetAllowlist !== undefined) {
    if (!Array.isArray(value.assetAllowlist) || value.assetAllowlist.length === 0 || value.assetAllowlist.some((id) => typeof id !== 'string' || !SLUG.test(id))) {
      invalid('pack.assetAllowlist must be a non-empty array of asset ids');
    }
    assetAllowlist = Object.freeze([...value.assetAllowlist]);
  }
  const identity = Object.freeze({
    format: SAMPLE_PACK_FORMAT,
    formatVersion: value.formatVersion,
    packId: value.packId,
    manifestSha256: value.manifestSha256,
    contentSha256: value.contentSha256,
  });
  return Object.freeze({ identity, policy, assetAllowlist, requestedPackId: value.packId });
}

function normalizeSongRender(value) {
  if (value === undefined) return Object.freeze({ fullMix: true, stems: false, rpp: false });
  known(value, SONG_RENDER_FIELDS, 'render');
  if (value.fullMix === false) invalid('render.fullMix is mandatory and cannot be false');
  if (value.fullMix !== undefined && value.fullMix !== true) invalid('render.fullMix must be true');
  if (value.stems !== undefined && typeof value.stems !== 'boolean') invalid('render.stems must be a boolean');
  if (value.rpp !== undefined && typeof value.rpp !== 'boolean') invalid('render.rpp must be a boolean');
  if (value.rpp === true && value.stems === false) invalid('render.rpp requires stems; explicit rpp:true with stems:false is rejected');
  const stems = value.rpp === true && value.stems === undefined ? true : (value.stems ?? false);
  return Object.freeze({ fullMix: true, stems, rpp: value.rpp ?? false });
}

export function normalizeSongRequest(value, { seed = () => randomBytes(4).readUInt32BE(0), maxValidationAttempts = 5, modelLaneId: configuredModelLaneId = 'deterministic-test-double' } = {}) {
  known(value, SONG_FIELDS, 'request');
  if (typeof value.prompt !== 'string') invalid('prompt is required and must be a string');
  const promptBytes = Buffer.byteLength(value.prompt, 'utf8');
  if (promptBytes < 1 || promptBytes > 32768) invalid('prompt must contain 1 through 32768 UTF-8 bytes');
  if (value.titleHint !== undefined && (typeof value.titleHint !== 'string' || value.titleHint.length > 500)) invalid('titleHint must be a string of at most 500 characters');
  const scoreSchemaVersion = value.scoreSchemaVersion ?? SCHEMA_VERSION;
  if (!SUPPORTED_CURRENT_SCHEMAS.includes(scoreSchemaVersion)) {
    throw new ApiError('UNSUPPORTED_SCORE_SCHEMA', `score schema ${scoreSchemaVersion} is not supported`, {
      details: { requested: scoreSchemaVersion, supported: SUPPORTED_CURRENT_SCHEMAS },
    });
  }
  const packRequest = normalizePackRequest(value.pack);
  const renderProfileId = value.renderProfileId ?? CUSTODY_PROFILE_ID;
  if (renderProfileId !== CUSTODY_PROFILE_ID && renderProfileId !== LISTEN_PROFILE_ID) {
    invalid(`renderProfileId must be ${CUSTODY_PROFILE_ID} or ${LISTEN_PROFILE_ID}`, { field: 'request.renderProfileId' });
  }
  const listen = renderProfileId === LISTEN_PROFILE_ID;
  if (listen && packRequest) invalid('the listen render profile does not render sample packs');

  const register = value.register ?? { source: 'neutral' };
  known(register, REGISTER_FIELDS, 'register');
  let source = register.source ?? 'neutral';
  if (source === 'command') source = 'weiss';
  if (!['neutral', 'supplied', 'weiss'].includes(source)) invalid('register.source must be supplied, weiss, or neutral');
  if (source === 'supplied' && (typeof register.brief !== 'string' || register.brief.length === 0)) invalid('register.brief is required and non-empty for supplied');
  if (source !== 'supplied' && register.brief !== undefined) invalid('register.brief is forbidden unless source is supplied');
  if (register.notes !== undefined && typeof register.notes !== 'string') invalid('register.notes must be a string');
  if (register.allowNeutralFallback !== undefined && typeof register.allowNeutralFallback !== 'boolean') invalid('register.allowNeutralFallback must be a boolean');
  if (source !== 'weiss' && register.allowNeutralFallback !== undefined) invalid('register.allowNeutralFallback is meaningful only for weiss');

  const voices = value.canonicalVoiceAllowlist ?? VOICES;
  if (!Array.isArray(voices) || voices.length > VOICES.length || new Set(voices).size !== voices.length || voices.some((voice) => !VOICES.includes(voice))) {
    invalid(`canonicalVoiceAllowlist must contain unique canonical voices from: ${VOICES.join(', ')}`);
  }
  const admittedSeed = value.seed ?? seed();
  if (!Number.isInteger(admittedSeed) || admittedSeed < 0 || admittedSeed > 0xffffffff) invalid('seed must be an unsigned 32-bit integer');

  const sections = normalizeSections(value.sections);
  const duration = normalizeDuration(value.duration, sections);
  const composition = value.composition ?? {};
  known(composition, COMPOSITION_FIELDS, 'composition');
  const modelLaneId = composition.modelLaneId ?? configuredModelLaneId;
  if (modelLaneId !== configuredModelLaneId) invalid('composition.modelLaneId is not configured', { modelLaneId, configuredModelLaneId });
  const validationAttempts = composition.maxValidationAttempts ?? 3;
  positiveInteger(validationAttempts, 'composition.maxValidationAttempts', maxValidationAttempts);

  const capability = packRequest ? 'M3 one-shot samples on canonical kick/snare/hat lanes, with optional synthesis' : 'synthesis';
  return Object.freeze({
    prompt: value.prompt,
    ...(value.titleHint === undefined ? {} : { titleHint: value.titleHint }),
    scoreSchemaVersion,
    pack: packRequest,
    register: Object.freeze({
      source,
      ...(source === 'supplied' ? { brief: register.brief } : {}),
      ...(source === 'weiss' && register.allowNeutralFallback !== undefined ? { allowNeutralFallback: register.allowNeutralFallback } : {}),
      ...(register.notes === undefined ? {} : { notes: register.notes }),
    }),
    canonicalVoiceAllowlist: Object.freeze([...voices]),
    seed: admittedSeed,
    duration,
    sections,
    composition: Object.freeze({ modelLaneId, maxValidationAttempts: validationAttempts }),
    render: normalizeSongRender(value.render),
    execution: normalizeExecution(value.execution),
    ...(listen ? { renderProfileId } : {}),
    compatibility: Object.freeze({
      scoreSchemaVersion,
      capability,
      kit: KIT_VERSION,
      ...(listen ? { listenProfileId: LISTEN_PROFILE_ID } : { custodyProfileId: CUSTODY_PROFILE_ID }),
      packRequirement: packRequest ? Object.freeze({ format: SAMPLE_PACK_FORMAT, formatVersion: packRequest.identity.formatVersion, packId: packRequest.identity.packId }) : null,
    }),
  });
}

export function normalizeRenderRequest(value) {
  if (!isObject(value)) invalid('request must be an object');
  for (const field of FORBIDDEN_RENDER_OVERRIDES) if (Object.hasOwn(value, field)) invalid(`${field} is authoritative in score and cannot be overridden`, { field });
  known(value, RENDER_FIELDS, 'request');
  if (!isObject(value.score)) invalid('score is required and must be an object');
  if (value.score.samplePack !== undefined || value.score.sampleVoices !== undefined || value.packCustodyRef !== undefined) {
    const scoreHasPack = value.score.samplePack !== undefined || value.score.sampleVoices !== undefined;
    if (!scoreHasPack && value.packCustodyRef !== undefined) invalid('packCustodyRef is meaningful only for a sample-backed score');
  }
  let packCustodyRef = null;
  if (value.packCustodyRef !== undefined) {
    packCustodyRef = normalizePackRequest(value.packCustodyRef);
    if (packCustodyRef.policy !== 'required') invalid('packCustodyRef.policy must be required for renders');
  }
  if (value.sourceJobId !== undefined && (typeof value.sourceJobId !== 'string' || value.sourceJobId.length === 0)) invalid('sourceJobId must be a non-empty string');
  const profile = value.custodyProfileId ?? CUSTODY_PROFILE_ID;
  if (typeof profile !== 'string') invalid('custodyProfileId must be a string');
  const mode = value.mode ?? 'canonical';
  if (mode !== 'canonical' && mode !== 'derivative') invalid('mode must be canonical or derivative');
  if (mode === 'canonical' && value.derivativeRecipe !== undefined) invalid('derivativeRecipe is forbidden for canonical mode');
  if (mode === 'derivative' && !isObject(value.derivativeRecipe)) invalid('derivativeRecipe is required for derivative mode');
  if (mode === 'derivative') {
    const scoreArtifactSha256 = sha256(Buffer.from(canonicalJson(value.score), 'utf8'));
    if (value.derivativeRecipe.sourceArtifactSha256 !== scoreArtifactSha256) {
      invalid('derivativeRecipe.sourceArtifactSha256 must equal the canonical score artifactSha256', {
        expected: scoreArtifactSha256,
        provided: value.derivativeRecipe.sourceArtifactSha256,
      });
    }
  }
  const outputs = normalizeSongRender(value.outputs);
  if (mode === 'derivative' && (outputs.stems || outputs.rpp)) {
    invalid('derivative mode in this tranche supports fullMix only; stems and rpp are not offered');
  }
  return Object.freeze({
    score: value.score,
    ...(value.sourceJobId === undefined ? {} : { sourceJobId: value.sourceJobId }),
    custodyProfileId: profile,
    packCustodyRef,
    mode,
    outputs,
    ...(mode === 'derivative' ? { derivativeRecipe: value.derivativeRecipe } : {}),
    execution: normalizeExecution(value.execution),
  });
}
