# Co-write

Bring your own piece. House Band keeps your notes and develops an arrangement around them.
Output is a House Band score, a WAV, an arrangement MIDI, and a co-write report.

Co-write starts from one piece and keeps its notes. Style-from-catalog (planned, milestone M5)
reads many of your pieces and writes new music in your manner without quoting them; it is a
separate feature (`style learn`, then `--style` on develop). This release ships co-write only.

## Import

```sh
house-band cowrite import song.mid -o song.source.json
# also: .midi now; .xrns .mod .s3m .xm .it as those importers land
```

Writes a `house-band-source-song` JSON: tempo, time signature, tracks with role guesses
(melody, bass, chords, drums, other) and notes `{ beat, lengthBeats, midi, velocity, offsetMs }`.
Importers never extract samples from modules or Renoise files.

## As-written

```sh
house-band cowrite as-written song.source.json -o before.wav [--kit tr808] [--score-out score.json]
```

Your notes on the score's 16th-note grid, plain stand-in voices (melody as lead, bass as bass,
chords as pad, drums by GM note or instrument name). Timing leftovers become `nudge` (capped at
plus or minus 50 ms). This is the "before" listen: nothing added yet.

## Develop

```sh
house-band cowrite develop song.source.json -o out/ \
  [--engine arranger|llm] [--form loop|subtractive|aba|abac] \
  [--drafts sketch1.mid sketch2.mid] [--brief "slow, rainy, small band"] \
  [--length <bars>] [--kit tr808] [--seed 1] [--profile <desk profile>] \
  [--credit "Your Name"]
```

Writes `out/score.json`, `out/score.wav` (+ manifest), `out/develop.json`, `out/arrangement.mid`,
and `out/CO-WRITE-REPORT.md`.

| Flag | Default | Meaning |
|---|---|---|
| `--engine` | `arranger` | `arranger` is deterministic and offline; `llm` uses a Desk profile |
| `--form` | `subtractive` | `loop` (A x N), `subtractive` (A x 4 with planned drop-outs), `aba`, `abac` |
| `--drafts` | none | Extra source-song or MIDI files; they become B and C |
| `--brief` | none | Free text; the llm engine reads it; the arranger records it only |
| `--length` | form length | Grow the cue by adding sections; never stretches your notes |
| `--kit` | `tr808` | Drum kit id |
| `--seed` | `1` | Deterministic seed for the arranger |
| `--profile` | Desk default | Desk provider when `--engine llm` |
| `--credit` | `the author` | Name in the report credit line |

### The keep-layer promise

Every note from your chosen tracks appears in the output score at the same pitch class and beat
(octave folds into the playing voice's range are allowed and listed). Those steps carry
`"origin": "user"`. Everything House Band adds carries `"origin": "house-band"`. A broken keep
layer refuses to render (exit 3) and still writes `develop.json` so you can inspect it.

### The report

`CO-WRITE-REPORT.md` lists credit, a per-section table (start time, bars, what is yours, what was
added), every octave fold and re-strike, integrated LUFS and sample peak of the WAV, and the
output files.

### Arrangement MIDI

`arrangement.mid` is SMF type 1, PPQ 480: a tempo/time-signature track, then one track per score
track that has notes, named `<track> (yours)` or `<track> (added)` by majority origin. Drum
voices use MIDI channel 10 with GM percussion notes; other parts use GM programs by voice. Open
it in your DAW or tracker, or re-import with `cowrite import`.

## Appendix N example

Ray Weiss's combat loop "maybean2" (notes only, CC BY 4.0) ships as a source-song fixture. Credit
line: "Music by Ray Weiss and House Band".

```sh
node tools/cowrite/as-written.mjs test/fixtures/cowrite/maybean2.source.json -o maybean2-as-written.wav
node tools/cowrite/develop.mjs test/fixtures/cowrite/maybean2.source.json -o out/ --credit "Ray Weiss"
```

When the notes-only Renoise examples land under `examples/co-write/appendix-n/`:

```sh
house-band cowrite import examples/co-write/appendix-n/maybean2.notes.xrns -o maybean2.source.json
house-band cowrite as-written maybean2.source.json -o before.wav
house-band cowrite develop maybean2.source.json --form subtractive --credit "Ray Weiss" -o out/
```

First Decent (title theme) uses the same flow with drafts for B material when those example files
are present (`ANfirstdecent.notes.xrns` with drafts `anexperiment` / `ANattempt1`).
