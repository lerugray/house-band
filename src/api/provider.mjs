import { canonicalJson } from '../provenance.mjs';
import { KIT_VERSION, SCHEMA_VERSION } from '../version.mjs';
import { ApiError } from './errors.mjs';

const DRUM_VOICES = new Set(['kick', 'snare', 'hat']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function distributeBars(admission) {
  const requested = admission.sections;
  if (requested.length === 0) {
    let total = admission.duration.targetBars ?? 1;
    if (admission.duration.secondsInterval) {
      const midpoint = (admission.duration.secondsInterval[0] + admission.duration.secondsInterval[1]) / 2;
      total = admission.duration.targetBars ?? clamp(Math.round(midpoint / 2), admission.duration.barRange[0], admission.duration.barRange[1]);
    }
    return [{ name: 'song', bars: total }];
  }
  const result = requested.map((section) => ({ name: section.name, bars: section.bars ?? 1 }));
  let target = admission.duration.targetBars;
  if (target === null && admission.duration.secondsInterval && requested.some((section) => section.bars === undefined)) {
    const midpoint = (admission.duration.secondsInterval[0] + admission.duration.secondsInterval[1]) / 2;
    target = clamp(Math.round(midpoint / 2), admission.duration.barRange[0], admission.duration.barRange[1]);
  }
  if (target !== null) {
    let remainder = target - result.reduce((sum, section) => sum + section.bars, 0);
    for (let index = 0; remainder > 0; index = (index + 1) % result.length) {
      if (requested[index].bars === undefined && result[index].bars < 4096) {
        result[index].bars++;
        remainder--;
      }
    }
  }
  return result;
}

function selectSampleBindings(admission) {
  if (!admission.pack) return null;
  const packAssets = admission.pack.resolvedAssets;
  const allowlist = admission.pack.assetAllowlist;
  const result = {};
  for (const voice of admission.canonicalVoiceAllowlist) {
    if (!DRUM_VOICES.has(voice)) continue;
    const candidates = packAssets.filter((asset) => asset.allowedCanonicalLanes.includes(voice));
    const filtered = allowlist ? candidates.filter((asset) => allowlist.includes(asset.id)) : candidates;
    if (filtered.length === 0) return null;
    const asset = filtered[0];
    result[voice] = { kind: 'one-shot', assetId: asset.id, pcmSha256: asset.pcmSha256, gain: 0.8 };
  }
  return Object.keys(result).length > 0 ? result : null;
}

function eventFor(voices, sampleVoices) {
  return voices.map((voice, index) => {
    const steps = index % 2 === 0 ? [0, 8] : [4, 12];
    if (sampleVoices && Object.hasOwn(sampleVoices, voice)) return { i: steps, voice, opts: { vol: 0.6 } };
    if (DRUM_VOICES.has(voice)) return { i: steps, voice, opts: { vol: 0.1 } };
    if (voice === 'air') return { i: steps, voice, dur: 0.05, opts: { vol: 0.03 } };
    return { i: steps, voice, note: 'C3', dur: 0.1, opts: { vol: 0.05 } };
  });
}

export function deterministicScore(admission, fixedRegister) {
  const sections = distributeBars(admission);
  const totalBars = sections.reduce((sum, section) => sum + section.bars, 0);
  let tempo = 240;
  if (admission.duration.secondsInterval) {
    const [min, max] = admission.duration.secondsInterval;
    const desired = (min + max) / 2;
    tempo = clamp(240 * totalBars / desired, 20, 400);
  }
  const sampleVoices = selectSampleBindings(admission);
  const tracks = {};
  for (const section of sections) {
    tracks[section.name] ??= { bpm: tempo, len: 16, vol: 0.8, steps: eventFor(admission.canonicalVoiceAllowlist, sampleVoices) };
  }
  const score = {
    schemaVersion: admission.scoreSchemaVersion ?? SCHEMA_VERSION,
    kitVersion: KIT_VERSION,
    seed: admission.seed,
    tempo,
    sampleRate: 44100,
    ...(admission.titleHint === undefined ? {} : { label: admission.titleHint }),
    register: fixedRegister,
    tracks,
    sections: sections.map((section) => ({ track: section.name, bars: section.bars })),
  };
  if (admission.pack && sampleVoices) {
    score.samplePack = {
      packId: admission.pack.identity.packId,
      formatVersion: admission.pack.identity.formatVersion,
      manifestSha256: admission.pack.identity.manifestSha256,
      contentSha256: admission.pack.identity.contentSha256,
    };
    score.sampleVoices = sampleVoices;
  }
  return score;
}

/** Pluggable provider used by default; real network adapters implement the same generate method. */
export class DeterministicScoreProvider {
  constructor() {
    this.laneId = 'deterministic-test-double';
    this.model = 'house-band-deterministic-score-author/1.0.0';
    this.maxTransportAttempts = 3;
    this.callTimeoutMs = 5_000;
    this.totalDeadlineMs = 30_000;
  }

  async generate({ admission, fixedRegister }) {
    return canonicalJson(deterministicScore(admission, fixedRegister));
  }
}

/**
 * Real provider transport over an OpenAI-compatible chat-completions endpoint.
 *
 * All transport bounds (maxTransportAttempts, per-call timeout, total deadline,
 * serialized calls, and late-response discard) are enforced by the caller in
 * service.mjs; this adapter only exposes the configured bounds and performs the
 * HTTP round-trip, returning the raw assistant content string for validation.
 */
export class OpenAiCompatibleProvider {
  constructor({
    baseUrl,
    apiKeyEnvVar,
    model,
    laneId = 'openai-compatible',
    displayName = 'OpenAI-compatible provider',
    maxTransportAttempts = 3,
    callTimeoutMs = 30_000,
    totalDeadlineMs = 120_000,
    temperature = 0.2,
    maxTokens = 8_192,
    responseFormat = null,
  } = {}) {
    if (!baseUrl || typeof baseUrl !== 'string') throw new Error('OpenAiCompatibleProvider: baseUrl is required');
    if (!apiKeyEnvVar || typeof apiKeyEnvVar !== 'string') throw new Error('OpenAiCompatibleProvider: apiKeyEnvVar is required');
    if (!model || typeof model !== 'string') throw new Error('OpenAiCompatibleProvider: model is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKeyEnvVar = apiKeyEnvVar;
    this.model = model;
    this.laneId = laneId;
    this.displayName = displayName;
    this.maxTransportAttempts = maxTransportAttempts;
    this.callTimeoutMs = callTimeoutMs;
    this.totalDeadlineMs = totalDeadlineMs;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.responseFormat = responseFormat ?? { type: 'json_object' };
  }

  buildMessages(request) {
    const base = request.basePrompt;
    const requiredSections = base.sections.length === 0
      ? 'No explicit sections were admitted. Emit at least one section entry, each with an existing track name and bars>=1.'
      : 'Admitted sections were provided. Match each section name and bars exactly unless constrained by other diagnostics.';
    const requiredRegister = `Copy fixed register exactly: ${JSON.stringify(base.fixedRegister)}.`;
    const requiredKit = `Use the exact admitted kitVersion object exactly: ${JSON.stringify(base.scoreContract.kitVersion)}.`;
    const allowedTracks = 'Track names are independent identifiers (for example A and B), beginning with a letter and containing only letters, digits, underscore or hyphen, at most 64 characters. Use the admitted section track names when supplied; the voice allowlist constrains event voices only.';
    const topLevel = [
      'schemaVersion (admitted string):',
      'kitVersion object with semver and sha',
      'seed',
      'sampleRate 44100',
      'register object',
      'tracks object',
      'sections array',
      'optional tempo number in bpm, optional gain, optional label',
      'optional performance object',
      'optional samplePack and sampleVoices only when pack is admitted',
    ].join(' ');
    const forbidden = [
      'Do NOT emit legacy/alternate keys like version, score, tempo object/array, timeSignature, pattern, arrangement, events, scoreSchemaVersion, or events/sections shape from legacy schemas.',
      'Do NOT wrap output in Markdown code fences, add comments, preambles, or trailing text.',
      'Do NOT emit decimal every values or unsupported option keys for drum voices.',
    ].join(' ');
    const repairHint = request.requestFormat === 'hb-composition-repair/1.0.0'
      ? 'This is a repair attempt; follow orderedValidatorDiagnostics and previous raw candidate issues exactly before re-trying.'
      : '';
    return [
      {
        role: 'system',
        content: [
          'You are a deterministic House Band score composer.',
          base.task,
          `Return one complete JSON object using score schema ${base.scoreSchemaVersion}.`,
          `Top-level keys must be valid under this contract: ${topLevel}.`,
          `Each track must include integer len (1..4096) and may include bpm if not using top-level tempo.`,
          allowedTracks,
          'Before laying out events, decide an original identifying gesture or texture process, an answer, the bass job and destination, a rest map, a transformation, a rise and a landing. Let the scene decide harmonic rhythm; do not copy reference tunes or progressions or add notes merely to meet counts.',
          ...(base.scoreSchemaVersion === '1.2.0' ? [
            'Schema 1.2 supports section shape {gain:[bars+1 anchors 0..2],bright:[bars+1 anchors .25..2]}, mute:[voices], dropouts:[{from,to,voices}] in sixteenth-grid bar units; curves interpolate at each onset and reset each section. Brightness and step accent 0..1 support synth pad/drone/pluck/bass/lead only; accent multiplies level by 1+0.5a and cutoff by 1+0.8a. Sample controls are unsupported. Tracks may declare pan -1..1 and width 0..0.6. Optional mix has room 0..1, width 0..0.6 and voices:{voice:{pan,width}}. Room conflicts with fx.reverb.',
          ] : []),
          `Base track keys are bpm, len, vol, and steps; schema 1.2 extensions are listed separately.`,
          `Base section keys are track, bars, fadeIn, harmonicClaim, and execution; schema 1.2 extensions are listed separately. Execution is optional and, when used, is {kind:"intro"|"body"|"mutation", every, id}; mutation variants require harmonicClaim:"reuse".`,
          `Optional performance keys are humanize, releaseTail, and voices. Humanize keys are timingMs [min,max] milliseconds, velocity [min,max] gain fractions, and swing 0..1; voice overrides use the same humanize shape, while releaseTail is valid only for pad and drone.`,
          `Base step keys are i/every (i is integer step index; every is integer stride), voice/v, role, opts/o, note/freq, dur (for pitched tracks only), and optional nudge (milliseconds timing offset). If the fixed register declares class dread/calm/joy, every event requires one of the eight documented role values.`,
          `Each step MUST include voice/v and it must be from ${base.canonicalVoiceAllowlist.join(', ')}.`,
          `For percussion voices (kick, snare, hat), omit note/freq/dur and keep opts/o as an object.`,
          requiredRegister,
          requiredKit,
          `seed must remain exactly ${base.seed}.`,
          requiredSections,
          `When sections are not explicitly admitted, one or more sections are still required and each section bars must be integer >=1.`,
          forbidden,
          repairHint,
          'Do not include prose, Markdown, comments, or trailing data.',
          `Sample rate is fixed at ${base.scoreContract.sampleRate} Hz.`,
          `Kit version is ${base.scoreContract.kitVersion.semver}.`,
        ].join(' '),
      },
      { role: 'user', content: JSON.stringify(request.requestFormat === 'hb-composition-repair/1.0.0'
        ? { ...base, requestFormat: request.requestFormat, completePriorRawCandidate: request.completePriorRawCandidate, orderedValidatorDiagnostics: request.orderedValidatorDiagnostics, admittedConstraints: request.admittedConstraints, outputRequirement: request.outputRequirement }
        : base) },
    ];
  }

  async generate({ request, signal }) {
    const apiKey = process.env[this.apiKeyEnvVar];
    if (!apiKey) {
      throw new ApiError('MODEL_LANE_UNAVAILABLE', `environment variable ${this.apiKeyEnvVar} is not set`, { retryable: false });
    }

    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages: this.buildMessages(request),
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      ...(this.responseFormat ? { response_format: this.responseFormat } : {}),
    };
    const fetchOptions = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    };

    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      if (signal?.aborted) {
        throw new ApiError('MODEL_LANE_UNAVAILABLE', 'provider call was aborted by deadline or timeout', { retryable: true, cause: error });
      }
      throw new ApiError('MODEL_LANE_UNAVAILABLE', `provider transport error: ${error.message}`, { retryable: true, cause: error });
    }

    if (!response.ok) {
      let text = '';
      try { text = await response.text(); } catch {}
      const retryable = response.status >= 500 || response.status === 429;
      throw new ApiError('MODEL_LANE_UNAVAILABLE', `provider returned HTTP ${response.status}`, {
        retryable,
        details: { status: response.status, bodySnippet: text.slice(0, 500) },
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new ApiError('MODEL_LANE_UNAVAILABLE', 'provider returned non-JSON response body', { retryable: true, cause: error });
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ApiError('MODEL_LANE_UNAVAILABLE', 'provider response missing assistant content', { retryable: false });
    }
    return content;
  }
}
