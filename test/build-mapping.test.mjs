/** OSS-09: build-mapping against a synthetic library and committed From Mars mappings. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { buildPack } from '../tools/build-pack.mjs';
import { loadSamplePackDirectory } from '../src/sample-pack-node.mjs';
import { packSkip } from './helpers/env.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_MAPPING = join(ROOT, 'tools', 'samples', 'build-mapping.mjs');
const MAPPINGS_DIR = join(ROOT, 'examples', 'sample-mappings', 'samples-from-mars');
const PACK_IDS = [
  'm3-tr606-demo',
  'tv-kit-cr78',
  'tv-kit-dystopian-tech',
  'tv-kit-found-wood',
  'tv-kit-linndrum',
  'tv-kit-synare-sds',
  'tv-kit-tr707',
  'tv-kit-vinyl-indie',
];

/** Tiny mono PCM16LE WAV writer for synthetic library fixtures. */
function writePcm16Wav(path, samples, sampleRate = 44100) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-32768, Math.min(32767, samples[i] | 0));
    buffer.writeInt16LE(clipped, 44 + i * 2);
  }
  writeFileSync(path, buffer);
}

function sineFrames(hz, seconds, sampleRate = 44100, peak = 16000) {
  const n = Math.round(seconds * sampleRate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(peak * Math.sin((2 * Math.PI * hz * i) / sampleRate));
  }
  return out;
}

function noiseBurstFrames(seconds, sampleRate = 44100, peak = 12000) {
  const n = Math.round(seconds * sampleRate);
  const out = new Int16Array(n);
  let state = 0x12345678;
  for (let i = 0; i < n; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const envelope = i < n / 8 ? i / (n / 8) : Math.max(0, 1 - (i - n / 8) / (n * 7 / 8));
    out[i] = Math.round((((state & 0xffff) / 0x8000) - 1) * peak * envelope);
  }
  return out;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runBuildMapping(args, env = process.env) {
  return spawnSync(process.execPath, [BUILD_MAPPING, ...args], {
    encoding: 'utf8',
    env: { ...env },
  });
}

async function makeSyntheticFixture(workDir) {
  const inputDir = join(workDir, 'library');
  const seedOut = join(workDir, 'seed-out');
  mkdirSync(inputDir, { recursive: true });
  const sinePath = join(inputDir, 'tone-sine.wav');
  const noisePath = join(inputDir, 'noise-burst.wav');
  writePcm16Wav(sinePath, sineFrames(220, 0.2));
  writePcm16Wav(noisePath, noiseBurstFrames(0.15));
  const metadata = {
    packId: 'probe-mapping-kit',
    displayName: 'Probe mapping kit',
    projectId: 'house-band',
    curator: 'test',
    createdAt: '2026-11-16T00:00:00Z',
    provenance: 'synthetic test fixture',
    attribution: 'synthetic test fixture',
    licenseRef: 'synthetic test fixture',
    sourceCollection: 'synthetic',
    assets: [
      {
        sourceFile: 'tone-sine.wav',
        id: 'kick',
        displayName: 'Sine kick stand-in',
        suggestedVoice: 'kick',
        tags: ['synthetic', 'sine'],
      },
      {
        sourceFile: 'noise-burst.wav',
        id: 'snare',
        displayName: 'Noise snare stand-in',
        suggestedVoice: 'snare',
        tags: ['synthetic', 'noise'],
      },
    ],
  };
  const metadataPath = join(workDir, 'probe.build.json');
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const built = await buildPack({
    inputDir,
    metadataPath,
    outputDir: seedOut,
  });
  const mapping = {
    ...metadata,
    assets: metadata.assets.map((asset) => {
      const sourceBytes = readFileSync(join(inputDir, asset.sourceFile));
      return { ...asset, expectedSourceSha256: sha256Bytes(sourceBytes) };
    }),
    libraryRootHint: 'synthetic library root',
    expected: {
      manifestSha256: built.manifest.manifestSha256,
      contentSha256: built.manifest.contentSha256,
    },
  };
  const mappingPath = join(workDir, 'probe-mapping-kit.mapping.json');
  writeFileSync(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`);
  rmSync(seedOut, { recursive: true, force: true });
  return { inputDir, mappingPath, mapping, packId: metadata.packId };
}

describe('build-mapping', () => {
  it('builds a synthetic mapping to OK, loads the pack, then rejects a changed source byte', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hb-build-mapping-'));
    try {
      const { inputDir, mappingPath, packId } = await makeSyntheticFixture(workDir);
      const outDir = join(workDir, 'packs');
      const ok = runBuildMapping([
        '--mapping', mappingPath,
        '--input', inputDir,
        '--out', outDir,
      ]);
      assert.equal(ok.status, 0, ok.stderr || ok.stdout);
      assert.match(ok.stdout, new RegExp(`OK ${packId} [0-9a-f]{12}`));
      const packDir = join(outDir, packId);
      assert.ok(existsSync(join(packDir, 'pack.json')));
      const loaded = await loadSamplePackDirectory(packDir);
      assert.equal(loaded.manifest.packId, packId);

      rmSync(packDir, { recursive: true, force: true });
      const noisePath = join(inputDir, 'noise-burst.wav');
      const bytes = Buffer.from(readFileSync(noisePath));
      bytes[60] = bytes[60] ^ 0xff;
      writeFileSync(noisePath, bytes);

      const bad = runBuildMapping([
        '--mapping', mappingPath,
        '--input', inputDir,
        '--out', outDir,
      ]);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /edition mismatch/);
      assert.match(bad.stderr, /different: noise-burst\.wav/);
      assert.equal(existsSync(packDir), false, 'failed build must not write a pack');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('refuses --out inside repo sample-packs/ with exit 2', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hb-build-mapping-refuse-'));
    try {
      const mappingPath = join(workDir, 'dummy.mapping.json');
      writeFileSync(mappingPath, JSON.stringify({
        packId: 'dummy',
        displayName: 'dummy',
        projectId: 'house-band',
        curator: 'test',
        createdAt: '2026-11-16T00:00:00Z',
        provenance: 'x',
        attribution: 'x',
        licenseRef: 'x',
        sourceCollection: 'x',
        assets: [{
          sourceFile: 'a.wav',
          id: 'kick',
          displayName: 'a',
          suggestedVoice: 'kick',
          tags: ['t'],
          expectedSourceSha256: '0'.repeat(64),
        }],
        libraryRootHint: 'x',
        expected: { manifestSha256: '0'.repeat(64), contentSha256: '0'.repeat(64) },
      }));
      const banned = join(ROOT, 'sample-packs', 'x');
      const result = runBuildMapping([
        '--mapping', mappingPath,
        '--input', workDir,
        '--out', banned,
      ]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /refusing to write inside repo sample-packs/);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('the 8 committed Samples From Mars mapping files parse as JSON', () => {
    for (const packId of PACK_IDS) {
      const path = join(MAPPINGS_DIR, `${packId}.mapping.json`);
      const mapping = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(mapping.packId, packId);
      assert.equal(typeof mapping.expected?.contentSha256, 'string');
      assert.equal(mapping.expected.contentSha256.length, 64);
      assert.equal(typeof mapping.expected?.manifestSha256, 'string');
      assert.ok(Array.isArray(mapping.assets));
      for (const asset of mapping.assets) {
        assert.equal(typeof asset.expectedSourceSha256, 'string');
        assert.equal(asset.expectedSourceSha256.length, 64);
      }
    }
    const m3 = JSON.parse(readFileSync(join(MAPPINGS_DIR, 'm3-tr606-demo.mapping.json'), 'utf8'));
    assert.equal(m3.provenance, 'purchased commercial sample collection (Samples From Mars)');
  });

  it(
    'each mapping expected.contentSha256 matches private sample-packs/<id>/pack.json',
    {
      skip: PACK_IDS.map((id) => packSkip(id)).find(Boolean) || false,
    },
    () => {
      for (const packId of PACK_IDS) {
        const mapping = JSON.parse(readFileSync(join(MAPPINGS_DIR, `${packId}.mapping.json`), 'utf8'));
        const pack = JSON.parse(readFileSync(join(ROOT, 'sample-packs', packId, 'pack.json'), 'utf8'));
        assert.equal(
          mapping.expected.contentSha256,
          pack.contentSha256,
          `${packId} contentSha256`,
        );
      }
    },
  );
});
