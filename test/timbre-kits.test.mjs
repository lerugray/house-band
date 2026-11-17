/** Named drum kits and the added lanes (kit 1.11.0 Timbre Range). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineAudioContext } from 'node-web-audio-api';

import { DRUM_LANES, LAYER_FILTERS, LAYER_TYPES, LAYER_WAVES, NEUTRAL_LANES, TIMBRE_LANES } from '../src/kit/band.js';
import { KIT_IDS, KITS } from '../src/presets/kits/index.mjs';
import { loadCuratedPack } from '../src/sample-pack-node.mjs';
import { ALL_VOICES, SpecError, validateSpec, VOICES } from '../src/spec.mjs';
import { renderScoreToWav } from '../app/render.mjs';
import { cents, energy, mono, miniScore, peak, peakHz, render, sha256, SR } from './helpers/timbre.mjs';
import { packSkip } from './helpers/env.mjs';

const synthKits = KIT_IDS.filter((id) => KITS[id].kind === 'synth');
const sampleKits = KIT_IDS.filter((id) => KITS[id].kind === 'sample');

const everyLane = () => DRUM_LANES.map((voice, n) => ({ i: n, voice, opts: { vol: { kick: 0.3, snare: 0.11, hat: 0.04 }[voice] ?? 0.15 } }));
const groove = (kit, extra = {}) => miniScore(everyLane(), { bars: 1, tempo: 240, extra: { ...(kit ? { kit } : {}), ...extra } });

function checkLane(laneDef, where) {
  if (laneDef.variants) {
    assert.ok(laneDef.variants[laneDef.default], `${where}: default variant exists`);
    for (const [name, v] of Object.entries(laneDef.variants)) checkLane(v, `${where}:${name}`);
    return;
  }
  assert.ok(laneDef.dur > 0 && Number.isFinite(laneDef.dur), `${where}: natural length`);
  if (laneDef.sample !== undefined) {
    const keys = Array.isArray(laneDef.sample) ? laneDef.sample : [laneDef.sample];
    assert.ok(keys.length > 0 && keys.every((k) => /^tv-[a-z0-9-]+\/[a-z0-9-]+$/.test(k)), `${where}: sample keys`);
    assert.ok(laneDef.gain > 0 && laneDef.gain < 64, `${where}: gain`);
    return;
  }
  assert.ok(laneDef.layers.length > 0, `${where}: has layers`);
  for (const [n, layer] of laneDef.layers.entries()) {
    const at = `${where} layer ${n}`;
    assert.ok(LAYER_TYPES.includes(layer.t), `${at}: type`);
    assert.ok(layer.d > 0 && Number.isFinite(layer.d) && layer.d <= 8, `${at}: decay`);
    assert.ok(layer.level > 0 && layer.level <= 4, `${at}: level`);
    if (layer.t === 'tone') {
      assert.ok(layer.f0 > 0 && layer.f0 <= 20000, `${at}: f0`);
      assert.ok(layer.wave === undefined || LAYER_WAVES.includes(layer.wave), `${at}: wave`);
    }
    for (const fx of layer.fx ?? []) {
      assert.ok(LAYER_FILTERS.includes(fx.type) && fx.f >= 10 && fx.f <= 20000, `${at}: filter`);
    }
    if (layer.bursts) assert.ok(layer.bursts[0] === 0 && layer.bursts.every((b, i, a) => i === 0 || b > a[i - 1]), `${at}: burst offsets ascend from 0`);
  }
}

describe('the kit registry', () => {
  it('has at least 10 kits: 5+ code-synthesized and 5+ sample kits', () => {
    assert.ok(KIT_IDS.length >= 10, `${KIT_IDS.length} kits`);
    assert.ok(synthKits.length >= 5, `${synthKits.length} synth kits`);
    assert.ok(sampleKits.length >= 5, `${sampleKits.length} sample kits`);
    assert.equal(new Set(KIT_IDS).size, KIT_IDS.length);
  });

  it('every kit is well-formed data and names what it is', () => {
    for (const id of KIT_IDS) {
      const kit = KITS[id];
      assert.equal(kit.id, id);
      assert.ok(kit.title && kit.character && kit.lineage, `${id}: title, character, lineage`);
      for (const [name, lane] of Object.entries(kit.lanes)) {
        assert.ok(DRUM_LANES.includes(name), `${id}: unknown lane ${name}`);
        checkLane(lane, `${id}.${name}`);
      }
      for (const core of ['kick', 'snare', 'hat']) assert.ok(kit.lanes[core], `${id} defines ${core}`);
    }
  });

  it('every synth kit defines all eleven lanes', () => {
    for (const id of synthKits) for (const lane of DRUM_LANES) assert.ok(KITS[id].lanes[lane], `${id} defines ${lane}`);
  });

  it('every sample kit pins a curated pack from Ray\'s library and every sample key resolves inside it', { skip: sampleKits.map((id) => packSkip(KITS[id].pack.packId)).find(Boolean) || false }, async () => {
    for (const id of sampleKits) {
      const kit = KITS[id];
      assert.ok(kit.pack, `${id}: pack identity`);
      assert.match(kit.lineage, /ray-samples/);
      const pack = await loadCuratedPack(kit.pack.packId);
      assert.equal(pack.manifest.manifestSha256, kit.pack.manifestSha256, `${id}: manifest pin`);
      assert.equal(pack.manifest.contentSha256, kit.pack.contentSha256, `${id}: content pin`);
      assert.match(pack.manifest.provenance, /first-party|purchased/);
      const keys = [];
      const collect = (lane) => {
        if (lane.variants) Object.values(lane.variants).forEach(collect);
        else if (lane.sample !== undefined) keys.push(...(Array.isArray(lane.sample) ? lane.sample : [lane.sample]));
      };
      Object.values(kit.lanes).forEach(collect);
      assert.ok(keys.length >= 8, `${id}: maps real samples`);
      for (const key of keys) {
        const [packId, assetId] = key.split('/');
        assert.equal(packId, kit.pack.packId);
        assert.ok(pack.assets[assetId], `${id}: asset ${assetId} is in the pack`);
      }
      // Lean: every asset in the pack is used by the kit.
      const used = new Set(keys.map((k) => k.split('/')[1]));
      for (const assetId of Object.keys(pack.assets)) assert.ok(used.has(assetId), `${id}: pack asset ${assetId} is unused (keep packs lean)`);
    }
  });

  it('VOICES stays the thirteen canonical voices; the added lanes live in ALL_VOICES', () => {
    assert.equal(VOICES.length, 13);
    assert.deepEqual(ALL_VOICES.slice(13), TIMBRE_LANES);
    assert.equal(TIMBRE_LANES.length, 8);
  });
});

describe('kit selection', () => {
  it('every kit renders every lane to finite, audible, unclipped audio', { skip: sampleKits.map((id) => packSkip(KITS[id].pack.packId)).find(Boolean) || false }, async () => {
    for (const id of KIT_IDS) {
      const { wav } = await render(groove(id));
      const x = mono(wav);
      assert.ok(x.every(Number.isFinite), `${id}: finite`);
      assert.ok(peak(x) > 0.01, `${id}: audible`);
      assert.ok(peak(x) < 1, `${id}: no clipping`);
    }
  });

  it('every kit sounds different from every other and from the default', { skip: sampleKits.map((id) => packSkip(KITS[id].pack.packId)).find(Boolean) || false }, async () => {
    const hashes = new Map();
    for (const id of [null, ...KIT_IDS]) hashes.set(id ?? 'default', sha256((await render(groove(id))).wav));
    assert.equal(new Set(hashes.values()).size, hashes.size);
  });

  it('is deterministic: the same score renders the same bytes twice', { skip: packSkip('tv-kit-linndrum') }, async () => {
    for (const id of ['tr909', 'linndrum']) {
      const a = await render(groove(id));
      const b = await render(groove(id));
      assert.equal(sha256(a.wav), sha256(b.wav), id);
    }
  });

  it('event-level, track-level and score-level kits compose, event beating track beating score', async () => {
    const lanes = (extra = {}) => [
      { i: 0, voice: 'kick', opts: { vol: 0.3, ...extra } },
      { i: 4, voice: 'snare', opts: { vol: 0.11 } },
    ];
    // Stems: render one lane in isolation so only that lane's kit matters. The
    // render length follows the whole score's tails, so compare the first second.
    const stem = async (score, voice) => {
      const head = mono((await render(score, { voice })).wav).subarray(0, SR);
      return sha256(Buffer.from(head.buffer, head.byteOffset, head.byteLength));
    };
    const kickStem = (score) => stem(score, 'kick');
    const snareStem = (score) => stem(score, 'snare');
    const plain909 = miniScore(lanes(), { extra: { kit: 'tr909' } });
    const plain808 = miniScore(lanes(), { extra: { kit: 'tr808' } });
    const eventOverride = miniScore(lanes({ kit: 'tr909' }), { extra: { kit: 'tr808' } });
    assert.equal(await kickStem(eventOverride), await kickStem(plain909), 'event kit beats score kit');
    assert.equal(await snareStem(eventOverride), await snareStem(plain808), 'an un-overridden lane keeps the score kit');
    const trackLevel = miniScore(lanes(), { extra: { kit: 'tr808' }, track: { kit: 'tr909' } });
    assert.equal(await kickStem(trackLevel), await kickStem(plain909), 'track kit beats score kit');
    const trackVsEvent = miniScore(lanes({ kit: 'tr808' }), { extra: { kit: 'tr909' }, track: { kit: 'tr909' } });
    assert.equal(await kickStem(trackVsEvent), await kickStem(plain808), 'event kit beats track kit');
  });

  it('a lane the kit leaves out falls back to the neutral recipe (or the historical voice)', { skip: sampleKits.map((id) => packSkip(KITS[id].pack.packId)).find(Boolean) || false }, async () => {
    const missing = KIT_IDS.find((id) => !KITS[id].lanes.clap);
    assert.ok(missing, 'at least one sample kit has no clap');
    const clapStem = async (kit) => sha256((await render(miniScore([{ i: 0, voice: 'clap', opts: { vol: 0.12 } }], { extra: kit ? { kit } : {} }), { voice: 'clap' })).wav);
    assert.equal(await clapStem(missing), await clapStem(null));
  });

  it('rejects an unknown kit, naming the ones that exist', () => {
    assert.throws(() => validateSpec(groove('no-such-kit')), (e) => e instanceof SpecError && /unknown kit "no-such-kit"/.test(e.message) && /tr808/.test(e.message));
    assert.throws(() => validateSpec(miniScore([{ i: 0, voice: 'kick', opts: { kit: 'nope' } }])), /unknown kit/);
    assert.throws(() => validateSpec(miniScore([{ i: 0, voice: 'kick' }], { track: { kit: 'nope' } })), /unknown kit/);
  });
});

describe('the added drum lanes', () => {
  it('exist as tomLow, tomMid, tomHigh, clap, rim, ride, crash and perc', () => {
    assert.deepEqual([...TIMBRE_LANES], ['tomLow', 'tomMid', 'tomHigh', 'clap', 'rim', 'ride', 'crash', 'perc']);
    assert.deepEqual(Object.keys(NEUTRAL_LANES).sort(), [...TIMBRE_LANES].sort());
  });

  for (const lane of TIMBRE_LANES) {
    it(`${lane} plays with no kit named (neutral recipe) and is audible`, async () => {
      const { wav } = await render(miniScore([{ i: 0, voice: lane, opts: { vol: 0.2 } }], { tempo: 120 }));
      const x = mono(wav);
      assert.ok(x.every(Number.isFinite));
      assert.ok(peak(x) > 0.005, `${lane} audible`);
    });
  }

  it('toms descend in pitch low < mid < high in every synth kit', async () => {
    for (const id of synthKits) {
      const centroid = async (lane) => {
        const { wav } = await render(miniScore([{ i: 0, voice: lane, opts: { vol: 0.2 } }], { extra: { kit: id } }));
        const x = mono(wav);
        const s = (await import('./helpers/timbre.mjs')).spectrum(x, 400, 4096);
        let num = 0; let den = 0;
        for (let k = 1; k < 600; k++) { num += s.mags[k] * s.hz(k); den += s.mags[k]; }
        return num / den;
      };
      const [low, mid, high] = [await centroid('tomLow'), await centroid('tomMid'), await centroid('tomHigh')];
      assert.ok(low < mid && mid < high, `${id}: tom centroids ${low.toFixed(0)} < ${mid.toFixed(0)} < ${high.toFixed(0)}`);
    }
  });

  it('every lane honours `tune`: +12 semitones doubles a tom\'s fundamental', async () => {
    const f = async (tune) => {
      const { wav } = await render(miniScore([{ i: 0, voice: 'tomLow', opts: { vol: 0.2, tune } }], { extra: { kit: 'tr808' } }));
      return peakHz(mono(wav), 600, 40, 600).hz;
    };
    const base = await f(0);
    const up = await f(12);
    assert.ok(Math.abs(cents(up, base * 2)) < 120, `tune +12 moved ${base.toFixed(0)} Hz to ${up.toFixed(0)} Hz`);
  });

  it('a perc variant selects a different instrument; an unknown variant is a render error', async () => {
    const stem = async (variant) => sha256((await render(miniScore([{ i: 0, voice: 'perc', opts: { vol: 0.1, variant } }], { extra: { kit: 'tr808' } }))).wav);
    assert.notEqual(await stem('cowbell'), await stem('clave'));
    await assert.rejects(() => stem('does-not-exist'), (e) => e instanceof SpecError && /variant: "does-not-exist" is not one of/.test(e.message));
    // A lane with a single sound simply ignores `variant`.
    assert.doesNotThrow(() => validateSpec(miniScore([{ i: 0, voice: 'hat', opts: { vol: 0.04, variant: 'open' } }], { extra: { kit: 'tr808' } })));
  });

  it('`dur` shortens an open hat and lengthens a closed one', async () => {
    const tailEnergy = async (dur) => {
      const { wav } = await render(miniScore([{ i: 0, voice: 'hat', opts: { vol: 0.05, dur } }], { tempo: 120, extra: { kit: 'tr909' } }));
      return energy(mono(wav), Math.floor(0.2 * SR), Math.floor(0.6 * SR));
    };
    assert.ok((await tailEnergy(0.4)) > 10 * (await tailEnergy(0.05)));
  });

  it('a sample kit\'s open hat variant rings longer than its closed hat', { skip: packSkip('tv-kit-linndrum') }, async () => {
    const tail = async (variant) => {
      const { wav } = await render(miniScore([{ i: 0, voice: 'hat', opts: { vol: 0.05, variant } }], { tempo: 120, extra: { kit: 'linndrum' } }));
      return energy(mono(wav), Math.floor(0.25 * SR), Math.floor(0.7 * SR));
    };
    assert.ok((await tail('open')) > 5 * (await tail('closed')));
  });

  it('sample lanes round-robin deterministically across a kit\'s alternates', { skip: packSkip('tv-kit-cr78') }, async () => {
    const hit = (i) => ({ i, voice: 'snare', opts: { vol: 0.11 } });
    const { wav } = await render(miniScore([hit(0), hit(8)], { tempo: 120, extra: { kit: 'cr78' } }));
    const x = mono(wav);
    const win = Math.floor(0.15 * SR);
    const a = x.subarray(0, win);
    const b = x.subarray(Math.round(8 * 0.125 * SR), Math.round(8 * 0.125 * SR) + win);
    let diff = 0;
    for (let n = 0; n < win; n++) diff += Math.abs(a[n] - b[n]);
    assert.ok(diff > 0.5, 'consecutive hits use different samples');
    assert.equal(sha256((await render(miniScore([hit(0), hit(8)], { tempo: 120, extra: { kit: 'cr78' } }))).wav), sha256(wav));
  });

  it('tr707 carries the real TR-707 samples: every lane, the a/b kick and snare, the flam snare, the tamb perc, and the variants differ', { skip: packSkip('tv-kit-tr707') }, async () => {
    const kit = KITS.tr707;
    assert.equal(kit.kind, 'sample');
    assert.equal(kit.pack.packId, 'tv-kit-tr707');
    for (const lane of DRUM_LANES) assert.ok(kit.lanes[lane], `tr707 defines ${lane}`);
    const names = (lane) => Object.keys(kit.lanes[lane].variants ?? {});
    assert.deepEqual(names('kick'), ['a', 'b']);
    assert.deepEqual(names('snare'), ['a', 'b', 'flam']);
    assert.deepEqual(names('hat'), ['closed', 'open']);
    assert.deepEqual(names('perc'), ['cowbell', 'tamb']);
    for (const [lane, ids] of [['kick', ['kick', 'kick-b']], ['snare', ['snare', 'snare-b', 'snare-flam']], ['ride', ['ride']], ['crash', ['crash']]]) {
      const keys = kit.lanes[lane].variants ? Object.values(kit.lanes[lane].variants).map((v) => v.sample) : [kit.lanes[lane].sample];
      assert.deepEqual(keys, ids.map((id) => `tv-kit-tr707/${id}`));
    }
    const hit = async (voice, variant) => sha256((await render(miniScore([{ i: 0, voice, opts: { vol: 0.12, ...(variant ? { variant } : {}) } }], { extra: { kit: 'tr707' } }), { voice })).wav);
    for (const [voice, variants] of [['kick', ['a', 'b']], ['snare', ['a', 'b', 'flam']], ['hat', ['closed', 'open']], ['perc', ['cowbell', 'tamb']]]) {
      const hashes = await Promise.all(variants.map((v) => hit(voice, v)));
      assert.equal(new Set(hashes).size, variants.length, `${voice} variants ${variants.join('/')} render different audio`);
      assert.equal(await hit(voice), hashes[0], `${voice} with no variant plays the default (${variants[0]})`);
    }
  });

  it('long kit tails are not cut off at the end of the render', async () => {
    const { wav } = await render(miniScore([{ i: 12, voice: 'crash', opts: { vol: 0.2 } }], { tempo: 240, extra: { kit: 'orchestral' } }));
    const x = mono(wav);
    assert.ok(peak(x.subarray(x.length - 441)) < 0.002, 'the final 10 ms is silent: the tail was allowed to finish');
  });
});

describe('browser/node parity', () => {
  it('the Audition Room renderer produces the same bytes as the CLI renderer for a synth kit, patches and the added lanes', async () => {
    globalThis.OfflineAudioContext = OfflineAudioContext;
    const steps = [
      ...everyLane(),
      { i: 0, voice: 'pad', note: 'C3', dur: 0.8, opts: { patch: 'glass-fm' } },
      { i: 8, voice: 'bass', note: 'C2', dur: 0.3, opts: { patch: 'reese' } },
      { i: 2, voice: 'pluck', note: 'G4', dur: 0.1, opts: { patch: 'karplus-string' } },
    ];
    const score = miniScore(steps, { bars: 1, tempo: 240, extra: { kit: 'industrial', patches: { bell: 'tubular-chime' } } });
    const node = await render(score);
    const browser = await renderScoreToWav(validateSpec(structuredClone(score)));
    assert.equal(sha256(Buffer.from(browser.wav)), sha256(node.wav));
    assert.deepEqual(browser.manifest.timbre, node.manifest.timbre, 'the same timbre custody block');
  });
});
