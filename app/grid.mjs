/**
 * Build and update the live pattern grid from a score spec.
 */

import { VOICES } from '../src/spec.mjs';

function stepSeconds(bpm) {
  return 60 / bpm / 4;
}

function barSeconds(bpm) {
  return 16 * stepSeconds(bpm);
}

export function buildGrid(container, spec) {
  container.innerHTML = '';
  const trackEls = new Map();
  const playhead = document.createElement('div');
  playhead.className = 'playhead';

  for (const [trackName, track] of Object.entries(spec.tracks)) {
    const bpm = track.bpm ?? spec.tempo;
    const len = track.len;
    const usedVoices = new Set(track.steps.map((s) => s.voice ?? s.v));
    if (usedVoices.size === 0) continue;

    const trackWrap = document.createElement('div');
    trackWrap.className = 'track-wrap';
    trackWrap.dataset.track = trackName;

    const title = document.createElement('div');
    title.className = 'track-title';
    title.textContent = `${trackName} · ${bpm}bpm · ${len} steps`;
    trackWrap.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'track-grid';
    grid.style.gridTemplateColumns = `6em repeat(${len}, 1fr)`;

    // Corner cell
    const corner = document.createElement('div');
    corner.className = 'cell label corner';
    grid.appendChild(corner);

    for (let i = 0; i < len; i++) {
      const idx = document.createElement('div');
      idx.className = 'cell index';
      idx.textContent = i + 1;
      grid.appendChild(idx);
    }

    const voiceRows = new Map();
    for (const voice of VOICES) {
      if (!usedVoices.has(voice)) continue;
      const rowLabel = document.createElement('div');
      rowLabel.className = 'cell label';
      rowLabel.textContent = voice;
      grid.appendChild(rowLabel);

      const cells = [];
      for (let i = 0; i < len; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell step';
        cell.dataset.step = String(i);
        grid.appendChild(cell);
        cells.push(cell);
      }
      voiceRows.set(voice, cells);
    }

    for (const event of track.steps) {
      const voice = event.voice ?? event.v;
      const cells = voiceRows.get(voice);
      if (!cells) continue;
      const indices = event.i !== undefined
        ? (Array.isArray(event.i) ? event.i : [event.i])
        : null;
      if (indices) {
        for (const i of indices) {
          if (cells[i]) cells[i].classList.add('hit');
        }
      } else if (event.every) {
        for (let i = 0; i < len; i += event.every) {
          if (cells[i]) cells[i].classList.add('hit');
        }
      }
    }

    const ph = playhead.cloneNode();
    trackWrap.appendChild(ph);
    trackWrap.appendChild(grid);
    container.appendChild(trackWrap);
    trackEls.set(trackName, { wrap: trackWrap, playhead: ph, len, bpm });
  }

  function update(positionSeconds) {
    // Find active section
    let t = 0;
    let active = null;
    for (const sec of spec.sections) {
      const track = spec.tracks[sec.track];
      const bpm = track.bpm ?? spec.tempo;
      const dur = sec.bars * barSeconds(bpm);
      if (positionSeconds >= t && positionSeconds < t + dur) {
        active = { trackName: sec.track, sectionStart: t, bpm, track };
        break;
      }
      t += dur;
    }

    for (const [name, { wrap, playhead: ph, len, bpm }] of trackEls) {
      if (active && active.trackName === name) {
        wrap.classList.add('active');
        const elapsed = positionSeconds - active.sectionStart;
        const step = Math.floor(elapsed / stepSeconds(bpm)) % len;
        const pct = ((step + 0.5) / len) * 100;
        ph.style.left = `calc(6em + ((100% - 6em) * ${step} / ${len}))`;
        ph.style.display = 'block';
      } else {
        wrap.classList.remove('active');
        ph.style.display = 'none';
      }
    }
  }

  return { update };
}
