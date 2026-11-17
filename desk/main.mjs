/**
 * Composer's Desk UI controller.
 *
 * Drives the BLACKBOX PATCHBAY interface. Reuses Audition Room modules for
 * transport, pattern grid, and client-side rendering.
 */

import { createTransport, STATE } from '/app/transport.mjs';
import { buildGrid } from '/app/grid.mjs';
import { renderScoreToWav } from '/app/render.mjs';
import { validateSpec } from '/src/spec.mjs';
import { deriveOscilloscopeData, drawOscilloscope } from './oscilloscope.mjs';

const $ = (id) => document.getElementById(id);
const API_PREFIX = '/desk/api';

function formatTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

async function api(path, options = {}) {
  const url = `${API_PREFIX}${path}`;
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body.error?.message || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

class DeskUi {
  constructor() {
    this.session = null;
    this.capabilities = null;
    this.health = null;
    this.takes = new Map();
    this.currentTake = { A: null, B: null, active: 'A' };
    this.transport = null;
    this.audioCtx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    this.voiceState = {};
    this.gridController = null;
    this.renderTimer = null;
    this.busy = false;
    this.packs = [];
    this.packAssetsMap = new Map();
    this.oscilloscope = null;
  }

  async init() {
    [this.health, this.capabilities] = await Promise.all([
      api('/health'),
      api('/capabilities'),
    ]);

    this.updateStatusStrip();
    this.populateProfiles();
    this.wireEvents();

    const params = new URLSearchParams(location.search);
    const restoredId = params.get('session');
    if (restoredId) {
      this.session = await api(`/sessions/${restoredId}`);
    } else {
      this.session = await api('/sessions', {
        method: 'POST',
        body: JSON.stringify({ prompt: '', weissEnabled: true }),
      });
    }

    this.reflectSession();
    this.buildCustodyRail();
    this.drawPatchbayCables();
    this.loadPacks();
    window.addEventListener('resize', () => this.drawPatchbayCables());
    this.setFooter('Ready');
  }

  updateStatusStrip() {
    const h = this.health || {};
    this.setDot('renderer-dot', h.custodyRendererAvailable ? 'ok' : 'error');
    $('renderer-status').textContent = h.custodyRendererAvailable ? 'renderer ready' : 'renderer unavailable';

    const pHealth = h.providerHealth || 'missing configuration';
    this.setDot('provider-dot', pHealth === 'configured' ? 'ok' : pHealth === 'unreachable/limited' ? 'warn' : 'error');
    const providerText = h.provider ? `${h.provider.displayName} · ${h.provider.model} · ${pHealth}` : 'no provider';
    $('provider-status').textContent = providerText;
    $('provider-status').title = providerText;

    this.setDot('weiss-dot', h.weissAvailable ? 'ok' : 'warn');
    $('weiss-status').textContent = h.weissAvailable ? 'Weiss ready' : 'Weiss unavailable';
  }

  setDot(id, state) {
    const el = $(id);
    el.className = 'status-dot ' + state;
  }

  populateProfiles() {
    const sel = $('profile-select');
    sel.innerHTML = '';
    const configuredIds = new Set(this.capabilities.profiles.filter((p) => p.configured).map((p) => p.id));
    const sorted = [...this.capabilities.profiles].sort((a, b) => {
      if (a.id === this.capabilities.defaultProfileId) return -1;
      if (b.id === this.capabilities.defaultProfileId) return 1;
      if (a.configured && !b.configured) return -1;
      if (!a.configured && b.configured) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
    for (const profile of sorted) {
      const opt = document.createElement('option');
      opt.value = profile.id;
      const label = `${profile.displayName} · ${profile.model} (${profile.configured ? 'configured' : 'missing'})`;
      opt.textContent = label;
      opt.title = label;
      sel.appendChild(opt);
    }
    const sessionProfile = this.session?.profileId;
    const fallbackProfile = configuredIds.has(this.capabilities.defaultProfileId)
      ? this.capabilities.defaultProfileId
      : (sorted.find((p) => p.configured)?.id || this.capabilities.defaultProfileId);
    sel.value = sessionProfile || fallbackProfile || '';
  }

  wireEvents() {
    $('profile-select').addEventListener('change', async () => {
      this.session = await api(`/sessions/${this.session.sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ profileId: $('profile-select').value }),
      });
      this.refreshHealth();
    });

    $('profile-test').addEventListener('click', async () => {
      this.setFooter('Testing profile…', false, true);
      await this.refreshHealth();
      const h = this.health;
      const status = h.providerHealth || 'unknown';
      this.setFooter(`Profile test: ${status}`, status !== 'configured');
    });

    $('weiss-toggle').addEventListener('change', async () => {
      this.session = await api(`/sessions/${this.session.sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ weissEnabled: $('weiss-toggle').checked }),
      });
    });

    $('brief-btn').addEventListener('click', () => this.makeBrief());
    $('cancel-brief-btn').addEventListener('click', () => {
      this.showPromptGroup();
      this.setFooter('Brief cancelled');
    });
    $('compose-btn').addEventListener('click', () => this.composeScore());
    $('edit-brief-btn').addEventListener('click', () => this.showBriefEdit());
    $('revise-btn').addEventListener('click', () => this.reviseScore());

    const briefInput = $('brief-input');
    briefInput.addEventListener('input', () => this.refreshBriefScrollCue());
    briefInput.addEventListener('scroll', () => this.refreshBriefScrollCue());
    window.addEventListener('resize', () => this.refreshBriefScrollCue());

    $('play-btn').addEventListener('click', () => {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      this.transport.togglePlay();
    });
    $('stop-btn').addEventListener('click', () => this.transport.stop());
    $('loop-check').addEventListener('change', () => this.transport.setLoop($('loop-check').checked));
    $('ab-a').addEventListener('click', () => this.selectAB('A'));
    $('ab-b').addEventListener('click', () => this.selectAB('B'));
    $('reroll-btn').addEventListener('click', () => this.rerollSeed());

    $('export-accept').addEventListener('click', () => this.exportBundle({ stems: false, rpp: false }));
    $('export-handoff').addEventListener('click', () => this.exportBundle({ stems: true, rpp: true }));

    const showLog = $('show-log');
    if (this.health?.logFile) {
      showLog.addEventListener('click', () => {
        window.open('file://' + encodeURI(this.health.logFile), '_blank');
      });
    } else {
      showLog.hidden = true;
    }

    $('pack-refresh').addEventListener('click', () => this.loadPacks());
  }

  async refreshHealth() {
    this.health = await api('/health');
    this.updateStatusStrip();
  }

  reflectSession() {
    if (!this.session) return;
    $('prompt-input').value = this.session.prompt || '';
    $('weiss-toggle').checked = this.session.weissEnabled;
    if (this.session.brief) {
      $('brief-input').value = this.session.brief.text;
      this.showBriefGroup();
    }
    this.updateTakeHistory();
    if (this.session.activeTakeId) {
      const take = this.session.takes.find((t) => t.takeId === this.session.activeTakeId);
      if (take) this.activateTake(take);
    }
    // Sync custody rail to recovered workflow stage.
    const stage = this.session.workflow?.currentStage;
    if (stage) {
      const order = ['prompt', 'brief', 'score', 'render', 'audition', 'export'];
      const idx = order.indexOf(stage);
      if (idx >= 0) {
        for (let i = 0; i <= idx; i++) {
          this.updateCustodyRail(order[i], i === idx ? 'locked' : 'locked');
        }
      }
    }
  }

  setFooter(text, isError = false, isRendering = false) {
    const el = $('footer-status');
    el.textContent = text;
    el.className = isError ? 'error' : isRendering ? 'rendering' : '';
  }

  refreshBriefScrollCue() {
    const el = $('brief-input');
    if (!el) return;
    const overflows = el.scrollHeight > el.clientHeight;
    el.classList.toggle('can-scroll', overflows);
  }

  showPromptGroup() {
    $('prompt-group').hidden = false;
    $('brief-group').hidden = true;
  }

  showBriefGroup() {
    $('prompt-group').hidden = true;
    $('brief-group').hidden = false;
    this.drawPatchbayCables();
    this.refreshBriefScrollCue();
  }

  showBriefEdit() {
    $('prompt-group').hidden = true;
    $('brief-group').hidden = false;
    this.drawPatchbayCables();
    this.refreshBriefScrollCue();
  }

  async makeBrief() {
    if (this.busy) return;
    const prompt = $('prompt-input').value.trim();
    if (!prompt) return;
    this.busy = true;
    this.setFooter('Writing direction brief…', false, true);
    this.updateCustodyRail('brief', 'active');
    try {
      this.session.prompt = prompt;
      const result = await api(`/sessions/${this.session.sessionId}/brief`, {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      });
      $('brief-input').value = result.brief;
      this.session.brief = { text: result.brief, source: result.source };
      this.showBriefGroup();
      this.setFooter(`Brief ready · ${result.source}`);
      this.updateCustodyRail('brief', 'locked');
    } catch (err) {
      this.setFooter(err.message, true);
      this.updateCustodyRail('brief', 'failed');
    } finally {
      this.busy = false;
    }
  }

  async composeScore() {
    if (this.busy) return;
    const brief = $('brief-input').value.trim();
    if (!brief) return;
    this.busy = true;
    this.setFooter('Composing score…', false, true);
    this.updateCustodyRail('score', 'active');
    try {
      const result = await api(`/sessions/${this.session.sessionId}/compose`, {
        method: 'POST',
        body: JSON.stringify({ brief, renderStems: true, renderRpp: true }),
      });
      this.session = result.session;
      this.updateCustodyRail('score', 'locked');
      this.updateCustodyRail('render', 'active');
      await this.activateTake(result.take);
      this.updateCustodyRail('render', 'locked');
      this.updateCustodyRail('audition', 'locked');
      this.setFooter('Score rendered and ready to audition');
      $('revision-group').hidden = false;
    } catch (err) {
      this.setFooter(err.message, true);
      this.updateCustodyRail('score', 'failed');
    } finally {
      this.busy = false;
    }
  }

  async reviseScore() {
    if (this.busy) return;
    const direction = $('revision-input').value.trim();
    if (!direction || !this.session.activeTakeId) return;
    this.busy = true;
    this.setFooter('Revising score…', false, true);
    this.updateCustodyRail('brief', 'active');
    try {
      const result = await api(`/sessions/${this.session.sessionId}/revise`, {
        method: 'POST',
        body: JSON.stringify({ takeId: this.session.activeTakeId, direction, renderStems: true, renderRpp: true }),
      });
      this.session = result.session;
      this.updateCustodyRail('brief', 'locked');
      this.updateCustodyRail('score', 'locked');
      this.updateCustodyRail('render', 'active');
      await this.activateTake(result.take);
      this.updateCustodyRail('render', 'locked');
      this.updateCustodyRail('audition', 'locked');
      this.setFooter('Revision rendered');
      $('revision-input').value = '';
    } catch (err) {
      this.setFooter(err.message, true);
      this.updateCustodyRail('score', 'failed');
    } finally {
      this.busy = false;
    }
  }

  async activateTake(take) {
    this.takes.set(take.takeId, take);
    this.drawOscilloscope(take.score);
    this.drawPatternWall(take.score);
    await this.renderTake(take);
    this.updateTakeHistory();
    this.refreshBriefScrollCue();
  }

  async renderTake(take) {
    this.setFooter('Rendering in browser…', false, true);
    const artifact = validateSpec(structuredClone(take.score));

    let wav;
    let manifest;
    let mixHash;
    if (take.score.samplePack) {
      const url = `${API_PREFIX}/sessions/${this.session.sessionId}/takes/${take.takeId}/mix.wav`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Server mix fetch failed: ${res.status}`);
      wav = await res.arrayBuffer();
      mixHash = res.headers.get('x-mix-sha256') ?? take.mixSha256 ?? '';
    } else {
      const rendered = await renderScoreToWav(artifact, {});
      wav = rendered.wav;
      manifest = rendered.manifest;
      mixHash = manifest.output.sha256;
    }

    const buffer = await this.audioCtx.decodeAudioData(wav.slice(0));

    // Push current to B, new to A.
    this.currentTake.B = this.currentTake.A;
    this.currentTake.A = { takeId: take.takeId, buffer, wav, manifest: manifest || null, score: take.score };
    this.currentTake.active = 'A';

    if (!this.transport) {
      this.transport = createTransport(this.audioCtx, {
        onStateChange: (state) => {
          $('play-btn').textContent = state === STATE.PLAYING ? 'Pause' : 'Play';
        },
        onPosition: (pos, dur) => {
          $('position').textContent = `${formatTime(pos)} / ${formatTime(dur)}`;
          if (this.gridController) this.gridController.update(pos);
          if (this.oscilloscope) this.oscilloscope.updatePlayhead(pos, dur);
        },
      });
    }
    this.transport.setBuffer(buffer);
    this.drawWaveform(wav);
    $('render-hash').textContent = mixHash.slice(0, 16) + '…';
    $('hash-stamp').textContent = `sha256 ${mixHash}`;
    $('seed-input').value = take.score.seed;
    $('freeze-panel').hidden = false;
    $('freeze-panel').classList.add('render-frozen');
    this.updateAB();
    this.buildVoiceMix(take.score);
    this.drawPatchbayCables();
    this.setFooter('Ready');
  }

  updateAB() {
    const hasA = Boolean(this.currentTake.A);
    const hasB = Boolean(this.currentTake.B);
    $('ab-a').disabled = !hasA;
    $('ab-b').disabled = !hasB;
    $('play-btn').disabled = !hasA;
    $('stop-btn').disabled = !hasA;
    $('export-accept').disabled = !hasA;
    $('export-handoff').disabled = !hasA;
    $('ab-a').classList.toggle('active', this.currentTake.active === 'A');
    $('ab-b').classList.toggle('active', this.currentTake.active === 'B');
  }

  selectAB(side) {
    if (!this.currentTake[side]) return;
    this.currentTake.active = side;
    this.transport.setBuffer(this.currentTake[side].buffer);
    this.drawOscilloscope(this.currentTake[side].score);
    this.drawPatternWall(this.currentTake[side].score);
    this.buildVoiceMix(this.currentTake[side].score);
    $('seed-input').value = this.currentTake[side].score.seed;
    this.updateAB();
  }

  async rerollSeed() {
    if (this.busy || !this.session.activeTakeId) return;
    this.busy = true;
    this.setFooter('Re-rolling seed…', false, true);
    try {
      const result = await api(`/sessions/${this.session.sessionId}/reroll-seed`, {
        method: 'POST',
        body: JSON.stringify({ takeId: this.session.activeTakeId }),
      });
      this.session = result.session;
      this.updateCustodyRail('score', 'locked');
      this.updateCustodyRail('render', 'active');
      await this.activateTake(result.take);
      this.updateCustodyRail('render', 'locked');
      this.updateCustodyRail('audition', 'locked');
      this.setFooter('Seed re-rolled');
    } catch (err) {
      this.setFooter(err.message, true);
    } finally {
      this.busy = false;
    }
  }

  buildVoiceMix(score) {
    const used = new Set();
    for (const track of Object.values(score.tracks)) {
      for (const event of track.steps) used.add(event.voice ?? event.v);
    }
    const container = $('voice-mix');
    container.innerHTML = '';
    const voices = [...used].sort();
    for (const voice of voices) {
      if (!this.voiceState[voice]) this.voiceState[voice] = { mute: false, solo: false, gain: 1 };
      const row = document.createElement('div');
      row.className = 'voice-row';
      row.innerHTML = `
        <label>${voice}</label>
        <button data-action="mute" title="Mute">M</button>
        <button data-action="solo" title="Solo">S</button>
        <input type="range" min="0" max="2" step="0.01" value="${this.voiceState[voice].gain}">
      `;
      const [muteBtn, soloBtn, gainInput] = [
        row.querySelector('[data-action="mute"]'),
        row.querySelector('[data-action="solo"]'),
        row.querySelector('input[type="range"]'),
      ];
      muteBtn.addEventListener('click', () => {
        this.voiceState[voice].mute = !this.voiceState[voice].mute;
        this.refreshVoiceMixUI();
        this.queueReRender();
      });
      soloBtn.addEventListener('click', () => {
        this.voiceState[voice].solo = !this.voiceState[voice].solo;
        this.refreshVoiceMixUI();
        this.queueReRender();
      });
      gainInput.addEventListener('input', () => {
        this.voiceState[voice].gain = parseFloat(gainInput.value);
        this.queueReRender();
      });
      container.appendChild(row);
    }
    this.refreshVoiceMixUI();
  }

  refreshVoiceMixUI() {
    const rows = $('voice-mix').querySelectorAll('.voice-row');
    rows.forEach((row) => {
      const voice = row.querySelector('label').textContent;
      const state = this.voiceState[voice];
      row.querySelector('[data-action="mute"]').classList.toggle('on', state.mute);
      row.querySelector('[data-action="solo"]').classList.toggle('on', state.solo);
    });
  }

  queueReRender() {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.reRenderCurrent(), 80);
  }

  async reRenderCurrent() {
    const active = this.currentTake[this.currentTake.active];
    if (!active || active.score.samplePack) return;
    const score = this.applyVoiceMix(active.score);
    try {
      const artifact = validateSpec(structuredClone(score));
      const { wav, manifest } = await renderScoreToWav(artifact, {});
      const buffer = await this.audioCtx.decodeAudioData(wav.slice(0));
      active.buffer = buffer;
      active.wav = wav;
      active.manifest = manifest;
      this.transport.setBuffer(buffer);
      this.drawWaveform(wav);
      $('render-hash').textContent = manifest.output.sha256.slice(0, 16) + '…';
    } catch (err) {
      this.setFooter(`Audition render failed: ${err.message}`, true);
    }
  }

  applyVoiceMix(score) {
    const anySolo = Object.values(this.voiceState).some((s) => s.solo);
    const draft = structuredClone(score);
    for (const track of Object.values(draft.tracks)) {
      track.steps = track.steps.filter((event) => {
        const voice = event.voice ?? event.v;
        const state = this.voiceState[voice];
        if (!state) return true;
        if (state.mute) return false;
        if (anySolo && !state.solo) return false;
        const opts = event.opts ?? event.o ?? {};
        opts.vol = (opts.vol ?? 1) * state.gain;
        event.opts = opts;
        return true;
      });
    }
    return draft;
  }

  drawPatternWall(score) {
    const container = $('wall-grid');
    container.innerHTML = '';
    this.gridController = buildGrid(container, score);
  }

  drawOscilloscope(score) {
    const container = $('oscilloscope');
    if (this.oscilloscope) {
      this.oscilloscope.destroy();
      this.oscilloscope = null;
    }
    const data = deriveOscilloscopeData(score);
    this.oscilloscope = drawOscilloscope(container, data, {
      onSeek: (seconds) => {
        if (this.transport) this.transport.seek(seconds);
      },
    });
  }

  drawWaveform(wav) {
    const canvas = $('waveform');
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.fillStyle = '#0a0b0d';
    ctx.fillRect(0, 0, width, height);

    const arrayBuffer = wav instanceof ArrayBuffer ? wav : wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    const view = new DataView(arrayBuffer);
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    const dataOffset = 44;
    const totalSamples = (wav.byteLength - dataOffset) / (bitsPerSample / 8) / channels;
    const step = Math.max(1, Math.floor(totalSamples / width));

    ctx.strokeStyle = '#7ab0f4';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < width; x++) {
      const startSample = x * step;
      let sum = 0;
      let count = 0;
      for (let s = 0; s < step && startSample + s < totalSamples; s++) {
        const offset = dataOffset + (startSample + s) * channels * (bitsPerSample / 8);
        const sample = bitsPerSample === 16 ? view.getInt16(offset, true) / 32768 : 0;
        sum += Math.abs(sample);
        count++;
      }
      const amp = count > 0 ? sum / count : 0;
      const y = height / 2 - amp * (height / 2) * 0.95;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  buildCustodyRail() {
    const container = $('custody-rail');
    container.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('viewBox', '0 0 600 56');
    svg.id = 'custody-rail-svg';

    const order = ['prompt', 'brief', 'score', 'render', 'audition', 'export'];
    const labels = ['Prompt', 'Brief', 'Score', 'Render', 'Audition', 'Export'];
    const xPositions = [40, 140, 240, 340, 440, 540];
    const cy = 28;

    // Segments first so nodes draw on top.
    for (let i = 0; i < order.length - 1; i++) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', xPositions[i]);
      line.setAttribute('y1', cy);
      line.setAttribute('x2', xPositions[i + 1]);
      line.setAttribute('y2', cy);
      line.setAttribute('class', `rail-segment future`);
      line.dataset.segment = i;
      svg.appendChild(line);
    }

    for (let i = 0; i < order.length; i++) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'stage-node future');
      g.dataset.stage = order[i];
      g.dataset.x = xPositions[i];
      g.dataset.y = cy;

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', xPositions[i]);
      circle.setAttribute('cy', cy);
      circle.setAttribute('r', 10);
      g.appendChild(circle);

      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      icon.setAttribute('x', xPositions[i]);
      icon.setAttribute('y', cy);
      icon.setAttribute('class', 'stage-icon');
      icon.textContent = '○';
      g.appendChild(icon);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', xPositions[i]);
      label.setAttribute('y', 50);
      label.setAttribute('class', 'stage-label');
      label.textContent = labels[i];
      g.appendChild(label);

      svg.appendChild(g);
    }

    container.appendChild(svg);
  }

  updateCustodyRail(stage, state) {
    const order = ['prompt', 'brief', 'score', 'render', 'audition', 'export'];
    const index = order.indexOf(stage);
    const svg = document.getElementById('custody-rail-svg');
    if (!svg) return;

    const nodes = svg.querySelectorAll('.stage-node');
    const segments = svg.querySelectorAll('.rail-segment');

    nodes.forEach((node, i) => {
      node.classList.remove('future', 'locked', 'active', 'failed');
      const icon = node.querySelector('.stage-icon');
      if (i < index) {
        node.classList.add('locked');
        icon.textContent = '🔒';
      } else if (i === index) {
        node.classList.add(state || 'active');
        icon.textContent = state === 'locked' ? '🔒' : state === 'failed' ? '✕' : '●';
      } else {
        node.classList.add('future');
        icon.textContent = '○';
      }
    });

    let failedAt = -1;
    if (state === 'failed') failedAt = index;

    segments.forEach((seg, i) => {
      seg.classList.remove('future', 'lit', 'failed');
      if (failedAt >= 0 && i === failedAt - 1) {
        seg.classList.add('failed');
      } else if (i < index && (failedAt < 0 || i < failedAt - 1)) {
        seg.classList.add('lit');
      } else {
        seg.classList.add('future');
      }
    });

    if (state === 'locked' && index > 0) {
      this.pulseRailSegment(index - 1);
    }
  }

  pulseRailSegment(segmentIndex) {
    const svg = document.getElementById('custody-rail-svg');
    if (!svg) return;
    const segment = svg.querySelector(`.rail-segment[data-segment="${segmentIndex}"]`);
    if (!segment) return;
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', 5);
    dot.setAttribute('class', 'pulse-dot run');
    const animate = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
    animate.setAttribute('dur', '0.7s');
    animate.setAttribute('fill', 'freeze');
    animate.setAttribute('path', `M${segment.getAttribute('x1')},${segment.getAttribute('y1')} L${segment.getAttribute('x2')},${segment.getAttribute('y2')}`);
    dot.appendChild(animate);
    svg.appendChild(dot);
    setTimeout(() => dot.remove(), 800);
  }

  updateTakeHistory() {
    const list = $('take-list');
    list.innerHTML = '';
    for (const take of this.session.takes) {
      const chip = document.createElement('button');
      chip.className = 'take-chip' + (take.takeId === this.session.activeTakeId ? ' active' : '');
      chip.textContent = `${take.takeId.slice(0, 8)} · ${take.score.register?.name?.slice(0, 20) || 'take'}`;
      chip.addEventListener('click', async () => {
        await this.activateTake(take);
        this.session = await api(`/sessions/${this.session.sessionId}/active-take`, {
          method: 'POST',
          body: JSON.stringify({ takeId: take.takeId }),
        });
        this.updateTakeHistory();
      });
      list.appendChild(chip);
    }
  }

  drawPatchbayCables() {
    const app = document.getElementById('app');
    const svg = document.getElementById('patchbay-cables');
    if (!app || !svg) return;
    const appRect = app.getBoundingClientRect();
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${Math.round(appRect.width)} ${Math.round(appRect.height)}`);

    const left = document.querySelector('.left-rail');
    const center = document.querySelector('.center-rail');
    const right = document.querySelector('.right-rail');
    if (!left || !center || !right) return;

    const l = left.getBoundingClientRect();
    const c = center.getBoundingClientRect();
    const r = right.getBoundingClientRect();

    function rel(rect) {
      return {
        x: rect.left - appRect.left,
        y: rect.top - appRect.top,
        r: rect.right - appRect.left,
        b: rect.bottom - appRect.top,
        cx: rect.left - appRect.left + rect.width / 2,
        cy: rect.top - appRect.top + rect.height / 2,
      };
    }

    const L = rel(l);
    const C = rel(c);
    const R = rel(r);

    function jack(x, y) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
      circle.setAttribute('r', 5);
      circle.setAttribute('class', 'patch-jack');
      return circle;
    }

    function cable(x1, y1, x2, y2, lit) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const midX = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
      path.setAttribute('d', d);
      path.setAttribute('class', 'patch-cable' + (lit ? ' lit' : ''));
      return path;
    }

    const yIn = L.cy - 60;
    const yOut = L.cy + 40;
    const cIn = C.cy - 80;
    const cOut = C.cy + 80;
    const rIn = R.cy - 60;
    const rOut = R.cy + 40;

    svg.appendChild(cable(L.r, yIn, C.x, cIn, this.session?.brief));
    svg.appendChild(cable(C.r, cOut, R.x, rIn, this.session?.activeTakeId));
    svg.appendChild(jack(L.r, yIn));
    svg.appendChild(jack(C.x, cIn));
    svg.appendChild(jack(C.r, cOut));
    svg.appendChild(jack(R.x, rIn));
  }

  async loadPacks() {
    try {
      const { packs } = await api('/packs');
      this.packs = packs || [];
      this.packAssetsMap.clear();
      for (const pack of this.packs) {
        for (const asset of pack.assets) {
          this.packAssetsMap.set(`${pack.packId}|${asset.id}`, { pack, asset });
        }
      }
      this.renderPackList();
    } catch (err) {
      this.setFooter(`Pack list failed: ${err.message}`, true);
    }
  }

  renderPackList() {
    const list = $('pack-list');
    list.innerHTML = '';
    if (this.packs.length === 0) {
      list.innerHTML = '<div class="oscilloscope-empty">No canonical packs installed.</div>';
      return;
    }
    for (const pack of this.packs) {
      const item = document.createElement('div');
      item.className = 'pack-item';
      const toggle = document.createElement('button');
      toggle.className = 'pack-toggle';
      toggle.type = 'button';
      toggle.textContent = `${pack.displayName} · ${pack.assets.length} sample${pack.assets.length === 1 ? '' : 's'}`;
      toggle.title = `${pack.packId} · ${pack.manifestSha256.slice(0, 16)}…`;
      const assetsDiv = document.createElement('div');
      assetsDiv.className = 'pack-assets';
      assetsDiv.hidden = true;

      toggle.addEventListener('click', () => {
        assetsDiv.hidden = !assetsDiv.hidden;
      });

      for (const asset of pack.assets) {
        const row = document.createElement('div');
        row.className = 'pack-asset';
        row.innerHTML = `
          <span class="asset-voice">${asset.allowedCanonicalLanes[0]}</span>
          <span class="asset-name" title="${asset.id}">${asset.id}</span>
        `;
        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.textContent = '▶';
        previewBtn.title = 'Preview';
        previewBtn.addEventListener('click', () => this.previewAsset(pack, asset));
        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.textContent = 'Use';
        useBtn.title = `Use ${asset.id} as ${asset.allowedCanonicalLanes[0]}`;
        useBtn.addEventListener('click', () => this.applySuggestion(pack, asset));
        row.appendChild(previewBtn);
        row.appendChild(useBtn);
        assetsDiv.appendChild(row);
      }

      item.appendChild(toggle);
      item.appendChild(assetsDiv);
      list.appendChild(item);
    }
  }

  async previewAsset(pack, asset) {
    try {
      const url = `${API_PREFIX}/packs/${encodeURIComponent(pack.packId)}/assets/${encodeURIComponent(asset.id)}/wav`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
      const buffer = await this.audioCtx.decodeAudioData(arrayBuffer);
      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      const gain = this.audioCtx.createGain();
      gain.gain.value = 0.7;
      source.connect(gain);
      gain.connect(this.audioCtx.destination);
      source.start();
      this.setFooter(`Previewed ${asset.id}`);
    } catch (err) {
      this.setFooter(`Preview failed: ${err.message}`, true);
    }
  }

  async applySuggestion(pack, asset) {
    if (this.busy || !this.session.activeTakeId) {
      this.setFooter('Compose a score first, then apply a sample.', true);
      return;
    }
    this.busy = true;
    this.setFooter(`Applying ${asset.id}…`, false, true);
    try {
      const result = await api(`/sessions/${this.session.sessionId}/apply-suggestion`, {
        method: 'POST',
        body: JSON.stringify({
          takeId: this.session.activeTakeId,
          packId: pack.packId,
          manifestSha256: pack.manifestSha256,
          contentSha256: pack.contentSha256,
          assetId: asset.id,
          voice: asset.allowedCanonicalLanes[0],
        }),
      });
      this.session = result.session;
      await this.activateTake(result.take);
      this.setFooter(`Applied ${asset.id} · new take`);
    } catch (err) {
      this.setFooter(err.message, true);
    } finally {
      this.busy = false;
    }
  }

  exportBundle({ stems, rpp }) {
    if (!this.session.activeTakeId) return;
    this.setFooter('Exporting bundle…', false, true);
    const params = new URLSearchParams({
      takeId: this.session.activeTakeId,
      stems: String(stems),
      rpp: String(rpp),
    });
    const url = `${API_PREFIX}/sessions/${this.session.sessionId}/export?${params}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bundle.zip';
    a.click();
    this.setFooter('Bundle exported');
    this.updateCustodyRail('export', 'locked');
  }
}

const desk = new DeskUi();
window.desk = desk;
desk.init().catch((err) => {
  console.error(err);
  $('footer-status').textContent = `Failed to start: ${err.message}`;
  $('footer-status').className = 'error';
});
