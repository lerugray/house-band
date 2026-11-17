import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { WeissCli } from '../src/desk/weiss.mjs';
import { CODES } from '../src/desk/errors.mjs';

function jsonReply(reply, extra = {}) {
  return JSON.stringify({
    arm: 'primary',
    backend: 'openrouter',
    model: 'test-model',
    reply,
    citations: [{ tag: 't', title: 'Title', source_kind: 'note', source_path: 'x', id: '1' }],
    music_evidence: { selection: 'none', tracks: [], modality_limit: 0 },
    ...extra,
  });
}

describe('Desk Weiss CLI boundary', () => {
  let tmp;

  before(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'hb-desk-weiss-'));
  });

  async function makeWeiss(scriptBody, timeoutMs = 5_000, extra = {}) {
    const executable = resolve(tmp, `python-${Math.random().toString(16).slice(2)}`);
    const script = resolve(tmp, `script-${Math.random().toString(16).slice(2)}.py`);
    await writeFile(executable, '#!/bin/sh\n' + scriptBody + '\n', 'utf8');
    await writeFile(script, '# placeholder', 'utf8');
    await chmod(executable, 0o755);
    return new WeissCli({
      executable,
      script,
      cwd: tmp,
      timeoutMs,
      backend: 'openrouter',
      groundMusic: false,
      musicTracks: [],
      arm: 'primary',
      configPath: resolve(tmp, 'absent-weiss.json'),
      env: Object.create(null),
      ...extra,
    });
  }

  it('returns reply from JSON on success', async () => {
    const payload = jsonReply("A brief in Ray's vocabulary");
    const weiss = await makeWeiss(`echo '${payload.replace(/'/g, `'\\''`)}'`);
    const result = await weiss.generate('make a tense loop');
    assert.equal(result.success, true);
    assert.equal(result.reply, "A brief in Ray's vocabulary");
    assert.equal(result.stdout, "A brief in Ray's vocabulary");
    assert.equal(result.provenance.backend, 'openrouter');
    assert.equal(result.provenance.citations[0].title, 'Title');
    assert.equal(result.provenance.music_evidence.selection, 'none');
    assert.equal(result.provenance.timedOut, false);
    assert.ok(!JSON.stringify(result.provenance).includes('make a tense loop'));
  });

  it('throws WEISS_FAILED on non-zero exit', async () => {
    const weiss = await makeWeiss('echo error >&2\nexit 1');
    try {
      await weiss.generate('prompt');
      assert.fail('expected rejection');
    } catch (err) {
      assert.equal(err.code, CODES.WEISS_FAILED);
      assert.ok(!JSON.stringify(err.details).includes('prompt'));
    }
  });

  it('throws WEISS_FAILED on timeout', async () => {
    const weiss = await makeWeiss('trap "exit 143" TERM\nsleep 5', 100);
    try {
      await weiss.generate('prompt');
      assert.fail('expected rejection');
    } catch (err) {
      assert.equal(err.code, CODES.WEISS_FAILED);
      assert.equal(err.details.timedOut, true);
    }
  });

  it('builds explicit openrouter argv by default', async () => {
    const weiss = await makeWeiss('echo ok');
    const argv = weiss.argv('hello world');
    assert.equal(argv[1], 'hello world');
    assert.ok(argv.includes('--backend'));
    assert.equal(argv[argv.indexOf('--backend') + 1], 'openrouter');
    assert.ok(argv.includes('--json'));
    assert.ok(!argv.includes('--ground-music'));
  });
});
