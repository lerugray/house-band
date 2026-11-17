import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateSpec, SpecError, shippingStatus, specDuration } from '../src/spec.mjs';
import { assertNoStepErrors, RenderError, renderSpec, renderSpecToWav } from '../src/render.mjs';
import { readWavHeader } from '../src/wav.mjs';
import { sha256 } from '../src/provenance.mjs';
import * as band from '../src/kit/band.js';
import * as prng from '../src/kit/prng.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const demoSpec = JSON.parse(readFileSync(join(root, 'examples/demo-spec.json'), 'utf8'));
const validatedDemo = () => validateSpec(structuredClone(demoSpec));

describe('spec validation', () => {
  it('accepts the demo spec', () => {
    const s = validateSpec(structuredClone(demoSpec));
    assert.equal(s.seed, 42);
    assert.ok(specDuration(s) > 14 && specDuration(s) < 16);
  });

  it('rejects missing seed with a clear error', () => {
    const bad = structuredClone(demoSpec);
    delete bad.seed;
    assert.throws(() => validateSpec(bad), (e) => {
      assert.ok(e instanceof SpecError);
      assert.match(e.message, /seed/);
      return true;
    });
  });

  it('requires a strict register reference', () => {
    const missing = structuredClone(demoSpec);
    delete missing.register;
    assert.throws(() => validateSpec(missing), /spec\.register/);

    const unsafe = structuredClone(demoSpec);
    unsafe.register.briefRef = '../outside.md';
    assert.throws(() => validateSpec(unsafe), /briefRef/);
  });

  it('mechanically marks the reserved kit-demo register non-shippable', () => {
    assert.deepEqual(shippingStatus(validatedDemo()), {
      shippable: false,
      reason: 'register "kit-demo" is a tooling exercise, not a shippable musical register',
    });
  });

  it('rejects unknown voice', () => {
    const bad = structuredClone(demoSpec);
    bad.tracks.pulse.steps.push({ i: 1, voice: 'theremin', note: 'C4', dur: 0.1 });
    assert.throws(() => validateSpec(bad), /voice/);
  });

  it('rejects section pointing at missing track', () => {
    const bad = structuredClone(demoSpec);
    bad.sections[0].track = 'nope';
    assert.throws(() => validateSpec(bad), /unknown track/);
  });

  it('does not resolve inherited object properties as tracks', () => {
    const bad = structuredClone(demoSpec);
    bad.sections[0].track = 'constructor';
    assert.throws(() => validateSpec(bad), /unknown track/);
  });

  it('rejects bad note names', () => {
    const bad = structuredClone(demoSpec);
    bad.tracks.pulse.steps = [{ i: 0, voice: 'bass', note: 'H9', dur: 0.2 }];
    assert.throws(() => validateSpec(bad), /note/);
  });

  it('rejects unknown fields and misspelled voice options', () => {
    const top = structuredClone(demoSpec);
    top.promt = 'typo';
    assert.throws(() => validateSpec(top), /spec\.promt: unknown field/);

    const option = structuredClone(demoSpec);
    option.tracks.pulse.steps[0].opts.velocity = 0.5;
    assert.throws(() => validateSpec(option), /opts\.velocity: unknown field/);
  });

  it('rejects contradictory or dead event selectors', () => {
    const aliases = structuredClone(demoSpec);
    aliases.tracks.pulse.steps[0].v = 'kick';
    assert.throws(() => validateSpec(aliases), /voice or v/);

    const dead = structuredClone(demoSpec);
    dead.tracks.pulse.steps[0].i = 16;
    assert.throws(() => validateSpec(dead), /within track length/);
  });
});

describe('deterministic render', () => {
  it('two renders of the same spec are byte-identical', async () => {
    const a = (await renderSpecToWav(validatedDemo())).wav;
    const b = (await renderSpecToWav(validatedDemo())).wav;
    assert.ok(Buffer.isBuffer(a) && a.length > 44);
    assert.equal(a.length, b.length);
    assert.ok(a.equals(b), 'WAV bytes differ across identical renders');
  });

  it('schedules both sides of an offline multi-section transition', async () => {
    const multi = structuredClone(demoSpec);
    multi.tempo = 240;
    multi.tracks.first = {
      bpm: 240, len: 16, vol: 0.8,
      steps: [{ i: [0, 4, 8, 12], voice: 'kick', opts: { vol: 0.2 } }],
    };
    multi.tracks.second = {
      bpm: 240, len: 16, vol: 0.8,
      steps: [{ i: [0, 4, 8, 12], voice: 'hat', opts: { vol: 0.08 } }],
    };
    delete multi.tracks.pulse;
    multi.sections = [
      { track: 'first', bars: 1, fadeIn: 0.01 },
      { track: 'second', bars: 1, fadeIn: 0.01 },
    ];
    const audio = await renderSpec(validateSpec(multi), { tailSeconds: 0.1 });
    const channel = audio.getChannelData(0);
    const energy = (from, to) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += Math.abs(channel[i]);
      return sum;
    };
    assert.ok(energy(0, 44100) > 1, 'first section was silent');
    assert.ok(energy(44100, 88200) > 1, 'second section was silent');
  });
});

describe('WAV header sanity', () => {
  it('writes a valid 16-bit stereo PCM header', async () => {
    // Shorten for speed: 1 bar only.
    const short = structuredClone(demoSpec);
    short.sections = [{ track: 'pulse', bars: 1, fadeIn: 0.02 }];
    const { wav } = await renderSpecToWav(validateSpec(short), { tailSeconds: 0.5 });
    const h = readWavHeader(wav);
    assert.equal(h.audioFormat, 1);
    assert.equal(h.numChannels, 2);
    assert.equal(h.sampleRate, 44100);
    assert.equal(h.bitsPerSample, 16);
    assert.equal(h.blockAlign, 4);
    assert.equal(h.dataSize + 44, h.fileSize);
  });

  it('rejects unvalidated objects at the render boundary', async () => {
    await assert.rejects(() => renderSpec(structuredClone(demoSpec)), /validated score artifact/);
  });

  it('returns a sidecar manifest with matching custody fields and WAV hash', async () => {
    const artifact = validatedDemo();
    assert.ok(Object.isFrozen(artifact));
    assert.ok(Object.isFrozen(artifact.register));
    const { wav, manifest } = await renderSpecToWav(artifact, { tailSeconds: 0.1 });
    assert.equal(manifest.schemaVersion, artifact.schemaVersion);
    assert.deepEqual(manifest.kitVersion, artifact.kitVersion);
    assert.equal(manifest.seed, artifact.seed);
    assert.deepEqual(manifest.register, artifact.register);
    assert.equal(manifest.output.sha256, sha256(wav));
    assert.equal(manifest.output.bytes, wav.length);
    assert.equal(manifest.shipping.shippable, false);
  });
});

describe('kit-in-browser surface', () => {
  it('exports the recognisable public shape', () => {
    assert.equal(typeof band.createBand, 'function');
    assert.equal(typeof band.noteFreq, 'function');
    assert.equal(typeof band.chord, 'function');
    assert.equal(typeof band.LOOKAHEAD, 'number');
    assert.equal(typeof band.TICK_MS, 'number');
    assert.equal(typeof band.FADE_IN, 'number');
    assert.equal(typeof band.FADE_OUT, 'number');
    assert.equal(typeof band.RETIRE_TAIL, 'number');
    assert.equal(typeof band.NEUTRAL_DEFAULTS, 'object');
    assert.equal(typeof prng.mulberry32, 'function');
    assert.equal(typeof prng.hash2, 'function');
    assert.equal(typeof prng.hashInt, 'function');
  });

  it('createBand still requires an injected ctx (does not construct its own)', () => {
    assert.throws(() => band.createBand({}), /AudioContext/);
    assert.throws(() => band.createBand(), /AudioContext/);
  });

  it('createBand accepts a stub AudioContext-like object', () => {
    const stub = {
      sampleRate: 44100,
      currentTime: 0,
      destination: {},
      createGain() {
        return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} }, connect() {}, disconnect() {} };
      },
      createDynamicsCompressor() {
        return {
          threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
          attack: { value: 0 }, release: { value: 0 }, connect() {},
        };
      },
      createBiquadFilter() {
        return { type: 'lowpass', frequency: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, Q: { value: 0 }, connect() {} };
      },
      createOscillator() {
        return {
          type: 'sine',
          frequency: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
          detune: { value: 0 },
          connect() {}, start() {}, stop() {},
        };
      },
      createBuffer() { throw new Error('no buffer in stub'); },
      createConvolver() { return null; },
      createBufferSource() {
        return { buffer: null, loop: false, connect() {}, start() {}, stop() {} };
      },
    };
    const b = band.createBand({ ctx: stub, seed: 1 });
    assert.equal(typeof b.registerTrack, 'function');
    assert.equal(typeof b.setTrack, 'function');
    assert.equal(typeof b.tick, 'function');
    assert.equal(typeof b.start, 'function');
    assert.ok(b.voices.pad && b.voices.kick);
    b.dispose();
  });

  it('uses one injected clock for track changes, ticks, and disposal', () => {
    let now = 3;
    const scheduled = [];
    const stub = {
      sampleRate: 44100,
      currentTime: 0,
      destination: {},
      createGain() {
        return {
          gain: {
            value: 1,
            setValueAtTime(value, time) { scheduled.push(['set', value, time]); },
            linearRampToValueAtTime(value, time) { scheduled.push(['linear', value, time]); },
            exponentialRampToValueAtTime() {}, cancelScheduledValues() {},
          },
          connect() {}, disconnect() {},
        };
      },
      createDynamicsCompressor() { return null; },
      createBuffer() { throw new Error('no buffer in clock stub'); },
      createConvolver() { return null; },
    };
    const b = band.createBand({ ctx: stub, seed: 1, nowFn: () => now, fadeIn: 0.5 });
    const stepTimes = [];
    b.registerTrack('clocked', { bpm: 60, len: 16, step(_i, t) { stepTimes.push(t); } });
    b.setTrack('clocked');
    assert.equal(stepTimes[0], 3.03);
    assert.ok(scheduled.some(([kind, , time]) => kind === 'set' && time === 3));
    now = 4;
    b.tick();
    assert.ok(stepTimes.some((time) => time >= 4.03));
    b.dispose();
    assert.ok(scheduled.some(([kind, , time]) => kind === 'set' && time === 4));
  });

  it('collects strict step failures with track, index, absolute step, and time', () => {
    const stub = {
      sampleRate: 44100, currentTime: 0, destination: {},
      createGain() {
        return {
          gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} },
          connect() {}, disconnect() {},
        };
      },
      createDynamicsCompressor() { return null; },
      createBuffer() { throw new Error('no buffer'); },
      createConvolver() { return null; },
    };
    const b = band.createBand({ ctx: stub, strict: true, nowFn: () => 2 });
    b.registerTrack('broken', { bpm: 60, len: 16, step() { throw new Error('bad voice option'); } });
    b.setTrack('broken');
    assert.equal(b.stepErrors.length, 1);
    assert.match(b.stepErrors[0].message, /track "broken" step 0 \(absolute 0, t=2\.030000\): bad voice option/);
    assert.throws(() => assertNoStepErrors(b.stepErrors), (error) => {
      assert.ok(error instanceof RenderError);
      assert.match(error.errors[0].message, /track "broken" step 0/);
      return true;
    });
    b.dispose();
  });

  it('noteFreq never substitutes A4 for invalid input', () => {
    assert.throws(() => band.noteFreq('H9'), /invalid note name/);
    assert.throws(() => band.noteFreq(Number.NaN), /positive finite/);
  });
});
