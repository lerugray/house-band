# M2 — The Audition Room (interface milestone)

MISSION shape stage 2: an accessible surface for auditioning, tweaking, and accepting
scores WITHOUT touching code. The operator (a musician, not a programmer) is the user.
Authored 2026-08-11 from Ray's go ("if the API and tooling is solid we can start to
think about an interface"); M1 hardening (0587102) is the foundation this builds on.

## Structural decisions (made — build to these)

1. **Browser app, in-repo, no server.** `app/` builds to a single-file
   `dist/audition-room.html` (boot-anywhere, file:// double-click — fleet convention).
   It runs the SAME canonical kit (`src/kit/band.js` + `prng.js`) live in the browser
   — WebAudio is its native habitat; no second implementation, no drift. The kit code
   is imported/inlined from the canonical source at build time, never forked.
2. **The score artifact stays the boundary.** The UI loads a validated score-spec
   JSON (file picker + drag-drop + bundled `examples/`), and every tweak WRITES BACK
   a new valid spec artifact. No UI state that can't round-trip through the schema —
   that is the paid-eligibility law (authored-code all the way down) expressed in UI
   terms. Strict-mode validation runs on load AND on every edit; invalid = loud.
3. **Render parity.** In-browser WAV export via OfflineAudioContext, emitting the
   SAME manifest sidecar the CLI does (kit version, spec hash, seed). A determinism
   note in the manifest marks browser renders as environment-scoped per
   docs/DETERMINISM.md (the CLI remains the custody path for shipped audio).

## Surfaces (build in this order)

**A. Audition (the PoC gate).** Transport: play / stop / loop, position readout.
Live pattern grid: every voice's step lane visualized with a moving playhead — the
score visible AS music notation-of-sorts, not JSON. Per-voice mute/solo + gain.
Register/preset panel naming the score's stated register (the law surfaced in UI).
Seed display + re-roll (A/B audition: hold the previous take for instant compare).

**B. Tweak.** Score-level controls that map 1:1 to spec fields: tempo/swing, per-voice
level/pattern parameters as the schema exposes them, section arrangement if the spec
carries sections. Every change = new artifact + a visible diff chip ("what changed
from the loaded take"); one-click revert. NO freehand piano-roll — this is not a DAW
(MISSION non-goal); it is a director's chair over an authored score.

**C. Accept.** "Accept this take" exports the bundle: spec JSON + WAV + manifest,
named and dated. That bundle is what a game repo consumes.

**D. Stems & the REAPER handoff (Ray, 2026-08-11).** The bridge to human production —
adopt REAPER, never rebuild it (MISSION non-goal, ledger row):
- **Per-voice stems:** one isolated render pass per voice from the SAME score artifact
  — sample-aligned, identical length (tails included), plus the full mix. Stems are
  still authored-code renders; the manifest covers the whole stem set so provenance
  survives the handoff.
- **REAPER session export:** a generated `.RPP` (plain-text format) with the project
  tempo, one named track per voice, stems placed at zero, and section markers where
  the spec carries sections. Open it and mix — no import ritual. Acceptance test:
  the generated .RPP round-trips through REAPER without warnings (verify against the
  RPP structure of a save from a current REAPER; keep the generator minimal — tracks,
  items, tempo, markers, nothing exotic).
- Mixing, plugins, added parts happen IN REAPER on the operator's side; nothing the
  operator does there flows back into the score artifact (the code remains the score;
  a REAPER mix is a production of it, like a performance of sheet music).

## Gates

- PoC-FIRST: surface A alone, with a bundled example score playing, screenshot + a
  browser-rendered WAV → operator verdict BEFORE surfaces B/C land.
- Suite: schema round-trip property tests (load→edit→save = still valid; untouched
  fields byte-stable), transport state machine, and a headless render-parity check
  (browser-path spec hash == CLI-path spec hash for the same artifact).
- The UI is a CONSUMER of the kit. Zero edits to src/kit/ in this milestone; a kit
  gap discovered by the UI is reported, not patched around.
- Visual bar: this is a tool, not a game — clean, legible, unfussy. Dark, quiet,
  readable at a glance; the pattern grid is the hero. No decorative register.
