import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { OfflineAudioContext } from 'node-web-audio-api';

import { createBand, noteFreq } from '../src/kit/band.js';
import { renderSpecToWav } from '../src/render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';

function makeRecordingContext() {
  const events = [];
  function recordParam(name) {
    return {
      value: 0,
      setValueAtTime(v, t) { events.push([name, 'set', v, t]); this.value = v; },
      linearRampToValueAtTime(v, t) { events.push([name, 'ramp', v, t]); this.value = v; },
      exponentialRampToValueAtTime(v, t) { events.push([name, 'exp', v, t]); this.value = v; },
      cancelScheduledValues() {},
    };
  }
  const ctx = {
    sampleRate: 44100,
    currentTime: 0,
    destination: {},
    createGain() {
      const gain = recordParam('gain');
      const node = {
        gain,
        connect() {},
        disconnect() {},
      };
      return node;
    },
    createOscillator() {
      const freq = recordParam('frequency');
      const detune = recordParam('detune');
      const node = {
        type: 'sine',
        frequency: freq,
        detune,
        connect() {},
        start() {},
        stop() {},
        setPeriodicWave() {},
      };
      return node;
    },
    createBiquadFilter() {
      return {
        type: 'lowpass',
        frequency: recordParam('filterFreq'),
        Q: recordParam('filterQ'),
        connect() {},
        disconnect() {},
      };
    },
    createBufferSource() {
      return {
        buffer: null,
        loop: false,
        playbackRate: recordParam('playbackRate'),
        connect() {},
        start() {},
        stop() {},
      };
    },
    createPeriodicWave() { return {}; },
    createConvolver() { return null; },
    createBuffer() { throw new Error('no buffer in stub'); },
  };
  return { ctx, events };
}

function chipScore(overrides = {}) {
  return {
    schemaVersion: '1.1.0',
    kitVersion: KIT_VERSION,
    seed: 0xc1abf00d,
    tempo: 120,
    sampleRate: 44100,
    gain: 0.5,
    register: { name: 'kit-demo', briefRef: 'docs/REGISTER-KIT-DEMO.md' },
    tracks: {
      chip: {
        bpm: 120,
        len: 16,
        vol: 0.8,
        steps: [],
      },
    },
    sections: [{ track: 'chip', bars: 1, fadeIn: 0.01 }],
    ...overrides,
  };
}

describe('chip voice schema', () => {
  it('accepts chipPulse, chipTriangle, and chipNoise events', () => {
    const spec = chipScore({
      tracks: {
        chip: {
          bpm: 120, len: 16, vol: 0.8,
          steps: [
            { i: 0, voice: 'chipPulse', note: 'C4', dur: 0.25, opts: { duty: 0.25, fx: [{ type: 'arp', intervals: [0, 4, 7] }] } },
            { i: 4, voice: 'chipTriangle', note: 'E4', dur: 0.25, opts: { vibrato: 6, vibratoDepth: 0.005 } },
            { i: 8, voice: 'chipNoise', note: 'G2', dur: 0.15, opts: { mode: 'periodic', cut: 3000 } },
          ],
        },
      },
    });
    const artifact = validateSpec(spec);
    assert.equal(artifact.tracks.chip.steps[0].voice, 'chipPulse');
    assert.equal(artifact.tracks.chip.steps[2].opts.mode, 'periodic');
  });

  it('rejects unknown chip options and bad fx types', () => {
    const spec = chipScore({
      tracks: {
        chip: {
          bpm: 120, len: 16, vol: 0.8,
          steps: [
            { i: 0, voice: 'chipPulse', note: 'C4', dur: 0.25, opts: { badOpt: 1 } },
          ],
        },
      },
    });
    assert.throws(() => validateSpec(spec), /badOpt/);

    const badFx = chipScore({
      tracks: {
        chip: {
          bpm: 120, len: 16, vol: 0.8,
          steps: [
            { i: 0, voice: 'chipPulse', note: 'C4', dur: 0.25, opts: { fx: [{ type: 'magic' }] } },
          ],
        },
      },
    });
    assert.throws(() => validateSpec(badFx), /tracker-fx/);
  });
});

describe('chip voice schedule inspection', () => {
  it('arp emits a cyclic frequency pattern at tick rate', () => {
    const { ctx, events } = makeRecordingContext();
    const band = createBand({ ctx, seed: 1 });
    band.registerTrack('arp', {
      bpm: 120, len: 16,
      step(_i, t, s) {
        if (_i === 0) s.v.chipPulse(t, noteFreq('C4'), 0.18, {
          tickDuration: 0.03,
          fx: [{ type: 'arp', intervals: [0, 4, 7] }],
        });
      },
    });
    band.setTrack('arp');
    band.tick(0);
    band.tick(0.5);
    const ramps = events.filter(([n, kind]) => n === 'frequency' && kind === 'ramp');
    const freqs = ramps.map(([, , v]) => v);
    assert.ok(freqs.length >= 4, 'expected several frequency ramps');
    // The first three distinct target frequencies should be C4, E4, G4.
    const c4 = noteFreq('C4');
    const e4 = noteFreq('E4');
    const g4 = noteFreq('G4');
    assert.ok(freqs.some((f) => Math.abs(f - c4) < 1), 'missing C4');
    assert.ok(freqs.some((f) => Math.abs(f - e4) < 1), 'missing E4');
    assert.ok(freqs.some((f) => Math.abs(f - g4) < 1), 'missing G4');
  });

  it('portamento ramps monotonically toward the target frequency', () => {
    const { ctx, events } = makeRecordingContext();
    const band = createBand({ ctx, seed: 1 });
    const startFreq = noteFreq('C4');
    const targetFreq = noteFreq('G4');
    band.registerTrack('porta', {
      bpm: 120, len: 16,
      step(_i, t, s) {
        if (_i === 0) s.v.chipPulse(t, startFreq, 0.18, {
          tickDuration: 0.03,
          fx: [{ type: 'porta', target: targetFreq, rate: 2 }],
        });
      },
    });
    band.setTrack('porta');
    band.tick(0);
    band.tick(0.5);
    const ramps = events.filter(([n, kind]) => n === 'frequency' && kind === 'ramp');
    const freqs = ramps.map(([, , v]) => v);
    assert.ok(freqs.length >= 2);
    // Every step should move closer to the target (or equal it).
    let last = startFreq;
    for (const f of freqs) {
      const before = Math.abs(last - targetFreq);
      const after = Math.abs(f - targetFreq);
      assert.ok(after <= before + 0.1, `portamento moved away from target: ${last} -> ${f}`);
      last = f;
    }
    assert.ok(Math.abs(last - targetFreq) < 2, 'did not reach target frequency');
  });

  it('note-cut truncates the gain envelope at the requested tick', () => {
    const { ctx, events } = makeRecordingContext();
    const band = createBand({ ctx, seed: 1 });
    band.registerTrack('cut', {
      bpm: 120, len: 16,
      step(_i, t, s) {
        if (_i === 0) s.v.chipPulse(t, noteFreq('C4'), 0.24, {
          tickDuration: 0.04,
          fx: [{ type: 'cut', tick: 3 }],
        });
      },
    });
    band.setTrack('cut');
    band.tick(0);
    band.tick(0.5);
    const gainSets = events.filter(([n, kind]) => n === 'gain' && kind === 'set');
    const cutEvent = gainSets.find(([, , v, time]) => v < 0.001 && time >= 0.12);
    assert.ok(cutEvent, 'gain did not drop to silence at the cut tick');
    // The band schedules the first step at now + 0.03, so a tickDuration of 0.04
    // makes tick 3 land at 0.03 + 3 * 0.04 = 0.15.
    assert.ok(cutEvent[3] >= 0.14 && cutEvent[3] <= 0.16, `cut landed at unexpected time ${cutEvent[3]}`);
  });
});

describe('chip voice offline render', () => {
  it('duty selection measurably changes harmonic content', async () => {
    const base = chipScore({
      tracks: {
        chip: {
          bpm: 120, len: 16, vol: 0.8,
          steps: [{ i: 0, voice: 'chipPulse', note: 'C4', dur: 0.2, opts: { duty: 0.5, vol: 0.2 } }],
        },
      },
      sections: [{ track: 'chip', bars: 1, fadeIn: 0 }],
    });
    const narrow = JSON.parse(JSON.stringify(base));
    narrow.tracks.chip.steps[0].opts.duty = 0.125;

    const a = await renderSpecToWav(validateSpec(base), { tailSeconds: 0.1 });
    const b = await renderSpecToWav(validateSpec(narrow), { tailSeconds: 0.1 });
    assert.notEqual(
      createHash('sha256').update(a.wav).digest('hex'),
      createHash('sha256').update(b.wav).digest('hex'),
      'duty change did not alter rendered PCM',
    );
  });

  it('renders the same chip score byte-identically twice', async () => {
    const spec = chipScore({
      tracks: {
        chip: {
          bpm: 120, len: 16, vol: 0.8,
          steps: [
            { i: 0, voice: 'chipPulse', note: 'C4', dur: 0.2, opts: { duty: 0.25, fx: [{ type: 'arp', intervals: [0, 4, 7] }] } },
            { i: 4, voice: 'chipTriangle', note: 'E4', dur: 0.2, opts: { vibrato: 5, vibratoDepth: 0.004 } },
            { i: 8, voice: 'chipNoise', note: 'G2', dur: 0.15, opts: { mode: 'periodic' } },
          ],
        },
      },
      sections: [{ track: 'chip', bars: 1, fadeIn: 0 }],
    });
    const a = await renderSpecToWav(validateSpec(spec), { tailSeconds: 0.1 });
    const b = await renderSpecToWav(validateSpec(spec), { tailSeconds: 0.1 });
    assert.ok(a.wav.equals(b.wav), 'chip render was not deterministic');
  });

  it('white and periodic noise modes produce different output', async () => {
    const white = chipScore({
      tracks: {
        chip: {
          bpm: 120, len: 16, vol: 0.8,
          steps: [{ i: 0, voice: 'chipNoise', note: 'C4', dur: 0.2, opts: { mode: 'white', vol: 0.2 } }],
        },
      },
      sections: [{ track: 'chip', bars: 1, fadeIn: 0 }],
    });
    const periodic = JSON.parse(JSON.stringify(white));
    periodic.tracks.chip.steps[0].opts.mode = 'periodic';

    const a = await renderSpecToWav(validateSpec(white), { tailSeconds: 0.1 });
    const b = await renderSpecToWav(validateSpec(periodic), { tailSeconds: 0.1 });
    assert.notEqual(
      createHash('sha256').update(a.wav).digest('hex'),
      createHash('sha256').update(b.wav).digest('hex'),
      'noise mode change did not alter rendered PCM',
    );
  });
});

describe('chip voice performance pass', () => {
  it('applies deterministic timing and velocity to chip voices', async () => {
    const score = chipScore({
      performance: {
        humanize: { timingMs: [10, 10], velocity: [0.2, 0.2], swing: 0 },
      },
      tracks: {
        chip: {
          bpm: 120, len: 16, vol: 0.8,
          steps: [{ i: 0, voice: 'chipPulse', note: 'C4', dur: 0.2, opts: { vol: 0.1 } }],
        },
      },
      sections: [{ track: 'chip', bars: 1, fadeIn: 0 }],
    });
    const neutral = JSON.parse(JSON.stringify(score));
    delete neutral.performance;

    const withPerf = await renderSpecToWav(validateSpec(score), { tailSeconds: 0.1 });
    const withoutPerf = await renderSpecToWav(validateSpec(neutral), { tailSeconds: 0.1 });
    assert.notEqual(
      createHash('sha256').update(withPerf.wav).digest('hex'),
      createHash('sha256').update(withoutPerf.wav).digest('hex'),
      'performance pass did not affect chip voice render',
    );
  });
});
