#!/usr/bin/env node
/** Generate the CC0 hb-synth-oneshots pack (deterministic synthetic one-shots). */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { encodeCanonicalWav } from '../src/sample-pack.mjs';

const SAMPLE_RATE = 44100;
const TWO_PI = Math.PI * 2;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadataPath = join(root, 'sample-packs', 'hb-synth-oneshots.build.json');
const packOut = join(root, 'sample-packs', 'hb-synth-oneshots');

/** Fixed-seed PRNG; seed 1 only. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function onePoleHighPass(input, cutoffHz) {
  const rc = 1 / (TWO_PI * cutoffHz);
  const dt = 1 / SAMPLE_RATE;
  const alpha = rc / (rc + dt);
  const out = new Float64Array(input.length);
  let y = 0;
  let prevX = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    y = alpha * (y + x - prevX);
    prevX = x;
    out[i] = y;
  }
  return out;
}

function normalizePeak(samples, peak) {
  let maxAbs = 0;
  for (let i = 0; i < samples.length; i++) maxAbs = Math.max(maxAbs, Math.abs(samples[i]));
  if (maxAbs === 0) return samples;
  const scale = peak / maxAbs;
  for (let i = 0; i < samples.length; i++) samples[i] *= scale;
  return samples;
}

function toInt16(samples) {
  const frames = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const q = Math.round(samples[i] * 32767);
    frames[i] = Math.max(-32768, Math.min(32767, q));
  }
  return frames;
}

function writeWav(path, samples) {
  writeFileSync(path, encodeCanonicalWav(toInt16(samples)));
}

function makeKick() {
  const duration = 0.3;
  const n = Math.round(duration * SAMPLE_RATE);
  const samples = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const f = t < 0.08 ? 150 * (45 / 150) ** (t / 0.08) : 45;
    phase += TWO_PI * f / SAMPLE_RATE;
    samples[i] = Math.sin(phase) * Math.exp(-t / 0.09);
  }
  return normalizePeak(samples, 0.9);
}

function makeSnare(noise) {
  const duration = 0.25;
  const n = Math.round(duration * SAMPLE_RATE);
  const tone = new Float64Array(n);
  const noiseRaw = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    phase += TWO_PI * 185 / SAMPLE_RATE;
    tone[i] = 0.5 * Math.sin(phase) * Math.exp(-t / 0.05);
    noiseRaw[i] = (noise() * 2 - 1) * Math.exp(-t / 0.07);
  }
  const noiseHp = onePoleHighPass(noiseRaw, 1500);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = tone[i] + 0.6 * noiseHp[i];
  return normalizePeak(samples, 0.9);
}

function makeHat(noise) {
  const duration = 0.08;
  const n = Math.round(duration * SAMPLE_RATE);
  const noiseRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) noiseRaw[i] = noise() * 2 - 1;
  const hp1 = onePoleHighPass(noiseRaw, 7000);
  const hp2 = onePoleHighPass(hp1, 7000);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    samples[i] = hp2[i] * Math.exp(-t / 0.02);
  }
  return normalizePeak(samples, 0.7);
}

function parseArgs(argv) {
  const args = { out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--out') args.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node tools/make-synth-oneshots.mjs --out <dir>');
    return;
  }
  if (!args.out) throw new Error('--out <dir> is required');

  const workRoot = resolve(args.out);
  const srcDir = join(workRoot, 'src');
  mkdirSync(srcDir, { recursive: true });

  const noise = mulberry32(1);
  writeWav(join(srcDir, 'kick.wav'), makeKick());
  writeWav(join(srcDir, 'snare.wav'), makeSnare(noise));
  writeWav(join(srcDir, 'hat-closed.wav'), makeHat(noise));

  rmSync(packOut, { recursive: true, force: true });
  mkdirSync(packOut, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [
      join(root, 'tools', 'build-pack.mjs'),
      '--input', srcDir,
      '--metadata', metadataPath,
      '--out', packOut,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`build-pack failed with exit ${result.status}`);
  }
  console.error(`wrote synth oneshots into ${srcDir} and pack ${packOut}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(`make-synth-oneshots failed: ${error.message}`);
    process.exitCode = 1;
  }
}
