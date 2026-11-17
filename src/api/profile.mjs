import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import { LEGACY_SAMPLE_PACK_VERSION, SAMPLE_RENDERER_VERSION } from '../sample-pack.mjs';
import { KIT_VERSION, SCHEMA_VERSION, SUPPORTED_CURRENT_SCHEMAS } from '../version.mjs';
import { ApiError } from './errors.mjs';

const lockfile = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
const audioEngineVersion = lockfile.packages?.['node_modules/node-web-audio-api']?.version;

export const CUSTODY_PROFILE_ID = 'hb-custody-render/1.0.0';
export const CUSTODY_TAIL_ID = 'hb-custody-tail/1.0.0';
// Content-bound identity works before GS can commit this sandboxed worktree.
// Kit 1.11.0: the named kits and patches (data the kit interprets) are part of what
// produces the audio, so they are part of the renderer's content-bound identity.
const presetFiles = ['src/presets/kits', 'src/presets/patches'].flatMap((dir) => readdirSync(new URL('../../' + dir, import.meta.url))
  .filter((file) => file.endsWith('.mjs')).sort().map((file) => `${dir}/${file}`));
export const RENDERER_SOURCES = Object.freeze(['src/render.mjs','src/schedule.mjs','src/spec.mjs','src/version.mjs','src/wav.mjs','src/kit/band.js','src/kit/prng.js','src/timbre.mjs','src/presets/trims.mjs', ...presetFiles]);
const rendererHash = createHash('sha256');
for (const path of RENDERER_SOURCES) rendererHash.update(path + '\0').update(readFileSync(new URL('../../' + path, import.meta.url))).update('\0');
export const RENDERER_BUILD = `sha256:${rendererHash.digest('hex')}`;

/**
 * @param {string} scoreSchemaVersion
 * @param {false|true|string} samples false for a synthesis-only render, or the
 *   pack format version in play. `true` keeps the pre-1.7.0 call shape and
 *   means the 1.0.0 one-shot format.
 */
export function custodyProfile(scoreSchemaVersion = SCHEMA_VERSION, samples = false) {
  const packFormatVersion = samples === true ? LEGACY_SAMPLE_PACK_VERSION : samples || null;
  return Object.freeze({
    id: CUSTODY_PROFILE_ID,
    profileFormatVersion: '1.0.0',
    renderer: Object.freeze({
      name: 'house-band',
      version: '1.1.0',
      build: RENDERER_BUILD,
      associatedCode: RENDERER_SOURCES,
    }),
    runtime: Object.freeze({ node: 'v25.9.0', operatingSystem: 'darwin', architecture: 'arm64' }),
    webAudioEngine: Object.freeze({ name: 'node-web-audio-api', version: '2.2.0' }),
    audio: Object.freeze({
      sampleRate: 44100,
      channelCount: 2,
      channelLayout: 'interleaved stereo left then right',
      sampleRepresentation: 'signed 16-bit little-endian PCM',
      dither: false,
    }),
    encoder: Object.freeze({ name: 'House Band RIFF/WAVE PCM format 1 encoder', version: RENDERER_BUILD }),
    tail: Object.freeze({ id: CUSTODY_TAIL_ID, seconds: 1.45 }),
    scoreSchemaVersion,
    kit: KIT_VERSION,
    sampleRendererVersion: packFormatVersion ? SAMPLE_RENDERER_VERSION : null,
    m3: packFormatVersion ? Object.freeze({ format: 'house-band-sample-pack', formatVersion: packFormatVersion }) : null,
  });
}

export function custodyAvailability(profile, runtime = process) {
  const checks = Object.freeze({
    profileId: profile?.id === CUSTODY_PROFILE_ID,
    scoreSchemaVersion: SUPPORTED_CURRENT_SCHEMAS.includes(profile?.scoreSchemaVersion),
    node: runtime.version === profile?.runtime?.node,
    operatingSystem: runtime.platform === profile?.runtime?.operatingSystem,
    architecture: runtime.arch === profile?.runtime?.architecture,
    webAudioEngine: audioEngineVersion === profile?.webAudioEngine?.version,
    rendererBuild: profile?.renderer?.build === RENDERER_BUILD,
    encoder: profile?.encoder?.name === 'House Band RIFF/WAVE PCM format 1 encoder'
      && profile?.encoder?.version === RENDERER_BUILD,
    sampleRate: profile?.audio?.sampleRate === 44100,
    channelLayout: profile?.audio?.channelCount === 2
      && profile?.audio?.channelLayout === 'interleaved stereo left then right',
    sampleRepresentation: profile?.audio?.sampleRepresentation === 'signed 16-bit little-endian PCM',
    dither: profile?.audio?.dither === false,
    tail: profile?.tail?.id === CUSTODY_TAIL_ID && profile?.tail?.seconds === 1.45,
    kit: profile?.kit?.semver === KIT_VERSION.semver && profile?.kit?.sha === KIT_VERSION.sha,
  });
  return Object.freeze({ available: Object.values(checks).every(Boolean), checks });
}

export function requireCustodyProfile(profile, runtime = process) {
  const availability = custodyAvailability(profile, runtime);
  if (!availability.available) {
    const unavailableBoundaries = Object.entries(availability.checks)
      .filter(([, available]) => !available)
      .map(([boundary]) => boundary);
    throw new ApiError('TOOLCHAIN_UNAVAILABLE', 'the exact custody-render profile is unavailable', {
      retryable: false,
      stage: 'admitting',
      details: { custodyProfileId: profile?.id, unavailableBoundaries },
    });
  }
  return profile;
}

export const LISTEN_PROFILE_ID = 'hb-listen-render/1.0.0';
export const LISTEN_TAIL_ID = 'hb-listen-tail/1.0.0';
export const LISTEN_PLATFORMS = Object.freeze(['win32/x64', 'linux/x64', 'darwin/arm64', 'darwin/x64']);

function installedAudioEngineVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../node_modules/node-web-audio-api/package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}

/**
 * LISTEN render profile: the same renderer code as custody, on whatever supported
 * runtime is actually running. Never custody: it declares the runtime it ran on and
 * its bytes are not promised to match any custody receipt.
 */
export function listenProfile(scoreSchemaVersion = SCHEMA_VERSION, samples = false, runtime = process) {
  const packFormatVersion = samples === true ? LEGACY_SAMPLE_PACK_VERSION : samples || null;
  return Object.freeze({
    id: LISTEN_PROFILE_ID,
    profileClass: 'listen',
    custody: false,
    profileFormatVersion: '1.0.0',
    renderer: Object.freeze({
      name: 'house-band',
      version: '1.1.0',
      build: RENDERER_BUILD,
      associatedCode: RENDERER_SOURCES,
    }),
    runtime: Object.freeze({ node: runtime.version, operatingSystem: runtime.platform, architecture: runtime.arch }),
    webAudioEngine: Object.freeze({ name: 'node-web-audio-api', version: installedAudioEngineVersion() }),
    audio: Object.freeze({
      sampleRate: 44100,
      channelCount: 2,
      channelLayout: 'interleaved stereo left then right',
      sampleRepresentation: 'signed 16-bit little-endian PCM',
      dither: false,
    }),
    encoder: Object.freeze({ name: 'House Band RIFF/WAVE PCM format 1 encoder', version: RENDERER_BUILD }),
    tail: Object.freeze({ id: LISTEN_TAIL_ID, seconds: 1.45 }),
    scoreSchemaVersion,
    kit: KIT_VERSION,
    sampleRendererVersion: packFormatVersion ? SAMPLE_RENDERER_VERSION : null,
    m3: packFormatVersion ? Object.freeze({ format: 'house-band-sample-pack', formatVersion: packFormatVersion }) : null,
  });
}

export function listenAvailability(profile, runtime = process) {
  const checks = Object.freeze({
    profileId: profile?.id === LISTEN_PROFILE_ID,
    notCustody: profile?.custody === false && profile?.profileClass === 'listen',
    scoreSchemaVersion: SUPPORTED_CURRENT_SCHEMAS.includes(profile?.scoreSchemaVersion),
    declaredRuntimeIsActual: profile?.runtime?.node === runtime.version
      && profile?.runtime?.operatingSystem === runtime.platform
      && profile?.runtime?.architecture === runtime.arch,
    supportedPlatform: LISTEN_PLATFORMS.includes(`${runtime.platform}/${runtime.arch}`),
    webAudioEngine: audioEngineVersion === profile?.webAudioEngine?.version && installedAudioEngineVersion() === audioEngineVersion,
    rendererBuild: profile?.renderer?.build === RENDERER_BUILD,
    encoder: profile?.encoder?.name === 'House Band RIFF/WAVE PCM format 1 encoder'
      && profile?.encoder?.version === RENDERER_BUILD,
    sampleRate: profile?.audio?.sampleRate === 44100,
    channelLayout: profile?.audio?.channelCount === 2
      && profile?.audio?.channelLayout === 'interleaved stereo left then right',
    sampleRepresentation: profile?.audio?.sampleRepresentation === 'signed 16-bit little-endian PCM',
    dither: profile?.audio?.dither === false,
    tail: profile?.tail?.id === LISTEN_TAIL_ID && profile?.tail?.seconds === 1.45,
    kit: profile?.kit?.semver === KIT_VERSION.semver && profile?.kit?.sha === KIT_VERSION.sha,
  });
  return Object.freeze({ available: Object.values(checks).every(Boolean), checks });
}

export function requireListenProfile(profile, runtime = process) {
  const availability = listenAvailability(profile, runtime);
  if (!availability.available) {
    const unavailableBoundaries = Object.entries(availability.checks)
      .filter(([, available]) => !available)
      .map(([boundary]) => boundary);
    throw new ApiError('TOOLCHAIN_UNAVAILABLE', 'the listen-render profile is unavailable on this runtime', {
      retryable: false,
      stage: 'admitting',
      details: { listenProfileId: profile?.id, unavailableBoundaries },
    });
  }
  return profile;
}
