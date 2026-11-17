#!/usr/bin/env node
// HOUSE BAND LEAD-BALANCE GATE - the kit-level enforcement tooth for the Lead-Balance Law.
//
// WHY THIS EXISTS (2026-09-04, a fleet project score ruled NO: "some incredibly loud leads AGAIN").
// Until this file the kit carried the Lead-Balance Law as README prose and one structural,
// note-data audit (tools/score-audit) that never hears a render. Every per-game Gate A port
// derived its cap from THAT GAME'S OWN ear-passed tracks ("worst passing track + 2 dB"), which
// protects a passed score against regression and is blind by construction to the case that
// keeps reaching Ray's ear: a NEW score whose leads are hot everywhere, with no passed sibling
// to anchor to. The first render of a new score went to the operator ungated, and the operator
// kept saying "again". This gate anchors a new score to the FLEET's operator-accepted scores
// instead, so a lead that sits further above its bed than any accepted House Band lead FAILS
// before a listen set is staged.
//
// WHAT IT MEASURES (rendered stems, never score gains, never broadband - the law's own words):
//   inBandMeanDb       energy ratio lead/bed in 300-4000 Hz over ELIGIBLE windows
//   loudestDecileDb    mean per-window ratio over the loudest tenth of lead windows (fleet Gate A)
//   p90WindowDb        90th percentile of the per-window ratio
//   hotWindowFraction  share of eligible windows where the lead exceeds the bed by > HOT_WINDOW_DB
//   leadCrestOverBedDb lead in-band peak vs bed in-band RMS - the "strike" a limiter later lifts
//   leadCentroidHz / bedCentroidHz  the brightness clause's numbers
//   perSection         the distribution, because the mean is not the measurement (certified title-theme probe 08-30)
// Eligibility precedes every statistic (methodology v2 s3): a window counts only when BOTH the
// lead and the bed are sounding in the band - silence, decayed tails, solos and sub-bass-only
// beds are reported as excluded, never as "lead hot" or "bed quiet".
//
// THE CAPS are the fleet's accepted margin, measured on operator-passed scores through this
// same code (see CAPS below and tools/lead-balance/README.md for the table), with the standing
// Lead-Balance Law's numbers as the doctrine they sit inside. A per-game KEEP (methodology v2
// s4) may loosen or tighten them for THAT game by passing --caps; a new score with no KEEP
// gets the fleet caps and nothing else.
//
// Dependency-free node. Usage:
//   node tools/lead-balance/lead-balance.mjs --lead L1.wav[,L2.wav] --bed B1.wav[,B2.wav]
//        [--full mix.wav] [--section-seconds N] [--label name] [--json out.json] [--caps caps.json]
//   node tools/lead-balance/lead-balance.mjs --stems-dir DIR --lead-voices bell,pluck [--tag prefix]
//        (stems named <tag>-<voice>.f32.wav / .wav; every non-lead voice is the bed)
//   node tools/lead-balance/lead-balance.mjs --mix full.wav --lead-muted nolead.wav
//        (lead = full minus lead-muted, bed = lead-muted; for sets that ship A/B mutes)
// Exit 0 = GREEN, 1 = RED, 2 = usage / unavailable measurement.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MELODY_BAND = Object.freeze({ lowHz: 300, highHz: 4000 });
export const PRESENCE_BAND = Object.freeze({ lowHz: 1000, highHz: 5000 });
export const WINDOW_SECONDS = 0.4;     // ~16384 samples at 44.1 kHz, the fleet's window
export const HOT_WINDOW_DB = 6;        // "lead exceeds the bed by more than 6 dB" - the recurring complaint, as a count
export const FLOOR_BELOW_P90_DB = 35;  // a stem window this far under its own loud windows is a tail or silence
export const BED_IN_BAND_SHARE_DB = -30; // a bed whose 300-4000 Hz energy is this far under its broadband energy is sub-bass-only (v2 s3.5)
export const ABS_FLOOR_DBFS = -72;     // below this in-band RMS nobody hears a ratio; the window is silence

// THE FLEET CAPS. Derived 2026-09-04 from operator-accepted House Band scores measured through
// this file (an accepted strategy score v6 "passes now" / "really happy with the
// music"; a lobby sample project "sounds great"; a certified title theme at +3.03 dB in-band with
// its +3.15 sibling REJECTED - the table with every number is in README.md beside this file).
// Each cap is the worst accepted value plus a repeatability margin, capped by the standing
// Lead-Balance Law where the law is tighter. A score that sits further above its bed than any
// score Ray has accepted is RED.
export const FLEET_CAPS = Object.freeze({
  inBandMeanDb: 4.0,          // accepted max +3.03 (certified title theme, lead brighter than bed -> clause below); strategy score +2.55
  brightnessClauseDb: 0.9,    // a lead brighter than its bed must sit lower (law): effective 3.1 - between +3.03 ACCEPTED and +3.15 REJECTED
  loudestDecileDb: 7.0,       // the standing law's ceiling; accepted max +6.74 (accepted strategy score v6 L1)
  p90WindowDb: 8.5,           // accepted max +7.68 (accepted strategy score v6 L1) + margin
  hotWindowFraction: 0.25,    // accepted max 15% of eligible windows more than 6 dB hot (accepted strategy score v6 L1) + margin
  leadCrestOverBedDb: 26.0,   // accepted max +22.94 (accepted strategy score v6 L2) + margin; the strike the limiter lifts
  worstSectionOverMeanCapDb: 1.0, // a section may sit this far over the mean cap, never more (certified theme: accepted worst 3.91, rejected worst 4.15)
});

// ---- WAV -------------------------------------------------------------------------------------
export function readWav(path) {
  const raw = readFileSync(path);
  if (raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not RIFF/WAVE`);
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= raw.length) {
    const id = raw.toString('ascii', pos, pos + 4);
    const size = raw.readUInt32LE(pos + 4);
    const body = raw.subarray(pos + 8, Math.min(raw.length, pos + 8 + size));
    if (id === 'fmt ') fmt = body;
    else if (id === 'data') data = body;
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt/data chunk`);
  let format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (format === 0xfffe && fmt.length >= 26) format = fmt.readUInt16LE(24); // WAVE_FORMAT_EXTENSIBLE
  const frames = Math.floor(data.length / (channels * (bits / 8)));
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      const at = (i * channels + c) * (bits / 8);
      let v;
      if (format === 3 && bits === 32) v = data.readFloatLE(at);
      else if (format === 3 && bits === 64) v = data.readDoubleLE(at);
      else if (format === 1 && bits === 16) v = data.readInt16LE(at) / 32768;
      else if (format === 1 && bits === 24) v = ((data[at] | (data[at + 1] << 8) | (data[at + 2] << 16)) << 8 >> 8) / 8388608;
      else if (format === 1 && bits === 32) v = data.readInt32LE(at) / 2147483648;
      else if (format === 1 && bits === 8) v = (data[at] - 128) / 128;
      else throw new Error(`${path}: unsupported WAV format ${format} / ${bits} bit`);
      sum += v;
    }
    mono[i] = sum / channels;
  }
  return { samples: mono, sampleRate, channels, bits, format };
}

export function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

// ---- DSP (the fleet's dependency-free biquad band + Welch spectrum) --------------------------
function biquad(x, b, a) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i += 1) {
    const v = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0];
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
export function biquadBand(x, fs, lowHz, highHz) {
  const w1 = (2 * Math.PI * lowHz) / fs, c1 = Math.cos(w1), al1 = Math.sin(w1) / (2 * 0.7071);
  const hp = { b: [(1 + c1) / 2, -(1 + c1), (1 + c1) / 2], a: [1 + al1, -2 * c1, 1 - al1] };
  const w2 = (2 * Math.PI * Math.min(highHz, fs * 0.45)) / fs, c2 = Math.cos(w2), al2 = Math.sin(w2) / (2 * 0.7071);
  const lp = { b: [(1 - c2) / 2, 1 - c2, (1 - c2) / 2], a: [1 + al2, -2 * c2, 1 - al2] };
  return biquad(biquad(biquad(biquad(x, hp.b, hp.a), hp.b, hp.a), lp.b, lp.a), lp.b, lp.a);
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const n2 = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = n2;
      }
    }
  }
}
export function spectrum(x, sampleRate, nfft = 4096) {
  const hop = nfft >> 1, window = new Float64Array(nfft);
  let wp = 0;
  for (let i = 0; i < nfft; i += 1) { window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nfft); wp += window[i] * window[i]; }
  const power = new Float64Array(nfft / 2 + 1);
  let frames = 0;
  for (let start = 0; start + nfft <= x.length; start += hop) {
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < nfft; i += 1) re[i] = x[start + i] * window[i];
    fft(re, im);
    for (let bin = 0; bin <= nfft / 2; bin += 1) power[bin] += (re[bin] * re[bin] + im[bin] * im[bin]) / wp;
    frames += 1;
  }
  if (frames) for (let bin = 0; bin < power.length; bin += 1) power[bin] /= frames;
  return { power, binHz: sampleRate / nfft };
}
export function centroidHz(spec, lowHz = 20, highHz = Infinity) {
  let num = 0, den = 0;
  for (let bin = 1; bin < spec.power.length; bin += 1) {
    const f = bin * spec.binHz;
    if (f < lowHz || f > highHz) continue;
    num += f * spec.power[bin]; den += spec.power[bin];
  }
  return den > 0 ? num / den : 0;
}
const db10 = (p) => (p > 0 ? 10 * Math.log10(p) : -Infinity);
const db20 = (a) => (a > 0 ? 20 * Math.log10(a) : -Infinity);
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
function percentile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const at = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[at];
}
const round2 = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : v);
export function sumStems(stems) {
  const n = Math.min(...stems.map((s) => s.length));
  const out = new Float64Array(n);
  for (const s of stems) for (let i = 0; i < n; i += 1) out[i] += s[i];
  return out;
}
export function subtract(a, b) {
  const n = Math.min(a.length, b.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = a[i] - b[i];
  return out;
}

// ---- THE MEASUREMENT ----------------------------------------------------------------------
/**
 * @param {object} o
 * @param {Float64Array} o.lead   summed lead stems, mono
 * @param {Float64Array} o.bed    summed accompaniment stems, mono
 * @param {Float64Array} [o.full] the mix (for the presence margin); defaults to lead + bed
 * @param {number} o.sampleRate
 * @param {number} [o.sectionSeconds]  report the per-section distribution on this grid
 * @param {object} [o.caps]            override FLEET_CAPS (a per-game KEEP)
 */
export function measureLeadBalance(o) {
  const fs = o.sampleRate;
  const n = Math.min(o.lead.length, o.bed.length);
  const lead = o.lead.subarray(0, n), bed = o.bed.subarray(0, n);
  const full = o.full ? o.full.subarray(0, n) : sumStems([lead, bed]);
  const caps = { ...FLEET_CAPS, ...(o.caps || {}) };
  const leadB = biquadBand(lead, fs, MELODY_BAND.lowHz, MELODY_BAND.highHz);
  const bedB = biquadBand(bed, fs, MELODY_BAND.lowHz, MELODY_BAND.highHz);
  const leadP = biquadBand(lead, fs, PRESENCE_BAND.lowHz, PRESENCE_BAND.highHz);
  const win = Math.max(256, Math.round(WINDOW_SECONDS * fs)), hop = win >> 1;
  const rows = [];
  for (let start = 0; start + win <= n; start += hop) {
    let lp = 0, bp = 0, pp = 0, fp = 0, lpk = 0, bw = 0;
    for (let i = start; i < start + win; i += 1) {
      lp += leadB[i] * leadB[i]; bp += bedB[i] * bedB[i]; pp += leadP[i] * leadP[i]; fp += full[i] * full[i]; bw += bed[i] * bed[i];
      const m = Math.abs(leadB[i]); if (m > lpk) lpk = m;
    }
    rows.push({ start, seconds: start / fs, leadPower: lp / win, bedPower: bp / win, bedBroadband: bw / win, presencePower: pp / win, fullPower: fp / win, leadPeak: lpk });
  }
  if (!rows.length) return { available: false, reason: 'render shorter than one analysis window' };
  // Eligibility before any statistic: both stems sounding in the band.
  const leadFloor = percentile(rows.map((r) => r.leadPower), 0.9) * 10 ** (-FLOOR_BELOW_P90_DB / 10);
  const bedFloor = percentile(rows.map((r) => r.bedPower), 0.9) * 10 ** (-FLOOR_BELOW_P90_DB / 10);
  const absFloor = 10 ** (ABS_FLOOR_DBFS / 10);
  const excluded = { silence: 0, leadOnly: 0, bedOnly: 0, bedSubBassOnly: 0 };
  const eligible = [];
  for (const r of rows) {
    const leadOn = r.leadPower > leadFloor && r.leadPower > absFloor;
    const bedLoud = r.bedPower > bedFloor && r.bedPower > absFloor;
    const bedInBand = r.bedBroadband <= 0 || db10(r.bedPower / r.bedBroadband) >= BED_IN_BAND_SHARE_DB;
    const bedOn = bedLoud && bedInBand;
    if (leadOn && bedOn) { r.ratioDb = db10(r.leadPower / r.bedPower); eligible.push(r); }
    else if (leadOn && bedLoud && !bedInBand) excluded.bedSubBassOnly += 1;
    else if (leadOn) excluded.leadOnly += 1;
    else if (bedOn) excluded.bedOnly += 1;
    else excluded.silence += 1;
  }
  if (eligible.length < 5) {
    return { available: false, reason: `only ${eligible.length} windows have both lead and bed sounding in 300-4000 Hz (sub-bass-only bed windows: ${excluded.bedSubBassOnly})`, windows: rows.length, excluded };
  }
  const inBandMeanDb = db10(eligible.reduce((s, r) => s + r.leadPower, 0) / eligible.reduce((s, r) => s + r.bedPower, 0));
  const ranked = [...eligible].sort((a, b) => b.leadPower - a.leadPower);
  const decile = ranked.slice(0, Math.max(1, Math.floor(ranked.length / 10)));
  const loudestDecileDb = mean(decile.map((r) => r.ratioDb));
  const p90WindowDb = percentile(eligible.map((r) => r.ratioDb), 0.9);
  const hot = eligible.filter((r) => r.ratioDb > HOT_WINDOW_DB);
  const hotWindowFraction = hot.length / eligible.length;
  const bedRms = Math.sqrt(eligible.reduce((s, r) => s + r.bedPower, 0) / eligible.length);
  const leadRms = Math.sqrt(eligible.reduce((s, r) => s + r.leadPower, 0) / eligible.length);
  const leadPeak = Math.max(...eligible.map((r) => r.leadPeak));
  const leadCrestOverBedDb = db20(leadPeak) - db20(bedRms);
  const leadCentroidHz = centroidHz(spectrum(lead, fs));
  const bedCentroidHz = centroidHz(spectrum(bed, fs));
  const leadBrighter = leadCentroidHz > bedCentroidHz;
  // Presence margin (fleet Gate B shape): loudest decile of the lead's 1-5 kHz power vs the mix.
  const sounding = rows.filter((r) => r.presencePower > 1e-14);
  const pCut = percentile(sounding.map((r) => r.presencePower), 0.9);
  const loudP = sounding.filter((r) => r.presencePower >= pCut);
  const leadPresenceMarginDb = loudP.length ? db10(mean(loudP.map((r) => r.presencePower)) / mean(rows.map((r) => r.fullPower))) : NaN;
  const broadbandDb = db10(lead.reduce((s, v) => s + v * v, 0) / Math.max(1e-30, bed.reduce((s, v) => s + v * v, 0)));
  // Per-section distribution.
  const perSection = [];
  if (o.sectionSeconds > 0) {
    const count = Math.ceil((n / fs) / o.sectionSeconds);
    for (let s = 0; s < count; s += 1) {
      const lo = s * o.sectionSeconds, hi = (s + 1) * o.sectionSeconds;
      const inSec = eligible.filter((r) => r.seconds >= lo && r.seconds < hi);
      const all = rows.filter((r) => r.seconds >= lo && r.seconds < hi);
      const complete = (hi <= n / fs + 1e-9);
      perSection.push({
        index: s, startSeconds: lo, eligibleWindows: inSec.length, windows: all.length, complete,
        inBandDb: inSec.length ? round2(db10(inSec.reduce((a, r) => a + r.leadPower, 0) / inSec.reduce((a, r) => a + r.bedPower, 0))) : null,
        p90WindowDb: inSec.length ? round2(percentile(inSec.map((r) => r.ratioDb), 0.9)) : null,
        hotWindowFraction: inSec.length ? round2(inSec.filter((r) => r.ratioDb > HOT_WINDOW_DB).length / inSec.length) : null,
      });
    }
  }
  // The verdict.
  const meanCap = leadBrighter ? caps.inBandMeanDb - caps.brightnessClauseDb : caps.inBandMeanDb;
  const checks = [
    { metric: 'inBandMeanDb', value: round2(inBandMeanDb), cap: round2(meanCap), ok: inBandMeanDb <= meanCap, note: leadBrighter ? 'lead brighter than bed: brightness clause applied' : '' },
    { metric: 'loudestDecileDb', value: round2(loudestDecileDb), cap: caps.loudestDecileDb, ok: loudestDecileDb <= caps.loudestDecileDb },
    { metric: 'p90WindowDb', value: round2(p90WindowDb), cap: caps.p90WindowDb, ok: p90WindowDb <= caps.p90WindowDb },
    { metric: 'hotWindowFraction', value: round2(hotWindowFraction), cap: caps.hotWindowFraction, ok: hotWindowFraction <= caps.hotWindowFraction },
    { metric: 'leadCrestOverBedDb', value: round2(leadCrestOverBedDb), cap: caps.leadCrestOverBedDb, ok: leadCrestOverBedDb <= caps.leadCrestOverBedDb },
  ];
  const worstSection = perSection.filter((s) => s.complete && s.inBandDb !== null).sort((a, b) => b.inBandDb - a.inBandDb)[0] || null;
  if (worstSection) {
    checks.push({ metric: 'worstSectionInBandDb', value: worstSection.inBandDb, cap: round2(meanCap + caps.worstSectionOverMeanCapDb), ok: worstSection.inBandDb <= meanCap + caps.worstSectionOverMeanCapDb, note: `section ${worstSection.index} at ${worstSection.startSeconds}s; a section may sit 1 dB over the mean cap, never more (certified title-theme probe 08-30: the mean is not the measurement)` });
  }
  return {
    available: true,
    verdict: checks.every((c) => c.ok) ? 'GREEN' : 'RED',
    checks,
    caps: { ...caps, effectiveInBandMeanCapDb: round2(meanCap) },
    inBandMeanDb: round2(inBandMeanDb),
    loudestDecileDb: round2(loudestDecileDb),
    p90WindowDb: round2(p90WindowDb),
    hotWindowFraction: round2(hotWindowFraction),
    hotWindows: hot.length,
    leadCrestOverBedDb: round2(leadCrestOverBedDb),
    leadInBandRmsDbfs: round2(db20(leadRms)), bedInBandRmsDbfs: round2(db20(bedRms)),
    leadCentroidHz: Math.round(leadCentroidHz),
    bedCentroidHz: Math.round(bedCentroidHz),
    leadBrighterThanBed: leadBrighter,
    leadPresenceMarginDb: round2(leadPresenceMarginDb),
    broadbandDb_forContrastOnly: round2(broadbandDb),
    windows: rows.length, eligibleWindows: eligible.length, decileWindows: decile.length, excluded,
    windowSeconds: win / fs, sampleRate: fs, seconds: round2(n / fs),
    perSection,
  };
}

export function formatReport(label, r) {
  const lines = [`LEAD-BALANCE  ${label}`];
  if (!r.available) { lines.push(`  MEASUREMENT UNAVAILABLE: ${r.reason}`); return lines.join('\n'); }
  const f = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`;
  lines.push(`  in-band 300-4000 Hz mean : ${f(r.inBandMeanDb)} dB   (cap ${f(r.caps.effectiveInBandMeanCapDb)})`);
  lines.push(`  loudest decile           : ${f(r.loudestDecileDb)} dB   (cap ${f(r.caps.loudestDecileDb)})`);
  lines.push(`  p90 window               : ${f(r.p90WindowDb)} dB   (cap ${f(r.caps.p90WindowDb)})`);
  lines.push(`  windows > +${HOT_WINDOW_DB} dB         : ${(r.hotWindowFraction * 100).toFixed(0)}% (${r.hotWindows}/${r.eligibleWindows})   (cap ${(r.caps.hotWindowFraction * 100).toFixed(0)}%)`);
  lines.push(`  lead peak over bed RMS   : ${f(r.leadCrestOverBedDb)} dB   (cap ${f(r.caps.leadCrestOverBedDb)})`);
  lines.push(`  centroid lead / bed      : ${r.leadCentroidHz} / ${r.bedCentroidHz} Hz   ${r.leadBrighterThanBed ? 'lead BRIGHTER - brightness clause' : 'lead not brighter'}`);
  lines.push(`  presence 1-5 kHz margin  : ${f(r.leadPresenceMarginDb)} dB   broadband (contrast only): ${f(r.broadbandDb_forContrastOnly)} dB`);
  lines.push(`  in-band RMS lead / bed   : ${f(r.leadInBandRmsDbfs)} / ${f(r.bedInBandRmsDbfs)} dBFS over eligible windows`);
  lines.push(`  windows                  : ${r.eligibleWindows} eligible of ${r.windows} (excluded: silence ${r.excluded.silence}, lead-only ${r.excluded.leadOnly}, bed-only ${r.excluded.bedOnly}, bed sub-bass-only ${r.excluded.bedSubBassOnly})`);
  if (r.perSection.length) lines.push('  per section (in-band)    : ' + r.perSection.map((s) => `${s.startSeconds}s ${s.inBandDb === null ? 'n/a' : f(s.inBandDb)}${s.complete ? '' : '(tail)'}`).join('  '));
  lines.push(`  VERDICT                  : ${r.verdict}` + (r.verdict === 'RED' ? '  <- ' + r.checks.filter((c) => !c.ok).map((c) => `${c.metric} ${c.value} > ${c.cap}`).join('; ') : ''));
  return lines.join('\n');
}


// ==============================================================================================
// THE SPIKE GATE and THE PERCUSSION GATE - added 2026-09-04 (round 3).
//
// WHY (fleet project round 2, ruled NOT YET): "the percussion/highhat is a little too loud
// compared to everything else ... later on in the first track the lead eventually spikes and is
// way too loud again on some mallet instrument, so that isn't really fixed either." The gate
// above had read GREEN on that render, and it was not lying: measured as lead-over-bed, round 2
// sits BETTER than an accepted strategy score v6 Ray praised. Two structural blind spots:
//
// 1. A RATIO TO THE BED IS NOT A SPIKE. What the operator calls a spike is a voice standing far
//    above ITS OWN normal level, in one place, late. A mean, a decile, even a p90 over a
//    ten-minute render cannot see it, and neither can a peak-over-bed ratio, because a bell has
//    a large crest factor everywhere and the statistic is dominated by that, not by the outlier.
//    MEASURED: fleet project round 2's mallet has 18.4 dB between its own median quarter-second
//    and its own loudest; every melodic voice in every accepted score measures 3.0 to 7.4 dB.
//    That number is the defect, and it is a per-voice, self-referential statistic.
//
// 2. THE HAT COMPLAINT IS ABOUT A BAND, NOT A LEVEL. Round 2's pulse is 22.7 dB BELOW the rest
//    of the mix broadband - quieter than any accepted percussion - and the operator still heard
//    it sticking out, because in a dark, dry consort it owns the presence band alone. MEASURED:
//    its share of 1.5-8 kHz energy is -8.5 dB, where every accepted percussion sits at -10.2 to
//    -12.2 dB. Who owns the band the ear is most sensitive to is the measurement; the broadband
//    ratio is not.
//
// Both statistics are anchored on operator-ACCEPTED scores (tools/lead-balance/derive-peak-caps.mjs
// derives every subject from the committed A/B mute pairs: subject = raw full minus raw muted,
// percussion = leadMuted + chordsMuted - full), so a new score is graded against what Ray has
// said yes to and nothing else.
export const PEAK_WINDOW_SECONDS = 0.25;    // the operator hears the loudest quarter second
export const PEAK_HOP_SECONDS = 0.125;
export const LOCAL_CONTEXT_SECONDS = 3.0;   // "the music around it" - what a spike stands out from
export const HAT_BAND = Object.freeze({ lowHz: 1500, highHz: 8000 });  // where a hat, a rim and a stick live
export const SUBJECT_FLOOR_BELOW_P90_DB = 35;

function windowedPower(x, fs, seconds, hopSeconds) {
  const win = Math.max(64, Math.round(seconds * fs));
  const hop = Math.max(32, Math.round(hopSeconds * fs));
  const rows = [];
  for (let start = 0; start + win <= x.length; start += hop) {
    let p = 0;
    for (let i = start; i < start + win; i += 1) p += x[i] * x[i];
    rows.push({ index: start, seconds: start / fs, power: p / win });
  }
  return rows;
}
/** Centred running power of `x` over `seconds`, by prefix sums - the local musical level. */
function runningPower(x, seconds, fs) {
  const half = Math.round((seconds * fs) / 2);
  const pre = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i += 1) pre[i + 1] = pre[i] + x[i] * x[i];
  return (index) => {
    const a = Math.max(0, index - half), b = Math.min(x.length, index + half);
    return (pre[b] - pre[a]) / Math.max(1, b - a);
  };
}
function energy(x) { let e = 0; for (let i = 0; i < x.length; i += 1) e += x[i] * x[i]; return e; }

/**
 * ONE SUBJECT VOICE, measured three ways: against the rest of the mix, against the music around
 * it, and against itself.
 * @param {object} o
 * @param {Float64Array} o.subject  the voice under test, mono
 * @param {Float64Array} o.rest     every other voice, summed, mono
 * @param {Float64Array} [o.full]   the mix; defaults to subject + rest
 * @param {number} o.sampleRate
 */
export function measureSubject(o) {
  const fs = o.sampleRate;
  const n = Math.min(o.subject.length, o.rest.length);
  if (n < fs * PEAK_WINDOW_SECONDS * 8) return { available: false, reason: 'render shorter than eight analysis windows' };
  const subject = o.subject.subarray(0, n), rest = o.rest.subarray(0, n);
  const full = o.full ? o.full.subarray(0, n) : sumStems([subject, rest]);
  const sM = biquadBand(subject, fs, MELODY_BAND.lowHz, MELODY_BAND.highHz);
  const rM = biquadBand(rest, fs, MELODY_BAND.lowHz, MELODY_BAND.highHz);
  const fM = biquadBand(full, fs, MELODY_BAND.lowHz, MELODY_BAND.highHz);
  const sH = biquadBand(subject, fs, HAT_BAND.lowHz, HAT_BAND.highHz);
  const fH = biquadBand(full, fs, HAT_BAND.lowHz, HAT_BAND.highHz);
  // WHO OWNS THE BAND. Whole-track energy integrals, so these are stable to a tenth of a dB.
  const presenceShareDb = db10(energy(sH) / Math.max(1e-30, energy(fH)));
  const melodyShareDb = db10(energy(sM) / Math.max(1e-30, energy(fM)));
  const rows = windowedPower(sM, fs, PEAK_WINDOW_SECONDS, PEAK_HOP_SECONDS);
  if (rows.length < 8) return { available: false, reason: 'too few windows' };
  // SOUNDING WINDOWS ONLY. A voice's silence is not part of its own dynamic range, and a rest
  // is not a quiet performance - the same eligibility doctrine the lead-balance measurement uses.
  const floor = percentile(rows.map((r) => r.power), 0.9) * 10 ** (-SUBJECT_FLOOR_BELOW_P90_DB / 10);
  const absFloor = 10 ** (ABS_FLOOR_DBFS / 10);
  const sounding = rows.filter((r) => r.power > floor && r.power > absFloor);
  if (sounding.length < 8) return { available: false, reason: `only ${sounding.length} windows have the subject sounding in 300-4000 Hz` };
  const localFull = runningPower(fM, LOCAL_CONTEXT_SECONDS, fs);
  const localRest = runningPower(rM, LOCAL_CONTEXT_SECONDS, fs);
  for (const r of sounding) {
    r.ownDb = db10(r.power);
    r.promDb = db10(r.power / Math.max(1e-30, localFull(r.index)));
    r.overRestDb = db10(r.power / Math.max(1e-30, localRest(r.index)));
  }
  const own = sounding.map((r) => r.ownDb);
  const prom = sounding.map((r) => r.promDb);
  // PER-NOTE PEAKS. selfOutlierDb below turned out to measure NOTE DENSITY as much as dynamics
  // (see the comment on the caps): a sparse struck voice spends most of its sounding windows in
  // a decay tail, so its median window is its tail and its p99.5 is an attack, whatever the
  // arrangement does. This is the density-invariant version of the same question - the loudest
  // NOTE against the median NOTE - found by taking local maxima of the same envelope at least
  // 0.6 s apart, which is one note at any tempo a House Band score has used.
  const notePeaks = [];
  let lastPeak = -1e9;
  for (let i = 1; i < sounding.length - 1; i += 1) {
    if (sounding[i].ownDb >= sounding[i - 1].ownDb && sounding[i].ownDb >= sounding[i + 1].ownDb
      && sounding[i].seconds - lastPeak > 0.6) { notePeaks.push(sounding[i]); lastPeak = sounding[i].seconds; }
  }
  const noteDb = notePeaks.map((r) => r.ownDb);
  const loudestNote = notePeaks.length ? notePeaks.reduce((b, r) => (r.ownDb > b.ownDb ? r : b), notePeaks[0]) : null;
  const loudest = sounding.reduce((best, r) => (r.promDb > best.promDb ? r : best), sounding[0]);
  const ownLoudest = sounding.reduce((best, r) => (r.ownDb > best.ownDb ? r : best), sounding[0]);
  // Broadband context only, so a report can say what the old metric would have said.
  const inBandMeanOverRestDb = db10(energy(sM) / Math.max(1e-30, energy(rM)));
  return {
    available: true,
    // THE SPIKE, note against note. How far this voice's loudest note stands above its median
    // note - the "the lead eventually spikes" question, asked in a way that a sparse voice and
    // a dense one answer the same.
    noteSpreadDb: noteDb.length >= 8 ? round2(Math.max(...noteDb) - percentile(noteDb, 0.5)) : null,
    noteSpreadP995Db: noteDb.length >= 8 ? round2(percentile(noteDb, 0.995) - percentile(noteDb, 0.5)) : null,
    notes: noteDb.length,
    loudestNoteSeconds: loudestNote ? round2(loudestNote.seconds) : null,
    // CONTEXT ONLY, NOT GRADED - see the caps comment. This is p99.5 minus median over the
    // voice's own sounding WINDOWS, and for a sparse struck voice the median window is a decay
    // tail rather than a note, so the number reads as a defect when the voice is simply not
    // playing very often. It is kept because it is a useful second look at a dense voice.
    selfOutlierDb: round2(percentile(own, 0.995) - percentile(own, 0.5)),
    loudestOwnSeconds: round2(ownLoudest.seconds),
    // THE PROMINENCE. How far it stands above the music around it, in the band the ear hears.
    localProminenceP995Db: round2(percentile(prom, 0.995)),
    localProminenceP99Db: round2(percentile(prom, 0.99)),
    localProminenceMaxDb: round2(Math.max(...prom)),
    localProminenceMedianDb: round2(percentile(prom, 0.5)),
    loudestProminenceSeconds: round2(loudest.seconds),
    // WHO OWNS THE BAND.
    presenceShareDb: round2(presenceShareDb),
    melodyShareDb: round2(melodyShareDb),
    inBandMeanOverRestDb: round2(inBandMeanOverRestDb),
    soundingWindows: sounding.length, windows: rows.length,
    windowSeconds: PEAK_WINDOW_SECONDS, contextSeconds: LOCAL_CONTEXT_SECONDS,
    sampleRate: fs, seconds: round2(n / fs),
  };
}

// THE FLEET CAPS FOR THESE TWO GATES. Worst ACCEPTED value plus a margin sized to the
// statistic: 1.5 dB for a percentile (which moves a little run to run), 1.0 dB for a
// whole-track energy share (which does not). Derived by tools/lead-balance/derive-peak-caps.mjs
// from accepted strategy scores v6 and v4r2, levels 1-3, lead / chords / percussion - eighteen
// operator-accepted subjects. The table is in README.md and PEAK-CAPS.json.
// A METRIC THAT WAS TRIED AND FALSIFIED, recorded because the falsification is the finding.
// The first cut of this gate graded `selfOutlierDb` - p99.5 minus median of a voice's own 250 ms
// level over its sounding windows - and it read RED on fleet project round 2's mallet at
// +18.88 dB against +3.05 to +7.36 for every accepted subject. That looked like the operator's
// "the lead eventually spikes" caught cold. It was not. Measured note by note, round 2's bell is
// one of the most CONSISTENT voices in the fleet: its loudest note stands 5.44 dB over its
// median note. The 18.88 came from the metric's denominator - a bell that strikes three times in
// four bars spends most of its sounding windows in a decay tail, so its median window is its
// tail and its p99.5 is an attack. The metric was measuring NOTE DENSITY. Every accepted score
// it was anchored on is dense, so the anchor was an artifact too, and a cap built on it would
// have failed any sparse struck voice in the fleet forever, including one Ray would have liked.
// It is demoted to a reported number and replaced by `noteSpreadDb`, which asks the same
// question note against note and is therefore density-invariant. The metric that actually
// caught the defect Ray described is `localProminenceMaxDb` - the voice against the music around
// it - which reads +7.04 on round 2 against an accepted worst of +4.75.
export const FLEET_SUBJECT_CAPS = Object.freeze({
  // MELODIC. accepted worst +4.22 / +4.75 dB (accepted strategy score v6 level 2 lead) - THE SPIKE GATE
  voiceLocalProminenceP995Db: 5.7,
  voiceLocalProminenceMaxDb: 6.3,
  // note against note, density-invariant; accepted worst filled by derive-peak-caps.mjs
  voiceNoteSpreadDb: 8.3,
  // PERCUSSION. accepted worst -10.16 dB share of 1.5-8 kHz (accepted strategy score v4r2 level 2) - THE HAT GATE
  percussionPresenceShareDb: -9.2,
  percussionLocalProminenceP995Db: -2.8,
  percussionNoteSpreadDb: 8.3,
});

const CHECKS_BY_ROLE = Object.freeze({
  melodic: [
    ['localProminenceP995Db', 'voiceLocalProminenceP995Db', 'this voice over the music around it, 99.5th percentile - THE SPIKE'],
    ['localProminenceMaxDb', 'voiceLocalProminenceMaxDb', 'this voice over the music around it, worst single window - THE SPIKE'],
    ['noteSpreadDb', 'voiceNoteSpreadDb', 'the loudest note of this voice over its median note'],
  ],
  percussion: [
    ['presenceShareDb', 'percussionPresenceShareDb', 'share of 1.5-8 kHz energy - who owns the band the ear hears - THE HAT'],
    ['localProminenceP995Db', 'percussionLocalProminenceP995Db', 'the percussion over the music around it, 99.5th percentile'],
    ['noteSpreadDb', 'percussionNoteSpreadDb', 'the loudest strike over the median strike'],
  ],
});

/** Grade one measured subject in its role against the fleet caps. */
export function gradeSubject(name, role, r, caps) {
  const c = { ...FLEET_SUBJECT_CAPS, ...(caps || {}) };
  if (!r || !r.available) return { name, role, available: false, reason: (r && r.reason) || 'not measured', verdict: 'UNAVAILABLE' };
  const spec = CHECKS_BY_ROLE[role];
  if (!spec) throw new Error(`gradeSubject: unknown role ${role} (melodic | percussion | bed)`);
  // A metric that could not be computed (too few notes to have a median note) is reported as
  // such and does not silently pass.
  const checks = spec.map(([metric, cap, note]) => ({
    metric, value: r[metric], cap: c[cap],
    ok: r[metric] === null || r[metric] === undefined ? true : r[metric] <= c[cap],
    note: (r[metric] === null || r[metric] === undefined) ? note + ' (not measurable on this stem)' : note,
  }));
  return { name, role, available: true, verdict: checks.every((x) => x.ok) ? 'GREEN' : 'RED', checks, ...r };
}

export function formatSubjectReport(g) {
  const f = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`;
  if (!g.available) return `  ${String(g.name).padEnd(10)} ${String(g.role).padEnd(10)} MEASUREMENT UNAVAILABLE: ${g.reason}`;
  const head = `  ${String(g.name).padEnd(10)} ${String(g.role).padEnd(10)}`
    + ` local p99.5 ${f(g.localProminenceP995Db).padStart(7)}`
    + `  max ${f(g.localProminenceMaxDb).padStart(7)}`
    + `  note spread ${(g.noteSpreadDb === null ? '   n/a' : f(g.noteSpreadDb)).padStart(7)}`
    + `  presence share ${f(g.presenceShareDb).padStart(7)}`
    + `  ${g.verdict}`;
  if (g.verdict !== 'RED' || !g.checks) return head;
  return head + '\n' + g.checks.filter((c) => !c.ok).map((c) => `      RED  ${c.metric} ${f(c.value)} over cap ${f(c.cap)} - ${c.note}`).join('\n');
}

// ---- CLI -----------------------------------------------------------------------------------
function cli(argv) {
  const valueOf = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };
  const has = (flag) => argv.includes(flag);
  const label = valueOf('--label', '');
  const sectionSeconds = Number(valueOf('--section-seconds', '0'));
  const capsPath = valueOf('--caps', '');
  const caps = capsPath ? JSON.parse(readFileSync(resolve(capsPath), 'utf8')) : undefined;
  const jsonOut = valueOf('--json', '');
  let lead, bed, full, sampleRate, inputs = {};
  const loadList = (list) => list.split(',').filter(Boolean).map((p) => resolve(p));
  if (has('--stems-dir')) {
    const dir = resolve(valueOf('--stems-dir'));
    const leadVoices = new Set(valueOf('--lead-voices', 'lead').split(',').filter(Boolean));
    const tag = valueOf('--tag', '');
    const files = readdirSync(dir).filter((f) => /\.wav$/i.test(f) && (!tag || f.startsWith(tag + '-')));
    const stems = {};
    for (const f of files) {
      const voice = basename(f).replace(/\.f32\.wav$/i, '').replace(/\.wav$/i, '').split('-').pop();
      if (voice === 'full') { const w = readWav(join(dir, f)); full = w.samples; sampleRate = w.sampleRate; inputs.full = { file: f, sha256: sha256File(join(dir, f)) }; continue; }
      stems[voice] = { file: f, wav: readWav(join(dir, f)) };
    }
    const leads = Object.entries(stems).filter(([v]) => leadVoices.has(v));
    const beds = Object.entries(stems).filter(([v]) => !leadVoices.has(v));
    if (!leads.length || !beds.length) { console.error('need at least one lead stem and one bed stem in', dir); process.exit(2); }
    sampleRate = sampleRate || leads[0][1].wav.sampleRate;
    lead = sumStems(leads.map(([, s]) => s.wav.samples));
    bed = sumStems(beds.map(([, s]) => s.wav.samples));
    inputs.lead = leads.map(([v, s]) => ({ voice: v, file: s.file, sha256: sha256File(join(dir, s.file)) }));
    inputs.bed = beds.map(([v, s]) => ({ voice: v, file: s.file, sha256: sha256File(join(dir, s.file)) }));
  } else if (has('--mix')) {
    const mixPath = resolve(valueOf('--mix')), mutedPath = resolve(valueOf('--lead-muted'));
    const mix = readWav(mixPath), muted = readWav(mutedPath);
    if (mix.sampleRate !== muted.sampleRate) { console.error('sample rates differ'); process.exit(2); }
    sampleRate = mix.sampleRate; full = mix.samples; bed = muted.samples; lead = subtract(mix.samples, muted.samples);
    inputs = { mix: { file: mixPath, sha256: sha256File(mixPath) }, leadMuted: { file: mutedPath, sha256: sha256File(mutedPath) }, leadIs: 'mix minus lead-muted' };
  } else if (has('--lead') && has('--bed')) {
    const L = loadList(valueOf('--lead')).map((p) => ({ p, w: readWav(p) }));
    const B = loadList(valueOf('--bed')).map((p) => ({ p, w: readWav(p) }));
    sampleRate = L[0].w.sampleRate;
    lead = sumStems(L.map((x) => x.w.samples)); bed = sumStems(B.map((x) => x.w.samples));
    if (has('--full')) { const F = readWav(resolve(valueOf('--full'))); full = F.samples; }
    inputs = { lead: L.map((x) => ({ file: x.p, sha256: sha256File(x.p) })), bed: B.map((x) => ({ file: x.p, sha256: sha256File(x.p) })) };
  } else {
    console.error('usage: --lead A.wav[,B.wav] --bed C.wav[,D.wav] [--full M.wav] | --stems-dir DIR --lead-voices v1,v2 [--tag T] | --mix M.wav --lead-muted N.wav   [--section-seconds N] [--label L] [--json out] [--caps caps.json]');
    process.exit(2);
  }
  const result = measureLeadBalance({ lead, bed, full, sampleRate, sectionSeconds, caps });
  const report = { label, generated: new Date().toISOString(), inputs, ...result };
  if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify(report, null, 2) + '\n');
  console.log(formatReport(label || (inputs.lead ? inputs.lead.map((x) => x.file || x.voice).join('+') : 'mix'), result));
  if (!result.available) process.exit(2);
  process.exit(result.verdict === 'GREEN' ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
