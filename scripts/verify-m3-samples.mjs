/** Required file:// Chromium proof for the M3 tranche-1 sample custody path. */

import { chromium } from '/opt/homebrew/lib/python3.14/site-packages/playwright/driver/package/index.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = resolve(root, 'dist', 'audition-room.html');
const scorePath = resolve(root, 'examples', 'm3-sample-spec.json');
const packPath = resolve(root, 'sample-packs', 'hb-synth-oneshots');
const expectedHash = 'REPIN-ON-PINNED-TOOLCHAIN';
const chromiumArgs = [
  '--single-process',
  '--no-zygote',
  '--disable-gpu',
  '--disable-software-rasterizer',
];

async function main() {
  const browser = await chromium.launch({ headless: true, args: chromiumArgs });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(`file://${htmlPath}`);
  await page.waitForFunction(
    () => document.getElementById('status').textContent.startsWith('Ready · sha256 '),
    null,
    { timeout: 60000 },
  );

  await page.locator('#load-input').setInputFiles(scorePath);
  await page.waitForFunction(
    () => document.getElementById('status').textContent.includes('requires a loaded and validated sample pack'),
    null,
    { timeout: 60000 },
  );
  await page.locator('#pack-input').setInputFiles(packPath);
  await page.waitForFunction(
    (hash) => document.getElementById('status').dataset.renderHash === hash,
    expectedHash,
    { timeout: 60000 },
  );

  const result = await page.evaluate(() => ({
    hash: document.getElementById('status').dataset.renderHash,
    status: document.getElementById('status').textContent,
    pack: document.getElementById('sample-pack-panel').textContent,
    sampleVoices: [...document.querySelectorAll('.voice-source.sample-backed')].map((entry) => entry.textContent),
  }));
  await page.screenshot({ path: resolve(root, 'docs', 'proofs', 'audition-room-m3-samples-2026-08-11.png'), fullPage: true });
  await browser.close();

  if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);
  if (result.hash !== expectedHash) throw new Error(`browser hash ${result.hash} does not match CLI ${expectedHash}`);
  if (!result.pack.includes('Matches loaded score')) throw new Error('sample pack panel did not confirm score match');
  if (result.sampleVoices.length !== 3) throw new Error(`expected 3 sample-backed voice labels, found ${result.sampleVoices.length}`);
  console.log(JSON.stringify({ chromiumArgs, expectedHash, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
