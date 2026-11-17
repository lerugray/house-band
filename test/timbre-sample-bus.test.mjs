/**
 * Samples get the full chain: a sampled kit lane, a sample-backed patch and a
 * bound sample voice all play THROUGH the band's graph (track bus, per-voice
 * placement, sends, master inserts, glue compressor), exactly like a synth
 * voice. (The Full-Arrangement and Mastering Law: every score gets a mix + FX +
 * mastering pass, sparse and sampled ones included.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { renderSpecToWav } from '../src/render.mjs';
import { SpecError, validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';
import { energy, miniScore, mono, peak, render, sha256, SR, stereo } from './helpers/timbre.mjs';
import { packSkip } from './helpers/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FX = { bpm: 120, delay: { preset: 'eighth', feedback: 0.5, wet: 1 }, reverb: { preset: 'hall', wet: 0.5 } };

// A sampled snare (linndrum: 0.2 s long) on its own, 120 bpm, so an 8th-note echo lands at 0.25 s.
const snare = (opts, extra = {}) => miniScore([{ i: 0, voice: 'snare', opts: { vol: 0.1, ...opts } }], { tempo: 120, bars: 2, extra: { kit: 'linndrum', ...extra } });

describe('a sampled kit lane rides the send effects', () => {
  it('feeds the delay: with a delay send the echo (after the 0.2 s sample has ended) is there; without, it is not', { skip: packSkip('tv-kit-linndrum') }, async () => {
    const dry = mono((await render(snare({ verb: 0 }, { fx: FX }))).wav);
    const wet = mono((await render(snare({ verb: 0, delay: 0.6 }, { fx: FX }))).wav);
    const window = [Math.floor(0.28 * SR), Math.floor(0.46 * SR)];
    assert.ok(energy(dry, ...window) < 1e-6, 'no send, no echo');
    assert.ok(energy(wet, ...window) > 1e-4, 'the echo is audible');
    assert.ok(energy(wet, ...window) > 100 * energy(dry, ...window));
  });

  it('feeds the reverb: a reverb send leaves a tail after the sample ends', { skip: packSkip('tv-kit-linndrum') }, async () => {
    const tail = async (verb) => energy(mono((await render(snare({ verb }, { fx: FX }))).wav), Math.floor(0.45 * SR), Math.floor(1.4 * SR));
    assert.ok((await tail(0.8)) > 20 * (await tail(0)));
  });

  it('feeds the legacy send reverb too (no fx suite declared)', { skip: packSkip('tv-kit-linndrum') }, async () => {
    const tail = async (verb) => energy(mono((await render(snare({ verb }))).wav), Math.floor(0.4 * SR), Math.floor(1.2 * SR));
    assert.ok((await tail(0.8)) > 10 * (await tail(0)));
  });

  it('obeys per-voice placement: mix.voices pan puts the hit on one side', { skip: packSkip('tv-kit-linndrum') }, async () => {
    const side = async (pan) => {
      const { left, right } = stereo((await render(snare({}, { mix: { voices: { snare: { pan } } } }))).wav);
      return { l: energy(left), r: energy(right) };
    };
    const hardLeft = await side(-1);
    const hardRight = await side(1);
    assert.ok(hardLeft.l > 50 * hardLeft.r, 'hard left');
    assert.ok(hardRight.r > 50 * hardRight.l, 'hard right');
  });

  it('is shaped by the master inserts: a master chorus changes the sampled mix', { skip: packSkip('tv-kit-linndrum') }, async () => {
    const plain = (await render(snare({}))).wav;
    const inserted = (await render(snare({}, { fx: { master: { chorus: { wet: 0.5 } } } }))).wav;
    assert.notEqual(sha256(plain), sha256(inserted));
  });

  it('sits on the music bus: score gain and track volume scale the sampled hit like a synth voice', { skip: packSkip('tv-kit-linndrum') }, async () => {
    const rms = async (score) => Math.sqrt(energy(mono((await render(score)).wav)));
    const base = snare({ vol: 0.02 });
    const quieter = structuredClone(base); quieter.gain = 0.25;
    const ratio = (await rms(quieter)) / (await rms(base));
    assert.ok(Math.abs(ratio - 0.5) < 0.03, `gain 0.5 -> 0.25 scales by ${ratio.toFixed(3)}`);
    const trackQuiet = structuredClone(base); trackQuiet.tracks.T.vol = 0.4;
    const trackRatio = (await rms(trackQuiet)) / (await rms(base));
    assert.ok(Math.abs(trackRatio - 0.5) < 0.03, `track vol 0.8 -> 0.4 scales by ${trackRatio.toFixed(3)}`);
  });

  it('applies to sample-backed patches as well', async () => {
    const note = (opts) => miniScore([{ i: 0, voice: 'pluck', note: 'C4', dur: 0.2, opts: { patch: 'humbucker-guitar', ...opts } }], { tempo: 120, bars: 2, track: { len: 32 }, extra: { fx: FX } });
    const tail = async (opts) => energy(mono((await render(note(opts))).wav), Math.floor(2.2 * SR), Math.floor(3.8 * SR));
    assert.ok((await tail({ verb: 0.8 })) > 5 * (await tail({ verb: 0 })));
    const { left, right } = stereo((await render(miniScore([{ i: 0, voice: 'pluck', note: 'C4', dur: 0.2, opts: { patch: 'humbucker-guitar' } }], { tempo: 120, extra: { mix: { voices: { pluck: { pan: -1 } } } } }))).wav);
    assert.ok(energy(left) > 50 * energy(right));
  });
});

describe('bound sample voices (the legacy sampleVoices bindings) on kit 1.11.0', () => {
  const sampler = () => {
    const spec = JSON.parse(readFileSync(join(root, 'examples', 'sampler-demo-spec.json'), 'utf8'));
    spec.kitVersion = { ...KIT_VERSION };
    return spec;
  };
  const pack = () => loadSamplePackDirectory(join(root, 'sample-packs', 'sampler-demo-17'));

  it('without fx, mix or phrase controls they keep the exact integer custody bus', async () => {
    const { manifest } = await renderSpecToWav(validateSpec(sampler()), { samplePack: await pack() });
    assert.equal(manifest.samples.integerFrameMix, true);
    assert.equal(manifest.timbre, undefined);
  });

  it('with fx or mix they are routed through the graph, and the manifest says so', async () => {
    const spec = sampler();
    spec.fx = { master: { chorus: { wet: 0.4 } } };
    const custody = await renderSpecToWav(validateSpec(sampler()), { samplePack: await pack() });
    const graph = await renderSpecToWav(validateSpec(spec), { samplePack: await pack() });
    assert.equal(graph.manifest.timbre.graphSamples, true);
    assert.equal(graph.manifest.samples, undefined, 'not the integer bus');
    assert.notEqual(sha256(graph.wav), sha256(custody.wav));
    assert.ok(mono(graph.wav).every(Number.isFinite) && peak(mono(graph.wav)) > 0.01);
  });

  it('placement reaches bound samples: pan a bound voice hard left', async () => {
    const spec = sampler();
    spec.mix = { voices: { lead: { pan: -1 }, bass: { pan: -1 }, bell: { pan: -1 }, pluck: { pan: -1 } } };
    const { wav } = await renderSpecToWav(validateSpec(spec), { samplePack: await pack() });
    const { left, right } = stereo(wav);
    assert.ok(energy(left) > 50 * energy(right));
  });

  it('sends are accepted on the graph route and refused on the custody route', async () => {
    const withSend = (graph) => {
      const spec = sampler();
      if (graph) spec.fx = { reverb: 'hall' };
      const first = spec.tracks[Object.keys(spec.tracks)[0]].steps.find((e) => Object.hasOwn(spec.sampleVoices, e.voice ?? e.v));
      first.opts = { ...(first.opts ?? first.o ?? {}), verb: 0.5 };
      delete first.o;
      return spec;
    };
    assert.doesNotThrow(() => validateSpec(withSend(true)));
    assert.throws(() => validateSpec(withSend(false)), (e) => e instanceof SpecError && /takes sends only when the score routes samples through the graph/.test(e.message));
  });

  it('the graph route keeps the long sample tail inside the render', async () => {
    const spec = sampler();
    spec.fx = { master: { chorus: { wet: 0.2 } } };
    const { wav } = await renderSpecToWav(validateSpec(spec), { samplePack: await pack() });
    const x = mono(wav);
    assert.ok(peak(x.subarray(x.length - 441)) < 0.003);
  });
});
