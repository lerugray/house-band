#!/usr/bin/env node
/**
 * CLI: house-band cowrite develop (OSS-22).
 *
 *   node tools/cowrite/develop.mjs <song.source.json> -o <out dir> [--engine arranger|llm]
 *     [--form loop|subtractive|aba|abac] [--drafts <file>...] [--brief <text>] [--length <bars>]
 *     [--kit <id>] [--seed <n>] [--profile <desk profile id>] [--credit <name>]
 *
 * Writes <out>/score.json, <out>/score.wav (+ score.wav.manifest.json), <out>/develop.json,
 * <out>/arrangement.mid and <out>/CO-WRITE-REPORT.md.
 * The keep layer is checked before anything renders; a broken keep layer writes develop.json
 * only and exits 3. The structural score-audit gate and the lead-balance gate run on every
 * score; a failing gate is named on stderr and the run exits 4 (outputs are still written so
 * the result can be inspected). Exit 2 is usage, 1 any other error.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORMS } from '../../src/cowrite/arranger.mjs';
import { DEVELOP_RECORD_FORMAT, DEVELOP_RECORD_VERSION, developScore, ENGINES } from '../../src/cowrite/develop.mjs';
import { exportArrangementMidi } from '../../src/cowrite/export-midi.mjs';
import { importMidi } from '../../src/cowrite/import-midi.mjs';
import { describeKeepLayer } from '../../src/cowrite/keep-layer.mjs';
import { buildCowriteReport } from '../../src/cowrite/report.mjs';
import { validateSourceSong } from '../../src/cowrite/source-song.mjs';
import { renderSpec, renderSpecToWav } from '../../src/render.mjs';
import { KITS } from '../../src/presets/kits/index.mjs';
import { validateSpec } from '../../src/spec.mjs';
import { auditScore } from '../score-audit/lib.mjs';
import { biquadBand, formatReport, MELODY_BAND, measureLeadBalance } from '../lead-balance/lead-balance.mjs';

export const LEAD_VOICES = Object.freeze(['lead']);
const MAX_TRIM_PASSES = 2;
const MAX_PROGRESSION_VARIANTS = 4;
const TRIM_TOLERANCE_DB = 1.0;

export class DevelopUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DevelopUsageError';
  }
}

function usage() {
  return `Usage: node tools/cowrite/develop.mjs <song.source.json> -o <out dir> [--engine ${ENGINES.join('|')}]
       [--form ${FORMS.join('|')}] [--drafts <file>...] [--brief <text>] [--length <bars>]
       [--kit <id>] [--seed <n>] [--profile <desk profile id>] [--credit <name>]

Develops a house-band-source-song into a full arrangement that keeps every user note.
Defaults: --engine arranger, --form subtractive, --kit tr808, --seed 1, --credit "the author".
--drafts takes source-song JSON or MIDI files; they become the B and C sections.
--profile picks the Desk provider for --engine llm (default HOUSE_BAND_PROFILE, else the Desk default).
--credit sets the name in the co-write report credit line.`;
}

export function parseArgs(args) {
  const out = { file: null, outDir: null, engine: 'arranger', form: 'subtractive', drafts: [], brief: null, lengthBars: null, kit: 'tr808', seed: 1, profile: null, credit: 'the author' };
  const need = (flag, value) => {
    if (value == null || value.startsWith('-')) throw new DevelopUsageError(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '-o' || a === '--out') out.outDir = need(a, args[++i]);
    else if (a === '--engine') out.engine = need(a, args[++i]);
    else if (a === '--form') out.form = need(a, args[++i]);
    else if (a === '--brief') {
      if (args[i + 1] == null) throw new DevelopUsageError('--brief needs a value');
      out.brief = args[++i];
    } else if (a === '--length') out.lengthBars = Number(need(a, args[++i]));
    else if (a === '--kit') out.kit = need(a, args[++i]);
    else if (a === '--seed') out.seed = Number(need(a, args[++i]));
    else if (a === '--profile') out.profile = need(a, args[++i]);
    else if (a === '--credit') out.credit = need(a, args[++i]);
    else if (a === '--drafts') {
      while (args[i + 1] != null && !args[i + 1].startsWith('-')) out.drafts.push(args[++i]);
      if (out.drafts.length === 0) throw new DevelopUsageError('--drafts needs at least one file');
    } else if (a.startsWith('-')) throw new DevelopUsageError(`unknown flag: ${a}`);
    else if (out.file == null) out.file = a;
    else throw new DevelopUsageError(`unexpected argument: ${a}`);
  }
  if (out.file == null || out.outDir == null) throw new DevelopUsageError('a source-song file and -o <out dir> are required');
  if (!ENGINES.includes(out.engine)) throw new DevelopUsageError(`--engine must be one of ${ENGINES.join(', ')}`);
  if (!FORMS.includes(out.form)) throw new DevelopUsageError(`--form must be one of ${FORMS.join(', ')}`);
  if (out.lengthBars !== null && (!Number.isInteger(out.lengthBars) || out.lengthBars < 1 || out.lengthBars > 4096)) throw new DevelopUsageError('--length must be a whole number of bars from 1 to 4096');
  if (!Number.isInteger(out.seed) || out.seed < 0 || out.seed > 0xffffffff) throw new DevelopUsageError('--seed must be an unsigned 32-bit integer');
  if (!Object.hasOwn(KITS, out.kit)) throw new DevelopUsageError(`--kit: unknown kit "${out.kit}" (have ${Object.keys(KITS).join(', ')})`);
  return out;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Read a source-song JSON, or import a MIDI file (drafts may be either). */
export function readSong(path) {
  const bytes = readFileSync(path);
  const ext = extname(path).toLowerCase();
  if (ext === '.mid' || ext === '.midi') return { song: validateSourceSong(importMidi(bytes, basename(path))), sha256: sha256(bytes) };
  return { song: validateSourceSong(JSON.parse(bytes.toString('utf8'))), sha256: sha256(bytes) };
}

/** Desk provider for the llm engine. */
export async function deskProvider(profileId) {
  const { loadEnvFile } = await import('../../src/desk/env.mjs');
  const { buildProfiles, getProfile, DEFAULT_PROFILE_ID } = await import('../../src/desk/config.mjs');
  const { createProvider } = await import('../../src/desk/providers/index.mjs');
  const file = await loadEnvFile();
  const env = { ...file.env, ...process.env };
  const id = profileId ?? env.HOUSE_BAND_PROFILE ?? DEFAULT_PROFILE_ID;
  const profiles = buildProfiles(env);
  const profile = getProfile(profiles, id);
  if (!profile) throw new DevelopUsageError(`unknown Desk profile "${id}" (have ${profiles.map((p) => p.id).join(', ')})`);
  if (!profile.configured) throw new DevelopUsageError(`Desk profile "${id}" is not configured (see docs for its environment variable); configured: ${profiles.filter((p) => p.configured).map((p) => p.id).join(', ')}`);
  return { provider: createProvider(profile, env), profileId: id };
}

function mono(buffer) {
  const n = buffer.length;
  const out = new Float64Array(n);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i] / channels;
  }
  return out;
}

function voicesIn(spec) {
  const set = new Set();
  for (const track of Object.values(spec.tracks)) for (const s of track.steps) set.add(s.voice ?? s.v);
  return [...set].sort();
}

/**
 * Lead and bed stems rendered through the score's own scheduler (solo by filtering the
 * event list, the lead-balance README's rule): the lead stem is the score with only the
 * lead voice, the bed the score without it. Each section renders on its own and the
 * section spans are joined: the kit's offline render time grows faster than linearly
 * with length, and this keeps the gate linear. The only difference from one long render
 * is that a section's reverb tail does not spill into the next section's span.
 */
export async function renderStems(spec, leadVoices, bedVoices) {
  const fs = spec.sampleRate;
  const parts = { lead: [], bed: [] };
  for (const section of spec.sections) {
    const single = validateSpec({ ...structuredClone(spec), sections: [structuredClone(section)] });
    const frames = Math.round(section.bars * 16 * (60 / (spec.tracks[section.track].bpm ?? spec.tempo) / 4) * fs);
    for (const [name, voices] of [['lead', leadVoices], ['bed', bedVoices]]) {
      const buf = mono(await renderSpec(single, { voices }));
      const span = new Float64Array(frames);
      span.set(buf.subarray(0, Math.min(frames, buf.length)));
      parts[name].push(span);
    }
  }
  const join = (list) => {
    const out = new Float64Array(list.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const a of list) {
      out.set(a, at);
      at += a.length;
    }
    return out;
  };
  return { lead: join(parts.lead), bed: join(parts.bed) };
}

/** The lead-balance gate (fleet caps) on the score's stems, plus per-section ratios. */
export async function leadBalanceGate(spec, record) {
  const voices = voicesIn(spec);
  const lead = voices.filter((v) => LEAD_VOICES.includes(v));
  const bed = voices.filter((v) => !LEAD_VOICES.includes(v));
  if (lead.length === 0 || bed.length === 0) return { available: false, reason: lead.length === 0 ? 'the score has no lead voice' : 'the score has no accompaniment', leadVoices: lead, bedVoices: bed };
  const stems = await renderStems(spec, lead, bed);
  const firstSection = record.sections[0];
  const leadMono = stems.lead;
  const bedMono = stems.bed;
  const result = measureLeadBalance({
    lead: leadMono,
    bed: bedMono,
    sampleRate: spec.sampleRate,
    sectionSeconds: (firstSection.bars * 240) / spec.tempo,
  });
  return { ...result, leadVoices: lead, bedVoices: bed, sectionsInBand: sectionRatios(leadMono, bedMono, spec, record) };
}

/** In-band (300-4000 Hz) lead-over-bed energy ratio per score section, from the stems. */
export function sectionRatios(lead, bed, spec, record) {
  const fs = spec.sampleRate;
  const lb = biquadBand(lead, fs, MELODY_BAND.lowHz, MELODY_BAND.highHz);
  const bb = biquadBand(bed, fs, MELODY_BAND.lowHz, MELODY_BAND.highHz);
  return record.sections.map((s) => {
    const a = Math.round(((s.startBar * 240) / spec.tempo) * fs);
    const z = Math.min(lb.length, Math.round((((s.startBar + s.bars) * 240) / spec.tempo) * fs));
    let lp = 0;
    let bp = 0;
    for (let i = a; i < z; i++) {
      lp += lb[i] * lb[i];
      bp += bb[i] * bb[i];
    }
    const n = Math.max(1, z - a);
    const leadDbfs = 10 * Math.log10(lp / n + 1e-30);
    const bedDbfs = 10 * Math.log10(bp / n + 1e-30);
    // A section with no audible lead (or no bed) has no ratio to trim.
    const ratioDb = leadDbfs > -72 && bedDbfs > -72 ? Math.round((leadDbfs - bedDbfs) * 100) / 100 : null;
    return { index: s.index, track: s.track, ratioDb };
  });
}

function auditSummary(audit) {
  const hs = audit.metrics.harmonicState;
  return {
    pass: audit.pass,
    flags: audit.flags,
    sections: hs.sections.map((s) => ({ index: s.index, label: s.label, classification: s.classification, motion: s.score === undefined ? null : Math.round(s.score * 1000) / 1000 })),
    distinctness: hs.comparisons.filter((c) => c.available).map((c) => ({ sections: c.sections, classification: c.classification, distance: Math.round(c.distance * 1000) / 1000 })),
    enforcement: { mode: hs.enforcement.mode, presentedAsNewPairs: hs.enforcement.presentedAsNewPairs, reportedReusePairs: hs.enforcement.reportedReusePairs.length },
  };
}

function leadSummary(lb) {
  if (!lb) return null;
  if (!lb.available) return { available: false, reason: lb.reason, leadVoices: lb.leadVoices, bedVoices: lb.bedVoices };
  return {
    available: true,
    verdict: lb.verdict,
    inBandMeanDb: lb.inBandMeanDb,
    loudestDecileDb: lb.loudestDecileDb,
    p90WindowDb: lb.p90WindowDb,
    hotWindowFraction: lb.hotWindowFraction,
    leadCrestOverBedDb: lb.leadCrestOverBedDb,
    leadCentroidHz: lb.leadCentroidHz,
    bedCentroidHz: lb.bedCentroidHz,
    leadBrighterThanBed: lb.leadBrighterThanBed,
    effectiveInBandMeanCapDb: lb.caps.effectiveInBandMeanCapDb,
    checks: lb.checks,
    perSection: lb.perSection,
    sections: lb.sectionsInBand,
    leadVoices: lb.leadVoices,
    bedVoices: lb.bedVoices,
    eligibleWindows: lb.eligibleWindows,
    windows: lb.windows,
  };
}

/**
 * Per-section lead trims (dB) that bring each section's measured in-band ratio to the
 * target inside every cap. Returns null when every section already sits within tolerance
 * and the verdict is GREEN.
 */
export function sectionTrims(lb, current) {
  const cap = lb.caps.effectiveInBandMeanCapDb;
  const target = Math.min(3, cap - 1);
  let changed = lb.verdict !== 'GREEN';
  const next = lb.sectionsInBand.map((s, k) => {
    const now = current[k] ?? 0;
    if (s.ratioDb === null) return now;
    const delta = target - s.ratioDb;
    if (Math.abs(delta) > TRIM_TOLERANCE_DB) changed = true;
    return Math.round(Math.max(-15, Math.min(6, now + delta)) * 100) / 100;
  });
  return changed ? next : null;
}

/**
 * Develop end to end. Returns { exitCode, record, paths }.
 * @param {object} o parsed options plus optional { source, drafts, render, leadBalance, provider, log }
 */
export async function runDevelop(o) {
  const log = o.log ?? ((line) => console.log(line));
  const warn = o.warn ?? ((line) => console.error(line));
  const outDir = resolve(o.outDir);
  const main = o.source ? { song: validateSourceSong(o.source), sha256: sha256(Buffer.from(JSON.stringify(o.source))) } : readSong(resolve(o.file));
  const drafts = o.draftSongs ? o.draftSongs.map((d) => ({ song: validateSourceSong(d), sha256: sha256(Buffer.from(JSON.stringify(d))) })) : (o.drafts ?? []).map((p) => readSong(resolve(p)));
  const doRender = o.render !== false;
  const doLeadBalance = o.leadBalance !== false && doRender;

  let provider = o.provider ?? null;
  let profileId = o.profileId ?? o.profile ?? null;
  if (o.engine === 'llm' && !provider) ({ provider, profileId } = await deskProvider(o.profile));

  mkdirSync(outDir, { recursive: true });
  const paths = {
    score: resolve(outDir, 'score.json'),
    wav: resolve(outDir, 'score.wav'),
    manifest: resolve(outDir, 'score.wav.manifest.json'),
    record: resolve(outDir, 'develop.json'),
    midi: resolve(outDir, 'arrangement.mid'),
    report: resolve(outDir, 'CO-WRITE-REPORT.md'),
  };
  const credit = o.credit ?? 'the author';

  let variant = 0;
  let trims = [];
  let trimPasses = 0;
  let result;
  let audit;
  let lead = null;
  const history = [];
  for (;;) {
    result = await developScore(main.song, {
      engine: o.engine,
      form: o.form,
      drafts: drafts.map((d) => d.song),
      lengthBars: o.lengthBars,
      kit: o.kit,
      seed: o.seed,
      brief: o.brief,
      provider,
      profileId,
      progressionVariant: variant,
      sectionLeadTrimDb: trims,
    });
    const keepOk = result.keepLayer.ok && result.draftKeepLayers.every((k) => k.ok);
    if (!keepOk) break;
    audit = auditScore(result.spec);
    if (o.engine === 'arranger' && audit.flags.includes('harmonic-bed-reuse') && variant + 1 < MAX_PROGRESSION_VARIANTS) {
      history.push({ progressionVariant: variant, reason: 'score-audit harmonic-bed-reuse: next House Band progression' });
      variant += 1;
      continue;
    }
    if (!doLeadBalance) break;
    lead = await leadBalanceGate(result.spec, result.record);
    if (o.engine !== 'arranger' || !lead.available || trimPasses >= MAX_TRIM_PASSES) break;
    const next = sectionTrims(lead, trims);
    if (next === null) break;
    history.push({ sectionLeadTrimDb: trims, sectionsInBandDb: lead.sectionsInBand.map((x) => x.ratioDb), inBandMeanDb: lead.inBandMeanDb, verdict: lead.verdict, nextSectionLeadTrimDb: next, reason: 'measured lead trim per section (Lead-Balance Law: measure the gap at a known trim, then scale)' });
    trims = next;
    trimPasses += 1;
  }

  const { spec, record, keepLayer, draftKeepLayers } = result;
  const keepOk = keepLayer.ok && draftKeepLayers.every((k) => k.ok);
  const developRecord = {
    format: DEVELOP_RECORD_FORMAT,
    version: DEVELOP_RECORD_VERSION,
    engine: record.engine,
    form: record.form,
    seed: record.seed,
    kit: record.kit,
    source: { title: main.song.title, sha256: main.sha256, provenance: main.song.provenance },
    drafts: drafts.map((d, k) => ({ draft: k + 1, title: d.song.title, sha256: d.sha256, provenance: d.song.provenance })),
    tempo: record.tempo,
    key: record.key,
    sections: record.sections,
    userSections: record.userSections,
    keepLayer: {
      ok: keepOk,
      expectedNotes: keepLayer.expectedNotes,
      sections: keepLayer.sections,
      missing: keepLayer.missing,
      moved: keepLayer.moved,
      extra: keepLayer.extra,
      drafts: draftKeepLayers.map((k, i) => ({ draft: i + 1, ok: k.ok, expectedNotes: k.expectedNotes, sections: k.sections, missing: k.missing, moved: k.moved, extra: k.extra })),
    },
    changes: record.changes,
    length: record.length,
    brief: record.brief,
    record,
    tuning: history,
  };

  if (!keepOk) {
    developRecord.render = { refused: true, reason: describeKeepLayer(keepLayer.ok ? draftKeepLayers.find((k) => !k.ok) : keepLayer) };
    writeFileSync(paths.record, `${JSON.stringify(developRecord, null, 2)}\n`);
    warn(`REFUSED: ${developRecord.render.reason}`);
    warn(`wrote ${paths.record} (no score rendered)`);
    return { exitCode: 3, record: developRecord, paths, spec };
  }

  writeFileSync(paths.score, `${JSON.stringify(spec, null, 2)}\n`);
  log(`wrote ${paths.score}`);

  const failed = [];
  developRecord.gates = { scoreAudit: auditSummary(audit), leadBalance: doLeadBalance ? leadSummary(lead) : { skipped: true } };
  if (!audit.pass) failed.push(`score-audit (${audit.flags.join(', ')})`);
  if (doLeadBalance) {
    if (!lead.available) failed.push(`lead-balance (measurement unavailable: ${lead.reason})`);
    else if (lead.verdict !== 'GREEN') failed.push(`lead-balance (${lead.checks.filter((c) => !c.ok).map((c) => `${c.metric} ${c.value} > ${c.cap}`).join(', ')})`);
  }
  developRecord.gates.failed = failed;
  developRecord.gates.passed = failed.length === 0;

  let wavBytes = null;
  if (doRender) {
    const { wav, manifest } = await renderSpecToWav(spec);
    wavBytes = wav;
    writeFileSync(paths.wav, wav);
    writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    developRecord.render = { wav: 'score.wav', manifest: 'score.wav.manifest.json', sha256: manifest.output.sha256, bytes: wav.length, seconds: Math.round((record.length.totalBars * 240 / spec.tempo) * 1000) / 1000 };
    log(`wrote ${paths.wav} (${wav.length} bytes, sha256 ${manifest.output.sha256})`);
  } else {
    developRecord.render = { skipped: true };
  }
  writeFileSync(paths.record, `${JSON.stringify(developRecord, null, 2)}\n`);
  log(`wrote ${paths.record}`);

  const midiBytes = exportArrangementMidi(spec, {
    sections: developRecord.sections,
    timeSignature: main.song.timeSignature ?? [4, 4],
  });
  writeFileSync(paths.midi, midiBytes);
  developRecord.arrangementMidi = { file: 'arrangement.mid', bytes: midiBytes.length };
  log(`wrote ${paths.midi} (${midiBytes.length} bytes)`);

  const reportFiles = ['score.json', 'develop.json', 'arrangement.mid', 'CO-WRITE-REPORT.md'];
  if (doRender) reportFiles.splice(1, 0, 'score.wav', 'score.wav.manifest.json');
  const reportMd = buildCowriteReport({
    develop: developRecord,
    spec,
    wavBytes,
    credit,
    files: reportFiles,
  });
  writeFileSync(paths.report, reportMd);
  developRecord.report = { file: 'CO-WRITE-REPORT.md', credit };
  writeFileSync(paths.record, `${JSON.stringify(developRecord, null, 2)}\n`);
  log(`wrote ${paths.report}`);

  log(`develop: ${main.song.title} -> ${record.engine} ${record.form}, ${record.sections.length} sections, ${record.length.totalBars} bars; ${describeKeepLayer(keepLayer)}`);
  log(`score-audit: ${audit.pass ? 'PASS' : `FAIL ${audit.flags.join(', ')}`}`);
  if (doLeadBalance) log(lead.available ? formatReport('develop', lead).split('\n').slice(0, 3).join('\n') + `\n  verdict ${lead.verdict}` : `lead-balance: unavailable (${lead.reason})`);
  for (const f of failed) warn(`GATE FAILED: ${f}`);
  return { exitCode: failed.length ? 4 : 0, record: developRecord, paths, spec };
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv.slice(2));
  } catch (err) {
    if (err instanceof DevelopUsageError) {
      console.error(err.message);
      console.error(usage());
      process.exit(2);
    }
    throw err;
  }
  if (opts.help) {
    console.log(usage());
    process.exit(0);
  }
  try {
    const { exitCode } = await runDevelop(opts);
    process.exit(exitCode);
  } catch (err) {
    if (err instanceof DevelopUsageError) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(err.message || err);
    process.exit(1);
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv).catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
