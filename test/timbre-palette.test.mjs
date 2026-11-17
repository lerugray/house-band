/**
 * The Timbre-Variety Law reaches the composers: every score declares a palette
 * (kit + patch names) and a one-line "differs from the last 3 siblings" note, and
 * a check flags a palette identical to a sibling score's.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPalette, describePalette, paletteComponents, paletteDistance, scorePalette } from '../src/palette.mjs';
import { SpecError, validateSpec } from '../src/spec.mjs';
import { miniScore } from './helpers/timbre.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTE = 'a different set from the last three siblings';

const score = ({ kit, patches, palette = { differsFrom: NOTE }, drums = true, label } = {}) => miniScore([
  ...(drums ? [{ i: 0, voice: 'kick', opts: { vol: 0.3 } }, { i: 4, voice: 'snare', opts: { vol: 0.1 } }] : []),
  { i: 0, voice: 'pad', note: 'C4', dur: 0.5 },
  { i: 8, voice: 'bass', note: 'C2', dur: 0.3 },
], { extra: { ...(kit ? { kit } : {}), ...(patches ? { patches } : {}), ...(palette ? { palette } : {}), ...(label ? { label } : {}) } });

describe('palette extraction', () => {
  it('reduces a score to the kit and patches it actually plays', () => {
    const p = scorePalette(score({ kit: 'tr808', patches: { pad: 'glass-fm', bass: 'reese' } }));
    assert.deepEqual(p.kits, ['tr808']);
    assert.deepEqual(p.patches, { pad: ['glass-fm'], bass: ['reese'] });
    assert.deepEqual(paletteComponents(p), ['bass:reese', 'kit:tr808', 'pad:glass-fm']);
    assert.match(describePalette(p), /kit tr808 \| pad glass-fm \| bass reese/);
  });

  it('counts track-level and event-level choices, and calls an unnamed choice "default"', () => {
    const s = score({ kit: 'tr808' });
    s.tracks.T.patches = { pad: 'drawbar-organ' };
    s.tracks.T.steps[0].opts.kit = 'tr909';
    const p = scorePalette(s);
    assert.deepEqual(p.kits, ['tr808', 'tr909']);
    assert.deepEqual(p.patches, { pad: ['drawbar-organ'], bass: ['default'] });
    assert.deepEqual(scorePalette(score({ drums: false })).kits, []);
  });

  it('ignores voice classes the score never plays, and returns null for a foreign JSON shape', () => {
    assert.deepEqual(Object.keys(scorePalette(score({ patches: { bell: 'gamelan' } })).patches).sort(), ['bass', 'pad']);
    assert.equal(scorePalette({ hello: 'world' }), null);
  });

  it('counts how many components differ', () => {
    const a = scorePalette(score({ kit: 'tr808', patches: { pad: 'glass-fm' } }));
    assert.equal(paletteDistance(a, scorePalette(score({ kit: 'tr808', patches: { pad: 'glass-fm' } }))), 0);
    assert.equal(paletteDistance(a, scorePalette(score({ kit: 'tr808', patches: { pad: 'drawbar-organ' } }))), 2);
    assert.equal(paletteDistance(a, scorePalette(score({ kit: 'tr909', patches: { pad: 'drawbar-organ' } }))), 4);
  });
});

describe('the palette declaration', () => {
  it('validates: a one-line differsFrom note (8-400 characters) is required, unknown fields are not', () => {
    assert.doesNotThrow(() => validateSpec(score({ kit: 'tr808', palette: { differsFrom: NOTE, name: 'harbour-night' } })));
    assert.throws(() => validateSpec(score({ palette: {} })), (e) => e instanceof SpecError && /differsFrom/.test(e.message));
    assert.throws(() => validateSpec(score({ palette: { differsFrom: 'short' } })), /differsFrom/);
    assert.throws(() => validateSpec(score({ palette: { differsFrom: 'two\nlines of explanation here' } })), /differsFrom/);
    assert.throws(() => validateSpec(score({ palette: { differsFrom: NOTE, kit: 'tr808' } })), /unknown field/);
  });
});

describe('the sibling check', () => {
  const a = scorePalette(score({ kit: 'tr808', patches: { pad: 'glass-fm', bass: 'reese' } }));

  it('flags an identical palette as an error and names the sibling', () => {
    const findings = checkPalette('new.json', a, [['old.json', scorePalette(score({ kit: 'tr808', patches: { pad: 'glass-fm', bass: 'reese' } }))]]);
    assert.equal(findings.filter((f) => f.level === 'error').length, 1);
    assert.match(findings[0].message, /IDENTICAL to sibling old\.json/);
  });

  it('passes a palette that differs, and flags it again under a stricter --min-diff', () => {
    const sibling = [['old.json', scorePalette(score({ kit: 'tr808', patches: { pad: 'glass-fm', bass: 'fm-dx-bass' } }))]];
    assert.equal(checkPalette('new.json', a, sibling).filter((f) => f.level === 'error').length, 0);
    assert.equal(checkPalette('new.json', a, sibling, { minDiff: 3 }).filter((f) => f.level === 'error').length, 1);
  });

  it('warns when a kit-1.11.0 score has not declared its palette note', () => {
    const undeclared = scorePalette(score({ kit: 'tr808', palette: null }));
    assert.ok(checkPalette('new.json', undeclared, []).some((f) => f.code === 'palette-undeclared'));
  });

  it('treats a score on an older kit as playing the default palette, so two of them are identical', () => {
    const legacy = (steps) => ({ ...miniScore(steps), kitVersion: { semver: '1.9.0', sha: '4e27575dc63f5b01a7c5392a28d47ffeeec217b931755618dd7b51dd970c6417' } });
    const steps = [{ i: 0, voice: 'kick' }, { i: 0, voice: 'pad', note: 'C4', dur: 1 }];
    const findings = checkPalette('b.json', scorePalette(legacy(steps)), [['a.json', scorePalette(legacy(steps))]]);
    assert.ok(findings.some((f) => f.code === 'legacy-kit'));
    assert.ok(findings.some((f) => f.code === 'palette-identical'));
  });
});

describe('palette-check CLI and the compose-time warning', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hb-palette-'));
    const put = (name, s) => writeFileSync(join(dir, name), JSON.stringify(s));
    put('a-night-harbour.score.json', score({ kit: 'tr808', patches: { pad: 'glass-fm', bass: 'reese' } }));
    put('b-copy.score.json', score({ kit: 'tr808', patches: { pad: 'glass-fm', bass: 'reese' } }));
    put('c-different.score.json', score({ kit: 'brushed-jazz', patches: { pad: 'drawbar-organ', bass: 'sub-sine' } }));
    writeFileSync(join(dir, 'a-night-harbour.score.json.manifest.json'), '{"not":"a score"}');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (...args) => spawnSync(process.execPath, [join(root, 'tools', 'palette-check.mjs'), ...args], { encoding: 'utf8' });

  it('exits 1 and names both scores for an identical pair', () => {
    const r = cli(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /ERROR .*(a-night-harbour|b-copy)\.score\.json: palette is IDENTICAL to sibling/);
    assert.equal((r.stdout.match(/IDENTICAL/g) ?? []).length, 1, 'each pair is reported once');
  });

  it('exits 0 for a score that differs from every sibling', () => {
    const r = cli(join(dir, 'c-different.score.json'));
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /palette-check: clean/);
  });

  it('checks one candidate against siblings in another directory (--against) and emits JSON', () => {
    const r = cli(join(dir, 'b-copy.score.json'), '--against', dir, '--json');
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.ok(out.findings.some((f) => f.code === 'palette-identical' && f.sibling === 'a-night-harbour.score.json'));
  });

  it('exits 2 on bad usage', () => {
    assert.equal(cli().status, 2);
    assert.equal(cli(dir, '--min-diff', '0').status, 2);
  });

  it('src/compose.mjs warns on stderr about an identical sibling, still renders, and can be silenced', () => {
    const out = join(dir, 'out', 'copy.wav');
    mkdirSync(join(dir, 'out'), { recursive: true });
    const run = (env) => spawnSync(process.execPath, [join(root, 'src', 'compose.mjs'), '--spec', join(dir, 'b-copy.score.json'), '--out', out], { encoding: 'utf8', env: { ...process.env, ...env } });
    const loud = run({});
    assert.equal(loud.status, 0, loud.stderr);
    assert.match(loud.stderr, /palette error: b-copy\.score\.json: palette is IDENTICAL to sibling a-night-harbour\.score\.json/);
    assert.ok(readFileSync(out).length > 1000, 'the WAV was still written');
    const quiet = run({ HOUSE_BAND_PALETTE_CHECK: 'off' });
    assert.equal(quiet.status, 0);
    assert.doesNotMatch(quiet.stderr, /palette (error|warn)/);
  });
});
