#!/usr/bin/env node
/**
 * On the pinned custody toolchain only: render the OSS-06 oneshot specs and
 * rewrite REPIN-ON-PINNED-TOOLCHAIN placeholders with the measured hashes.
 * Exit 2 on any other host.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { OfflineAudioContext } from 'node-web-audio-api';

import { custodyAvailability, custodyProfile } from '../src/api/profile.mjs';
import { renderSpecToWav } from '../src/render.mjs';
import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';

const PLACEHOLDER = 'REPIN-ON-PINNED-TOOLCHAIN';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function replaceAll(path, from, to) {
  const before = readFileSync(path, 'utf8');
  if (!before.includes(from)) return false;
  writeFileSync(path, before.split(from).join(to));
  return true;
}

async function main() {
  globalThis.OfflineAudioContext = OfflineAudioContext;
  const available = custodyAvailability(custodyProfile()).available;
  if (!available) {
    console.error('repin-oneshot-goldens: pinned custody toolchain unavailable; run on Node v25.9.0 darwin/arm64');
    process.exit(2);
  }

  const m3 = JSON.parse(readFileSync(join(root, 'examples', 'm3-sample-spec.json'), 'utf8'));
  m3.kitVersion = { ...KIT_VERSION };
  const m3Pack = await loadSamplePackDirectory(join(root, 'sample-packs', 'hb-synth-oneshots'));
  const m3Render = await renderSpecToWav(validateSpec(m3), { samplePack: m3Pack });
  const m3Hash = sha256(m3Render.wav);

  const targets = [
    join(root, 'test', 'timbre-backcompat.test.mjs'),
    join(root, 'scripts', 'verify-m3-samples.mjs'),
  ];
  let rewritten = 0;
  for (const path of targets) {
    if (replaceAll(path, PLACEHOLDER, m3Hash)) {
      console.error(`rewrote ${path}`);
      rewritten += 1;
    }
  }
  if (rewritten === 0) {
    console.error('no REPIN-ON-PINNED-TOOLCHAIN placeholders found');
    process.exit(1);
  }
  console.error(`repinned oneshot goldens to ${m3Hash} (${rewritten} file(s))`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`repin-oneshot-goldens failed: ${error.message}`);
    process.exitCode = 1;
  });
}
