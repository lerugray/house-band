/**
 * Landing-page claims stay true (Adam's feedback, 2026-11-17): the "How it works" snippet is a valid score,
 * the LLM excerpt is the real model output, and each Darkness row's kit, Samples From Mars tag and score size
 * match the score files and the kit registry.
 */
import { readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateSpec } from '../src/spec.mjs';
import { KITS } from '../src/presets/kits/index.mjs';

const html = readFileSync('site/index.html', 'utf8');
const mainJs = readFileSync('site/main.js', 'utf8');

function unescapeHtml(text) {
  return text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function preCode(id) {
  const match = html.match(new RegExp(`<pre[^>]*(?:id="${id}"|class="[^"]*${id}[^"]*")[^>]*><code>([\\s\\S]*?)</code></pre>`));
  assert.ok(match, `site/index.html has a <pre> for ${id}`);
  return unescapeHtml(match[1]);
}

describe('landing page', () => {
  it('"How it works" shows a complete score that validates as-is', () => {
    const score = JSON.parse(preCode('how-snippet'));
    assert.doesNotThrow(() => validateSpec(score));
    assert.equal(typeof score.tracks, 'object');
    assert.equal(Array.isArray(score.tracks), false, 'tracks are keyed by name, not an array');
  });

  it('the LLM excerpt is lines 42-61 of the model output, verbatim', () => {
    const lines = readFileSync('site/llm/after-closing.model-output.json', 'utf8').split('\n');
    const shown = preCode('llm-excerpt').split('\n');
    assert.equal(shown.length, 20);
    shown.forEach((line, k) => {
      const n = 42 + k;
      assert.equal(line, `${String(n).padStart(3)}  ${lines[n - 1]}`);
    });
  });

  it('the model output is a valid score', () => {
    const score = JSON.parse(readFileSync('site/llm/after-closing.model-output.json', 'utf8'));
    assert.doesNotThrow(() => validateSpec(score));
  });

  it('Darkness rows carry the kit and byte size of their score file', () => {
    const rows = [...mainJs.matchAll(/\{ id: '([^']+)', title: [^}]*kit: '([^']+)', bytes: (\d+) \}/g)];
    assert.equal(rows.length, 10);
    for (const [, id, kit, bytes] of rows) {
      const path = `site/scores/darkness/${id}.json`;
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).kit, kit, `${id} kit`);
      assert.equal(statSync(path).size, Number(bytes), `${id} bytes`);
    }
  });

  it('SAMPLED_KITS names exactly the sample-backed kits, each with a built-in swap', () => {
    const block = mainJs.match(/export const SAMPLED_KITS = \{([\s\S]*?)\};/)[1];
    const pairs = [...block.matchAll(/'?([a-z0-9-]+)'?: '([a-z0-9-]+)'/g)].map((m) => [m[1], m[2]]);
    const sampled = Object.entries(KITS).filter(([, kit]) => kit.kind === 'sample').map(([id]) => id).sort();
    assert.deepEqual(pairs.map(([id]) => id).sort(), sampled);
    for (const [, swap] of pairs) assert.equal(KITS[swap]?.kind, 'synth', `${swap} is a built-in kit`);
  });
});
