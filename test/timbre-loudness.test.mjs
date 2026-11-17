/**
 * Loudness of the Timbre Range (s383 loudness round): the BS.1770 measure itself,
 * and the bar it enforces. Swapping a patch or a kit must not move that part's
 * level: every proof render (tools/timbre-proof.mjs) sits within +-1.5 LU
 * (integrated, ITU-R BS.1770 / EBU R128, K-weighted) of its class default's render
 * of the same notes. Regenerate the trims with `node tools/calibrate-timbre.mjs
 * --write` when a preset changes. Analysis only: nothing plays.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { integratedLufs, kWeightingStages, readWavChannels, wavLufs } from '../tools/lib/loudness.mjs';
import { LOUDNESS_TOLERANCE_LU, measureProofSet, measureWav, proofJobs, renderProof } from '../tools/lib/timbre-loudness.mjs';
import { phraseScore } from '../tools/lib/timbre-proof-scores.mjs';
import { timbrePacksSkip } from './helpers/env.mjs';

const SR = 44100;
const seconds = (n) => Math.round(n * SR);
const sine = (hz, peakDb, n, phase = 0) => Float32Array.from({ length: n }, (_, i) => 10 ** (peakDb / 20) * Math.sin(phase + (2 * Math.PI * hz * i) / SR));
const silence = (n) => new Float32Array(n);
const concat = (...parts) => { const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** A 16-bit stereo PCM WAV, so ffmpeg and the reader see the same bytes. */
function pcmWav(left, right) {
  const frames = left.length;
  const b = Buffer.alloc(44 + frames * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + frames * 4, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), 44 + i * 4);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), 46 + i * 4);
  }
  return b;
}

describe('BS.1770 integrated loudness (tools/lib/loudness.mjs)', () => {
  it('reads the EBU reference: a 1 kHz sine at -23 dBFS peak in both channels is -23.0 LUFS, in one channel -26.0', () => {
    const tone = sine(1000, -23, seconds(12));
    assert.ok(Math.abs(integratedLufs([tone, tone], SR) - -23.0) < 0.05, `${integratedLufs([tone, tone], SR)}`);
    assert.ok(Math.abs(integratedLufs([tone], SR) - -26.0) < 0.05, `${integratedLufs([tone], SR)}`);
  });

  it('K-weights: the shelf lifts 4 kHz and the RLB high-pass removes 20 Hz, relative to the same level at 1 kHz', () => {
    const at = (hz) => integratedLufs([sine(hz, -23, seconds(6))], SR);
    assert.ok(at(4000) - at(1000) > 2.5 && at(4000) - at(1000) < 4.5, `4 kHz ${at(4000) - at(1000)}`);
    assert.ok(at(1000) - at(20) > 6, `20 Hz ${at(1000) - at(20)}`);
    const [shelf, rlb] = kWeightingStages(48000);
    // The published 48 kHz coefficients (BS.1770-4 tables 1 and 2).
    assert.ok(Math.abs(shelf.b[0] - 1.53512485958697) < 1e-9 && Math.abs(shelf.a[1] - -1.69065929318241) < 1e-9 && Math.abs(shelf.a[2] - 0.73248077421585) < 1e-9);
    assert.ok(Math.abs(rlb.a[1] - -1.99004745483398) < 1e-9 && Math.abs(rlb.a[2] - 0.99007225036621) < 1e-9);
  });

  it('gates: silence does not dilute the result, and a part 15 LU down is dropped by the relative gate', () => {
    const tone = sine(1000, -23, seconds(8));
    const quiet = sine(1000, -43, seconds(8));
    const plain = integratedLufs([tone], SR);
    // The few 400 ms blocks that straddle the join are legitimately counted, so allow ~0.1 LU.
    assert.ok(Math.abs(integratedLufs([concat(tone, silence(seconds(10)))], SR) - plain) < 0.12, 'absolute gate');
    assert.ok(Math.abs(integratedLufs([concat(tone, quiet)], SR) - plain) < 0.12, 'relative gate');
    // Only 6 LU down it is counted: the integrated value moves toward the quiet part.
    assert.ok(integratedLufs([concat(tone, sine(1000, -29, seconds(8)))], SR) < plain - 1, 'not gated');
    assert.equal(integratedLufs([silence(seconds(3))], SR), -Infinity);
  });

  it('reads stereo WAV bytes channel by channel', () => {
    const left = sine(440, -20, seconds(3));
    const right = sine(660, -26, seconds(3));
    const { channels, sampleRate } = readWavChannels(pcmWav(left, right));
    assert.equal(channels.length, 2);
    assert.equal(sampleRate, SR);
    assert.ok(Math.abs(wavLufs(pcmWav(left, right)) - integratedLufs([left, right], SR)) < 0.02);
  });

  const ffmpegOk = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
  it('agrees with ffmpeg -af ebur128 within 0.3 LU on three synthetic programs (skipped when ffmpeg is absent)', { skip: !ffmpegOk && 'ffmpeg not installed' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-lufs-'));
    try {
      const n = seconds(12);
      const chord = (hzs, db) => Float32Array.from({ length: n }, (_, i) => hzs.reduce((s, hz, k) => s + Math.sin((2 * Math.PI * hz * i) / SR + k) / hzs.length, 0) * 10 ** (db / 20));
      const pulses = Float32Array.from({ length: n }, (_, i) => (i % seconds(1.5) < seconds(0.2) ? Math.sin((2 * Math.PI * 180 * i) / SR) * 10 ** (-12 / 20) * Math.exp(-(i % seconds(1.5)) / seconds(0.05)) : 0));
      const programs = {
        wide: [chord([110, 330, 990, 2970], -18), chord([147, 440, 1320, 3960], -22)],
        gapped: [pulses, pulses.map((v) => v * 0.7)],
        dense: [concat(chord([220, 1760, 5200], -30).subarray(0, seconds(6)), chord([220, 1760, 5200], -17).subarray(0, seconds(6))), chord([260, 2100, 6100], -24)],
      };
      for (const [name, [l, r]] of Object.entries(programs)) {
        const file = join(dir, `${name}.wav`);
        writeFileSync(file, pcmWav(l, r));
        const run = spawnSync('ffmpeg', ['-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
        const theirs = Number([...run.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop()?.[1]);
        assert.ok(Number.isFinite(theirs), `${name}: no ffmpeg reading`);
        const ours = wavLufs(pcmWav(l, r));
        assert.ok(Math.abs(ours - theirs) <= 0.3, `${name}: ours ${ours.toFixed(2)} vs ffmpeg ${theirs}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the proof renders hold the loudness bar (+-1.5 LU of the class default)', { skip: timbrePacksSkip() }, () => {
  let proof;
  before(async () => { proof = await measureProofSet(); });

  it('covers every kit and every patch, plus the six class defaults', () => {
    const jobs = proofJobs();
    assert.equal(jobs.length, 1 + 14 + 5 + 32);
    assert.ok(jobs.some((j) => j.id === 'kit:tr707'), 'the TR-707 kit is in the loudness gate');
    assert.deepEqual(Object.keys(proof).sort(), jobs.map((j) => j.id).sort());
    for (const job of jobs) assert.ok(Number.isFinite(proof[job.id].lufs), `${job.id} is silent`);
  });

  it('every kit groove is within 1.5 LU of the kit-less groove', () => {
    const bad = Object.entries(proof).filter(([, r]) => r.group === 'kit' && Math.abs(r.deltaLu) > LOUDNESS_TOLERANCE_LU);
    assert.deepEqual(bad.map(([id, r]) => `${id} ${r.deltaLu.toFixed(2)} LU`), []);
  });

  for (const cls of ['pad', 'bass', 'lead', 'pluck', 'bell']) {
    it(`every ${cls} patch phrase is within 1.5 LU of the default ${cls} phrase`, () => {
      const bad = Object.entries(proof).filter(([, r]) => r.group === 'patch' && r.cls === cls && Math.abs(r.deltaLu) > LOUDNESS_TOLERANCE_LU);
      assert.deepEqual(bad.map(([id, r]) => `${id} ${r.deltaLu.toFixed(2)} LU`), []);
    });
  }

  it('is not vacuous: a patch trimmed 2 dB hot, or a kit 2 dB cold, falls outside the bar', async () => {
    const baseline = proof['bell:sawbells'].lufs;
    const hot = measureWav(await renderProof(phraseScore({ cls: 'bell', patch: 'sawbells' }), { patchFactor: 10 ** (2 / 20) })).lufs;
    assert.ok(Math.abs(hot - baseline - 2) < 0.1, `${hot - baseline}`);
    assert.ok(Math.abs(hot - proof['bell:default'].lufs) > 0, 'moved off the default');
    const job = proofJobs().find((j) => j.id === 'kit:linndrum');
    const cold = measureWav(await renderProof(job.score, { kitFactor: () => 10 ** (-3 / 20) })).lufs;
    assert.ok(Math.abs(cold - proof['kit:default'].lufs) > LOUDNESS_TOLERANCE_LU, `${cold - proof['kit:default'].lufs}`);
  });

  it('the shipped presets render the same bytes as the scaled path at factor 1 (the calibration measures what ships)', async () => {
    const job = proofJobs().find((j) => j.id === 'bass:sub-sine');
    const shipped = (await import('../src/render.mjs')).renderSpecToWav;
    const { validateSpec } = await import('../src/spec.mjs');
    const direct = (await shipped(validateSpec(job.score), {})).wav;
    const viaTool = await renderProof(job.score, { patchFactor: 1 });
    assert.equal(Buffer.compare(direct, viaTool), 0);
  });
});
