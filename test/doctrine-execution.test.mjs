import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { dataSkip } from './helpers/env.mjs';

import {
  createBand,
  doctrineAdjustment,
  REGISTER_CLASSES,
  VOICE_ROLES,
} from '../src/kit/band.js';
import { renderSpecToWav } from '../src/render.mjs';
import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { sampleRenderPlan } from '../src/sample-render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function doctrineScore(registerClass = 'calm') {
  return {
    schemaVersion: '1.1.0',
    kitVersion: KIT_VERSION,
    seed: 0xd0c7_1234,
    tempo: 240,
    sampleRate: 44100,
    gain: 0.35,
    register: {
      name: 'doctrine-proof',
      briefRef: 'docs/REGISTER-KIT-DEMO.md',
      class: registerClass,
      ...(registerClass === 'calm' ? { salientEventsPerMinute: 24 } : {}),
    },
    tracks: {
      body: {
        bpm: 240,
        len: 16,
        vol: 0.8,
        steps: [
          { i: [0, 8], voice: 'drone', role: 'bass-pedal', note: 'C2', dur: 0.4, opts: { vol: 0.04, verb: 0 } },
          { every: 4, voice: 'pluck', role: 'inner-rhythm', note: 'G4', dur: 0.08, opts: { vol: 0.04, verb: 0 } },
          { i: [4, 12], voice: 'lead', role: 'lead', note: 'E4', dur: 0.2, opts: { vol: 0.04, verb: 0, r: 0.2 } },
        ],
      },
      bodyColor: {
        bpm: 240,
        len: 16,
        vol: 0.8,
        steps: [
          { i: [0, 8], voice: 'drone', role: 'bass-pedal', note: 'C2', dur: 0.4, opts: { vol: 0.04, verb: 0 } },
          { every: 4, voice: 'pluck', role: 'inner-rhythm', note: 'G4', dur: 0.08, opts: { vol: 0.04, verb: 0 } },
          { i: 12, voice: 'bell', role: 'harmonic-color', note: 'D5', dur: 0.15, opts: { vol: 0.025, verb: 0 } },
        ],
      },
    },
    sections: [
      { track: 'body', bars: 1, harmonicClaim: 'new', execution: { kind: 'body' } },
      { track: 'body', bars: 1, harmonicClaim: 'reuse', execution: { kind: 'body' } },
      { track: 'bodyColor', bars: 1, harmonicClaim: 'reuse', execution: { kind: 'mutation', every: 3, id: 'color-hit' } },
    ],
  };
}

function clockStub() {
  return {
    sampleRate: 44100,
    currentTime: 0,
    destination: {},
    createGain() {
      return {
        gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {}, disconnect() {},
      };
    },
    createDynamicsCompressor() { return null; },
    createBuffer() { throw new Error('no buffer'); },
    createConvolver() { return null; },
  };
}

describe('banked doctrine execution', () => {
  it('exports the eight-role constitution and register-neutral class hooks', () => {
    assert.deepEqual(VOICE_ROLES, [
      'bass-pedal', 'pulse-percussion', 'inner-rhythm', 'lead',
      'countervoice', 'harmonic-color', 'environment-transient', 'reserve',
    ]);
    assert.deepEqual(REGISTER_CLASSES, ['dread', 'calm', 'joy']);
    assert.equal(doctrineAdjustment('dread', 'pulse-percussion').timeSeconds, 0);
    assert.equal(doctrineAdjustment('dread', 'environment-transient').timeSeconds, 0.015);
    assert.equal(doctrineAdjustment('calm', 'countervoice').timeSeconds, 0.015);
    assert.equal(doctrineAdjustment('joy', 'bass-pedal').timeSeconds, -0.01);
    assert.equal(doctrineAdjustment(undefined, undefined).timeSeconds, 0);
  });

  it('validates role-tagged class scores and a lawful authored mutation schedule', { skip: dataSkip('ab-run-2026-08-22/doctrine-preferred-ab.score.json') }, () => {
    assert.doesNotThrow(() => validateSpec(doctrineScore()));

    const preferredB = JSON.parse(readFileSync(join(root, 'ab-run-2026-08-22', 'doctrine-preferred-ab.score.json'), 'utf8'));
    assert.doesNotThrow(() => validateSpec(preferredB), 'the operator-preferred 1.4 doctrine render must remain compatible');

    const missingRole = doctrineScore();
    delete missingRole.tracks.body.steps[0].role;
    assert.throws(() => validateSpec(missingRole), /role: required/);

    const missingBudget = doctrineScore();
    delete missingBudget.register.salientEventsPerMinute;
    assert.throws(() => validateSpec(missingBudget), /salientEventsPerMinute: required/);

    const falseNewMaterial = doctrineScore();
    falseNewMaterial.sections[2].harmonicClaim = 'new';
    assert.throws(() => validateSpec(falseNewMaterial), /must declare "reuse"/);

    const offClock = doctrineScore();
    offClock.sections[2].execution.every = 2;
    assert.throws(() => validateSpec(offClock), /not scheduled on environment pass 3/);
  });

  it('keeps reserve onset occupancy below the structural-accent ceiling', () => {
    const score = doctrineScore('dread');
    score.tracks.body.steps.push({ every: 2, voice: 'bell', role: 'reserve', note: 'C6', dur: 0.05 });
    assert.throws(() => validateSpec(score), /reserve role must remain silent through most/);
  });

  it('exposes micro, phrase, and environment mutation clocks to direct kit scores', () => {
    let now = 2;
    const seen = [];
    const band = createBand({ ctx: clockStub(), nowFn: () => now, lookahead: 0.4 });
    band.registerTrack('body', {
      bpm: 60,
      len: 2,
      step(_index, _time, state) { seen.push(state.clock); },
    });
    band.setExecutionContext({ sectionIndex: 4, environmentPass: 5, sectionKind: 'mutation', mutationEvery: 5, mutationId: 'register-lift' });
    band.setTrack('body');
    now = 2.6;
    band.tick();
    assert.ok(seen.some((clock) => clock.micro === 0 && clock.phrase === 0));
    assert.ok(seen.some((clock) => clock.micro === 0 && clock.phrase === 1));
    assert.ok(seen.every((clock) => clock.environment === 5 && clock.mutationId === 'register-lift'));
    band.dispose();
  });

  it('renders each opted-in class deterministically and audibly distinct from neutral execution', async () => {
    for (const registerClass of REGISTER_CLASSES) {
      const source = doctrineScore(registerClass);
      const first = (await renderSpecToWav(validateSpec(source), { tailSeconds: 0.3 })).wav;
      const second = (await renderSpecToWav(validateSpec(source), { tailSeconds: 0.3 })).wav;
      assert.ok(first.equals(second), `${registerClass} execution changed across identical renders`);

      const neutral = doctrineScore(registerClass);
      delete neutral.register.class;
      delete neutral.register.salientEventsPerMinute;
      const before = (await renderSpecToWav(validateSpec(neutral), { tailSeconds: 0.3 })).wav;
      assert.notEqual(hash(first), hash(before), `${registerClass} hook did not affect PCM`);
    }
  });

  it('supports an authored lead grace inflection without changing the note grid', async () => {
    const plain = doctrineScore();
    const inflected = doctrineScore();
    inflected.tracks.body.steps[2].opts.grace = -1;
    inflected.tracks.body.steps[2].opts.graceTime = 0.045;
    assert.doesNotThrow(() => validateSpec(inflected));

    const plainWav = (await renderSpecToWav(validateSpec(plain), { tailSeconds: 0.3 })).wav;
    const first = (await renderSpecToWav(validateSpec(inflected), { tailSeconds: 0.3 })).wav;
    const second = (await renderSpecToWav(validateSpec(inflected), { tailSeconds: 0.3 })).wav;
    assert.ok(first.equals(second), 'lead grace must remain deterministic');
    assert.notEqual(hash(first), hash(plainWav), 'lead grace must alter rendered PCM');
  });

  it('applies the same class-and-role onset contract to sample-backed custody', async () => {
    const source = JSON.parse(readFileSync(join(root, 'examples', 'm3-sample-spec.json'), 'utf8'));
    source.kitVersion = KIT_VERSION;
    source.register.class = 'calm';
    source.register.salientEventsPerMinute = 20;
    for (const event of source.tracks.sampleProof.steps) {
      event.role = event.voice === 'hat' ? 'inner-rhythm' : 'pulse-percussion';
    }
    const pack = await loadSamplePackDirectory(join(root, 'sample-packs', 'hb-synth-oneshots'));
    const classed = sampleRenderPlan(validateSpec(source), pack);
    const repeat = sampleRenderPlan(validateSpec(source), pack);
    assert.deepEqual(classed.events, repeat.events);

    const neutral = structuredClone(source);
    delete neutral.register.class;
    delete neutral.register.salientEventsPerMinute;
    const baseline = sampleRenderPlan(validateSpec(neutral), pack);
    const classedHat = classed.events.find((event) => event.voice === 'hat');
    const neutralHat = baseline.events.find((event) => event.voice === 'hat');
    assert.equal(classedHat.startFrame - neutralHat.startFrame, Math.round(0.006 * 44100));
  });
});
