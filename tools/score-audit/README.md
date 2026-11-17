# House Band structural score-audit probe

A numeric, no-listening gate that catches mechanical and harmonic-architecture
defects from note DATA before any ear set reaches the operator. It consumes a
composed House Band score artifact (JSON or ES module) and emits a machine verdict.

## Run

```sh
node tools/score-audit/audit.mjs <path-to-score>
node tools/score-audit/audit.mjs <path-to-score> --human
```

- Exit code `0` on pass, `1` on fail, `2` on usage/load errors.
- Default output is JSON on stdout plus a short human summary on stderr.
- `--human` swaps the two: summary on stdout, JSON on stderr.

## What it measures

| Check | Flag | Threshold | Notes |
|-------|------|-----------|-------|
| Onset-timing variance per voice | `mechanical-onsets` | Residual range ≤ 1 ms | Skipped if `performance.humanize.timingMs` (global or per-voice) has non-zero width. |
| Velocity/gain spread per voice | `mechanical-velocities` | Explicit `opts.vol` range ≤ 0.001, or no explicit velocities at all | Skipped if `performance.humanize.velocity` has non-zero width. |
| Lead gate/release distribution | `constant-lead-releases` | Total length (`dur + release`) range ≤ 0.01 s on `lead`, `chipPulse`, `chipTriangle` | Uses kit default release when `opts.r` is omitted. |
| Section arrangement | `single-section` | Fewer than 2 sections | Required by the Song-Structure Law. |
| Section arrangement | `constant-arrangement` | 2+ sections but all identical signatures | Passes subtractive/additive A×N forms because dropout tracks produce different signatures. |
| Harmonic-state motion (HSMD) | `static-harmonic-bed`, `low-harmonic-motion` | `< 0.25` static-like; `≥ 0.50` plus excursion `≥ 0.05` moving | Gating for new scores. `0.25 <= M < 0.50` does not meet the movement floor. |
| Harmonic section distinctness (HSMD) | `harmonic-bed-reuse` | `< 0.08` same bed; `0.08 <= D < 0.16` operator judgment; `≥ 0.16` distinct | Same-bed pairs fail only when both sections are presented as new material. |

It also reports a `harmony` metric (distinct pitch roots across pitched notes) and
`harmonicState` HSMD results. The former remains informational and does not replace
the standing distinct-chord-root floor; HSMD is the ratified paired gate. Its
`enforcement` result records gating/grandfather status, static and low-motion
sections, same-bed pairs presented as new, reported reuse, insufficient-data
sections, and judgment-band pairs.

HSMD integrates duration occupancy with pitch-class presence, so sequential notes in
an arpeggio imply one harmonic state without requiring a chord label. It ignores gain,
normalizes each voice before mixing, downweights lead/countermelody against an explicit
harmony voice, and raises sparse one- or two-voice counterpoint to full weight. Windows
are truncated at labeled section boundaries. `chipNoise` is treated as unpitched, and
tracker pitch FX are not expanded because the current probe consumes authored note
events rather than the renderer's tick-level schedule.

## Harmonic declarations and exceptions

New root-static or pedal-dominant scores declare the choice in score metadata as
`register.harmonicArchitecture: "root-static"` or `"pedal-dominant"`. That
declaration records the register-brief posture; it does not bypass the numeric
floor, so every measured material section still needs `M >= 0.50` and `E >= 0.05`.

Doctrine entry 7's separate one-off escape hatch is represented by all of:

```json
"register": {
  "name": "example-register",
  "briefRef": "docs/REGISTER-EXAMPLE.md",
  "harmonicArchitecture": "static-bed",
  "staticBedAuthorization": {
    "operator": "Ray",
    "date": "2026-08-21",
    "briefRef": "docs/REGISTER-EXAMPLE.md"
  }
}
```

The authorization is valid only when its `briefRef` matches the register brief.
This explicit operator authorization exempts the score from HSMD motion and
same-bed failures; omitting any part leaves `STATIC` gating.

Sections default to `harmonicClaim: "new"`. A declared reprise or an
additive/subtractive pass of existing harmonic material must instead carry
`harmonicClaim: "reuse"`:

```json
"sections": [
  { "track": "A", "bars": 8, "harmonicClaim": "new" },
  { "track": "A-drop-bass", "bars": 8, "harmonicClaim": "reuse" }
]
```

HSMD still reports a same-bed comparison involving a reuse section, but does not
fail it as material falsely presented as new. `INSUFFICIENT_HARMONIC_DATA` and
pairwise `0.08 <= D < 0.16` never add a flag; both are surfaced for operator
judgment.

Kit 1.4 mutation sections follow the same ratified rule: every
`sections[].execution.kind: "mutation"` variant must carry
`harmonicClaim: "reuse"`. Register classes and role-onset execution never exempt
HSMD motion or distinctness, and the audit continues to inspect the authored note
data independent of those timing-only hooks.

## Prospective enforcement and grandfathering

Amendment A applies to scores audited from ratification onward. The following
complete set of score-shaped repository artifacts present at ratification on
2026-08-21 is path-grandfathered: HSMD remains visible for them but adds no flags.
All other audit checks keep their prior behavior.

- `examples/chipfx-audition-spec.json`
- `examples/demo-spec.json`
- `examples/m3-sample-spec.json`
- `listen/house-band-performance-pass-after-2026-08-15.score.json`
- `listen/house-band-performance-pass-before-2026-08-15.score.json`
- `test/fixtures/golden-spec.json`
- `tools/score-audit/fixtures/humanized.json`
- `tools/score-audit/fixtures/mechanical.json`
- `tools/score-audit/fixtures/score-module.mjs`

The CLI resolves the supplied path against this list. Library callers that need
the same treatment pass `auditScore(score, { sourcePath })`; omitting `sourcePath`
intentionally treats the score as new.

## Threshold rationale

Thresholds are intentionally conservative. They catch obvious mechanical tells — grid-perfect onsets, constant velocity, identical lead releases, repeated identical sections — without penalising subtle composition choices. The 1 ms onset tolerance only fires when authored onsets are exactly step-aligned and no timing humanization is declared; a declared `timingMs` range immediately exempts the voice.

## Tests

```sh
node --test tools/score-audit/test/*.test.mjs
```

- `mechanical.json` — must fail with all four flags.
- `humanized.json` — must pass; uses declared humanization, explicit velocity spread, varied lead releases, and a subtractive A×4 arrangement.
- `score-module.mjs` — verifies ES-module loading.
- `demo-spec.json` — informational run against a real example.
- `harmonic-state.test.mjs` — TIV reference distances, implied arpeggios,
  static/moving anchors, transposed reuse, distinct sections, and section isolation.
- Amendment-A enforcement coverage includes new-score failure, operator-authorized
  static pass, grandfather pass, same-bed CLI exit 1, judgment-band non-failure,
  and insufficient-data non-failure.

## Files

- `audit.mjs` — CLI entry point.
- `lib.mjs` — audit logic, reusable outside the CLI.
- `harmonic-state.mjs` — dependency-free DR2 HSMD implementation.
- `fixtures/mechanical.json` — synthetic mechanical fixture.
- `fixtures/humanized.json` — synthetic humanized fixture.
- `fixtures/harmonic-static.json` — isolated static-bed gate/authorization fixture.
- `fixtures/harmonic-reuse.json` — moving transposed-bed reuse gate fixture.
- `fixtures/score-module.mjs` — module-loading fixture.
- `test/audit.test.mjs` — Node built-in test suite.
- `test/harmonic-state.test.mjs` — focused harmonic-state test suite.
