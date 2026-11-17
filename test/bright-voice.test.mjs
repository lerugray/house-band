/**
 * Kit 1.12.0 bright-voice treatment (s462, docs/proposals/HOUSE-BAND-BRIGHT-VOICE-PROPOSAL.md).
 *
 * - A score pinned to kit 1.11.0 renders exactly as before (no treatment), unless it opts in with `brightVoice: "r10"`.
 * - Kit 1.12.0 treats bright voices by default; `brightVoice: "off"` gives back the untreated bytes.
 * - Treated bells come out >= 3 dB lower in 2-8 kHz, 25-40 % off centre, with a longer 20 dB drop-off.
 * - A score with no bright voice is byte-identical on either kit.
 * The 64 stored Timbre Range proofs are checked by tools/bright-voice/proof-identity.mjs (long).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { SpecError, validateSpec } from '../src/spec.mjs';
import { brightPlan, brightVoiceMode } from '../src/timbre.mjs';
import { BRIGHT_VOICE_PRESETS, brightPanValue, brightSides, isBrightVoice } from '../src/presets/bright.mjs';
import { KIT_VERSION, PRE_BRIGHT_KIT_VERSION, PRE_TIMBRE_KIT_VERSION } from '../src/version.mjs';
import { miniScore, render, sha256 } from './helpers/timbre.mjs';
import { band, balance, decay20, mono, readStereo, rmsDb } from '../tools/bright-voice/measure.mjs';

const R10 = BRIGHT_VOICE_PRESETS.r10;
const BELLS = [
  { i: 0, voice: 'bell', note: 'E5', dur: 1.2 },
  { i: 8, voice: 'bell', note: 'B5', dur: 1.2 },
];
const pinned = (score) => ({ ...score, kitVersion: { ...PRE_BRIGHT_KIT_VERSION } });

describe('bright-voice classification and plan', () => {
  it('bells always, the bright leads and karplus-string by patch, never bass / pad / the neutral lead', () => {
    assert.equal(isBrightVoice(R10, 'bell', undefined), true);
    assert.equal(isBrightVoice(R10, 'bell', 'music-box'), true);
    for (const p of ['fm-brass', 'pwm-square', 'reed-oboe', 'supersaw-lead', 'ms20-square']) assert.equal(isBrightVoice(R10, 'lead', p), true, p);
    for (const p of [undefined, 'breath-flute', 'sor-saw']) assert.equal(isBrightVoice(R10, 'lead', p), false, String(p));
    assert.equal(isBrightVoice(R10, 'pluck', 'karplus-string'), true);
    assert.equal(isBrightVoice(R10, 'pluck', undefined), false);
    assert.equal(isBrightVoice(R10, 'bass', 'string-bass'), false);
    assert.equal(isBrightVoice(R10, 'pad', undefined), false);
  });

  it('two bright voices sit on opposite sides', () => {
    assert.deepEqual(brightSides(R10, new Set(['bell'])), { bell: 1 });
    assert.deepEqual(brightSides(R10, new Set(['bell', 'lead'])), { bell: 1, lead: -1 });
    assert.deepEqual(brightSides(R10, new Set(['bell', 'pluck'])), { bell: 1, pluck: -1 });
    assert.deepEqual(brightSides(R10, new Set(['lead', 'pluck'])), { lead: -1, pluck: 1 });
  });

  it('the pan value lands a mono voice 35 % off centre', () => {
    assert.ok(Math.abs(Math.sin(brightPanValue(R10.panPct) * Math.PI / 2) - 0.35) < 1e-12);
  });

  it('mode: on by default at 1.12.0, off at 1.11.0, explicit field wins', () => {
    const s = miniScore(BELLS);
    assert.equal(brightVoiceMode(s), 'r10');
    assert.equal(brightVoiceMode(pinned(s)), 'off');
    assert.equal(brightVoiceMode({ ...pinned(s), brightVoice: 'r10' }), 'r10');
    assert.equal(brightVoiceMode({ ...s, brightVoice: 'off' }), 'off');
    assert.equal(brightPlan(pinned(s)), null);
    assert.equal(brightPlan(miniScore([{ i: 0, voice: 'lead', note: 'C5', dur: 0.5 }])), null, 'neutral lead is not bright');
    assert.deepEqual(Object.keys(brightPlan(s).voices), ['bell']);
  });

  it('validation: brightVoice needs kit 1.11.0+ and a known mode', () => {
    assert.doesNotThrow(() => validateSpec({ ...pinned(miniScore(BELLS)), brightVoice: 'r10' }));
    assert.doesNotThrow(() => validateSpec({ ...miniScore(BELLS), brightVoice: 'off' }));
    assert.throws(() => validateSpec({ ...miniScore(BELLS), brightVoice: 'loud' }), SpecError);
    assert.throws(() => validateSpec({ ...miniScore(BELLS), kitVersion: { ...PRE_TIMBRE_KIT_VERSION }, brightVoice: 'r10' }), SpecError);
    assert.doesNotThrow(() => validateSpec(pinned(miniScore(BELLS))), 'kit 1.11.0 e84cca stays accepted');
  });
});

describe('bright-voice rendering', () => {
  let off; let on; let optIn; let pinnedRender;
  before(async () => {
    const s = miniScore(BELLS, { bars: 2 });
    pinnedRender = await render(pinned(s));
    off = await render({ ...s, brightVoice: 'off' });
    on = await render(s);
    optIn = await render({ ...pinned(s), brightVoice: 'r10' });
  });

  it('kit 1.12.0 with brightVoice "off" is the pinned 1.11.0 render, byte for byte', () => {
    assert.equal(sha256(off.wav), sha256(pinnedRender.wav));
    assert.equal(pinnedRender.manifest.brightVoice, undefined);
  });

  it('a 1.11.0 score that opts in sounds exactly like the 1.12.0 default', () => {
    assert.equal(sha256(optIn.wav), sha256(on.wav));
    assert.notEqual(sha256(on.wav), sha256(off.wav));
    assert.equal(on.manifest.brightVoice.preset, 'r10');
    assert.equal(on.manifest.brightVoice.explicit, false);
    assert.equal(optIn.manifest.brightVoice.explicit, true);
    assert.deepEqual(on.manifest.brightVoice.sides, { bell: 'right' });
  });

  it('treated bell: >= 3 dB lower in 2-8 kHz, 25-40 % right of centre, longer 20 dB drop-off, render holds the tail', () => {
    const A = readStereo(off.wav); const B = readStereo(on.wav);
    const d = rmsDb(band(mono(B), B.sr)) - rmsDb(band(mono(A), A.sr));
    assert.ok(d <= -3, `2-8 kHz moved ${d.toFixed(2)} dB`);
    const pan = balance(B).panPct;
    assert.ok(pan >= 25 && pan <= 40, `pan ${pan} %`);
    assert.ok(Math.abs(balance(A).panPct) < 1, 'untreated bell is centred');
    const dA = decay20(A); const dB = decay20(B, dA);
    assert.ok(dA.notes > 0 && dB.medianMs > dA.medianMs, `decay20 ${dA.medianMs} -> ${dB.medianMs} ms`);
    assert.ok(B.n > A.n, 'the render is extended for the dark tail');
  });

  it('a score with no bright voice renders byte-identically on 1.11.0 and 1.12.0', async () => {
    const s = miniScore([{ i: 0, voice: 'pad', note: 'C4', dur: 1 }, { i: 4, voice: 'lead', note: 'G4', dur: 0.5 }, { i: 0, voice: 'kick' }]);
    const a = await render(pinned(s)); const b = await render(s);
    assert.equal(sha256(a.wav), sha256(b.wav));
    assert.equal(b.manifest.brightVoice, undefined);
  });

  it('an authored pan keeps its side and is corrected to the target, not doubled', async () => {
    const s = miniScore(BELLS, { bars: 2, extra: { mix: { voices: { bell: { pan: -0.1 } } } } });
    const B = readStereo((await render(s)).wav);
    const pan = balance(B).panPct;
    assert.ok(pan <= -25 && pan >= -40, `pan ${pan} %`);
  });

  it('an authored pan wider than the target stays where the score put it (hard left stays hard left)', async () => {
    const s = miniScore(BELLS, { bars: 2, extra: { mix: { voices: { bell: { pan: -1 } } } } });
    const B = readStereo((await render(s)).wav);
    assert.ok(balance(B).panPct < -80, `pan ${balance(B).panPct} %`);
  });

  it('the current kit identity is 1.12.0', () => {
    assert.equal(KIT_VERSION.semver, '1.12.0');
  });
});
