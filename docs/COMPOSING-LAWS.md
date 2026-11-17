# Composing laws

Standing craft laws for every composed House Band score. Headings are the law names;
parenthesised dates and attributions from the private notes are omitted here.

## The Full-Arrangement and Mastering Law

(1) A score is a FULL arrangement by default (melody, harmony/accompaniment, bass, rhythm
or texture layer, a counter-line or answer, real builds and drop-outs). A sparse or solo
texture only where the project's register doc calls for it and says why. (2) Every score,
sparse ones included, gets a mix + FX + mastering pass before any listen set: per-voice
levels, EQ/space, placement and the room (kit 1.9+), bus processing, and mastering to the
register's loudness target (true peak <= -1 dBTP), recorded in the listen set's report.
New scores use the room/stereo placement, and the section-change leak fix is in the kit.

## The Song-Structure Law

A full song needs more than one part - always. Minimum two distinct sections (A/B at
least; bridge/breakdown welcome) with real arrangement variation between them (voicing,
density, register movement - not just a fill). Loops are not exempt by default: a loop
either alternates sections or carries internal variation across passes; a single
repeated cell is a DEFECT, not a style. This law binds hand-composed scores, the API
composer prompt, and every port of the kit. Per-project registers remain each project's
own (the register-neutrality law is untouched - this governs STRUCTURE, not voice).

**A/B is the FLOOR, not the target.** A two-part score can still irritate over a long
session. For projects whose sessions run long, aim for: 3+ distinct sections; per-pass
variation inside sections (voicing/density swaps so no two consecutive passes are
identical); section lengths long enough that the full cycle takes minutes, not seconds;
and TEMPO tuned to the project's actual pace - when in doubt, slower than instinct. The
check-question at compose time: "would this irritate at minute twenty?"

**HARMONIC MOVEMENT is the third axis - form and texture are not motion.** Sections that
change while roots do not still fail. The Law governs three axes: sections, per-pass
variation, and harmonic movement. A loop-bearing score MOVES ITS ROOTS - a real
progression per section, and sections that differ harmonically from one another, not
just in voicing and density. Enforce it with a standing test asserting a minimum count
of distinct chord roots per full cycle, measured from the composed material. A static
single-chord bed remains possible as a deliberate register choice - but only on an
explicit call, never as a default.

**Paired harmonic inspection.** Retain the standing minimum distinct-chord-root count
per full cycle as the default harmonic floor. Also run the label-free Harmonic-State
Motion and Distinctness (HSMD) test on composed note data. A section has measured
harmonic motion when `M >= 0.50` and excursion `E >= 0.05`; `M < 0.25` is static-like and
`0.25 <= M < 0.50` is low/ambiguous. Materially different section types are harmonically
distinct when pairwise `D >= 0.16`; `D < 0.08` is the same harmonic bed and
`0.08 <= D < 0.16` requires operator judgment. Declared reprises or additive/subtractive
passes of the same section must be reported as reuse and may not be presented as new
harmonic sections. A root-static or pedal-dominant architecture may satisfy the movement
floor without a one-off operator exemption only when its register brief declares that
architecture and every affected material section meets `M >= 0.50` and `E >= 0.05`. HSMD
does not waive the root floor for an undeclared default bed. Thresholds are versioned
engineering policy and may change only through an operator-reviewed catalog
recalibration.

**FORM VOCABULARY widens - A/B alternation is one shape, not THE shape.** Valid forms
include, beside A/B(/bridge):

- **Subtractive/additive arrangement over a repeated section** - for example the
  Appendix N loop shape: A played four times with minor changes and instruments dropping
  out for a stretch, then returning. The section repeats; the ARRANGEMENT is the
  variation.
- **A/B/C and longer chains** - three-plus distinct sections in sequence before the
  cycle closes.
- **Layer-build forms** - start sparse, add voices per pass, thin back out.
- **Long-form evolving loops** - gradual texture evolution, a sparse/ambient middle
  passage as a breathing space, melodic material that transforms rather than merely
  alternates.

The three axes (sections, per-pass variation, harmonic movement) still bind whatever the
form - a subtractive Ax4 must still move its roots and vary its passes; form choice
never exempts a score from the floors above. Compose-time question gains a sibling:
"which structural trope is this score using, and is that a choice or a default?"

## The Lead-Balance Law

Broadband lead-vs-accompaniment ratios can read "balanced" while the melody band
screams. Lead balance is measured as an **RMS ratio in 300-4000 Hz, from rendered
stems** - never broadband, never inferred from score/spec gains. Targets for the
background/menu register: **+3 to +5 dB** lead over accompaniment in-band, **loudest
decile <= +7 dB**. Foreground/action registers may run hotter, but state the measured
number in the compose report either way.

**Brightness clause:** RMS ratio is not perceived loudness - a bright/pure lead timbre
reads louder than its measured ratio. Compose reports also state the lead stem's
**spectral centroid**; when the lead is bright (high centroid vs the bed), sit it at the
LOW end of the window or warm the timbre first. Treat a hot-reading lead as a TIMBRE
question before a level question.

Fix by measured trim (measure the gap at a known trim, then scale), not by ear-guessing
multipliers.

**Enforcement:**

1. **No listen set stages without its measured lead numbers.** The render/compose report
   states the in-band (300-4000 Hz) lead-vs-accompaniment RMS ratio and the lead centroid
   for every track staged. A pipeline that cannot render stems gets a stem path added
   BEFORE its next staging.
2. **When an operator-passed sibling track exists on the same master chain, its measured
   lead level is the target** - reference-anchored trim beats window-center guessing.

**Standing gate:** `tools/lead-balance/lead-balance.mjs` is the kit-level gate, anchored
to accepted scores (table in `tools/lead-balance/README.md`); every score with no KEEP
runs it on rendered stems before a listen set stages; a new port copies it beside its
render tooling. Three of its numbers describe the defect: the loudest-decile ratio, the
share of windows more than 6 dB hot, and the per-section distribution (the mean is not
the measurement).

## Porting the lead gate into a game

A project's gate probe commonly renders lead and bed channel buffers in memory, then
writes only its own JSON verdict; without persisted stems, the fleet gate cannot measure
or audit that render. `dumpLeadBalanceStems()` bridges those same buffers to PCM16 WAV
custody and the real kit-level `measureLeadBalance()` result without introducing another
metric path.

```js
import { dumpLeadBalanceStems } from '../../house-band/tools/lead-balance/stems-dump.mjs';
const gate = dumpLeadBalanceStems({ lead: leadChannels, bed: accompChannels, full: fullChannels,
  sampleRate: SAMPLE_RATE, outDir: 'runs/lead-balance-stems', tag: track });
if (gate.verdict === 'RED') process.stderr.write(`lead-balance RED: ${track}\n`);
```

Most project repos are siblings of `house-band`, so a probe under the project's
`scripts/` directory uses the same `../../house-band/...` convention shown above. Pass a
per-project KEEP through as `caps` (and its section grid as `sectionSeconds`); the helper
forwards both directly to `measureLeadBalance()`.

## The Boot-Brevity Law

Form follows surface: **a boot/intro theme is SHORT** - seconds-scale, one gesture, done.
A boot surface earns a sting or a short phrase, not a composition; menu/attract surfaces
earn loops; only play surfaces earn full arrangements. State the target surface and its
expected dwell time in every compose brief, and size the piece to the dwell.

## The Timbre-Variety Law

Compose rounds must not default to the same patch set score after score. At compose time,
name the voice choices AND how they differ from the last few sibling scores (same voice
*class* is fine; same *patch parameters* recurring across projects is the violation). The
kit's full array - synth families, chip voices, tracker-fx, percussion - is there to be
ranged across, and register comes first: variety serves the project's own register, never
fights it.

**Named timbre source:** first-party sample material (provenance-clean) is a STANDING
source for real timbres beyond synthesis. MicroFreak patches/instruments are exemplary
usable material. Per-project embed cost (single-file builds) stays a named tradeoff in
the compose report.

Kit range and compose-time checks carry the law to every composer. Since kit 1.7.0 that
source is playable, not just catalogued: pitched sampler voices consume the endorsed
families directly. Reaching for a sampled timbre is a variety-widening move the law
encourages; the embed cost it buys stays a named tradeoff in the compose report.

## The Performance-Pass Law

Two standing craft laws, binding on every House Band score:

1. **Chord and pad releases default LONGER than synth defaults.** An abrupt chord cutoff
   is a defect tell. Tune release tails per register; let harmony ring where the register
   wants it.
2. **Humanization is part of composition, not polish.** Register-appropriate
   micro-timing offsets and velocity variation, DETERMINISTIC - drawn from the score's
   own PRNG stream, never wall-clock. Warm or organic registers demand it; a rigidly
   mechanical register may deliberately skip it, but its register doc must say so.
   Deterministic performance DIFFERENTIATION also satisfies this law - a documented
   combination of envelope geometry, articulation, accent hierarchy, note-length,
   attack-transient, or pitch inflection may carry the performed feel on a precise grid.
   The REQUIREMENT to differentiate is unchanged - constant-everything remains a defect;
   only the permitted means broaden. The register doc must name which means the score
   uses.

Every score states its release + humanization posture in its register doc. Listen sets
are judged against this law before they reach the operator's ear.

The score API exposes that posture through the optional top-level `performance` object.
Omission is deliberately neutral and preserves pre-performance renders byte for byte.
Ranges are explicit rather than aesthetic presets: `timingMs` is a deterministic
per-note offset range, `velocity` is a fractional gain-offset range, and `swing` delays
odd sixteenth steps by that fraction of half a step. A score-level setting applies to
every voice; entries under `voices` override only the named voice. `releaseTail` adds
seconds to each pad/drone note's authored release (and therefore to chords voiced as
simultaneous pad/drone notes).

```json
"performance": {
  "humanize": { "timingMs": [-8, 8], "velocity": [-0.05, 0.05], "swing": 0.12 },
  "releaseTail": 0.4,
  "voices": {
    "pad": {
      "humanize": { "timingMs": [-4, 6] },
      "releaseTail": 0.9
    }
  }
}
```

All draws come from the score seed plus stable step/voice/call coordinates. No
wall-clock or `Math.random` input enters performance scheduling. Direct kit users may
pass the same object as `createBand({ performance })`; declarative score renders pass
`score.performance` through automatically. Release-tail defaults remain zero for
compatibility, so each register must opt in to the longer chord/pad posture and tune it
explicitly.

## Structural Score-Audit Gate

Before ANY ear set reaches the operator, run `node tools/score-audit/audit.mjs <score.json>`
on each composed score. It enforces the Performance-Pass Law numerically (onset-timing
variance, velocity/gain spread, lead release/sustain diversity) and checks the
Song-Structure Law's form requirement (subtractive/evolving forms LEGAL,
constant-arrangement repetition a DEFECT) and paired HSMD harmonic floor. Static/low-motion
material and same-bed material presented as new sections are defects; insufficient note
data and the `0.08 <= D < 0.16` judgment band remain visible for operator judgment. Exit 1
= fix the score before rendering an ear set - the operator's ear stays the register/taste
gate, never the mechanical-defect detector. Thresholds and usage:
`tools/score-audit/README.md`.

## Low-end overload probe

After rendering a listen/demo mix, run:

```sh
python3 scripts/lf-overload-probe.py <render.wav> [--lowest-written-hz N] [--json]
```

Thresholds (sub-150 / sub-60 share, LF headroom, roughness, optional octave-ghost) are
documented in the probe. Kit demo-pack wiring is **report-only** (a FAIL does not fail
the suite); treat FAIL on a shippable score as a compose defect to fix before ear-gate.
