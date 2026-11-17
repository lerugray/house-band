/**
 * Noncanonical derivative render processor.
 *
 * Derivative renders are explicit post-render alternates: a complete recipe
 * names the renderer, source score artifact, and every byte-affecting output
 * parameter. The derivative output is never compared to the canonical song WAV
 * hash and is never represented as canonical replay.
 */

import { readWavHeader } from '../wav.mjs';
import { renderSpecToWav } from '../render.mjs';
import { ApiError } from './errors.mjs';

const SUPPORTED_BIT_DEPTHS = new Set([8, 16, 24]);
const SUPPORTED_CHANNEL_LAYOUTS = new Set(['mono', 'stereo']);

export class DerivativeRecipeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DerivativeRecipeError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new DerivativeRecipeError(message);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Validate a derivative recipe against the canonical score identity.
 * The recipe must enumerate every byte-affecting parameter.
 */
export function validateDerivativeRecipe(recipe, sourceArtifactSha256) {
  assert(isObject(recipe), 'derivativeRecipe must be an object');
  assert(typeof recipe.rendererIdentity === 'string' && recipe.rendererIdentity.length > 0,
    'derivativeRecipe.rendererIdentity must be a non-empty string');
  assert(typeof recipe.sourceArtifactSha256 === 'string' && recipe.sourceArtifactSha256.length === 64,
    'derivativeRecipe.sourceArtifactSha256 must be a SHA-256 hex string');
  assert(recipe.sourceArtifactSha256 === sourceArtifactSha256,
    'derivativeRecipe.sourceArtifactSha256 must equal the canonical score artifactSha256');
  assert(isObject(recipe.output), 'derivativeRecipe.output must be an object');
  const output = recipe.output;
  assert(Number.isInteger(output.sampleRate) && output.sampleRate >= 1,
    'derivativeRecipe.output.sampleRate must be a positive integer');
  assert(SUPPORTED_BIT_DEPTHS.has(output.bitDepth),
    'derivativeRecipe.output.bitDepth must be one of 8, 16, or 24');
  assert(SUPPORTED_CHANNEL_LAYOUTS.has(output.channelLayout),
    'derivativeRecipe.output.channelLayout must be mono or stereo');
  assert(typeof output.tailSeconds === 'number' && Number.isFinite(output.tailSeconds) && output.tailSeconds >= 0,
    'derivativeRecipe.output.tailSeconds must be a finite non-negative number');
  return Object.freeze({
    rendererIdentity: recipe.rendererIdentity,
    sourceArtifactSha256: recipe.sourceArtifactSha256,
    output: Object.freeze({
      sampleRate: output.sampleRate,
      bitDepth: output.bitDepth,
      channelLayout: output.channelLayout,
      tailSeconds: output.tailSeconds,
    }),
  });
}

function decodeWavSamples(bytes) {
  const header = readWavHeader(bytes);
  const numFrames = header.dataSize / header.blockAlign;
  const channels = Array.from({ length: header.numChannels }, () => new Float32Array(numFrames));
  const bytesPerSample = header.bitsPerSample / 8;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let channel = 0; channel < header.numChannels; channel++) {
      const offset = 44 + frame * header.blockAlign + channel * bytesPerSample;
      let sample = 0;
      if (header.bitsPerSample === 8) {
        sample = (bytes.readUInt8(offset) - 128) / 128;
      } else if (header.bitsPerSample === 16) {
        sample = bytes.readInt16LE(offset) / 32768;
      } else if (header.bitsPerSample === 24) {
        const low = bytes.readUInt8(offset);
        const mid = bytes.readUInt8(offset + 1);
        const high = bytes.readInt8(offset + 2);
        const int24 = (high << 16) | (mid << 8) | low;
        sample = int24 / 8388608;
      }
      channels[channel][frame] = clamp(sample, -1, 1);
    }
  }
  return { sampleRate: header.sampleRate, channels };
}

function quantizeSample(sample, bitDepth) {
  if (bitDepth === 8) {
    return Math.round((clamp(sample, -1, 1) + 1) / 2 * 255);
  }
  if (bitDepth === 16) {
    return sample < 0 ? Math.round(clamp(sample, -1, 0) * 0x8000) : Math.round(clamp(sample, 0, 1) * 0x7fff);
  }
  // 24-bit
  return sample < 0 ? Math.round(clamp(sample, -1, 0) * 0x800000) : Math.round(clamp(sample, 0, 1) * 0x7fffff);
}

function resampleChannel(source, sourceRate, targetRate) {
  if (sourceRate === targetRate) return source;
  const ratio = sourceRate / targetRate;
  const targetLength = Math.max(1, Math.round(source.length / ratio));
  const target = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, source.length - 1);
    const frac = pos - i0;
    target[i] = source[i0] * (1 - frac) + source[i1] * frac;
  }
  return target;
}

function applyChannelLayout(channels, layout) {
  if (layout === 'stereo') {
    if (channels.length === 2) return channels;
    return [channels[0], channels[0].slice()];
  }
  // mono
  if (channels.length === 1) return channels;
  const mono = new Float32Array(channels[0].length);
  for (let i = 0; i < mono.length; i++) {
    mono[i] = (channels[0][i] + channels[1][i]) / 2;
  }
  return [mono];
}

function encodeWavBuffer({ sampleRate, channels, bitDepth }) {
  const numChannels = channels.length;
  const numFrames = channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitDepth, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const quantized = quantizeSample(channels[c][i], bitDepth);
      if (bitDepth === 8) {
        buf.writeUInt8(quantized, offset);
      } else if (bitDepth === 16) {
        buf.writeInt16LE(quantized, offset);
      } else {
        buf.writeUInt8(quantized & 0xff, offset);
        buf.writeUInt8((quantized >> 8) & 0xff, offset + 1);
        buf.writeUInt8((quantized >> 16) & 0xff, offset + 2);
      }
      offset += bytesPerSample;
    }
  }
  return buf;
}

function createFloatBuffer(sampleRate, channels) {
  return Object.freeze({
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0].length,
    getChannelData(channel) { return channels[channel]; },
  });
}

/**
 * Render a derivative output from a validated score and pack.
 *
 * If the recipe's tail matches the canonical tail, the canonical mix is used as
 * the source; otherwise a separate source render with the requested tail is made
 * and then transformed. The output is always a fresh noncanonical WAV.
 */
export async function renderDerivative(artifact, recipe, pack = null, canonicalWav = null) {
  const canonicalTailSeconds = 1.45;
  let sourceWav = canonicalWav;
  if (!sourceWav || recipe.output.tailSeconds !== canonicalTailSeconds) {
    const renderOpts = { tailSeconds: recipe.output.tailSeconds };
    if (pack) renderOpts.samplePack = pack;
    const rendered = await renderSpecToWav(artifact, renderOpts);
    sourceWav = rendered.wav;
  }

  let { sampleRate, channels } = decodeWavSamples(sourceWav);
  channels = applyChannelLayout(channels, recipe.output.channelLayout);
  channels = channels.map((channel) => resampleChannel(channel, sampleRate, recipe.output.sampleRate));
  const outputBuffer = createFloatBuffer(recipe.output.sampleRate, channels);
  const wav = encodeWavBuffer({ sampleRate: recipe.output.sampleRate, channels, bitDepth: recipe.output.bitDepth });

  return Object.freeze({
    wav,
    output: Object.freeze({
      sampleRate: recipe.output.sampleRate,
      bitDepth: recipe.output.bitDepth,
      channelLayout: recipe.output.channelLayout,
      tailSeconds: recipe.output.tailSeconds,
      frames: outputBuffer.length,
      rendererIdentity: recipe.rendererIdentity,
    }),
    sourceArtifactSha256: recipe.sourceArtifactSha256,
  });
}

export function derivativeError(cause) {
  if (cause instanceof DerivativeRecipeError) {
    return new ApiError('INVALID_REQUEST', cause.message, { stage: 'admitting', cause });
  }
  if (cause instanceof ApiError) return cause;
  return new ApiError('RENDER_FAILED', `derivative render failed: ${cause?.message || cause}`, { stage: 'rendering', cause });
}
