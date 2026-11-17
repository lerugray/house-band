/** OSS-17: source-song format + MIDI importer. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { importMidi } from '../src/cowrite/import-midi.mjs';
import {
  meanPolyphony,
  medianPitch,
  roleGuess,
  validateSourceSong,
  SourceSongError,
} from '../src/cowrite/source-song.mjs';
import {
  FIXTURE,
  writeFixtureType0,
  writeFixtureType1,
  writeMidi,
} from './helpers/write-midi.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'tools', 'cowrite', 'import.mjs');

function expectedNotes(list) {
  return list.map((n) => ({
    beat: n.beat,
    lengthBeats: n.lengthBeats,
    midi: n.midi,
    velocity: (n.velocity ?? 100) / 127,
    offsetMs: 0,
  }));
}

function byRole(song) {
  const map = {};
  for (const t of song.tracks) {
    map[t.roleGuess] = t;
  }
  return map;
}

function stripIds(tracks) {
  return tracks.map(({ id, ...rest }) => rest);
}

describe('OSS-17 source-song + MIDI', () => {
  it('imports shared fixture type 1 with melody/bass/drums roles and exact notes', () => {
    const bytes = writeFixtureType1();
    const song = validateSourceSong(importMidi(bytes, 'fixture.mid'));
    assert.equal(song.tracks.length, 3);
    assert.equal(song.tempo, 120);
    assert.deepEqual(song.timeSignature, [4, 4]);
    assert.equal(song.sequence, null);
    assert.equal(song.provenance.importer, 'midi');
    assert.equal(song.provenance.file, 'fixture.mid');

    const roles = byRole(song);
    assert.ok(roles.melody, 'expected melody track');
    assert.ok(roles.bass, 'expected bass track');
    assert.ok(roles.drums, 'expected drums track');
    assert.equal(roles.drums.kind, 'drums');
    assert.equal(roles.drums.instrumentName, 'GM drums');
    assert.equal(roles.melody.instrumentName, 'Lead 1 (square)');
    assert.equal(roles.bass.instrumentName, 'Acoustic Bass');

    assert.deepEqual(roles.melody.notes, expectedNotes(FIXTURE.melody));
    assert.deepEqual(roles.bass.notes, expectedNotes(FIXTURE.bass));
    assert.deepEqual(roles.drums.notes, expectedNotes(FIXTURE.drums));
  });

  it('type 0 and type 1 import to identical tracks (ids aside)', () => {
    const type1 = validateSourceSong(importMidi(writeFixtureType1(), 'a.mid'));
    const type0 = validateSourceSong(importMidi(writeFixtureType0(), 'a.mid'));
    assert.deepEqual(stripIds(type0.tracks), stripIds(type1.tracks));
    assert.equal(type0.tempo, type1.tempo);
    assert.deepEqual(type0.timeSignature, type1.timeSignature);
    assert.equal(type0.lengthBeats, type1.lengthBeats);
  });

  it('tempo change to 90 at bar 2 appears in tempoMap', () => {
    const bytes = writeFixtureType1({
      tempoChanges: [{ beat: 4, bpm: 90 }],
    });
    const song = validateSourceSong(importMidi(bytes, 'tempo.mid'));
    assert.equal(song.tempo, 120);
    assert.ok(song.tempoMap.length >= 2);
    assert.deepEqual(song.tempoMap[0], { beat: 0, bpm: 120 });
    const change = song.tempoMap.find((e) => e.beat === 4);
    assert.ok(change, 'expected tempoMap entry at beat 4');
    assert.ok(Math.abs(change.bpm - 90) < 0.01, `bpm=${change.bpm}`);
  });

  it('handles running status and sysex in the stream', () => {
    const bytes = writeFixtureType1({ useRunningStatus: true, insertSysex: true });
    const song = validateSourceSong(importMidi(bytes, 'run.mid'));
    assert.equal(song.tracks.length, 3);
    const roles = byRole(song);
    assert.deepEqual(roles.melody.notes, expectedNotes(FIXTURE.melody));
    assert.deepEqual(roles.bass.notes, expectedNotes(FIXTURE.bass));
    assert.deepEqual(roles.drums.notes, expectedNotes(FIXTURE.drums));
  });

  it('rejects SMF type 2 and SMPTE division', () => {
    const type2 = Buffer.alloc(14);
    type2.write('MThd', 0, 4, 'ascii');
    type2.writeUInt32BE(6, 4);
    type2.writeUInt16BE(2, 8);
    type2.writeUInt16BE(0, 10);
    type2.writeUInt16BE(480, 12);
    assert.throws(() => importMidi(type2, 'x.mid'), /SMF type 2 not supported/);

    const smpte = Buffer.alloc(14);
    smpte.write('MThd', 0, 4, 'ascii');
    smpte.writeUInt32BE(6, 4);
    smpte.writeUInt16BE(0, 8);
    smpte.writeUInt16BE(1, 10);
    smpte.writeUInt16BE(0x8000 | (24 << 8) | 40, 12);
    assert.throws(() => importMidi(smpte, 'x.mid'), /SMPTE/);
  });

  it('roleGuess: drums, chords by polyphony, bass by median, highest remaining is melody', () => {
    const tracks = [
      {
        id: 'a',
        name: 'a',
        instrumentName: 'x',
        kind: 'pitched',
        notes: [
          { beat: 0, lengthBeats: 1, midi: 60, velocity: 1, offsetMs: 0 },
          { beat: 0, lengthBeats: 1, midi: 64, velocity: 1, offsetMs: 0 },
          { beat: 0, lengthBeats: 1, midi: 67, velocity: 1, offsetMs: 0 },
        ],
      },
      {
        id: 'b',
        name: 'b',
        instrumentName: 'x',
        kind: 'pitched',
        notes: [
          { beat: 0, lengthBeats: 4, midi: 36, velocity: 1, offsetMs: 0 },
          { beat: 4, lengthBeats: 4, midi: 40, velocity: 1, offsetMs: 0 },
        ],
      },
      {
        id: 'c',
        name: 'c',
        instrumentName: 'x',
        kind: 'pitched',
        notes: [
          { beat: 0, lengthBeats: 1, midi: 72, velocity: 1, offsetMs: 0 },
          { beat: 1, lengthBeats: 1, midi: 74, velocity: 1, offsetMs: 0 },
        ],
      },
      {
        id: 'd',
        name: 'd',
        instrumentName: 'x',
        kind: 'drums',
        notes: [{ beat: 0, lengthBeats: 0.5, midi: 36, velocity: 1, offsetMs: 0 }],
      },
      {
        id: 'e',
        name: 'e',
        instrumentName: 'x',
        kind: 'pitched',
        notes: [{ beat: 0, lengthBeats: 1, midi: 55, velocity: 1, offsetMs: 0 }],
      },
    ];
    assert.ok(meanPolyphony(tracks[0].notes) >= 2.5);
    assert.ok(medianPitch(tracks[1].notes) < 48);
    roleGuess(tracks);
    assert.equal(tracks[0].roleGuess, 'chords');
    assert.equal(tracks[1].roleGuess, 'bass');
    assert.equal(tracks[2].roleGuess, 'melody');
    assert.equal(tracks[3].roleGuess, 'drums');
    assert.equal(tracks[4].roleGuess, 'other');
  });

  it('validateSourceSong rejects bad format and accepts a good song', () => {
    const song = importMidi(writeFixtureType1(), 'ok.mid');
    const ok = validateSourceSong(song);
    assert.equal(ok.format, 'house-band-source-song');
    assert.throws(
      () => validateSourceSong({ ...JSON.parse(JSON.stringify(song)), format: 'nope' }),
      (err) => err instanceof SourceSongError && err.path === 'format',
    );
  });

  it('CLI writes source JSON and prints summary; .xrns goes to the XRNS importer (OSS-18)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-cowrite-'));
    try {
      const midPath = join(dir, 'song.mid');
      writeFileSync(midPath, writeFixtureType1());
      const outPath = join(dir, 'out.source.json');
      const result = spawnSync(process.execPath, [CLI, midPath, '-o', outPath], {
        encoding: 'utf8',
        cwd: ROOT,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /title:/);
      assert.match(result.stdout, /tempo:\s*120/);
      assert.match(result.stdout, /melody/);
      assert.match(result.stdout, /bass/);
      assert.match(result.stdout, /drums/);
      const written = JSON.parse(readFileSync(outPath, 'utf8'));
      validateSourceSong(written);

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

  it('writeMidi helper emits readable type 0 with optional extras', () => {
    const bytes = writeMidi({
      format: 0,
      useRunningStatus: true,
      insertSysex: true,
      tempoChanges: [{ beat: 4, bpm: 90 }],
    });
    const song = importMidi(bytes, 'extra.mid');
    assert.equal(song.tracks.length, 3);
    assert.ok(song.tempoMap.some((e) => e.beat === 4 && Math.abs(e.bpm - 90) < 0.01));
  });
});
