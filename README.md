# House Band

Music written as code. Scores are readable JSON; a deterministic WebAudio band plays them; you can bring your own samples and your own songs.

[Listen first](https://lerugray.github.io/house-band/) · [Try it in your browser](https://lerugray.github.io/house-band/audition-room.html) (paste a score, nothing to install) · [See an LLM write one](https://lerugray.github.io/house-band/#llm)

## What it is

A score is authored data (tracks, steps, notes, kit and patch choices, a seed). The renderer is deterministic within a pinned toolchain and writes a WAV plus a `.manifest.json` custody record. 14 drum kits (7 synthesised, 7 sampled), 32 instrument patches, an FX suite, a Performance-Pass. An LLM is optional and only ever writes a score; there is no prompt-to-audio path.

## Quick start

Node 22+. Then:

```sh
git clone https://github.com/lerugray/house-band.git
cd house-band
npm ci
node bin/house-band.mjs render examples/demo-spec.json -o demo.wav
```

Expected output (paths and byte counts vary):

```text
wrote demo.wav (<bytes> bytes)
wrote demo.wav.manifest.json (sha256 <hex>)
```

## Render a score

Score format: [docs/M2-INTERFACE.md](./docs/M2-INTERFACE.md). Use `--kit-map a=b[,c=d]` to substitute kits at render time without editing the score. Every render writes a `.manifest.json` beside the WAV. Determinism is scoped to a pinned Node, OS, architecture, and WebAudio engine; see [docs/DETERMINISM.md](./docs/DETERMINISM.md) for the exact custody profile and what is (and is not) promised across machines.

## Audition Room and Composer's Desk

Audition Room: [open it on the site](https://lerugray.github.io/house-band/audition-room.html), or build it locally with `node app/build.mjs` and open `dist/audition-room.html` (no server). Load, drop or paste a score (the Paste score button, or Ctrl/Cmd+V anywhere); `?score=<path>` opens a score from the same site.

A real Desk run, with the exact prompt, the model's score and the render: [`site/llm/`](./site/llm/README.md).

Desk: `npm run desk-server`. Provider profiles read keys from the House Band env file (`HOUSE_BAND_ENV_FILE` or `~/.config/house-band/.env`): Claude Code OAuth (`CLAUDE_CODE_OAUTH_TOKEN` or the name in `HOUSE_BAND_CLAUDE_TOKEN_VAR`), Anthropic (`ANTHROPIC_API_KEY`), DeepSeek, Ollama Cloud, or a custom OpenAI-compatible endpoint (`HOUSE_BAND_LLM_*`). The deterministic test double works with no key.

## Plug in your own samples

```sh
node bin/house-band.mjs samples scan ~/Samples/my-drums
node bin/house-band.mjs samples build house-band.samples.json
node bin/house-band.mjs render my-song.json --kit-map tr707=user:my-drums -o my-song.wav
```

Full guide: `docs/BRING-YOUR-OWN-SAMPLES.md`. The seven sampled kits that need Samples From Mars (`linndrum`, `cr78`, `vinyl-indie`, `found-wood`, `dystopian-tech`, `synare-sds`, `tr707`) rebuild from your own library with `node bin/house-band.mjs samples build-mapping` and the example mappings under `examples/sample-mappings/samples-from-mars/`.

## Co-write from your own tracks

```sh
node bin/house-band.mjs cowrite import song.xrns -o song.source.json
node bin/house-band.mjs cowrite as-written song.source.json -o before.wav
node bin/house-band.mjs cowrite develop song.source.json --form subtractive -o out/
```

The Appendix N example shows notes-only Renoise input kept as the user's layer, then developed into a full arrangement. Guide: `docs/CO-WRITE.md`.

## Style from your catalog

Planned, not in this release: learn a style profile from many of your pieces and pass it into compose, Desk, and co-write. Co-write keeps one piece's notes; style-from-catalog does not quote them. Status will track the public issue tracker after publish.

## Kits and patches

### Kits

| id | title | kind | sample source |
|---|---|---|---|
| `tr808` | 808-style | synth | - |
| `tr909` | 909-style | synth | - |
| `dusty-lofi` | Dusty lo-fi | synth | - |
| `brushed-jazz` | Brushed jazz | synth | - |
| `industrial` | Industrial / metallic | synth | - |
| `chip8` | Chip / console | synth | - |
| `orchestral` | Orchestral percussion | synth | - |
| `linndrum` | LinnDrum (sampled) | sampled | needs Samples From Mars (your own copy; see Plug in your own samples) |
| `cr78` | CR-78 rhythm box (sampled) | sampled | needs Samples From Mars (your own copy; see Plug in your own samples) |
| `vinyl-indie` | Vinyl indie (acoustic drums) | sampled | needs Samples From Mars (your own copy; see Plug in your own samples) |
| `found-wood` | Found wood and tin (found-sound kit) | sampled | needs Samples From Mars (your own copy; see Plug in your own samples) |
| `dystopian-tech` | Dystopian tech (modular and vintage machines) | sampled | needs Samples From Mars (your own copy; see Plug in your own samples) |
| `synare-sds` | Synare and Simmons electro (sampled) | sampled | needs Samples From Mars (your own copy; see Plug in your own samples) |
| `tr707` | TR-707 (sampled) | sampled | needs Samples From Mars (your own copy; see Plug in your own samples) |

### Patches

**pad:** `glass-fm`, `supersaw-wall`, `choir-ah`, `drawbar-organ`, `breath-wash`, `mint-swell` (sampled from Ray Weiss's own instruments (included))

**bass:** `reese`, `fm-dx-bass`, `sub-sine`, `pwm-growl`, `string-bass`, `ms20-bass` (sampled from Ray Weiss's own instruments (included))

**lead:** `fm-brass`, `pwm-square`, `reed-oboe`, `breath-flute`, `supersaw-lead`, `sor-saw` (sampled from Ray Weiss's own instruments (included)), `ms20-square` (sampled from Ray Weiss's own instruments (included))

**pluck:** `karplus-string`, `fm-marimba`, `kalimba`, `bottle-tick`, `humbucker-guitar` (sampled from Ray Weiss's own instruments (included)), `snes-rhodes` (sampled from Ray Weiss's own instruments (included))

**bell:** `fm-glass-bell`, `tubular-chime`, `glass-harmonica`, `music-box`, `gamelan`, `sawbells` (sampled from Ray Weiss's own instruments (included)), `ms20-bell` (sampled from Ray Weiss's own instruments (included))

## Licence and credits

- Code: MIT (see [LICENSE](./LICENSE)).
- Sample packs `sampler-demo-17`, `tv-patch-microfreak`, `tv-patch-ms20` and the example scores in `examples/`: CC BY 4.0; credit Ray Weiss and House Band (see [NOTICE.md](./NOTICE.md)).
- Fonts `NotJam*`: CC0 1.0.
- `hb-synth-oneshots`: CC0 1.0 (generated by code).
- Stageshow under `site/vendor/stageshow/`: MIT.

No samples from commercial libraries are distributed here.

## Contributing

Tests (`npm test`), the composing laws in [docs/COMPOSING-LAWS.md](./docs/COMPOSING-LAWS.md), and how to propose a kit are in [CONTRIBUTING.md](./CONTRIBUTING.md).
