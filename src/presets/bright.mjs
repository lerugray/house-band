/**
 * Bright-voice treatment (kit 1.12.0, s462): the Darkness r10 mix move as a kit default.
 *
 * Ray, 2026-11-16: "one lead is usually a little too grating/loud ... (typically tends to be bells and other high
 * frequency sounds)" and "generally higher frequency sounds like that don't need to be as loud in a mix and instead
 * can be given definition via panning". Darkness r10 fixed it per game in post; this puts the same treatment on the
 * voice itself so every score gets it (docs/proposals/HOUSE-BAND-BRIGHT-VOICE-PROPOSAL.md).
 *
 * Every BRIGHT voice gets, ahead of its bus: a level trim (gainDb + a generated body-match trim), a de-harsh EQ (2-8 kHz), a soft off-centre pan and a
 * short dark reverb tail (a mono Freeverb-style room, low-passed, panned with its voice). Its existing reverb and fx
 * sends are de-harshed the same way. Nothing else in a score changes.
 *
 * DATA, inside the kit identity (tools/lib/kit-identity.mjs hashes every file under src/presets/).
 * Classification (measured on the Timbre Range proof phrases, docs/proof/bright-voice-s462/CLASSIFY.md):
 *   - bell: every bell patch and the neutral bell (bell / glock / celesta / music box: 70-94% of power above 1 kHz).
 *   - lead: the bright synth leads and the reed (fm-brass, pwm-square, reed-oboe, supersaw-lead: 25-47% above 1 kHz)
 *     and ms20-square (the square lead the proposal names). Not the neutral triangle lead, breath-flute or sor-saw
 *     (6-8% above 1 kHz: dark).
 *   - pluck: karplus-string (40% of power above 2 kHz; the Karplus voice Darkness r9 had to cut).
 *   Bass, pad and drums are never bright here: the low end and the bed stay centred.
 */

import { BRIGHT_TRIMS } from './bright-trims.mjs';

/** Freeverb-style mono room as the dark tail (Jezar's public-domain design, the r10 tame.mjs constants). */
export const BRIGHT_TAIL_COMBS = Object.freeze([1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]);
export const BRIGHT_TAIL_ALLPASSES = Object.freeze([556, 441, 341, 225]);
export const BRIGHT_TAIL_SPREAD = 23;

export const BRIGHT_VOICE_PRESETS = Object.freeze({
  r10: Object.freeze({
    id: 'r10',
    version: '1.0.0',
    title: 'Darkness r10 bright-voice treatment',
    // Voice gain: about -1.5 dB below the voice's untreated body, the EQ takes the glare (proposal "level" row).
    gainDb: -1.5,
    // Body match per bright voice (generated, src/presets/bright-trims.mjs): r10 held the body (200 Hz-4 kHz) with a
    // band-matched rider in post, because the +8 dB dark tail builds up under sustained notes. The kit applies the
    // rider's solved gain statically, to dry, sends and tail together. Total voice gain = gainDb + trims[key].
    trims: BRIGHT_TRIMS,
    // De-harsh: peaking -10 dB at 4 kHz (Q 0.6) + high shelf -5 dB from 6.5 kHz (WebAudio's shelf slope S = 1,
    // i.e. Q 0.707, the proposal's Q 0.7).
    eq: Object.freeze([
      Object.freeze({ type: 'peaking', frequency: 4000, q: 0.6, gainDb: -10 }),
      Object.freeze({ type: 'highshelf', frequency: 6500, gainDb: -5 }),
    ]),
    // Target L/R balance of a mono voice: 100 (E_R - E_L) / (E_R + E_L) = 35 % (proposal: about 35 %, r10 34-39 %).
    // Equal-power StereoPanner value p with sin(p * pi / 2) = 0.35. Level-compensated so a centred voice keeps its
    // power (the r10 pan law), see band.js brightRoute.
    panPct: 35,
    // The tail: Freeverb room 0.94, damping 0.4, Freeverb's 0.015 input scale (x2: a centred mono voice feeds both
    // channels), wet +8 dB, summed to mono, two 2-pole low-passes at 1.8 kHz, panned to the voice's side.
    tail: Object.freeze({
      room: 0.94, damp: 0.4, inputScale: 0.03, wetDb: 8, lowpassHz: 1800, lowpassStages: 2, seconds: 4, fadeSeconds: 0.25,
      combs: BRIGHT_TAIL_COMBS, allpasses: BRIGHT_TAIL_ALLPASSES, allpassFeedback: 0.5, spread: BRIGHT_TAIL_SPREAD,
    }),
    // Which voices are bright, and their default side (+1 right, -1 left). A class maps to `true` (every patch and
    // the neutral voice) or to the list of bright patch ids.
    classes: Object.freeze({
      bell: Object.freeze({ side: 1, patches: true }),
      lead: Object.freeze({ side: -1, patches: Object.freeze(['fm-brass', 'pwm-square', 'reed-oboe', 'supersaw-lead', 'ms20-square']) }),
      pluck: Object.freeze({ side: 1, patches: Object.freeze(['karplus-string']) }),
    }),
  }),
});

export const BRIGHT_VOICE_MODES = Object.freeze(['r10', 'off']);
export const BRIGHT_CLASS_ORDER = Object.freeze(['bell', 'lead', 'pluck']);

/** True when `cls` played with patch `patch` (undefined/null = the neutral voice) is bright under `preset`. */
export function isBrightVoice(preset, cls, patch) {
  const rule = preset.classes[cls];
  if (!rule) return false;
  if (rule.patches === true) return true;
  return patch !== undefined && patch !== null && rule.patches.includes(patch);
}

/**
 * Sides for the bright classes a score actually plays, so two bright voices together sit on opposite sides: each
 * class (in BRIGHT_CLASS_ORDER) takes its default side unless that side already holds more bright classes than the
 * other, then it takes the other one.
 */
export function brightSides(preset, classesInUse) {
  const sides = {};
  let right = 0;
  let left = 0;
  for (const cls of BRIGHT_CLASS_ORDER) {
    if (!classesInUse.has(cls)) continue;
    let side = preset.classes[cls].side;
    if (side > 0 && right > left) side = -1;
    else if (side < 0 && left > right) side = 1;
    if (side > 0) right += 1; else left += 1;
    sides[cls] = side;
  }
  return sides;
}

/** Trim key of a bright voice: "class" for the neutral voice, "class:patch" for a patch. */
export const brightTrimKey = (cls, patch) => (patch === undefined || patch === null ? cls : `${cls}:${patch}`);

/** The StereoPanner value that puts a mono voice `pct` % off centre (equal-power law). */
export const brightPanValue = (pct) => (2 / Math.PI) * Math.asin(pct / 100);
