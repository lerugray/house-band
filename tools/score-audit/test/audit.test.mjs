import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadScore, auditScore } from '../lib.mjs';
import { validateSpec } from '../../../src/spec.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(__dirname, '..', 'fixtures', name);

const EXPECTED_MECHANICAL_FLAGS = new Set([
  'mechanical-onsets',
  'mechanical-velocities',
  'constant-lead-releases',
  'constant-arrangement',
  'harmonic-bed-reuse',
]);

describe('score-audit probe', () => {
  it('fails the synthetic MECHANICAL fixture with the right flags', async () => {
    const score = await loadScore(fixture('mechanical.json'));
    const result = auditScore(score);

    assert.equal(result.pass, false);
    assert.deepEqual(new Set(result.flags), EXPECTED_MECHANICAL_FLAGS);

    // Specific mechanical tells are exposed in metrics.
    assert.equal(result.metrics.onset.lead?.mechanical, true);
    assert.equal(result.metrics.velocity.lead?.mechanical, true);
    assert.equal(result.metrics.leadReleases.lead?.mechanical, true);
    assert.equal(result.metrics.sections.allSame, true);

    // Ratified HSMD enforcement also catches the same bed presented as four sections.
    assert.equal(result.metrics.harmonicState.advisory, false);
    assert.equal(result.metrics.harmonicState.enforcement.mode, 'gating');
    assert.equal(result.metrics.harmonicState.summary.suggestedVerdict, 'HARMONIC_BED_REUSE');
    assert.ok(result.metrics.harmonicState.comparisons.every((comparison) =>
      comparison.classification === 'SAME_HARMONIC_BED'));
  });

  it('passes the synthetic HUMANIZED fixture', async () => {
    const score = await loadScore(fixture('humanized.json'));
    const result = auditScore(score, { sourcePath: fixture('humanized.json') });

    assert.equal(result.pass, true);
    assert.deepEqual(result.flags, []);

    // Humanization is recognised, so grid-aligned authored onsets do not fire.
    assert.equal(result.metrics.onset.lead?.humanized, true);
    assert.equal(result.metrics.onset.lead?.mechanical, false);

    // Lead releases vary across the arrangement.
    assert.ok(result.metrics.leadReleases.lead?.totalRange > 0.1);

    // Subtractive A×4 produces multiple distinct section signatures.
    assert.ok(result.metrics.sections.count >= 2);
    assert.ok(result.metrics.sections.distinctSignatures >= 2);

    // The transposed single-chord sections are arrangement changes, but HSMD
    // correctly treats them as reused harmonic architecture.
    assert.equal(result.metrics.harmonicState.advisory, false);
    assert.equal(result.metrics.harmonicState.enforcement.mode, 'grandfathered');
    assert.equal(
      result.metrics.harmonicState.enforcement.grandfatheredPath,
      'tools/score-audit/fixtures/humanized.json',
    );
    assert.equal(result.metrics.harmonicState.summary.suggestedVerdict, 'HARMONIC_BED_REUSE');
  });

  it('loads an ES-module score', async () => {
    const path = fixture('score-module.mjs');
    const score = await loadScore(path);
    assert.equal(score.schemaVersion, '1.0.0');
    const result = auditScore(score, { sourcePath: path });
    assert.equal(result.pass, false);
    assert.ok(result.flags.includes('constant-arrangement'));
  });

  it('records an informational result for a real example score', async () => {
    const example = join(__dirname, '..', '..', '..', 'examples', 'demo-spec.json');
    const score = await loadScore(example);
    const result = auditScore(score, { sourcePath: example });

    // This is a one-bar kit demo, not a shippable song; we only record metrics.
    assert.equal(typeof result.pass, 'boolean');
    assert.ok(Array.isArray(result.flags));
    assert.ok(typeof result.metrics, 'object');
    assert.equal(result.metrics.harmonicState.advisory, false);
    assert.equal(result.metrics.harmonicState.enforcement.mode, 'grandfathered');
  });

  it('gates a new STATIC score without an operator-authorized static bed', async () => {
    const score = await loadScore(fixture('harmonic-static.json'));
    assert.doesNotThrow(() => validateSpec(structuredClone(score)));

    const result = auditScore(score);
    assert.equal(result.pass, false);
    assert.deepEqual(result.flags, ['static-harmonic-bed']);
    assert.equal(result.metrics.harmonicState.summary.suggestedVerdict, 'STATIC');
    assert.equal(result.metrics.harmonicState.enforcement.reportedReusePairs.length, 1);
  });

  it('passes an operator-authorized static bed declared in register metadata', async () => {
    const score = structuredClone(await loadScore(fixture('harmonic-static.json')));
    score.register.harmonicArchitecture = 'static-bed';
    score.register.staticBedAuthorization = {
      operator: 'Ray',
      date: '2026-08-21',
      briefRef: score.register.briefRef,
    };
    assert.doesNotThrow(() => validateSpec(structuredClone(score)));

    const result = auditScore(score);
    assert.equal(result.pass, true);
    assert.deepEqual(result.flags, []);
    assert.equal(result.metrics.harmonicState.enforcement.staticBedAuthorized, true);
  });

  it('gates HARMONIC_BED_REUSE presented as new sections with exit 1', async () => {
    const path = fixture('harmonic-reuse.json');
    const score = await loadScore(path);
    assert.doesNotThrow(() => validateSpec(structuredClone(score)));

    const result = auditScore(score);
    assert.equal(result.pass, false);
    assert.deepEqual(result.flags, ['harmonic-bed-reuse']);
    assert.equal(result.metrics.harmonicState.summary.suggestedVerdict, 'HARMONIC_BED_REUSE');

    const cli = spawnSync(process.execPath, [join(__dirname, '..', 'audit.mjs'), path], {
      encoding: 'utf8',
    });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Flags: harmonic-bed-reuse/);
  });

  it('reports the 0.08-0.16 judgment band without hard-failing', async () => {
    const score = structuredClone(await loadScore(fixture('humanized.json')));
    score.sections = score.sections.map((section, index) => ({
      ...section,
      harmonicClaim: index === 0 ? 'new' : 'reuse',
    }));

    const result = auditScore(score);
    assert.equal(result.pass, true);
    assert.deepEqual(result.flags, []);
    assert.ok(result.metrics.harmonicState.enforcement.operatorJudgmentPairs.length > 0);
    assert.ok(result.metrics.harmonicState.enforcement.operatorJudgmentPairs.every((pair) =>
      pair.distance >= 0.08 && pair.distance < 0.16));
  });

  it('reports INSUFFICIENT_HARMONIC_DATA without hard-failing', async () => {
    const score = structuredClone(await loadScore(fixture('harmonic-static.json')));
    score.tracks = {
      drumsA: {
        bpm: 120,
        len: 64,
        steps: [{ i: [0, 16, 32, 48], voice: 'kick', opts: { vol: 0.2 } }],
      },
      drumsB: {
        bpm: 120,
        len: 64,
        steps: [{ i: [0, 8, 24, 40], voice: 'snare', opts: { vol: 0.15 } }],
      },
    };
    score.sections = [
      { track: 'drumsA', bars: 4, harmonicClaim: 'new' },
      { track: 'drumsB', bars: 4, harmonicClaim: 'new' },
    ];

    const result = auditScore(score);
    assert.equal(result.pass, true);
    assert.deepEqual(result.flags, []);
    assert.equal(result.metrics.harmonicState.summary.suggestedVerdict, 'INSUFFICIENT_HARMONIC_DATA');
    assert.equal(result.metrics.harmonicState.enforcement.insufficientSections.length, 2);
  });
});
