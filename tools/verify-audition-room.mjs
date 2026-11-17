#!/usr/bin/env node

/**
 * Smoke-check the standalone dist/audition-room.html file.
 *
 * Loads it from a file:// URL in headless Chromium, verifies the bundled demo
 * score renders the transport ready, and saves a screenshot.
 */

import { resolve } from 'node:path';
import { chromium } from 'playwright';

const AUDITION_ROOM = resolve(process.cwd(), 'dist', 'audition-room.html');
const SCREENSHOT = resolve(process.cwd(), 'docs', 'look-desk-m0-20260818', 'audition-room-smoke.png');

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto(`file://${AUDITION_ROOM}`);
  await page.waitForSelector('#play-btn');

  // Wait for the demo render to enable the export/accept controls.
  await page.waitForFunction(() => {
    const play = document.getElementById('play-btn');
    const accept = document.getElementById('accept-take');
    return play && !play.disabled && accept && !accept.disabled;
  }, { timeout: 30_000 });

  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  await browser.close();

  if (errors.length > 0) {
    console.error('Browser errors:', errors);
    process.exit(1);
  }
  console.log(`Audition Room smoke OK — screenshot saved to ${SCREENSHOT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
