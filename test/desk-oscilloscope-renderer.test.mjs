import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSkip } from './helpers/env.mjs';

import { chromium } from 'playwright';

import { createDeskHttpServer } from '../src/desk/http.mjs';
import { DeskService } from '../src/desk/service.mjs';
import { buildProfiles } from '../src/desk/config.mjs';
import { createProvider } from '../src/desk/providers/index.mjs';
import { SessionStore } from '../src/desk/session-store.mjs';

const kitVersion = {
  semver: '1.3.0',
  sha: '8ac798658c15d33ffbc6b1a4286bd155f78be4ffb825860d57958c7aca17680c',
};

const SWEEP = [2, 3, 4, 6, 8, 12];

function buildScore(sectionCount) {
  const voices = ['kick', 'snare', 'hat', 'bass', 'lead', 'pad', 'pluck'];
  const tracks = {};
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const name = `S${i + 1}`;
    const activeVoices = voices.slice(i % voices.length, (i % voices.length) + 3);
    const steps = [];
    for (let v = 0; v < activeVoices.length; v++) {
      const voice = activeVoices[v];
      if (['kick', 'snare', 'hat'].includes(voice)) {
        steps.push({ i: [0 + v, 8 + v], voice, opts: { vol: 0.2 + v * 0.05 } });
      } else {
        steps.push({ i: (i + v * 4) % 16, voice, note: `C${2 + v}`, dur: 0.3, opts: { vol: 0.1 + v * 0.02 } });
      }
    }
    tracks[name] = { bpm: 120, len: 16, vol: 0.8, steps };
    sections.push({ track: name, bars: 2 });
  }
  return {
    schemaVersion: '1.1.0',
    kitVersion,
    seed: 1,
    tempo: 120,
    sampleRate: 44100,
    register: { name: 'renderer-test', briefRef: 'docs/TEST.md' },
    tracks,
    sections,
  };
}

/** A score whose sections repeat, so pass/varied signalling has something to say. */
function repeatingScore(sectionCount) {
  const score = buildScore(2);
  score.sections = [];
  for (let i = 0; i < sectionCount; i++) {
    score.sections.push({ track: i % 2 === 0 ? 'S1' : 'S2', bars: 2 });
  }
  return score;
}

/** More voices than the strip's height can give a row each. */
function manyVoiceScore(voiceCount) {
  const steps = [];
  for (let v = 0; v < voiceCount; v++) {
    steps.push({ i: [v % 16, (v + 8) % 16], voice: `v${v + 1}`, opts: { vol: 0.4 } });
  }
  return {
    schemaVersion: '1.1.0',
    kitVersion,
    seed: 1,
    tempo: 120,
    sampleRate: 44100,
    register: { name: 'renderer-test', briefRef: 'docs/TEST.md' },
    tracks: { WIDE: { bpm: 120, len: 16, vol: 0.8, steps } },
    sections: [{ track: 'WIDE', bars: 2 }, { track: 'WIDE', bars: 2 }],
  };
}

describe('Desk oscilloscope renderer', { skip: await browserSkip() }, () => {
  let tmp;
  let server;
  let browser;
  let page;
  let port;
  let chipfx;

  before(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'hb-desk-osc-'));
    const env = Object.create(null);
    const profiles = buildProfiles(env);
    const deterministic = profiles.find((p) => p.id === 'deterministic');
    const provider = createProvider(deterministic, env);
    const sessionStore = new SessionStore({ root: resolve(tmp, 'sessions') });
    const service = await new DeskService({ env, profiles, provider, weiss: null, sessionStore }).init();

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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/desk/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#oscilloscope');

    chipfx = JSON.parse(await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'chipfx-audition-spec.json'),
      'utf8',
    ));
  });

  after(async () => {
    await browser?.close();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(tmp, { recursive: true, force: true });
  });

  /**
   * Render a score and return a structural report of what actually landed in
   * the DOM. These assertions are about PRESENCE and legibility: a report that
   * says a block drew nothing is a failure, not a pass. The previous suite
   * could go green on an empty block, because clipping suppressed the very
   * content its containment check was looking for.
   */
  async function report(score) {
    return page.evaluate(async (scoreJson) => {
      const { deriveOscilloscopeData, drawOscilloscope } = await import('/desk/oscilloscope.mjs');
      const container = document.getElementById('oscilloscope');
      container.innerHTML = '';
      const data = deriveOscilloscopeData(scoreJson);
      const controller = drawOscilloscope(container, data);
      const svg = container.querySelector('.oscilloscope-svg');
      svg.getBoundingClientRect(); // flush layout so getBBox is stable

      const out = {
        duration: data.duration,
        voiceOrder: data.voiceOrder,
        sectionCount: data.sections.length,
        railLabels: Array.from(svg.querySelectorAll('.osc-rail-label')).map((t) => ({
          shown: t.childNodes[0]?.data ?? '',
          full: t.getAttribute('data-full'),
          merged: t.classList.contains('merged'),
        })),
        // Any use of the deforming attributes at all is a failure.
        deformingAttrs: svg.querySelectorAll('[textLength], [lengthAdjust]').length,
        geometry: controller.geometry,
        seek: [],
        blocks: [],
      };

      controller.geometry.forEach((b, i) => {
        for (const [px, want] of [
          [b.x, b.start],
          [b.x + b.w / 2, b.start + b.duration / 2],
          [b.x + b.w, b.start + b.duration],
        ]) {
          out.seek.push({ i, err: Math.abs(controller.timeAtX(px) - want) });
        }
      });

      svg.querySelectorAll('.osc-block').forEach((block, bi) => {
        const bgRect = block.querySelector('.osc-block-bg');
        const width = Number(bgRect.getAttribute('width'));
        const height = Number(bgRect.getAttribute('height'));
        const section = data.sections[bi];

        const outOfBounds = [];
        for (const el of block.querySelectorAll('text, rect, polyline, line, circle')) {
          if (el.classList.contains('osc-block-bg')) continue;
          let box;
          try { box = el.getBBox(); } catch (_) { continue; }
          if (box.x < -0.5 || box.y < -0.5
            || box.x + box.width > width + 0.5 || box.y + box.height > height + 0.5) {
            outOfBounds.push({
              el: el.tagName + '.' + (el.getAttribute('class') || ''),
              box: { x: box.x, y: box.y, w: box.width, h: box.height },
              width,
              height,
            });
          }
        }

        const texts = Array.from(block.querySelectorAll('text')).map((t) => ({
          cls: t.getAttribute('class') || '',
          shown: t.childNodes[0]?.data ?? '',
          full: t.getAttribute('data-full'),
          fontSize: parseFloat(getComputedStyle(t).fontSize),
          ink: t.getBBox().width,
        }));

        const rows = Array.from(block.querySelectorAll('.osc-row')).map((rowG) => {
          const voices = (rowG.getAttribute('data-voices') || '').split(',').filter(Boolean);
          const active = rowG.getAttribute('data-active') === '1';
          const poly = rowG.querySelector('polyline');
          const kind = poly ? 'trace'
            : rowG.querySelector('.osc-heat') ? 'heat'
              : rowG.querySelector('.osc-row-flat') ? 'flat'
                : rowG.querySelector('.osc-row-idle') ? 'idle' : 'NOTHING';

          let trace = null;
          if (poly) {
            const xs = poly.getAttribute('points').split(' ').map((p) => Number(p.split(',')[0]));
            const start = xs[0];
            const end = xs[xs.length - 1];
            const traceW = end - start;
            const spikes = [...new Set(xs.slice(1, -1))].sort((a, b) => a - b);
            // Rendered spikes must sit exactly where the derived hits say.
            const derived = [...new Set(
              voices.flatMap((v) => (section.voiceHits[v] ?? []).map((h) => h.x)),
            )].sort((a, b) => a - b);
            const expected = derived.map((x) => start + x * traceW);
            let maxErr = Infinity;
            if (expected.length === spikes.length) {
              maxErr = 0;
              for (let k = 0; k < expected.length; k++) {
                maxErr = Math.max(maxErr, Math.abs(expected[k] - spikes[k]));
              }
            }
            trace = {
              traceW,
              spikeCount: spikes.length,
              derivedCount: derived.length,
              maxErr,
              minFrac: spikes.length ? (spikes[0] - start) / traceW : null,
              maxFrac: spikes.length ? (spikes[spikes.length - 1] - start) / traceW : null,
              points: poly.getAttribute('points'),
            };
          }
          return { voices, active, kind, trace };
        });

        out.blocks.push({
          index: bi,
          label: section.label,
          mode: block.getAttribute('data-mode'),
          width,
          height,
          outOfBounds,
          texts,
          rows,
          hasDensityBar: !!block.querySelector('.osc-density-bar'),
          passSignal: !!block.querySelector('.osc-pass-mark') || !!block.querySelector('.osc-pass-meta'),
        });
      });

      return out;
    }, score);
  }

  it('renders one row per voice, with content, in every block at 2/3/4/6/8/12 sections', async () => {
    for (const count of SWEEP) {
      const r = await report(buildScore(count));
      const voices = r.voiceOrder.length;
      assert.ok(voices > 0, `no voices derived at ${count} sections`);
      assert.equal(r.railLabels.length, voices, `rail lost voice labels at ${count} sections`);
      assert.equal(r.blocks.length, count);

      for (const block of r.blocks) {
        assert.equal(block.rows.length, voices,
          `block ${block.label} (${Math.round(block.width)}px, ${block.mode}) drew ${block.rows.length} of ${voices} voice rows`);
        for (const row of block.rows) {
          assert.notEqual(row.kind, 'NOTHING',
            `voice ${row.voices} silently vanished in ${block.label} (${Math.round(block.width)}px, ${block.mode})`);
          if (row.active) {
            assert.ok(['trace', 'heat', 'flat'].includes(row.kind),
              `active voice ${row.voices} drew "${row.kind}" in ${block.label} (${block.mode})`);
          }
        }
        assert.ok(block.hasDensityBar, `block ${block.label} lost its density bar`);
      }
    }
  });

  it('renders every voice row on the real chipfx score', async () => {
    const r = await report(chipfx);
    assert.equal(r.railLabels.length, r.voiceOrder.length);
    for (const block of r.blocks) {
      assert.equal(block.rows.length, r.voiceOrder.length,
        `chipfx block ${block.label} (${Math.round(block.width)}px) drew ${block.rows.length} of ${r.voiceOrder.length} rows`);
      assert.ok(block.rows.every((row) => row.kind !== 'NOTHING'),
        `chipfx block ${block.label} has an empty voice row`);
    }
  });

  it('never deforms a glyph and never renders one below legible size', async () => {
    for (const score of [...SWEEP.map(buildScore), chipfx]) {
      const r = await report(score);
      assert.equal(r.deformingAttrs, 0, 'textLength/lengthAdjust must never be used on a label');
      for (const block of r.blocks) {
        for (const text of block.texts) {
          assert.ok(text.fontSize >= 7,
            `"${text.shown}" rendered at ${text.fontSize}px in ${block.label}`);
          assert.ok(text.shown.length > 0, `empty text node in ${block.label}`);
          // A shown string is either the whole thing or a contiguous piece of
          // it (head truncation, or the trailing segment when a head
          // truncation would collide with another section's).
          assert.ok(text.full.includes(text.shown),
            `"${text.shown}" is not a truncation of "${text.full}" in ${block.label}`);
          assert.ok(text.ink <= block.width + 0.5,
            `"${text.shown}" is ${text.ink}px wide in a ${block.width}px block`);
        }
      }
    }
  });

  it('keeps every rendered element inside its block, with content actually present', async () => {
    for (const score of [...SWEEP.map(buildScore), chipfx]) {
      const r = await report(score);
      for (const block of r.blocks) {
        // Containment is only meaningful if there IS something to contain.
        const drawn = block.rows.filter((row) => row.kind !== 'NOTHING').length;
        assert.ok(drawn > 0, `block ${block.label} has nothing to contain`);
        assert.deepEqual(block.outOfBounds, [],
          `overflow in ${block.label} (${Math.round(block.width)}px, ${block.mode})`);
      }
    }
  });

  it('draws each trace at the derived hit positions, spanning the whole section', async () => {
    for (const score of [buildScore(4), buildScore(12), chipfx]) {
      const r = await report(score);
      for (const block of r.blocks) {
        for (const row of block.rows) {
          if (!row.trace) continue;
          assert.equal(row.trace.spikeCount, row.trace.derivedCount,
            `${block.label}/${row.voices}: drew ${row.trace.spikeCount} spikes for ${row.trace.derivedCount} derived hits`);
          assert.ok(row.trace.maxErr < 0.5,
            `${block.label}/${row.voices}: spike position off by ${row.trace.maxErr}px`);
          assert.ok(row.trace.traceW >= 16,
            `${block.label}: trace width fell to ${row.trace.traceW}px`);
        }
      }
    }
  });

  it('spans the chipfx exemplar across its whole block instead of the first bar', async () => {
    const r = await report(chipfx);
    const exemplar = r.blocks.find((b) => b.label === 'exemplar');
    assert.ok(exemplar, 'chipfx exemplar section not rendered');
    const traces = exemplar.rows.filter((row) => row.trace && row.trace.spikeCount > 0);
    assert.ok(traces.length > 0, 'exemplar drew no traces');
    // The bar-looping bug crammed all 12 bars of hits into the first 1/12 of
    // the block; every hit measured x <= 0.073.
    assert.ok(traces.some((row) => row.trace.maxFrac > 0.9),
      `exemplar hits stop at ${Math.max(...traces.map((t) => t.trace.maxFrac))} of the block`);
  });

  it('puts a two-bar section\'s hits in both halves of its block', async () => {
    const score = buildScore(2);
    score.tracks.S1 = { bpm: 120, len: 16, vol: 0.8, steps: [{ i: [0, 12], voice: 'kick', opts: { vol: 0.5 } }] };
    const r = await report(score);
    const row = r.blocks[0].rows.find((candidate) => candidate.voices.includes('kick'));
    assert.ok(row?.trace, 'kick row drew no trace');
    assert.ok(row.trace.minFrac < 0.5, 'no hits in the first half');
    assert.ok(row.trace.maxFrac >= 0.5, 'no hits in the second half');
  });

  it('renders different sections and different voices as different traces', async () => {
    const r = await report(buildScore(6));
    const shapes = [];
    for (const block of r.blocks) {
      for (const row of block.rows) {
        if (row.trace) shapes.push(`${block.index}:${row.voices}:${row.trace.points}`);
      }
    }
    assert.ok(shapes.length >= 12, `expected many traces, got ${shapes.length}`);

    // Same voice, different sections: the deterministic fixture staggers voices
    // per section, so the SET of active voices must differ between block 0 and
    // block 3 — a per-block rendering that ignored the section would not.
    const voicesIn = (i) => r.blocks[i].rows.filter((row) => row.active).map((row) => row.voices.join()).join(',');
    assert.notEqual(voicesIn(0), voicesIn(3), 'blocks 0 and 3 render identical voice activity');

    // Within one block, two different voices must not draw the identical curve.
    const withinBlock = r.blocks[0].rows.filter((row) => row.trace).map((row) => row.trace.points);
    assert.equal(new Set(withinBlock).size, withinBlock.length,
      'two voices in one block drew byte-identical traces');
  });

  it('maps x to musical seconds exactly at every block edge and midpoint', async () => {
    for (const count of [2, 4, 12]) {
      const r = await report(buildScore(count));
      const worst = Math.max(...r.seek.map((s) => s.err));
      // The old mapping ignored the 2px inter-block gaps and drifted; this
      // asserts the exact geometry, not a percentage of the strip.
      assert.ok(worst < 1e-6, `seek error of ${worst}s at ${count} sections`);
    }
    const chip = await report(chipfx);
    assert.ok(Math.max(...chip.seek.map((s) => s.err)) < 1e-6, 'chipfx seek drifted');
  });

  it('maps click and drag through the same geometry the blocks are drawn on', async () => {
    const score = buildScore(4);

    const result = await page.evaluate(async (scoreToRender) => {
      const { deriveOscilloscopeData, drawOscilloscope } = await import('/desk/oscilloscope.mjs');
      const container = document.getElementById('oscilloscope');
      container.innerHTML = '';
      const data = deriveOscilloscopeData(scoreToRender);
      const seeks = [];
      const controller = drawOscilloscope(container, data, { onSeek: (s) => seeks.push(s) });
      const svg = container.querySelector('.oscilloscope-svg');
      const rect = svg.getBoundingClientRect();

      // Third block's midpoint and last block's midpoint, in strip px.
      const a = controller.geometry[2];
      const b = controller.geometry[3];
      const ax = a.x + a.w / 2;
      const bx = b.x + b.w / 2;

      svg.dispatchEvent(new MouseEvent('mousedown', {
        clientX: rect.left + ax, clientY: rect.top + 10, bubbles: true, cancelable: true, view: window,
      }));
      window.dispatchEvent(new MouseEvent('mousemove', {
        clientX: rect.left + bx, clientY: rect.top + 10, bubbles: true,
      }));
      window.dispatchEvent(new MouseEvent('mouseup', {
        clientX: rect.left + bx, clientY: rect.top + 10, bubbles: true,
      }));

      return {
        seeks,
        wantA: a.start + a.duration / 2,
        wantB: b.start + b.duration / 2,
        // MouseEvent clientX is quantised to whole pixels, so the achievable
        // accuracy is bounded by what one pixel of this block is worth in time.
        tolerance: 2 * (a.duration / a.w),
        duration: data.duration,
      };
    }, score);

    assert.equal(result.seeks.length, 2, 'expected one seek for mousedown and one for mousemove');
    assert.ok(Math.abs(result.seeks[0] - result.wantA) <= result.tolerance,
      `click landed ${Math.abs(result.seeks[0] - result.wantA)}s from the block it was over`);
    assert.ok(Math.abs(result.seeks[1] - result.wantB) <= result.tolerance,
      `drag landed ${Math.abs(result.seeks[1] - result.wantB)}s from the block it ended over`);
  });

  it('falls back to an honest glyph-free form when blocks get too narrow for rhythm', async () => {
    // 24 sections in this strip drives blocks under the width that can carry a
    // readable trace. The rung must state what it can (which voices sound, how
    // busy) and stop — no deformed labels, no dropped rows, no fake rhythm.
    const r = await report(buildScore(24));
    const slivers = r.blocks.filter((b) => b.mode === 'sliver');
    assert.ok(slivers.length > 0, `expected sliver blocks, widths were ${r.blocks.map((b) => Math.round(b.width))}`);
    for (const block of slivers) {
      assert.deepEqual(block.texts, [], `sliver block ${block.label} still drew text`);
      assert.equal(block.rows.length, r.voiceOrder.length, 'sliver dropped voice rows');
      assert.ok(block.rows.every((row) => row.kind === 'heat'),
        `sliver rows drew ${[...new Set(block.rows.map((row) => row.kind))]}`);
      assert.ok(block.hasDensityBar, 'sliver dropped its density bar');
      assert.deepEqual(block.outOfBounds, []);
    }
  });

  it('does not render two different sections under the same truncated name', async () => {
    // chipfx has noise-kick / noise-snare / noise-hat, which a prefix
    // truncation renders as three identical "noi" labels.
    const r = await report(chipfx);
    const shown = new Map();
    for (const block of r.blocks) {
      const label = block.texts.find((t) => t.cls.startsWith('osc-label'));
      if (!label) continue;
      const owner = shown.get(label.shown);
      assert.ok(owner === undefined || owner === label.full,
        `"${label.shown}" is shown for both "${owner}" and "${label.full}"`);
      shown.set(label.shown, label.full);
    }
    const noiseLabels = r.blocks
      .map((b) => b.texts.find((t) => t.cls.startsWith('osc-label')))
      .filter((t) => t && t.full.startsWith('noise-'))
      .map((t) => t.shown);
    assert.equal(noiseLabels.length, 3, 'expected the three noise-* sections to carry labels');
    assert.equal(new Set(noiseLabels).size, 3, `noise sections render as ${noiseLabels.join('/')}`);
  });

  it('keeps the repeated-pass signal at every rung, not only the widest', async () => {
    for (const count of [3, 6, 12]) {
      const r = await report(repeatingScore(count));
      const repeats = r.blocks.filter((b) => b.index > 1);
      assert.ok(repeats.length > 0);
      for (const block of repeats) {
        assert.ok(block.passSignal,
          `repeated section ${block.label} lost its pass signal at ${Math.round(block.width)}px (${block.mode})`);
      }
    }
  });

  it('merges voice rows explicitly, never silently, when they cannot all fit', async () => {
    const voiceCount = 20;
    const r = await report(manyVoiceScore(voiceCount));
    assert.equal(r.voiceOrder.length, voiceCount);
    assert.ok(r.railLabels.length < voiceCount, 'expected merging at 20 voices');
    assert.ok(r.railLabels.some((l) => l.merged), 'merged rows are not marked as merged');
    assert.ok(r.railLabels.some((l) => l.full.includes('+')), 'merged rows are not labelled as merged');

    // Every voice must still be accounted for in some row — merging is a
    // relabelling, never a disappearance.
    const covered = new Set();
    for (const row of r.blocks[0].rows) row.voices.forEach((v) => covered.add(v));
    assert.equal(covered.size, voiceCount, 'merging dropped voices');
    assert.equal(r.blocks[0].rows.length, r.railLabels.length, 'rail and rows disagree on row count');
  });
});
