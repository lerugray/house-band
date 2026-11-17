#!/usr/bin/env node
/**
 * Playwright acceptance for the page player (OSS-26).
 * Headless Chromium with --mute-audio.
 */
import { chromium } from 'playwright';
import { listen } from './serve.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { server } = await listen(0);
  const address = server.address();
  const base = typeof address === 'object' && address
    ? `http://127.0.0.1:${address.port}/`
    : 'http://127.0.0.1:4173/';

  const launchOpts = {
    headless: true,
    args: ['--mute-audio'],
  };
  if (process.env.CHROMIUM_PATH) {
    launchOpts.executablePath = process.env.CHROMIUM_PATH;
  }

  let browser;
  try {
    browser = await chromium.launch(launchOpts);
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });

    const heroPlay = page.locator('#hero .play-btn, [data-slot="player-hero"] .play-btn').first();
    await heroPlay.waitFor({ state: 'visible' });
    await heroPlay.click();

    await page.waitForFunction(() => {
      const audio = document.querySelector('#player-hero audio, [data-slot="player-hero"] audio');
      return audio && audio.paused === false;
    }, null, { timeout: 15000 });

    const t0 = await page.evaluate(() => {
      const audio = document.querySelector('#player-hero audio, [data-slot="player-hero"] audio');
      return audio ? audio.currentTime : -1;
    });
    await sleep(800);
    const t1 = await page.evaluate(() => {
      const audio = document.querySelector('#player-hero audio, [data-slot="player-hero"] audio');
      return audio ? audio.currentTime : -1;
    });
    if (!(t1 > t0)) {
      throw new Error(`hero currentTime did not advance (${t0} -> ${t1})`);
    }

    const secondPlay = page.locator('#player-darkness .play-btn, [data-slot="player-darkness"] .play-btn').first();
    await secondPlay.click();

    await page.waitForFunction(() => {
      const hero = document.querySelector('#player-hero audio, [data-slot="player-hero"] audio');
      const dark = document.querySelector('#player-darkness audio, [data-slot="player-darkness"] audio');
      return hero && dark && hero.paused === true && dark.paused === false;
    }, null, { timeout: 15000 });

    const seek = await page.evaluate(() => {
      const root = document.querySelector('#player-hero, [data-slot="player-hero"]');
      const wave = root && root.querySelector('.hb-player-wave');
      const audio = root && root.querySelector('audio');
      if (!wave || !audio) return { ok: false, reason: 'missing wave/audio' };
      const dur = audio.duration || 0;
      // Prefer peaks duration via aria-valuemax if metadata not ready.
      const ariaMax = Number(wave.getAttribute('aria-valuemax') || 0);
      const duration = (Number.isFinite(dur) && dur > 0) ? dur : ariaMax;
      if (!(duration > 0)) return { ok: false, reason: `bad duration ${duration}` };
      const rect = wave.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      wave.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
      }));
      wave.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
      }));
      return {
        ok: true,
        currentTime: audio.currentTime,
        duration,
        delta: Math.abs(audio.currentTime - duration / 2),
      };
    });

    if (!seek.ok) throw new Error(`seek failed: ${seek.reason}`);
    if (seek.delta > 2) {
      throw new Error(
        `seek midpoint off: currentTime=${seek.currentTime} duration=${seek.duration} delta=${seek.delta}`,
      );
    }

    console.log('player.test ok');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
