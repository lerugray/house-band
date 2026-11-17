#!/usr/bin/env node
/**
 * Precompute waveform peaks for every audio file under site/audio/.
 * ffmpeg decode to 8 kHz mono s16le, 800 equal windows of [min, max] scaled to -1..1
 * (3 decimals), plus durationSeconds, written to site/peaks/<same relative path>.json.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const AUDIO = path.join(SITE, 'audio');
const PEAKS = path.join(SITE, 'peaks');
const WINDOWS = 800;
const RATE = 8000;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function walkAudio(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkAudio(full, out);
    else if (/\.(mp3|ogg|wav)$/i.test(ent.name)) out.push(full);
  }
  return out;
}

function peaksForFile(filePath) {
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', filePath, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    die(`peaks: ffmpeg failed for ${filePath}: ${(r.stderr && r.stderr.toString()) || r.error?.message}`);
  }
  const pcm = r.stdout;
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount < 1) die(`peaks: no samples from ${filePath}`);

  const durationSeconds = sampleCount / RATE;
  const peaks = [];
  for (let w = 0; w < WINDOWS; w++) {
    const start = Math.floor((w * sampleCount) / WINDOWS);
    const end = Math.floor(((w + 1) * sampleCount) / WINDOWS);
    let min = 1;
    let max = -1;
    if (end <= start) {
      min = 0;
      max = 0;
    } else {
      for (let i = start; i < end; i++) {
        const s = pcm.readInt16LE(i * 2) / 32768;
        if (s < min) min = s;
        if (s > max) max = s;
      }
    }
    peaks.push([
      Math.round(min * 1000) / 1000,
      Math.round(max * 1000) / 1000,
    ]);
  }
  return { peaks, durationSeconds: Math.round(durationSeconds * 1000) / 1000 };
}

function main() {
  const files = walkAudio(AUDIO);
  if (!files.length) die('peaks: no audio files under site/audio/ (run fetch-audio.mjs first)');

  for (const file of files) {
    const rel = path.relative(AUDIO, file);
    const outPath = path.join(PEAKS, `${rel}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const data = peaksForFile(file);
    fs.writeFileSync(outPath, `${JSON.stringify(data)}\n`, 'utf8');
    console.log(`peaks: ${rel} (${data.durationSeconds}s)`);
  }
  console.log(`peaks: wrote ${files.length} files under site/peaks/`);
}

main();
