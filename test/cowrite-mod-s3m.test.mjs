/** OSS-19: MOD and S3M importers. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { importMidi } from '../src/cowrite/import-midi.mjs';
import { importMod } from '../src/cowrite/import-mod.mjs';
import { importS3m } from '../src/cowrite/import-s3m.mjs';
import { validateSourceSong } from '../src/cowrite/source-song.mjs';
import { FIXTURE, writeFixtureType1 } from './helpers/write-midi.mjs';
import { writeFixtureMod, writeMod } from './helpers/write-mod.mjs';
import { writeFixtureS3m, writeS3m } from './helpers/write-s3m.mjs';
import {
  PITCH_CONVENTION_LINE,
  ROWS_PER_BEAT_LINE,
  effectiveBpm,
  periodToMidi,
  s3mNoteToMidi,
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

describe('OSS-19 MOD and S3M', () => {
  it('period and S3M note tables honour sample-native MIDI 60', () => {
    assert.equal(periodToMidi(428), 60);
    assert.equal(periodToMidi(214), 72);
    assert.equal(s3mNoteToMidi(0x40), 60); // C-4
    assert.equal(s3mNoteToMidi(0x50), 72); // C-5
    assert.equal(effectiveBpm(120, 6), 120);
    assert.equal(effectiveBpm(125, 6), 125);
  });

  it('MOD fixture matches MIDI melody/bass beats and pitches; BPM 120; drums kind', () => {
    const midiSong = validateSourceSong(importMidi(writeFixtureType1(), 'fixture.mid'));
    const modSong = validateSourceSong(importMod(writeFixtureMod(), 'fixture.mod'));
    assert.equal(modSong.tempo, 120);
    assert.equal(modSong.provenance.importer, 'mod');
    assert.ok(Math.abs(modSong.tempoMap[0].bpm - 120) < 1e-9);

    const midiRoles = byRole(midiSong);
    const modRoles = byRole(modSong);
    assert.ok(modRoles.melody);
    assert.ok(modRoles.bass);
    assert.ok(modRoles.drums);
    assert.equal(modRoles.drums.kind, 'drums');
    assert.match(modRoles.drums.instrumentName, /\bBD\b/i);

    assert.deepEqual(pitchBeatPairs(modRoles.melody.notes), pitchBeatPairs(midiRoles.melody.notes));
    assert.deepEqual(pitchBeatPairs(modRoles.bass.notes), pitchBeatPairs(midiRoles.bass.notes));
    assert.deepEqual(
      modRoles.melody.notes.map((n) => n.lengthBeats),
      midiRoles.melody.notes.map((n) => n.lengthBeats),
    );
    assert.deepEqual(
      modRoles.bass.notes.map((n) => n.lengthBeats),
      midiRoles.bass.notes.map((n) => n.lengthBeats),
    );
  });

  it('S3M fixture matches MIDI melody/bass beats and pitches; BPM 120; drums kind', () => {
    const midiSong = validateSourceSong(importMidi(writeFixtureType1(), 'fixture.mid'));
    const s3mSong = validateSourceSong(importS3m(writeFixtureS3m(), 'fixture.s3m'));
    assert.equal(s3mSong.tempo, 120);
    assert.equal(s3mSong.provenance.importer, 's3m');

    const midiRoles = byRole(midiSong);
    const s3mRoles = byRole(s3mSong);
    assert.equal(s3mRoles.drums.kind, 'drums');
    assert.match(s3mRoles.drums.instrumentName, /\bBD\b/i);

    assert.deepEqual(pitchBeatPairs(s3mRoles.melody.notes), pitchBeatPairs(midiRoles.melody.notes));
    assert.deepEqual(pitchBeatPairs(s3mRoles.bass.notes), pitchBeatPairs(midiRoles.bass.notes));
    assert.deepEqual(
      s3mRoles.melody.notes.map((n) => n.lengthBeats),
      midiRoles.melody.notes.map((n) => n.lengthBeats),
    );
    assert.deepEqual(
      s3mRoles.bass.notes.map((n) => n.lengthBeats),
      midiRoles.bass.notes.map((n) => n.lengthBeats),
    );
  });

  it('B00 at the last row ends the song without looping (MOD and S3M)', () => {
    const modSong = validateSourceSong(importMod(writeFixtureMod(), 'loop.mod'));
    const s3mSong = validateSourceSong(importS3m(writeFixtureS3m(), 'loop.s3m'));
    // 32 musical rows at 4 rows/beat = 8 beats; must not repeat the order.
    assert.ok(modSong.lengthBeats <= 8.0001, `mod lengthBeats=${modSong.lengthBeats}`);
    assert.ok(s3mSong.lengthBeats <= 8.0001, `s3m lengthBeats=${s3mSong.lengthBeats}`);
    assert.equal(modRolesSafeCount(modSong), FIXTURE.melody.length);
    assert.equal(s3mRolesSafeCount(s3mSong), FIXTURE.melody.length);
  });

  it('EC3 / SC3 shortens a note to 3 ticks', () => {
    const modSong = validateSourceSong(importMod(writeMod({ noteCutDemo: true }), 'cut.mod'));
    const s3mSong = validateSourceSong(importS3m(writeS3m({ noteCutDemo: true }), 'cut.s3m'));
    const modMel = byRole(modSong).melody;
    const s3mMel = byRole(s3mSong).melody;
    const cutMod = modMel.notes.find((n) => n.beat === 1);
    const cutS3m = s3mMel.notes.find((n) => n.beat === 1);
    assert.ok(cutMod, 'expected MOD note at beat 1');
    assert.ok(cutS3m, 'expected S3M note at beat 1');
    // 3 ticks / speed 6 / 4 rows per beat = 0.125 beats
    assert.ok(Math.abs(cutMod.lengthBeats - 0.125) < 1e-9, `mod len=${cutMod.lengthBeats}`);
    assert.ok(Math.abs(cutS3m.lengthBeats - 0.125) < 1e-9, `s3m len=${cutS3m.lengthBeats}`);
  });

  it('rejects 15-sample MOD and missing SCRM', () => {
    const short = Buffer.alloc(1084);
    short.write('M.K.', 1080, 4, 'ascii');
    // Corrupt signature
    const badSig = Buffer.from(short);
    badSig.write('2CHN', 1080, 4, 'ascii');
    assert.throws(() => importMod(badSig, 'x.mod'), /not a 31-sample MOD/);

    const notS3m = Buffer.alloc(0x60);
    assert.throws(() => importS3m(notS3m, 'x.s3m'), /SCRM/);
  });

  it('CLI imports .mod and .s3m, prints pitch convention, hands .xrns to the XRNS importer (OSS-18)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-mod-s3m-'));
    try {
      const modPath = join(dir, 'song.mod');
      const s3mPath = join(dir, 'song.s3m');
      writeFileSync(modPath, writeFixtureMod());
      writeFileSync(s3mPath, writeFixtureS3m());

      const modOut = join(dir, 'mod.source.json');
      const modRun = spawnSync(process.execPath, [CLI, modPath, '-o', modOut], {
        encoding: 'utf8',
        cwd: ROOT,
      });
      assert.equal(modRun.status, 0, modRun.stderr || modRun.stdout);
      assert.match(modRun.stdout, new RegExp(PITCH_CONVENTION_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(modRun.stdout, new RegExp(ROWS_PER_BEAT_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(modRun.stdout, /tempo:\s*120/);
      validateSourceSong(JSON.parse(readFileSync(modOut, 'utf8')));

      const s3mOut = join(dir, 's3m.source.json');
      const s3mRun = spawnSync(process.execPath, [CLI, s3mPath, '-o', s3mOut], {
        encoding: 'utf8',
        cwd: ROOT,
      });
      assert.equal(s3mRun.status, 0, s3mRun.stderr || s3mRun.stdout);
      assert.match(s3mRun.stdout, /pitch convention/);
      validateSourceSong(JSON.parse(readFileSync(s3mOut, 'utf8')));

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
});

function modRolesSafeCount(song) {
  return byRole(song).melody.notes.length;
}

function s3mRolesSafeCount(song) {
  return byRole(song).melody.notes.length;
}
