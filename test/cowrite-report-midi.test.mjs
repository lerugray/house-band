/** OSS-23: co-write report + arrangement MIDI export. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { developScore } from '../src/cowrite/develop.mjs';
import { exportArrangementMidi, majorityOriginLabel } from '../src/cowrite/export-midi.mjs';
import { importMidi } from '../src/cowrite/import-midi.mjs';
import { buildCowriteReport } from '../src/cowrite/report.mjs';
import { validateSourceSong } from '../src/cowrite/source-song.mjs';
import { renderSpecToWav } from '../src/render.mjs';
import { FIXTURE, writeFixtureType1 } from './helpers/write-midi.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEVELOP_CLI = join(ROOT, 'tools', 'cowrite', 'develop.mjs');
const EXPORT_CLI = join(ROOT, 'tools', 'cowrite', 'export-midi.mjs');

const REPORT_HEADINGS = [
  '# Co-write:',
  '## Credit',
  '## Sections',
  '## Changes to your notes',
  '## Loudness',
  '## Files',
];

function fixtureSong() {
  return validateSourceSong(importMidi(writeFixtureType1(), 'fixture.mid'));
}

describe('OSS-23 co-write report + arrangement MIDI', () => {
  it('develops the shared fixture with the arranger: report headings in order, Sections table, MIDI round-trip', async () => {
    const source = fixtureSong();
    const { spec, record, keepLayer } = await developScore(source, { engine: 'arranger', form: 'loop' });
    assert.equal(keepLayer.ok, true);

    const { wav } = await renderSpecToWav(spec);
    const develop = {
      format: 'house-band-cowrite-develop',
      source: { title: source.title },
      sections: record.sections,
      changes: record.changes,
      record,
    };
    const report = buildCowriteReport({
      develop,
      spec,
      wavBytes: wav,
      credit: 'the author',
    });

    let cursor = 0;
    for (const heading of REPORT_HEADINGS) {
      const at = report.indexOf(heading, cursor);
      assert.ok(at >= 0, `missing heading ${heading}`);
      assert.ok(at >= cursor, `heading out of order: ${heading}`);
      cursor = at + heading.length;
    }
    assert.match(report, /Music by the author and House Band/);
    assert.match(report, /Section \| Starts at \(m:ss\) \| Bars \| Yours \| Added by House Band/);
    const sectionRows = report.split('\n').filter((l) => /^\w+\d+\s\|/.test(l));
    assert.ok(sectionRows.length >= 1, 'Sections table should be non-empty');
    assert.match(report, /Sample peak:/);
    assert.doesNotMatch(report, /true peak/i);

    const midi = exportArrangementMidi(spec, {
      sections: record.sections,
      timeSignature: source.timeSignature,
    });
    assert.equal(midi[0], 0x4d); // MThd
    assert.equal(midi.readUInt16BE(8), 1); // type 1
    assert.equal(midi.readUInt16BE(12), 480); // PPQ

    const a1 = spec.tracks.A1.steps;
    assert.equal(majorityOriginLabel(a1), 'yours');

    const song = validateSourceSong(importMidi(midi, 'arrangement.mid'));
    const yours = song.tracks.filter((t) => /\(yours\)$/.test(t.name));
    assert.ok(yours.length >= 1, `expected a (yours) track, got ${song.tracks.map((t) => t.name).join(', ')}`);
    const yoursNotes = yours.flatMap((t) => t.notes);
    for (const n of FIXTURE.melody) {
      const hit = yoursNotes.find((x) => x.midi === n.midi && Math.abs(x.beat - n.beat) < 1e-6);
      assert.ok(hit, `missing melody midi=${n.midi} beat=${n.beat} on a (yours) track`);
    }

    const drums = song.tracks.filter((t) => t.kind === 'drums');
    assert.ok(drums.length >= 1, 'drum notes should import as channel-10 / GM drums');
    assert.ok(drums.some((t) => t.instrumentName === 'GM drums'));
    assert.ok(drums.some((t) => t.notes.length > 0));
  });

  it('CLI develop writes arrangement.mid and CO-WRITE-REPORT.md; export-midi CLI works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-oss23-'));
    try {
      const src = join(dir, 'song.source.json');
      writeFileSync(src, `${JSON.stringify(fixtureSong(), null, 2)}\n`);
      const out = join(dir, 'out');
      const r = spawnSync(
        process.execPath,
        [DEVELOP_CLI, src, '-o', out, '--form', 'loop', '--credit', 'Test User'],
        { encoding: 'utf8', cwd: ROOT },
      );
      assert.equal(r.status, 0, r.stderr || r.stdout);
      const report = readFileSync(join(out, 'CO-WRITE-REPORT.md'), 'utf8');
      assert.match(report, /# Co-write: fixture/);
      assert.match(report, /Music by Test User and House Band/);
      for (const heading of REPORT_HEADINGS.slice(1)) assert.ok(report.includes(heading));
      const midiPath = join(out, 'arrangement.mid');
      const midi = readFileSync(midiPath);
      assert.ok(midi.length > 20);
      const song = validateSourceSong(importMidi(midi, 'arrangement.mid'));
      assert.ok(song.tracks.some((t) => /\(yours\)$/.test(t.name)));

      const alt = join(dir, 'alt.mid');
      const e = spawnSync(
        process.execPath,
        [EXPORT_CLI, join(out, 'score.json'), '-o', alt, '--develop', join(out, 'develop.json')],
        { encoding: 'utf8', cwd: ROOT },
      );
      assert.equal(e.status, 0, e.stderr || e.stdout);
      assert.ok(readFileSync(alt).length > 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
