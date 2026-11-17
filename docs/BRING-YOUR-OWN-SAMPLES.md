# Bring your own samples

Point House Band at a folder of WAVs you already own. It builds a canonical, hashed pack, then you render scores with that pack as a `user:` kit. Never commit commercial samples into this repository.

## What a pack is

A pack is a folder with `pack.json` and an `assets/` directory of PCM16LE mono 44.1 kHz WAVs. Identity is the pack's `contentSha256`: the same files always produce the same hash. Built-in packs live under `sample-packs/`. Packs you build are named `user-<id>` and live outside the repo (see Search path below). Scores name them as `user:<id>`. Pack format details: [M3-PACK-FORMAT.md](./M3-PACK-FORMAT.md).

## Three commands

```sh
house-band samples scan ~/Samples/my-drums
house-band samples build house-band.samples.json
house-band render my-song.json --kit-map tr707=user:my-drums -o my-song.wav
```

You can also put `"kit": "user:my-drums"` directly in a score instead of using `--kit-map`.

A worked example of a scanned drum folder lives at [examples/sample-mappings/generic-drum-folder/](../examples/sample-mappings/generic-drum-folder/README.md).

## Config format

`samples scan` writes `house-band.samples.json` (schema: [house-band.samples.schema.json](./schemas/house-band.samples.schema.json)). Example:

```json
{
  "format": "house-band-samples",
  "version": 1,
  "id": "my-drums",
  "displayName": "My drum folder",
  "source": { "type": "folder", "path": "/Users/me/Samples/my-drums" },
  "licence": "user-supplied; not for redistribution",
  "fallbackKit": "tr808",
  "kit": {
    "kick":  { "a": "Kicks/BD Tight.wav", "b": "Kicks/BD Long.wav" },
    "snare": { "a": "Snares/SN 01.wav" },
    "hat":   { "closed": "Hats/CH.wav", "open": "Hats/OH.wav" },
    "clap":  { "default": "Claps/Clap 2.wav" },
    "perc":  { "cowbell": "Perc/Cowbell.wav", "shaker": "Perc/Shaker.wav" }
  },
  "patches": {
    "my-keys": { "class": "pluck", "zones": "auto", "files": ["Keys/Rhodes C2.wav", "Keys/Rhodes C3.wav", "Keys/Rhodes C4.wav"] }
  }
}
```

Edit the JSON, then re-run `samples build`.

### Roles and variants

Drum lanes (House Band names):

| Role | Variants |
|---|---|
| kick | a, b |
| snare | a, b, flam |
| hat | closed, open |
| tomLow | default |
| tomMid | default |
| tomHigh | default |
| clap | default |
| rim | default |
| ride | default |
| crash | default |
| perc | anvil, bell, blip, brush, cabasa, castanets, chop, clang, clave, conga, conga-high, conga-low, cowbell, fm-tom, guiro, hiss, laser, maraca, perc-a, perc-b, shaker, simmons-tom, snap, sweep, tamb, tambourine, thump, tick, triangle, twang, woodblock, zap |

Pitched patches use class `pad`, `bass`, `lead`, `pluck`, or `bell`. `"zones": "auto"` takes root notes from the WAV `smpl` chunk when present, else measured pitch, else a note name in the filename; zones split halfway between neighbouring roots.

## Report lines

`samples scan` prints a report (also `house-band.samples.report.json` beside the config):

| Line | Meaning | What to do |
|---|---|---|
| `MAPPED kick.a <- Kicks/BD Tight.wav (token "bd" in filename)` | Role assigned | Keep or change the path in the JSON |
| `UNMAPPED tomLow (falls back to tr808)` | No file for this lane | Add a file path under that role, or accept the fallback kit |
| `AMBIGUOUS snare.a: 3 candidates, picked Snares/SN 01.wav` | Several matches; shortest path then alphabetical wins | Confirm the pick or point at another file |
| `UNUSED 41 files` | WAVs not mapped (listed in the JSON report) | Map them, ignore them, or delete them from the folder |
| `UNSUPPORTED 3 files (.aif)` | Not WAV in v1 | Convert, e.g. `ffmpeg -i in.aif -c:a pcm_s16le out.wav` |

## Search path and `HOUSE_BAND_PACKS`

Packs are found in order:

1. Repo `sample-packs/`
2. Each directory in `$HOUSE_BAND_PACKS` (split on the platform path delimiter)
3. `~/.house-band/packs/`

`samples build` writes into the first `$HOUSE_BAND_PACKS` entry, or `~/.house-band/packs/` when that env var is empty. List installed packs with `house-band samples list`.

A missing pack fails with which pack is needed, which kit or patch needs it, and the two fixes: build it from your own library, or `--kit-map` it to a synth kit.

## SFZ and SF2

Import an SFZ or SF2 into an ordinary `house-band.samples.json`, then `samples build` as usual:

```sh
house-band samples from-sfz voice.sfz --class pluck
house-band samples from-sf2 bank.sf2 --class pad --preset 0
```

SFZ v1 subset: `<control> default_path`, `<global>`, `<group>`, `<region>` with `sample`, `key`, `lokey`, `hikey`, `pitch_keycenter`, and `lovel`/`hivel` (loudest velocity layer only). Other opcodes are listed in the report. SF2 v1 subset: one preset by name or index; samples are written as WAVs beside the config.

## Samples From Mars mapping

If you own Essential WAV From Mars, rebuild Ray's commercial-backed packs byte-identically:

```sh
house-band samples build-mapping --mapping examples/sample-mappings/samples-from-mars --input "<library root>"
```

See `examples/sample-mappings/samples-from-mars/README.md` once that mapping ships (OSS-09). No commercial audio is stored in this repository; the mapping files name expected hashes only.

## Determinism

A user pack is canonical and hashed like any other. The same files and the same score give the same WAV within the toolchain scope described in [DETERMINISM.md](./DETERMINISM.md). Built-in kit identity shas do not change: user kits live outside `src/presets/`.

## Never commit commercial samples

Do not copy Samples From Mars, BBC Symphony Orchestra, LABS, or any other commercial library into this repo, a fixture, or the site. `samples build` refuses to write into the repo's `sample-packs/` directory so commercial audio cannot land there by accident. Keep user packs under `$HOUSE_BAND_PACKS` or `~/.house-band/packs/` (`.house-band/` is gitignored).
