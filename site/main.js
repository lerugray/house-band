import { mountPlayer } from './player.js';
import { mountBand } from './band.js';

/** Titles and lengths from da7c971 LS03 MANIFEST.json (loopSeconds, else ogg seconds). */
const DARKNESS = [
  { id: '00-approaching', title: 'Approaching', seconds: 102.8571 },
  { id: '01-main-street', title: 'Main Street', seconds: 105.6 },
  { id: '02-past-the-last-light', title: 'Past the Last Light', seconds: 113.6842 },
  { id: '03-tuesday-night', title: 'Tuesday Night', seconds: 97.5 },
  { id: '04-sorry-about-the-wait', title: 'Sorry About the Wait', seconds: 84.3243 },
  { id: '05-off-season', title: 'Off-Season', seconds: 111.4286 },
  { id: '06-the-742', title: 'The 7:42', seconds: 123.2004 },
  { id: '07-forty-one-seconds', title: 'Forty-One Seconds', seconds: 41 },
  { id: '08a-hold-music', title: 'Hold Music (on the title, telephone)', seconds: 57.7273 },
  { id: '08b-hold-music', title: 'Hold Music (full band)', seconds: 57.7273 },
];

/** Markers from PLAN.md (e) section 3; kept as published unless REPORT notes a >2 s miss. */
const FD_MARKERS = [
  { label: 'A', at: 0 },
  { label: 'B', at: 51 },
  { label: 'C', at: 102 },
  { label: "A'", at: 128 },
  { label: 'D', at: 179 },
];

const MA_MARKERS = [
  { label: 'A', at: 0 },
  { label: 'B', at: 38 },
  { label: 'C', at: 76 },
  { label: "A'", at: 115 },
  { label: 'D', at: 153 },
];

function formatLength(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function darknessTrack(id, title) {
  return {
    title,
    mp3: `audio/darkness/${id}.mp3`,
    ogg: `audio/darkness/${id}.ogg`,
    peaks: `peaks/darkness/${id}.ogg.json`,
  };
}

async function kitsFromScores() {
  const kits = {};
  await Promise.all(
    DARKNESS.map(async (t) => {
      const res = await fetch(`scores/darkness/${t.id}.json`);
      if (!res.ok) throw new Error(`score ${t.id}: ${res.status}`);
      const score = await res.json();
      const found = new Set();
      if (typeof score.kit === 'string') found.add(score.kit);
      kits[t.id] = [...found];
    }),
  );
  return kits;
}

function wireDarknessAlbum(playerApi, kits) {
  const list = document.getElementById('darkness-album');
  if (!list) return;
  list.replaceChildren();
  DARKNESS.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'album-row';

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'album-play';
    play.setAttribute('aria-label', `Play ${t.title}`);
    play.textContent = 'Play';
    play.addEventListener('click', () => {
      playerApi.loadTrack(i, { autoplay: true }).catch(() => {});
    });

    const title = document.createElement('span');
    title.className = 'album-title';
    title.textContent = t.title;

    const len = document.createElement('span');
    len.className = 'album-length';
    len.textContent = formatLength(t.seconds);

    const chips = document.createElement('span');
    chips.className = 'kit-chips';
    for (const kit of kits[t.id] || []) {
      const chip = document.createElement('span');
      chip.className = 'kit-chip';
      chip.textContent = kit;
      chips.append(chip);
    }

    const score = document.createElement('a');
    score.href = `scores/darkness/${t.id}.json`;
    score.textContent = 'View the score';
    score.setAttribute('aria-label', `View the score for ${t.title}`);

    li.append(play, title, len, chips, score);
    list.append(li);
  });
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Lazy-load a Stageshow demo; reduced-motion gets the poster PNG only.
 *  `?film-<name>=1` forces the React stage (for vendored film.mjs), including under
 *  prefers-reduced-motion so the Stage poster can be filmed. */
function mountDemoSlot(opts) {
  const { slotAttr, rootId, demo, cssHref, jsHref, posterSrc, posterAlt, filmParam } = opts;
  const slot = document.querySelector(`[data-slot="${slotAttr}"]`);
  const root = document.getElementById(rootId);
  if (!slot || !root || root.dataset.hbReady === '1') return;
  root.dataset.hbReady = '1';

  const film = new URLSearchParams(window.location.search).has(filmParam);
  if (prefersReducedMotion() && !film) {
    const img = document.createElement('img');
    img.src = posterSrc;
    img.alt = posterAlt;
    img.width = 720;
    img.height = 400;
    img.style.display = 'block';
    img.style.width = '100%';
    img.style.height = 'auto';
    root.replaceChildren(img);
    return;
  }

  const host = document.createElement('div');
  host.dataset.demo = demo;
  host.style.width = '100%';
  host.style.height = '100%';
  root.replaceChildren(host);

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = cssHref;
  document.head.appendChild(link);

  import(jsHref).catch((err) => {
    console.error(`${demo} demo failed to load`, err);
  });
}

function mountSamplesSlot() {
  mountDemoSlot({
    slotAttr: 'demo-samples',
    rootId: 'demo-samples-root',
    demo: 'samples',
    cssHref: 'demos/dist/samples.css',
    jsHref: './demos/dist/samples.js',
    posterSrc: 'demos/posters/samples-poster.png',
    posterAlt: 'Bring your own samples: mapped roles and song.wav',
    filmParam: 'film-samples',
  });
}

function mountCowriteSlot() {
  mountDemoSlot({
    slotAttr: 'demo-cowrite',
    rootId: 'demo-cowrite-root',
    demo: 'cowrite',
    cssHref: 'demos/dist/cowrite.css',
    jsHref: './demos/dist/cowrite.js',
    posterSrc: 'demos/posters/cowrite-poster.png',
    posterAlt: 'Co-write: maybean2 lanes and section strip A B C A\' D',
    filmParam: 'film-cowrite',
  });
}

function observeDemoSlot(slotAttr, mount) {
  const slot = document.querySelector(`[data-slot="${slotAttr}"]`);
  if (!slot) return;
  if (!('IntersectionObserver' in window)) {
    mount();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.disconnect();
        mount();
      }
    },
    { rootMargin: '240px 0px' },
  );
  io.observe(slot);
}

function observeSamplesDemo() {
  observeDemoSlot('demo-samples', mountSamplesSlot);
}

function observeCowriteDemo() {
  observeDemoSlot('demo-cowrite', mountCowriteSlot);
}

function boot() {
  const bandRoot = document.getElementById('band-hero');
  if (bandRoot) mountBand(bandRoot);

  const hero = document.getElementById('player-hero');
  if (hero) {
    mountPlayer(hero, {
      ariaLabel: 'Darkness Main Street',
      tracks: [darknessTrack('01-main-street', 'Main Street')],
    });
  }

  const darknessEl = document.getElementById('player-darkness');
  let darknessPlayer = null;
  if (darknessEl) {
    darknessPlayer = mountPlayer(darknessEl, {
      ariaLabel: 'Darkness album player',
      tracks: DARKNESS.map((t) => darknessTrack(t.id, t.title)),
    });
  }

  kitsFromScores()
    .then((kits) => {
      if (darknessPlayer) wireDarknessAlbum(darknessPlayer, kits);
    })
    .catch((err) => console.error(err));

  const fdBefore = document.getElementById('player-fd-before');
  if (fdBefore) {
    mountPlayer(fdBefore, {
      ariaLabel: 'First Decent as written',
      tracks: [{
        title: 'First Decent (as written)',
        mp3: 'audio/appendix-n/source-as-written-ANfirstdecent-2026-10-24.mp3',
        ogg: 'audio/appendix-n/source-as-written-ANfirstdecent-2026-10-24.ogg',
        peaks: 'peaks/appendix-n/source-as-written-ANfirstdecent-2026-10-24.ogg.json',
      }],
    });
  }

  const fdAfter = document.getElementById('player-fd-after');
  if (fdAfter) {
    mountPlayer(fdAfter, {
      ariaLabel: 'First Decent developed',
      tracks: [{
        title: 'First Decent (developed)',
        mp3: 'audio/appendix-n/an-house-band-first-decent-2026-10-24.mp3',
        ogg: 'audio/appendix-n/an-house-band-first-decent-2026-10-24.ogg',
        peaks: 'peaks/appendix-n/an-house-band-first-decent-2026-10-24.ogg.json',
        markers: FD_MARKERS,
      }],
    });
  }

  const maBefore = document.getElementById('player-ma-before');
  if (maBefore) {
    mountPlayer(maBefore, {
      ariaLabel: 'Maybe AN 2 as written',
      tracks: [{
        title: 'Maybe AN 2 (as written)',
        mp3: 'audio/appendix-n/source-as-written-maybean2-2026-10-24.mp3',
        ogg: 'audio/appendix-n/source-as-written-maybean2-2026-10-24.ogg',
        peaks: 'peaks/appendix-n/source-as-written-maybean2-2026-10-24.ogg.json',
      }],
    });
  }

  const maAfter = document.getElementById('player-ma-after');
  if (maAfter) {
    mountPlayer(maAfter, {
      ariaLabel: 'Maybe AN 2 developed',
      tracks: [{
        title: 'Maybe AN 2 (developed)',
        mp3: 'audio/appendix-n/an-house-band-maybe-an-2-2026-10-25.mp3',
        ogg: 'audio/appendix-n/an-house-band-maybe-an-2-2026-10-25.ogg',
        peaks: 'peaks/appendix-n/an-house-band-maybe-an-2-2026-10-25.ogg.json',
        markers: MA_MARKERS,
      }],
    });
  }

  observeCowriteDemo();
  observeSamplesDemo();

  const abSampled = document.getElementById('player-ab-sampled');
  if (abSampled) {
    mountPlayer(abSampled, {
      ariaLabel: 'Sampled TR-707 kit render',
      tracks: [{
        title: 'Forty-One Seconds (sampled TR-707)',
        mp3: 'audio/ab/forty-one-seconds-sampled.mp3',
        ogg: 'audio/ab/forty-one-seconds-sampled.ogg',
        peaks: 'peaks/ab/forty-one-seconds-sampled.ogg.json',
      }],
    });
  }

  const abSynth = document.getElementById('player-ab-synth');
  if (abSynth) {
    mountPlayer(abSynth, {
      ariaLabel: 'Synth kit-map render',
      tracks: [{
        title: 'Forty-One Seconds (tr808 via kit-map)',
        mp3: 'audio/ab/forty-one-seconds-synth.mp3',
        ogg: 'audio/ab/forty-one-seconds-synth.ogg',
        peaks: 'peaks/ab/forty-one-seconds-synth.ogg.json',
      }],
    });
  }

  const roadOut = document.getElementById('player-example-road-out');
  if (roadOut) {
    mountPlayer(roadOut, {
      ariaLabel: 'The Road Out',
      tracks: [{
        title: 'The Road Out',
        mp3: 'audio/examples/an-house-band-road-out-2026-10-15.mp3',
        ogg: 'audio/examples/an-house-band-road-out-2026-10-15.ogg',
        peaks: 'peaks/examples/an-house-band-road-out-2026-10-15.ogg.json',
      }],
    });
  }
}

boot();
