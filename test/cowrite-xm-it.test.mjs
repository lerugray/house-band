/** OSS-20: XM and IT importers. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { importMidi } from '../src/cowrite/import-midi.mjs';
import { importMod } from '../src/cowrite/import-mod.mjs';
import { importS3m } from '../src/cowrite/import-s3m.mjs';
import { importXm, xmNoteToMidi } from '../src/cowrite/import-xm.mjs';
import { importIt, itNoteToMidi } from '../src/cowrite/import-it.mjs';
import { validateSourceSong } from '../src/cowrite/source-song.mjs';
import { FIXTURE, writeFixtureType1 } from './helpers/write-midi.mjs';
import { writeFixtureMod } from './helpers/write-mod.mjs';
import { writeFixtureS3m } from './helpers/write-s3m.mjs';
import { writeFixtureXm, writeXm } from './helpers/write-xm.mjs';
import { writeFixtureIt, writeIt } from './helpers/write-it.mjs';
import {
  PITCH_CONVENTION_LINE,
  ROWS_PER_BEAT_LINE,
  effectiveBpm,
} from '../src/cowrite/tracker-common.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'tools', 'cowrite', 'import.mjs');

function byRole(song) {
  const map = {};
  for (const t of song.tracks) map[t.roleGuess] = t;
  return map;
}

function pitchBeatPairs(notes) {
  return notes.map((n) => ({ beat: n.beat, midi: n.midi }));
}

function assertMelodyBassMatch(label, song, midiSong) {
  const roles = byRole(song);
  const midiRoles = byRole(midiSong);
  assert.ok(roles.melody, `${label}: melody`);
  assert.ok(roles.bass, `${label}: bass`);
  assert.deepEqual(
    pitchBeatPairs(roles.melody.notes),
    pitchBeatPairs(midiRoles.melody.notes),
    `${label}: melody pitches/beats`,
  );
  assert.deepEqual(
    pitchBeatPairs(roles.bass.notes),
    pitchBeatPairs(midiRoles.bass.notes),
    `${label}: bass pitches/beats`,
  );
}

describe('OSS-20 XM and IT', () => {
  it('XM and IT note tables honour sample-native MIDI 60', () => {
    assert.equal(xmNoteToMidi(49), 60); // C-4
    assert.equal(xmNoteToMidi(1), 12); // C-0
    assert.equal(xmNoteToMidi(97), -1); // key off
    assert.equal(itNoteToMidi(60), 60); // C-5
    assert.equal(itNoteToMidi(255), -1);
    assert.equal(itNoteToMidi(254), -1);
    assert.equal(effectiveBpm(120, 6), 120);
  });

  it('XM fixture matches MIDI melody/bass; BPM 120; drums kind; mixed pack forms', () => {
    const midiSong = validateSourceSong(importMidi(writeFixtureType1(), 'fixture.mid'));
    const xmSong = validateSourceSong(importXm(writeFixtureXm(), 'fixture.xm'));
    assert.equal(xmSong.tempo, 120);
    assert.equal(xmSong.provenance.importer, 'xm');
    assert.ok(Math.abs(xmSong.tempoMap[0].bpm - 120) < 1e-9);

    const roles = byRole(xmSong);
    assert.equal(roles.drums.kind, 'drums');
    assert.match(roles.drums.instrumentName, /\bBD\b/i);
    assertMelodyBassMatch('xm', xmSong, midiSong);
    assert.deepEqual(
      roles.melody.notes.map((n) => n.lengthBeats),
      byRole(midiSong).melody.notes.map((n) => n.lengthBeats),
    );
  });

  it('IT fixture matches MIDI melody/bass; BPM 120; drums kind; mask reuse / last-note', () => {
    const midiSong = validateSourceSong(importMidi(writeFixtureType1(), 'fixture.mid'));
    const itSong = validateSourceSong(importIt(writeFixtureIt(), 'fixture.it'));
    assert.equal(itSong.tempo, 120);
    assert.equal(itSong.provenance.importer, 'it');

    const roles = byRole(itSong);
    assert.equal(roles.drums.kind, 'drums');
    assert.match(roles.drums.instrumentName, /\bBD\b/i);
    assertMelodyBassMatch('it', itSong, midiSong);
  });

  it('key-off / note-off ends a note (XM 97, IT 255)', () => {
    const xmSong = validateSourceSong(importXm(writeXm({ keyOffDemo: true }), 'keyoff.xm'));
    const itSong = validateSourceSong(importIt(writeIt({ keyOffDemo: true }), 'keyoff.it'));
    const xmMel = byRole(xmSong).melody;
    const itMel = byRole(itSong).melody;
    const xmCut = xmMel.notes.find((n) => n.beat === 1);
    const itCut = itMel.notes.find((n) => n.beat === 1);
    assert.ok(xmCut, 'expected XM note at beat 1');
    assert.ok(itCut, 'expected IT note at beat 1');
    // Key-off two rows later (0.5 beats at 4 rows/beat).
    assert.ok(Math.abs(xmCut.lengthBeats - 0.5) < 1e-9, `xm len=${xmCut.lengthBeats}`);
    assert.ok(Math.abs(itCut.lengthBeats - 0.5) < 1e-9, `it len=${itCut.lengthBeats}`);
  });

  it('IT importer never reads beyond a pattern stated length', () => {
    const poisoned = writeIt({ poisonPattern: true });
    const song = validateSourceSong(importIt(poisoned, 'poison.it'));
    // Poison would inject midi 90 if over-read; must not appear.
    for (const t of song.tracks) {
      for (const n of t.notes) {
        assert.notEqual(n.midi, 90, 'over-read poison note');
      }
    }
    assert.equal(byRole(song).melody.notes.length, FIXTURE.melody.length);
  });

  it('shared contract: MIDI type 1, MOD, S3M, XM, IT (+ XRNS when present) melody/bass match', async () => {
    const midiSong = validateSourceSong(importMidi(writeFixtureType1(), 'fixture.mid'));
    const songs = [
      ['midi', midiSong],
      ['mod', validateSourceSong(importMod(writeFixtureMod(), 'fixture.mod'))],
      ['s3m', validateSourceSong(importS3m(writeFixtureS3m(), 'fixture.s3m'))],
      ['xm', validateSourceSong(importXm(writeFixtureXm(), 'fixture.xm'))],
      ['it', validateSourceSong(importIt(writeFixtureIt(), 'fixture.it'))],
    ];

    // XRNS (OSS-18) when available on the tree.
    try {
      const xrnsMod = await import(pathToFileURL(join(ROOT, 'src', 'cowrite', 'import-xrns.mjs')).href);
      const writeXrns = await import(pathToFileURL(join(ROOT, 'test', 'helpers', 'write-xrns.mjs')).href);
      if (typeof xrnsMod.importXrns === 'function' && typeof writeXrns.writeFixtureXrns === 'function') {
        songs.push([
          'xrns',
          validateSourceSong(xrnsMod.importXrns(writeXrns.writeFixtureXrns(), 'fixture.xrns')),
        ]);
      }
    } catch {
      // OSS-18 not on this branch; five-importer contract still runs.
    }

    for (const [label, song] of songs) {
      if (label === 'midi') continue;
      assertMelodyBassMatch(label, song, midiSong);
      assert.ok(Math.abs(song.tempo - 120) < 1e-6, `${label} tempo`);
    }
  });

  it('CLI imports .xm and .it, prints pitch convention, hands .xrns to the XRNS importer (OSS-18)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-xm-it-'));
    try {
      const xmPath = join(dir, 'song.xm');
      const itPath = join(dir, 'song.it');
      writeFileSync(xmPath, writeFixtureXm());
      writeFileSync(itPath, writeFixtureIt());

      const xmOut = join(dir, 'xm.source.json');
      const xmRun = spawnSync(process.execPath, [CLI, xmPath, '-o', xmOut], {
        encoding: 'utf8',
        cwd: ROOT,
      });
      assert.equal(xmRun.status, 0, xmRun.stderr || xmRun.stdout);
      assert.match(xmRun.stdout, new RegExp(PITCH_CONVENTION_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(xmRun.stdout, new RegExp(ROWS_PER_BEAT_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(xmRun.stdout, /tempo:\s*120/);
      validateSourceSong(JSON.parse(readFileSync(xmOut, 'utf8')));

      const itOut = join(dir, 'it.source.json');
      const itRun = spawnSync(process.execPath, [CLI, itPath, '-o', itOut], {
        encoding: 'utf8',
        cwd: ROOT,
      });
      assert.equal(itRun.status, 0, itRun.stderr || itRun.stdout);
      assert.match(itRun.stdout, /pitch convention/);
      validateSourceSong(JSON.parse(readFileSync(itOut, 'utf8')));

      writeFileSync(join(dir, 'x.xrns'), 'nope');
      // RC s462: OSS-18's importer is wired into the CLI; a non-zip .xrns now fails in that importer (exit 1).
      const notZip = spawnSync(process.execPath, [CLI, join(dir, 'x.xrns')], {
        encoding: 'utf8',
        cwd: ROOT,
      });
      assert.equal(notZip.status, 1, notZip.stderr);
      assert.doesNotMatch(notZip.stderr, /importer not built yet/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing XM / IT signatures', () => {
    assert.throws(() => importXm(Buffer.alloc(100), 'x.xm'), /Extended Module/);
    assert.throws(() => importIt(Buffer.alloc(0xc0), 'x.it'), /IMPM/);
  });
});
