import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineAudioContext } from 'node-web-audio-api';

import {
  midiToFrequency,
  mixSamplerVoiceQ16,
  nearestMidi,
  noteToMidi,
  SAMPLER_Q16,
  samplerRateQ16,
  samplerRateQ16FromFrequency,
  samplerVoiceFrameCount,
  SEMITONE_RATIO_Q16,
  selectSamplerZone,
} from '../src/kit/band.js';
import { renderSpecToWav } from '../src/render.mjs';
import { renderScoreToWav } from '../app/render.mjs';
import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { encodeCanonicalWav, SAMPLE_PACK_VERSION, validateSamplePack } from '../src/sample-pack.mjs';
import { sha256 as browserSha256 } from '../app/provenance.mjs';
import { renderSampleBus, resolveSamplerEvent, sampleRenderPlan } from '../src/sample-render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION, SCHEMA_VERSION } from '../src/version.mjs';
import { buildPack, resolveRootNote, trimCanonical } from '../tools/build-pack.mjs';
import { centsBetween, measureF0, parseRootNoteFromFilename } from '../tools/pitch.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const packRoot = join(root, 'sample-packs', 'sampler-demo-17');
const demoSpecSource = json('examples/sampler-demo-spec.json');
const nodeSha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Deterministic pseudo-audio: an integer sawtooth with a coprime stride. */
function syntheticFrames(count, stride = 733) {
  const frames = new Int16Array(count);
  let phase = 0;
  for (let index = 0; index < count; index++) {
    phase = (phase + stride) % 4096;
    frames[index] = (phase - 2048) * 15;
  }
  return frames;
}

/** An exact-integer sine-free periodic wave for pitch probing. */
function pitchedFrames(frequencyHz, seconds, sampleRate = 44100) {
  const count = Math.round(seconds * sampleRate);
  const frames = new Int16Array(count);
  const period = sampleRate / frequencyHz;
  for (let index = 0; index < count; index++) {
    const position = (index % period) / period;
    // Triangle: strong fundamental, cheap harmonics, no transcendentals.
    frames[index] = Math.round((position < 0.5 ? position * 4 - 1 : 3 - position * 4) * 12000);
  }
  return frames;
}

function encodeFloat32Wav(samples, sampleRate = 44100) {
  const dataBytes = samples.length * 4;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index++) view.setFloat32(44 + index * 4, samples[index], true);
  return bytes;
}

/** Int32 sample bus scaled into Int16 range so the estimator can read it. */
function normalizedBus(bus) {
  let peak = 0;
  for (let index = 0; index < bus.length; index++) peak = Math.max(peak, Math.abs(bus[index]));
  const scale = peak > 32767 ? 32767 / peak : 1;
  const frames = new Int16Array(bus.length);
  for (let index = 0; index < bus.length; index++) frames[index] = Math.round(bus[index] * scale);
  return frames;
}

function oneNoteSpec(voice, note, dur = 3) {
  return validateSpec({
    schemaVersion: SCHEMA_VERSION,
    kitVersion: KIT_VERSION,
    seed: 1,
    tempo: 60,
    sampleRate: 44100,
    gain: 1,
    label: 'sampler pitch probe',
    register: { name: 'probe', briefRef: 'docs/RAY-SAMPLES-TIMBRE-CATALOG-2026-08-29.md' },
    samplePack: demoSpecSource.samplePack,
    sampleVoices: { [voice]: { ...demoSpecSource.sampleVoices[voice], gain: 1 } },
    tracks: { probe: { bpm: 60, len: 16, vol: 1, steps: [{ i: 0, voice, note, dur }] } },
    sections: [{ track: 'probe', bars: 1, fadeIn: 0 }],
  });
}

describe('sampler pitch arithmetic', () => {
  it('pins the Q16 semitone table to the ideal ratios it stands in for', () => {
    assert.deepEqual([...SEMITONE_RATIO_Q16], [
      65536, 69433, 73562, 77936, 82570, 87480,
      92682, 98193, 104032, 110218, 116772, 123715,
    ]);
    for (let semitone = 0; semitone < 12; semitone++) {
      const ideal = SAMPLER_Q16 * Math.pow(2, semitone / 12);
      assert.ok(
        Math.abs(SEMITONE_RATIO_Q16[semitone] - ideal) <= 0.5,
        `semitone ${semitone}: ${SEMITONE_RATIO_Q16[semitone]} is not the nearest integer to ${ideal}`,
      );
    }
  });

  it('derives frequencies without a transcendental call, within a hundredth of a cent', () => {
    assert.equal(midiToFrequency(69), 440);
    for (let midi = 0; midi <= 127; midi++) {
      const ideal = 440 * Math.pow(2, (midi - 69) / 12);
      assert.ok(Math.abs(centsBetween(midiToFrequency(midi), ideal)) < 0.02, `MIDI ${midi} drifts too far`);
    }
    assert.equal(noteToMidi('C3'), 48);
    assert.equal(noteToMidi('G#3'), 56);
    assert.equal(noteToMidi('A4'), 69);
    assert.equal(noteToMidi('H4'), null);
    assert.equal(nearestMidi(440), 69);
  });

  it('keeps octave rates exact powers of two and refuses absurd stretches', () => {
    assert.equal(samplerRateQ16(48, 48), SAMPLER_Q16);
    assert.equal(samplerRateQ16(60, 48), SAMPLER_Q16 * 2);
    assert.equal(samplerRateQ16(72, 48), SAMPLER_Q16 * 4);
    assert.equal(samplerRateQ16(36, 48), SAMPLER_Q16 / 2);
    assert.equal(samplerRateQ16(24, 48), SAMPLER_Q16 / 4);
    assert.equal(samplerRateQ16(49, 48), SEMITONE_RATIO_Q16[1]);
    assert.equal(samplerRateQ16(47, 48), Math.round(SEMITONE_RATIO_Q16[11] / 2));
    assert.throws(() => samplerRateQ16(120, 48), /exceeds/);
    assert.throws(() => samplerRateQ16(0, 60), /exceeds/);
    assert.throws(() => samplerRateQ16(48.5, 48), /integer MIDI/);
    assert.equal(samplerRateQ16FromFrequency(midiToFrequency(60), 48), SAMPLER_Q16 * 2);
  });
});

describe('sampler zone mapping', () => {
  const zones = [
    { lo: 46, hi: 49, rootNote: 48, assetId: 'low', pcmSha256: 'a'.repeat(64) },
    { lo: 50, hi: 53, rootNote: 52, assetId: 'mid', pcmSha256: 'b'.repeat(64) },
    { lo: 54, hi: 58, rootNote: 56, assetId: 'high', pcmSha256: 'c'.repeat(64) },
  ];

  it('selects by coverage and honours both boundaries', () => {
    assert.equal(selectSamplerZone(zones, 46).assetId, 'low');
    assert.equal(selectSamplerZone(zones, 49).assetId, 'low');
    assert.equal(selectSamplerZone(zones, 50).assetId, 'mid');
    assert.equal(selectSamplerZone(zones, 53).assetId, 'mid');
    assert.equal(selectSamplerZone(zones, 54).assetId, 'high');
    assert.equal(selectSamplerZone(zones, 58).assetId, 'high');
    assert.equal(selectSamplerZone(zones, 45), null);
    assert.equal(selectSamplerZone(zones, 59), null);
  });

  it('breaks overlaps by nearest root, not by array order', () => {
    const overlapping = [
      { lo: 40, hi: 60, rootNote: 60, assetId: 'far', pcmSha256: 'a'.repeat(64) },
      { lo: 40, hi: 60, rootNote: 48, assetId: 'near', pcmSha256: 'b'.repeat(64) },
    ];
    assert.equal(selectSamplerZone(overlapping, 47).assetId, 'near');
    assert.equal(selectSamplerZone([...overlapping].reverse(), 47).assetId, 'near');
    const tied = [
      { lo: 40, hi: 60, rootNote: 44, assetId: 'zeta', pcmSha256: 'a'.repeat(64) },
      { lo: 40, hi: 60, rootNote: 52, assetId: 'alpha', pcmSha256: 'b'.repeat(64) },
    ];
    // Equidistant from 48: the lower root wins, so the choice is stable.
    assert.equal(selectSamplerZone(tied, 48).assetId, 'zeta');
    assert.equal(selectSamplerZone([...tied].reverse(), 48).assetId, 'zeta');
  });

  it('rejects a score whose sampler note falls through the zone map', () => {
    const spec = structuredClone(demoSpecSource);
    spec.tracks.turn.steps.push({ i: 30, voice: 'lead', note: 'C7', dur: 0.5 });
    assert.throws(() => validateSpec(spec), /no zone in spec\.sampleVoices\.lead covers MIDI 96/);
  });

  it('resolves a sampler event to the zone root and its Q16 rate', () => {
    const spec = validateSpec(structuredClone(demoSpecSource));
    const exact = resolveSamplerEvent(spec.sampleVoices.pluck, { note: 'C3', dur: 1 }, 'pluck');
    assert.equal(exact.rootNote, 48);
    assert.equal(exact.rateQ16, SAMPLER_Q16);
    const stretched = resolveSamplerEvent(spec.sampleVoices.pluck, { note: 'G3', dur: 1 }, 'pluck');
    assert.equal(stretched.rootNote, 56);
    assert.equal(stretched.rateQ16, samplerRateQ16(55, 56));
  });
});

describe('sampler determinism', () => {
  it('holds a fixed-vector regression hash for the Q16 mixer', () => {
    const frames = syntheticFrames(2000);
    const cases = [
      { rateQ16: SAMPLER_Q16, gainQ16: SAMPLER_Q16 },
      { rateQ16: samplerRateQ16(55, 56), gainQ16: Math.round(0.62 * SAMPLER_Q16) },
      { rateQ16: samplerRateQ16(60, 48), gainQ16: Math.round(1.4 * SAMPLER_Q16) },
      { rateQ16: samplerRateQ16(31, 36), gainQ16: Math.round(0.85 * SAMPLER_Q16) },
    ];
    const hash = createHash('sha256');
    for (const testCase of cases) {
      const bus = new Int32Array(4096);
      mixSamplerVoiceQ16(bus, 7, {
        frames,
        rateQ16: testCase.rateQ16,
        gainQ16: testCase.gainQ16,
        gateFrames: 1500,
        releaseFrames: 441,
        fadeFrames: 64,
        fadeOriginFrame: 0,
      });
      hash.update(new Uint8Array(bus.buffer, bus.byteOffset, bus.byteLength));
    }
    assert.equal(hash.digest('hex'), '54c20cfc33e4bc3dad8343f634b2fe08f6567d9db2af7a408c14f8a3d15bd498');
  });

  it('reduces to the byte-identical 1:1 copy at unity rate with no gate', () => {
    const frames = syntheticFrames(900);
    const gainQ16 = Math.round(0.73 * SAMPLER_Q16);
    const viaMixer = new Int32Array(1200);
    mixSamplerVoiceQ16(viaMixer, 30, {
      frames, rateQ16: SAMPLER_Q16, gainQ16, gateFrames: null, releaseFrames: 0, fadeFrames: 0, fadeOriginFrame: 0,
    });

    // Independent reimplementation of the pack-format-1.0.0 one-shot path.
    const legacy = new Int32Array(1200);
    const roundSigned = (value) => (value < 0 ? -Math.round(-value) : Math.round(value));
    for (let index = 0; index < frames.length; index++) {
      const out = 30 + index;
      if (out >= legacy.length) break;
      legacy[out] += roundSigned((frames[index] * gainQ16) / SAMPLER_Q16);
    }
    assert.deepEqual(viaMixer, legacy);
  });

  it('re-renders the demo score to the same bytes twice', async () => {
    const pack = await loadSamplePackDirectory(packRoot);
    const first = await renderSpecToWav(validateSpec(structuredClone(demoSpecSource)), { samplePack: pack });
    const second = await renderSpecToWav(validateSpec(structuredClone(demoSpecSource)), { samplePack: pack });
    assert.equal(nodeSha256(first.wav), nodeSha256(second.wav));
    assert.equal(first.manifest.output.sha256, second.manifest.output.sha256);
  });

  it('gates a sampler note to its authored duration', () => {
    const frames = syntheticFrames(44100);
    const gated = new Int32Array(44100);
    const written = mixSamplerVoiceQ16(gated, 0, {
      frames, rateQ16: SAMPLER_Q16, gainQ16: SAMPLER_Q16, gateFrames: 4410, releaseFrames: 441, fadeFrames: 0, fadeOriginFrame: 0,
    });
    assert.equal(written, 4851);
    assert.equal(gated[4850], 0, 'the release must reach silence');
    assert.equal(gated[4851], 0, 'nothing may sound past the gate');
    assert.equal(samplerVoiceFrameCount(44100, SAMPLER_Q16, 4410, 441), 4851);
    assert.equal(samplerVoiceFrameCount(44100, SAMPLER_Q16 * 2, null, 0), 22050);
  });
});

describe('sampler pitch accuracy', () => {
  let pack;
  before(async () => {
    globalThis.OfflineAudioContext = OfflineAudioContext;
    pack = await loadSamplePackDirectory(packRoot);
  });

  /**
   * The resampler's own error is measured against a PITCH-STABLE source,
   * because that is the only condition under which "source f0 x rate" is a
   * meaningful prediction. Ray's analog material is not pitch-stable: the
   * MS-20 daf bass wanders 23 cents WITHIN one sample and the HUMBUCKER note
   * falls 9 cents across its decay, so a render of those can differ from the
   * whole-file f0 by more than the resampler ever contributes. Measured on the
   * repo's own material, worst case by source class:
   *   synthetic triangle       < 0.4 cents
   *   SNES RHODES (chip)       ~1.4 cents
   *   HUMBUCKER (guitar)       ~1.3 cents
   *   MS-20 square lead        ~2.1 cents
   *   MS-20 daf bass (analog)  ~7.4 cents  <- source drift, not resampling
   */
  it('transposes a pitch-stable reference tone to within half a cent', () => {
    for (const semitones of [-12, -7, -5, -1, 0, 1, 3, 7, 12]) {
      const rootMidi = 57;
      const frames = pitchedFrames(midiToFrequency(rootMidi), 1.5);
      const bus = new Int32Array(66150);
      mixSamplerVoiceQ16(bus, 0, {
        frames,
        rateQ16: samplerRateQ16(rootMidi + semitones, rootMidi),
        gainQ16: SAMPLER_Q16,
        gateFrames: null,
        releaseFrames: 0,
        fadeFrames: 0,
        fadeOriginFrame: 0,
      });
      const rendered = new Int16Array(bus.length);
      for (let index = 0; index < bus.length; index++) rendered[index] = Math.max(-32768, Math.min(32767, bus[index]));
      const measured = measureF0(rendered, 44100);
      const cents = Math.abs(centsBetween(measured.frequencyHz, midiToFrequency(rootMidi + semitones)));
      assert.ok(cents < 0.5, `${semitones} semitones landed ${cents.toFixed(3)} cents off`);
    }
  });

  it('holds the chip multisample to under two cents across its whole zone map', async () => {
    for (const note of ['C2', 'G2', 'D#3', 'A#3', 'C4', 'D#4', 'A#3']) {
      const spec = oneNoteSpec('bell', note);
      const plan = sampleRenderPlan(spec, pack, { tailSeconds: 0.2 });
      const event = plan.events[0];
      const asset = pack.assets[event.assetId];
      const measured = measureF0(normalizedBus(renderSampleBus(plan)), 44100);
      const expected = (asset.metadata.measuredF0Millihertz / 1000) * (event.rateQ16 / SAMPLER_Q16);
      const cents = Math.abs(centsBetween(measured.frequencyHz, expected));
      assert.ok(cents < 2, `bell ${note}: ${cents.toFixed(2)} cents off the resampled source pitch`);
    }
  });

  it('sounds every zone of every voice at the source pitch times the applied rate', async () => {
    const cases = [
      ['pluck', 'C3'], ['pluck', 'E3'], ['pluck', 'G#3'], ['pluck', 'G3'], ['pluck', 'D3'], ['pluck', 'A#3'],
      ['bell', 'C2'], ['bell', 'G2'], ['bell', 'D#3'], ['bell', 'C4'], ['bell', 'A#3'], ['bell', 'D#4'],
      ['bass', 'C2'], ['bass', 'G1'], ['bass', 'A#1'], ['bass', 'G#1'],
      ['lead', 'C4'], ['lead', 'D#4'], ['lead', 'G4'], ['lead', 'A#4'], ['lead', 'C5'],
    ];
    let worstResampler = 0;
    let worstMusical = 0;
    for (const [voice, note] of cases) {
      const spec = oneNoteSpec(voice, note);
      const plan = sampleRenderPlan(spec, pack, { tailSeconds: 0.2 });
      const event = plan.events[0];
      const asset = pack.assets[event.assetId];
      const measured = measureF0(normalizedBus(renderSampleBus(plan)), 44100);
      assert.ok(measured.confidence > 0.8, `${voice} ${note}: rendered note is not confidently pitched`);
      const expected = (asset.metadata.measuredF0Millihertz / 1000) * (event.rateQ16 / SAMPLER_Q16);
      const resamplerCents = Math.abs(centsBetween(measured.frequencyHz, expected));
      // 8 cents is the ceiling Ray's least stable analog source imposes, not a
      // resampler budget; the synthetic and chip cases above hold the real bound.
      assert.ok(resamplerCents < 8, `${voice} ${note}: ${resamplerCents.toFixed(2)} cents off the resampled source pitch`);
      // Equal-temperament error is the SOURCE's tuning. The HUMBUCKER files sit
      // 11-20 cents sharp in Ray's library, exactly as the timbre catalog measured.
      const musicalCents = Math.abs(centsBetween(measured.frequencyHz, midiToFrequency(noteToMidi(note))));
      assert.ok(musicalCents < 25, `${voice} ${note}: ${musicalCents.toFixed(2)} cents off equal temperament`);
      worstResampler = Math.max(worstResampler, resamplerCents);
      worstMusical = Math.max(worstMusical, musicalCents);
    }
    assert.ok(worstResampler < 8, `worst resampler error ${worstResampler.toFixed(2)} cents`);
    assert.ok(worstMusical < 25, `worst equal-temperament error ${worstMusical.toFixed(2)} cents`);
  });
});

describe('sampler custody parity', () => {
  before(() => { globalThis.OfflineAudioContext = OfflineAudioContext; });

  it('renders the same bytes through the CLI and browser paths', async () => {
    const nodePack = await loadSamplePackDirectory(packRoot);
    const manifest = json('sample-packs/sampler-demo-17/pack.json');
    const files = new Map(manifest.assets.map((asset) => [
      asset.file,
      new Uint8Array(readFileSync(join(packRoot, asset.file))),
    ]));
    const browserPack = await validateSamplePack(manifest, files, browserSha256);
    const artifact = validateSpec(structuredClone(demoSpecSource));
    const cli = await renderSpecToWav(artifact, { samplePack: nodePack });
    const browser = await renderScoreToWav(artifact, { samplePack: browserPack });
    const browserBytes = new Uint8Array(browser.wav);
    assert.equal(browserBytes.byteLength, cli.wav.length);
    assert.ok(browserBytes.every((byte, index) => byte === cli.wav[index]));
    assert.deepEqual(browser.manifest.samples, cli.manifest.samples);
  });

  it('names every zone asset in the custody sidecar, not just the binding', async () => {
    const pack = await loadSamplePackDirectory(packRoot);
    const { manifest } = await renderSpecToWav(validateSpec(structuredClone(demoSpecSource)), { samplePack: pack });
    assert.equal(manifest.samples.referencedAssets.length, 8);
    assert.equal(manifest.samples.rendererVersion, '1.1.0');
    const bellRows = manifest.samples.referencedAssets.filter((row) => row.voice === 'bell');
    assert.equal(bellRows.length, 3);
    assert.deepEqual(bellRows.map((row) => row.rootNote).sort((a, b) => a - b), [36, 48, 60]);
  });

  it('refuses a sampler binding against a 1.0.0 pack, and a mismatched zone root', async () => {
    const legacy = structuredClone(demoSpecSource);
    legacy.samplePack.formatVersion = '1.0.0';
    assert.throws(() => validateSpec(legacy), /sampler bindings require pack format/);

    const pack = await loadSamplePackDirectory(packRoot);
    const wrongRoot = validateSpec(structuredClone(demoSpecSource));
    const mutated = structuredClone(demoSpecSource);
    mutated.sampleVoices.bass.zones[0].rootNote = 40;
    await assert.rejects(
      () => renderSpecToWav(validateSpec(mutated), { samplePack: pack }),
      /does not match asset root/,
    );
    assert.equal(wrongRoot.sampleVoices.bass.zones[0].rootNote, 36);
  });
});

describe('pack builder root-note verification', () => {
  let workDir;
  before(() => { workDir = mkdtempSync(join(tmpdir(), 'house-band-sampler-')); });

  const buildOne = async (sourceName, bytes, asset) => {
    const inputDir = join(workDir, `in-${asset.id}`);
    const outDir = join(workDir, `out-${asset.id}`);
    rmSync(inputDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    mkdtempSync(inputDir.slice(0, -6));
    writeFileSync(join(workDir, sourceName), bytes);
    const metadataPath = join(workDir, `${asset.id}.build.json`);
    writeFileSync(metadataPath, JSON.stringify({
      packId: `probe-${asset.id}`,
      displayName: 'Probe',
      projectId: 'house-band',
      curator: 'test',
      createdAt: '2026-08-29T00:00:00Z',
      provenance: 'synthetic test fixture',
      attribution: 'synthetic test fixture',
      licenseRef: 'synthetic test fixture',
      sourceCollection: 'synthetic',
      assets: [{ ...asset, sourceFile: sourceName }],
    }));
    return buildPack({ inputDir: workDir, metadataPath, outputDir: outDir });
  };

  it('parses both root-note filename conventions and ignores the rest', () => {
    assert.deepEqual(parseRootNoteFromFilename('HUMBUCKER MF-052-100.wav'), { midi: 52, convention: 'midi-velocity' });
    assert.deepEqual(parseRootNoteFromFilename('a/b/SNES ORGAN-036-100.wav'), { midi: 36, convention: 'midi-velocity' });
    assert.deepEqual(parseRootNoteFromFilename('Sid C4.wav'), { midi: 60, convention: 'note-name' });
    assert.deepEqual(parseRootNoteFromFilename('DX100-F#3.wav'), { midi: 54, convention: 'note-name' });
    assert.equal(parseRootNoteFromFilename('ms20 daf bass1.wav'), null);
  });

  it('trusts the measurement over a lying filename label and records the disagreement', async () => {
    // Audio is A3; the filename claims A4. The From Mars octave-label defect.
    const wav = encodeCanonicalWav(pitchedFrames(midiToFrequency(57), 2));
    const result = await buildOne('Liar A4.wav', wav, {
      id: 'liar', displayName: 'Liar', suggestedVoice: 'sampler', tags: ['probe'],
    });
    const asset = result.manifest.assets[0];
    assert.equal(asset.rootNote, 57);
    assert.equal(asset.rootNoteSource, 'measured-override');
    assert.equal(result.labelDisagreements, 1);
    assert.match(result.warnings[0], /DISAGREEMENT/);
    assert.ok(asset.transformLog.some((line) => /measurement wins/.test(line)));
  });

  it('confirms an honest label, measures an unlabelled source, and honours an operator root', async () => {
    const honest = await buildOne('Honest-057-100.wav', encodeCanonicalWav(pitchedFrames(midiToFrequency(57), 2)), {
      id: 'honest', displayName: 'Honest', suggestedVoice: 'sampler', tags: ['probe'],
    });
    assert.equal(honest.manifest.assets[0].rootNote, 57);
    assert.equal(honest.manifest.assets[0].rootNoteSource, 'filename');
    assert.equal(honest.labelDisagreements, 0);

    const unlabelled = await buildOne('nameless blob.wav', encodeCanonicalWav(pitchedFrames(midiToFrequency(45), 2)), {
      id: 'unlabelled', displayName: 'Unlabelled', suggestedVoice: 'sampler', tags: ['probe'],
    });
    assert.equal(unlabelled.manifest.assets[0].rootNote, 45);
    assert.equal(unlabelled.manifest.assets[0].rootNoteSource, 'measured');

    // An explicit operator root wins, but the disagreement is still surfaced.
    const declared = await buildOne('operator-said.wav', encodeCanonicalWav(pitchedFrames(midiToFrequency(57), 2)), {
      id: 'declared', displayName: 'Declared', suggestedVoice: 'sampler', rootNote: 69, tags: ['probe'],
    });
    assert.equal(declared.manifest.assets[0].rootNote, 69);
    assert.equal(declared.manifest.assets[0].rootNoteSource, 'declared');
    assert.equal(declared.labelDisagreements, 1);
    assert.match(declared.warnings[0], /operator declaration kept/);
  });

  it('converts a 32-bit float source and trims to an embed budget', async () => {
    const seconds = 2;
    const pcm = pitchedFrames(midiToFrequency(57), seconds);
    const floats = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index++) floats[index] = pcm[index] / 32768;
    const result = await buildOne('renoise-float.wav', encodeFloat32Wav(floats), {
      id: 'floatsource', displayName: 'Float source', suggestedVoice: 'sampler', maxSeconds: 0.75, tags: ['probe'],
    });
    const asset = result.manifest.assets[0];
    assert.equal(asset.bitsPerSample, 16);
    assert.equal(asset.frameCount, Math.round(0.75 * 44100));
    assert.equal(asset.rootNote, 57);
    assert.ok(asset.transformLog.some((line) => /format=3/.test(line)));
    assert.ok(asset.transformLog.some((line) => /trimmed 88200 frames to 33075/.test(line)));
  });

  it('fades a trimmed tail to silence rather than cutting it', () => {
    const frames = syntheticFrames(44100);
    const trimmed = trimCanonical(frames, 0.5);
    assert.equal(trimmed.length, 22050);
    assert.equal(trimmed[trimmed.length - 1], 0);
    assert.deepEqual(trimCanonical(frames, 5), frames, 'a budget above the source length is a no-op');
  });

  it('refuses a sampler asset it can neither label nor measure', () => {
    const silence = new Int16Array(44100);
    assert.throws(
      () => resolveRootNote({ id: 'silent', suggestedVoice: 'sampler', sourceFile: 'silent.wav' }, silence, []),
      /no root-note label and no confident pitch measurement/,
    );
    const percussion = resolveRootNote({ id: 'kick', suggestedVoice: 'kick', sourceFile: 'kick.wav' }, silence, []);
    assert.deepEqual(
      { rootNote: percussion.rootNote, rootNoteSource: percussion.rootNoteSource },
      { rootNote: null, rootNoteSource: 'none' },
    );
  });
});

describe('sampler pack format', () => {
  it('builds at 1.1.0, loads generated one-shots, and demands a root for sampler assets', async () => {
    assert.equal(SAMPLE_PACK_VERSION, '1.1.0');
    const oneshots = await loadSamplePackDirectory(join(root, 'sample-packs', 'hb-synth-oneshots'));
    assert.equal(oneshots.manifest.formatVersion, '1.1.0');
    assert.equal(oneshots.manifest.assets[0].rootNote, null);

    const manifest = json('sample-packs/sampler-demo-17/pack.json');
    const files = new Map(manifest.assets.map((asset) => [
      asset.file,
      new Uint8Array(readFileSync(join(packRoot, asset.file))),
    ]));
    assert.equal(manifest.formatVersion, '1.1.0');
    for (const asset of manifest.assets) {
      assert.equal(asset.suggestedVoice, 'sampler');
      assert.ok(Number.isInteger(asset.rootNote));
    }

    const rootless = structuredClone(manifest);
    rootless.assets[0].rootNote = null;
    await assert.rejects(
      () => validateSamplePack(rootless, files, browserSha256),
      /sampler assets require an integer MIDI root/,
    );
  });

  it('records the three SNES RHODES octave-label corrections in the shipped pack', () => {
    const manifest = json('sample-packs/sampler-demo-17/pack.json');
    const overridden = manifest.assets.filter((asset) => asset.rootNoteSource === 'measured-override');
    assert.equal(overridden.length, 3);
    for (const asset of overridden) {
      assert.match(asset.id, /^snes-rhodes-/);
      assert.ok(asset.transformLog.some((line) => /the measurement wins/.test(line)));
    }
    const measured = manifest.assets.filter((asset) => asset.rootNoteSource === 'measured');
    assert.deepEqual(measured.map((asset) => asset.id).sort(), ['ms20-daf-bass', 'ms20-square-lead']);
  });
});
