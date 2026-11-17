#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { listen } from './serve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const OUT = path.join(SITE, 'screens');

const VIEWPORTS = [
  { w: 1280, h: 720 },
  { w: 1400, h: 730 },
  { w: 1600, h: 900 },
  { w: 390, h: 844 },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, url } = await listen(0);
  const address = server.address();
  const base = typeof address === 'object' && address
    ? `http://127.0.0.1:${address.port}/`
    : url;

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
    for (const { w, h } of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(base, { waitUntil: 'networkidle' });
      const tag = `${w}x${h}`;
      await page.screenshot({
        path: path.join(OUT, `${tag}-fold.png`),
        fullPage: false,
      });
      await page.screenshot({
        path: path.join(OUT, `${tag}-full.png`),
        fullPage: true,
      });
      await page.close();
    }
    console.log(`wrote ${VIEWPORTS.length * 2} PNGs to ${OUT}`);
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
