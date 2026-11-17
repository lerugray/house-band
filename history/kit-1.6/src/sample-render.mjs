/** Shared integer-frame one-shot compiler and PCM16 mixer. */

import { CANONICAL_SAMPLE_RATE, SAMPLE_RENDERER_VERSION, assertScorePackMatch } from './sample-pack.mjs';
import { doctrineAdjustment, performanceAdjustment, performanceReleaseTail } from './kit/band.js';

const LEAD_IN_FRAMES = 1323; // Existing scheduler starts the first step at 0.030 s.
const Q16 = 65536;

function clampInt32(value) {
  if (value > 0x7fffffff) return 0x7fffffff;
  if (value < -0x80000000) return -0x80000000;
  return value;
}

function roundSigned(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

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
        const asset = pack.assets[binding.assetId];
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
        const startFrame = Math.max(0, sectionStart + LEAD_IN_FRAMES + Math.round(
          absoluteStep * stepFrames + (adjusted.timeSeconds + doctrine.timeSeconds) * CANONICAL_SAMPLE_RATE,
        ));
        const eventGain = (event.opts ?? event.o)?.vol ?? 1;
        const gain = binding.gain * eventGain * (1 + adjusted.velocity) * (track.vol ?? 0.8) * (artifact.gain ?? 0.5);
        const gainQ16 = Math.round(gain * Q16);
        const entry = Object.freeze({
          sectionIndex,
          track: section.track,
          step: absoluteStep,
          eventIndex,
          voice,
          assetId: binding.assetId,
          startFrame,
          sectionStart,
          fadeFrames,
          gainQ16,
          frames: asset.frames,
        });
        events.push(entry);
        lastSampleFrame = Math.max(lastSampleFrame, startFrame + asset.frames.length);
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

export function renderSampleBus(plan) {
  const mix = new Int32Array(plan.totalFrames);
  for (const event of plan.events) {
    for (let sourceFrame = 0; sourceFrame < event.frames.length; sourceFrame++) {
      const outputFrame = event.startFrame + sourceFrame;
      if (outputFrame >= mix.length) break;
      let value = roundSigned((event.frames[sourceFrame] * event.gainQ16) / Q16);
      if (event.fadeFrames > 0) {
        const fadePosition = outputFrame - event.sectionStart;
        const fadeQ16 = Math.min(Q16, Math.max(0, Math.floor((fadePosition * Q16) / event.fadeFrames)));
        value = roundSigned((value * fadeQ16) / Q16);
      }
      mix[outputFrame] = clampInt32(mix[outputFrame] + value);
    }
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
