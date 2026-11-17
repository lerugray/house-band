# House Band - MISSION

House Band is the standing convention for code-composed music, grown into its own tool.
A score here is authored code: synthesized voices and step-sequenced tracks composed
deterministically (PRNG-seeded), so the musical intent lives in readable, versionable
source - not in a prompt-to-audio black box.

## What it is for

- Generate songs/scores from PROMPTS via the House Band process: a register/direction
  brief (authored by an optional external brief command when the register is the
  operator's own vocabulary, or by the orchestrator for registers outside it) drives a
  composed score over the band kit.

## The law (register neutrality)

The TOOL is register-neutral. Each consumer's musical register comes from ITS OWN
design seed, never inherited from the kit's origin or from another score. Every new
score states its register explicitly. Extend the kit with new voice types as registers
demand.

## Non-goals

- Not a DAW replacement (REAPER covers human-in-the-loop production).
- Not a generative-audio service wrapper; if a score can't be read as code, it isn't
  House Band.
