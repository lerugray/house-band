# Vendored Stageshow

- Source: https://github.com/benjitaylor/skills, folder `stageshow/`, commit `802057409787133703c56001080169e347305572` (`80205740`, "Add Stageshow", 2026-10-30).
- License: MIT, see `LICENSE`; third-party notices in `NOTICE.md`. Both kept unchanged.
- Copied by hand (shallow fetch of that commit). No `skills` CLI, no `portless`, nothing in any `~/.claude/skills`.

Removed from the copy (NOTICE.md: not covered by the MIT license, never shipped here):
- `assets/app-icons.ts` (app artwork).
- Every `*.svg` in the tree (44 files: `kit/brands/*.svg` brand marks plus any others). Consequence: `kit/index.ts`, `kit/brands/index.ts` and `kit/parts/BrandMark.tsx` no longer resolve. The demos in `tools/stageshow-demos/` import only individual kit modules (`stage`, `act`, `window`, `motion/Stream`), never `kit/index.ts`, so no brand artwork can enter a build. The examples and playground that reference the removed files are not built.

Left in place (CC0, per `NOTICE.md`): two Wikipedia photos under `examples/wikipedia/`. They are not imported by any demo and are not in the build output.

Nothing else in this folder is modified.

Removed in House Band (release candidate, s462): `film-all.sh`, a filming script added in hammerstein-ai (not part of upstream Stageshow) that hard-coded that project's lane paths and demo folders; nothing here used it.

Copied into House Band from hammerstein-ai 8b6b825c (itself the upstream commit 802057409787133703c56001080169e347305572 minus app icons and SVGs).

Public export (s463): `examples/`, `teaching/` and `playground/` stay in the private repo only. The landing-page demos never import them, and their fictional sample email addresses trip the publish leak guard.
