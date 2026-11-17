# House Band landing page

Static site for the public House Band landing page. No framework, no build step, no external
requests from the page itself.

## Layout

- `index.html` / `styles.css` / `main.js` — the page (eight sections from the open-source plan)
- `band.js` — variant A pixel band in the hero (integer ×3, silent until Play loop)
- `band-loop.spec.json` / `audio/band-loop.mp3` — 4 s / 120 BPM synth loop for the band
- `tools/serve.mjs` — local static server on `127.0.0.1:4173` (or `PORT`)
- `tools/screens.mjs` — Playwright screenshots into `screens/`
- `tools/look-gate.mjs` — layout and a11y checks at 1280x720, 1400x730, 1600x900

Slots are marked with `data-slot` placeholders.

## Commands

```bash
node site/tools/serve.mjs
node site/tools/look-gate.mjs
node site/tools/screens.mjs
```

## Page-only audio (not in the public repo)

The Darkness and Appendix N soundtrack renders (`audio/darkness/`, `audio/appendix-n/`, `audio/ab/`,
`audio/examples/`) are all rights reserved and streamed on this page only. They are not in the public
repository: `.github/workflows/pages.yml` copies them into the Pages deploy artifact with
`node site/tools/stage-page-audio.mjs <source audio dir>`, which checks every file's sha256 against
`SOURCES.md`. To preview the full page locally, stage them the same way first; without them those players
have no audio.

Set `CHROMIUM_PATH` to an installed Chromium/Chrome binary if Playwright should not download one.
Launch args always include `--mute-audio`.

## Share image

`og.png` (1200x630) is the page's own pixel band (band.js, code-drawn) captured mid-loop and set beside the title; used for og:image and twitter:image.
