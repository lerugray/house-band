import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { biquadBand, readWav } from '../tools/lead-balance/lead-balance.mjs';
import { dumpLeadBalanceStems } from '../tools/lead-balance/stems-dump.mjs';

const FS = 22050;

function tone(freqs, seconds, amp, fs = FS, gate = null) {
  const n = Math.round(seconds * fs), out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / fs;
    let v = 0;
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
    out[i] = (amp / freqs.length) * v * (gate ? gate(t) : 1);
  }
  return out;
}

const inBandRms = (x) => {
  const filtered = biquadBand(x, FS, 300, 4000);
  let power = 0;
  for (const sample of filtered) power += sample * sample;
  return Math.sqrt(power / filtered.length);
};

const bed = tone([330, 440, 660, 880], 12, 0.2);
const bedRms = inBandRms(bed);

function leadAt(marginDb) {
  const raw = tone([1000, 1500], 12, 1);
  const target = bedRms * 10 ** (marginDb / 20);
  const scale = target / inBandRms(raw);
  return raw.map((sample) => sample * scale);
}

let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'house-band-stems-dump-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('dumps the canonical +2 dB GREEN and +9 dB RED fixtures without changing the measurement', () => {
  const green = dumpLeadBalanceStems({
    lead: leadAt(2), bed, sampleRate: FS, outDir: join(root, 'green'), tag: 'seated',
  });
  assert.equal(green.available, true);
  assert.equal(green.verdict, 'GREEN', JSON.stringify(green.checks));
  assert.ok(Math.abs(green.inBandMeanDb - 2) < 0.3, `mean ${green.inBandMeanDb}`);

  const red = dumpLeadBalanceStems({
    lead: leadAt(9), bed, sampleRate: FS, outDir: join(root, 'red'), tag: 'hot',
  });
  assert.equal(red.verdict, 'RED');
  assert.ok(Math.abs(red.inBandMeanDb - 9) < 0.3, `mean ${red.inBandMeanDb}`);
});

test('writes tag-prefixed mono PCM16 RIFF/WAVE stems that round-trip through readWav', async () => {
  const lead = leadAt(2);
  const result = dumpLeadBalanceStems({ lead, bed, sampleRate: FS, outDir: root, tag: 'battle-animals' });
  assert.deepEqual(result.stems, {
    leadPath: join(root, 'battle-animals-lead.wav'),
    bedPath: join(root, 'battle-animals-bed.wav'),
    fullPath: join(root, 'battle-animals-full.wav'),
  });

  for (const path of Object.values(result.stems)) {
    const raw = await readFile(path);
    assert.equal(raw.toString('ascii', 0, 4), 'RIFF');
    assert.equal(raw.toString('ascii', 8, 12), 'WAVE');
    assert.equal(raw.toString('ascii', 12, 16), 'fmt ');
    assert.equal(raw.readUInt16LE(20), 1);
    assert.equal(raw.readUInt16LE(22), 1);
    assert.equal(raw.readUInt16LE(34), 16);
    assert.match(result.sha256[path.endsWith('-lead.wav') ? 'lead' : path.endsWith('-bed.wav') ? 'bed' : 'full'], /^[a-f0-9]{64}$/);
  }

  const decoded = readWav(result.stems.leadPath);
  assert.equal(decoded.sampleRate, FS);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.format, 1);
  assert.equal(decoded.bits, 16);
  let maxError = 0;
  for (let i = 0; i < lead.length; i += 1) maxError = Math.max(maxError, Math.abs(decoded.samples[i] - lead[i]));
  assert.ok(maxError < 1 / 32768 + 1e-12, `max PCM16 error ${maxError}`);
});

test('downmixes OfflineAudioContext-shaped channel arrays like the same mono buffers', () => {
  const lead = Float32Array.from(leadAt(2));
  const floatBed = Float32Array.from(bed);
  const mono = dumpLeadBalanceStems({ lead, bed: floatBed, sampleRate: FS, outDir: join(root, 'mono'), tag: 'cue' });
  const stereo = dumpLeadBalanceStems({
    lead: [lead, lead], bed: [floatBed, floatBed], sampleRate: FS, outDir: join(root, 'stereo'), tag: 'cue',
  });

  for (const field of ['verdict', 'inBandMeanDb', 'loudestDecileDb', 'p90WindowDb', 'hotWindowFraction']) {
    assert.deepEqual(stereo[field], mono[field], field);
  }
});

test('writes CLI-shaped pretty JSON only when jsonOut is provided', async () => {
  const jsonOut = join(root, 'banks', 'battle-animals.json');
  const result = dumpLeadBalanceStems({
    lead: leadAt(2), bed, sampleRate: FS, outDir: join(root, 'with-json'), tag: 'battle-animals',
    label: 'sample project battle animals', jsonOut,
  });
  const raw = await readFile(jsonOut, 'utf8');
  assert.ok(raw.endsWith('\n'));
  const report = JSON.parse(raw);
  assert.equal(report.label, 'sample project battle animals');
  assert.ok(!Number.isNaN(Date.parse(report.generated)));
  assert.equal(report.inputs.lead[0].file, result.stems.leadPath);
  assert.equal(report.inputs.lead[0].sha256, result.sha256.lead);
  assert.equal(report.inputs.bed[0].file, result.stems.bedPath);
  assert.equal(report.inputs.full.file, result.stems.fullPath);
  assert.equal(report.verdict, 'GREEN');
  assert.equal(report.inBandMeanDb, result.inBandMeanDb);
  assert.equal(raw, `${JSON.stringify(report, null, 2)}\n`);

  dumpLeadBalanceStems({ lead: leadAt(2), bed, sampleRate: FS, outDir: join(root, 'no-json'), tag: 'cue' });
  assert.deepEqual((await readdir(join(root, 'no-json'))).sort(), [
    'cue-bed.wav', 'cue-full.wav', 'cue-lead.wav',
  ]);
});

test('throws on missing destinations, empty stems, and irreconcilable channel lengths', () => {
  assert.throws(
    () => dumpLeadBalanceStems({ lead: leadAt(2), bed, sampleRate: FS, tag: 'cue' }),
    /outDir/,
  );
  assert.throws(
    () => dumpLeadBalanceStems({ lead: [], bed, sampleRate: FS, outDir: root, tag: 'cue' }),
    /lead.*empty/i,
  );
  assert.throws(
    () => dumpLeadBalanceStems({
      lead: [new Float32Array(10), new Float32Array(9)], bed,
      sampleRate: FS, outDir: root, tag: 'cue',
    }),
    /lead.*length/i,
  );
});
