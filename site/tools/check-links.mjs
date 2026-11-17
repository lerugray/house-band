#!/usr/bin/env node
/**
 * Check local href/src targets in every .html under site/ (excluding vendor/ and
 * demos/node_modules/). Print external links; exit 1 if any local target is missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');

const ATTR_RE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function shouldSkipDir(absDir) {
  const rel = path.relative(SITE, absDir).split(path.sep).join('/');
  if (rel === 'vendor' || rel.startsWith('vendor/')) return true;
  if (rel === 'demos/node_modules' || rel.startsWith('demos/node_modules/')) return true;
  return false;
}

function walkHtml(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (shouldSkipDir(full)) continue;
      walkHtml(full, out);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

function isExternal(raw) {
  const u = raw.trim();
  if (!u) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return true;
  if (u.startsWith('//')) return true;
  return false;
}

function isFragmentOnly(raw) {
  const u = raw.trim();
  return u === '' || u.startsWith('#');
}

/** Strip query and hash; keep path for local resolution. */
function localPathPart(raw) {
  let u = raw.trim();
  const hash = u.indexOf('#');
  if (hash >= 0) u = u.slice(0, hash);
  const q = u.indexOf('?');
  if (q >= 0) u = u.slice(0, q);
  return u;
}

function resolveLocal(fromHtml, raw) {
  const part = localPathPart(raw);
  if (!part) return null;
  if (part.startsWith('/')) {
    return path.resolve(SITE, part.slice(1));
  }
  return path.resolve(path.dirname(fromHtml), part);
}

function underSite(abs) {
  const rel = path.relative(SITE, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function main() {
  const htmlFiles = walkHtml(SITE);
  const external = new Set();
  const broken = [];

  for (const html of htmlFiles) {
    const text = fs.readFileSync(html, 'utf8');
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(text)) !== null) {
      const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      if (!raw || isFragmentOnly(raw)) continue;
      if (isExternal(raw)) {
        external.add(raw);
        continue;
      }
      const target = resolveLocal(html, raw);
      if (!target) continue;
      if (!underSite(target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        const from = path.relative(SITE, html).split(path.sep).join('/');
        broken.push(`${from}: ${raw}`);
      }
    }
  }

  const extList = [...external].sort();
  if (extList.length) {
    console.log('external links:');
    for (const u of extList) console.log(`  ${u}`);
  } else {
    console.log('external links: (none)');
  }

  if (broken.length) {
    console.error('broken local links:');
    for (const line of broken) console.error(`  ${line}`);
    process.exit(1);
  }

  console.log(`check-links ok (${htmlFiles.length} html)`);
}

main();
