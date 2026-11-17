/**
 * Structure oscilloscope for Composer's Desk.
 *
 * Renders a full-width horizontal timeline of score sections. Each block
 * shows active voices, density, and derived chord-root movement. The strip
 * doubles as an audition scrubber: click or drag to seek the transport.
 *
 * Data derivation is pure and testable; DOM rendering stays in this module.
 */

import { barSeconds } from '../src/spec.mjs';

const PITCH_CLASS_RE = /^([A-G])(#|b)?/;
const ROOT_PRIORITY = ['bass', 'pad', 'lead', 'pluck', 'drone', 'bell', 'air'];
// Source of truth: src/spec.mjs barSeconds() defines each bar as 16 engine steps.
const STEPS_PER_BAR = 16;
const DEFAULT_VELOCITY = 0.5;

function parseNoteRoot(note) {
  if (typeof note !== 'string') return null;
  const m = note.trim().match(PITCH_CLASS_RE);
  if (!m) return null;
  const letter = m[1];
  const accidental = m[2] ?? '';
  return `${letter}${accidental}`;
}

function stepVoice(event) {
  return event.voice ?? event.v ?? null;
}

function stepVelocity(event) {
  const opts = event.opts ?? event.o ?? {};
  if (typeof opts.vol === 'number' && Number.isFinite(opts.vol)) {
    return Math.max(0, Math.min(1, opts.vol));
  }
  return DEFAULT_VELOCITY;
}

function expandHits(event, sectionSteps, trackLen, phase) {
  const voice = stepVoice(event);
  if (!voice) return [];
  const velocity = stepVelocity(event);
  const hits = [];
  const indices = event.i === undefined
    ? null
    : (Array.isArray(event.i) ? event.i : [event.i]);

  for (let rel = 0; rel < sectionSteps; rel += 1) {
    const patternIndex = (phase + rel) % trackLen;
    const sounds = indices
      ? indices.includes(patternIndex)
      : (Number.isFinite(event.every) && event.every > 0 && patternIndex % event.every === 0);
    if (sounds) hits.push({ x: rel / sectionSteps, v: velocity });
  }

  return hits;
}

/**
 * Derive a normalized oscilloscope data structure from a score spec.
 *
 * Returns an object with:
 *   sections: ordered array of section descriptors
 *   duration: total musical duration in seconds
 *   voiceOrder: stable list of voices that appear anywhere in the score
 */
export function deriveOscilloscopeData(score) {
  if (!score || !Array.isArray(score.sections) || score.sections.length === 0) {
    return { sections: [], duration: 0, voiceOrder: [] };
  }

  const globalVoiceOrder = [];
  const globalVoiceSet = new Set();

  // First pass: collect all voices in section order so rows align.
  for (const section of score.sections) {
    const track = score.tracks[section.track];
    if (!track) continue;
    for (const event of track.steps ?? []) {
      const voice = stepVoice(event);
      if (voice && !globalVoiceSet.has(voice)) {
        globalVoiceSet.add(voice);
        globalVoiceOrder.push(voice);
      }
    }
  }

  const sections = [];
  let cursor = 0;
  let previousRoot = null;
  let previousTrack = null;
  let trackPhase = 0;
  const passCounts = new Map();

  for (const section of score.sections) {
    const track = score.tracks[section.track];
    const bars = section.bars ?? 1;
    const bpm = track?.bpm ?? score.tempo ?? 120;
    const duration = bars * barSeconds(bpm);
    const steps = track?.steps ?? [];
    const trackLen = track?.len ?? 16;
    const sectionSteps = bars * STEPS_PER_BAR;
    if (section.track !== previousTrack) trackPhase = 0;

    const voicesHere = new Set();
    const notesByVoice = {};
    const voiceHits = {};
    let soundingHits = 0;
    for (const event of steps) {
      const voice = stepVoice(event);
      if (!voice) continue;
      voicesHere.add(voice);
      if (event.note !== undefined) {
        notesByVoice[voice] ??= [];
        notesByVoice[voice].push(event.note);
      }
      voiceHits[voice] ??= [];
      const hits = expandHits(event, sectionSteps, trackLen, trackPhase);
      voiceHits[voice].push(...hits);
      soundingHits += hits.length;
    }

    // Sort chronologically while retaining coincident events: each is a real
    // engine invocation and contributes independently to truthful density.
    for (const voice of Object.keys(voiceHits)) {
      voiceHits[voice].sort((a, b) => a.x - b.x);
    }

    // Derive chord root: prefer lowest/structural voice, then priority order.
    let root = null;
    for (const voice of ROOT_PRIORITY) {
      const notes = notesByVoice[voice];
      if (notes && notes.length > 0) {
        root = parseNoteRoot(notes[0]);
        if (root) break;
      }
    }
    // Fallback to any available pitched voice.
    if (!root) {
      for (const voice of globalVoiceOrder) {
        const notes = notesByVoice[voice];
        if (notes && notes.length > 0) {
          root = parseNoteRoot(notes[0]);
          if (root) break;
        }
      }
    }
    const displayRoot = root ?? '—';
    const rootChanged = previousRoot !== null && previousRoot !== displayRoot;
    previousRoot = displayRoot;

    const stepsPerBar = bars > 0 ? soundingHits / bars : 0;
    const density = Math.min(1, stepsPerBar / STEPS_PER_BAR);

    const rowActivity = globalVoiceOrder.map((voice) => ({
      voice,
      active: voicesHere.has(voice),
    }));

    // Repeated-pass bookkeeping: same section name may reappear.
    const pass = (passCounts.get(section.track) ?? 0) + 1;
    passCounts.set(section.track, pass);
    const previousPass = sections.filter((s) => s.track === section.track).pop();
    const varied = pass > 1 && previousPass
      && (previousPass.root !== displayRoot
        || previousPass.density !== density
        || JSON.stringify(previousPass.voices) !== JSON.stringify([...voicesHere].sort()));

    sections.push({
      label: section.track,
      track: section.track,
      pass,
      varied,
      bars,
      bpm,
      start: cursor,
      duration,
      steps: steps.length,
      voices: [...voicesHere].sort(),
      rowActivity,
      root: displayRoot,
      rootChanged,
      density,
      stepsPerBar,
      voiceHits,
    });

    trackPhase = (trackPhase + sectionSteps) % trackLen;
    previousTrack = section.track;
    cursor += duration;
  }

  return {
    sections,
    duration: cursor,
    voiceOrder: globalVoiceOrder,
  };
}

// ─── Layout model ──────────────────────────────────────────────────────────
//
// Voice names live in ONE rail on the left of the whole strip, not in a gutter
// repeated inside every block. A per-block gutter is what previously ate narrow
// blocks alive: at 53px the 48px gutter floor left no trace width at all and
// rows were dropped without any signal. With a single rail, a block's entire
// width is trace, so per-voice rows survive down to very narrow blocks.
//
// Block-width ladder — each rung states exactly what it draws. Text is fitted
// by measurement (truncated, or hidden when even one character will not fit);
// glyphs are NEVER deformed to fit, so lengthAdjust/textLength are not used.
//
//   full    >= 190px  label · meta (bars/bpm/density) · root · varied badge
//                     · per-voice traces · density bar
//   compact >=  96px  label · root · per-voice traces · density bar · pass mark
//   narrow  >=  26px  label (if it fits) · root (if it fits) · per-voice traces
//                     · density bar · pass mark. 26px is where a block still
//                     clears MIN_TRACE_W of drawable rhythm after padding.
//   sliver  <   26px  glyph-free: per-voice activity heat cells · density bar
//                     · pass mark. No text at all — nothing pretends to be
//                     rhythm at a width that cannot carry it.
const MODE_FULL_W = 190;
const MODE_COMPACT_W = 96;
const MODE_NARROW_W = 26;
// Blocks are floored to MIN_BLOCK_W and the REMAINING width is shared
// proportionally by duration (chipfx: 11 one-bar sections beside a 12-bar one
// went 28px vs 331px, data-faithful and unusable). Time stays exact because
// seek/playhead map through each block's real geometry, not a global ratio —
// the axis is piecewise-linear per section, and every section stays legible.
// If even the floor cannot fit, blocks fall back to pure proportion and the
// sliver rung takes over.
const MIN_BLOCK_W = 44;
const BLOCK_GAP = 2;
const MIN_ROW_H = 9;
const MAX_ROW_H = 18;
const MIN_TRACE_W = 16;
// A label cut below this many characters says nothing; hide it instead.
const MIN_LABEL_CHARS = 3;
const RAIL_MIN = 20;
const RAIL_MAX = 84;
const ROWS_TOP = 36;
const ROWS_TOP_TIGHT = 24;
const DENSITY_BAR_H = 3;

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

function textEl(x, y, content, cls, fontSize) {
  const el = svgEl('text', { x, y, class: cls });
  el.textContent = content;
  if (fontSize) el.style.fontSize = `${fontSize}px`;
  return el;
}

/**
 * Tooltip wrapper. The <title> goes on a wrapping <g>, never inside the <text>:
 * a title child of <text> sits in the text content model, so some engines paint
 * it and every engine folds it into textContent.
 */
function titled(el, tooltip, fullText = tooltip) {
  const g = svgEl('g', { class: 'osc-titled' });
  const title = svgEl('title');
  title.textContent = tooltip;
  g.appendChild(title);
  g.appendChild(el);
  // data-full is the untruncated string this text stands for, so a reader (or a
  // test) can tell truncation from corruption.
  if (el.tagName === 'text') el.setAttribute('data-full', fullText);
  return g;
}

function cssVar(container, name, fallback) {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(container).getPropertyValue(name).trim();
  return value || fallback;
}

export function blockMode(blockWidth) {
  if (blockWidth >= MODE_FULL_W) return 'full';
  if (blockWidth >= MODE_COMPACT_W) return 'compact';
  if (blockWidth >= MODE_NARROW_W) return 'narrow';
  return 'sliver';
}

/**
 * Group voices into rows that fit the available height. One row per voice
 * whenever they fit; otherwise adjacent voices merge into EXPLICITLY labelled
 * rows ("kick+2") so a merge is always visible, never a silent disappearance.
 */
export function buildVoiceRows(voiceOrder, maxRows) {
  const voices = voiceOrder ?? [];
  if (voices.length === 0) return [];
  if (maxRows >= voices.length) {
    return voices.map((voice) => ({ voices: [voice], label: voice, merged: false }));
  }
  const rows = [];
  const groups = Math.max(1, maxRows);
  let taken = 0;
  for (let r = 0; r < groups; r += 1) {
    const remainingRows = groups - r;
    const size = Math.ceil((voices.length - taken) / remainingRows);
    const slice = voices.slice(taken, taken + size);
    taken += size;
    rows.push({
      voices: slice,
      label: slice.length === 1 ? slice[0] : `${slice[0]}+${slice.length - 1}`,
      merged: slice.length > 1,
    });
  }
  return rows;
}

/**
 * Share `available` px across sections: a floor first, then the remainder by
 * duration.
 *
 * The floor is capped at FLOOR_SHARE of an equal share, so it can never eat
 * more than that fraction of the strip. Without the cap, 12 sections against a
 * 44px floor consume the whole width and every block comes out the same size —
 * proportion would be destroyed in the act of saving legibility. With it,
 * chipfx's 12-bar section still reads as several times its one-bar neighbours
 * while those neighbours stay wide enough to carry real traces. Sections of
 * equal duration are unaffected: the floor cancels out and the split is exact.
 */
const FLOOR_SHARE = 0.55;

export function allocateBlockWidths(sections, available, minBlockW = MIN_BLOCK_W) {
  const total = sections.reduce((sum, s) => sum + (s.duration || 0), 0) || 1;
  const usable = Math.max(1, available);
  const floorW = Math.min(minBlockW, (usable / Math.max(1, sections.length)) * FLOOR_SHARE);
  const remainder = Math.max(0, usable - floorW * sections.length);
  return sections.map((s) => Math.max(1, floorW + remainder * ((s.duration || 0) / total)));
}

function verticalLayout(height, rowCount) {
  const tight = height < 120;
  const rowsTop = tight ? ROWS_TOP_TIGHT : ROWS_TOP;
  const rowsBottom = height - (DENSITY_BAR_H + 9);
  const avail = Math.max(MIN_ROW_H, rowsBottom - rowsTop);
  const maxRows = Math.max(1, Math.floor(avail / MIN_ROW_H));
  const rows = Math.max(1, Math.min(rowCount || 1, maxRows));
  const rowHeight = Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, Math.floor(avail / rows)));
  // Few voices should not leave the rows pinned to the top of a tall strip.
  const rowsOrigin = rowsTop + Math.max(0, (avail - rows * rowHeight) / 2);
  return {
    tight,
    rowsTop,
    rowsOrigin,
    rowsBottom,
    maxRows,
    rowHeight,
    labelY: tight ? 13 : 15,
    metaY: 27,
    densityY: height - (DENSITY_BAR_H + 6),
  };
}

/** The trailing `-`/`_`/space-delimited segment, used to disambiguate labels. */
function labelTail(text) {
  const parts = String(text).split(/[-_\s]+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

function blockLayout(blockWidth, vertical) {
  const mode = blockMode(blockWidth);
  const padX = Math.max(2, Math.min(8, Math.round(blockWidth * 0.06)));
  const traceStart = padX;
  const traceWidth = Math.max(0, blockWidth - padX * 2);
  return {
    mode,
    padX,
    traceStart,
    traceWidth,
    // Narrow blocks swap the chunky display face for the mono one: the chunky
    // face is ~12px per glyph at 10px, so a 36px block would fit two letters.
    // Same size, narrower metrics, more of the section name survives.
    labelClass: mode === 'narrow' ? 'osc-label narrow' : 'osc-label',
    labelFontSize: mode === 'full' ? 14 : mode === 'compact' ? 12 : 9,
    metaFontSize: 9,
    rootFontSize: mode === 'full' ? 12 : 10,
    rowHeight: vertical.rowHeight,
  };
}

function rowCenterY(vertical, index) {
  return vertical.rowsOrigin + vertical.rowHeight * index + vertical.rowHeight / 2;
}

function renderTrace(g, hits, y, layout, accent) {
  const { traceStart, traceWidth, rowHeight } = layout;
  if (traceWidth < MIN_TRACE_W) return null;

  // Flat baseline with a vertical tick through it at each hit. The previous
  // shape ran the line from one spike's top straight to the next spike's
  // bottom, which reads as a slow zigzag rather than as rhythm — and because
  // amplitude was velocity alone, real scores (vol 0.05–0.25) drew 1px
  // wiggles. Velocity now scales between a floor that is always visible and
  // the row's half height: a quiet hit looks quieter, never invisible.
  const maxAmp = Math.max(2.5, rowHeight / 2 - 2);
  const minAmp = Math.min(maxAmp, Math.max(1.5, rowHeight * 0.22));
  const points = [`${traceStart},${y}`];
  for (const hit of hits) {
    const x = traceStart + hit.x * traceWidth;
    const amp = minAmp + Math.max(0, Math.min(1, hit.v)) * (maxAmp - minAmp);
    points.push(`${x},${y}`);
    points.push(`${x},${y - amp}`);
    points.push(`${x},${y + amp}`);
    points.push(`${x},${y}`);
  }
  points.push(`${traceStart + traceWidth},${y}`);

  const polyline = svgEl('polyline', {
    class: 'osc-trace',
    points: points.join(' '),
    fill: 'none',
    stroke: accent,
    'stroke-width': Math.max(1, Math.min(2, traceWidth / 80)),
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  g.appendChild(polyline);
  return polyline;
}

function renderIdleRow(g, y, layout, accent) {
  const { traceStart, traceWidth } = layout;
  if (traceWidth <= 0) return null;
  const line = svgEl('line', {
    class: 'osc-row-idle',
    x1: traceStart,
    y1: y,
    x2: traceStart + traceWidth,
    y2: y,
    stroke: accent,
    'stroke-width': 1,
    'stroke-opacity': 0.22,
    'stroke-dasharray': '2 3',
  });
  g.appendChild(line);
  return line;
}

/**
 * Glyph-free row for the sliver rung: an activity heat cell whose fill states
 * how busy the voice is, outlined-only when the voice is silent. It claims to
 * show presence and density, and nothing else.
 */
function renderHeatCell(g, y, layout, accent, activity, active) {
  const height = Math.max(3, layout.rowHeight - 3);
  const rect = svgEl('rect', {
    class: active ? 'osc-heat active' : 'osc-heat',
    x: layout.traceStart,
    y: y - height / 2,
    width: Math.max(1, layout.traceWidth),
    height,
    rx: 1,
    fill: active ? accent : 'none',
    'fill-opacity': active ? 0.18 + activity * 0.72 : 0,
    stroke: accent,
    'stroke-width': 1,
    'stroke-opacity': active ? 0.55 : 0.18,
  });
  g.appendChild(rect);
  return rect;
}

/**
 * Render the oscilloscope into `container` and return a controller.
 *
 * Options:
 *   onSeek(seconds) — called when the user clicks or drags the strip.
 */
export function drawOscilloscope(container, data, options = {}) {
  container.innerHTML = '';

  const { onSeek } = options;
  const accent = cssVar(container, '--accent-2', '#4fd2c2');
  const signal = cssVar(container, '--signal', '#7ab0f4');
  const bg = cssVar(container, '--bg', '#0a0b0d');

  if (data.sections.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'oscilloscope-empty';
    empty.textContent = 'Structure oscilloscope · waiting for score';
    container.appendChild(empty);
    return { updatePlayhead() {}, data, destroy() {} };
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'oscilloscope-strip-wrap';
  container.appendChild(wrapper);

  const svg = svgEl('svg', {
    class: 'oscilloscope-svg',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': 'Structure timeline scrubber',
  });
  wrapper.appendChild(svg);

  const defs = svgEl('defs');
  svg.appendChild(defs);

  // One hidden node, reused for every text measurement. Everything that renders
  // is measured first, so no glyph is ever stretched or squeezed to fit.
  const measureGroup = svgEl('g', { 'aria-hidden': 'true', style: 'visibility: hidden;' });
  const measureNode = svgEl('text', { x: 0, y: 0 });
  measureGroup.appendChild(measureNode);
  svg.appendChild(measureGroup);

  /**
   * Measure both the advance width AND the ink box. They differ: side bearings
   * push painted glyphs outside the advance, which is how an end-anchored root
   * mark can sit a few px past a block's right edge while every advance-based
   * sum says it fits. Placement below corrects by the overhang.
   */
  function measureText(content, cls, fontSize) {
    measureNode.setAttribute('class', cls);
    // Inline style, not the presentation attribute: a stylesheet rule on the
    // class (osc-root-text sets text-anchor: middle) outranks the attribute and
    // would silently shift every measurement and placement by half a string.
    measureNode.style.textAnchor = 'start';
    measureNode.style.fontSize = fontSize ? `${fontSize}px` : '';
    measureNode.textContent = content;
    try {
      const advance = measureNode.getComputedTextLength();
      const box = measureNode.getBBox();
      if (Number.isFinite(advance) && Number.isFinite(box.width) && box.width > 0) {
        return {
          advance,
          ink: box.width,
          left: box.x,
          rightOver: Math.max(0, box.x + box.width - advance),
        };
      }
    } catch (_) { /* fall through to the estimate */ }
    const est = content.length * (fontSize || 10) * 0.62;
    return { advance: est, ink: est, left: 0, rightOver: 0 };
  }

  function textWidth(content, cls, fontSize) {
    return measureText(content, cls, fontSize).ink;
  }

  /** Start-anchored x that keeps the painted ink at or right of `left`. */
  function startX(left, m) {
    return left - Math.min(0, m.left);
  }

  /** End-anchored x that keeps the painted ink at or left of `right`. */
  function endX(right, m) {
    return right - m.rightOver;
  }

  // Fit by truncation, never by deformation. Returns null when the text cannot
  // be shortened to something still worth reading — the caller then renders
  // nothing rather than a smear or a single orphan character.
  function fitLabel(content, cls, fontSize, maxWidth, minChars = 1) {
    if (!content || maxWidth <= 0) return null;
    if (textWidth(content, cls, fontSize) <= maxWidth) return content;
    const floor = Math.min(minChars, content.length);
    for (let n = content.length - 1; n >= floor; n -= 1) {
      const candidate = content.slice(0, n);
      if (textWidth(candidate, cls, fontSize) <= maxWidth) return candidate;
    }
    return null;
  }

  const railGroup = svgEl('g', { class: 'osc-rail' });
  const rootGroup = svgEl('g', { class: 'osc-root' });
  const blockGroup = svgEl('g', { class: 'osc-blocks' });
  const playheadGroup = svgEl('g', { class: 'osc-playhead', style: 'display: none;' });
  svg.appendChild(rootGroup);
  svg.appendChild(blockGroup);
  svg.appendChild(railGroup);
  svg.appendChild(playheadGroup);

  // Playhead line.
  const playheadLine = svgEl('line', {
    class: 'osc-playhead-line',
    y1: 0,
    y2: '100%',
    stroke: signal,
    'stroke-width': 2,
  });
  const playheadNode = svgEl('circle', {
    class: 'osc-playhead-node',
    r: 5,
    fill: bg,
    stroke: signal,
    'stroke-width': 2,
  });
  playheadGroup.appendChild(playheadLine);
  playheadGroup.appendChild(playheadNode);

  let width = 0;
  let height = 0;
  let railWidth = RAIL_MIN;
  let totalDuration = data.duration || 1;
  /** Per-block geometry: the single source of truth for x ↔ time. */
  let geometry = [];

  function renderRail(rows, vertical) {
    railGroup.innerHTML = '';
    if (rows.length === 0) return;
    const maxText = railWidth - 8;
    const fontSize = Math.max(8, Math.min(11, vertical.rowHeight - 4));
    rows.forEach((row, index) => {
      const fitted = fitLabel(row.label, 'osc-rail-label', fontSize, maxText, MIN_LABEL_CHARS);
      if (!fitted) return;
      const m = measureText(fitted, 'osc-rail-label', fontSize);
      const el = textEl(endX(railWidth - 6, m), rowCenterY(vertical, index) + fontSize * 0.35, fitted,
        row.merged ? 'osc-rail-label merged' : 'osc-rail-label', fontSize);
      el.style.textAnchor = 'end';
      railGroup.appendChild(titled(el,
        row.merged ? `${row.voices.join(' + ')} (merged row)` : row.label, row.label));
    });
  }

  /**
   * Fit every section's label at once, so truncation can be checked for
   * COLLISIONS. chipfx has noise-kick / noise-snare / noise-hat: prefix
   * truncation renders all three as "noi", three different sections wearing
   * one name. Where a truncation would collide, the trailing segment is tried
   * instead ("kick", "snare", "hat"). Only genuinely distinct sections are
   * disambiguated — a section that legitimately repeats keeps its own name.
   */
  function fitSectionLabels(sections, widths, layouts) {
    const full = sections.map((s) => (s.pass > 1 ? `${s.label} ${s.pass}` : s.label));
    const room = sections.map((s, i) => {
      const layout = layouts[i];
      const inner = Math.max(0, Math.max(1, widths[i]) - layout.padX * 2);
      const rootReserve = Math.min(
        textWidth(s.root, 'osc-root-text', layout.rootFontSize) + 6,
        inner * 0.5,
      );
      return { inner, rootReserve, layout };
    });

    const fitted = sections.map((s, i) => {
      if (layouts[i].mode === 'sliver') return null;
      const { inner, rootReserve, layout } = room[i];
      const cls = layout.labelClass;
      const size = layout.labelFontSize;
      return fitLabel(full[i], cls, size, inner - rootReserve, full[i].length)
        ?? fitLabel(full[i], cls, size, inner, full[i].length)
        ?? fitLabel(full[i], cls, size, inner, MIN_LABEL_CHARS);
    });

    const groups = new Map();
    fitted.forEach((text, i) => {
      if (!text || text === full[i]) return; // untruncated labels cannot mislead
      if (!groups.has(text)) groups.set(text, []);
      groups.get(text).push(i);
    });

    for (const [text, indices] of groups) {
      if (new Set(indices.map((i) => full[i])).size < 2) continue; // same section, repeated
      const taken = new Set(fitted.filter((t, i) => t && !indices.includes(i)));
      for (const i of indices) {
        const tail = labelTail(full[i]);
        if (!tail) continue;
        const { inner, layout } = room[i];
        const alt = fitLabel(tail, layout.labelClass, layout.labelFontSize, inner, MIN_LABEL_CHARS);
        if (alt && alt !== text && !taken.has(alt)) {
          fitted[i] = alt;
          taken.add(alt);
        }
      }
    }

    return fitted.map((text, i) => ({ text, full: full[i] }));
  }

  function renderBlocks() {
    const rect = wrapper.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(120, rect.height);

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    blockGroup.innerHTML = '';
    rootGroup.innerHTML = '';
    defs.innerHTML = '';

    totalDuration = data.duration || 1;

    // Vertical layout is strip-global so voice rows line up across every block
    // and a single rail can label them.
    const probe = verticalLayout(height, (data.voiceOrder ?? []).length || 1);
    const rows = buildVoiceRows(data.voiceOrder ?? [], probe.maxRows);
    const vertical = verticalLayout(height, rows.length || 1);

    const railFont = Math.max(8, Math.min(11, vertical.rowHeight - 4));
    const longest = rows.reduce((w, row) => Math.max(w, textWidth(row.label, 'osc-rail-label', railFont)), 0);
    railWidth = rows.length === 0
      ? 0
      : Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(width * 0.24), Math.round(longest) + 12));

    renderRail(rows, vertical);

    const gaps = BLOCK_GAP * Math.max(0, data.sections.length - 1);
    const available = Math.max(1, width - railWidth - gaps);
    const widths = allocateBlockWidths(data.sections, available);
    const layouts = widths.map((w) => blockLayout(Math.max(1, w), vertical));
    const displayLabels = fitSectionLabels(data.sections, widths, layouts);

    geometry = [];
    let currentX = railWidth;

    data.sections.forEach((section, index) => {
      const blockWidth = Math.max(1, widths[index]);
      const x = currentX;
      currentX += blockWidth + BLOCK_GAP;
      geometry.push({ start: section.start, duration: section.duration, x, w: blockWidth });

      const clipId = `osc-clip-${index}-${Math.random().toString(36).slice(2)}`;
      const clip = svgEl('clipPath', { id: clipId });
      clip.appendChild(svgEl('rect', { x: 0, y: 0, width: blockWidth, height, rx: 6, ry: 6 }));
      defs.appendChild(clip);

      const layout = layouts[index];

      const g = svgEl('g', {
        class: `osc-block mode-${layout.mode}`,
        transform: `translate(${x}, 0)`,
        'data-start': section.start,
        'data-duration': section.duration,
        'data-mode': layout.mode,
        'data-width': blockWidth,
        'clip-path': `url(#${clipId})`,
      });
      // Appended before its children so text measurement sees real layout.
      blockGroup.appendChild(g);

      // Background with density shading.
      const densityOpacity = 0.08 + section.density * 0.22;
      g.appendChild(svgEl('rect', {
        class: 'osc-block-bg',
        width: blockWidth,
        height,
        rx: 6,
        ry: 6,
        fill: `rgba(79, 210, 194, ${densityOpacity})`,
        stroke: accent,
        'stroke-width': section.rootChanged ? 2 : 1,
        'stroke-opacity': section.rootChanged ? 0.9 : 0.35,
      }));

      // A root change is a full-height tick on the block's leading edge: it
      // survives every rung, including glyph-free slivers, and collides with
      // nothing.
      if (section.rootChanged) {
        g.appendChild(svgEl('rect', {
          class: 'osc-boundary',
          x: 0,
          y: 4,
          width: 2,
          height: Math.max(4, height - 8),
          fill: signal,
          'fill-opacity': 0.85,
        }));
      }

      const inner = Math.max(0, blockWidth - layout.padX * 2);

      // Label / root priority on the header line, in this order:
      //   1. whole label + root, when both fit;
      //   2. whole label alone, when the root's reserve is what breaks it;
      //   3. label truncated to at least MIN_LABEL_CHARS, root only if room is
      //      left over;
      //   4. nothing, when even MIN_LABEL_CHARS will not fit legibly.
      // Identity outranks harmony, and a label is never cut to one orphan
      // character just to keep a root mark company.
      let labelRight = 0;
      const { text: labelFit, full: labelText } = displayLabels[index];
      if (labelFit) {
        const cls = layout.labelClass;
        const m = measureText(labelFit, cls, layout.labelFontSize);
        const x = startX(layout.padX, m);
        const labelEl = textEl(x, vertical.labelY, labelFit, cls, layout.labelFontSize);
        labelEl.style.textAnchor = 'start';
        g.appendChild(titled(labelEl, labelText));
        labelRight = x + m.left + m.ink;
      }

      // Root mark takes the right end of the header line whenever the space
      // surviving the label holds it — at every rung, not only the wide ones.
      if (layout.mode !== 'sliver') {
        const rootRoom = blockWidth - layout.padX - (labelRight > 0 ? labelRight + 5 : layout.padX);
        const rootFit = fitLabel(section.root, 'osc-root-text', layout.rootFontSize, rootRoom);
        if (rootFit) {
          const m = measureText(rootFit, 'osc-root-text', layout.rootFontSize);
          const rootEl = textEl(endX(blockWidth - layout.padX, m), vertical.labelY, rootFit,
            'osc-root-text', layout.rootFontSize);
          rootEl.style.textAnchor = 'end';
          g.appendChild(titled(rootEl, `root ${section.root}`, section.root));
        }
      }

      // Repeated-pass signal. `full` spells it out on the meta line; every
      // narrower rung keeps a marker (filled = varied, hollow = repeat) so the
      // fact never simply vanishes with the badge.
      const fullMeta = layout.mode === 'full' && !vertical.tight;
      let metaReserve = 0;
      if (section.pass > 1) {
        const tip = `pass ${section.pass} · ${section.varied ? 'varied' : 'repeat'}`;
        if (fullMeta) {
          const badge = section.varied ? 'varied' : 'repeat';
          const badgeFit = fitLabel(badge, 'osc-pass-meta', layout.metaFontSize, inner * 0.5);
          if (badgeFit) {
            const bm = measureText(badgeFit, 'osc-pass-meta', layout.metaFontSize);
            const passText = textEl(endX(blockWidth - layout.padX, bm), vertical.metaY, badgeFit,
              section.varied ? 'osc-pass-meta varied' : 'osc-pass-meta', layout.metaFontSize);
            passText.style.textAnchor = 'end';
            g.appendChild(titled(passText, tip, badge));
            metaReserve = bm.ink + 8;
          }
        } else {
          const mark = svgEl('rect', {
            class: section.varied ? 'osc-pass-mark varied' : 'osc-pass-mark',
            x: Math.max(1, blockWidth - layout.padX - 4),
            y: Math.max(2, vertical.densityY - 8),
            width: 4,
            height: 4,
            fill: section.varied ? accent : 'none',
            stroke: accent,
            'stroke-width': 1,
            'stroke-opacity': 0.8,
          });
          g.appendChild(titled(mark, tip));
        }
      }

      if (fullMeta) {
        // Drop whole facts, never half a word: "2 bars · 240b" reads as
        // corruption, "2 bars · 240bpm" reads as a shorter sentence.
        const parts = [
          `${section.bars} bar${section.bars === 1 ? '' : 's'}`,
          `${Math.round(section.bpm)}bpm`,
          `${Math.round(section.stepsPerBar)}/bar`,
        ];
        const meta = parts.join(' · ');
        let metaFit = null;
        for (let n = parts.length; n >= 1 && !metaFit; n -= 1) {
          const candidate = parts.slice(0, n).join(' · ');
          metaFit = fitLabel(candidate, 'osc-meta', layout.metaFontSize,
            inner - metaReserve, candidate.length);
        }
        if (metaFit) {
          const metaEl = textEl(startX(layout.padX, measureText(metaFit, 'osc-meta', layout.metaFontSize)),
            vertical.metaY, metaFit, 'osc-meta', layout.metaFontSize);
          metaEl.style.textAnchor = 'start';
          g.appendChild(titled(metaEl, meta));
        }
      }

      // Voice rows — one per rail row, at every rung. Traces where the width
      // can carry rhythm, glyph-free heat cells where it cannot.
      rows.forEach((row, rowIndex) => {
        const y = rowCenterY(vertical, rowIndex);
        if (y + vertical.rowHeight / 2 > vertical.rowsBottom + 1) return;
        const active = row.voices.some((voice) => section.voices.includes(voice));
        const hits = row.voices
          .flatMap((voice) => section.voiceHits[voice] ?? [])
          .sort((a, b) => a.x - b.x);

        const rowG = svgEl('g', {
          class: active ? 'osc-row active' : 'osc-row',
          'data-row': String(rowIndex),
          'data-voices': row.voices.join(','),
          'data-active': active ? '1' : '0',
        });
        g.appendChild(rowG);

        // The rung decides, so the mode a block advertises and what it draws
        // can never disagree; MIN_TRACE_W stays as the guard that justifies
        // where the sliver threshold sits.
        if (layout.mode === 'sliver' || layout.traceWidth < MIN_TRACE_W) {
          const activity = Math.min(1, (hits.length / Math.max(1, section.bars)) / STEPS_PER_BAR);
          renderHeatCell(rowG, y, layout, accent, activity, active);
          return;
        }
        if (active && hits.length > 0) {
          renderTrace(rowG, hits, y, layout, accent);
        } else if (active) {
          // Active but rhythmically empty (sustained/one-shot material).
          rowG.appendChild(svgEl('line', {
            class: 'osc-row-flat',
            x1: layout.traceStart,
            y1: y,
            x2: layout.traceStart + layout.traceWidth,
            y2: y,
            stroke: accent,
            'stroke-width': 1,
            'stroke-opacity': 0.6,
          }));
        } else {
          renderIdleRow(rowG, y, layout, accent);
        }
      });

      // Density bar along the bottom: a proportion of the block's own width, so
      // it costs no horizontal room and reads identically at every rung.
      const trackW = Math.max(1, inner);
      g.appendChild(svgEl('rect', {
        class: 'osc-density-track',
        x: layout.padX,
        y: vertical.densityY,
        width: trackW,
        height: DENSITY_BAR_H,
        rx: 1,
        fill: accent,
        'fill-opacity': 0.15,
      }));
      g.appendChild(svgEl('rect', {
        class: 'osc-density-bar',
        x: layout.padX,
        y: vertical.densityY,
        width: Math.max(1, trackW * section.density),
        height: DENSITY_BAR_H,
        rx: 1,
        fill: accent,
        'fill-opacity': 0.85,
      }));
    });
  }

  renderBlocks();

  // Custom pixel faces change every measurement; re-fit once they land.
  if (typeof document !== 'undefined' && document.fonts?.ready?.then) {
    document.fonts.ready.then(() => renderBlocks()).catch(() => {});
  }

  /** x (px, strip coordinates) → musical seconds, exact per block. */
  function timeAtX(px) {
    if (geometry.length === 0) return 0;
    if (px <= geometry[0].x) return geometry[0].start;
    for (const block of geometry) {
      if (px < block.x) return block.start; // inter-block gap: snap forward
      if (px <= block.x + block.w) {
        return block.start + ((px - block.x) / block.w) * block.duration;
      }
    }
    const last = geometry[geometry.length - 1];
    return last.start + last.duration;
  }

  /** musical seconds → x (px), the exact inverse of timeAtX. */
  function xAtTime(seconds) {
    if (geometry.length === 0) return 0;
    for (const block of geometry) {
      if (seconds < block.start) return block.x;
      if (seconds <= block.start + block.duration) {
        const ratio = block.duration > 0 ? (seconds - block.start) / block.duration : 0;
        return block.x + ratio * block.w;
      }
    }
    const last = geometry[geometry.length - 1];
    return last.x + last.w;
  }

  function seekFromEvent(evt) {
    if (!onSeek || totalDuration <= 0) return;
    const rect = svg.getBoundingClientRect();
    const seconds = timeAtX(evt.clientX - rect.left);
    onSeek(Math.max(0, Math.min(totalDuration, seconds)));
  }

  let dragging = false;
  function onMouseMove(evt) {
    if (!dragging) return;
    seekFromEvent(evt);
  }
  function onMouseUp() {
    dragging = false;
  }

  function onMouseDown(evt) {
    dragging = true;
    seekFromEvent(evt);
  }

  function onTouchStart(evt) {
    dragging = true;
    if (evt.touches[0]) seekFromEvent(evt.touches[0]);
    evt.preventDefault();
  }
  function onTouchMove(evt) {
    if (!dragging) return;
    if (evt.touches[0]) seekFromEvent(evt.touches[0]);
    evt.preventDefault();
  }
  function onTouchEnd() {
    dragging = false;
  }

  svg.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  svg.addEventListener('touchstart', onTouchStart, { passive: false });
  svg.addEventListener('touchmove', onTouchMove, { passive: false });
  svg.addEventListener('touchend', onTouchEnd);

  const resizeObserver = new ResizeObserver(() => renderBlocks());
  resizeObserver.observe(wrapper);

  function updatePlayhead(positionSeconds, duration = data.duration) {
    if (duration <= 0 || width <= 0) {
      playheadGroup.style.display = 'none';
      return;
    }
    const x = xAtTime(Math.max(0, Math.min(duration, positionSeconds)));
    playheadLine.setAttribute('x1', x);
    playheadLine.setAttribute('x2', x);
    playheadNode.setAttribute('cx', x);
    playheadNode.setAttribute('cy', 12);
    playheadGroup.style.display = 'block';
  }

  return {
    data,
    updatePlayhead,
    timeAtX,
    xAtTime,
    get geometry() { return geometry.map((block) => ({ ...block })); },
    get railWidth() { return railWidth; },
    destroy() {
      resizeObserver.disconnect();
      svg.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      svg.removeEventListener('touchstart', onTouchStart);
      svg.removeEventListener('touchmove', onTouchMove);
      svg.removeEventListener('touchend', onTouchEnd);
    },
  };
}
