#!/usr/bin/env node
/**
 * OSS-29: render Darkness 07-forty-one-seconds A/B (sampled TR-707 vs --kit-map tr707=tr808),
 * two-pass loudnorm to -16 LUFS, then MP3 (-q:a 2) and Ogg (-q:a 5) into site/audio/ab/.
 *
 * Usage: node site/tools/render-ab.mjs
 * Requires: ffmpeg on PATH, sample-packs/tv-kit-tr707 for the sampled leg.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSpec, SpecError } from '../../src/spec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const ROOT = path.resolve(SITE, '..');
const SCORE = path.join(SITE, 'scores', 'darkness', '07-forty-one-seconds.json');
const OUT_DIR = path.join(SITE, 'audio', 'ab');
const HB = path.join(ROOT, 'bin', 'house-band.mjs');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: opts.encoding ?? 'utf8',
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    cwd: opts.cwd ?? ROOT,
    env: process.env,
  });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) {
    const err = (r.stderr && String(r.stderr)) || (r.stdout && String(r.stdout)) || `exit ${r.status}`;
    die(`${cmd} ${args.join(' ')} failed:\n${err}`);
  }
  return r;
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Parse loudnorm first-pass JSON from ffmpeg stderr. */
function measureLoudnorm(wavPath) {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-i', wavPath, '-af', 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const text = `${r.stderr || ''}\n${r.stdout || ''}`;
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    die(`loudnorm measure: no JSON in ffmpeg output for ${wavPath}\n${text.slice(-800)}`);
  }
  let measured;
  try {
    measured = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    die(`loudnorm measure: bad JSON for ${wavPath}: ${err.message}`);
  }
  return measured;
}

function applyLoudnorm(inWav, outWav, measured) {
  const filter = [
    'loudnorm=I=-16:TP=-1:LRA=11',
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    'linear=true',
    'print_format=summary',
  ].join(':');
  run('ffmpeg', ['-y', '-hide_banner', '-i', inWav, '-af', filter, outWav]);
}

function encodePair(normWav, stem) {
  const mp3 = path.join(OUT_DIR, `${stem}.mp3`);
  const ogg = path.join(OUT_DIR, `${stem}.ogg`);
  run('ffmpeg', ['-y', '-hide_banner', '-i', normWav, '-codec:a', 'libmp3lame', '-q:a', '2', mp3]);
  run('ffmpeg', ['-y', '-hide_banner', '-i', normWav, '-codec:a', 'libvorbis', '-q:a', '5', ogg]);
  return { mp3, ogg };
}

function renderLeg(label, outWav, extraArgs = []) {
  console.log(`render-ab: rendering ${label} -> ${outWav}`);
  run(process.execPath, [HB, 'render', SCORE, '-o', outWav, ...extraArgs]);
}

function main() {
  if (!fs.existsSync(SCORE)) die(`render-ab: missing score ${SCORE}`);
  if (!fs.existsSync(HB)) die(`render-ab: missing ${HB}`);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SCORE, 'utf8'));
  } catch (err) {
    die(`render-ab: cannot read score: ${err.message}`);
  }

  try {
    validateSpec(raw);
  } catch (err) {
    const msg = err instanceof SpecError || err?.name === 'SpecError'
      ? err.message
      : (err && err.message) || String(err);
    console.error(`REPORT: BLOCKED OSS-29 score not a plain House Band spec: ${msg}`);
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-oss29-ab-'));
  const aRaw = path.join(tmp, 'a.wav');
  const bRaw = path.join(tmp, 'b.wav');
  const aNorm = path.join(tmp, 'a-norm.wav');
  const bNorm = path.join(tmp, 'b-norm.wav');

  try {
    renderLeg('sampled', aRaw);
    renderLeg('synth', bRaw, ['--kit-map', 'tr707=tr808']);

    console.log('render-ab: loudnorm pass 1 (measure) sampled');
    const aMeas = measureLoudnorm(aRaw);
    console.log('render-ab: loudnorm pass 2 (apply) sampled');
    applyLoudnorm(aRaw, aNorm, aMeas);

    console.log('render-ab: loudnorm pass 1 (measure) synth');
    const bMeas = measureLoudnorm(bRaw);
    console.log('render-ab: loudnorm pass 2 (apply) synth');
    applyLoudnorm(bRaw, bNorm, bMeas);

    console.log('render-ab: encode sampled');
    const sampled = encodePair(aNorm, 'forty-one-seconds-sampled');
    console.log('render-ab: encode synth');
    const synth = encodePair(bNorm, 'forty-one-seconds-synth');

    const shaA = sha256File(sampled.mp3);
    const shaB = sha256File(synth.mp3);
    if (shaA === shaB) die('render-ab: sampled and synth MP3 hashes match (expected differ)');

    console.log(`render-ab: wrote ${path.relative(ROOT, sampled.mp3)}`);
    console.log(`render-ab: wrote ${path.relative(ROOT, sampled.ogg)}`);
    console.log(`render-ab: wrote ${path.relative(ROOT, synth.mp3)}`);
    console.log(`render-ab: wrote ${path.relative(ROOT, synth.ogg)}`);
    console.log(`render-ab: mp3 sha256 sampled=${shaA}`);
    console.log(`render-ab: mp3 sha256 synth=${shaB}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
