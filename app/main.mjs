/**
 * Audition Room UI — Surfaces A–D.
 */

import { VOICES, validateSpec, SpecError } from '../src/spec.mjs';
import { NEUTRAL_DEFAULTS } from '../src/kit/band.js';
import { renderScoreToWav } from './render.mjs';
import { createTransport, STATE } from './transport.mjs';
import { buildGrid } from './grid.mjs';
import { createAcceptedBundle } from './bundle.mjs';
import { createHandoffBundle } from './handoff.mjs';
import { loadSamplePackFiles } from './sample-pack.mjs';
import { applySpecEdit, describeValue, diffSpecs, formatPath, revertSpecPath } from './tweak.mjs';

const DEMO_SPEC = __DEMO_SPEC__;

const $ = (id) => document.getElementById(id);

function formatTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function init() {
  const els = {
    status: $('status'),
    loadInput: $('load-input'),
    packInput: $('pack-input'),
    samplePackPanel: $('sample-pack-panel'),
    loadLabel: $('load-label'),
    saveBtn: $('save-spec'),
    exportWavBtn: $('export-wav'),
    exportManifestBtn: $('export-manifest'),
    acceptBtn: $('accept-take'),
    handoffBtn: $('export-handoff'),
    playBtn: $('play-btn'),
    stopBtn: $('stop-btn'),
    loopCheck: $('loop-check'),
    position: $('position'),
    seedInput: $('seed-input'),
    rerollBtn: $('reroll-btn'),
    abA: $('ab-a'),
    abB: $('ab-b'),
    voiceList: $('voice-list'),
    tweakControls: $('tweak-controls'),
    diffList: $('diff-list'),
    grid: $('grid'),
    registerPanel: $('register-panel'),
    pasteOpen: $('paste-open'),
    pasteDialog: $('paste-dialog'),
    pasteForm: $('paste-form'),
    pasteText: $('paste-text'),
    pasteError: $('paste-error'),
    pasteCancel: $('paste-cancel'),
    dropTarget: document.body,
  };

  const initialArtifact = validateSpec(structuredClone(DEMO_SPEC));
  let loadedSpec = initialArtifact;
  let workingSpec = initialArtifact;
  let loadedSamplePack = null;
  const voiceState = Object.fromEntries(VOICES.map((v) => [v, { mute: false, solo: false, gain: 1 }]));
  let gridController = null;
  let renderTimer = null;
  let currentTake = { A: null, B: null, active: 'A' };

  const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  const audioCtx = new AudioContext();

  const transport = createTransport(audioCtx, {
    onStateChange(state) {
      els.playBtn.textContent = state === STATE.PLAYING ? 'Pause' : 'Play';
    },
    onPosition(pos, dur) {
      els.position.textContent = `${formatTime(pos)} / ${formatTime(dur)}`;
      if (gridController) gridController.update(pos);
    },
  });

  function setStatus(text, isError = false) {
    if (!String(text).startsWith('Ready · sha256 ')) delete els.status.dataset.renderHash;
    els.status.textContent = text;
    els.status.className = 'status' + (isError ? ' error' : text ? ' rendering' : '');
  }

  function clearError() {
    if (els.status.classList.contains('error')) setStatus('');
  }

  function validateWorkingSpec() {
    // Apply runtime audition controls to a mutable clone, then validate.
    const draft = structuredClone(workingSpec);
    const anySolo = Object.values(voiceState).some((s) => s.solo);

    for (const track of Object.values(draft.tracks)) {
      track.steps = track.steps.filter((event) => {
        const voice = event.voice ?? event.v;
        const state = voiceState[voice];
        if (!state) return true;
        if (state.mute) return false;
        if (anySolo && !state.solo) return false;

        const defaults = NEUTRAL_DEFAULTS.voices[voice] || {};
        const opts = event.opts ?? event.o ?? {};
        const sampleBacked = Object.hasOwn(draft.sampleVoices || {}, voice);
        const baseVol = opts.vol === undefined ? (sampleBacked ? 1 : defaults.vol) : opts.vol;
        if (baseVol !== undefined) {
          opts.vol = Math.min(4, Math.max(0, baseVol * state.gain));
        }
        event.opts = opts;
        if (event.o !== undefined) delete event.o;
        return true;
      });
    }

    return validateSpec(draft);
  }

  async function renderCurrent() {
    clearError();
    let artifact;
    try {
      artifact = validateWorkingSpec();
    } catch (err) {
      setStatus(`Spec invalid: ${err.message}`, true);
      throw err;
    }

    setStatus('Rendering…');
    els.playBtn.disabled = true;

    try {
      const renderOpts = { samplePack: loadedSamplePack };
      if (!artifact.sampleVoices) renderOpts.tailSeconds = 0.1;
      const { wav, manifest } = await renderScoreToWav(artifact, renderOpts);
      const buffer = await audioCtx.decodeAudioData(wav.slice(0));

      // Push current take to B, new take to A.
      currentTake.B = currentTake.A;
      currentTake.A = { buffer, wav, manifest, seed: artifact.seed };
      currentTake.active = 'A';
      transport.setBuffer(buffer);
      updateAB();
      els.status.dataset.renderHash = manifest.output.sha256;
      setStatus(`Ready · sha256 ${manifest.output.sha256}`);
    } catch (err) {
      setStatus(`Render failed: ${err.message}`, true);
      throw err;
    } finally {
      els.playBtn.disabled = false;
    }
  }

  function queueRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderCurrent().catch(() => {});
    }, 80);
  }

  function loadArtifact(json) {
    try {
      const artifact = validateSpec(json);
      loadedSpec = artifact;
      workingSpec = artifact;
      currentTake = { A: null, B: null, active: 'A' };
      updateAB();
      clearError();
      updateRegisterPanel();
      updateGrid();
      updateVoiceControls();
      updateSamplePackPanel();
      buildTweakControls();
      updateDiffs();
      els.seedInput.value = String(workingSpec.seed);
      renderCurrent().catch(() => {});
      return true;
    } catch (err) {
      setStatus(`Load failed: ${err instanceof SpecError ? err.message : 'invalid JSON'}`, true);
      return false;
    }
  }

  function updateRegisterPanel() {
    const reg = workingSpec.register || {};
    const kv = workingSpec.kitVersion || {};
    els.registerPanel.innerHTML = `
      <div class="register-row"><span class="label">Register</span><span>${reg.name || '—'}</span></div>
      <div class="register-row"><span class="label">Brief</span><span>${reg.briefRef || '—'}</span></div>
      <div class="register-row"><span class="label">Kit</span><span>${kv.semver || '—'} · ${(kv.sha || '').slice(0, 12)}…</span></div>
      <div class="register-row"><span class="label">Schema</span><span>${workingSpec.schemaVersion || '—'}</span></div>
      ${workingSpec.label ? `<div class="register-row" style="margin-top:0.5rem;color:var(--muted)">${workingSpec.label}</div>` : ''}
    `;
  }

  function updateSamplePackPanel() {
    const ref = workingSpec.samplePack;
    if (!loadedSamplePack) {
      els.samplePackPanel.textContent = ref
        ? `Required · ${ref.packId}\nNo matching pack loaded`
        : 'No pack required by this score';
      els.samplePackPanel.classList.toggle('missing', Boolean(ref));
      return;
    }
    const manifest = loadedSamplePack.manifest;
    const matches = Boolean(ref
      && ref.packId === manifest.packId
      && ref.manifestSha256 === manifest.manifestSha256
      && ref.contentSha256 === manifest.contentSha256);
    els.samplePackPanel.textContent = [
      manifest.displayName,
      `${manifest.assetCount} assets · ${manifest.totalWavBytes} bytes`,
      manifest.provenance,
      ref ? (matches ? 'Matches loaded score' : 'Does not match loaded score') : 'Loaded; current score does not use samples',
    ].join('\n');
    els.samplePackPanel.classList.toggle('missing', Boolean(ref) && !matches);
  }

  function updateGrid() {
    gridController = buildGrid(els.grid, workingSpec);
  }

  function parseControlValue(input, kind) {
    if (kind === 'number') {
      const value = Number(input.value);
      if (!Number.isFinite(value)) throw new Error('must be a finite number');
      return value;
    }
    if (kind === 'integer') {
      const value = Number(input.value);
      if (!Number.isInteger(value)) throw new Error('must be an integer');
      return value;
    }
    if (kind === 'number-list') {
      const parts = input.value.split(',').map((part) => part.trim()).filter(Boolean);
      if (parts.length === 0) throw new Error('needs at least one number');
      const values = parts.map(Number);
      if (values.some((value) => !Number.isFinite(value))) throw new Error('must be a comma-separated number list');
      return values;
    }
    if (kind === 'integer-or-list') {
      const parts = input.value.split(',').map((part) => part.trim()).filter(Boolean);
      const values = parts.map(Number);
      if (values.length === 0 || values.some((value) => !Number.isInteger(value))) {
        throw new Error('must be an integer or comma-separated integer list');
      }
      return values.length === 1 ? values[0] : values;
    }
    return input.value;
  }

  function commitArtifactEdit(path, value) {
    try {
      workingSpec = applySpecEdit(workingSpec, path, value);
      clearError();
      els.seedInput.value = String(workingSpec.seed);
      updateRegisterPanel();
      updateGrid();
      buildTweakControls();
      updateDiffs();
      queueRender();
      return true;
    } catch (err) {
      setStatus(`Edit rejected: ${err.message}`, true);
      buildTweakControls();
      return false;
    }
  }

  function makeField(label, path, value, kind = 'number', attrs = {}) {
    const wrap = document.createElement('label');
    wrap.className = 'tweak-field';
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    input.type = kind === 'string' || kind.includes('list') ? 'text' : 'number';
    input.value = Array.isArray(value) ? value.join(', ') : String(value);
    for (const [key, attrValue] of Object.entries(attrs)) input.setAttribute(key, String(attrValue));
    input.dataset.path = formatPath(path);
    input.addEventListener('change', () => {
      try {
        commitArtifactEdit(path, parseControlValue(input, kind));
      } catch (err) {
        setStatus(`Edit rejected: ${formatPath(path)} ${err.message}`, true);
        buildTweakControls();
      }
    });
    wrap.append(name, input);
    return wrap;
  }

  function makeSelectField(label, path, value, choices) {
    const wrap = document.createElement('label');
    wrap.className = 'tweak-field';
    const name = document.createElement('span');
    name.textContent = label;
    const select = document.createElement('select');
    select.dataset.path = formatPath(path);
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = choice;
      option.textContent = choice;
      option.selected = choice === value;
      select.appendChild(option);
    }
    select.addEventListener('change', () => commitArtifactEdit(path, select.value));
    wrap.append(name, select);
    return wrap;
  }

  function makeGroup(title, className = '') {
    const group = document.createElement('div');
    group.className = `tweak-group ${className}`.trim();
    const heading = document.createElement('h3');
    heading.textContent = title;
    group.appendChild(heading);
    return group;
  }

  function optionKind(value) {
    if (Array.isArray(value)) return 'number-list';
    if (typeof value === 'number') return 'number';
    return 'string';
  }

  function buildTweakControls() {
    els.tweakControls.innerHTML = '';

    const score = makeGroup('Score');
    if (workingSpec.tempo !== undefined) {
      score.appendChild(makeField('Tempo', ['tempo'], workingSpec.tempo, 'number', { min: 20, max: 400, step: 0.01 }));
    }
    if (workingSpec.gain !== undefined) {
      score.appendChild(makeField('Master gain', ['gain'], workingSpec.gain, 'number', { min: 0, max: 1, step: 0.01 }));
    }
    const swingGap = document.createElement('div');
    swingGap.className = 'schema-gap';
    swingGap.textContent = `Swing — unavailable in schema ${workingSpec.schemaVersion}`;
    score.appendChild(swingGap);
    els.tweakControls.appendChild(score);

    for (const [trackName, track] of Object.entries(workingSpec.tracks)) {
      const trackGroup = makeGroup(`Track · ${trackName}`, 'track-editor');
      const trackFields = document.createElement('div');
      trackFields.className = 'tweak-fields';
      if (track.bpm !== undefined) {
        trackFields.appendChild(makeField('BPM', ['tracks', trackName, 'bpm'], track.bpm, 'number', { min: 20, max: 400, step: 0.01 }));
      }
      trackFields.appendChild(makeField('Length', ['tracks', trackName, 'len'], track.len, 'integer', { min: 1, max: 4096, step: 1 }));
      if (track.vol !== undefined) {
        trackFields.appendChild(makeField('Track level', ['tracks', trackName, 'vol'], track.vol, 'number', { min: 0, max: 1, step: 0.01 }));
      }
      trackGroup.appendChild(trackFields);

      track.steps.forEach((event, eventIndex) => {
        const eventGroup = makeGroup(`${event.voice ?? event.v} · event ${eventIndex + 1}`, 'event-editor');
        const fields = document.createElement('div');
        fields.className = 'tweak-fields';
        const base = ['tracks', trackName, 'steps', eventIndex];
        if (event.i !== undefined) fields.appendChild(makeField('Steps', [...base, 'i'], event.i, 'integer-or-list'));
        if (event.every !== undefined) fields.appendChild(makeField('Every', [...base, 'every'], event.every, 'integer', { min: 1, max: track.len, step: 1 }));
        if (event.note !== undefined) fields.appendChild(makeField('Note', [...base, 'note'], event.note, 'string'));
        if (event.freq !== undefined) fields.appendChild(makeField('Frequency', [...base, 'freq'], event.freq, 'number', { min: 1, max: 24000, step: 0.01 }));
        if (event.dur !== undefined) fields.appendChild(makeField('Duration', [...base, 'dur'], event.dur, 'number', { min: 0.001, max: 120, step: 0.001 }));
        const optionKey = event.opts !== undefined ? 'opts' : event.o !== undefined ? 'o' : null;
        if (optionKey) {
          for (const [key, value] of Object.entries(event[optionKey])) {
            fields.appendChild(makeField(key === 'vol' ? 'Voice level' : key, [...base, optionKey, key], value, optionKind(value)));
          }
        }
        eventGroup.appendChild(fields);
        trackGroup.appendChild(eventGroup);
      });
      els.tweakControls.appendChild(trackGroup);
    }

    const sections = makeGroup('Arrangement', 'section-editor');
    workingSpec.sections.forEach((section, index) => {
      const row = document.createElement('div');
      row.className = 'section-row';
      const base = ['sections', index];
      row.appendChild(makeSelectField(`Section ${index + 1}`, [...base, 'track'], section.track, Object.keys(workingSpec.tracks)));
      row.appendChild(makeField('Bars', [...base, 'bars'], section.bars, 'integer', { min: 1, max: 4096, step: 1 }));
      if (section.fadeIn !== undefined) {
        row.appendChild(makeField('Fade in', [...base, 'fadeIn'], section.fadeIn, 'number', { min: 0, max: 30, step: 0.01 }));
      }
      if (workingSpec.sections.length > 1) {
        const order = document.createElement('div');
        order.className = 'section-order';
        const up = document.createElement('button');
        const down = document.createElement('button');
        up.type = down.type = 'button';
        up.textContent = 'Move up';
        down.textContent = 'Move down';
        up.disabled = index === 0;
        down.disabled = index === workingSpec.sections.length - 1;
        const move = (offset) => {
          const reordered = structuredClone(workingSpec.sections);
          const [moved] = reordered.splice(index, 1);
          reordered.splice(index + offset, 0, moved);
          commitArtifactEdit(['sections'], reordered);
        };
        up.addEventListener('click', () => move(-1));
        down.addEventListener('click', () => move(1));
        order.append(up, down);
        row.appendChild(order);
      }
      sections.appendChild(row);
    });
    els.tweakControls.appendChild(sections);
  }

  function updateDiffs() {
    const diffs = diffSpecs(loadedSpec, workingSpec);
    els.diffList.innerHTML = '';
    if (diffs.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'diff-empty';
      empty.textContent = 'No changes from loaded take';
      els.diffList.appendChild(empty);
      return;
    }
    for (const diff of diffs) {
      const chip = document.createElement('button');
      chip.className = 'diff-chip';
      chip.title = `Revert ${formatPath(diff.path)}`;
      chip.textContent = `${formatPath(diff.path)}: ${describeValue(diff.before)} → ${describeValue(diff.after)}  ×`;
      chip.addEventListener('click', () => {
        try {
          workingSpec = revertSpecPath(loadedSpec, workingSpec, diff.path);
          clearError();
          els.seedInput.value = String(workingSpec.seed);
          updateRegisterPanel();
          updateGrid();
          buildTweakControls();
          updateDiffs();
          queueRender();
        } catch (err) {
          setStatus(`Revert failed: ${err.message}`, true);
        }
      });
      els.diffList.appendChild(chip);
    }
  }

  function updateAB() {
    els.abA.textContent = currentTake.A ? `A · seed ${currentTake.A.seed}` : 'A';
    els.abB.textContent = currentTake.B ? `B · seed ${currentTake.B.seed}` : 'B';
    els.abA.classList.toggle('active', currentTake.active === 'A');
    els.abB.classList.toggle('active', currentTake.active === 'B');
    els.exportWavBtn.disabled = !currentTake[currentTake.active];
    els.exportManifestBtn.disabled = !currentTake[currentTake.active];
    els.acceptBtn.disabled = !currentTake.A;
    els.handoffBtn.disabled = !currentTake.A || Boolean(workingSpec.sampleVoices);
    els.handoffBtn.title = workingSpec.sampleVoices ? 'Sample-backed .RPP handoff is deferred beyond M3 tranche 1' : '';
  }

  function selectAB(take) {
    if (!currentTake[take]) return;
    currentTake.active = take;
    transport.setBuffer(currentTake[take].buffer);
    updateAB();
  }

  function buildVoiceControls() {
    els.voiceList.innerHTML = '';
    for (const voice of VOICES) {
      const row = document.createElement('div');
      row.className = 'voice-row';
      row.innerHTML = `
        <label>${voice}<span class="voice-source"></span></label>
        <button data-action="mute" title="Mute">M</button>
        <button data-action="solo" title="Solo">S</button>
        <input type="range" min="0" max="2" step="0.01" value="1" title="Gain">
      `;
      const [muteBtn, soloBtn, gainInput] = [
        row.querySelector('[data-action="mute"]'),
        row.querySelector('[data-action="solo"]'),
        row.querySelector('input[type="range"]'),
      ];

      muteBtn.addEventListener('click', () => {
        voiceState[voice].mute = !voiceState[voice].mute;
        updateVoiceControls();
        queueRender();
      });
      soloBtn.addEventListener('click', () => {
        voiceState[voice].solo = !voiceState[voice].solo;
        updateVoiceControls();
        queueRender();
      });
      gainInput.addEventListener('input', () => {
        voiceState[voice].gain = parseFloat(gainInput.value);
        queueRender();
      });

      els.voiceList.appendChild(row);
    }
    updateVoiceControls();
  }

  function updateVoiceControls() {
    const rows = els.voiceList.querySelectorAll('.voice-row');
    rows.forEach((row, idx) => {
      const voice = VOICES[idx];
      const state = voiceState[voice];
      const muteBtn = row.querySelector('[data-action="mute"]');
      const soloBtn = row.querySelector('[data-action="solo"]');
      const gainInput = row.querySelector('input[type="range"]');
      const source = row.querySelector('.voice-source');
      muteBtn.classList.toggle('on', state.mute);
      soloBtn.classList.toggle('on', state.solo);
      gainInput.value = String(state.gain);
      const binding = workingSpec.sampleVoices?.[voice];
      source.textContent = binding ? `sample · ${binding.assetId}` : 'synth';
      source.classList.toggle('sample-backed', Boolean(binding));
    });
  }

  function setSeed(value) {
    let n = Number(value);
    if (!Number.isFinite(n) || n < 0) n = 0;
    return commitArtifactEdit(['seed'], (n >>> 0) % 0x100000000);
  }

  function rerollSeed() {
    setSeed(Math.floor(Math.random() * 0x100000000));
  }

  // Event wiring
  els.loadInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result));
        loadArtifact(json);
      } catch (err) {
        setStatus(`Load failed: ${err.message}`, true);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  els.packInput.addEventListener('change', async (e) => {
    if (!e.target.files.length) return;
    setStatus('Validating sample pack…');
    try {
      loadedSamplePack = await loadSamplePackFiles(e.target.files);
      updateSamplePackPanel();
      updateVoiceControls();
      await renderCurrent();
    } catch (err) {
      setStatus(`Sample pack load failed: ${err.message}`, true);
    } finally {
      e.target.value = '';
    }
  });

  els.saveBtn.addEventListener('click', () => {
    try {
      const artifact = validateSpec(structuredClone(workingSpec));
      const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' });
      downloadBlob(blob, `house-band-${workingSpec.register?.name || 'score'}-${Date.now()}.json`);
    } catch (err) {
      setStatus(`Save failed: ${err.message}`, true);
    }
  });

  els.exportWavBtn.addEventListener('click', () => {
    const take = currentTake[currentTake.active];
    if (!take) return;
    const name = `${workingSpec.register?.name || 'score'}-${take.seed}-${Date.now()}`;
    downloadBlob(new Blob([take.wav], { type: 'audio/wav' }), `${name}.wav`);
  });

  els.exportManifestBtn.addEventListener('click', () => {
    const take = currentTake[currentTake.active];
    if (!take) return;
    const name = `${workingSpec.register?.name || 'score'}-${take.seed}-${Date.now()}`;
    downloadBlob(new Blob([JSON.stringify(take.manifest, null, 2)], { type: 'application/json' }), `${name}.wav.manifest.json`);
  });

  els.acceptBtn.addEventListener('click', async () => {
    els.acceptBtn.disabled = true;
    setStatus('Accepting take…');
    try {
      const artifact = validateSpec(structuredClone(workingSpec));
      const { wav, manifest } = await renderScoreToWav(artifact, { samplePack: loadedSamplePack });
      const bundle = await createAcceptedBundle(artifact, wav, manifest, { date: new Date() });
      downloadBlob(new Blob([bundle.bytes], { type: 'application/zip' }), bundle.filename);
      setStatus(`Accepted · ${bundle.filename}`);
    } catch (err) {
      setStatus(`Accept failed: ${err.message}`, true);
    } finally {
      els.acceptBtn.disabled = !currentTake.A;
    }
  });

  els.handoffBtn.addEventListener('click', async () => {
    els.handoffBtn.disabled = true;
    setStatus('Rendering aligned stems…');
    try {
      const artifact = validateSpec(structuredClone(workingSpec));
      const bundle = await createHandoffBundle(artifact, { date: new Date() });
      downloadBlob(new Blob([bundle.bytes], { type: 'application/zip' }), bundle.filename);
      setStatus(`Handoff ready · ${bundle.manifest.outputs.stems.length} stems + REAPER`);
    } catch (err) {
      setStatus(`Handoff failed: ${err.message}`, true);
    } finally {
      els.handoffBtn.disabled = !currentTake.A;
    }
  });

  els.playBtn.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    transport.togglePlay();
  });
  els.stopBtn.addEventListener('click', () => transport.stop());
  els.loopCheck.addEventListener('change', () => transport.setLoop(els.loopCheck.checked));

  els.seedInput.addEventListener('change', () => {
    setSeed(els.seedInput.value);
  });
  els.rerollBtn.addEventListener('click', rerollSeed);

  els.abA.addEventListener('click', () => selectAB('A'));
  els.abB.addEventListener('click', () => selectAB('B'));

  // Paste a score: dialog, or Ctrl/Cmd+V anywhere outside a text field.
  function parseScoreText(text) {
    const trimmed = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(trimmed);
  }

  function openPasteDialog(prefill = '') {
    els.pasteError.textContent = '';
    if (prefill) els.pasteText.value = prefill;
    if (typeof els.pasteDialog.showModal === 'function') els.pasteDialog.showModal();
    else els.pasteDialog.setAttribute('open', '');
    els.pasteText.focus();
  }

  function closePasteDialog() {
    if (typeof els.pasteDialog.close === 'function') els.pasteDialog.close();
    else els.pasteDialog.removeAttribute('open');
  }

  els.pasteOpen.addEventListener('click', () => openPasteDialog());
  els.pasteCancel.addEventListener('click', closePasteDialog);
  els.pasteText.addEventListener('input', () => { els.pasteError.textContent = ''; });
  els.pasteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    let json;
    try {
      json = parseScoreText(els.pasteText.value);
    } catch (err) {
      els.pasteError.textContent = `That is not valid JSON: ${err.message}`;
      return;
    }
    try {
      validateSpec(structuredClone(json));
    } catch (err) {
      els.pasteError.textContent = `The score did not pass the format check: ${err.message}`;
      return;
    }
    if (loadArtifact(json)) {
      closePasteDialog();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    }
  });

  document.addEventListener('paste', (e) => {
    const target = e.target;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
    const text = e.clipboardData?.getData('text') ?? '';
    if (!text.trim().startsWith('{') && !text.trim().startsWith('```')) return;
    e.preventDefault();
    openPasteDialog(text);
  });

  // ?score=<same-origin path> preloads a score (the landing page links its examples this way).
  async function loadScoreFromQuery() {
    const param = new URLSearchParams(globalThis.location?.search ?? '').get('score');
    if (!param) return false;
    let url;
    try {
      url = new URL(param, globalThis.location.href);
    } catch {
      return false;
    }
    if (url.origin !== globalThis.location.origin) {
      setStatus('Only scores from this site can be opened by link; use Paste score for others.', true);
      return false;
    }
    try {
      setStatus('Loading score…');
      const res = await fetch(url.href);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return loadArtifact(await res.json());
    } catch (err) {
      setStatus(`Could not load ${url.pathname}: ${err.message}`, true);
      return false;
    }
  }

  // Drag and drop
  ['dragenter', 'dragover'].forEach((ev) => {
    els.dropTarget.addEventListener(ev, (e) => { e.preventDefault(); });
  });
  els.dropTarget.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (files.some((entry) => entry.name === 'pack.json' || entry.name.toLowerCase().endsWith('.wav'))) {
      setStatus('Validating sample pack…');
      loadSamplePackFiles(files).then((pack) => {
        loadedSamplePack = pack;
        updateSamplePackPanel();
        updateVoiceControls();
        return renderCurrent();
      }).catch((err) => setStatus(`Sample pack drop failed: ${err.message}`, true));
      return;
    }
    const file = files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadArtifact(JSON.parse(String(reader.result)));
      } catch (err) {
        setStatus(`Drop failed: ${err.message}`, true);
      }
    };
    reader.readAsText(file);
  });

  // Init
  buildVoiceControls();
  updateRegisterPanel();
  updateSamplePackPanel();
  updateGrid();
  buildTweakControls();
  updateDiffs();
  els.seedInput.value = String(workingSpec.seed);
  loadScoreFromQuery().then((loaded) => {
    if (!loaded) renderCurrent().catch(() => {});
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
