#!/usr/bin/env node
import { chromium } from 'playwright';
import { listen } from './serve.mjs';

const DESKTOP = [
  { w: 1280, h: 720 },
  { w: 1400, h: 730 },
  { w: 1600, h: 900 },
];

function accessibleName(el) {
  const aria = (el.getAttribute('aria-label') || '').trim();
  if (aria) return aria;
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map((id) => {
      const node = document.getElementById(id);
      return node ? (node.textContent || '').trim() : '';
    });
    const joined = parts.filter(Boolean).join(' ').trim();
    if (joined) return joined;
  }
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text) return text;
  const title = (el.getAttribute('title') || '').trim();
  if (title) return title;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const ph = (el.getAttribute('placeholder') || '').trim();
    if (ph) return ph;
  }
  return '';
}

async function checkSize(page, base, size) {
  const failures = [];
  const tag = `${size.w}x${size.h}`;
  await page.setViewportSize({ width: size.w, height: size.h });
  await page.goto(base, { waitUntil: 'networkidle' });

  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth);
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    const h1 = document.querySelector('#hero h1');
    const play = document.querySelector('#hero .play-btn, [data-slot="player-hero"] .play-btn');
    const h1Bottom = h1 ? h1.getBoundingClientRect().bottom : null;
    const playBottom = play ? play.getBoundingClientRect().bottom : null;

    const overflowText = [];
    for (const el of document.querySelectorAll('*')) {
      const ownText = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim(),
      );
      if (!ownText && el.childElementCount > 0) continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        const label = (el.tagName || '?').toLowerCase()
          + (el.id ? `#${el.id}` : '')
          + (el.className && typeof el.className === 'string' && el.className.trim()
            ? `.${el.className.trim().split(/\s+/).join('.')}`
            : '');
        overflowText.push(label);
      }
    }

    return { scrollWidth, innerWidth, innerHeight, h1Bottom, playBottom, overflowText };
  });

  if (layout.scrollWidth > layout.innerWidth) {
    failures.push(
      `${tag}: horizontal scroll (scrollWidth ${layout.scrollWidth} > innerWidth ${layout.innerWidth})`,
    );
  }
  if (layout.h1Bottom == null) {
    failures.push(`${tag}: hero h1 missing`);
  } else if (layout.h1Bottom > layout.innerHeight) {
    failures.push(
      `${tag}: hero h1 bottom ${layout.h1Bottom.toFixed(1)} > innerHeight ${layout.innerHeight}`,
    );
  }
  if (layout.playBottom == null) {
    failures.push(`${tag}: hero play button missing`);
  } else if (layout.playBottom > layout.innerHeight) {
    failures.push(
      `${tag}: hero play button bottom ${layout.playBottom.toFixed(1)} > innerHeight ${layout.innerHeight}`,
    );
  }
  for (const label of layout.overflowText) {
    failures.push(`${tag}: text overflow on ${label}`);
  }

  const urls = await page.evaluate(() => {
    const out = [];
    for (const img of document.querySelectorAll('img')) {
      if (img.getAttribute('src')) out.push(img.src);
    }
    for (const source of document.querySelectorAll('audio source')) {
      if (source.getAttribute('src')) out.push(source.src);
    }
    for (const script of document.querySelectorAll('script[src]')) {
      out.push(script.src);
    }
    return [...new Set(out)];
  });

  for (const assetUrl of urls) {
    try {
      const res = await page.request.get(assetUrl);
      if (res.status() !== 200) {
        failures.push(`${tag}: asset ${assetUrl} returned ${res.status()}`);
      }
    } catch (err) {
      failures.push(`${tag}: asset ${assetUrl} failed (${err.message})`);
    }
  }

  const unnamed = await page.evaluate((fnSource) => {
    // eslint-disable-next-line no-new-func
    const accessibleName = new Function(`return (${fnSource})`)();
    const bad = [];
    for (const el of document.querySelectorAll('button, a')) {
      if (!accessibleName(el)) {
        bad.push((el.outerHTML || '').slice(0, 120));
      }
    }
    return bad;
  }, accessibleName.toString());

  for (const html of unnamed) {
    failures.push(`${tag}: button/a missing accessible name: ${html}`);
  }

  return failures;
}

async function main() {
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

  const failures = [];
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
    const page = await browser.newPage();
    for (const size of DESKTOP) {
      failures.push(...await checkSize(page, base, size));
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  if (failures.length) {
    console.error('look-gate failed:');
    for (const line of failures) console.error(` - ${line}`);
    process.exit(1);
  }
  console.log('look-gate ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
