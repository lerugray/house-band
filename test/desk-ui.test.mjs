import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { browserSkip } from './helpers/env.mjs';

import { chromium } from 'playwright';

import { createDeskHttpServer } from '../src/desk/http.mjs';
import { DeskService } from '../src/desk/service.mjs';
import { buildProfiles } from '../src/desk/config.mjs';
import { createProvider } from '../src/desk/providers/index.mjs';
import { SessionStore } from '../src/desk/session-store.mjs';

describe('Desk UI smoke', { skip: await browserSkip() }, () => {
  let tmp;
  let server;
  let browser;
  let page;
  let port;
  let service;

  before(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'hb-desk-ui-'));
    const env = Object.create(null);
    const profiles = buildProfiles(env);
    const deterministic = profiles.find((p) => p.id === 'deterministic');
    const provider = createProvider(deterministic, env);
    const sessionStore = new SessionStore({ root: resolve(tmp, 'sessions') });
    service = new DeskService({ env, profiles, provider, weiss: null, sessionStore });
    await service.init();

    server = createDeskHttpServer(service);
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        port = server.address().port;
        resolveListen();
      });
    });

    browser = await chromium.launch({ args: ['--mute-audio'] });
    const context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage({ viewport: { width: 1440, height: 900 } });
  });

  after(async () => {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  });

  async function screenshot(name) {
    await page.screenshot({ path: resolve(tmp, `${name}.png`) });
  }

  it('loads the Desk, composes a score, and renders the audition bay', async () => {
    await page.goto(`http://127.0.0.1:${port}/desk/`);
    await page.waitForSelector('#prompt-input');

    // Select deterministic profile.
    await page.selectOption('#profile-select', 'deterministic');

    // Turn Weiss off.
    await page.uncheck('#weiss-toggle');

    // Enter prompt and make brief.
    await page.fill('#prompt-input', 'a tense loop for a stealth scene');
    await page.click('#brief-btn');
    await page.waitForSelector('#brief-group:not([hidden])', { timeout: 10_000 });
    const brief = await page.inputValue('#brief-input');
    assert.ok(brief.length > 0);

    // Cancel at the brief stage returns to the prompt without rendering.
    await page.click('#cancel-brief-btn');
    await page.waitForSelector('#prompt-group:not([hidden])', { timeout: 5_000 });
    assert.equal(await page.isVisible('#brief-group'), false);

    // Re-make the brief and continue.
    await page.click('#brief-btn');
    await page.waitForSelector('#brief-group:not([hidden])', { timeout: 10_000 });

    // Compose score.
    await page.click('#compose-btn');
    await page.waitForSelector('#freeze-panel:not([hidden])', { timeout: 30_000 });

    // Audition controls should be enabled.
    assert.equal(await page.isEnabled('#play-btn'), true);

    // Play briefly.
    await page.click('#play-btn');
    await page.waitForTimeout(500);
    await page.click('#stop-btn');

    await screenshot('desk-compose-audition');

    // Revise.
    await page.fill('#revision-input', 'make it brighter');
    await page.click('#revise-btn');
    await page.waitForFunction(() => document.querySelectorAll('.take-chip').length >= 2, { timeout: 30_000 });

    await screenshot('desk-revision');

    // Re-roll the seed and produce a new child take for A/B comparison.
    const firstSeed = await page.inputValue('#seed-input');
    await page.click('#reroll-btn');
    await page.waitForFunction(() => document.querySelectorAll('.take-chip').length >= 3, { timeout: 30_000 });
    const secondSeed = await page.inputValue('#seed-input');
    assert.notEqual(secondSeed, firstSeed);
  });

  it('exports a bundle', async () => {
    await page.goto(`http://127.0.0.1:${port}/desk/`);
    await page.waitForSelector('#prompt-input');
    await page.selectOption('#profile-select', 'deterministic');
    await page.uncheck('#weiss-toggle');
    await page.fill('#prompt-input', 'a tense loop');
    await page.click('#brief-btn');
    await page.waitForSelector('#brief-group:not([hidden])', { timeout: 10_000 });
    await page.click('#compose-btn');
    await page.waitForSelector('#freeze-panel:not([hidden])', { timeout: 30_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#export-handoff'),
    ]);
    const path = await download.path();
    assert.ok(path);
    const stat = await (await import('node:fs/promises')).stat(path);
    assert.ok(stat.size > 1000);
    const head = Buffer.alloc(4);
    const fh = await (await import('node:fs/promises')).open(path, 'r');
    await fh.read(head, 0, 4, 0);
    await fh.close();
    assert.equal(head.toString('binary'), 'PK\x03\x04');
  });

  it('recovers the session and take history on reopen', async () => {
    await page.goto(`http://127.0.0.1:${port}/desk/`);
    await page.waitForSelector('#prompt-input');
    await page.selectOption('#profile-select', 'deterministic');
    await page.uncheck('#weiss-toggle');
    await page.fill('#prompt-input', 'a recovery test loop');
    await page.click('#brief-btn');
    await page.waitForSelector('#brief-group:not([hidden])', { timeout: 10_000 });
    await page.click('#compose-btn');
    await page.waitForSelector('#freeze-panel:not([hidden])', { timeout: 30_000 });

    const sessionId = await page.evaluate(() => window.desk.session.sessionId);
    assert.ok(sessionId);
    const takeCount = await page.evaluate(() => document.querySelectorAll('.take-chip').length);
    assert.equal(takeCount, 1);

    // Close the page and reopen with the same session id.
    await page.close();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/desk/?session=${sessionId}`);
    await page.waitForSelector('#freeze-panel:not([hidden])', { timeout: 10_000 });
    const recovered = await page.evaluate(() => window.desk.session.sessionId);
    assert.equal(recovered, sessionId);
    const recoveredTakeCount = await page.evaluate(() => document.querySelectorAll('.take-chip').length);
    assert.equal(recoveredTakeCount, 1);
  });
});
