/**
 * Vanilla ES-module audio player for the landing page.
 * mountPlayer(el, { tracks: [{ title, mp3, ogg, peaks, markers? }] })
 */
let currentPlayer = null;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function loadPeaks(peaks) {
  if (!peaks) return Promise.resolve({ peaks: [], durationSeconds: 0 });
  if (typeof peaks === 'object' && Array.isArray(peaks.peaks)) {
    return Promise.resolve(peaks);
  }
  return fetch(peaks).then((r) => {
    if (!r.ok) throw new Error(`peaks ${peaks}: ${r.status}`);
    return r.json();
  });
}

export function mountPlayer(el, options = {}) {
  if (!el) throw new Error('mountPlayer: element required');
  const tracks = Array.isArray(options.tracks) ? options.tracks : [];
  if (!tracks.length) throw new Error('mountPlayer: tracks required');

  el.classList.add('hb-player');
  el.tabIndex = 0;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', options.ariaLabel || 'Audio player');

  el.replaceChildren();

  const head = document.createElement('div');
  head.className = 'hb-player-head';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'play-btn';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.setAttribute('aria-pressed', 'false');

  const meta = document.createElement('div');
  meta.className = 'hb-player-meta';

  const titleEl = document.createElement('div');
  titleEl.className = 'hb-player-title';

  const timeEl = document.createElement('div');
  timeEl.className = 'hb-player-time';
  timeEl.setAttribute('aria-label', 'Playback time');
  timeEl.textContent = '0:00 / 0:00';

  meta.append(titleEl, timeEl);
  head.append(playBtn, meta);

  const waveWrap = document.createElement('div');
  waveWrap.className = 'hb-player-wave';
  waveWrap.setAttribute('role', 'slider');
  waveWrap.setAttribute('aria-label', 'Seek waveform');
  waveWrap.setAttribute('aria-valuemin', '0');
  waveWrap.setAttribute('aria-valuemax', '0');
  waveWrap.setAttribute('aria-valuenow', '0');
  waveWrap.tabIndex = 0;

  const canvas = document.createElement('canvas');
  canvas.className = 'hb-player-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  waveWrap.append(canvas);

  const markerLayer = document.createElement('div');
  markerLayer.className = 'hb-player-markers';
  markerLayer.setAttribute('aria-hidden', 'true');
  waveWrap.append(markerLayer);

  const audio = document.createElement('audio');
  audio.preload = 'none';
  audio.setAttribute('aria-hidden', 'true');

  let trackListEl = null;
  if (tracks.length > 1) {
    trackListEl = document.createElement('ul');
    trackListEl.className = 'hb-player-tracks';
    trackListEl.setAttribute('aria-label', 'Tracks');
  }

  el.append(head, waveWrap, audio);
  if (trackListEl) el.append(trackListEl);

  const state = {
    index: 0,
    peaksData: null,
    duration: 0,
    dragging: false,
    destroyed: false,
    trackButtons: [],
  };

  function active() {
    return tracks[state.index];
  }

  function setPlayingUi(playing) {
    playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playBtn.classList.toggle('is-playing', playing);
  }

  function updateTime() {
    const cur = audio.currentTime || 0;
    const dur = state.duration || audio.duration || 0;
    timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    waveWrap.setAttribute('aria-valuenow', String(Math.round(cur)));
    waveWrap.setAttribute('aria-valuemax', String(Math.round(dur)));
    draw();
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = waveWrap.clientWidth || 320;
    const cssH = waveWrap.clientHeight || 72;
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const accent = cssVar('--accent', '#f2b544');
    const muted = cssVar('--muted', '#9aa0a6');
    const pairs = state.peaksData?.peaks || [];
    const mid = h / 2;
    const progress = state.duration > 0 ? Math.min(1, (audio.currentTime || 0) / state.duration) : 0;
    const split = progress * w;

    if (!pairs.length) {
      ctx.fillStyle = muted;
      ctx.fillRect(0, mid - dpr, w, dpr * 2);
      return;
    }

    const barW = w / pairs.length;
    for (let i = 0; i < pairs.length; i++) {
      const [mn, mx] = pairs[i];
      const x = i * barW;
      const y1 = mid - Math.max(1, Math.abs(mx) * mid * 0.92);
      const y2 = mid + Math.max(1, Math.abs(mn) * mid * 0.92);
      ctx.fillStyle = x + barW * 0.5 <= split ? accent : muted;
      ctx.fillRect(x, y1, Math.max(dpr, barW * 0.7), y2 - y1);
    }

    const markers = active().markers || [];
    if (markers.length && state.duration > 0) {
      markerLayer.replaceChildren();
      const yours = cssVar('--yours', '#6fb7ff');
      for (const m of markers) {
        const t = typeof m === 'number' ? m : m.at;
        const label = typeof m === 'number' ? '' : (m.label || '');
        const xRatio = Math.min(1, Math.max(0, t / state.duration));
        const line = document.createElement('span');
        line.className = 'hb-player-marker';
        line.style.left = `${xRatio * 100}%`;
        line.style.background = yours;
        if (label) {
          const lab = document.createElement('span');
          lab.className = 'hb-player-marker-label';
          lab.textContent = label;
          line.append(lab);
        }
        markerLayer.append(line);
      }
    } else {
      markerLayer.replaceChildren();
    }
  }

  function seekFromClientX(clientX) {
    if (!state.duration) return;
    const rect = waveWrap.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * state.duration;
    updateTime();
  }

  function pauseSelf() {
    audio.pause();
    setPlayingUi(false);
  }

  async function playSelf() {
    if (currentPlayer && currentPlayer !== api) {
      currentPlayer.pause();
    }
    currentPlayer = api;
    try {
      await audio.play();
      setPlayingUi(true);
    } catch (err) {
      setPlayingUi(false);
      throw err;
    }
  }

  async function toggle() {
    if (audio.paused) await playSelf();
    else pauseSelf();
  }

  async function loadTrack(index, { autoplay = false } = {}) {
    state.index = index;
    const track = active();
    titleEl.textContent = track.title || '';
    audio.replaceChildren();
    if (track.ogg) {
      const sOgg = document.createElement('source');
      sOgg.src = track.ogg;
      sOgg.type = 'audio/ogg';
      audio.append(sOgg);
    }
    if (track.mp3) {
      const sMp3 = document.createElement('source');
      sMp3.src = track.mp3;
      sMp3.type = 'audio/mpeg';
      audio.append(sMp3);
    }
    audio.load();

    state.peaksData = await loadPeaks(track.peaks);
    state.duration = state.peaksData.durationSeconds || 0;
    updateTime();
    draw();

    if (trackListEl) {
      state.trackButtons.forEach((btn, i) => {
        btn.setAttribute('aria-current', i === index ? 'true' : 'false');
        btn.classList.toggle('is-current', i === index);
      });
    }

    if (autoplay) await playSelf();
  }

  if (trackListEl) {
    tracks.forEach((track, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hb-player-track-btn';
      btn.textContent = track.title || `Track ${i + 1}`;
      btn.setAttribute('aria-label', `Play ${track.title || `track ${i + 1}`}`);
      btn.addEventListener('click', () => {
        loadTrack(i, { autoplay: true }).catch(() => {});
      });
      li.append(btn);
      trackListEl.append(li);
      state.trackButtons.push(btn);
    });
  }

  playBtn.addEventListener('click', () => {
    toggle().catch(() => {});
  });

  audio.addEventListener('timeupdate', updateTime);
  audio.addEventListener('ended', () => {
    setPlayingUi(false);
    updateTime();
  });
  audio.addEventListener('pause', () => {
    if (currentPlayer === api) setPlayingUi(false);
  });
  audio.addEventListener('play', () => setPlayingUi(true));
  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      if (!state.duration) state.duration = audio.duration;
      updateTime();
    }
  });

  waveWrap.addEventListener('pointerdown', (ev) => {
    state.dragging = true;
    waveWrap.setPointerCapture(ev.pointerId);
    seekFromClientX(ev.clientX);
  });
  waveWrap.addEventListener('pointermove', (ev) => {
    if (!state.dragging) return;
    seekFromClientX(ev.clientX);
  });
  waveWrap.addEventListener('pointerup', () => {
    state.dragging = false;
  });
  waveWrap.addEventListener('pointercancel', () => {
    state.dragging = false;
  });

  el.addEventListener('keydown', (ev) => {
    if (ev.target !== el && ev.target !== playBtn && ev.target !== waveWrap) return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      toggle().catch(() => {});
    } else if (ev.code === 'ArrowLeft') {
      ev.preventDefault();
      audio.currentTime = Math.max(0, (audio.currentTime || 0) - 5);
      updateTime();
    } else if (ev.code === 'ArrowRight') {
      ev.preventDefault();
      const dur = state.duration || audio.duration || 0;
      audio.currentTime = Math.min(dur, (audio.currentTime || 0) + 5);
      updateTime();
    }
  });

  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  const api = {
    el,
    audio,
    play: playSelf,
    pause: pauseSelf,
    loadTrack,
    get index() {
      return state.index;
    },
    destroy() {
      state.destroyed = true;
      pauseSelf();
      if (currentPlayer === api) currentPlayer = null;
      window.removeEventListener('resize', onResize);
      el.replaceChildren();
    },
  };

  loadTrack(0).catch((err) => {
    console.error(err);
  });

  return api;
}
