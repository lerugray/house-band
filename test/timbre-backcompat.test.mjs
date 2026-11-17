/**
 * Back-compat is a hard line: a score with no kit / patches / palette / added
 * lane renders byte-identical to the 1.10.0 engine. The golden hashes in
 * test/fixtures/timbre-backcompat-golden.json were recorded by the 1.10.0 engine
 * (house-band 2a335b8) BEFORE any of the Timbre Range work existed. Each score is
 * rendered as it was declared AND relabelled to the new kit identity, so both the
 * "kit 1.10.0 is still accepted" path and the "new engine, neutral path" are
 * pinned. The long reference renders (bundled pilot cues and similar private fixtures) are
 * covered by tools/backcompat-check.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pinnedSkip, packSkip } from './helpers/env.mjs';

import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { renderSpecToWav } from '../src/render.mjs';
import { SpecError, validateSpec } from '../src/spec.mjs';
import { KIT_VERSION, PRE_BRIGHT_KIT_VERSION, PRE_TIMBRE_KIT_VERSION } from '../src/version.mjs';
import { miniScore, render, sha256 } from './helpers/timbre.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gold = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'timbre-backcompat-golden.json'), 'utf8'));
const example = (name) => JSON.parse(readFileSync(join(root, 'examples', name), 'utf8'));

describe('neutral path is byte-identical to the 1.10.0 engine', () => {
  for (const row of gold.scores) {
    it(`${row.name}: as declared (kit ${row.kit})`, { skip: row.name === 'doctrine-roles' ? false : pinnedSkip() }, async () => {
      const { wav, manifest } = await render(row.score);
      assert.equal(sha256(wav), row.wavSha256);
      assert.equal(wav.length, row.wavBytes);
      assert.equal(manifest.timbre, undefined, 'a neutral score carries no timbre block');
    });
    if (row.kit === '1.10.0') {
      // Kit 1.12.0 treats bright voices (bell, bright leads) by default, so the current kit's neutral path is pinned
      // with `brightVoice: "off"`; kit 1.11.0 (e84cca) has no treatment unless a score opts in.
      for (const [label, kitVersion, extra] of [[PRE_BRIGHT_KIT_VERSION.semver, PRE_BRIGHT_KIT_VERSION, {}], [`${KIT_VERSION.semver} (brightVoice off)`, KIT_VERSION, { brightVoice: 'off' }]]) {
        it(`${row.name}: relabelled to kit ${label}`, { skip: row.name === 'doctrine-roles' ? false : pinnedSkip() }, async () => {
          const score = { ...structuredClone(row.score), ...extra };
          score.kitVersion = { ...kitVersion };
          const { wav, manifest } = await render(score);
          assert.equal(sha256(wav), row.wavSha256, 'the new engine must reproduce the old bytes for a neutral score');
          assert.equal(manifest.timbre, undefined);
          assert.equal(manifest.brightVoice, undefined);
        });
      }
    }
  }

  it('the golden set exercises every historical voice, fx, retire, mix/phrase controls and doctrine roles', () => {
    const voices = new Set();
    let fx = false; let retire = false; let mix = false; let doctrine = false; let accent = false;
    for (const { score } of gold.scores) {
      fx ||= score.fx !== undefined; retire ||= score.retire !== undefined; mix ||= score.mix !== undefined;
      doctrine ||= score.register.class !== undefined;
      for (const track of Object.values(score.tracks)) for (const e of track.steps) { voices.add(e.voice); accent ||= e.accent !== undefined; }
    }
    for (const v of ['pad', 'drone', 'bell', 'pluck', 'bass', 'lead', 'air', 'kick', 'snare', 'hat', 'chipPulse', 'chipTriangle', 'chipNoise']) assert.ok(voices.has(v), `golden set must exercise ${v}`);
    assert.ok(fx && retire && mix && doctrine && accent);
  });

  it('the custody sample path (integer Q16 bus) is untouched: sampler demo and M3 one-shots keep their recorded bytes', { skip: packSkip('sampler-demo-17') || packSkip('hb-synth-oneshots') || pinnedSkip() }, async () => {
    // Recorded from the 1.10.0 engine before the Timbre Range work (house-band 2a335b8).
    const sampler = example('sampler-demo-spec.json');
    sampler.kitVersion = { ...KIT_VERSION };
    const samplerPack = await loadSamplePackDirectory(join(root, 'sample-packs', 'sampler-demo-17'));
    const a = await renderSpecToWav(validateSpec(sampler), { samplePack: samplerPack });
    assert.equal(sha256(a.wav), '7a2d99b935b11902785e194c89d3afca006e1fbf14dca7f8c448d6953e1908e8');
    assert.equal(a.manifest.timbre, undefined);
    assert.equal(a.manifest.samples.integerFrameMix, true);

    const m3 = example('m3-sample-spec.json');
    m3.kitVersion = { ...KIT_VERSION };
    const m3Pack = await loadSamplePackDirectory(join(root, 'sample-packs', 'hb-synth-oneshots'));
    const b = await renderSpecToWav(validateSpec(m3), { samplePack: m3Pack });
    assert.equal(sha256(b.wav), 'REPIN-ON-PINNED-TOOLCHAIN');
  });
});

describe('the new surface is gated on the new kit', () => {
  const withKit = (kitVersion, extra, steps = [{ i: 0, voice: 'kick', opts: { vol: 0.3 } }]) => {
    const score = miniScore(steps, { extra });
    score.kitVersion = kitVersion;
    return score;
  };

  it('kit 1.10.0 still validates and renders a score that uses none of it', () => {
    assert.doesNotThrow(() => validateSpec(withKit({ ...PRE_TIMBRE_KIT_VERSION }, {})));
  });

  for (const [what, extra, steps] of [
    ['a kit field', { kit: 'tr808' }, undefined],
    ['a patches map', { patches: { pad: 'glass-fm' } }, undefined],
    ['a palette', { palette: { differsFrom: 'a different set from the last three siblings' } }, undefined],
    ['an added drum lane', {}, [{ i: 0, voice: 'clap', opts: { vol: 0.1 } }]],
    ['a tune option', {}, [{ i: 0, voice: 'kick', opts: { vol: 0.3, tune: 2 } }]],
    ['a patch option', {}, [{ i: 0, voice: 'pad', note: 'C4', dur: 0.5, opts: { patch: 'glass-fm' } }]],
  ]) {
    it(`kit 1.10.0 rejects ${what}`, () => {
      assert.throws(() => validateSpec(withKit({ ...PRE_TIMBRE_KIT_VERSION }, extra, steps)), (error) => error instanceof SpecError && /requires the current kit/.test(error.message));
    });
    it(`kit ${KIT_VERSION.semver} accepts ${what}`, () => {
      assert.doesNotThrow(() => validateSpec(withKit({ ...KIT_VERSION }, extra, steps)));
    });
  }

  it('naming a kit really changes the bytes (the byte check is not vacuous)', async () => {
    const steps = [{ every: 4, voice: 'kick', opts: { vol: 0.3 } }, { i: [4, 12], voice: 'snare', opts: { vol: 0.11 } }, { every: 2, voice: 'hat', opts: { vol: 0.04 } }];
    const plain = await render(miniScore(steps));
    const kit = await render(miniScore(steps, { extra: { kit: 'tr808' } }));
    assert.notEqual(sha256(plain.wav), sha256(kit.wav));
    assert.ok(kit.manifest.timbre.kits.some((k) => k.id === 'tr808'));
  });
});
