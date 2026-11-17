# House Band lead-balance gate (kit-level, fleet-anchored)

`node tools/lead-balance/lead-balance.mjs` measures a rendered score's lead against its
accompaniment the way the Lead-Balance Law says to - **RMS ratio in 300-4000 Hz from rendered
stems**, never broadband, never score gains - and returns GREEN or RED against caps anchored to
the House Band scores Ray has ACCEPTED. It is the enforcement tooth the law lacked at the kit
level. Exit 0 GREEN, 1 RED, 2 measurement unavailable / usage.

## Why it exists (2026-09-04)

A fleet project score was ruled NO ("some incredibly loud leads AGAIN"). The word AGAIN is
the finding. Until this tool the kit's only gate was `tools/score-audit` (note data, no render)
and every per-game Gate A port derived its cap from **that game's own ear-passed tracks** -
"worst passing track + 2 dB" (several sample projects all do this; the
v2 methodology spec formalises it as per-game KEEPs). That is a regression guard for a score
that has already passed. It cannot see the case that keeps reaching the operator: a NEW score
with no passed sibling, hot everywhere, whose first render goes to Ray's ear ungated. That
project ported no gate at all and reported per-voice **broadband** RMS - the exact blind spot
the law names - so its bell read "quiet" (-37.6 dBFS RMS) while sitting +16 dB over the bed in
the melody band whenever it struck.

## What it measures

Windows of 0.4 s (hop 0.2 s). A window is **eligible** only when BOTH the lead and the bed are
sounding in the band: each stem above -72 dBFS in-band and within 35 dB of its own loud
windows, and the bed carrying at least -30 dB of its broadband energy in 300-4000 Hz (a
sub-bass-only bed is not a bed - methodology v2 s3.5). Excluded windows are reported by kind,
never called hot or quiet. Then:

| metric | meaning |
|---|---|
| `inBandMeanDb` | energy ratio lead/bed in 300-4000 Hz over eligible windows |
| `loudestDecileDb` | mean per-window ratio over the loudest tenth of lead windows (the fleet's Gate A number) |
| `p90WindowDb` | 90th percentile of the per-window ratio |
| `hotWindowFraction` | share of eligible windows where the lead exceeds the bed by more than 6 dB |
| `leadCrestOverBedDb` | lead in-band peak vs bed in-band RMS - the strike a limiter later lifts |
| `leadCentroidHz` / `bedCentroidHz` | the brightness clause's numbers |
| `perSection` | the distribution on a section grid (`--section-seconds`); the mean is not the measurement |

## The fleet caps, and the table they come from

Every number below was measured through this file on 2026-09-04 (22.05 or 44.1 kHz stems; the
biquads scale with the rate). "Lead" for that project = the three path voices (Ember bell,
Tide bowed pair, Veil stopped tone); "bed" = Stone (pedal + floor) and the wood pulse.

| score | Ray's verdict | in-band mean | loudest decile | p90 window | windows > 6 dB | lead peak over bed RMS | lead / bed centroid |
|---|---|---|---|---|---|---|---|
| fleet project round 1, paths E+T+V over S+P | **NO** ("incredibly loud leads again") | **+13.27** | **+24.47** | +24.03 | **86%** | **+31.2** | 473 / 169 Hz |
| fleet project round 1, Ember+Veil over the rest | NO (same render) | **+6.86** | **+16.36** | +19.24 | **49%** | +21.6 | 1138 / 229 Hz |
| accepted strategy score v6 level 1 / 2 / 3 | PASS ("passes now" 09-02; "really happy with the music" 09-03) | +0.87 / +2.39 / +2.55 | +6.74 / +5.57 / +5.65 | +7.68 / +6.49 / +6.29 | 15% / 13% / 11% | +22.3 / +22.9 / +21.1 | 290/388, 288/400, 333/442 |
| lobby sample project / closed | PASS ("sounds great", first listen, 08-14) | -4.73 / -6.31 | +2.36 / +3.96 | +2.99 / +0.24 | 4% / 7% | +11.2 / +9.1 | 678/149, 722/144 |
| certified title theme (its own probe, documented in scripts/lead-balance.py) | CERTIFIED at +3.03; the +3.15 sibling REJECTED | +3.03 (sections 3.91 / 2.91 / 1.67 / 3.35) vs rejected +3.15 (4.15 / 0.83 / 3.97 / 3.53) | under +7 | - | - | - | lead brighter than bed |
| fleet project round 2 (the recompose, full cycle) | not yet heard | -2.84 | +2.05 | +1.09 | 1% | +19.7 | 246 / 276 Hz |

Caps (`FLEET_CAPS`): worst accepted value plus a repeatability margin, never looser than the
standing law:

- `inBandMeanDb` 4.0, and **3.1 when the lead is brighter than its bed** (`brightnessClauseDb`
  0.9) - the clause lands exactly between the certified theme's accepted +3.03 and rejected +3.15.
- `loudestDecileDb` 7.0 - the law's own ceiling; accepted max +6.74.
- `p90WindowDb` 8.5 - accepted max +7.68.
- `hotWindowFraction` 0.25 - accepted max 15%.
- `leadCrestOverBedDb` 26 - accepted max +22.9.
- worst complete section may sit 1.0 dB over the mean cap, never more - accepted worst section
  3.91 passes, rejected worst 4.15 fails.

A per-game KEEP (methodology v2 s4) may pass `--caps caps.json` to override for THAT game;
a new score with no KEEP gets the fleet caps and nothing else. Rendering rate, window count and
exclusions are in the JSON so a cap change can be audited.

## Usage

```sh
# stems named <tag>-<voice>.f32.wav; every voice not named --lead-voices is the bed
node tools/lead-balance/lead-balance.mjs --stems-dir runs/stems --tag r2 --lead-voices Ember,Tide,Veil --section-seconds 115.2 --json out.json
# explicit stems
node tools/lead-balance/lead-balance.mjs --lead lead.wav --bed pad.wav,bass.wav --full mix.wav
# a listen set that ships A/B mutes: lead = full minus lead-muted
node tools/lead-balance/lead-balance.mjs --mix full.raw.wav --lead-muted lead-muted.raw.wav
```

Port into a game the way the kit is ported: copy this file beside the game's render tooling,
record its sha256, render stems through the game's OWN scheduler (solo by filtering the event
list, never a second DSP path), run the gate, and bank the JSON with the source hashes so the
battery fails when the score changes without a re-measure. Tests: `test/lead-balance.test.mjs`
(synthetic stems at known ratios: GREEN at +2, RED at +9, RED on a hot section under a passing
mean, sub-bass beds and solos reported unavailable, mix-minus-muted recovers the lead).

---

# The SPIKE gate and the PERCUSSION gate (round 3, 2026-09-04)

`node tools/lead-balance/derive-peak-caps.mjs` derives, and `measureSubject()` / `gradeSubject()`
apply, two further gates. They exist because the lead-balance gate above **read GREEN on a render
Ray then ruled against**, and it was not lying: measured as lead-over-bed, fleet project round 2
sits BETTER than an accepted strategy score v6 he praised. His words on round 2:

> *"the percussion/highhat is a little too loud compared to everything else ... later on in the
> first track the lead eventually spikes and is way too loud again on some mallet instrument, so
> that isn't really fixed either."*

Two structural blind spots, both now measured:

**1. A ratio to the bed is not a spike.** A spike is a voice standing far above ITS OWN normal
level, once, late. Means, deciles and p90s over a ten-minute render cannot see it, and neither
can a peak-over-bed ratio (a bell's crest factor dominates that statistic everywhere).

**A METRIC WAS TRIED HERE AND FALSIFIED, and the falsification is the finding.** The first cut
graded `selfOutlierDb` - p99.5 minus median of a voice's own 250 ms level over its sounding
windows - which read **+18.88 dB** on fleet project round 2's mallet against **+3.05 to +7.36**
for every accepted subject. That looked like the operator's complaint caught cold. It was not.
Measured NOTE BY NOTE, round 2's bell is one of the most consistent voices in the fleet: its
loudest note stands 5.44 dB over its median note. The 18.88 came from the denominator - a bell
that strikes three times in four bars spends most of its sounding windows in a decay tail, so
its median window is a tail and its p99.5 is an attack. **The metric was measuring note
density**, every accepted score it was anchored on is dense, and a cap built on it would have
failed any sparse struck voice in the fleet forever. It is demoted to a reported number and
replaced by `noteSpreadDb`, the same question asked note against note.

**The metric that actually catches what the operator described is `localProminenceMaxDb`** - the
voice's 250 ms level against the FULL MIX's own 3 s running level at that moment. Round 2's
mallet: **+7.04 dB**, at 556.8 s, which is bar 116 of 120 - the first bar of the score's
four-bar thinning into its coincidence, where the arrangement removes the masking and the bell
still struck at full section level. Every accepted lead tops out at **+4.75**.

**2. The hat complaint is about a band, not a level.** Round 2's pulse is 31.6 dB *below* the
rest of the mix in the melody band - quieter than any accepted percussion - and Ray still heard
it sticking out, because in a dark, dry consort it owns the presence band alone.
`presenceShareDb` is the percussion's share of 1.5-8 kHz energy across the whole track. Round 2:
**-8.52 dB**. Every accepted percussion: **-10.16 to -12.21 dB**. And the percussion is a
SUBJECT now, never a bed - round 2 declared its pulse part of the bed, which inflated the bed,
made every lead look seated, and measured the pulse not at all.

## The measurement

`measureSubject({ subject, rest, full, sampleRate })`, one voice at a time - never a summed lead,
because summing is the first thing that hides a single voice:

| metric | meaning |
|---|---|
| `selfOutlierDb` | p99.5 minus median of the subject's own 250 ms in-band level (sounding windows only) - **the spike** |
| `localProminenceP995Db` / `MaxDb` | the subject's 250 ms level over the FULL MIX's own 3 s running level at that moment - how far it stands above the music around it |
| `presenceShareDb` | the subject's share of the mix's 1.5-8 kHz energy - **who owns the band the ear hears** |
| `melodyShareDb` | the same in 300-4000 Hz |
| `loudestOwnSeconds` / `loudestProminenceSeconds` | where in the render to listen |

## Getting per-voice stems from a score that never dumped any

The accepted listen sets ship A/B mutes at raw (pre-normalisation) gain, which is three linear
equations - `full = lead + chords + percussion`, `leadMuted = chords + percussion`,
`chordsMuted = lead + percussion` - so `lead = full - leadMuted`, `chords = full - chordsMuted`,
`percussion = leadMuted + chordsMuted - full`, and every rest is `full - subject`. Those are
exactly the quantities a stem dump gives; nothing is approximated. That is how eighteen
operator-accepted subjects anchor these caps.

## The table (2026-09-04, every number through `measureSubject()`)

| score | Ray's verdict | subject | local p99.5 | local max | note spread | presence share |
|---|---|---|---|---|---|---|
| accepted strategy score v6 L1 | PASS | lead / chords / perc | +3.67 / +0.94 / -4.49 | +4.70 / +2.63 / -3.89 | see PEAK-CAPS.json | -15.36 / -0.47 / -11.37 |
| accepted strategy score v6 L2 | PASS | lead / chords / perc | +4.22 / -1.25 / -4.34 | +4.75 / -0.91 / -4.09 | | -14.31 / -0.58 / -10.56 |
| accepted strategy score v6 L3 | PASS | lead / chords / perc | +2.93 / -0.67 / -4.54 | +3.67 / +0.59 / -2.65 | | -12.48 / -0.55 / -12.21 |
| accepted strategy score v4r2 L1 | PASS | lead / chords / perc | +3.49 / +1.37 / -5.14 | +4.47 / +2.96 / -4.50 | | -16.29 / -0.52 / -10.52 |
| accepted strategy score v4r2 L2 | PASS | lead / chords / perc | +3.77 / -0.26 / -4.72 | +4.28 / +0.73 / -4.40 | | -15.87 / -0.57 / -10.16 |
| accepted strategy score v4r2 L3 | PASS | lead / chords / perc | +3.25 / +0.07 / -4.90 | +3.39 / +0.88 / -3.02 | | -13.59 / -0.60 / -10.79 |
| **fleet project round 2** | **NOT YET** | Ember (the mallet) | +5.65 | **+7.04** | +4.18 | -7.47 |
| fleet project round 2 | | Tide / Veil | -0.75 / +1.00 | +1.38 / +1.29 | +3.47 / +4.02 | -9.67 / -36.53 |
| **fleet project round 2** | | Pulse (percussion) | -13.60 | -11.47 | +3.43 | **-8.52** |
| fleet project round 3 | not yet heard | Ember / Tide / Veil | +1.88 / -1.35 / -2.30 | +2.97 / +1.25 / -2.29 | +5.25 / +7.70 / +3.63 | -9.91 / -9.35 / -32.53 |
| fleet project round 3 | not yet heard | Pulse | -14.66 | -13.34 | +4.00 | -12.74 |

`FLEET_SUBJECT_CAPS` = worst ACCEPTED value plus a margin sized to the statistic: **1.5 dB for a
percentile** (it moves a little run to run), **1.0 dB for a whole-track energy share** (it does
not). Rerunning `derive-peak-caps.mjs` re-derives them and fails if they have drifted from the
library, if any accepted subject has gone RED, or - with `--red-stems` - if the ruled-against
render reads GREEN. A gate that cannot go red is not a gate.
