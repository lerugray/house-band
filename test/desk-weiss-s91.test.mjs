import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { chmod, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { weissConfig, buildProfiles } from '../src/desk/config.mjs';
import { WeissCli } from '../src/desk/weiss.mjs';
import { DeskService } from '../src/desk/service.mjs';
import { SessionStore } from '../src/desk/session-store.mjs';
import { createProvider } from '../src/desk/providers/index.mjs';
import { createDeskHttpServer } from '../src/desk/http.mjs';
import { CODES } from '../src/desk/errors.mjs';

function jsonEnvelope(reply, extra = {}) {
  return {
    arm: 'primary',
    backend: 'openrouter',
    model: 'stub-model',
    reply,
    citations: [
      {
        tag: 'register',
        title: 'Stub Cite',
        source_kind: 'note',
        source_path: 'notes/stub.md',
        id: 'c1',
      },
    ],
    calibration: { note: 'stub' },
    music_evidence: {
      selection: 'catalog',
      tracks: [{ title: 'Alpha' }],
      modality_limit: 2,
    },
    ...extra,
  };
}

async function writeStubExec(dir, body, name = `weiss-stub-${Math.random().toString(16).slice(2)}`) {
  const executable = resolve(dir, name);
  const script = resolve(dir, `${name}.py`);
  await writeFile(executable, `#!/bin/sh\n${body}\n`, 'utf8');
  await writeFile(script, '# stub script\n', 'utf8');
  await chmod(executable, 0o755);
  return { executable, script };
}

function makeCli(dir, executable, script, extra = {}) {
  return new WeissCli({
    executable,
    script,
    cwd: dir,
    backend: 'openrouter',
    arm: 'primary',
    groundMusic: false,
    musicTracks: [],
    timeoutMs: 5_000,
    configPath: resolve(dir, 'no-weiss-config.json'),
    env: Object.create(null),
    ...extra,
  });
}

describe('S91 Weiss config profiles', () => {
  let tmp;

  before(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'hb-weiss-s91-cfg-'));
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('absent config file forces explicit openrouter public default', () => {
    const cfg = weissConfig({
      env: Object.create(null),
      configPath: resolve(tmp, 'missing.json'),
    });
    assert.equal(cfg.backend, 'openrouter');
    assert.equal(cfg.arm, 'primary');
    assert.equal(cfg.groundMusic, false);
    assert.deepEqual([...cfg.musicTracks], []);
    assert.equal(cfg.timeoutMs, 420_000);
    assert.ok(cfg.argv.includes('--backend'));
    assert.equal(cfg.argv[cfg.argv.indexOf('--backend') + 1], 'openrouter');
    assert.ok(cfg.argv.includes('--json'));
    assert.ok(!cfg.argv.includes('--ground-music'));
  });

  it('user-local Fable+music JSON opts in without repo secrets', async () => {
    const path = resolve(tmp, 'weiss-local.json');
    await writeFile(path, JSON.stringify({
      backend: 'claude-home',
      model: 'claude-fable-5-1',
      groundMusic: true,
      musicTracks: ['Track A', 'Track B'],
      timeoutMs: 420000,
    }), 'utf8');
    const cfg = weissConfig({
      env: Object.create(null),
      configPath: path,
    });
    assert.equal(cfg.backend, 'claude-home');
    assert.equal(cfg.model, 'claude-fable-5-1');
    assert.equal(cfg.groundMusic, true);
    assert.deepEqual([...cfg.musicTracks], ['Track A', 'Track B']);
    assert.equal(cfg.timeoutMs, 420000);
    assert.ok(cfg.argv.includes('--ground-music'));
    assert.equal(cfg.argv.filter((a) => a === '--music-track').length, 2);
    assert.ok(!JSON.stringify(cfg).toLowerCase().includes('api_key'));
  });

  it('HB_WEISS_* env overrides local JSON', async () => {
    const path = resolve(tmp, 'weiss-env.json');
    await writeFile(path, JSON.stringify({
      backend: 'claude-home',
      model: 'claude-fable-5-1',
      groundMusic: true,
    }), 'utf8');
    const cfg = weissConfig({
      env: {
        HB_WEISS_BACKEND: 'openrouter',
        HB_WEISS_GROUND_MUSIC: 'false',
        HB_WEISS_TIMEOUT_MS: '123000',
      },
      configPath: path,
    });
    assert.equal(cfg.backend, 'openrouter');
    assert.equal(cfg.groundMusic, false);
    assert.equal(cfg.model, 'claude-fable-5-1');
    assert.equal(cfg.timeoutMs, 123000);
  });

  it('rejects malformed local JSON clearly', async () => {
    const path = resolve(tmp, 'weiss-bad.json');
    await writeFile(path, '{not-json', 'utf8');
    assert.throws(
      () => weissConfig({ env: Object.create(null), configPath: path }),
      (err) => err.code === CODES.INVALID_REQUEST && /malformed JSON/i.test(err.message),
    );
  });

  it('music selection keeps the normal 420s deadline when unset', async () => {
    const path = resolve(tmp, 'weiss-music.json');
    await writeFile(path, JSON.stringify({
      backend: 'openrouter',
      musicTracks: ['One'],
    }), 'utf8');
    const cfg = weissConfig({ env: Object.create(null), configPath: path });
    assert.equal(cfg.timeoutMs, 420_000);
  });
});

describe('S91 Weiss CLI JSON + cancellation', () => {
  let tmp;

  before(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'hb-weiss-s91-cli-'));
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects invalid JSON, empty reply, and error envelopes', async () => {
    const invalid = await writeStubExec(tmp, 'printf "not-json\\n"');
    await assert.rejects(
      () => makeCli(tmp, invalid.executable, invalid.script).generate('p'),
      (err) => err.code === CODES.WEISS_FAILED && /invalid JSON/i.test(err.message),
    );

    const empty = await writeStubExec(tmp, `printf '%s\\n' '${JSON.stringify(jsonEnvelope(''))}'`);
    await assert.rejects(
      () => makeCli(tmp, empty.executable, empty.script).generate('p'),
      (err) => err.code === CODES.WEISS_FAILED && /empty reply/i.test(err.message),
    );

    const errored = await writeStubExec(
      tmp,
      `printf '%s\\n' '${JSON.stringify({ error: 'boom', reply: 'ignored' })}'`,
    );
    await assert.rejects(
      () => makeCli(tmp, errored.executable, errored.script).generate('p'),
      (err) => err.code === CODES.WEISS_FAILED && /boom/i.test(err.message),
    );
  });

  it('pre-aborted signal does not spawn', async () => {
    const marker = resolve(tmp, 'spawned.flag');
    const stub = await writeStubExec(
      tmp,
      `echo spawned > '${marker}'\nprintf '%s\\n' '${JSON.stringify(jsonEnvelope('x'))}'`,
    );
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => makeCli(tmp, stub.executable, stub.script).generate('secret-prompt', { signal: ac.signal }),
      (err) => err.code === CODES.WEISS_FAILED && /canceled before start/i.test(err.message),
    );
    assert.equal(existsSync(marker), false);
  });

  it('abort during run terminates resistant grandchild in the process group', async () => {
    const marker = resolve(tmp, 'grandchild.alive');
    const stub = await writeStubExec(tmp, `
marker='${marker}'
rm -f "$marker"
(
  trap '' TERM
  while true; do
    echo alive >> "$marker"
    sleep 0.05
  done
) &
trap 'exit 143' TERM
sleep 30
`);
    const weiss = makeCli(tmp, stub.executable, stub.script, { timeoutMs: 10_000 });
    const ac = new AbortController();
    const pending = weiss.generate('cancel-me', { signal: ac.signal });
    for (let i = 0; i < 40; i++) {
      if (existsSync(marker)) break;
      await sleep(50);
    }
    assert.equal(existsSync(marker), true, 'grandchild should have started');
    ac.abort();
    await assert.rejects(
      () => pending,
      (err) => err.code === CODES.WEISS_FAILED && err.details.canceled === true,
    );
    await sleep(1500);
    const before = existsSync(marker) ? (await readFile(marker, 'utf8')).length : 0;
    await sleep(300);
    const after = existsSync(marker) ? (await readFile(marker, 'utf8')).length : 0;
    assert.equal(after, before, 'grandchild should stop writing after group kill');
  });

  it('deadline kill clears escalation and does not leave dangling listeners', async () => {
    const before = process.listenerCount('uncaughtException');
    const stub = await writeStubExec(tmp, 'trap "" TERM\nsleep 30');
    const weiss = makeCli(tmp, stub.executable, stub.script, { timeoutMs: 80 });
    await assert.rejects(
      () => weiss.generate('slow'),
      (err) => err.code === CODES.WEISS_FAILED && err.details.timedOut === true,
    );
    await sleep(1200);
    assert.equal(process.listenerCount('uncaughtException'), before);
  });

  it('musicTracks produce exact repeatable argv without a shell', async () => {
    const stub = await writeStubExec(tmp, 'exit 0');
    const weiss = makeCli(tmp, stub.executable, stub.script, {
      groundMusic: true,
      musicTracks: ['Alpha', 'Beta'],
      model: 'claude-fable-5-1',
      backend: 'claude-home',
    });
    const a = weiss.argv('PROMPT');
    const b = weiss.argv('PROMPT');
    assert.deepEqual(a, b);
    assert.deepEqual(a, [
      stub.script,
      'PROMPT',
      '--backend', 'claude-home',
      '--model', 'claude-fable-5-1',
      '--arm', 'primary',
      '--ground-music',
      '--music-track', 'Alpha',
      '--music-track', 'Beta',
      '--json',
    ]);
  });
});

describe('S91 Desk provenance + no fallback', () => {
  let tmp;
  let providerCalls;

  function fakeApiService() {
    return {
      setProvider() {},
      capabilities() { return { canonicalVoiceAllowlist: ['kick'] }; },
      listPacks() { return []; },
      async submitSong() {
        const jobId = `job-${Math.random().toString(16).slice(2)}`;
        const job = {
          jobId,
          state: 'succeeded',
          admission: { modelLaneId: 'deterministic' },
        };
        return { job, completion: Promise.resolve(job) };
      },
      async listArtifacts() {
        return [
          { artifactId: 'score', kind: 'score', acceptance: 'accepted', sha256: 'scorehash' },
          { artifactId: 'mix', kind: 'wav_mix', acceptance: 'accepted', sha256: 'mixhash' },
          { artifactId: 'man', kind: 'manifest', acceptance: 'accepted', sha256: 'manhash' },
        ];
      },
      async getArtifact(_jobId, artifactId) {
        if (artifactId === 'score') {
          return { bytes: Buffer.from(JSON.stringify({ title: 'stub-score', seed: 1 }), 'utf8') };
        }
        return { bytes: Buffer.from('stub') };
      },
    };
  }

  before(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'hb-weiss-s91-desk-'));
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function buildService({ weiss } = {}) {
    providerCalls = 0;
    const env = Object.create(null);
    const profiles = buildProfiles(env);
    const deterministic = profiles.find((p) => p.id === 'deterministic');
    const sessionStore = new SessionStore({
      root: resolve(tmp, `sessions-${Math.random().toString(16).slice(2)}`),
    });
    const service = new DeskService({
      env,
      profiles,
      provider: createProvider(deterministic, env),
      weiss: weiss ?? null,
      sessionStore,
      apiService: fakeApiService(),
    });
    await service.init();
    const original = service.providerFor.bind(service);
    service.providerFor = (session) => {
      const p = original(session);
      return {
        laneId: p.laneId,
        async generate(args) {
          providerCalls += 1;
          return p.generate(args);
        },
      };
    };
    return service;
  }

  it('persists reply text + provenance on initial brief', async () => {
    const payload = jsonEnvelope('Initial register brief from stub');
    const stub = await writeStubExec(tmp, `printf '%s\\n' '${JSON.stringify(payload)}'`);
    const weiss = makeCli(tmp, stub.executable, stub.script);
    const service = await buildService({ weiss });
    const session = await service.createSession({
      prompt: 'tense stealth loop',
      weissEnabled: true,
      profileId: 'deterministic',
    });
    const result = await service.makeBrief(session.sessionId);
    assert.equal(result.brief, 'Initial register brief from stub');
    assert.equal(result.source, 'weiss');
    assert.equal(result.weissMeta.backend, 'openrouter');
    assert.equal(result.weissMeta.citations[0].id, 'c1');
    assert.equal(result.weissMeta.music_evidence.tracks[0].title, 'Alpha');
    assert.equal(providerCalls, 0);

    const stored = await service.getSession(session.sessionId);
    assert.equal(stored.brief.text, 'Initial register brief from stub');
    assert.equal(stored.brief.weissMeta.model, 'stub-model');
    assert.equal(Object.hasOwn(stored.brief.weissMeta, 'argv'), false);
    assert.ok(!JSON.stringify(stored.brief.weissMeta).includes('tense stealth loop'));
  });

  it('persists provenance on revision without audio render', async () => {
    const first = jsonEnvelope('First brief');
    const second = jsonEnvelope('Revised brief', {
      backend: 'claude-home',
      model: 'claude-fable-5-1',
      citations: [{ tag: 'r', title: 'Rev', source_kind: 'note', source_path: 'r.md', id: 'r2' }],
    });
    const stateFile = resolve(tmp, 'rev-state.txt');
    await writeFile(stateFile, '1', 'utf8');
    const stub = await writeStubExec(tmp, `
state='${stateFile}'
n=$(cat "$state")
if [ "$n" = "1" ]; then
  echo 2 > "$state"
  printf '%s\\n' '${JSON.stringify(first)}'
else
  printf '%s\\n' '${JSON.stringify(second)}'
fi
`);
    const weiss = makeCli(tmp, stub.executable, stub.script);
    const service = await buildService({ weiss });
    const session = await service.createSession({
      prompt: 'loop',
      weissEnabled: true,
      profileId: 'deterministic',
    });
    await service.makeBrief(session.sessionId);
    const raw = await service.sessionStore.read(session.sessionId);
    raw.takes.push({
      takeId: 'take-1',
      jobId: 'job-seed',
      parentTakeId: null,
      createdAt: new Date().toISOString(),
      prompt: 'loop',
      brief: raw.brief,
      score: { title: 'seed' },
      scoreSha256: 's',
      mixSha256: 'm',
      manifestSha256: 'f',
      hasStems: false,
      hasRpp: false,
      model: 'deterministic',
    });
    await service.sessionStore.write(raw);

    const revised = await service.reviseScore(session.sessionId, 'take-1', 'brighter pad');
    assert.equal(revised.session.brief.text, 'Revised brief');
    assert.equal(revised.session.brief.source, 'weiss');
    assert.equal(revised.session.brief.weissMeta.backend, 'claude-home');
    assert.equal(revised.session.brief.weissMeta.citations[0].id, 'r2');
    assert.equal(providerCalls, 0);
    assert.ok(revised.take);
    assert.equal(revised.take.parentTakeId, 'take-1');
  });

  it('enabled but unavailable Weiss fails with zero provider calls', async () => {
    const weiss = makeCli(tmp, resolve(tmp, 'missing-exec'), resolve(tmp, 'missing.py'));
    const service = await buildService({ weiss });
    const session = await service.createSession({
      prompt: 'x',
      weissEnabled: true,
      profileId: 'deterministic',
    });
    await assert.rejects(
      () => service.makeBrief(session.sessionId),
      (err) => err.code === CODES.WEISS_FAILED,
    );
    assert.equal(providerCalls, 0);
  });

  it('Weiss-off still uses the composer provider', async () => {
    const service = await buildService({ weiss: null });
    const session = await service.createSession({
      prompt: 'x',
      weissEnabled: false,
      profileId: 'deterministic',
    });
    const result = await service.makeBrief(session.sessionId, 'write a brief');
    assert.equal(result.source, 'model');
    assert.ok(result.brief.length > 0);
    assert.equal(providerCalls, 1);
  });
});

describe('S91 HTTP disconnect aborts Weiss', () => {
  let tmp;
  let server;
  let port;
  let sessionId;
  let marker;

  before(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'hb-weiss-s91-http-'));
    marker = resolve(tmp, 'http-child.alive');
    const stub = await writeStubExec(tmp, `
marker='${marker}'
rm -f "$marker"
(
  trap '' TERM
  while true; do echo alive >> "$marker"; sleep 0.05; done
) &
trap 'exit 143' TERM
sleep 30
`);
    const weiss = makeCli(tmp, stub.executable, stub.script, { timeoutMs: 15_000 });
    const env = Object.create(null);
    const profiles = buildProfiles(env);
    const deterministic = profiles.find((p) => p.id === 'deterministic');
    const sessionStore = new SessionStore({ root: resolve(tmp, 'sessions') });
    const service = new DeskService({
      env,
      profiles,
      provider: createProvider(deterministic, env),
      weiss,
      sessionStore,
      apiService: {
        setProvider() {},
        capabilities() { return { canonicalVoiceAllowlist: [] }; },
        listPacks() { return []; },
      },
    });
    await service.init();
    const session = await service.createSession({
      prompt: 'disconnect me',
      weissEnabled: true,
      profileId: 'deterministic',
    });
    sessionId = session.sessionId;

    server = createDeskHttpServer(service);
    await new Promise((resolveListen, reject) => {
      server.listen(0, '127.0.0.1', () => resolveListen());
      server.once('error', reject);
    });
    port = server.address().port;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await rm(tmp, { recursive: true, force: true });
  });

  it('request destroy aborts the Weiss subprocess group', async () => {
    const body = '{"prompt":"abort-please"}';
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: `/desk/api/sessions/${sessionId}/brief`,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();

    for (let i = 0; i < 40; i++) {
      if (existsSync(marker)) break;
      await sleep(50);
    }
    assert.equal(existsSync(marker), true);
    req.destroy();
    await sleep(2000);
    const before = existsSync(marker) ? (await readFile(marker, 'utf8')).length : 0;
    await sleep(400);
    const after = existsSync(marker) ? (await readFile(marker, 'utf8')).length : 0;
    assert.equal(after, before, 'HTTP disconnect should stop grandchild writes');
  });
});
