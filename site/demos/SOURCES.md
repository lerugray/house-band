# Demo sources (samples and co-write)

Every on-screen string in the Stageshow demos, with its source.

## Bring your own samples: `data-slot="demo-samples"`

Report format: PLAN.md (b); OSS-11 output format.

| What is shown | Source |
|---|---|
| Window title `house-band` | Product CLI name from PLAN.md (a) README / `bin/house-band.mjs` |
| Folder chip `MyDrums/` | PLAN.md (b) worked example path `~/Samples/MyDrums` and config id folder name |
| `$ house-band samples scan ~/Samples/MyDrums` | PLAN.md (b) three-command example (scan line) |
| `MAPPED kick.a <- Kicks/BD Tight.wav` | PLAN.md (b) report format; kit mapping `kick.a` / `Kicks/BD Tight.wav` in the samples.json example |
| `MAPPED snare.a <- Snares/SN 01.wav` | PLAN.md (b) report format; `snare.a` / `Snares/SN 01.wav` in the samples.json example |
| `MAPPED hat.closed <- Hats/CH.wav` | PLAN.md (b) report format; `hat.closed` / `Hats/CH.wav` in the samples.json example |
| `MAPPED hat.open <- Hats/OH.wav` | PLAN.md (b) report format; `hat.open` / `Hats/OH.wav` in the samples.json example |
| `MAPPED clap <- Claps/Clap 2.wav` | PLAN.md (b) report format; `clap` / `Claps/Clap 2.wav` (example uses `clap.default`) |
| `UNMAPPED tomLow (falls back to tr808)` | PLAN.md (b) report format example line; `fallbackKit` `tr808` |
| `UNMAPPED ride (falls back to tr808)` | PLAN.md (b) report format; ride lane + `fallbackKit` `tr808` |
| `$ house-band render song.json --kit-map tr707=user:my-drums` | PLAN.md (b) render + `--kit-map` example (`tr707=user:my-drums`); score name shortened to `song.json` for the stage |
| Label `song.wav` | Render payoff filename (matches `-o` style output named in the section copy) |

## Co-write: `data-slot="demo-cowrite"`

PLAN.md (c) co-write CLI and (e) section 3; Appendix N Maybe AN 2 from
`docs/listen/an-ray-pieces-s332/WHAT-TO-LISTEN-FOR.md` (appendix-n). Instrument names from the
real XRNS parse / OSS-18 import shape in appendix-n `tools/score/ray-s332/ray-maybean2.data.mjs`
(generated from `maybean2.xrns` Song.xml).

| What is shown | Source |
|---|---|
| Window title `house-band cowrite` | PLAN.md (c) CLI front door `house-band cowrite …`; card OSS-28 |
| File chip `maybean2.notes.xrns` | PLAN.md (c) notes-only public example; OSS-18 `examples/co-write/appendix-n/maybean2.notes.xrns`; card OSS-28 |
| `$ house-band cowrite import maybean2.notes.xrns` | PLAN.md (c) `house-band cowrite import song.xrns`; card OSS-28 |
| Lane `AU: Prophet V3 (Init)` | `ray-maybean2.data.mjs` `T0c0`/`T0c1` `inst`; WHAT-TO-LISTEN-FOR.md stand-ins table (Prophet bell) |
| Lane `AU: Mini V3 (Init)` | `ray-maybean2.data.mjs` `T1c0` `inst`; WHAT-TO-LISTEN-FOR.md (Mini bass) |
| Lane `AU: Buchla Easel V (Init)` | `ray-maybean2.data.mjs` `T3c0` `inst`; WHAT-TO-LISTEN-FOR.md (Buchla D drone) |
| Lane `BD 626 Color 01` | `ray-maybean2.data.mjs` `T2c0` `inst`; WHAT-TO-LISTEN-FOR.md (kick) |
| Note-block rows on yours lanes | First 8 bars (lines 0–127 at LPB 4) of the same `ray-maybean2.data.mjs` events, scaled to lane width |
| `$ house-band cowrite develop maybean2.source.json --form subtractive` | PLAN.md (c) develop + `--form subtractive` (Ray's Appendix N shape); card OSS-28 |
| Amber lanes `bass`, `pad`, `counter-line`, `drums` | PLAN.md (c) develop arranger parts; WHAT-TO-LISTEN-FOR.md Maybe AN 2 "House Band added" (bass/pad/counter/drums family); card OSS-28 |
| Section strip `A`, `B`, `C`, `A'`, `D` | PLAN.md (e) section 3 Maybe AN 2 markers; WHAT-TO-LISTEN-FOR.md Cue 2 sections |
| Caption on `A`: `yours, four passes, with drop-outs` | PLAN.md (c) "Ray's own Appendix N loop: A played four times…"; WHAT-TO-LISTEN-FOR.md "A (0:00) is your loop, all four of your passes… Pass 3's drop-out"; card OSS-28 |

Import also yields `Tambourine TOM 01` (`T4c0` in `ray-maybean2.data.mjs`). The stage shows four yours lanes per OSS-28 (Prophet, Mini, Buchla, BD).

## Vendored kit

`site/vendor/stageshow/` is Stageshow (MIT) from hammerstein-ai `8b6b825c` (upstream benjitaylor/skills `802057409787133703c56001080169e347305572` minus app icons and SVGs). See `site/vendor/stageshow/VENDORED.md`.
