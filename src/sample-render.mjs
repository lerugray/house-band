/** Shared integer-frame one-shot compiler and PCM16 mixer. */

import { CANONICAL_SAMPLE_RATE, SAMPLE_RENDERER_VERSION, assertScorePackMatch } from './sample-pack.mjs';
import {
  doctrineAdjustment,
  mixSamplerVoiceQ16,
  nearestMidi,
  noteToMidi,
  performanceAdjustment,
  performanceReleaseTail,
  SAMPLER_MAX_GAIN_Q16,
  samplerRateQ16,
  samplerRateQ16FromFrequency,
  samplerVoiceFrameCount,
  selectSamplerZone,
} from './kit/band.js';

const LEAD_IN_FRAMES = 1323; // Existing scheduler starts the first step at 0.030 s.
const Q16 = 65536;
/** Default sampler note-off fade, in seconds. Short enough not to smear, long enough not to click. */
const DEFAULT_SAMPLER_RELEASE_SECONDS = 0.03;

function floatToPcm16(sample) {
  if (sample > 1) sample = 1;
  else if (sample < -1) sample = -1;
  return sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
}

function eventHits(event, stepIndex) {
  if (event.i !== undefined) return Array.isArray(event.i) ? event.i.includes(stepIndex) : event.i === stepIndex;
  return stepIndex % event.every === 0;
}

function musicalFrames(artifact) {
  let frames = 0;
  for (const section of artifact.sections) {
    const track = artifact.tracks[section.track];
    const bpm = track.bpm ?? artifact.tempo;
    frames += Math.round(section.bars * 16 * (60 / bpm / 4) * CANONICAL_SAMPLE_RATE);
  }
  return frames;
}

/**
 * Custody sidecar rows for the assets a score actually references. Sampler
 * bindings expand to one row per zone so the manifest names every PCM hash the
 * render could have touched, not just the binding.
 */
export function referencedSampleAssets(sampleVoices) {
  const rows = [];
  for (const [voice, binding] of Object.entries(sampleVoices)) {
    if (binding.kind === 'sampler') {
      for (const zone of binding.zones) {
        rows.push(Object.freeze({
          voice,
          assetId: zone.assetId,
          pcmSha256: zone.pcmSha256,
          rootNote: zone.rootNote,
          lo: zone.lo,
          hi: zone.hi,
        }));
      }
      continue;
    }
    rows.push(Object.freeze({ voice, assetId: binding.assetId, pcmSha256: binding.pcmSha256 }));
  }
  return Object.freeze(rows);
}

export function hasSampleVoices(artifact) {
  return Boolean(artifact.sampleVoices && Object.keys(artifact.sampleVoices).length > 0);
}

export function hasSynthEvents(artifact, isolatedVoice = null) {
  const sampleVoices = artifact.sampleVoices || {};
  for (const track of Object.values(artifact.tracks)) {
    for (const event of track.steps) {
      const voice = event.voice ?? event.v;
      if (isolatedVoice && voice !== isolatedVoice) continue;
      if (!Object.hasOwn(sampleVoices, voice)) return true;
    }
  }
  return false;
}

/**
 * Resolve one sampler event to a zone, a Q16 rate, and a gate length.
 *
 * `note` takes the integer-table path (exact semitone ratio). `freq` takes the
 * ratio path, which is still deterministic — `/` and `Math.round` are
 * correctly rounded — but is quantised to Q16 like everything else.
 */
export function resolveSamplerEvent(binding, event, voice) {
  const midi = event.note !== undefined ? noteToMidi(event.note) : nearestMidi(event.freq);
  if (midi === null) throw new Error(`sample voice ${voice}: event pitch does not resolve to a MIDI note`);
  const zone = selectSamplerZone(binding.zones, midi);
  if (!zone) throw new Error(`sample voice ${voice}: no zone covers MIDI ${midi}`);
  const rateQ16 = event.note !== undefined
    ? samplerRateQ16(midi, zone.rootNote)
    : samplerRateQ16FromFrequency(event.freq, zone.rootNote);
  const releaseSeconds = binding.release ?? DEFAULT_SAMPLER_RELEASE_SECONDS;
  return Object.freeze({
    assetId: zone.assetId,
    rootNote: zone.rootNote,
    midi,
    rateQ16,
    gateFrames: Math.max(1, Math.round(event.dur * CANONICAL_SAMPLE_RATE)),
    releaseFrames: Math.max(0, Math.round(releaseSeconds * CANONICAL_SAMPLE_RATE)),
  });
}

export function sampleRenderPlan(artifact, pack, opts = {}) {
  assertScorePackMatch(artifact, pack);
  const isolatedVoice = opts.voice ?? null;
  const events = [];
  let sectionStart = 0;
  let lastSampleFrame = 0;
  let previousTrack = null;
  let consecutiveTrackSteps = 0;
  for (let sectionIndex = 0; sectionIndex < artifact.sections.length; sectionIndex++) {
    const section = artifact.sections[sectionIndex];
    const track = artifact.tracks[section.track];
    const bpm = track.bpm ?? artifact.tempo;
    const stepFrames = (60 / bpm / 4) * CANONICAL_SAMPLE_RATE;
    const sectionSteps = section.bars * 16;
    const continuesTrack = section.track === previousTrack;
    if (!continuesTrack) consecutiveTrackSteps = 0;
    const fadeFrames = continuesTrack ? 0 : Math.round((section.fadeIn ?? 0.05) * CANONICAL_SAMPLE_RATE);
    for (let absoluteStep = 0; absoluteStep < sectionSteps; absoluteStep++) {
      const trackStep = (consecutiveTrackSteps + absoluteStep) % track.len;
      const voiceCalls = Object.create(null);
      for (let eventIndex = 0; eventIndex < track.steps.length; eventIndex++) {
        const event = track.steps[eventIndex];
        const voice = event.voice ?? event.v;
        const binding = artifact.sampleVoices[voice];
        if (!binding || (isolatedVoice && voice !== isolatedVoice) || !eventHits(event, trackStep)) continue;
        const sampler = binding.kind === 'sampler' ? resolveSamplerEvent(binding, event, voice) : null;
        const asset = pack.assets[sampler ? sampler.assetId : binding.assetId];
        const call = voiceCalls[voice] ?? 0;
        voiceCalls[voice] = call + 1;
        const adjusted = artifact.performance
          ? performanceAdjustment(artifact.performance, {
              seed: artifact.seed,
              absoluteStep: consecutiveTrackSteps + absoluteStep,
              stepIndex: trackStep,
              stepSeconds: stepFrames / CANONICAL_SAMPLE_RATE,
              voice,
              call,
            })
          : { timeSeconds: 0, velocity: 0 };
        const doctrine = artifact.register.class && event.role
          ? doctrineAdjustment(artifact.register.class, event.role)
          : { timeSeconds: 0 };
        const eventOpts = event.opts ?? event.o ?? {};
        const nudgeSeconds = ((event.nudge !== undefined ? event.nudge : eventOpts.nudge) || 0) / 1000;
        const startFrame = Math.max(0, sectionStart + LEAD_IN_FRAMES + Math.round(
          absoluteStep * stepFrames + (adjusted.timeSeconds + doctrine.timeSeconds + nudgeSeconds) * CANONICAL_SAMPLE_RATE,
        ));
        const eventGain = eventOpts.vol ?? 1;
        const gain = binding.gain * eventGain * (1 + adjusted.velocity) * (track.vol ?? 0.8) * (artifact.gain ?? 0.5);
        const gainQ16 = Math.round(gain * Q16);
        if (Math.abs(gainQ16) > SAMPLER_MAX_GAIN_Q16) {
          throw new Error(`sample voice ${voice}: combined gain leaves the exact-integer mix range`);
        }
        const rateQ16 = sampler ? sampler.rateQ16 : Q16;
        const gateFrames = sampler ? sampler.gateFrames : null;
        const releaseFrames = sampler ? sampler.releaseFrames : 0;
        const entry = Object.freeze({
          sectionIndex,
          track: section.track,
          step: absoluteStep,
          eventIndex,
          voice,
          assetId: sampler ? sampler.assetId : binding.assetId,
          rootNote: sampler ? sampler.rootNote : null,
          midi: sampler ? sampler.midi : null,
          rateQ16,
          gateFrames,
          releaseFrames,
          startFrame,
          sectionStart,
          fadeFrames,
          gainQ16,
          frames: asset.frames,
        });
        events.push(entry);
        lastSampleFrame = Math.max(
          lastSampleFrame,
          startFrame + samplerVoiceFrameCount(asset.frames.length, rateQ16, gateFrames, releaseFrames),
        );
      }
    }
    sectionStart += Math.round(sectionSteps * stepFrames);
    consecutiveTrackSteps += sectionSteps;
    previousTrack = section.track;
  }
  const tailSeconds = opts.tailSeconds === undefined ? 1.45 + performanceReleaseTail(artifact.performance) : opts.tailSeconds;
  const legacyFrames = Math.max(1, Math.ceil((musicalFrames(artifact) / CANONICAL_SAMPLE_RATE + tailSeconds) * CANONICAL_SAMPLE_RATE));
  return Object.freeze({
    rendererVersion: SAMPLE_RENDERER_VERSION,
    events: Object.freeze(events),
    totalFrames: Math.max(legacyFrames, lastSampleFrame, 1),
    musicalFrames: musicalFrames(artifact),
    lastSampleFrame,
  });
}

/**
 * Integer sample bus. Every event goes through the kit's Q16 mixer; a one-shot
 * drum is just the rateQ16 === 65536, no-gate case, which the mixer reduces to
 * the byte-identical 1:1 copy that pack format 1.0.0 shipped.
 */
export function renderSampleBus(plan) {
  const mix = new Int32Array(plan.totalFrames);
  for (const event of plan.events) {
    mixSamplerVoiceQ16(mix, event.startFrame, {
      frames: event.frames,
      rateQ16: event.rateQ16,
      gainQ16: event.gainQ16,
      gateFrames: event.gateFrames,
      releaseFrames: event.releaseFrames,
      fadeFrames: event.fadeFrames,
      fadeOriginFrame: event.sectionStart,
    });
  }
  return mix;
}

/** Encode stereo PCM16 after adding the mono integer sample bus to both sides. */
export function encodeCustodyMix(audioBuffer, sampleBus) {
  const frameCount = sampleBus.length;
  if (audioBuffer.sampleRate !== CANONICAL_SAMPLE_RATE || audioBuffer.numberOfChannels !== 2 || audioBuffer.length !== frameCount) {
    throw new Error('custody mixer: synth buffer must be stereo 44100 Hz and frame-aligned');
  }
  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.getChannelData(1);
  const dataBytes = frameCount * 4;
  const out = new ArrayBuffer(44 + dataBytes);
  const bytes = new Uint8Array(out);
  const view = new DataView(out);
  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, CANONICAL_SAMPLE_RATE, true);
  view.setUint32(28, CANONICAL_SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    const sample = sampleBus[frame];
    const l = Math.max(-32768, Math.min(32767, floatToPcm16(left[frame]) + sample));
    const r = Math.max(-32768, Math.min(32767, floatToPcm16(right[frame]) + sample));
    view.setInt16(offset, l, true);
    view.setInt16(offset + 2, r, true);
    offset += 4;
  }
  return out;
}

export function silentStereoBuffer(frameCount) {
  const channels = [new Float32Array(frameCount), new Float32Array(frameCount)];
  return Object.freeze({
    sampleRate: CANONICAL_SAMPLE_RATE,
    numberOfChannels: 2,
    length: frameCount,
    duration: frameCount / CANONICAL_SAMPLE_RATE,
    getChannelData(channel) { return channels[channel]; },
  });
}
