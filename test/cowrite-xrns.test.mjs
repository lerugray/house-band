/** OSS-18: XRNS importer, zip/xml helpers, strip tool, notes-only examples. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { importMidi } from '../src/cowrite/import-midi.mjs';
import {
  importXrns,
  midiToNoteName,
  delayToOffsetMs,
} from '../src/cowrite/import-xrns.mjs';
import { validateSourceSong } from '../src/cowrite/source-song.mjs';
import {
  extractMember,
  listMembers,
  writeZipStored,
} from '../src/cowrite/zip.mjs';
import { parseXml, childText } from '../src/cowrite/xml.mjs';
import { FIXTURE, writeFixtureType1 } from './helpers/write-midi.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STRIP = join(ROOT, 'tools', 'cowrite', 'strip-xrns.mjs');
const EXAMPLES = join(ROOT, 'examples', 'co-write', 'appendix-n');
const APPENDIX_N_DIR = process.env.APPENDIX_N_DIR || '';

/** Renoise tracker note for a sounding MIDI pitch (plugin instruments: sounding = renoise - 12). */
function renoiseNameForPluginSounding(midi) {
  const renoiseMidi = midi + 12;
  const NOTES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
  const pc = renoiseMidi % 12;
  const oct = Math.floor(renoiseMidi / 12) - 1;
  return `${NOTES[pc]}${oct}`;
}

function noteColumn(note, inst, vol = null, delay = null) {
  let body = `<Note>${note}</Note><Instrument>${inst}</Instrument>`;
  if (vol != null) body += `<Volume>${vol}</Volume>`;
  if (delay != null) body += `<Delay>${delay}</Delay>`;
  return `<NoteColumn>${body}</NoteColumn>`;
}

function lineXml(index, columnsXml) {
  return `<Line index="${index}"><NoteColumns>${columnsXml}</NoteColumns></Line>`;
}

function patternTrack(linesXml) {
  return `<PatternTrack type="PatternTrack"><Lines>${linesXml}</Lines></PatternTrack>`;
}

function emptyPatternTrack() {
  return `<PatternTrack type="PatternTrack"/>`;
}

/**
 * Build a minimal Renoise Song.xml for the shared fixture (plugin melody+bass, sample BD 01 drums).
 */
function buildFixtureSongXml(opts = {}) {
  const lpb = opts.lpb ?? 4;
  const bpm = opts.bpm ?? 120;
  const lines = opts.lines ?? 32;
  const muteDrumsInEntry0 = Boolean(opts.muteDrumsInEntry0);
  const delayHex = opts.delayHex ?? null;

  const melLines = [];
  for (const n of FIXTURE.melody) {
    const line = Math.round(n.beat * lpb);
    const note = renoiseNameForPluginSounding(n.midi);
    melLines.push(
      lineXml(line, noteColumn(note, '00', null, line === 0 && delayHex ? delayHex : null)),
    );
  }
  const bassLines = [];
  for (const n of FIXTURE.bass) {
    const line = Math.round(n.beat * lpb);
    bassLines.push(lineXml(line, noteColumn(renoiseNameForPluginSounding(n.midi), '00')));
  }
  const drumLines = [];
  for (const n of FIXTURE.drums) {
    const line = Math.round(n.beat * lpb);
    const offLine = Math.round((n.beat + n.lengthBeats) * lpb);
    drumLines.push(lineXml(line, noteColumn('C-4', '01')));
    // Tracker notes run to the next note or OFF; place OFF so length matches MIDI.
    drumLines.push(lineXml(offLine, noteColumn('OFF', '01')));
  }

  const pattern0Tracks = [
    patternTrack(melLines.join('')),
    patternTrack(bassLines.join('')),
    patternTrack(drumLines.join('')),
    emptyPatternTrack(),
  ].join('');

  let sequenceXml;
  if (opts.twoEntriesMute) {
    // Two copies of the same pattern; mute drums (track 2) only in the first entry.
    sequenceXml = `
      <SequenceEntry>
        <Pattern>0</Pattern>
        <MutedTracks><MutedTrack>2</MutedTrack></MutedTracks>
      </SequenceEntry>
      <SequenceEntry>
        <Pattern>0</Pattern>
      </SequenceEntry>`;
  } else if (muteDrumsInEntry0) {
    sequenceXml = `
      <SequenceEntry>
        <Pattern>0</Pattern>
        <MutedTracks><MutedTrack>2</MutedTrack></MutedTracks>
      </SequenceEntry>`;
  } else {
    sequenceXml = `<SequenceEntry><Pattern>0</Pattern></SequenceEntry>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<RenoiseSong doc_version="67">
  <GlobalSongData>
    <BeatsPerMin>${bpm}</BeatsPerMin>
    <LinesPerBeat>${lpb}</LinesPerBeat>
    <SongName>fixture</SongName>
    <SignatureNumerator>4</SignatureNumerator>
    <SignatureDenominator>4</SignatureDenominator>
  </GlobalSongData>
  <Instruments>
    <Instrument>
      <Name>Lead Plugin</Name>
      <PluginProperties>
        <PluginDevice>
          <PluginDisplayName>TestPlug</PluginDisplayName>
        </PluginDevice>
      </PluginProperties>
    </Instrument>
    <Instrument>
      <Name>BD 01</Name>
    </Instrument>
  </Instruments>
  <Tracks>
    <SequencerTrack><Name>Melody</Name></SequencerTrack>
    <SequencerTrack><Name>Bass</Name></SequencerTrack>
    <SequencerTrack><Name>Drums</Name></SequencerTrack>
    <SequencerMasterTrack><Name>Master</Name></SequencerMasterTrack>
  </Tracks>
  <PatternPool>
    <Patterns>
      <Pattern>
        <NumberOfLines>${lines}</NumberOfLines>
        <Tracks>${pattern0Tracks}</Tracks>
      </Pattern>
    </Patterns>
  </PatternPool>
  <PatternSequence>
    <SequenceEntries>${sequenceXml}</SequenceEntries>
  </PatternSequence>
</RenoiseSong>
`;
}

function zipSongXml(xmlString) {
  const data = Buffer.from(xmlString, 'utf8');
  return writeZipStored([{ name: 'Song.xml', data }]);
}

function byRole(song) {
  const map = {};
  for (const t of song.tracks) map[t.roleGuess] = t;
  return map;
}

function pitchedNotes(track) {
  return track.notes.map((n) => ({
    beat: n.beat,
    lengthBeats: n.lengthBeats,
    midi: n.midi,
  }));
}

describe('OSS-18 XRNS import', () => {
  it('xml.mjs parses elements, attrs, CDATA, comments, entities; rejects DTD', () => {
    const doc = parseXml(
      `<?xml version="1.0"?>\n<!-- hi -->\n<root a="1" b='&lt;x&gt;'><child>A&amp;B&#65;&#x42;<![CDATA[<>]]></child></root>`,
    );
    assert.equal(doc.name, 'root');
    assert.equal(doc.attrs.a, '1');
    assert.equal(doc.attrs.b, '<x>');
    assert.equal(childText(doc, 'child'), 'A&BAB<>');
    assert.throws(() => parseXml('<!DOCTYPE foo><root/>'), /DTD/);
  });

  it('synthetic fixture matches MIDI import (beats, pitches; drums pitches aside)', () => {
    const xml = buildFixtureSongXml();
    const zip = zipSongXml(xml);
    const xrns = validateSourceSong(importXrns(zip, 'fixture.xrns'));
    const midi = validateSourceSong(importMidi(writeFixtureType1(), 'fixture.mid'));

    const x = byRole(xrns);
    const m = byRole(midi);
    assert.ok(x.melody && x.bass && x.drums);
    assert.equal(x.drums.kind, 'drums');
    assert.equal(x.drums.instrumentName, 'BD 01');
    assert.deepEqual(pitchedNotes(x.melody), pitchedNotes(m.melody));
    assert.deepEqual(pitchedNotes(x.bass), pitchedNotes(m.bass));
    assert.deepEqual(
      x.drums.notes.map((n) => ({ beat: n.beat, lengthBeats: n.lengthBeats })),
      m.drums.notes.map((n) => ({ beat: n.beat, lengthBeats: n.lengthBeats })),
    );
  });

  it('Delay 0x80 at 120 BPM LPB 4 is offsetMs 62.5; muted track drops only that entry', () => {
    assert.equal(delayToOffsetMs('80', 120, 4), 62.5);

    const withDelay = validateSourceSong(
      importXrns(zipSongXml(buildFixtureSongXml({ delayHex: '80' })), 'delay.xrns'),
    );
    const mel = byRole(withDelay).melody;
    assert.equal(mel.notes[0].offsetMs, 62.5);
    assert.equal(mel.notes[0].beat, 0);

    const muted = validateSourceSong(
      importXrns(zipSongXml(buildFixtureSongXml({ twoEntriesMute: true, lines: 32 })), 'mute.xrns'),
    );
    const drums = muted.tracks.find((t) => t.kind === 'drums');
    assert.ok(drums);
    // First entry muted: drums only from second copy (beats shifted by 8).
    assert.equal(drums.notes.length, FIXTURE.drums.length);
    assert.ok(drums.notes.every((n) => n.beat >= 8));
    assert.deepEqual(
      drums.notes.map((n) => n.beat),
      FIXTURE.drums.map((n) => n.beat + 8),
    );

    // Melody still has both entries' notes.
    const melody = byRole(muted).melody;
    assert.equal(melody.notes.length, FIXTURE.melody.length * 2);
  });

  it('strip-xrns writes Song.xml-only zip with identical member bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-strip-'));
    try {
      const xml = buildFixtureSongXml();
      const extra = Buffer.from('not-song');
      // Input zip: Song.xml (deflate would be fine; stored is enough) + another member.
      const input = writeZipStored([
        { name: 'Song.xml', data: Buffer.from(xml, 'utf8') },
        { name: 'SampleData/x.flac', data: extra },
      ]);
      const inPath = join(dir, 'in.xrns');
      const outPath = join(dir, 'out.xrns');
      writeFileSync(inPath, input);

      const result = spawnSync(process.execPath, [STRIP, inPath, outPath], {
        encoding: 'utf8',
        cwd: ROOT,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /SampleData\/x\.flac/);

      const outBytes = readFileSync(outPath);
      assert.deepEqual(listMembers(outBytes), ['Song.xml']);
      const inSong = extractMember(input, 'Song.xml');
      const outSong = extractMember(outBytes, 'Song.xml');
      assert.deepEqual(Buffer.from(outSong), Buffer.from(inSong));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('notes-only examples contain no SampleData/ members', () => {
    const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.notes.xrns'));
    assert.ok(files.length >= 4, `expected notes-only xrns in ${EXAMPLES}`);
    for (const f of files) {
      const members = listMembers(readFileSync(join(EXAMPLES, f)));
      assert.deepEqual(members, ['Song.xml'], f);
      assert.ok(!members.some((m) => m.startsWith('SampleData/')));
    }
  });

  it('APPENDIX_N_DIR: import matches ray-s332 data modules (skip if unset)', async (t) => {
    if (!APPENDIX_N_DIR) {
      t.skip('APPENDIX_N_DIR not set');
      return;
    }
    const srcDir = join(APPENDIX_N_DIR, 'assets', 'music', 'source', 'ray-renoise-2026-07');
    const dataDir = join(APPENDIX_N_DIR, 'tools', 'score', 'ray-s332');
    const pairs = [
      ['ANfirstdecent.xrns', 'ray-firstdecent.data.mjs', 'RAY_ANFIRSTDECENT'],
      ['maybean2.xrns', 'ray-maybean2.data.mjs', 'RAY_MAYBEAN2'],
      ['ANattempt1.xrns', 'ray-anattempt1.data.mjs', 'RAY_ANATTEMPT1'],
      ['anexperiment.xrns', 'ray-anexperiment.data.mjs', 'RAY_ANEXPERIMENT'],
      ['newan3.xrns', 'ray-newan3.data.mjs', 'RAY_NEWAN3'],
    ];

    for (const [xrnsName, dataFile, exportName] of pairs) {
      const xrnsPath = join(srcDir, xrnsName);
      const dataPath = join(dataDir, dataFile);
      const bytes = readFileSync(xrnsPath);
      const song = importXrns(bytes, xrnsName);
      const xml = Buffer.from(extractMember(bytes, 'Song.xml')).toString('utf8');
      const root = parseXml(xml);
      const global = root.children.find((c) => c.name === 'GlobalSongData');
      const useLpb = Number.parseInt(childText(global, 'LinesPerBeat', '4'), 10);

      const mod = await import(pathToFileURL(dataPath).href);
      const data = mod[exportName];
      assert.ok(data, `missing export ${exportName}`);

      const header = readFileSync(dataPath, 'utf8')
        .split('\n')
        .find((line) => line.includes('Renoise delay as ms at'));
      assert.ok(header, `header comment in ${dataFile}`);
      const hm = /Renoise delay as ms at ([0-9.]+) BPM/.exec(header);
      assert.ok(hm, `header BPM in ${dataFile}`);
      const headerBpm = Number.parseFloat(hm[1]);
      const songBpm = song.tempo;

      for (const [trackId, col] of Object.entries(data)) {
        if (trackId === 'totalLines' || trackId === 'bpm') continue;
        const track = song.tracks.find((tr) => tr.id === trackId);
        assert.ok(track, `${xrnsName}: missing track ${trackId}`);
        const got = track.notes.map((n) => [
          n.beat * useLpb,
          midiToNoteName(n.midi),
          n.velocity,
        ]);
        const expected = col.ev.map((ev) => [ev[0], ev[2], ev[3]]);
        assert.deepEqual(got, expected, `${xrnsName} ${trackId} [line,note,vol]`);

        for (let i = 0; i < col.ev.length; i++) {
          const storedMs = col.ev[i][4];
          const scaled = track.notes[i].offsetMs * (songBpm / headerBpm);
          assert.ok(
            Math.abs(scaled - storedMs) <= 0.1,
            `${xrnsName} ${trackId}[${i}] delay ${scaled} vs ${storedMs}`,
          );
        }
      }
    }

    // notes-only copies have no SampleData
    for (const f of readdirSync(EXAMPLES).filter((x) => x.endsWith('.notes.xrns'))) {
      const members = listMembers(readFileSync(join(EXAMPLES, f)));
      assert.ok(!members.some((m) => m.startsWith('SampleData/')), f);
    }
  });
});
