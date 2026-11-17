/**
 * cowrite develop, `llm` engine (OSS-22).
 *
 * The request goes through the Desk/API provider path in the existing composition wire
 * format (`hb-composition-request/1.0.0`, repairs as `hb-composition-repair/1.0.0`, built
 * by the API's own composerRequest). The base prompt carries the source-song, the keep
 * layer rule (with the user's notes already laid out as steps), the form plan and
 * docs/COMPOSING-LAWS.md. Every returned candidate goes through validateSpec, then the
 * admitted constraints, then checkKeepLayer, inside the same bounded repair loop as the
 * API composer: at most maxValidationAttempts candidates, at most the provider's
 * maxTransportAttempts calls, the provider's per-call timeout and total deadline, and the
 * validator's ordered diagnostics fed back on each repair.
 *
 * With the Desk `deterministic` profile the provider answers offline (it lays out the
 * arranger's score), so the whole path runs in tests without a network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonNoDuplicates } from '../api/json.mjs';
import { composerRequest, stableDiagnostics } from '../api/service.mjs';
import { canonicalJson } from '../provenance.mjs';
import { SpecError, validateSpec } from '../spec.mjs';
import { KIT_VERSION, SCHEMA_VERSION } from '../version.mjs';
import { arrange, DEVELOP_REGISTER } from './arranger.mjs';
import { checkKeepLayer, describeKeepLayer, VOICE_RANGES } from './keep-layer.mjs';

export const LLM_PROMPT_REVISION = 'hb-cowrite-develop/1.0.0';
export const DEFAULT_LLM_VALIDATION_ATTEMPTS = 3;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The public export places the laws at docs/; the private repo keeps them in the overlay.
const LAWS_PATHS = ['docs/COMPOSING-LAWS.md', 'oss/overlay/docs/COMPOSING-LAWS.md'];

export const DEVELOP_VOICES = Object.freeze([
  'lead', 'pad', 'pluck', 'bell', 'bass', 'drone',
  'kick', 'snare', 'hat', 'clap', 'rim', 'ride', 'crash', 'perc', 'tomLow', 'tomMid', 'tomHigh',
]);

export const KEEP_LAYER_RULE = [
  'THE KEEP LAYER IS THE LAW. Every note of every pitched track of the user\'s source-song must appear in the',
  'score in every section that states the user\'s material (cowrite.formPlan entries with statesUserMaterial:',
  'true), at the same pitch class and beat, as a step that carries "origin": "user". Beat means the 16th-note',
  'step from the start of that section (step i = round(beat * 4)). Keep the octave too; an octave fold is',
  'allowed only to move a note into the range of the voice that plays it (cowrite.voiceRanges). Never tag a',
  'House Band note "origin": "user". Every note House Band adds carries "origin": "house-band".',
  'cowrite.userLayer gives the user\'s notes already laid out as steps for each material: copy those steps',
  'unchanged into every listed track, then compose the arrangement around them. Never time-stretch, transpose',
  'or re-harmonise the user\'s notes; develop them by what you add (bass from the chord roots, drums, pad or',
  'counter-line, new sections) and by planned drop-outs of the parts House Band added.',
].join(' ');

/** docs/COMPOSING-LAWS.md as text (first match of the public and private locations). */
export function composingLaws(root = REPO_ROOT) {
  for (const rel of LAWS_PATHS) {
    const path = resolve(root, rel);
    if (existsSync(path)) return { path: rel, text: readFileSync(path, 'utf8') };
  }
  return { path: null, text: 'docs/COMPOSING-LAWS.md was not found in this checkout.' };
}

export class LlmDevelopError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LlmDevelopError';
    this.details = details;
  }
}

/**
 * Build the base prompt. The form plan (section names, bars, which sections state the
 * user's material) and the user's notes as steps come from the deterministic arranger
 * scaffold, so the model composes into a fixed frame the keep-layer check can read.
 */
export function developPrompt(source, { form, drafts = [], lengthBars = null, kit = 'tr808', seed = 1, brief = null, laws = composingLaws() } = {}) {
  const scaffold = arrange(source, { form, drafts, lengthBars, kit, seed });
  const { spec, record } = scaffold;
  const userLayer = {};
  for (const s of record.sections) {
    if (!s.statesUserMaterial || userLayer[s.material]) continue;
    userLayer[s.material] = {
      tracks: record.sections.filter((x) => x.material === s.material && x.statesUserMaterial).map((x) => x.track),
      steps: spec.tracks[s.track].steps.filter((step) => step.origin === 'user'),
    };
  }
  const sections = record.sections.map((s) => Object.freeze({ name: s.track, bars: s.bars }));
  const totalBars = sections.reduce((n, s) => n + s.bars, 0);
  const basePrompt = {
    promptTemplateRevision: LLM_PROMPT_REVISION,
    task: 'Return one complete House Band score as a single JSON object that develops the user\'s own piece into a full arrangement: keep every user note (the keep layer) and add the arrangement around it.',
    scoreSchemaVersion: SCHEMA_VERSION,
    scoreContract: {
      strictUnknownFields: true,
      sampleRate: 44100,
      kitVersion: KIT_VERSION,
      register: DEVELOP_REGISTER,
      synthesisOnly: true,
      stepOrigin: 'every step carries "origin": "user" (the user\'s notes) or "origin": "house-band" (added notes)',
      kit: `top-level "kit": "${kit}" names the drum kit`,
      performance: {
        optional: true,
        humanize: { timingMs: 'optional [min,max] milliseconds (-50..50)', velocity: 'optional [min,max] gain fractions (-1..1)', swing: 'optional 0..1 half-step delay fraction' },
        releaseTail: 'optional 0..30 seconds added to pad/drone note releases',
        voices: 'optional per-voice humanize/releaseTail overrides; releaseTail only for pad/drone',
      },
      output: 'one complete JSON object; no prose, Markdown, comments, or trailing data',
    },
    canonicalVoiceAllowlist: DEVELOP_VOICES,
    assetAllowlist: [],
    packIdentity: null,
    userPrompt: brief ?? 'Develop this piece into a full arrangement in its own character.',
    registerBrief: 'Co-write: the user\'s piece stays as written; House Band adds the band. Follow cowrite.keepLayerRule and cowrite.composingLaws.',
    fixedRegister: DEVELOP_REGISTER,
    duration: { targetBars: totalBars },
    sections,
    seed,
    cowrite: {
      form,
      kit,
      lengthBars,
      seed,
      keepLayerRule: KEEP_LAYER_RULE,
      voiceRanges: VOICE_RANGES,
      formPlan: record.sections.map((s) => ({
        track: s.track,
        material: s.material,
        kind: s.kind,
        startBar: s.startBar,
        bars: s.bars,
        harmonicClaim: s.harmonicClaim,
        statesUserMaterial: s.statesUserMaterial,
        plan: s.parts?.plan ?? null,
        chords: s.chords,
      })),
      estimatedKey: record.key,
      userLayer,
      sourceSong: source,
      drafts,
      composingLaws: laws.text,
      composingLawsPath: laws.path,
    },
  };
  return { basePrompt, scaffold };
}

/** Validate one candidate: schema, admitted constraints, then the keep layer. */
export function validateDevelopCandidate(raw, { source, drafts, basePrompt, userSections, draftSections }) {
  const parsed = parseJsonNoDuplicates(raw);
  const artifact = validateSpec(parsed);
  if (artifact.schemaVersion !== basePrompt.scoreSchemaVersion) throw new SpecError('spec.schemaVersion: differs from admitted schema');
  if (artifact.seed !== basePrompt.seed) throw new SpecError('spec.seed: differs from admitted seed');
  if (canonicalJson(artifact.kitVersion) !== canonicalJson(KIT_VERSION)) throw new SpecError('spec.kitVersion: differs from admitted kit');
  if (canonicalJson(artifact.register) !== canonicalJson(DEVELOP_REGISTER)) throw new SpecError('spec.register: differs from admitted immutable register');
  if (artifact.samplePack !== undefined || artifact.sampleVoices !== undefined) throw new SpecError('spec.samplePack: synthesis admission forbids sample fields');
  if (artifact.sections.length !== basePrompt.sections.length) throw new SpecError(`spec.sections: expected ${basePrompt.sections.length} sections in the form plan order`);
  basePrompt.sections.forEach((want, index) => {
    const got = artifact.sections[index];
    if (got.track !== want.name) throw new SpecError(`spec.sections[${index}].track: expected "${want.name}" from the form plan`);
    if (got.bars !== want.bars) throw new SpecError(`spec.sections[${index}].bars: expected ${want.bars} from the form plan`);
  });
  for (const [name, track] of Object.entries(artifact.tracks)) {
    track.steps.forEach((step, index) => {
      const voice = step.voice ?? step.v;
      if (!DEVELOP_VOICES.includes(voice)) throw new SpecError(`spec.tracks.${name}.steps[${index}].voice: outside admitted voices`);
      if (step.origin === undefined) throw new SpecError(`spec.tracks.${name}.steps[${index}].origin: required ("user" or "house-band")`);
    });
  }
  const keepLayer = checkKeepLayer(source, artifact, { sections: userSections });
  if (!keepLayer.ok) throw new SpecError(`spec.tracks: ${describeKeepLayer(keepLayer)}`);
  const draftKeepLayers = drafts.map((d, k) => checkKeepLayer(d, artifact, { sections: draftSections[k] }));
  draftKeepLayers.forEach((r, k) => {
    if (!r.ok) throw new SpecError(`spec.tracks: draft ${k + 1} ${describeKeepLayer(r)}`);
  });
  return { artifact, keepLayer, draftKeepLayers };
}

async function callProvider(provider, request, deadline, clock) {
  const remaining = deadline - clock();
  if (remaining <= 0) throw new LlmDevelopError('composition deadline elapsed');
  const timeoutMs = Math.min(provider.callTimeoutMs ?? remaining, remaining);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LlmDevelopError(`provider call timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const raw = await Promise.race([Promise.resolve().then(() => provider.generate({ request, signal: controller.signal })), timeout]);
    return typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Develop with a provider inside the bounded repair loop.
 * @param {object} source validated source-song
 * @param {{ provider: object, profileId?: string, form: string, drafts?: object[], lengthBars?: number|null,
 *   kit?: string, seed?: number, brief?: string|null, maxValidationAttempts?: number, clock?: () => number }} options
 */
export async function developWithLlm(source, options) {
  const { provider } = options;
  if (!provider || typeof provider.generate !== 'function') throw new LlmDevelopError('llm engine needs a provider with generate()');
  const drafts = options.drafts ?? [];
  const clock = options.clock ?? Date.now;
  const { basePrompt, scaffold } = developPrompt(source, options);
  const userSections = scaffold.record.userSections;
  const draftSections = scaffold.record.draftSections.map((d) => d.sections);
  const maximumCandidates = options.maxValidationAttempts ?? DEFAULT_LLM_VALIDATION_ATTEMPTS;
  const maximumCalls = provider.maxTransportAttempts ?? 1;
  const deadline = clock() + (provider.totalDeadlineMs ?? 30_000);
  const attempts = [];
  let candidates = 0;
  let calls = 0;
  let priorCandidate = null;
  let diagnostics = Object.freeze([]);
  while (candidates < maximumCandidates && calls < maximumCalls) {
    if (clock() >= deadline) throw new LlmDevelopError('composition deadline elapsed', { attempts });
    const request = composerRequest(basePrompt, priorCandidate, diagnostics, candidates + 1, maximumCandidates);
    calls += 1;
    let raw;
    try {
      raw = await callProvider(provider, request, deadline, clock);
    } catch (error) {
      attempts.push({ call: calls, transportError: error?.message ?? String(error) });
      if (calls >= maximumCalls) throw new LlmDevelopError(`provider transport attempts were exhausted: ${error?.message ?? error}`, { attempts });
      continue;
    }
    candidates += 1;
    try {
      const accepted = validateDevelopCandidate(raw, { source, drafts, basePrompt, userSections, draftSections });
      attempts.push({ call: calls, candidate: candidates, valid: true });
      const moved = accepted.keepLayer.moved.map((m) => ({ kind: 'octave-fold', material: 'A', track: m.track, noteIndex: m.noteIndex, beat: m.beat, from: m.note, to: m.toNote, voice: m.voice, sections: [m.section] }));
      const record = {
        engine: 'llm',
        engineVersion: LLM_PROMPT_REVISION,
        form: options.form,
        seed: options.seed ?? 1,
        kit: options.kit ?? 'tr808',
        tempo: scaffold.record.tempo,
        key: scaffold.record.key,
        provider: { profile: options.profileId ?? null, laneId: provider.laneId ?? null, model: provider.model ?? null },
        repairLoop: { maximumCandidates, maximumCalls, candidates, transportCalls: calls, attempts },
        material: scaffold.record.material,
        sections: scaffold.record.sections.map((s) => ({
          index: s.index,
          track: s.track,
          material: s.material,
          kind: s.kind,
          ...(s.draft ? { draft: s.draft } : {}),
          startBar: s.startBar,
          bars: s.bars,
          startSeconds: s.startSeconds,
          harmonicClaim: accepted.artifact.sections[s.index].harmonicClaim ?? 'new',
          statesUserMaterial: s.statesUserMaterial,
          plan: s.parts?.plan ?? null,
        })),
        userSections,
        draftSections: scaffold.record.draftSections,
        length: scaffold.record.length,
        changes: moved,
        brief: options.brief ?? null,
        notes: scaffold.record.notes,
      };
      return { spec: accepted.artifact, record, keepLayer: accepted.keepLayer, draftKeepLayers: accepted.draftKeepLayers, basePrompt };
    } catch (error) {
      diagnostics = stableDiagnostics(error);
      priorCandidate = raw;
      attempts.push({ call: calls, candidate: candidates, valid: false, diagnostics });
    }
  }
  throw new LlmDevelopError(`all ${candidates} candidate(s) were rejected: ${diagnostics.map((d) => d.message).join('; ')}`, { attempts, diagnostics });
}
