import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SamplesConfigError,
  SAMPLES_CONFIG_TOP_KEYS,
  validateSamplesConfig,
} from '../src/samples/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const SCHEMA_PATH = join(REPO_ROOT, 'docs', 'schemas', 'house-band.samples.schema.json');
const BASE_DIR = join(REPO_ROOT, 'examples', 'sample-mappings', 'generic-drum-folder');

/** PLAN.md (b) example config (source.path kept relative so baseDir resolution is exercised). */
function planExample() {
  return {
    format: 'house-band-samples',
    version: 1,
    id: 'my-drums',
    displayName: 'My drum folder',
    source: { type: 'folder', path: 'MyDrums' },
    licence: 'user-supplied; not for redistribution',
    fallbackKit: 'tr808',
    kit: {
      kick: { a: 'Kicks/BD Tight.wav', b: 'Kicks/BD Long.wav' },
      snare: { a: 'Snares/SN 01.wav' },
      hat: { closed: 'Hats/CH.wav', open: 'Hats/OH.wav' },
      clap: { default: 'Claps/Clap 2.wav' },
      perc: { cowbell: 'Perc/Cowbell.wav', shaker: 'Perc/Shaker.wav' },
    },
    patches: {
      'my-keys': {
        class: 'pluck',
        zones: 'auto',
        files: ['Keys/Rhodes C2.wav', 'Keys/Rhodes C3.wav', 'Keys/Rhodes C4.wav'],
      },
    },
  };
}

function assertFails(obj, expectedPath, mutate = (o) => o) {
  const input = mutate(structuredClone(obj));
  assert.throws(
    () => validateSamplesConfig(input, { baseDir: BASE_DIR }),
    (err) => {
      assert.ok(err instanceof SamplesConfigError, `expected SamplesConfigError, got ${err?.name}`);
      assert.equal(err.path, expectedPath);
      return true;
    },
  );
}

describe('OSS-10 samples config schema and validator', () => {
  it('PLAN.md (b) example validates with kit.kick.a.gain === 1 and absolute source.path', () => {
    const out = validateSamplesConfig(planExample(), { baseDir: BASE_DIR });
    assert.equal(out.kit.kick.a.gain, 1);
    assert.equal(out.kit.kick.a.maxSeconds, 2);
    assert.equal(out.kit.kick.a.file, 'Kicks/BD Tight.wav');
    assert.ok(isAbsolute(out.source.path), `source.path should be absolute, got ${out.source.path}`);
    assert.equal(out.patches['my-keys'].release, 0.08);
    assert.ok(Object.isFrozen(out));
    assert.ok(Object.isFrozen(out.kit.kick.a));
  });

  it('rejects unknown top-level key', () => {
    assertFails(planExample(), 'extra', (o) => {
      o.extra = true;
      return o;
    });
  });

  it('rejects bad format', () => {
    assertFails(planExample(), 'format', (o) => {
      o.format = 'nope';
      return o;
    });
  });

  it('rejects bad version', () => {
    assertFails(planExample(), 'version', (o) => {
      o.version = 2;
      return o;
    });
  });

  it('rejects bad id', () => {
    assertFails(planExample(), 'id', (o) => {
      o.id = 'Bad_Id';
      return o;
    });
  });

  it('rejects unknown drum lane', () => {
    assertFails(planExample(), 'kit.cowbell', (o) => {
      o.kit.cowbell = { default: 'x.wav' };
      return o;
    });
  });

  it('rejects hat.ride variant', () => {
    assertFails(planExample(), 'kit.hat.ride', (o) => {
      o.kit.hat.ride = 'Hats/Ride.wav';
      return o;
    });
  });

  it('rejects perc variant not in the built-in list', () => {
    assertFails(planExample(), 'kit.perc.gong', (o) => {
      o.kit.perc.gong = 'Perc/Gong.wav';
      return o;
    });
  });

  it('rejects non-wav file', () => {
    assertFails(planExample(), 'kit.kick.a', (o) => {
      o.kit.kick.a = 'Kicks/BD Tight.aiff';
      return o;
    });
  });

  it('rejects .. path segments', () => {
    assertFails(planExample(), 'kit.kick.a', (o) => {
      o.kit.kick.a = '../outside.wav';
      return o;
    });
  });

  it('rejects patch id colliding with humbucker-guitar', () => {
    assertFails(planExample(), 'patches.humbucker-guitar', (o) => {
      o.patches['humbucker-guitar'] = {
        class: 'pluck',
        zones: 'auto',
        files: ['Keys/Rhodes C2.wav'],
      };
      return o;
    });
  });

  it('rejects bad patch class', () => {
    assertFails(planExample(), 'patches.my-keys.class', (o) => {
      o.patches['my-keys'].class = 'guitar';
      return o;
    });
  });

  it('rejects empty patch files', () => {
    assertFails(planExample(), 'patches.my-keys.files', (o) => {
      o.patches['my-keys'].files = [];
      return o;
    });
  });

  it('rejects config with neither kit nor patches', () => {
    assertFails(planExample(), 'kit', (o) => {
      delete o.kit;
      delete o.patches;
      return o;
    });
  });

  it('schema file parses as JSON and properties keys equal allowed top-level keys', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    assert.deepEqual(Object.keys(schema.properties), [...SAMPLES_CONFIG_TOP_KEYS]);
  });
});
