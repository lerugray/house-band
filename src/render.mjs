/**
 * Headless offline render: score-spec → AudioBuffer / WAV bytes via the kit.
 */

import { OfflineAudioContext } from 'node-web-audio-api';
import { scheduleSpec } from './schedule.mjs';
import { isNativeKitVersion } from './version.mjs';

// Frozen renderer retains historical artifacts and their existing goldens.
async function historical(spec) {
  const { validateSpec } = await import('../history/pre-dr5/src/spec.mjs');
  const renderer = await import('../history/pre-dr5/src/render.mjs');
  const input = structuredClone(spec);
  delete input.audition;
  return { renderer, artifact: validateSpec(input) };
}
import {
  createBand,
  fxTailSeconds,
  LOOKAHEAD,
  NEUTRAL_DEFAULTS,
  normalizeFx,
  spatialFx,
  RETIRE_TAIL,
  performanceReleaseTail,
} from './kit/band.js';
import {
  requireValidatedScoreArtifact,
  specDuration,
  specTailOverhangSeconds,
  compileTrackStep,
} from './spec.mjs';
import { createWavManifest } from './provenance.mjs';
import {
  encodeCustodyMix,
  hasSampleVoices,
  hasSynthEvents,
  referencedSampleAssets,
  renderSampleBus,
  sampleRenderPlan,
  silentStereoBuffer,
} from './sample-render.mjs';
import { encodeWav } from './wav.mjs';
import { brightTailSeconds, graphSampleTailSeconds, usesGraphSamples } from './timbre.mjs';
import { loadTimbrePacks } from './sample-pack-node.mjs';

/** Default IR length from createBand's reverb defaults (seconds field). */
const DEFAULT_REVERB_SECONDS = NEUTRAL_DEFAULTS.band.reverb.seconds;

export class RenderError extends AggregateError {
  constructor(errors) {
    super(errors, `strict render failed with ${errors.length} step error${errors.length === 1 ? '' : 's'}`);
    this.name = 'RenderError';
  }
}

export function assertNoStepErrors(errors) {
  if (errors.length > 0) throw new RenderError(errors);
}

/**
 * Drive the band scheduler against a simulated clock, then offline-render.
 * @param {object} spec validated score-spec
 * @param {object} [opts]
 * @param {number} [opts.tailSeconds] extra seconds after musical end (reverb/release)
 * @returns {Promise<AudioBuffer>}
 */
export async function renderSpec(spec, opts = {}) {
  requireValidatedScoreArtifact(spec);
  if (!isNativeKitVersion(spec.kitVersion)) {
    const old = await historical(spec);
    return old.renderer.renderSpec(old.artifact, opts);
  }
  // Kit 1.11.0: kit/patch sample packs (and graph-routed bound samples) load
  // here; null for a neutral score, which never reaches the disk.
  const timbrePacks = opts.timbrePacks !== undefined ? opts.timbrePacks : await loadTimbrePacks(spec, opts.samplePack ?? null);
  const sampleRate = spec.sampleRate || 44100;
  const musicSeconds = specDuration(spec);
  // Kit 1.8.0: a declared fx suite extends the tail so echoes and reverb are
  // not cut. fxTailSeconds is 0 with no fx, so historical lengths are unchanged.
  const effectiveFx = spatialFx(spec.fx, spec.mix);
  const fxPlan = effectiveFx ? normalizeFx(effectiveFx, { bpm: spec.tempo }) : null;
  // Kit 1.9.0: the historical budget is a floor, not a ceiling. A score whose
  // longest note rings past it gets a buffer that actually holds the note; a
  // score that already fits keeps its old length and its old bytes, because the
  // max() cannot go down. See specTailOverhangSeconds for the measurement.
  const historicalTail = RETIRE_TAIL
    + Math.max(DEFAULT_REVERB_SECONDS, fxTailSeconds(fxPlan))
    + performanceReleaseTail(spec.performance);
  // Kit 1.12.0: a bright voice's dark tail rings up to its IR length past the note (0 with no bright voice).
  const scoreTail = specTailOverhangSeconds(spec)
    + Math.max(DEFAULT_REVERB_SECONDS, fxTailSeconds(fxPlan), brightTailSeconds(spec));
  const tail = opts.tailSeconds !== undefined
    ? opts.tailSeconds
    : Math.max(historicalTail, scoreTail, timbrePacks ? graphSampleTailSeconds(spec, timbrePacks) : 0);
  const totalSeconds = musicSeconds + tail;
  const length = opts.totalFrames ?? Math.max(1, Math.ceil(totalSeconds * sampleRate));

  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const band = scheduleSpec(spec, ctx, timbrePacks ? { ...opts, timbrePacks } : opts);

  if (band.stepErrors.length > 0) {
    const errors = band.stepErrors;
    band.dispose();
    assertNoStepErrors(errors);
  }

  const audioBuffer = await ctx.startRendering();
  band.dispose();
  return audioBuffer;
}

/** Render a spec and return 16-bit PCM WAV bytes (Buffer). */
export async function renderSpecToWav(spec, opts = {}) {
  requireValidatedScoreArtifact(spec);
  if (!isNativeKitVersion(spec.kitVersion)) {
    const old = await historical(spec);
    const result = await old.renderer.renderSpecToWav(old.artifact, opts);
    if (!spec.audition) return result;
    return { wav: result.wav, manifest: { ...result.manifest, artifactSha256: (await import('./provenance.mjs')).sha256((await import('./provenance.mjs')).canonicalJson(spec)), shipping: { shippable: false, reason: 'audition-only rebase: shipping promotion blocked' }, audition: spec.audition } };
  }
  if (!hasSampleVoices(spec) || usesGraphSamples(spec)) {
    const buffer = await renderSpec(spec, opts);
    const wav = encodeWav(buffer);
    return Object.freeze({ wav, manifest: createWavManifest(spec, wav, buffer) });
  }

  const plan = sampleRenderPlan(spec, opts.samplePack, opts);
  const buffer = hasSynthEvents(spec, opts.voice)
    ? await renderSpec(spec, { ...opts, totalFrames: plan.totalFrames, excludeSampleVoices: true })
    : silentStereoBuffer(plan.totalFrames);
  const sampleBus = renderSampleBus(plan);
  const wav = Buffer.from(encodeCustodyMix(buffer, sampleBus));
  const samples = Object.freeze({
    rendererVersion: plan.rendererVersion,
    packId: opts.samplePack.manifest.packId,
    manifestSha256: opts.samplePack.manifest.manifestSha256,
    contentSha256: opts.samplePack.manifest.contentSha256,
    referencedAssets: referencedSampleAssets(spec.sampleVoices),
    integerFrameMix: true,
  });
  return Object.freeze({ wav, manifest: createWavManifest(spec, wav, buffer, { samples }) });
}
