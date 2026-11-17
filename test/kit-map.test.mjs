/** OSS-08: --kit-map kit substitution at render. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyKitMap, parseKitMap, resolveKitMapVariants } from '../src/kit-map.mjs';
import { validateSpec } from '../src/spec.mjs';
import { KIT_VERSION } from '../src/version.mjs';
import { packSkip } from './helpers/env.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const compose = join(root, 'src', 'compose.mjs');

/** Small score: score-level tr707, one event with linndrum. */
function mappedSpec() {
  return {
    schemaVersion: '1.1.0',
    kitVersion: { ...KIT_VERSION },
    seed: 7,
    tempo: 120,
    sampleRate: 44100,
    gain: 0.5,
    kit: 'tr707',
    register: { name: 'kit-demo', briefRef: 'docs/REGISTER-KIT-DEMO.md' },
    tracks: {
      T: {
        bpm: 120,
        len: 16,
        vol: 0.8,
        steps: [
          { i: 0, voice: 'kick', opts: { vol: 0.2 } },
          { i: 8, voice: 'snare', opts: { vol: 0.15, kit: 'linndrum' } },
        ],
      },
    },
    sections: [{ track: 'T', bars: 1, fadeIn: 0 }],
  };
}

describe('kit-map parseKitMap', () => {
  it('parses a comma map into a frozen Map', () => {
    const map = parseKitMap('tr707=tr808,linndrum=tr909');
    assert.equal(map.get('tr707'), 'tr808');
    assert.equal(map.get('linndrum'), 'tr909');
    assert.equal(map.size, 2);
    assert.ok(Object.isFrozen(map));
  });

  it('rejects an empty item', () => {
    assert.throws(() => parseKitMap('tr707=tr808,'), (e) => e instanceof Error && e.message.includes('""'));
    assert.throws(() => parseKitMap(',tr707=tr808'), (e) => e instanceof Error);
    assert.throws(() => parseKitMap(''), (e) => e instanceof Error);
  });

  it('rejects a missing equals', () => {
    assert.throws(() => parseKitMap('tr707'), (e) => e instanceof Error && e.message.includes('tr707'));
    assert.throws(() => parseKitMap('tr707=tr808,linndrum'), (e) => e instanceof Error && e.message.includes('linndrum'));
  });

  it('rejects a source listed twice', () => {
    assert.throws(
      () => parseKitMap('tr707=tr808,tr707=tr909'),
      (e) => e instanceof Error && e.message.includes('tr707=tr909'),
    );
  });

  it('rejects source equal to target', () => {
    assert.throws(() => parseKitMap('tr707=tr707'), (e) => e instanceof Error && e.message.includes('tr707=tr707'));
  });
});

describe('kit-map applyKitMap', () => {
  it('replaces score and event kits, leaves input unchanged', () => {
    const spec = mappedSpec();
    const saved = structuredClone(spec);
    const map = parseKitMap('tr707=tr808,linndrum=tr909');
    const { spec: out, replaced } = applyKitMap(spec, map);
    assert.equal(out.kit, 'tr808');
    assert.equal(out.tracks.T.steps[1].opts.kit, 'tr909');
    assert.equal(replaced.length, 2);
    assert.deepEqual(
      replaced.map((r) => ({ path: r.path, from: r.from, to: r.to })),
      [
        { path: 'kit', from: 'tr707', to: 'tr808' },
        { path: 'tracks.T.steps[1].opts.kit', from: 'linndrum', to: 'tr909' },
      ],
    );
    assert.deepEqual(spec, saved);
    assert.notEqual(out, spec);
  });

  it('leaves unmapped kits alone and replaces o.kit / track.kit', () => {
    const spec = {
      kit: 'tr808',
      tracks: {
        A: {
          kit: 'tr707',
          steps: [{ i: 0, voice: 'kick', o: { kit: 'linndrum' } }],
        },
      },
    };
    const { spec: out, replaced } = applyKitMap(spec, parseKitMap('tr707=tr808,linndrum=tr909'));
    assert.equal(out.kit, 'tr808');
    assert.equal(out.tracks.A.kit, 'tr808');
    assert.equal(out.tracks.A.steps[0].o.kit, 'tr909');
    assert.equal(replaced.length, 2);
  });
});

/** Score that uses tr707 perc variant `tamb`, which tr808 does not have. */
function tambSpec() {
  return {
    schemaVersion: '1.1.0',
    kitVersion: { ...KIT_VERSION },
    seed: 7,
    tempo: 120,
    sampleRate: 44100,
    gain: 0.5,
    kit: 'tr707',
    register: { name: 'kit-demo', briefRef: 'docs/REGISTER-KIT-DEMO.md' },
    tracks: {
      T: {
        bpm: 120,
        len: 16,
        vol: 0.8,
        steps: [
          { i: 0, voice: 'kick', opts: { vol: 0.2 } },
          { i: 4, voice: 'perc', opts: { vol: 0.15, variant: 'tamb' } },
          { i: 8, voice: 'perc', opts: { vol: 0.15, variant: 'tamb' } },
        ],
      },
    },
    sections: [{ track: 'T', bars: 1, fadeIn: 0 }],
  };
}

describe('kit-map variant fallback tr707->tr808 tamb', () => {
  it('rewrites tamb to tr808 perc default and records substitutions', () => {
    const spec = tambSpec();
    assert.doesNotThrow(() => validateSpec(structuredClone(spec)));
    const mapped = applyKitMap(spec, parseKitMap('tr707=tr808'));
    assert.equal(mapped.spec.kit, 'tr808');
    const { spec: out, substitutions } = resolveKitMapVariants(mapped.spec);
    assert.equal(out.tracks.T.steps[1].opts.variant, 'cowbell');
    assert.equal(out.tracks.T.steps[2].opts.variant, 'cowbell');
    assert.deepEqual(substitutions, [
      { lane: 'perc', from: 'tamb', to: 'cowbell' },
      { lane: 'perc', from: 'tamb', to: 'cowbell' },
    ]);
    assert.doesNotThrow(() => validateSpec(out));
  });

  it('compose --kit-map tr707=tr808 on a tamb score exits 0 with kitMap.substitutions', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hb-kit-map-tamb-'));
    const emptyPacks = join(tmp, 'packs');
    mkdirSync(emptyPacks);
    const specPath = join(tmp, 'score.json');
    const outPath = join(tmp, 'x.wav');
    writeFileSync(specPath, `${JSON.stringify(tambSpec(), null, 2)}\n`);
    try {
      const result = spawnSync(
        process.execPath,
        [compose, '--spec', specPath, '--kit-map', 'tr707=tr808', '--out', outPath],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOUSE_BAND_PACKS: emptyPacks,
            HOUSE_BAND_PALETTE_CHECK: 'off',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /kit-map: variant substitution perc tamb -> cowbell/);
      const manifest = JSON.parse(readFileSync(`${outPath}.manifest.json`, 'utf8'));
      assert.ok(Array.isArray(manifest.kitMap.substitutions));
      assert.equal(manifest.kitMap.substitutions.length, 2);
      assert.deepEqual(manifest.kitMap.substitutions[0], { lane: 'perc', from: 'tamb', to: 'cowbell' });
      const derived = JSON.parse(readFileSync(`${outPath}.score.json`, 'utf8'));
      assert.equal(derived.kit, 'tr808');
      assert.equal(derived.tracks.T.steps[1].opts.variant, 'cowbell');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('kit-map compose CLI', () => {
  it('applies --kit-map, writes wav, score custody and manifest kitMap', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hb-kit-map-'));
    const emptyPacks = join(tmp, 'packs');
    mkdirSync(emptyPacks);
    const specPath = join(tmp, 'score.json');
    const outPath = join(tmp, 'x.wav');
    writeFileSync(specPath, `${JSON.stringify(mappedSpec(), null, 2)}\n`);
    try {
      const result = spawnSync(
        process.execPath,
        [compose, '--spec', specPath, '--kit-map', 'tr707=tr808,linndrum=tr909', '--out', outPath],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOUSE_BAND_PACKS: emptyPacks,
            HOUSE_BAND_PALETTE_CHECK: 'off',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.ok(existsSync(outPath));
      const manifestPath = `${outPath}.manifest.json`;
      assert.ok(existsSync(manifestPath));
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.kitMap.replaced, 2);
      assert.deepEqual(manifest.kitMap.map, { tr707: 'tr808', linndrum: 'tr909' });
      assert.deepEqual(manifest.kitMap.substitutions, []);
      assert.equal(manifest.kitMap.derivedScore, 'x.wav.score.json');
      assert.ok(typeof manifest.kitMap.sourceArtifactSha256 === 'string');
      assert.match(manifest.kitMap.sourceArtifactSha256, /^[a-f0-9]{64}$/);
      assert.ok(existsSync(`${outPath}.score.json`));
      const derived = JSON.parse(readFileSync(`${outPath}.score.json`, 'utf8'));
      assert.equal(derived.kit, 'tr808');
      assert.equal(derived.tracks.T.steps[1].opts.kit, 'tr909');
      assert.match(result.stderr, /kit-map: tr707 -> tr808 \(1 references\)/);
      assert.match(result.stderr, /kit-map: linndrum -> tr909 \(1 references\)/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it(
    'without --kit-map, missing From Mars pack fails with the OSS-07 message',
    {
      skip: packSkip('tv-kit-tr707')
        ? false
        : 'skipped: tv-kit-tr707 is installed (assertion only when the pack is absent)',
    },
    () => {
      const tmp = mkdtempSync(join(tmpdir(), 'hb-kit-map-miss-'));
      const emptyPacks = join(tmp, 'packs');
      mkdirSync(emptyPacks);
      const specPath = join(tmp, 'score.json');
      const outPath = join(tmp, 'x.wav');
      writeFileSync(specPath, `${JSON.stringify(mappedSpec(), null, 2)}\n`);
      try {
        const result = spawnSync(
          process.execPath,
          [compose, '--spec', specPath, '--out', outPath],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              HOUSE_BAND_PACKS: emptyPacks,
              HOUSE_BAND_PALETTE_CHECK: 'off',
            },
          },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /--kit-map/);
        assert.match(result.stderr, /kit "tr707"/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
