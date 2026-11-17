/** Named instrument patches (kit 1.11.0 Timbre Range): pad, bass, lead, pluck, bell. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { noteFreq, PATCH_CLASSES, PATCH_ENGINES } from '../src/kit/band.js';
import { PATCH_IDS, PATCH_IDS_BY_CLASS, PATCHES } from '../src/presets/patches/index.mjs';
import { loadCuratedPack } from '../src/sample-pack-node.mjs';
import { SpecError, validateSpec } from '../src/spec.mjs';
import { autocorrF0, cents, energy, miniScore, mono, peak, peakHz, render, sha256, SR } from './helpers/timbre.mjs';

const REPRESENTATIVE = { pad: ['C4', 1.6], bass: ['C2', 0.6], lead: ['C5', 0.8], pluck: ['C4', 0.3], bell: ['C5', 0.5] };
const note = (cls, patch, extra = {}) => {
  const [n, dur] = REPRESENTATIVE[cls];
  return { i: 0, voice: cls, note: n, dur, opts: { ...(patch ? { patch } : {}), ...extra } };
};

describe('the patch registry', () => {
  it('has at least four distinct patches per voice class, across genuinely different synthesis engines', () => {
    for (const cls of PATCH_CLASSES) {
      const ids = PATCH_IDS_BY_CLASS[cls];
      assert.ok(ids.length >= 4, `${cls}: ${ids.length} patches`);
      const engines = new Set(ids.map((id) => PATCHES[id].engine));
      assert.ok(engines.size >= 3, `${cls}: engines ${[...engines].join(', ')}`);
    }
    assert.equal(new Set(PATCH_IDS).size, PATCH_IDS.length);
    const engines = new Set(PATCH_IDS.map((id) => PATCHES[id].engine));
    for (const family of ['fm', 'stack', 'additive', 'formant', 'wash', 'karplus', 'sample']) assert.ok(engines.has(family), `engine family ${family} is represented`);
    assert.ok(PATCH_IDS.length >= 20);
  });

  it('every patch is well-formed data with a name, a description and a known engine', () => {
    for (const id of PATCH_IDS) {
      const patch = PATCHES[id];
      assert.equal(patch.id, id);
      assert.ok(PATCH_CLASSES.includes(patch.class), id);
      assert.ok(PATCH_ENGINES.includes(patch.engine), `${id}: engine ${patch.engine}`);
      assert.ok(patch.title && patch.character && patch.lineage, id);
      assert.ok(patch.vol > 0 && patch.env && patch.env.r >= 0, id);
      assert.ok(patch.params && typeof patch.params === 'object', id);
    }
  });

  it('the sample-backed patches pin a curated pack from Ray\'s library and map real zones', async () => {
    const sampled = PATCH_IDS.filter((id) => PATCHES[id].engine === 'sample');
    assert.ok(sampled.length >= 4, `${sampled.length} sample-backed patches`);
    for (const id of sampled) {
      const patch = PATCHES[id];
      const pack = await loadCuratedPack(patch.pack.packId);
      assert.equal(pack.manifest.manifestSha256, patch.pack.manifestSha256, id);
      assert.equal(pack.manifest.contentSha256, patch.pack.contentSha256, id);
      assert.match(pack.manifest.provenance, /first-party/);
      assert.doesNotMatch(pack.manifest.provenance, /hardware|own render/i, 'no unverified authorship claim in the provenance label');
      for (const zone of patch.params.zones) {
        const asset = pack.assets[zone.key.split('/')[1]];
        assert.ok(asset, `${id}: zone asset exists`);
        assert.equal(asset.metadata.rootNote, zone.root, `${id}: zone root is the measured/declared root`);
      }
      const zones = patch.params.zones;
      assert.equal(Math.min(...zones.map((z) => z.lo)), 0, `${id}: zones reach the bottom of the keyboard`);
      assert.equal(Math.max(...zones.map((z) => z.hi)), 127, `${id}: zones reach the top`);
    }
  });
});

describe('patch selection', () => {
  it('every patch renders a finite, audible, unclipped note and sounds unlike the default voice', async () => {
    for (const cls of PATCH_CLASSES) {
      const base = await render(miniScore([note(cls, null)], { tempo: 120 }));
      for (const id of PATCH_IDS_BY_CLASS[cls]) {
        const { wav } = await render(miniScore([note(cls, id)], { tempo: 120 }));
        const x = mono(wav);
        assert.ok(x.every(Number.isFinite), id);
        assert.ok(peak(x) > 0.004, `${id} is audible (peak ${peak(x)})`);
        assert.ok(peak(x) < 1, `${id} does not clip`);
        assert.notEqual(sha256(wav), sha256(base.wav), `${id} differs from the default ${cls}`);
      }
    }
  });

  it('within a class, no two patches render the same bytes', async () => {
    for (const cls of PATCH_CLASSES) {
      const seen = new Map();
      for (const id of PATCH_IDS_BY_CLASS[cls]) {
        const hash = sha256((await render(miniScore([note(cls, id)], { tempo: 120 }))).wav);
        assert.ok(!seen.has(hash), `${id} duplicates ${seen.get(hash)}`);
        seen.set(hash, id);
      }
    }
  });

  it('plays the pitch it is given (fundamental within 50 cents) for the harmonic engines', async () => {
    const harmonic = PATCH_IDS.filter((id) => ['fm', 'stack', 'additive', 'karplus', 'pwm', 'sample'].includes(PATCHES[id].engine)
      && !['fm-glass-bell', 'tubular-chime', 'gamelan'].includes(id)); // inharmonic bells have no single f0
    for (const id of harmonic) {
      const cls = PATCHES[id].class;
      const [n, dur] = REPRESENTATIVE[cls];
      const f = noteFreq(n);
      const { wav } = await render(miniScore([{ i: 0, voice: cls, note: n, dur: Math.max(dur, 1.2), opts: { patch: id } }], { tempo: 120 }));
      const est = autocorrF0(mono(wav), Math.floor(0.3 * SR), f * 0.7, f * 1.45);
      assert.ok(Math.abs(cents(est.hz, f)) < 50, `${id}: asked ${f.toFixed(1)} Hz, heard ${est.hz.toFixed(1)} Hz`);
    }
  });

  it('puts a fundamental near the pitch asked for, in every patch (inharmonic bells and noise patches included)', async () => {
    for (const id of PATCH_IDS) {
      const cls = PATCHES[id].class;
      const [n, dur] = REPRESENTATIVE[cls];
      const f = noteFreq(n);
      const { wav } = await render(miniScore([{ i: 0, voice: cls, note: n, dur: Math.max(dur, 1.0), opts: { patch: id } }], { tempo: 120 }));
      const near = peakHz(mono(wav), Math.floor(0.12 * SR), f * 0.96, f * 1.04, 16384);
      assert.ok(near.mag > 0.12 * near.max, `${id}: energy at ${f.toFixed(1)} Hz (${(near.mag / near.max).toFixed(2)} of the strongest peak)`);
    }
  });

  it('transposes: the fundamental follows the note an octave higher (harmonic engines); formant and noise patches change with pitch', async () => {
    for (const id of PATCH_IDS) {
      const patch = PATCHES[id];
      const cls = patch.class;
      const [low, high] = { pad: ['C3', 'C4'], bass: ['C2', 'C3'], lead: ['C4', 'C5'], pluck: ['C3', 'C4'], bell: ['C4', 'C5'] }[cls];
      const heard = [];
      for (const name of [low, high]) {
        const f = noteFreq(name);
        // The patch's own pitch tracking: the kit 1.12.0 bright-voice dark tail (a reverb) is off here.
        const { wav } = await render(miniScore([{ i: 0, voice: cls, note: name, dur: 1.0, opts: { patch: id } }], { tempo: 120, extra: { brightVoice: 'off' } }));
        heard.push(sha256(wav));
        if (!['fm', 'stack', 'additive', 'karplus', 'pwm', 'sample'].includes(patch.engine) || ['fm-glass-bell', 'tubular-chime', 'gamelan'].includes(id)) continue;
        const near = peakHz(mono(wav), Math.floor(0.12 * SR), f * 0.96, f * 1.04, 16384);
        assert.ok(near.mag > 0.1 * near.max, `${id} at ${name}: energy at ${f.toFixed(1)} Hz (${(near.mag / near.max).toFixed(2)})`);
      }
      assert.notEqual(heard[0], heard[1], `${id}: the two pitches render differently`);
    }
  });

  it('is deterministic, including the Karplus-Strong string and the noise patches', async () => {
    for (const id of ['karplus-string', 'string-bass', 'breath-flute', 'choir-ah', 'humbucker-guitar']) {
      const cls = PATCHES[id].class;
      const run = async () => sha256((await render(miniScore([note(cls, id), { ...note(cls, id), i: 4 }], { tempo: 120 }))).wav);
      assert.equal(await run(), await run(), id);
    }
  });

  it('event-level, track-level and score-level patch selection compose, event beating track beating score', async () => {
    const steps = (patch) => [{ i: 0, voice: 'pad', note: 'C4', dur: 1.0, opts: patch ? { patch } : {} }];
    const stem = async (score) => {
      const head = mono((await render(score, { voice: 'pad' })).wav).subarray(0, 2 * SR);
      return sha256(Buffer.from(head.buffer, head.byteOffset, head.byteLength));
    };
    const reference = await stem(miniScore(steps('supersaw-wall'), { tempo: 120 }));
    assert.equal(await stem(miniScore(steps(null), { tempo: 120, extra: { patches: { pad: 'supersaw-wall' } } })), reference, 'score-level patches map');
    assert.equal(await stem(miniScore(steps(null), { tempo: 120, track: { patches: { pad: 'supersaw-wall' } } })), reference, 'track-level patches map');
    assert.equal(await stem(miniScore(steps('supersaw-wall'), { tempo: 120, track: { patches: { pad: 'glass-fm' } }, extra: { patches: { pad: 'drawbar-organ' } } })), reference, 'event beats track beats score');
    assert.notEqual(await stem(miniScore(steps(null), { tempo: 120, track: { patches: { pad: 'glass-fm' } }, extra: { patches: { pad: 'drawbar-organ' } } })), reference);
  });

  it('a patch map picks per voice class: pad and bass in one score', async () => {
    const steps = [{ i: 0, voice: 'pad', note: 'C4', dur: 1 }, { i: 0, voice: 'bass', note: 'C2', dur: 0.5 }];
    const plain = sha256((await render(miniScore(steps, { tempo: 120 }))).wav);
    const padOnly = sha256((await render(miniScore(steps, { tempo: 120, extra: { patches: { pad: 'glass-fm' } } }))).wav);
    const both = sha256((await render(miniScore(steps, { tempo: 120, extra: { patches: { pad: 'glass-fm', bass: 'reese' } } }))).wav);
    assert.equal(new Set([plain, padOnly, both]).size, 3);
  });

  it('keeps the expression layer working on patches (accent, gain/bright shape) without moving their pitch', async () => {
    const score = miniScore([{ i: 0, voice: 'pad', note: 'C4', dur: 1.0, accent: 0.6, opts: { patch: 'supersaw-wall' } }], { tempo: 120 });
    score.schemaVersion = '1.2.0';
    score.sections[0].shape = { gain: [0.8, 1.1], bright: [0.8, 1.2] };
    const { wav } = await render(score);
    const x = mono(wav);
    assert.ok(peak(x) > 0.01 && x.every(Number.isFinite));
    assert.ok(Math.abs(cents(autocorrF0(x, Math.floor(0.3 * SR), 180, 380).hz, noteFreq('C4'))) < 60);
  });

  it('applies the release a patch carries when a performance release tail is declared', async () => {
    const ring = async (releaseTail) => {
      const score = miniScore([{ i: 0, voice: 'pad', note: 'C4', dur: 0.4, opts: { patch: 'drawbar-organ' } }], { tempo: 120, extra: releaseTail ? { performance: { releaseTail } } : {} });
      const x = mono((await render(score)).wav);
      return energy(x, Math.floor(0.7 * SR), Math.floor(1.6 * SR));
    };
    assert.ok((await ring(1.0)) > (await ring(0)) * 3, 'releaseTail lengthens the patch\'s own release');
  });

  it('rejects a patch used on the wrong voice class, an unknown patch, and a bad patches map', () => {
    assert.throws(() => validateSpec(miniScore([{ i: 0, voice: 'pad', note: 'C4', dur: 1, opts: { patch: 'reese' } }])), (e) => e instanceof SpecError && /is a bass patch, not pad/.test(e.message));
    assert.throws(() => validateSpec(miniScore([{ i: 0, voice: 'pad', note: 'C4', dur: 1, opts: { patch: 'nope' } }])), /unknown patch "nope"/);
    assert.throws(() => validateSpec(miniScore([{ i: 0, voice: 'kick', opts: { patch: 'reese' } }])), /unknown field/);
    assert.throws(() => validateSpec(miniScore([], { extra: { patches: { pad: 'reese' } } })), /is a bass patch, not pad/);
    assert.throws(() => validateSpec(miniScore([], { extra: { patches: { drone: 'glass-fm' } } })), /patches exist for/);
    assert.throws(() => validateSpec(miniScore([], { extra: { patches: ['pad'] } })), /must be an object/);
  });

  it('keeps a long patch tail inside the render (the buffer is sized from the patch, not the historical voice)', async () => {
    const { wav } = await render(miniScore([{ i: 12, voice: 'bell', note: 'C5', dur: 0.3, opts: { patch: 'gamelan' } }], { tempo: 240 }));
    const x = mono(wav);
    assert.ok(peak(x.subarray(x.length - 441)) < 0.002, 'the final 10 ms is silent: the ring was allowed to finish');
  });
});
