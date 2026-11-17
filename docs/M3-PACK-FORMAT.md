# Sample-pack format

Format identity: `house-band-sample-pack`, versions `1.0.0` and `1.1.0`.

- **1.0.0** — the M3 tranche-1 one-shot format: percussion assets on the
  `kick` / `snare` / `hat` lanes, no pitch identity. Still fully supported and
  **byte-frozen**: shipped scores pin these packs' manifest hashes, so the older
  field set is validated exactly as it always was rather than migrated.
- **1.1.0** — adds pitched material (kit 1.7.0). Assets may declare the
  `sampler` voice class and carry a root note, which is what a zone map binds
  against. See [§Pitched assets](#pitched-assets-110).

The sidecar is a directory containing `pack.json` and one canonical asset at
`assets/<asset-id>.wav` for every manifest entry. No other files are admitted by
the runtime validator.

Canonical assets are exactly PCM format 1, signed 16-bit little-endian,
44,100 Hz, mono RIFF/WAVE files. The `fmt ` chunk is first and exactly 16 bytes;
the `data` chunk follows immediately. The file therefore has a 44-byte header,
no other chunks, no padding, and a RIFF size equal to the file length minus 8.

`manifestSha256` is SHA-256 over UTF-8 canonical sorted-key JSON after omitting
only the top-level `manifestSha256` field. `contentSha256` is SHA-256 over assets
sorted lexically by asset id and framed, per asset, as:

1. unsigned 32-bit big-endian UTF-8 asset-id byte length;
2. asset-id UTF-8 bytes;
3. unsigned 32-bit big-endian canonical WAV byte length;
4. canonical WAV bytes.

Each asset also records SHA-256 over its complete canonical WAV and separately
over the raw PCM bytes beginning at byte 44. These definitions are implemented
once in `src/sample-pack.mjs` and used by the builder, CLI renderer, and browser.

## Pitched assets (1.1.0)

A 1.1.0 asset carries three extra fields:

| Field | Meaning |
|---|---|
| `rootNote` | MIDI integer the sample sounds at, or `null` for percussion |
| `rootNoteSource` | how the root was established: `filename`, `measured`, `measured-override`, `declared`, or `none` |
| `measuredF0Millihertz` | the measured fundamental as an integer, or `null` |

`suggestedVoice` widens from `kick | snare | hat` to those plus `sampler`. A
`sampler` asset must have an integer `rootNote`; a percussion asset must declare
`rootNote: null` and `rootNoteSource: "none"`.

**Root notes are measured, not trusted.** Filename labels are a convenience and
are routinely wrong — the timbre catalog found three of four Essential WAV From
Mars octave labels off by an octave, and building this pack found every SNES
RHODES file labelled an octave above its actual pitch. So the builder measures
f0 (YIN, `tools/pitch.mjs`) and **the measurement wins** over a parsed filename
label, recording the disagreement in `transformLog`, in `rootNoteSource`, and in
the builder's stderr warnings and `labelDisagreements` count. An explicit
`rootNote` in the pack metadata is an operator decision and does override the
measurement — but the disagreement is still reported, because a silently
overridden measurement is the exact thing this check exists to surface.

Everything that reaches a manifest field is computed with IEEE-754 `+ - * /`
and integer operations only. Those are correctly rounded and therefore
bit-identical on every conforming engine, whereas `Math.pow` / `Math.cos` are
implementation defined. That is why pitch measurement is YIN rather than an FFT,
and why cents appear only in human-facing warnings, never in the manifest.

## Optional build controls

| Metadata field | Effect |
|---|---|
| `rootNote` | operator-declared MIDI root, overriding both label and measurement |
| `maxSeconds` | head-trim the canonical asset to this length with a 441-frame linear tail fade |

`maxSeconds` exists because embed cost is the binding constraint on sampled
voices in single-file game builds: canonical audio costs 88.2 kB per second, so
a 6 s MicroFreak note is 529 kB untrimmed and about 141 kB kept to its audible
1.6 s.

Build command:

```sh
node tools/build-pack.mjs --input <wav-root> --metadata <pack-build.json> --out <empty-directory>
```

The builder accepts metadata-listed mono/stereo uncompressed PCM
8/16/24/32-bit or IEEE float32 WAV sources. It deterministically downmixes by
arithmetic mean, linearly resamples when needed, and quantizes nearest with ties
away from zero, without dither or implicit gain. Unsupported inputs and any
conversion that would clip are rejected with a path-specific error.
