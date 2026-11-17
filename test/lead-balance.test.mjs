// The lead-balance gate must go RED on a hot lead and GREEN on a seated one, on synthetic
// stems whose ratio is known exactly, and it must refuse to measure silence, solos and a
// sub-bass-only bed rather than calling them hot or quiet (methodology v2 s3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureLeadBalance, biquadBand, subtract, sumStems, FLEET_CAPS, HOT_WINDOW_DB } from '../tools/lead-balance/lead-balance.mjs';

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
const inBandRms = (x) => { const b = biquadBand(x, FS, 300, 4000); let s = 0; for (const v of b) s += v * v; return Math.sqrt(s / b.length); };
const bed = tone([330, 440, 660, 880], 12, 0.2);        // a sustained chord bed inside the melody band
const bedRms = inBandRms(bed);
function leadAt(marginDb) {
  const raw = tone([1000, 1500], 12, 1);
  const target = bedRms * 10 ** (marginDb / 20);
  const k = target / inBandRms(raw);
  return raw.map((v) => v * k);
}

test('a lead seated +2 dB over a sounding bed is GREEN and measures within 0.3 dB of the truth', () => {
  const r = measureLeadBalance({ lead: leadAt(2), bed, sampleRate: FS });
  assert.equal(r.available, true);
  assert.equal(r.verdict, 'GREEN', JSON.stringify(r.checks));
  assert.ok(Math.abs(r.inBandMeanDb - 2) < 0.3, `mean ${r.inBandMeanDb}`);
  assert.ok(r.hotWindowFraction === 0);
});

test('a lead +9 dB over the bed is RED on mean, decile, p90 and the hot-window count', () => {
  const r = measureLeadBalance({ lead: leadAt(9), bed, sampleRate: FS });
  assert.equal(r.verdict, 'RED');
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.metric);
  for (const m of ['inBandMeanDb', 'loudestDecileDb', 'p90WindowDb', 'hotWindowFraction']) assert.ok(failed.includes(m), `${m} should fail: ${failed}`);
  assert.ok(Math.abs(r.inBandMeanDb - 9) < 0.3);
});

test('a lead that is seated on average but strikes hot in one section is RED on the worst section, not rescued by the mean', () => {
  // three sections of 4 s: +1, +1, +8 dB -> mean well under the cap, section 3 far over it
  const soft = leadAt(1), hot = leadAt(8);
  const lead = new Float64Array(soft.length);
  const third = Math.round(4 * FS);
  for (let i = 0; i < lead.length; i += 1) lead[i] = i < 2 * third ? soft[i] : hot[i];
  const r = measureLeadBalance({ lead, bed, sampleRate: FS, sectionSeconds: 4 });
  assert.equal(r.perSection.length, 3);
  assert.ok(r.perSection[2].inBandDb > 7, JSON.stringify(r.perSection));
  assert.ok(r.checks.find((c) => c.metric === 'worstSectionInBandDb' && !c.ok), 'worst section must fail');
  assert.equal(r.verdict, 'RED');
});

test('silence, a solo lead and a sub-bass-only bed are EXCLUDED, never called hot', () => {
  // lead sounds only in the middle third; the bed is a 60 Hz sine (nothing in 300-4000 Hz)
  const lead = tone([1000], 12, 0.2, FS, (t) => (t > 4 && t < 8 ? 1 : 0));
  const sub = tone([60], 12, 0.5);
  const r = measureLeadBalance({ lead, bed: sub, sampleRate: FS });
  assert.equal(r.available, false, JSON.stringify(r));
  assert.ok(/both lead and bed/.test(r.reason));
  // and with a real bed, the solo/silent windows are reported as excluded, not measured
  const r2 = measureLeadBalance({ lead, bed, sampleRate: FS });
  assert.equal(r2.available, true);
  assert.ok(r2.excluded.bedOnly > 0);
  assert.ok(r2.eligibleWindows < r2.windows);
});

test('the brightness clause lowers the mean cap by 1 dB when the lead is brighter than its bed', () => {
  const r = measureLeadBalance({ lead: leadAt(3.5), bed, sampleRate: FS });   // 1-1.5 kHz lead over a 330-880 Hz bed
  assert.equal(r.leadBrighterThanBed, true);
  assert.equal(r.caps.effectiveInBandMeanCapDb, FLEET_CAPS.inBandMeanDb - FLEET_CAPS.brightnessClauseDb);
  assert.equal(r.checks[0].ok, false);   // 3.5 > 3.0 under the clause
  const darkRaw = tone([200, 250], 12, 1);
  const darkK = (bedRms * 10 ** (3.5 / 20)) / inBandRms(darkRaw);
  const dark = measureLeadBalance({ lead: darkRaw.map((v) => v * darkK), bed, sampleRate: FS });
  assert.equal(dark.leadBrighterThanBed, false);
  assert.equal(dark.caps.effectiveInBandMeanCapDb, FLEET_CAPS.inBandMeanDb);
});

test('mix-minus-muted recovers the lead stem (the A/B-mute listen-set shape)', () => {
  const lead = leadAt(2), mix = sumStems([lead, bed]);
  const recovered = subtract(mix, bed);
  let err = 0; for (let i = 0; i < lead.length; i += 1) err = Math.max(err, Math.abs(recovered[i] - lead[i]));
  assert.ok(err < 1e-12);
  const r = measureLeadBalance({ lead: recovered, bed, full: mix, sampleRate: FS });
  assert.equal(r.verdict, 'GREEN');
});

test('the caps are the fleet caps unless a KEEP overrides them', () => {
  const r = measureLeadBalance({ lead: leadAt(5), bed, sampleRate: FS, caps: { inBandMeanDb: 7, brightnessClauseDb: 0 } });
  assert.equal(r.checks[0].ok, true);
  assert.equal(HOT_WINDOW_DB, 6);
});
