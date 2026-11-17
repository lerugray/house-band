/** OSS-22: cowrite develop (keep layer, arranger and llm engines). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { arrange, FORMS } from '../src/cowrite/arranger.mjs';
import { developScore } from '../src/cowrite/develop.mjs';
import { developPrompt, LlmDevelopError } from '../src/cowrite/develop-llm.mjs';
import { asWritten } from '../src/cowrite/as-written.mjs';
import { importMidi } from '../src/cowrite/import-midi.mjs';
import { checkKeepLayer } from '../src/cowrite/keep-layer.mjs';
import { validateSourceSong } from '../src/cowrite/source-song.mjs';
import { buildProfiles, getProfile } from '../src/desk/config.mjs';
import { createProvider } from '../src/desk/providers/index.mjs';
import { canonicalJson } from '../src/provenance.mjs';
import { renderSpecToWav } from '../src/render.mjs';
import { validateSpec } from '../src/spec.mjs';
import { auditScore } from '../tools/score-audit/lib.mjs';
import { writeFixtureType1 } from './helpers/write-midi.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'tools', 'cowrite', 'develop.mjs');
// Ray Weiss's "maybean2" (Appendix N), notes only: built from the appendix-n emit_js.py data
// module by the OSS-18 rules; no sample data. See test/fixtures/cowrite/README.md.
const MAYBEAN2 = join(ROOT, 'test', 'fixtures', 'cowrite', 'maybean2.source.json');

function fixtureSong() {
  return validateSourceSong(importMidi(writeFixtureType1(), 'fixture.mid'));
}
function maybean2() {
  return validateSourceSong(JSON.parse(readFileSync(MAYBEAN2, 'utf8')));
}
const SONGS = { fixture: fixtureSong, maybean2 };
const USER_SECTIONS = { loop: 2, subtractive: 4, aba: 2, abac: 2 };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deterministicProvider() {
  const profile = getProfile(buildProfiles({}), 'deterministic');
  return createProvider(profile, {});
}

describe('OSS-22 step origin metadata', () => {
  it('validateSpec accepts origin "user" | "house-band" and rejects anything else', () => {
    const { spec } = asWritten(fixtureSong());
    const tagged = clone(spec);
    tagged.tracks.song.steps.forEach((s, k) => { s.origin = k % 2 ? 'user' : 'house-band'; });
    assert.doesNotThrow(() => validateSpec(tagged));
    const bad = clone(spec);
    bad.tracks.song.steps[0].origin = 'someone';
    assert.throws(() => validateSpec(bad), /origin: must be one of user, house-band/);
    const notString = clone(spec);
    notString.tracks.song.steps[0].origin = 1;
    assert.throws(() => validateSpec(notString), /origin/);
  });

  it('origin never changes rendering: tagged and untagged scores give identical PCM', async () => {
    const { spec } = asWritten(fixtureSong());
    const tagged = clone(spec);
    tagged.tracks.song.steps.forEach((s) => { s.origin = 'user'; });
    const a = await renderSpecToWav(spec);
    const b = await renderSpecToWav(validateSpec(tagged));
    assert.equal(a.manifest.output.sha256, b.manifest.output.sha256);
    assert.equal(Buffer.from(a.wav).equals(Buffer.from(b.wav)), true);
  });
});

describe('OSS-22 arranger engine', () => {
  for (const [name, load] of Object.entries(SONGS)) {
    for (const form of FORMS) {
      it(`${name} develops with form ${form}: valid spec, keep layer ok, score-audit passes`, async () => {
        const source = load();
        const { spec, record, keepLayer, draftKeepLayers } = await developScore(source, { engine: 'arranger', form });
        assert.doesNotThrow(() => validateSpec(clone(spec)));
        assert.equal(keepLayer.ok, true, JSON.stringify(keepLayer.missing.slice(0, 3)));
        assert.deepEqual(draftKeepLayers, []);
        // The contract's two-argument form infers the sections that state the user's material.
        const inferred = checkKeepLayer(source, spec);
        assert.equal(inferred.ok, true);
        assert.deepEqual(inferred.sections, record.userSections);
        assert.equal(record.userSections.length, USER_SECTIONS[form]);
        assert.equal(record.form, form);
        assert.equal(record.engine, 'arranger');
        // Section list with start bars, in score order.
        let bar = 0;
        record.sections.forEach((s, k) => {
          assert.equal(s.index, k);
          assert.equal(s.track, spec.sections[k].track);
          assert.equal(s.startBar, bar);
          assert.equal(s.bars, spec.sections[k].bars);
          bar += s.bars;
        });
        // Every step says who wrote it; user steps are exactly the source's notes.
        const expected = source.tracks.filter((t) => t.kind === 'pitched').reduce((n, t) => n + t.notes.length, 0);
        for (const index of record.userSections) {
          const steps = spec.tracks[spec.sections[index].track].steps;
          assert.ok(steps.every((s) => s.origin === 'user' || s.origin === 'house-band'));
          assert.equal(steps.filter((s) => s.origin === 'user' && s.note).length, expected);
        }
        // At least: a House Band bass from chord roots, a drum part on the kit, a pad or counter-line.
        const hbVoices = new Set(Object.values(spec.tracks).flatMap((t) => t.steps.filter((s) => s.origin === 'house-band').map((s) => s.voice)));
        assert.ok(hbVoices.has('bass'), 'bass');
        assert.ok(['kick', 'snare', 'hat', 'clap', 'ride', 'rim'].some((v) => hbVoices.has(v)), 'drums');
        assert.ok(hbVoices.has('pad') || hbVoices.has('pluck'), 'pad or counter-line');
        assert.equal(spec.kit, 'tr808');
        assert.equal(spec.seed, 1);
        const audit = auditScore(clone(spec));
        assert.equal(audit.pass, true, audit.flags.join(', '));
      });
    }
  }

  it('subtractive is the user section four times with planned drop-outs and returns', () => {
    const { spec, record } = arrange(maybean2(), { form: 'subtractive' });
    assert.deepEqual(record.sections.map((s) => s.material), ['A', 'A', 'A', 'A']);
    assert.deepEqual(record.sections.map((s) => s.parts.plan), ['intro', 'body', 'drop', 'full']);
    assert.deepEqual(spec.sections.map((s) => s.harmonicClaim), ['new', 'reuse', 'reuse', 'reuse']);
    const drums = (k) => spec.tracks[spec.sections[k].track].steps.filter((s) => !s.note);
    assert.equal(drums(2).length, 0, 'pass 3 drops every drum, the user\'s included');
    assert.ok(drums(3).length > drums(1).length, 'pass 4 returns fuller');
    assert.ok(record.changes.some((c) => c.kind === 'drum-rest' && c.sections.includes(2)));
  });

  it('two runs with the same seed give identical score.json; another seed differs', () => {
    for (const load of Object.values(SONGS)) {
      const a = arrange(load(), { form: 'abac', seed: 7 });
      const b = arrange(load(), { form: 'abac', seed: 7 });
      assert.equal(canonicalJson(a.spec), canonicalJson(b.spec));
      assert.equal(JSON.stringify(a.record), JSON.stringify(b.record));
      const c = arrange(load(), { form: 'abac', seed: 8 });
      assert.notEqual(canonicalJson(a.spec), canonicalJson(c.spec));
    }
  });

  it('--length adds sections and never time-stretches the user material', async () => {
    const source = maybean2();
    const { spec, record, keepLayer } = await developScore(source, { form: 'subtractive', lengthBars: 100 });
    assert.ok(record.length.totalBars >= 100);
    assert.equal(record.length.formBars, 64);
    assert.ok(record.length.added > 0);
    for (const index of record.userSections) assert.equal(spec.sections[index].bars, 16);
    assert.equal(keepLayer.ok, true);
    assert.equal(spec.tracks[spec.sections[0].track].bpm, 105);
    assert.ok(record.sections.some((s) => s.kind === 'house-band'));
    assert.equal(auditScore(clone(spec)).pass, true);
  });

  it('--drafts material becomes B (and C), with its own keep layer', async () => {
    const source = fixtureSong();
    const draft = clone(source);
    draft.title = 'draft';
    for (const t of draft.tracks) if (t.kind === 'pitched') t.notes.forEach((n) => { n.midi += 5; });
    const { spec, record, keepLayer, draftKeepLayers } = await developScore(source, { form: 'abac', drafts: [draft] });
    assert.deepEqual(record.sections.map((s) => s.material), ['A', 'B', 'A', 'C']);
    assert.equal(record.sections[1].kind, 'draft');
    assert.equal(record.sections[3].kind, 'house-band');
    assert.equal(keepLayer.ok, true);
    assert.equal(draftKeepLayers.length, 1);
    assert.equal(draftKeepLayers[0].ok, true);
    assert.deepEqual(draftKeepLayers[0].sections, [1]);
    assert.equal(checkKeepLayer(draft, spec, { sections: [1] }).ok, true);
  });
});

describe('OSS-22 checkKeepLayer', () => {
  it('deleting one user note from score.json makes checkKeepLayer report it', () => {
    for (const load of Object.values(SONGS)) {
      const source = load();
      const { spec } = arrange(source, { form: 'subtractive' });
      const broken = clone(spec);
      const track = broken.tracks[broken.sections[2].track];
      const victim = track.steps.findIndex((s) => s.origin === 'user' && s.note);
      const [removed] = track.steps.splice(victim, 1);
      const result = checkKeepLayer(source, broken);
      assert.equal(result.ok, false);
      assert.equal(result.missing.length, 1);
      assert.equal(result.missing[0].section, 2);
      assert.equal(result.missing[0].beat * 4, removed.i);
      assert.equal(result.missing[0].note, removed.note);
    }
  });

  it('an octave change without a range need, or a House Band note tagged "user", breaks the keep layer', () => {
    const source = fixtureSong();
    const { spec } = arrange(source, { form: 'aba' });
    const octave = clone(spec);
    const step = octave.tracks.A1.steps.find((s) => s.origin === 'user' && s.voice === 'lead');
    step.note = step.note.replace(/(-?\d)$/, (o) => String(Number(o) - 1));
    const r1 = checkKeepLayer(source, octave);
    assert.equal(r1.ok, false);
    assert.match(r1.missing[0].reason, /without a range need/);
    const extra = clone(spec);
    extra.tracks.A1.steps.find((s) => s.origin === 'house-band' && s.note).origin = 'user';
    const r2 = checkKeepLayer(source, extra);
    assert.equal(r2.ok, false);
    assert.equal(r2.extra.length, 1);
  });

  it('a note in the last sixteenth of the piece still lands inside its section', () => {
    const source = clone(fixtureSong());
    source.tracks.find((t) => t.roleGuess === 'melody').notes.push({ beat: 7.9, lengthBeats: 0.1, midi: 72, velocity: 1, offsetMs: 0 });
    const { spec, record } = arrange(source, { form: 'aba' });
    assert.equal(record.material.A.bars, 3);
    assert.equal(checkKeepLayer(source, spec).ok, true);
  });

  it('a fold into the voice range is reported as moved, and a dropout that silences user notes counts as missing', () => {
    const source = clone(fixtureSong());
    const melody = source.tracks.find((t) => t.roleGuess === 'melody');
    melody.notes[3].midi = 108; // C8: above the lead range, so the arranger folds it
    const { spec, record } = arrange(source, { form: 'loop' });
    const result = checkKeepLayer(source, spec);
    assert.equal(result.ok, true);
    assert.equal(result.moved.length, 2);
    assert.ok(record.changes.some((c) => c.kind === 'octave-fold' && c.noteIndex === 3 && c.from === 'C8' && c.to === 'C7'));
    const muted = clone(spec);
    muted.schemaVersion = '1.2.0';
    muted.sections[0].mute = ['lead'];
    const r = checkKeepLayer(source, muted, { sections: [0, 1] });
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, melody.notes.length);
  });
});

describe('OSS-22 llm engine', () => {
  it('runs offline with the Desk deterministic profile through validateSpec and checkKeepLayer', async () => {
    const source = fixtureSong();
    const result = await developScore(source, { engine: 'llm', form: 'aba', provider: deterministicProvider(), profileId: 'deterministic' });
    assert.equal(result.keepLayer.ok, true);
    assert.equal(result.record.engine, 'llm');
    assert.equal(result.record.provider.profile, 'deterministic');
    assert.equal(result.record.repairLoop.candidates, 1);
    assert.equal(auditScore(clone(result.spec)).pass, true);
  });

  it('the prompt carries the source-song, the keep-layer rule, the form and the composing laws', () => {
    const source = maybean2();
    const { basePrompt } = developPrompt(source, { form: 'abac', seed: 3, brief: 'slow, rainy' });
    assert.equal(basePrompt.cowrite.form, 'abac');
    assert.deepEqual(basePrompt.cowrite.sourceSong, source);
    assert.match(basePrompt.cowrite.keepLayerRule, /THE KEEP LAYER IS THE LAW/);
    assert.match(basePrompt.cowrite.composingLaws, /Song-Structure Law/);
    assert.equal(basePrompt.userPrompt, 'slow, rainy');
    assert.equal(basePrompt.seed, 3);
    assert.deepEqual(basePrompt.sections.map((s) => s.name), ['A1', 'B1', 'A2', 'C1']);
    assert.equal(basePrompt.cowrite.userLayer.A.steps.filter((s) => s.note).length, 160);
    assert.deepEqual(basePrompt.cowrite.userLayer.A.tracks, ['A1', 'A2']);
  });

  it('a candidate that breaks the keep layer goes back through the bounded repair loop', async () => {
    const source = fixtureSong();
    const good = arrange(source, { form: 'aba' }).spec;
    const bad = clone(good);
    bad.tracks.A2.steps.splice(bad.tracks.A2.steps.findIndex((s) => s.origin === 'user' && s.note), 1);
    const requests = [];
    const provider = {
      laneId: 'scripted', model: 'scripted', maxTransportAttempts: 3, callTimeoutMs: 5000, totalDeadlineMs: 30000,
      async generate({ request }) {
        requests.push(request);
        return canonicalJson(requests.length === 1 ? bad : good);
      },
    };
    const result = await developScore(source, { engine: 'llm', form: 'aba', provider });
    assert.equal(result.keepLayer.ok, true);
    assert.equal(result.record.repairLoop.candidates, 2);
    assert.equal(requests[0].requestFormat, 'hb-composition-request/1.0.0');
    assert.equal(requests[1].requestFormat, 'hb-composition-repair/1.0.0');
    assert.match(requests[1].orderedValidatorDiagnostics[0].message, /keep layer broken: 1 user note\(s\) missing/);
    assert.equal(requests[1].completePriorRawCandidate, canonicalJson(bad));

    const alwaysBad = { ...provider, async generate() { return canonicalJson(bad); } };
    await assert.rejects(developScore(source, { engine: 'llm', form: 'aba', provider: alwaysBad, maxValidationAttempts: 2 }), (err) => {
      assert.ok(err instanceof LlmDevelopError);
      assert.equal(err.details.attempts.length, 2);
      return true;
    });
  });
});

describe('OSS-22 CLI', () => {
  it('writes score.json, score.wav + manifest and develop.json; same seed twice gives identical score.json and WAV', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-develop-'));
    try {
      const src = join(dir, 'song.source.json');
      writeFileSync(src, `${JSON.stringify(fixtureSong(), null, 2)}\n`);
      const run = (out) => spawnSync(process.execPath, [CLI, src, '-o', join(dir, out), '--form', 'loop'], { encoding: 'utf8', cwd: ROOT });
      const a = run('a');
      assert.equal(a.status, 0, a.stderr || a.stdout);
      const b = run('b');
      assert.equal(b.status, 0, b.stderr || b.stdout);
      for (const f of ['score.json', 'score.wav', 'score.wav.manifest.json', 'develop.json']) {
        assert.equal(readFileSync(join(dir, 'a', f)).equals(readFileSync(join(dir, 'b', f))), true, `${f} differs between runs`);
      }
      const record = JSON.parse(readFileSync(join(dir, 'a', 'develop.json'), 'utf8'));
      assert.equal(record.format, 'house-band-cowrite-develop');
      assert.equal(record.engine, 'arranger');
      assert.equal(record.form, 'loop');
      assert.equal(record.keepLayer.ok, true);
      assert.deepEqual(record.changes, []);
      assert.equal(record.gates.passed, true, JSON.stringify(record.gates.failed));
      assert.equal(record.gates.scoreAudit.pass, true);
      assert.equal(record.gates.leadBalance.verdict, 'GREEN');
      assert.ok(record.sections.every((s) => Number.isInteger(s.startBar)));
      const manifest = JSON.parse(readFileSync(join(dir, 'a', 'score.wav.manifest.json'), 'utf8'));
      assert.equal(record.render.sha256, manifest.output.sha256);
      const score = JSON.parse(readFileSync(join(dir, 'a', 'score.json'), 'utf8'));
      assert.doesNotThrow(() => validateSpec(score));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('usage errors exit 2', () => {
    const r = spawnSync(process.execPath, [CLI, MAYBEAN2, '-o', join(tmpdir(), 'unused'), '--form', 'rondo'], { encoding: 'utf8', cwd: ROOT });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--form must be one of loop, subtractive, aba, abac/);
  });
});
