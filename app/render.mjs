/**
 * Browser offline render: score-spec -> AudioBuffer/WAV via the canonical kit.
 */

import { createBand, LOOKAHEAD, NEUTRAL_DEFAULTS, RETIRE_TAIL, performanceReleaseTail, normalizeFx, spatialFx, fxTailSeconds } from '../src/kit/band.js';
import { compileTrackStep, requireValidatedScoreArtifact, specDuration, specTailOverhangSeconds } from '../src/spec.mjs';
import { createWavManifest } from './provenance.mjs';
import { encodeCustodyMix, hasSampleVoices, hasSynthEvents, referencedSampleAssets, renderSampleBus, sampleRenderPlan, silentStereoBuffer } from '../src/sample-render.mjs';
import { encodeWav } from './wav.mjs';

import { scheduleSpec } from '../src/schedule.mjs';
import { isNativeKitVersion } from '../src/version.mjs';
import { brightTailSeconds, usesGraphSamples } from '../src/timbre.mjs';
import * as historicalKit from '../history/pre-dr5/src/kit/band.js';

const DEFAULT_REVERB_SECONDS = NEUTRAL_DEFAULTS.band.reverb.seconds;

export class RenderError extends Error {
  constructor(errors) {
    super(`strict render failed with ${errors.length} step error${errors.length === 1 ? '' : 's'}`);
    this.name = 'RenderError';
    this.errors = errors;
  }
}

export function assertNoStepErrors(errors) {
  if (errors.length > 0) throw new RenderError(errors);
}

/** Offline render a validated artifact to an AudioBuffer. */
export async function renderScore(artifact, opts = {}) {
  requireValidatedScoreArtifact(artifact);
  const sampleRate = artifact.sampleRate || 44100;
  const musicSeconds = specDuration(artifact);
  const current = isNativeKitVersion(artifact.kitVersion);
  const fx = spatialFx(artifact.fx, artifact.mix);
  const roomTail = Math.max(DEFAULT_REVERB_SECONDS, fxTailSeconds(fx ? normalizeFx(fx, {bpm:artifact.tempo}) : null));
  const tail = opts.tailSeconds !== undefined
    ? opts.tailSeconds
    : current ? Math.max(RETIRE_TAIL + roomTail + performanceReleaseTail(artifact.performance), specTailOverhangSeconds(artifact) + Math.max(roomTail, brightTailSeconds(artifact))) : RETIRE_TAIL + DEFAULT_REVERB_SECONDS + performanceReleaseTail(artifact.performance);
  const totalSeconds = musicSeconds + tail;
  const length = opts.totalFrames ?? Math.max(1, Math.ceil(totalSeconds * sampleRate));

  const OfflineAudioContext = globalThis.OfflineAudioContext;
  if (!OfflineAudioContext) throw new Error('OfflineAudioContext is not available');

  const ctx = new OfflineAudioContext(2, length, sampleRate);
  if (current) {
    const band = scheduleSpec(artifact, ctx, usesGraphSamples(artifact) && opts.samplePack && !opts.timbrePacks
      ? { ...opts, timbrePacks: new Map([[artifact.samplePack.packId, opts.samplePack]]) }
      : opts);
    assertNoStepErrors(band.stepErrors);
    const result = await ctx.startRendering();
    band.dispose();
    return result;
  }
  let now = 0;
  const band = historicalKit.createBand({
    ctx,
    seed: artifact.seed,
    gain: artifact.gain !== undefined ? artifact.gain : 0.5,
    performance: artifact.performance,
    registerClass: artifact.register.class,
    nowFn: () => now,
    strict: true,
    disconnectRetired: false,
  });

  for (const [name, track] of Object.entries(artifact.tracks)) {
    const scheduledTrack = (opts.voice || opts.excludeSampleVoices)
      ? {
          ...track,
          steps: track.steps.filter((event) => {
            const voice = event.voice ?? event.v;
            if (opts.voice && voice !== opts.voice) return false;
            if (opts.excludeSampleVoices && Object.hasOwn(artifact.sampleVoices || {}, voice)) return false;
            return true;
          }),
        }
      : track;
    band.registerTrack(name, {
      bpm: track.bpm ?? artifact.tempo,
      len: track.len | 0,
      vol: track.vol === undefined ? 0.8 : track.vol,
      step: compileTrackStep(scheduledTrack),
    });
  }

  const tickStep = LOOKAHEAD / 2;
  let environmentPass = 0;
  for (let sectionIndex = 0; sectionIndex < artifact.sections.length; sectionIndex++) {
    const sec = artifact.sections[sectionIndex];
    const track = artifact.tracks[sec.track];
    const bpm = track.bpm ?? artifact.tempo;
    const secDur = sec.bars * (16 * (60 / bpm / 4));
    const fadeIn = sec.fadeIn !== undefined ? sec.fadeIn : 0.05;
    if (sec.execution?.kind !== 'intro') environmentPass += 1;
    band.setExecutionContext({
      sectionIndex,
      environmentPass,
      sectionKind: sec.execution?.kind ?? null,
      mutationEvery: sec.execution?.every ?? null,
      mutationId: sec.execution?.id ?? null,
    });
    band.setTrack(sec.track, { fadeIn });
    const end = now + secDur;
    while (now < end) {
      band.tick();
      now = Math.min(end, now + tickStep);
    }
    band.tick();
    now = end;
  }
  const scheduleEnd = now + Math.min(tail, LOOKAHEAD * 4);
  while (now < scheduleEnd) {
    band.tick();
    now += tickStep;
  }

  if (band.stepErrors.length > 0) {
    const errors = band.stepErrors;
    band.dispose();
    assertNoStepErrors(errors);
  }

  const audioBuffer = await ctx.startRendering();
  band.dispose();
  return audioBuffer;
}

/** Render a validated artifact and return WAV bytes + manifest. */
export async function renderScoreToWav(artifact, opts = {}) {
  if (!hasSampleVoices(artifact) || usesGraphSamples(artifact)) {
    const buffer = await renderScore(artifact, opts);
    const wav = encodeWav(buffer);
    const manifest = await createWavManifest(artifact, wav, buffer);
    return { wav, manifest };
  }

  const plan = sampleRenderPlan(artifact, opts.samplePack, opts);
  const buffer = hasSynthEvents(artifact, opts.voice)
    ? await renderScore(artifact, { ...opts, totalFrames: plan.totalFrames, excludeSampleVoices: true })
    : silentStereoBuffer(plan.totalFrames);
  const sampleBus = renderSampleBus(plan);
  const wav = encodeCustodyMix(buffer, sampleBus);
  const samples = Object.freeze({
    rendererVersion: plan.rendererVersion,
    packId: opts.samplePack.manifest.packId,
    manifestSha256: opts.samplePack.manifest.manifestSha256,
    contentSha256: opts.samplePack.manifest.contentSha256,
    referencedAssets: referencedSampleAssets(artifact.sampleVoices),
    integerFrameMix: true,
  });
  const manifest = await createWavManifest(artifact, wav, buffer, { samples });
  return { wav, manifest };
}
