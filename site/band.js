/** Variant A pixel band for the House Band landing-page hero (from s462/band-mascot). */
const W = 192, H = 80;
const BEAT_MS = 500, EIGHTH_MS = 250, LOOP_MS = 4000;
const LOOP_AUDIO_URL = new URL('./audio/band-loop.mp3', import.meta.url).href;
const K = {
  bg: '#0d0f12', surface: '#161a20', surface2: '#1d222a', line: '#2a3038', text: '#ece8e1',
  muted: '#9aa0a6', accent: '#f2b544', yours: '#6fb7ff', ink: '#0d0f12',
  steel: '#3a424d', brass: '#d9a43c', wood: '#c98b4a', woodDk: '#8a5a2b', woodXd: '#5c3b1c',
  bulbOff: '#5a4a25', stick: '#e8cfa0', pad: '#4a5260',
};
// Original band (A and B): one colour per role. No coral, no Anthropic marks.
const ROLE = {
  keys:    { c: '#6fb7ff', d: '#3a77b8' },
  bass:    { c: '#b9a3ff', d: '#6f5bbf' },
  drums:   { c: '#7fd6b0', d: '#3e8f72' },
  synth:   { c: '#ff8fa3', d: '#c0546a' },
  bells:   { c: '#ffd77a', d: '#b8913a' },
  sampler: { c: '#e9d8b4', d: '#a8946a' },
};

/* ---------- pixel renderer (variant A only) ---------- */
const f2 = (n) => Math.round(n * 100) / 100;
function makeRenderer() {
  const px = true, pet = false;
  const out = [];
  const R = Math.round;
  const op = (o) => (o.op != null ? ` fill-opacity="${o.op}"` : '');
  const ol = () => '';
  const CUTS = { 1: [1], 2: [2, 1], 3: [3, 1, 1], 4: [4, 2, 1, 1] };
  const s = {
    px, pet, out,
    raw(str) { out.push(str); },
    rect(x, y, w, h, fill, o = {}) {
      if (px) {
        x = R(x); y = R(y); w = R(w); h = R(h);
        const cut = o.r ? (CUTS[o.r] || CUTS[4]) : null;
        if (!cut) { out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${op(o)}/>`); return; }
        for (let i = 0; i < h; i++) {
          const d = Math.min(i, h - 1 - i);
          const ins = d < cut.length ? cut[d] : 0;
          if (ins === 0) {
            let j = i; while (j + 1 < h && Math.min(j + 1, h - 2 - j) >= cut.length) j++;
            out.push(`<rect x="${x}" y="${y + i}" width="${w}" height="${j - i + 1}" fill="${fill}"${op(o)}/>`);
            i = j;
          } else {
            out.push(`<rect x="${x + ins}" y="${y + i}" width="${w - 2 * ins}" height="1" fill="${fill}"${op(o)}/>`);
          }
        }
      } else {
        const rx = (o.r || o.vr) ? ` rx="${f2(o.vr != null ? o.vr : o.r * 1.1)}"` : '';
        out.push(`<rect x="${f2(x)}" y="${f2(y)}" width="${f2(w)}" height="${f2(h)}"${rx} fill="${fill}"${op(o)}${ol(o)}/>`);
      }
    },
    ellipse(cx, cy, rx, ry, fill, o = {}) {
      if (px) {
        const spans = [];
        for (let j = Math.floor(cy - ry); j <= Math.ceil(cy + ry); j++) {
          const dy = (j + 0.5 - cy) / ry;
          if (Math.abs(dy) > 1) continue;
          const half = rx * Math.sqrt(1 - dy * dy);
          const x0 = Math.ceil(cx - half - 0.5), x1 = Math.floor(cx + half - 0.5);
          if (x1 >= x0) spans.push([j, x0, x1]);
        }
        for (const [j, x0, x1] of spans) out.push(`<rect x="${x0}" y="${j}" width="${x1 - x0 + 1}" height="1" fill="${fill}"${op(o)}/>`);
      } else {
        out.push(`<ellipse cx="${f2(cx)}" cy="${f2(cy)}" rx="${f2(rx)}" ry="${f2(ry)}" fill="${fill}"${op(o)}${ol(o)}/>`);
      }
    },
    line(x1, y1, x2, y2, stroke, w = 1, o = {}) {
      if (px) {
        let ax = R(x1), ay = R(y1); const bx = R(x2), by = R(y2);
        const dx = Math.abs(bx - ax), dy = -Math.abs(by - ay), sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
        let err = dx + dy; const bw = Math.max(1, R(w)), off = Math.floor((bw - 1) / 2);
        for (;;) {
          out.push(`<rect x="${ax - off}" y="${ay - off}" width="${bw}" height="${bw}" fill="${stroke}"${op(o)}/>`);
          if (ax === bx && ay === by) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; ax += sx; }
          if (e2 <= dx) { err += dx; ay += sy; }
        }
      } else {
        const so = o.op != null ? ` stroke-opacity="${o.op}"` : '';
        out.push(`<line x1="${f2(x1)}" y1="${f2(y1)}" x2="${f2(x2)}" y2="${f2(y2)}" stroke="${stroke}" stroke-width="${f2(w)}" stroke-linecap="round"${so}/>`);
      }
    },
    poly(pts, fill, o = {}) {
      if (px) {
        const ys = pts.map((p) => p[1]);
        for (let j = Math.floor(Math.min(...ys)); j < Math.ceil(Math.max(...ys)); j++) {
          const yc = j + 0.5, xs = [];
          for (let i = 0; i < pts.length; i++) {
            const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
            if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
          }
          xs.sort((a, b) => a - b);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            const x0 = Math.ceil(xs[k] - 0.5), x1 = Math.floor(xs[k + 1] - 0.5);
            if (o.dither) {
              for (let x = x0; x <= x1; x++) if ((x + j) % 2 === 0) out.push(`<rect x="${x}" y="${j}" width="1" height="1" fill="${fill}"${op(o)}/>`);
            } else if (x1 >= x0) out.push(`<rect x="${x0}" y="${j}" width="${x1 - x0 + 1}" height="1" fill="${fill}"${op(o)}/>`);
          }
        }
      } else {
        out.push(`<polygon points="${pts.map((p) => p.map(f2).join(',')).join(' ')}" fill="${fill}"${op(o)}${ol(o)}/>`);
      }
    },
    dot(x, y, fill, o = {}) { s.rect(x, y, 1, 1, fill, o); },
    g(attrs, fn) { out.push(`<g ${attrs}>`); fn(); out.push('</g>'); },
  };
  return s;
}

/* ---------- pixel font for the marquee (3x5) ---------- */
const FONT = {
  H: ['101', '101', '111', '101', '101'], O: ['111', '101', '101', '101', '111'],
  U: ['101', '101', '101', '101', '111'], S: ['111', '100', '111', '001', '111'],
  E: ['111', '100', '110', '100', '111'], B: ['110', '101', '110', '101', '110'],
  A: ['010', '101', '111', '101', '101'], N: ['1001', '1101', '1011', '1001', '1001'],
  D: ['110', '101', '101', '101', '110'], ' ': ['0', '0', '0', '0', '0'],
};
function sign(s, text, cx, y, color) {
  if (s.px) {
    const widths = [...text].map((ch) => FONT[ch][0].length);
    const total = widths.reduce((a, b) => a + b, 0) + text.length - 1;
    let x = Math.round(cx - total / 2);
    [...text].forEach((ch, i) => {
      FONT[ch].forEach((row, j) => [...row].forEach((b, k) => { if (b === '1') s.dot(x + k, y + j, color); }));
      x += widths[i] + 1;
    });
  } else {
    s.raw(`<text x="${cx}" y="${y + 4.9}" text-anchor="middle" font-size="5.8" font-weight="800" textLength="39" lengthAdjust="spacingAndGlyphs" fill="${color}" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">${text}</text>`);
  }
}

/* ---------- static scene ---------- */
function scene(s) {
  s.rect(0, 0, W, 60, K.surface);
  for (let x = 6; x < W; x += 12) s.rect(x, 0, 1, 60, K.surface2);
  for (const cx of [36, 96, 156]) {
    const cone = [[cx - 3, 0], [cx + 3, 0], [cx + 17, 62], [cx - 17, 62]];
    if (s.px) s.poly(cone, K.accent, { dither: true, op: 0.16 });
    else s.poly(cone, K.accent, { op: 0.07 });
  }
  // floor
  s.rect(0, 60, W, 20, K.surface2);
  for (const y of [64, 69, 74]) s.rect(0, y, W, 1, K.line);
  s.rect(0, 77, W, 3, K.line);
  for (let x = 12; x < W; x += 24) s.rect(x, 78, 2, 1, K.bulbOff);
  // drum riser
  s.rect(74, 50, 44, 10, K.line);
  s.rect(74, 50, 44, 1, K.steel);
  // marquee board
  s.rect(72, 2, 48, 14, K.accent, { r: 1 }); s.rect(73, 3, 46, 12, K.bg);
  sign(s, 'HOUSE BAND', 96, 7, K.text);
}

/* ---------- characters ---------- */
// The body: original blob for A/B, Ray's pet for C. `top` = top of the body, h = body height (11 by default).
function body(s, role, cx, top, opt = {}) {
  const h = opt.h || 11, w = 12;
  const { c, d } = ROLE[role];
  if (s.px) {
    s.rect(cx - w / 2, top, w, h, c, { r: 2 });
    s.rect(cx - 4, top + 1, 2, 1, '#ffffff', { op: 0.45 });
  } else {
    s.rect(cx - w / 2, top, w, h, c, { vr: 5 });
    s.ellipse(cx - 2.6, top + 2.6, 2.2, 1.2, '#ffffff', { op: 0.3 });
  }
  // eyes + mouth
  const ey = top + 4 + (opt.blink ? 1 : 0);
  if (opt.blink) { s.rect(cx - 3, ey, 2, 1, K.ink); s.rect(cx + 1, ey, 2, 1, K.ink); }
  else if (s.px) { s.rect(cx - 3, ey, 1, 2, K.ink); s.rect(cx + 2, ey, 1, 2, K.ink); }
  else { s.ellipse(cx - 2.5, ey + 1, 0.75, 1.1, K.ink); s.ellipse(cx + 2.5, ey + 1, 0.75, 1.1, K.ink); }
  if (s.px) { s.dot(cx - 5, top + 7, d); s.dot(cx + 4, top + 7, d); }
  else { s.ellipse(cx - 4.3, top + 7.2, 1, 0.6, d, { op: 0.7 }); s.ellipse(cx + 4.3, top + 7.2, 1, 0.6, d, { op: 0.7 }); }
  if (opt.mouth) {
    if (s.px) s.rect(cx - 1, top + 7, 2, 1, K.ink);
    else s.raw(`<path d="M${cx - 1.2} ${top + 7} q1.2 1.4 2.4 0" fill="none" stroke="${K.ink}" stroke-width="0.6" stroke-linecap="round"/>`);
  }
}

// limbs and hands
function arm(s, role, x1, y1, x2, y2) {
  s.line(x1, y1, x2, y2, ROLE[role].d, s.px ? 1 : 1.1);
}
function hand(s, role, x, y) {
  if (s.px) s.rect(x - 1, y - 1, 2, 2, ROLE[role].c);
  else s.ellipse(x, y, 1.15, 1.15, ROLE[role].c);
}
function feet(s, role, cx, gy) {
  if (s.px) { s.rect(cx - 5, gy - 2, 3, 2, ROLE[role].d); s.rect(cx + 2, gy - 2, 3, 2, ROLE[role].d); }
  else { s.ellipse(cx - 3.4, gy - 1, 1.8, 1, ROLE[role].d); s.ellipse(cx + 3.4, gy - 1, 1.8, 1, ROLE[role].d); }
}
function stick(s, x1, y1, x2, y2) { s.line(x1, y1, x2, y2, K.stick, s.px ? 1 : 0.8, { ol: 0.3 }); }
const OLI = {};

/* Each member: n frames, frame index from the eighth-note counter e. */
const MEMBERS = [
  { id: 'keys', n: 4, draw(s, f) {
    const cx = 19, bob = f % 2 === 0 ? 1 : 0, top = 54 + bob;
    feet(s, 'keys', cx, 73);
    s.line(9, 67, 27, 73, K.steel, s.px ? 1 : 1.1); s.line(27, 67, 9, 73, K.steel, s.px ? 1 : 1.1);
    body(s, 'keys', cx, top, { h: 11 - bob });
    { // keys player: a beanie
      const c = ROLE.keys.d;
      if (s.px) { s.rect(cx - 5, top - 1, 10, 3, c, { r: 1 }); s.rect(cx - 1, top - 3, 2, 2, K.text); }
      else { s.raw(`<path d="M${cx - 5.4} ${top + 2} q5.4 -5.6 10.8 0 z" fill="${c}"/>`); s.ellipse(cx, top - 1.9, 1.3, 1.3, K.text); }
    }
    s.rect(6, 63, 26, 4, K.line, { r: s.px ? 0 : 0.6, ...OLI });
    s.rect(7, 63, 24, 2, K.text);
    for (const x of [8, 10, 13, 15, 17, 20, 22, 25, 27, 29]) s.rect(x, 63, 1, 1, K.ink);
    const L = f === 0 ? [14, 63] : [14, f === 2 ? 59 : 61];
    const Rr = f === 2 ? [24, 63] : [24, f === 0 ? 59 : 61];
    if (f === 0) s.rect(13, 64, 2, 1, K.accent);
    if (f === 2) s.rect(23, 64, 2, 1, K.accent);
    arm(s, 'keys', cx - 5, top + 6, L[0], L[1]); arm(s, 'keys', cx + 5, top + 6, Rr[0], Rr[1]);
    hand(s, 'keys', L[0], L[1]); hand(s, 'keys', Rr[0], Rr[1]);
  } },
  { id: 'bass', n: 2, draw(s, f) {
    const cx = 50, bob = f === 0 ? 1 : 0, top = 60 + bob;
    feet(s, 'bass', cx, 73);
    body(s, 'bass', cx, top, { h: 12 - bob, mouth: f === 0 });
    {
      const c = ROLE.bass.d;
      s.line(cx, top - 1, cx, top - 3, c, s.px ? 1 : 0.9); s.line(cx + 1, top - 1, cx + 3, top - 3, c, s.px ? 1 : 0.9);
    }
    s.line(cx - 1, 67, cx + 10, 60, K.woodDk, s.px ? 1 : 1, OLI);
    s.rect(cx + 9, 57, 2, 3, K.woodXd, { r: s.px ? 0 : 0.4 });
    s.ellipse(cx - 3, 68, 3.6, 2.6, K.wood, OLI);
    s.rect(cx - 4, 68, 2, 1, K.woodXd);
    const fret = [cx + 6, 62], pluck = f === 0 ? [cx - 2, 69] : [cx - 3, 66];
    arm(s, 'bass', cx + 5, top + 5, fret[0], fret[1]); arm(s, 'bass', cx - 5, top + 5, pluck[0], pluck[1]);
    hand(s, 'bass', fret[0], fret[1]); hand(s, 'bass', pluck[0], pluck[1]);
  } },
  { id: 'drums', n: 4, draw(s, f) {
    const cx = 96, bob = f % 2 === 0 ? 1 : 0, top = 34 + bob;
    body(s, 'drums', cx, top, { h: 11, mouth: f === 2 });
    { // drummer: little round ears
      const { c, d } = ROLE.drums;
      if (s.px) { s.rect(cx - 6, top - 2, 3, 3, c, { r: 1 }); s.rect(cx + 3, top - 2, 3, 3, c, { r: 1 }); s.dot(cx - 5, top - 1, d); s.dot(cx + 4, top - 1, d); }
      else { s.ellipse(cx - 4.5, top - 0.2, 1.7, 1.7, c); s.ellipse(cx + 4.5, top - 0.2, 1.7, 1.7, c); s.ellipse(cx - 4.5, top - 0.2, 0.8, 0.8, d); s.ellipse(cx + 4.5, top - 0.2, 0.8, 0.8, d); }
    }
    // crash (left), floor stands
    s.line(81, 38, 81, 50, K.steel, s.px ? 1 : 0.8);
    s.line(76, 38, 86, 37, K.brass, s.px ? 1 : 1.2, OLI);
    // hi-hat (right)
    s.line(110, 42, 110, 50, K.steel, s.px ? 1 : 0.8);
    const hatUp = f % 2 === 1;
    s.line(106, hatUp ? 40 : 41, 114, hatUp ? 40 : 41, K.brass, s.px ? 1 : 1.1, OLI);
    s.line(106, 43, 114, 43, K.brass, s.px ? 1 : 1.1, OLI);
    // snare (left of centre)
    s.line(88, 48, 88, 50, K.steel, s.px ? 1 : 0.8);
    s.rect(84, 45, 8, 3, K.text, { r: s.px ? 0 : 0.5, ...OLI });
    s.rect(84, 45, 8, 1, K.muted);
    // kick (front, centre)
    const kick = f === 0;
    s.ellipse(96, 50, 6.6, 6.6, K.line, OLI);
    s.ellipse(96, 50, 5.4, 5.4, kick ? '#fff6dc' : K.text);
    s.ellipse(96, 50, kick ? 3.2 : 2.4, kick ? 3.2 : 2.4, K.accent);
    // sticks: screen-right arm on the hat every eighth, screen-left arm on the snare on beats 2 and 4
    const Rh = f % 2 === 0 ? [106, 41] : [104, 36], Rt = f % 2 === 0 ? [110, 40.5] : [107, 32];
    const Lh = f === 2 ? [90, 44] : [89, 37], Lt = f === 2 ? [86, 44.5] : [86, 33];
    arm(s, 'drums', cx - 5, top + 6, Lh[0], Lh[1]); arm(s, 'drums', cx + 5, top + 6, Rh[0], Rh[1]);
    stick(s, Lh[0], Lh[1], Lt[0], Lt[1]); stick(s, Rh[0], Rh[1], Rt[0], Rt[1]);
    hand(s, 'drums', Lh[0], Lh[1]); hand(s, 'drums', Rh[0], Rh[1]);
  } },
  { id: 'synth', n: 4, draw(s, f) {
    const dx = [-1, 0, 1, 0][f], cx = 134 + dx, bob = f % 2 === 0 ? 1 : 0, top = 61 + bob, lit = f % 2 === 0;
    feet(s, 'synth', 134, 73);
    { // lead: antenna with a beat light
      s.line(cx, top - 1, cx, top - 3, ROLE.synth.d, s.px ? 1 : 0.8);
      if (s.px) s.rect(cx - 1, top - 5, 2, 2, lit ? K.accent : K.bulbOff);
      else s.ellipse(cx, top - 4, 1.2, 1.2, lit ? K.accent : K.bulbOff);
    }
    body(s, 'synth', cx, top, { h: 11 - bob, lit });
    // keytar
    s.line(cx - 8, 72, cx + 6, 68, K.line, 3, OLI);
    s.line(cx + 6, 68, cx + 11, 66, K.line, s.px ? 1 : 1.4, OLI);
    s.line(cx - 7, 71, cx + 4, 68, K.text, 1);
    s.rect(cx + 10, 64, 2, 2, ROLE.synth.c);
    const Lh = [cx + 9, 66.5], Rh = f % 2 === 0 ? [cx - 3, 70.5] : [cx - 2, 67];
    arm(s, 'synth', cx + 5, top + 5, Lh[0], Lh[1]); arm(s, 'synth', cx - 5, top + 5, Rh[0], Rh[1]);
    hand(s, 'synth', Lh[0], Lh[1]); hand(s, 'synth', Rh[0], Rh[1]);
  } },
  { id: 'bells', n: 4, draw(s, f) {
    const cx = 160, bob = f % 2 === 0 ? 1 : 0, top = 55 + bob;
    feet(s, 'bells', cx, 73);
    s.line(152, 70, 155, 73, K.steel, s.px ? 1 : 0.9); s.line(168, 70, 165, 73, K.steel, s.px ? 1 : 0.9);
    body(s, 'bells', cx, top, { h: 11, mouth: f === 0 });
    { // bells player: a bow
      const b = ROLE.synth.c, bd = ROLE.synth.d;
      if (s.px) { s.rect(cx - 4, top - 2, 3, 2, b); s.rect(cx + 1, top - 2, 3, 2, b); s.rect(cx - 1, top - 2, 2, 2, bd); }
      else { s.poly([[cx, top - 0.6], [cx - 4, top - 2.6], [cx - 4, top + 1.2]], b); s.poly([[cx, top - 0.6], [cx + 4, top - 2.6], [cx + 4, top + 1.2]], b); s.ellipse(cx, top - 0.6, 1, 1, bd); }
    }
    s.rect(150, 63, 20, 1, K.steel);
    const bars = ['#ff8fa3', '#f2b544', '#ffd77a', '#7fd6b0', '#6fb7ff', '#b9a3ff'];
    const hts = [7, 6, 6, 5, 5, 4];
    bars.forEach((c, i) => s.rect(151 + i * 3, 64, 2, hts[i], c, { r: s.px ? 0 : 0.3, ...OLI }));
    // mallets
    const Lh = f === 0 ? [152, 60] : [151, 57], Lhd = f === 0 ? [154.5, 62.5] : [153.5, 58.5];
    const Rh = f === 2 ? [168, 60] : [169, 57], Rhd = f === 2 ? [165.5, 62.5] : [166.5, 58.5];
    arm(s, 'bells', cx - 6, top + 7, Lh[0], Lh[1]); arm(s, 'bells', cx + 6, top + 7, Rh[0], Rh[1]);
    stick(s, Lh[0], Lh[1], Lhd[0], Lhd[1]); stick(s, Rh[0], Rh[1], Rhd[0], Rhd[1]);
    for (const m of [Lhd, Rhd]) {
      if (s.px) s.rect(m[0] - 1, m[1] - 1, 2, 2, K.text); else s.ellipse(m[0], m[1], 1.1, 1.1, K.text, OLI);
    }
    hand(s, 'bells', Lh[0], Lh[1]); hand(s, 'bells', Rh[0], Rh[1]);
    if (f === 0) sparkle(s, 156, 59); if (f === 2) sparkle(s, 164, 59);
  } },
  { id: 'sampler', n: 2, draw(s, f) {
    const cx = 181, nod = f === 0 ? 1 : 0, top = 49 + nod;
    body(s, 'sampler', cx, top, { h: 12, mouth: f === 0 });
    { // sampler: headphones
      const hc = K.pad;
      if (s.px) { s.rect(cx - 5, top - 1, 10, 1, hc); s.rect(cx - 7, top + 3, 2, 5, K.line); s.rect(cx + 5, top + 3, 2, 5, K.line); }
      else { s.raw(`<path d="M${cx - 6} ${top + 4.5} Q${cx - 6} ${top - 1.6} ${cx} ${top - 1.6} Q${cx + 6} ${top - 1.6} ${cx + 6} ${top + 4.5}" fill="none" stroke="${hc}" stroke-width="1"/>`); s.rect(cx - 7.4, top + 3, 2.4, 5, K.line, { vr: 1 }); s.rect(cx + 5, top + 3, 2.4, 5, K.line, { vr: 1 }); }
    }
    // crate of records, with sleeves sticking out on the left and a record on the front
    for (const [x, y, c] of [[170, 61, '#6fb7ff'], [172, 60, '#ff8fa3'], [174, 62, '#7fd6b0']]) s.rect(x, y, 2, 66 - y, c, OLI);
    s.rect(169, 66, 22, 8, K.woodDk, { r: s.px ? 0 : 0.5, ...OLI });
    s.rect(169, 68, 22, 1, K.woodXd); s.rect(169, 71, 22, 1, K.woodXd);
    s.ellipse(180, 70, 2.6, 2.6, K.ink); s.ellipse(180, 70, 0.9, 0.9, K.accent);
    // sampler box with pads
    s.rect(176, 62, 13, 4, K.line, { r: s.px ? 0 : 0.5, ...OLI });
    [177, 180, 183, 186].forEach((x, i) => s.rect(x, 63, 2, 1, (f === 0 && i === 1) ? K.accent : K.pad));
    const Lh = f === 0 ? [178, 62] : [175, 58], Rh = [186.5, 61.5];
    arm(s, 'sampler', cx - 6, top + 8, Lh[0], Lh[1]); arm(s, 'sampler', cx + 6, top + 8, Rh[0], Rh[1]);
    hand(s, 'sampler', Lh[0], Lh[1]); hand(s, 'sampler', Rh[0], Rh[1]);
  } },
  { id: 'fx', n: 4, draw(s, f) {
    // marquee bulbs swap on every beat; notes float up on the eighths
    const beat = Math.floor(f / 2);
    for (let i = 0, x = 73; x <= 118; x += 3, i++) {
      const on = (i + beat) % 2 === 0;
      for (const y of [2, 15]) { if (s.px) s.dot(x, y, on ? K.accent : K.bulbOff); else s.ellipse(x + 0.5, y + 0.5, 0.65, 0.65, on ? K.accent : K.bulbOff); }
    }
    note(s, 140 + (f % 2), 54 - f * 3, [1, 0.85, 0.6, 0.35][f]);
    const g = (f + 2) % 4;
    note(s, 26 - (g % 2), 52 - g * 3, [1, 0.85, 0.6, 0.35][g]);
  } },
];

function sparkle(s, x, y) {
  if (s.px) { s.dot(x, y - 1, K.text); s.dot(x - 1, y, K.text); s.dot(x + 1, y, K.text); s.dot(x, y + 1, K.text); s.dot(x, y, K.accent); }
  else s.raw(`<path d="M${x} ${y - 1.8} L${x + 0.5} ${y - 0.5} L${x + 1.8} ${y} L${x + 0.5} ${y + 0.5} L${x} ${y + 1.8} L${x - 0.5} ${y + 0.5} L${x - 1.8} ${y} L${x - 0.5} ${y - 0.5} Z" fill="${K.accent}"/>`);
}
function note(s, x, y, a) {
  if (s.px) { s.rect(x, y + 3, 2, 2, K.text, { op: a }); s.rect(x + 1, y, 1, 3, K.text, { op: a }); s.dot(x + 2, y, K.text, { op: a }); }
  else s.raw(`<g opacity="${a}" fill="${K.text}"><ellipse cx="${x + 1}" cy="${y + 4}" rx="1.25" ry="0.95" transform="rotate(-20 ${x + 1} ${y + 4})"/><rect x="${x + 1.85}" y="${y}" width="0.5" height="4"/><path d="M${x + 2.3} ${y} q1.6 0.6 1.2 2.2 q-0.2 -1 -1.2 -1.2z"/></g>`);
}

const STAGE_LABEL =
  'Pixel art: a little band of original round creatures on a stage under a House Band sign, playing keys, bass, drums, synth lead, bells and a sampler.';

function buildStageSvg() {
  const s = makeRenderer();
  scene(s);
  for (const m of MEMBERS) {
    s.raw(`<g class="m" data-m="${m.id}" data-n="${m.n}">`);
    for (let f = 0; f < m.n; f++) {
      s.raw(`<g class="fr" data-f="${f}"${f ? ' display="none"' : ''}>`);
      m.draw(s, f);
      s.raw('</g>');
    }
    s.raw('</g>');
  }
  const id = `band-stage-${Math.random().toString(36).slice(2, 9)}`;
  return `<svg id="${id}" class="stage look-pixel" viewBox="0 0 ${W} ${H}" role="img" aria-label="${STAGE_LABEL}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><g id="${id}-g">${s.out.join('')}</g></svg>`;
}

/** Close-up crops: each tile clips to its own member (no neighbour visible). */
export const CROPS = [
  ['keys', 0, 46, 34, 30],
  ['bass', 36, 48, 32, 30],
  ['drums', 76, 28, 40, 34],
  ['synth lead', 118, 46, 32, 30],
  ['bells', 147, 46, 22, 30],
  ['sampler', 168, 46, 24, 30],
];

export function buildCloseupsHtml(stageSvgId) {
  const gid = `${stageSvgId}-g`;
  return CROPS.map(([name, x, y, cw, ch]) =>
    `<figure class="band-crop"><svg class="crop" viewBox="${x} ${y} ${cw} ${ch}" width="${cw * 3}" height="${ch * 3}" shape-rendering="crispEdges" aria-hidden="true"><use href="#${gid}"/></svg><figcaption>${name}</figcaption></figure>`,
  ).join('');
}

/**
 * Mount the pixel band into `root`. Silent until Play loop is pressed.
 * Respects prefers-reduced-motion (still frame). Integer pixel scale.
 */
export function mountBand(root, opts = {}) {
  if (!root) return null;
  const showCloseups = !!opts.showCloseups;
  root.classList.add('band-hero');
  root.innerHTML =
    `<div class="band-stagebox" data-band-stage></div>` +
    `<div class="band-loop-row">` +
    `<button type="button" class="band-loop-btn" data-band-loop aria-label="Play the band loop">Play loop</button>` +
    `<span class="band-loop-meta" aria-hidden="true">120 BPM · 4 s</span>` +
    `</div>` +
    (showCloseups ? `<div class="band-lineup" data-band-lineup aria-hidden="true"></div>` : '');

  const stageBox = root.querySelector('[data-band-stage]');
  stageBox.innerHTML = buildStageSvg();
  const svg = stageBox.firstElementChild;
  if (showCloseups) {
    root.querySelector('[data-band-lineup]').innerHTML = buildCloseupsHtml(svg.id);
  }

  const rmQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let audio = null;
  let lastE = -1;
  const t0 = performance.now();
  let raf = 0;

  function fit() {
    // Target ×3 (576×240) on desktop per mockup; largest integer ≤3 that fits the box.
    const maxW = Math.max(stageBox.clientWidth || 0, root.clientWidth || 0, W);
    const sc = Math.max(1, Math.min(3, Math.floor(maxW / W)));
    svg.setAttribute('width', String(W * sc));
    svg.setAttribute('height', String(H * sc));
    svg.dataset.scale = String(sc);
  }

  function nowMs() {
    if (audio && audio.src) {
      const t = (audio.ctx.currentTime - (audio.ctx.outputLatency || 0) - audio.when) * 1000;
      return ((t % LOOP_MS) + LOOP_MS) % LOOP_MS;
    }
    return performance.now() - t0;
  }

  function still() {
    return rmQuery.matches;
  }

  function render(force) {
    const e = still() ? 0 : Math.floor(nowMs() / EIGHTH_MS);
    if (e === lastE && !force) return;
    lastE = e;
    svg.querySelectorAll('.m').forEach((g) => {
      const n = +g.dataset.n;
      const f = ((e % n) + n) % n;
      if (g.dataset.cur === String(f)) return;
      g.dataset.cur = String(f);
      for (const fr of g.children) {
        fr.setAttribute('display', fr.dataset.f === String(f) ? 'inline' : 'none');
      }
    });
  }

  function tick() {
    render(false);
    raf = requestAnimationFrame(tick);
  }

  const loopBtn = root.querySelector('[data-band-loop]');
  function syncPlayUi() {
    const on = !!(audio && audio.src);
    loopBtn.textContent = on ? 'Stop loop' : 'Play loop';
    loopBtn.setAttribute('aria-label', on ? 'Stop the band loop' : 'Play the band loop');
    loopBtn.setAttribute('aria-pressed', String(on));
  }

  async function toggleAudio() {
    if (audio && audio.src) {
      audio.src.stop();
      audio.src = null;
      syncPlayUi();
      return;
    }
    if (!audio) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const res = await fetch(LOOP_AUDIO_URL);
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      audio = { ctx, buf, src: null, when: 0 };
    }
    await audio.ctx.resume();
    const src = audio.ctx.createBufferSource();
    src.buffer = audio.buf;
    src.loop = true;
    // Encoder added 1 s of padding; audible loop is 1.0..5.0 like the mockup.
    src.loopStart = 1.0;
    src.loopEnd = 5.0;
    src.connect(audio.ctx.destination);
    audio.when = audio.ctx.currentTime + 0.05;
    src.start(audio.when, 1.0);
    audio.src = src;
    syncPlayUi();
  }

  loopBtn.addEventListener('click', () => {
    toggleAudio().catch((err) => console.error(err));
  });
  rmQuery.addEventListener('change', () => render(true));
  addEventListener('resize', fit);
  fit();
  render(true);
  raf = requestAnimationFrame(tick);

  return {
    fit,
    render,
    destroy() {
      cancelAnimationFrame(raf);
      removeEventListener('resize', fit);
      if (audio && audio.src) {
        try { audio.src.stop(); } catch { /* ignore */ }
      }
      if (audio && audio.ctx) audio.ctx.close().catch(() => {});
    },
  };
}

export { W, H, LOOP_MS, EIGHTH_MS };
