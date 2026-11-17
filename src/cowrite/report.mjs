/**
 * Co-write report (OSS-23): CO-WRITE-REPORT.md from develop.json + score.json (+ WAV).
 */
import { readWavChannels, wavLufs } from '../../tools/lib/loudness.mjs';

const NOTE_CHANGE_KINDS = new Set(['octave-fold', 're-strike']);

/** Sample peak of 16-bit PCM WAV bytes in dBFS (not true peak). */
export function samplePeakDbfs(wavBytes) {
  const { channels } = readWavChannels(wavBytes);
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const a = Math.abs(channel[i]);
      if (a > peak) peak = a;
    }
  }
  return 20 * Math.log10(Math.max(peak, 1e-9));
}

function formatMss(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds + 1e-9));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function materialKey(section) {
  return section.material ?? 'A';
}

function yoursCell(section, develop) {
  if (!section.statesUserMaterial) return '—';
  const record = develop.record ?? develop;
  const material = record.material?.[materialKey(section)];
  const parts = [];
  if (material?.voices) {
    for (const [id, voice] of Object.entries(material.voices)) {
      parts.push(`${id} (${voice})`);
    }
  }
  if ((section.parts?.userDrums ?? 0) > 0) parts.push('drums');
  if (parts.length === 0 && (section.parts?.user ?? 0) > 0) parts.push('user notes');
  return parts.length ? parts.join(', ') : '—';
}

function patchForVoice(spec, voice) {
  if (!voice) return null;
  if (Object.hasOwn(GM_DRUM_VOICES, voice)) return spec.kit ?? 'kit';
  return spec.patches?.[voice] ?? null;
}

const GM_DRUM_VOICES = Object.freeze({
  kick: 1,
  snare: 1,
  hat: 1,
  tomLow: 1,
  tomMid: 1,
  tomHigh: 1,
  clap: 1,
  rim: 1,
  ride: 1,
  crash: 1,
  perc: 1,
});

function addedCell(section, spec) {
  const track = spec.tracks?.[section.track];
  if (!track?.steps?.length) return '—';
  const seen = new Map();
  for (const step of track.steps) {
    if (step.origin !== 'house-band') continue;
    const voice = step.voice ?? step.v;
    if (!voice || seen.has(voice)) continue;
    const patch = patchForVoice(spec, voice);
    seen.set(voice, patch);
  }
  if (seen.size === 0) return '—';
  return [...seen.entries()]
    .map(([voice, patch]) => (patch && !Object.hasOwn(GM_DRUM_VOICES, voice) ? `${voice} (${patch})` : voice))
    .join(', ');
}

function formatChange(c) {
  if (c.kind === 'octave-fold') {
    const where = Array.isArray(c.sections) ? ` (sections ${c.sections.join(', ')})` : '';
    return `- Octave fold: ${c.track} note ${c.noteIndex} ${c.from} -> ${c.to}${c.voice ? ` on ${c.voice}` : ''}${where}`;
  }
  if (c.kind === 're-strike') {
    const where = Array.isArray(c.sections) ? ` (sections ${c.sections.join(', ')})` : '';
    return `- Re-strike: ${c.track}${c.noteIndex != null ? ` note ${c.noteIndex}` : ''}${where}`;
  }
  return `- ${c.kind}: ${JSON.stringify(c)}`;
}

/**
 * Build CO-WRITE-REPORT.md text.
 * @param {{ develop: object, spec: object, wavBytes?: Buffer|Uint8Array|null, credit?: string, files?: string[] }} args
 */
export function buildCowriteReport({ develop, spec, wavBytes = null, credit = 'the author', files = null }) {
  const record = develop.record ?? develop;
  const title = develop.source?.title ?? record.material?.A?.title ?? spec.label ?? 'untitled';
  const tempo = spec.tempo ?? record.tempo ?? 120;
  const sections = record.sections ?? [];
  const user = credit && String(credit).trim() ? String(credit).trim() : 'the author';

  const lines = [];
  lines.push(`# Co-write: ${title}`);
  lines.push('');
  lines.push('## Credit');
  lines.push('');
  lines.push(`Music by ${user} and House Band`);
  lines.push('');
  lines.push('## Sections');
  lines.push('');
  lines.push('Section | Starts at (m:ss) | Bars | Yours | Added by House Band');
  lines.push('--- | --- | --- | --- | ---');
  for (const s of sections) {
    const startSec = s.startSeconds ?? (s.startBar * 240) / tempo;
    const yours = yoursCell(s, develop);
    const added = addedCell(s, spec);
    lines.push(`${s.track} | ${formatMss(startSec)} | ${s.bars} | ${yours} | ${added}`);
  }
  lines.push('');
  lines.push('## Changes to your notes');
  lines.push('');
  const changes = (develop.changes ?? record.changes ?? []).filter((c) => NOTE_CHANGE_KINDS.has(c.kind));
  if (changes.length === 0) lines.push('None');
  else for (const c of changes) lines.push(formatChange(c));
  lines.push('');
  lines.push('## Loudness');
  lines.push('');
  if (wavBytes && wavBytes.length) {
    const lufs = wavLufs(wavBytes);
    const peak = samplePeakDbfs(wavBytes);
    const lufsText = Number.isFinite(lufs) ? `${round1(lufs)} LUFS` : 'silence';
    lines.push(`Integrated loudness: ${lufsText}`);
    lines.push(`Sample peak: ${round1(peak)} dBFS`);
  } else {
    lines.push('WAV not available; loudness not measured.');
  }
  lines.push('');
  lines.push('## Files');
  lines.push('');
  const fileList = files ?? [
    'score.json',
    'score.wav',
    'score.wav.manifest.json',
    'develop.json',
    'arrangement.mid',
    'CO-WRITE-REPORT.md',
  ];
  for (const f of fileList) lines.push(`- ${f}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Write helpers used by the develop CLI.
 * @returns {{ markdown: string, lufs: number|null, samplePeakDbfs: number|null }}
 */
export function cowriteReport(args) {
  const markdown = buildCowriteReport(args);
  let lufs = null;
  let peak = null;
  if (args.wavBytes && args.wavBytes.length) {
    lufs = wavLufs(args.wavBytes);
    peak = samplePeakDbfs(args.wavBytes);
  }
  return { markdown, lufs, samplePeakDbfs: peak };
}
