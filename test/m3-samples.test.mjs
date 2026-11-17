import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineAudioContext } from 'node-web-audio-api';
import { pinnedSkip, packSkip } from './helpers/env.mjs';

import { renderScoreToWav } from '../app/render.mjs';
import { sha256 as browserSha256 } from '../app/provenance.mjs';
import { renderSpec, renderSpecToWav } from '../src/render.mjs';
import { encodeWav } from '../src/wav.mjs';
import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import {
  manifestIdentityBytes,
  packContentBytes,
  parseCanonicalWav,
  validateSamplePack,
} from '../src/sample-pack.mjs';
import { sampleRenderPlan } from '../src/sample-render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { decodeSourceWav, canonicalizeSource } from '../tools/build-pack.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const sampleSpecSource = json('examples/m3-sample-spec.json');
const legacyDemoSource = json('examples/demo-spec.json');
const expected = json('test/fixtures/m3-sample-output.json');
const packRoot = join(root, 'sample-packs', 'hb-synth-oneshots');
const nodeSha256 = (value) => createHash('sha256').update(value).digest('hex');

function packFiles(manifest) {
  return new Map(manifest.assets.map((asset) => [
    asset.file,
    new Uint8Array(readFileSync(join(packRoot, asset.file))),
  ]));
}

describe('M3 score compatibility matrix', () => {
  it('keeps the captured pre-change 1.0.0 render byte-identical', { skip: pinnedSkip() }, async () => {
    const { wav } = await renderSpecToWav(validateSpec(structuredClone(legacyDemoSource)));
    assert.equal(nodeSha256(wav), expected.legacyDemoOutputSha256);
  });

  /**
   * Kit 1.9.0 changed this golden — the ONLY golden it changes — and this test
   * is the receipt. The render-tail fix must be additive: it may append the tail
   * the old budget cut off, and it may not alter one frame that was already
   * being rendered. If a future change alters the musical content instead of
   * extending it, the prefix comparison reddens here rather than hiding inside a
   * refreshed hash.
   */
  it('appends the cut tail without altering a single rendered frame', { skip: pinnedSkip() }, async () => {
    const spec = validateSpec(structuredClone(legacyDemoSource));
    const before = await renderSpec(spec, { tailSeconds: 1.45 });   // the pre-1.9.0 budget
    const after = await renderSpec(spec);

    assert.equal(before.length, expected.legacyDemoPreKit190Frames);
    assert.ok(after.length > before.length, 'the fix must reserve more room, never less');
    assert.equal(nodeSha256(encodeWav(before)), expected.legacyDemoOutputSha256PreKit190);

    for (let channel = 0; channel < 2; channel++) {
      const old = before.getChannelData(channel);
      const now = after.getChannelData(channel);
      for (let i = 0; i < old.length; i++) {
        if (old[i] !== now[i]) {
          assert.fail(`channel ${channel} frame ${i} changed: ${old[i]} -> ${now[i]}`);
        }
      }
    }

    // And the old file really was stopping mid-decay, which is why it changed.
    const tailRms = (buffer) => {
      const window = Math.round(0.01 * buffer.sampleRate);
      let peak = 0;
      let energy = 0;
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
        for (let i = data.length - window; i < data.length; i++) energy += data[i] * data[i];
      }
      return 20 * Math.log10(Math.sqrt(energy / (2 * window)) / peak);
    };
    assert.ok(tailRms(before) > -40, `the pre-1.9.0 render ended mid-tail (${tailRms(before).toFixed(1)} dB)`);
    assert.ok(tailRms(after) < -90, `the 1.9.0 render must end in silence (${tailRms(after).toFixed(1)} dB)`);
  });

  it('accepts synth-only 1.1.0 and sample-enabled 1.1.0 without weakening 1.0.0', () => {
    const synth11 = structuredClone(legacyDemoSource);
    synth11.schemaVersion = '1.1.0';
    assert.equal(validateSpec(synth11).schemaVersion, '1.1.0');
    assert.deepEqual(validateSpec(structuredClone(sampleSpecSource)).sampleVoices.kick.kind, 'one-shot');

    const legacyWithSamples = structuredClone(sampleSpecSource);
    legacyWithSamples.schemaVersion = '1.0.0';
    assert.throws(() => validateSpec(legacyWithSamples), /unknown field|sample fields/);
  });

  it('rejects mislaned one-shot bindings and synth-only options on sample-backed events', () => {
    // Kit 1.7.0 widened the whitelist to pitched sampler bindings, but a
    // ONE-SHOT binding is still drum-only: a one-shot has no root note, so on
    // a pitched lane it would sound one fixed pitch for every note.
    const wrongVoice = structuredClone(sampleSpecSource);
    wrongVoice.sampleVoices.bass = wrongVoice.sampleVoices.kick;
    delete wrongVoice.sampleVoices.kick;
    assert.throws(() => validateSpec(wrongVoice), /one-shot bindings support only kick, snare, and hat/);

    const synthOption = structuredClone(sampleSpecSource);
    synthOption.tracks.sampleProof.steps[0].opts = { f0: 120 };
    assert.throws(() => validateSpec(synthOption), /unknown field/);
  });
});

describe('M3 canonical sample pack', { skip: packSkip('hb-synth-oneshots') }, () => {
  it('is below 300 KB and validates every exact canonical asset', async () => {
    const pack = await loadSamplePackDirectory(packRoot);
    assert.equal(pack.manifest.assetCount, 3);
    assert.ok(pack.manifest.totalWavBytes < 300 * 1024);
    assert.equal(pack.manifest.provenance, 'generated by tools/make-synth-oneshots.mjs');
    assert.equal(pack.manifest.manifestSha256, expected.packManifestSha256);
    assert.equal(pack.manifest.contentSha256, expected.packContentSha256);
    for (const asset of pack.manifest.assets) {
      const parsed = parseCanonicalWav(readFileSync(join(packRoot, asset.file)), asset.file);
      assert.equal(parsed.sampleRate, 44100);
      assert.equal(parsed.channels, 1);
      assert.equal(parsed.bitsPerSample, 16);
      assert.equal(parsed.frameCount, asset.frameCount);
    }
  });

  it('uses non-self-referential canonical manifest hashing and framed sorted content', async () => {
    const manifest = json('sample-packs/hb-synth-oneshots/pack.json');
    const files = packFiles(manifest);
    const identity = manifestIdentityBytes(manifest);
    const changedSelfHash = { ...manifest, manifestSha256: '0'.repeat(64) };
    assert.deepEqual(manifestIdentityBytes(changedSelfHash), identity);

    const sorted = manifest.assets.map((asset) => [asset.id, files.get(asset.file)]);
    const reversed = [...sorted].reverse();
    assert.deepEqual(packContentBytes(sorted), packContentBytes(reversed));
    assert.equal(nodeSha256(packContentBytes(sorted)), expected.packContentSha256);
  });

  it('validates the same pack with browser SHA-256 and fails closed on tampering', async () => {
    const manifest = json('sample-packs/hb-synth-oneshots/pack.json');
    const files = packFiles(manifest);
    const browserPack = await validateSamplePack(manifest, files, browserSha256);
    assert.equal(browserPack.manifest.manifestSha256, expected.packManifestSha256);

    const tampered = new Map(files);
    const kickPath = manifest.assets.find((asset) => asset.suggestedVoice === 'kick').file;
    const changed = new Uint8Array(tampered.get(kickPath));
    changed[changed.length - 1] ^= 1;
    tampered.set(kickPath, changed);
    await assert.rejects(() => validateSamplePack(manifest, tampered, browserSha256), /SHA-256 mismatch|peak does not match/);
  });

  it('canonicalizes supported WAV input deterministically and rejects unsupported encoding', () => {
    const canonicalBytes = readFileSync(join(packRoot, 'assets', 'kick.wav'));
    const decoded = decodeSourceWav(canonicalBytes, 'fixture.wav');
    const first = canonicalizeSource(decoded, 'fixture.wav');
    const second = canonicalizeSource(decoded, 'fixture.wav');
    assert.deepEqual(first, second);

    const compressed = new Uint8Array(canonicalBytes);
    new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength).setUint16(20, 6, true);
    assert.throws(() => decodeSourceWav(compressed, 'compressed.wav'), /only integer PCM.*IEEE float/);
  });
});

describe('M3 shared custody renderer parity', { skip: packSkip('hb-synth-oneshots') }, () => {
  let nodePack;
  let browserPack;

  before(async () => {
    globalThis.OfflineAudioContext = OfflineAudioContext;
    nodePack = await loadSamplePackDirectory(packRoot);
    const manifest = json('sample-packs/hb-synth-oneshots/pack.json');
    browserPack = await validateSamplePack(manifest, packFiles(manifest), browserSha256);
  });

  it('compiles one-shot starts to exact integer frames and includes tails', () => {
    const artifact = validateSpec(structuredClone(sampleSpecSource));
    const plan = sampleRenderPlan(artifact, nodePack, { tailSeconds: 0.1 });
    assert.equal(plan.events[0].startFrame, 1323);
    assert.ok(plan.events.every((event) => Number.isInteger(event.startFrame)));
    assert.ok(plan.totalFrames >= plan.lastSampleFrame);
    // Synth oneshots are short; asset tails may end inside the bar. The plan must
    // still cover every sample past its start, and the requested 0.1 s render tail.
    const lastStart = Math.max(...plan.events.map((event) => event.startFrame));
    assert.ok(plan.lastSampleFrame > lastStart);
    assert.ok(plan.totalFrames >= plan.musicalFrames + 4410);
  });

  it('locks browser and CLI sample-voiced WAVs to one byte-identical golden', async () => {
    const artifact = validateSpec(structuredClone(sampleSpecSource));
    const cli = await renderSpecToWav(artifact, { samplePack: nodePack });
    const browser = await renderScoreToWav(artifact, { samplePack: browserPack });
    const browserBytes = new Uint8Array(browser.wav);

    assert.equal(cli.wav.length, expected.sampleBytes);
    assert.equal(cli.manifest.render.frames, expected.sampleFrames);
    assert.equal(cli.manifest.output.sha256, expected.sampleOutputSha256);
    assert.equal(browser.manifest.output.sha256, expected.sampleOutputSha256);
    assert.equal(browserBytes.byteLength, cli.wav.length);
    assert.ok(browserBytes.every((byte, index) => byte === cli.wav[index]));
    assert.deepEqual(browser.manifest.samples, cli.manifest.samples);
  });

  it('fails loudly for a missing or mismatched resolved pack', async () => {
    const artifact = validateSpec(structuredClone(sampleSpecSource));
    await assert.rejects(() => renderSpecToWav(artifact), /requires a loaded and validated sample pack/);
    const wrong = structuredClone(sampleSpecSource);
    wrong.samplePack.contentSha256 = '0'.repeat(64);
    await assert.rejects(
      () => renderSpecToWav(validateSpec(wrong), { samplePack: nodePack }),
      /content SHA-256 does not match score/,
    );
  });

  it('keeps forbidden platform sample APIs out of the custody implementation', () => {
    for (const file of ['src/sample-pack.mjs', 'src/sample-render.mjs', 'app/render.mjs', 'src/render.mjs']) {
      const source = readFileSync(join(root, file), 'utf8');
      assert.doesNotMatch(source, /decodeAudioData|AudioBufferSourceNode|playbackRate|\.detune\b/, file);
    }
  });
});
