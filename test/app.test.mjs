import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { OfflineAudioContext } from 'node-web-audio-api';

import { createTransport, STATE } from '../app/transport.mjs';
import { renderScoreToWav } from '../app/render.mjs';
import { encodeWav as browserEncodeWav, readWavHeader as browserReadWavHeader } from '../app/wav.mjs';
import { canonicalJson, sha256, createWavManifest } from '../app/provenance.mjs';
import { applySpecEdit, diffSpecs, getAtPath, revertSpecPath } from '../app/tweak.mjs';
import { createAcceptedBundle } from '../app/bundle.mjs';
import { readStoredZip } from '../app/zip.mjs';
import { createHandoffBundle } from '../app/handoff.mjs';
import { validateRpp } from '../app/reaper.mjs';
import { encodeWav as nodeEncodeWav, readWavHeader as nodeReadWavHeader } from '../src/wav.mjs';
import { validateSpec, shippingStatus } from '../src/spec.mjs';
import { sha256 as nodeSha256 } from '../src/provenance.mjs';

const demoSpec = JSON.parse(readFileSync(new URL('../examples/demo-spec.json', import.meta.url), 'utf8'));

function makeStubContext() {
  let now = 0;
  const sources = [];
  const ctx = {
    get currentTime() { return now; },
    set currentTime(v) { now = v; },
    destination: {},
    createBufferSource() {
      const s = {
        buffer: null,
        loop: false,
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
        onended: null,
      };
      sources.push(s);
      return s;
    },
  };
  return { ctx, sources };
}

function makeStubBuffer(duration = 10, sampleRate = 44100) {
  return {
    length: Math.floor(duration * sampleRate),
    duration,
    sampleRate,
    numberOfChannels: 2,
    getChannelData() { return new Float32Array(Math.floor(duration * sampleRate)); },
  };
}

describe('transport state machine', () => {
  it('rejects a missing or incomplete AudioContext', () => {
    assert.throws(() => createTransport(null), /AudioContext/);
    assert.throws(() => createTransport({}), /AudioContext/);
  });

  it('starts idle and can load a buffer', () => {
    const { ctx } = makeStubContext();
    const transport = createTransport(ctx);
    assert.equal(transport.state, STATE.IDLE);
    transport.setBuffer(makeStubBuffer(5));
    assert.equal(transport.duration, 5);
    assert.equal(transport.position, 0);
  });

  it('transitions idle -> playing -> idle via play/stop', () => {
    const { ctx } = makeStubContext();
    const states = [];
    const transport = createTransport(ctx, { onStateChange: (s) => states.push(s) });
    transport.setBuffer(makeStubBuffer(4));
    transport.play();
    assert.equal(transport.state, STATE.PLAYING);
    transport.stop();
    assert.equal(transport.state, STATE.IDLE);
    assert.equal(transport.position, 0);
    assert.ok(states.includes(STATE.PLAYING));
    assert.ok(states.includes(STATE.IDLE));
  });

  it('reports position based on context time while playing', () => {
    const { ctx } = makeStubContext();
    const positions = [];
    const transport = createTransport(ctx, { onPosition: (p) => positions.push(p) });
    transport.setBuffer(makeStubBuffer(10));
    transport.play();
    ctx.currentTime = 1.5;
    assert.equal(transport.position, 1.5);
    transport.stop();
    assert.equal(transport.position, 0);
  });

  it('respects seek and clamps to duration', () => {
    const { ctx } = makeStubContext();
    const transport = createTransport(ctx);
    transport.setBuffer(makeStubBuffer(3));
    transport.seek(5);
    assert.equal(transport.position, 3);
    transport.play();
    assert.equal(transport.position, 3); // resumes from pausedAt
    transport.seek(1);
    assert.equal(transport.position, 1);
    transport.stop();
    transport.seek(-1);
    assert.equal(transport.position, 0);
  });

  it('reflects loop flag on the active source', () => {
    const { ctx, sources } = makeStubContext();
    const transport = createTransport(ctx);
    transport.setBuffer(makeStubBuffer(2));
    transport.setLoop(true);
    transport.play();
    assert.equal(transport.loop, true);
    assert.equal(sources[0].loop, true);
    transport.setLoop(false);
    assert.equal(sources[0].loop, false);
    transport.stop();
  });

  it('holds and swaps buffers for A/B compare', () => {
    const { ctx } = makeStubContext();
    const transport = createTransport(ctx);
    const a = makeStubBuffer(4);
    const b = makeStubBuffer(6);
    transport.setBuffer(a);
    transport.holdCurrent();
    transport.setBuffer(b);
    assert.equal(transport.duration, 6);
    transport.swapHeld();
    assert.equal(transport.duration, 4);
    transport.stop();
  });
});

describe('browser render parity', () => {
  before(() => {
    globalThis.OfflineAudioContext = OfflineAudioContext;
  });

  it('renders the demo spec to a valid WAV with matching browser artifact hash', async () => {
    const artifact = validateSpec(structuredClone(demoSpec));
    const { wav, manifest } = await renderScoreToWav(artifact, { tailSeconds: 0.1 });
    const header = browserReadWavHeader(wav);
    assert.equal(header.audioFormat, 1);
    assert.equal(header.numChannels, 2);
    assert.equal(header.sampleRate, 44100);
    assert.equal(header.bitsPerSample, 16);
    assert.ok(wav.byteLength > 44);
    assert.equal(manifest.output.bytes, wav.byteLength);
    assert.equal(manifest.output.sha256, await sha256(new Uint8Array(wav)));
    assert.equal(manifest.output.sha256, nodeSha256(Buffer.from(wav)));
  });

  it('produces the same artifact SHA-256 as the CLI path', async () => {
    const artifact = validateSpec(structuredClone(demoSpec));
    const browserHash = await sha256(canonicalJson(artifact));
    const nodeHash = nodeSha256(canonicalJson(artifact));
    assert.equal(browserHash, nodeHash);
    assert.equal(browserHash.length, 64);
  });
});

describe('browser WAV encoder parity', () => {
  it('matches the Node encoder byte-for-byte for a rendered buffer', async () => {
    const ctx = new OfflineAudioContext(2, 441, 44100);
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    osc.connect(ctx.destination);
    osc.start();
    const buffer = await ctx.startRendering();

    const browserWav = browserEncodeWav(buffer);
    const nodeWav = nodeEncodeWav(buffer);

    assert.equal(browserWav.byteLength, nodeWav.length);
    const browserBytes = new Uint8Array(browserWav);
    assert.ok(browserBytes.every((b, i) => b === nodeWav[i]));

    const h1 = browserReadWavHeader(browserWav);
    const h2 = nodeReadWavHeader(nodeWav);
    assert.equal(h1.numChannels, h2.numChannels);
    assert.equal(h1.sampleRate, h2.sampleRate);
    assert.equal(h1.bitsPerSample, h2.bitsPerSample);
  });
});

describe('spec round-trip', () => {
  it('remains valid after a seed change and JSON serialization', () => {
    const artifact = validateSpec(structuredClone(demoSpec));
    const working = JSON.parse(JSON.stringify(artifact));
    working.seed = (working.seed + 1) >>> 0;
    const roundTripped = validateSpec(working);
    assert.equal(roundTripped.seed, 43);
    assert.equal(roundTripped.schemaVersion, artifact.schemaVersion);
    assert.deepEqual(roundTripped.kitVersion, artifact.kitVersion);
  });

  it('rejects a spec that mutated an unknown field', () => {
    const working = JSON.parse(JSON.stringify(validateSpec(structuredClone(demoSpec))));
    working.promt = 'typo';
    assert.throws(() => validateSpec(working), /unknown field/);
  });

  it('classifies kit-demo as non-shippable in the browser manifest', async () => {
    const artifact = validateSpec(structuredClone(demoSpec));
    const manifest = await createWavManifest(artifact, new ArrayBuffer(44), {
      sampleRate: 44100,
      numberOfChannels: 2,
      length: 441,
    });
    assert.equal(manifest.shipping.shippable, false);
    assert.match(manifest.shipping.reason, /kit-demo/);
  });

  it('agrees with Node shippingStatus', () => {
    const artifact = validateSpec(structuredClone(demoSpec));
    assert.deepEqual(shippingStatus(artifact), {
      shippable: false,
      reason: 'register "kit-demo" is a tooling exercise, not a shippable musical register',
    });
  });
});

describe('Surface B artifact edits', () => {
  const cases = [
    { path: ['tempo'], values: [20, 72.5, 400] },
    { path: ['gain'], values: [0, 0.625, 1] },
    { path: ['tracks', 'pulse', 'bpm'], values: [40, 123.25, 320] },
    { path: ['tracks', 'pulse', 'vol'], values: [0, 0.5, 1] },
    { path: ['tracks', 'pulse', 'steps', 0, 'i'], values: [1, 7, 15] },
    { path: ['tracks', 'pulse', 'steps', 0, 'opts', 'vol'], values: [0, 0.8, 4] },
    { path: ['tracks', 'pulse', 'steps', 3, 'note'], values: ['C1', 'F#2', 'Bb3'] },
    { path: ['tracks', 'pulse', 'steps', 3, 'dur'], values: [0.001, 1.25, 120] },
    { path: ['sections', 0, 'bars'], values: [1, 8, 32] },
    { path: ['sections', 0, 'fadeIn'], values: [0, 1.5, 30] },
  ];

  it('round-trips every exposed edit family through strict validation', () => {
    const loaded = validateSpec(structuredClone(demoSpec));
    for (const { path, values } of cases) {
      for (const value of values) {
        const edited = applySpecEdit(loaded, path, value);
        const roundTripped = validateSpec(JSON.parse(JSON.stringify(edited)));
        assert.deepEqual(getAtPath(roundTripped, path), { exists: true, value });
      }
    }
  });

  it('keeps untouched fields byte-stable for a one-path edit', () => {
    const loaded = validateSpec(structuredClone(demoSpec));
    const edited = applySpecEdit(loaded, ['tracks', 'pulse', 'steps', 3, 'dur'], 0.9);
    const expected = structuredClone(loaded);
    expected.tracks.pulse.steps[3].dur = 0.9;
    assert.equal(JSON.stringify(edited), JSON.stringify(expected));
  });

  it('rejects invalid edits without mutating the prior artifact', () => {
    const loaded = validateSpec(structuredClone(demoSpec));
    const before = JSON.stringify(loaded);
    assert.throws(
      () => applySpecEdit(loaded, ['tracks', 'pulse', 'steps', 0, 'opts', 'vol'], 4.01),
      /must be between 0 and 4/,
    );
    assert.equal(JSON.stringify(loaded), before);
  });

  it('emits path-level diffs and reverts each chip in one operation', () => {
    const loaded = validateSpec(structuredClone(demoSpec));
    let edited = applySpecEdit(loaded, ['tempo'], 112);
    edited = applySpecEdit(edited, ['sections', 0, 'bars'], 3);
    const diffs = diffSpecs(loaded, edited);
    assert.deepEqual(diffs.map((diff) => diff.path), [['tempo'], ['sections', 0, 'bars']]);
    edited = revertSpecPath(loaded, edited, diffs[0].path);
    assert.equal(edited.tempo, loaded.tempo);
    assert.equal(edited.sections[0].bars, 3);
    edited = revertSpecPath(loaded, edited, diffs[1].path);
    assert.deepEqual(edited, loaded);
  });

  it('round-trips section ordering as authored arrangement data', () => {
    const source = structuredClone(demoSpec);
    source.sections = [
      { track: 'pulse', bars: 2, fadeIn: 0.05 },
      { track: 'pulse', bars: 4, fadeIn: 0.2 },
    ];
    const loaded = validateSpec(source);
    const reordered = applySpecEdit(loaded, ['sections'], [...loaded.sections].reverse());
    assert.equal(reordered.sections[0].bars, 4);
    assert.equal(reordered.sections[1].bars, 2);
    assert.deepEqual(validateSpec(JSON.parse(JSON.stringify(reordered))), reordered);
  });
});

describe('Surface C accepted-take bundle', () => {
  it('packages a named/dated spec, WAV, and matching manifest', async () => {
    const artifact = validateSpec(structuredClone(demoSpec));
    const { wav, manifest } = await renderScoreToWav(artifact, { tailSeconds: 0.1 });
    const bundle = await createAcceptedBundle(artifact, wav, manifest, {
      date: new Date(2026, 7, 11, 12, 0, 0),
    });
    assert.equal(bundle.filename, 'house-band-kit-demo-seed-42-2026-08-11.zip');
    const entries = readStoredZip(bundle.bytes);
    assert.deepEqual([...entries.keys()], [
      'house-band-kit-demo-seed-42-2026-08-11.spec.json',
      'house-band-kit-demo-seed-42-2026-08-11.wav',
      'house-band-kit-demo-seed-42-2026-08-11.manifest.json',
    ]);
    const spec = JSON.parse(new TextDecoder().decode(entries.get(bundle.entries[0])));
    const bundledManifest = JSON.parse(new TextDecoder().decode(entries.get(bundle.entries[2])));
    assert.deepEqual(validateSpec(spec), artifact);
    assert.equal(entries.get(bundle.entries[1]).byteLength, wav.byteLength);
    assert.equal(bundledManifest.artifactSha256, manifest.artifactSha256);
    assert.equal(bundledManifest.output.sha256, manifest.output.sha256);
  });

  it('refuses to package a manifest from another artifact or WAV', async () => {
    const artifact = validateSpec(structuredClone(demoSpec));
    const { wav, manifest } = await renderScoreToWav(artifact, { tailSeconds: 0.1 });
    await assert.rejects(
      () => createAcceptedBundle(artifact, wav, { ...manifest, artifactSha256: '0'.repeat(64) }),
      /artifact hash/,
    );
    await assert.rejects(
      () => createAcceptedBundle(artifact, wav.slice(0, -4), manifest),
      /accepted WAV/,
    );
  });
});

describe('Surface D stems and REAPER handoff', () => {
  function compactHandoffSpec() {
    const spec = structuredClone(demoSpec);
    spec.tempo = 400;
    spec.tracks.pulse.bpm = 400;
    spec.tracks.pulse.steps = [spec.tracks.pulse.steps[0], spec.tracks.pulse.steps[3]];
    spec.sections = [
      { track: 'pulse', bars: 1, fadeIn: 0 },
      { track: 'pulse', bars: 2, fadeIn: 0 },
    ];
    return validateSpec(spec);
  }

  it('packages sample-aligned isolated passes, mix, stem manifest, and minimal RPP', async () => {
    const artifact = compactHandoffSpec();
    const bundle = await createHandoffBundle(artifact, {
      date: new Date(2026, 7, 11, 12, 0, 0),
      tailSeconds: 0.1,
    });
    assert.equal(bundle.filename, 'house-band-kit-demo-seed-42-2026-08-11-stems-reaper.zip');
    const entries = readStoredZip(bundle.bytes);
    assert.equal(entries.size, 6);
    assert.ok(entries.has(`${bundle.base}.spec.json`));
    assert.ok(entries.has(`${bundle.base}.mix.wav`));
    assert.ok(entries.has(`${bundle.base}.stem-bass.wav`));
    assert.ok(entries.has(`${bundle.base}.stem-kick.wav`));
    assert.ok(entries.has(`${bundle.base}.stems.manifest.json`));
    assert.ok(entries.has(`${bundle.base}.RPP`));

    const manifest = JSON.parse(new TextDecoder().decode(entries.get(`${bundle.base}.stems.manifest.json`)));
    assert.equal(manifest.kind, 'house-band-stem-set');
    assert.equal(manifest.outputs.stems.length, 2);
    assert.deepEqual(manifest.outputs.stems.map((stem) => stem.voice), ['bass', 'kick']);
    const allOutputs = [manifest.outputs.mix, ...manifest.outputs.stems];
    assert.ok(allOutputs.every((output) => output.startFrame === 0));
    assert.ok(allOutputs.every((output) => output.frames === manifest.render.alignment.frames));
    assert.ok(allOutputs.every((output) => output.bytes === manifest.outputs.mix.bytes));

    const wavHeaders = allOutputs.map((output) => browserReadWavHeader(entries.get(output.filename)));
    assert.ok(wavHeaders.every((header) => header.dataSize === wavHeaders[0].dataSize));
    assert.ok(wavHeaders.every((header) => header.sampleRate === 44100));

    const rpp = new TextDecoder().decode(entries.get(`${bundle.base}.RPP`));
    const structure = validateRpp(rpp, {
      tempo: 400,
      voices: ['bass', 'kick'],
      filenames: [`${bundle.base}.stem-bass.wav`, `${bundle.base}.stem-kick.wav`],
      markers: [{}, {}],
      length: manifest.render.alignment.lengthSeconds,
    });
    assert.deepEqual(
      { tracks: structure.tracks, items: structure.items, sources: structure.sources, markers: structure.markers },
      { tracks: 2, items: 2, sources: 2, markers: 2 },
    );
    assert.match(rpp, /MARKER 1 0 "Section 1 · pulse"/);
    assert.match(rpp, /MARKER 2 0\.6 "Section 2 · pulse"/);
  });

  it('rejects malformed or incomplete RPP structure', () => {
    assert.throws(() => validateRpp('<REAPER_PROJECT 0.1 "7.78" 0\n>'), /newline-terminated/);
    assert.throws(() => validateRpp('<REAPER_PROJECT 0.1 "7.78" 0\n>\n'), /one WAVE item per track/);
  });
});
