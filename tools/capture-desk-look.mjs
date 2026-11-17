#!/usr/bin/env node

/**
 * Capture Composer's Desk M0 look screenshots for the lane report.
 *
 * Boots the Desk server, drives prompt → brief → compose, and saves
 * timestamped screenshots of the four §5.3 signature moves plus a full-page
 * shot into docs/look-desk-m0-20260818/.
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

import { createDeskHttpServer } from '../src/desk/http.mjs';
import { DeskService } from '../src/desk/service.mjs';
import { buildProfiles } from '../src/desk/config.mjs';
import { createProvider } from '../src/desk/providers/index.mjs';
import { SessionStore } from '../src/desk/session-store.mjs';
import { WeissCli } from '../src/desk/weiss.mjs';

const LOOK_DIR = resolve(process.cwd(), 'docs', 'look-desk-m0-20260818');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function shot(name) {
  return resolve(LOOK_DIR, `${TIMESTAMP}-${name}.png`);
}

async function main() {
  await mkdir(LOOK_DIR, { recursive: true });

  const tmp = await mkdtemp(resolve(tmpdir(), 'hb-desk-look-'));
  const env = Object.create(null);
  const profiles = buildProfiles(env);
  const deterministic = profiles.find((p) => p.id === 'deterministic');
  const provider = createProvider(deterministic, env);
  const sessionStore = new SessionStore({ root: resolve(tmp, 'sessions') });
  const weiss = new WeissCli();
  const service = new DeskService({ env, profiles, provider, weiss, sessionStore });
  await service.init();

  const server = createDeskHttpServer(service);
  let port;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      port = server.address().port;
      resolve();
    });
  });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`http://127.0.0.1:${port}/desk/`);
    await page.waitForSelector('#prompt-input');
    await page.selectOption('#profile-select', 'deterministic');
    // Leave Weiss ON for the brief stage.
    await page.fill('#prompt-input', 'a tense loop for a stealth scene');
    await page.click('#brief-btn');

    let weissWorked = false;
    try {
      await page.waitForSelector('#brief-group:not([hidden])', { timeout: 120_000 });
      const brief = await page.inputValue('#brief-input');
      weissWorked = brief.length > 0;
    } catch (err) {
      console.log('Weiss brief did not arrive in time or failed; capturing the failure state.');
    }

    await page.screenshot({ path: shot('desk-weiss-brief'), fullPage: true });

    if (!weissWorked) {
      console.log('Weiss exceeded its 60-second deadline; falling back to deterministic brief to capture pack-browser evidence.');
      await page.uncheck('#weiss-toggle');
      await page.click('#brief-btn');
      await page.waitForSelector('#brief-group:not([hidden])', { timeout: 10_000 });
    }

    await page.locator('#brief-group').screenshot({ path: shot('weiss-authored-brief') });

    await page.click('#compose-btn');
    await page.waitForSelector('#freeze-panel:not([hidden])', { timeout: 60_000 });
    await page.waitForTimeout(500);

    // Full page shows all four signature moves in context.
    await page.screenshot({ path: shot('desk-full-page'), fullPage: true });

    // Individual signature-move surfaces.
    await page.locator('#custody-rail').screenshot({ path: shot('signature-custody-rail') });
    await page.locator('#oscilloscope').screenshot({ path: shot('signature-structure-oscilloscope') });
    await page.locator('#pattern-wall').screenshot({ path: shot('signature-pattern-wall') });
    await page.locator('#freeze-panel').screenshot({ path: shot('signature-render-freeze') });

    // Canonical-pack browser: expand the first pack and preview a sample.
    await page.locator('.pack-toggle').first().click();
    await page.waitForSelector('.pack-assets:not([hidden])');
    await page.locator('.pack-asset .asset-name').first().waitFor();
    await page.locator('button[title="Preview"]').first().click();
    await page.waitForTimeout(300);
    await page.locator('#pack-section').screenshot({ path: shot('pack-browser-preview') });

    // Apply a sample suggestion to produce a new valid take.
    const suggestionResult = await page.evaluate(async () => {
      const desk = window.desk;
      const pack = desk.packs[0];
      if (!pack) return { ok: false, reason: 'no packs' };
      const asset = pack.assets[0];
      try {
        await desk.applySuggestion(pack, asset);
        return { ok: true, takeCount: desk.session.takes.length, activeTakeId: desk.session.activeTakeId };
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    });
    console.log('Suggestion result:', suggestionResult);
    if (!suggestionResult.ok) {
      await page.screenshot({ path: shot('desk-sample-suggestion-error'), fullPage: true });
    } else {
      await page.screenshot({ path: shot('desk-sample-suggestion-applied'), fullPage: true });
    }

    console.log(`Look screenshots saved to ${LOOK_DIR}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
