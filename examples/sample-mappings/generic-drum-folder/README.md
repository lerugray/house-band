# Generic drum folder (worked example)

This folder holds the `house-band.samples.json` that `samples scan` writes for the OSS-11 acceptance fixture (a small drum-and-keys tree). The WAV files themselves are not shipped here; regenerate them in a local folder if you want to re-run scan or build.

## Folder tree

```text
drum-folder/
  Kicks/
    BD Long.wav
    BD Tight.wav
  Keys/
    Rhodes C3.wav
    Rhodes C4.wav
  Loops/
    kick loop.wav          (unused: longer than 2.0 s drum rule)
  Pads/
    warm.wav               (unused: long, no drum token)
  perc/
    cowbell.wav
  HH closed.wav
  OH.wav
  Snare 01.wav
  notes.aif                (unsupported)
```

## Scan

```sh
house-band samples scan ./drum-folder --out house-band.samples.json --id scan-fixture
```

Typical report lines:

```text
MAPPED hat.open <- OH.wav (token "oh")
MAPPED hat.closed <- HH closed.wav (token "hh")
MAPPED kick.a <- Kicks/BD Long.wav (token "bd")
MAPPED kick.b <- Kicks/BD Tight.wav (token "bd")
MAPPED snare.a <- Snare 01.wav (token "snare")
MAPPED perc.cowbell <- perc/cowbell.wav (token "cowbell")
MAPPED patch.keys <- Keys/Rhodes C3.wav (pitched)
MAPPED patch.keys <- Keys/Rhodes C4.wav (pitched)
UNMAPPED tomLow (falls back to tr808)
UNMAPPED tomMid (falls back to tr808)
UNMAPPED tomHigh (falls back to tr808)
UNMAPPED clap (falls back to tr808)
UNMAPPED rim (falls back to tr808)
UNMAPPED ride (falls back to tr808)
UNMAPPED crash (falls back to tr808)
UNUSED 2 files
UNSUPPORTED 1 files
```

The checked-in [house-band.samples.json](./house-band.samples.json) matches that mapping (`source.path` is `./drum-folder` relative to this example).

## Build and render

```sh
house-band samples build examples/sample-mappings/generic-drum-folder/house-band.samples.json
house-band render examples/demo-spec.json --kit-map tr808=user:scan-fixture -o /tmp/with-user-kit.wav
```

`samples build` writes pack `user-scan-fixture` into the first `$HOUSE_BAND_PACKS` entry or `~/.house-band/packs/`. It will not write into the repo `sample-packs/` directory. Full guide: [docs/BRING-YOUR-OWN-SAMPLES.md](../../../docs/BRING-YOUR-OWN-SAMPLES.md).
