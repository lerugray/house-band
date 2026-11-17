/** OSS-21: cowrite as-written. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { asWritten, noteTiming, midiToNoteName } from '../src/cowrite/as-written.mjs';
import { importMidi } from '../src/cowrite/import-midi.mjs';
import { validateSourceSong } from '../src/cowrite/source-song.mjs';
import { validateSpec } from '../src/spec.mjs';
import { renderSpecToWav } from '../src/render.mjs';
import { writeFixtureType1 } from './helpers/write-midi.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'tools', 'cowrite', 'as-written.mjs');

function fixtureSong() {
  return validateSourceSong(importMidi(writeFixtureType1(), 'fixture.mid'));
}

function stepsByVoice(spec, voice) {
  return spec.tracks.song.steps.filter((s) => s.voice === voice);
}

describe('OSS-21 cowrite as-written', () => {
  it('builds a valid one-track score from the OSS-17 shared fixture', () => {
    const song = fixtureSong();
    const { spec, bars, messages } = asWritten(song);
    assert.equal(messages.length, 0);
    assert.doesNotThrow(() => validateSpec(structuredClone(spec)));

    assert.equal(Object.keys(spec.tracks).join(','), 'song');
    assert.equal(spec.tracks.song.len, 32);
    assert.equal(bars, 2);
    assert.equal(spec.sections.length, 1);
    assert.deepEqual(spec.sections[0], { track: 'song', bars: 2, fadeIn: 0.01 });
    assert.equal(spec.seed, 1);
    assert.equal(spec.kit, 'tr808');
    assert.equal(spec.label, 'As written: fixture');
    assert.equal(spec.register.name, 'as-written');
    assert.equal(spec.register.briefRef, 'docs/CO-WRITE.md');

    const leads = stepsByVoice(spec, 'lead');
    assert.deepEqual(
      leads.map((s) => s.i),
      [0, 4, 8, 12, 16, 24],
    );
    for (const s of leads) {
      assert.ok(s.note);
      assert.ok(s.dur > 0);
    }

    const bass = stepsByVoice(spec, 'bass');
    assert.equal(bass.length, 2);
    for (const s of bass) assert.equal(s.voice, 'bass');

    const kicks = stepsByVoice(spec, 'kick');
    assert.deepEqual(
      kicks.map((s) => s.i),
      [0, 8, 16, 24],
    );
    for (const s of kicks) {
      assert.equal(s.note, undefined);
      assert.equal(s.dur, undefined);
    }

    const snares = stepsByVoice(spec, 'snare');
    assert.deepEqual(
      snares.map((s) => s.i),
      [4, 12, 20, 28],
    );
    for (const s of snares) {
      assert.equal(s.note, undefined);
      assert.equal(s.dur, undefined);
    }
  });

  it('maps beat 0.1 at 120 BPM to i 0 nudge 50 without clamp; offsetMs 10 clamps', () => {
    const base = fixtureSong();
    const moved = JSON.parse(JSON.stringify(base));
    const melody = moved.tracks.find((t) => t.roleGuess === 'melody');
    melody.notes[0] = { ...melody.notes[0], beat: 0.1, offsetMs: 0 };

    const { i, nudgeMs } = noteTiming(0.1, 0, 120);
    assert.equal(i, 0);
    assert.equal(nudgeMs, 50);

    const ok = asWritten(moved);
    const lead0 = ok.spec.tracks.song.steps.find((s) => s.voice === 'lead' && s.i === 0);
    assert.ok(lead0);
    assert.equal(lead0.nudge, 50);
    assert.equal(ok.clampedCount, 0);

    melody.notes[0] = { ...melody.notes[0], beat: 0.1, offsetMs: 10 };
    const clamped = asWritten(moved);
    const leadClamped = clamped.spec.tracks.song.steps.find((s) => s.voice === 'lead' && s.i === 0);
    assert.equal(leadClamped.nudge, 50);
    assert.equal(clamped.clampedCount, 1);
    assert.ok(clamped.messages.some((m) => /nudge clamped: 1/.test(m)));
  });

  it('rendering twice gives identical WAV bytes', async () => {
    const { spec } = asWritten(fixtureSong());
    const a = await renderSpecToWav(spec);
    const b = await renderSpecToWav(spec);
    assert.equal(Buffer.from(a.wav).equals(Buffer.from(b.wav)), true);
  });

  it('midiToNoteName matches noteFreq grammar', () => {
    assert.equal(midiToNoteName(60), 'C4');
    assert.equal(midiToNoteName(72), 'C5');
    assert.equal(midiToNoteName(61), 'C#4');
  });

  it('CLI writes score, wav and manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-as-written-'));
    try {
      const mid = join(dir, 'fixture.mid');
      writeFileSync(mid, writeFixtureType1());
      const importCli = join(ROOT, 'tools', 'cowrite', 'import.mjs');
      const imported = spawnSync(process.execPath, [importCli, mid, '-o', join(dir, 'song.source.json')], {
        encoding: 'utf8',
        cwd: ROOT,
      });
      assert.equal(imported.status, 0, imported.stderr || imported.stdout);

      const outWav = join(dir, 'before.wav');
      const scoreOut = join(dir, 'before.score.json');
      const result = spawnSync(
        process.execPath,
        [CLI, join(dir, 'song.source.json'), '-o', outWav, '--score-out', scoreOut],
        { encoding: 'utf8', cwd: ROOT },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const score = JSON.parse(readFileSync(scoreOut, 'utf8'));
      assert.equal(score.tracks.song.len, 32);
      assert.ok(readFileSync(outWav).length > 44);
      assert.ok(readFileSync(`${outWav}.manifest.json`, 'utf8').includes('sha256'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
