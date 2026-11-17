/**
 * Headless offline render: score-spec → AudioBuffer / WAV bytes via the kit.
 */

import { OfflineAudioContext } from 'node-web-audio-api';
import { createBand, LOOKAHEAD, NEUTRAL_DEFAULTS, RETIRE_TAIL, performanceReleaseTail } from './kit/band.js';
import {
  requireValidatedScoreArtifact,
  specDuration,
  compileTrackStep,
} from './spec.mjs';
import { createWavManifest } from './provenance.mjs';
import {
  encodeCustodyMix,
  hasSampleVoices,
  hasSynthEvents,
  renderSampleBus,
  sampleRenderPlan,
  silentStereoBuffer,
} from './sample-render.mjs';
import { encodeWav } from './wav.mjs';

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
  const sampleRate = spec.sampleRate || 44100;
  const musicSeconds = specDuration(spec);
  const tail = opts.tailSeconds !== undefined
    ? opts.tailSeconds
    : RETIRE_TAIL + DEFAULT_REVERB_SECONDS + performanceReleaseTail(spec.performance);
  const totalSeconds = musicSeconds + tail;
  const length = opts.totalFrames ?? Math.max(1, Math.ceil(totalSeconds * sampleRate));

  const ctx = new OfflineAudioContext(2, length, sampleRate);
  let now = 0;
  const band = createBand({
    ctx,
    seed: spec.seed,
    gain: spec.gain !== undefined ? spec.gain : 0.5,
    performance: spec.performance,
    registerClass: spec.register.class,
    nowFn: () => now,
    strict: true,
    disconnectRetired: false,
  });

  for (const [name, track] of Object.entries(spec.tracks)) {
    const scheduledTrack = (opts.voice || opts.excludeSampleVoices)
      ? {
          ...track,
          steps: track.steps.filter((event) => {
            const voice = event.voice ?? event.v;
            if (opts.voice && voice !== opts.voice) return false;
            if (opts.excludeSampleVoices && Object.hasOwn(spec.sampleVoices || {}, voice)) return false;
            return true;
          }),
        }
      : track;
    band.registerTrack(name, {
      bpm: track.bpm ?? spec.tempo,
      len: track.len | 0,
      vol: track.vol === undefined ? 0.8 : track.vol,
      step: compileTrackStep(scheduledTrack),
    });
  }

  // Schedule every step into the offline graph before startRendering().
  // OfflineAudioContext.currentTime stays at 0 until render, so we pass `now`.
  const tickStep = LOOKAHEAD / 2;
  let environmentPass = 0;
  for (let sectionIndex = 0; sectionIndex < spec.sections.length; sectionIndex++) {
    const sec = spec.sections[sectionIndex];
    const track = spec.tracks[sec.track];
    const bpm = track.bpm ?? spec.tempo;
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
    // Advance simulated time so tick's lookahead window covers the section.
    while (now < end) {
      band.tick();
      now = Math.min(end, now + tickStep);
    }
    band.tick();
    now = end;
  }
  // One more stretch so notes near the end get their release into the graph.
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

/** Render a spec and return 16-bit PCM WAV bytes (Buffer). */
export async function renderSpecToWav(spec, opts = {}) {
  if (!hasSampleVoices(spec)) {
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
    referencedAssets: Object.freeze(Object.entries(spec.sampleVoices).map(([voice, binding]) => Object.freeze({
      voice,
      assetId: binding.assetId,
      pcmSha256: binding.pcmSha256,
    }))),
    integerFrameMix: true,
  });
  return Object.freeze({ wav, manifest: createWavManifest(spec, wav, buffer, { samples }) });
}
