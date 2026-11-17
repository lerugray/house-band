/** Shared deterministic DR5 scheduling. No AudioContext is constructed here. */
import {createBand, LOOKAHEAD} from './kit/band.js';
import {compileTrackStep} from './spec.mjs';
import {brightPlan} from './timbre.mjs';
import {resolveTimbreWithUser, userPatchDefs} from './user-timbres.mjs';

export function scheduleSpec(spec, ctx, opts = {}) {
  let now = 0;
  // Kit 1.11.0: null for a score with no kit, patch or graph-routed samples,
  // which then builds exactly the 1.10.0 band.
  // OSS-13: resolveTimbreWithUser is resolveTimbre itself for a score that names no `user:` kit or patch.
  const timbre = opts.timbre !== undefined ? opts.timbre : resolveTimbreWithUser(spec, opts.timbrePacks);
  const userPatches = userPatchDefs(spec);
  const stepDefaults = spec.patches || userPatches
    ? { ...(spec.patches ? { patches: spec.patches } : {}), ...(userPatches ? { userPatches } : {}) }
    : null;
  // Kit 1.12.0: null when the bright-voice treatment is off or nothing bright plays (the band is then unchanged).
  const bright = opts.bright !== undefined ? opts.bright : brightPlan(spec);
  const band = createBand({
    ctx,
    seed: spec.seed,
    gain: spec.gain !== undefined ? spec.gain : 0.5,
    performance: spec.performance,
    mix: spec.mix,
    onEvent: opts.onEvent,
    fx: spec.fx ? { bpm: spec.tempo, ...spec.fx } : undefined,
    // Kit 1.9.0: omitted is 'crossfade' with a zero hold — the 1.8.0 retire.
    ...(spec.retire ? { retireMode: spec.retire.mode, retireHold: spec.retire.hold ?? 0 } : {}),
    registerClass: spec.register.class,
    ...(timbre ? { timbre } : {}),
    ...(bright ? { bright } : {}),
    nowFn: () => now,
    strict: true,
    disconnectRetired: false,
  });

  // Schedule every step into the offline graph before startRendering().
  // OfflineAudioContext.currentTime stays at 0 until render, so we pass `now`.
  const tickStep = LOOKAHEAD / 2;
  let environmentPass = 0;
  for (let sectionIndex = 0; sectionIndex < spec.sections.length; sectionIndex++) {
    const sec = spec.sections[sectionIndex];
    const track = spec.tracks[sec.track];
    const bpm = track.bpm ?? spec.tempo;
    const secDur = sec.bars * (16 * (60 / bpm / 4));
    const fadeIn = sec.fadeIn !== undefined ? sec.fadeIn : 0.05;
    const scheduledTrack = { ...track, steps: track.steps.filter(event => {
      const voice = event.voice ?? event.v;
      return (!opts.voice || voice === opts.voice)
        && (!opts.voices || opts.voices.includes(voice))
        && (!opts.excludeSampleVoices || !Object.hasOwn(spec.sampleVoices ?? {}, voice));
    }) };
    band.registerTrack(sec.track, {
      bpm, len: track.len, vol: track.vol ?? 0.8,
      pan: track.pan, width: track.width,
      step: compileTrackStep(scheduledTrack, sec, stepDefaults),
    });
    if (sec.execution?.kind !== 'intro') environmentPass += 1;
    band.setExecutionContext({
      sectionIndex,
      environmentPass,
      sectionKind: sec.execution?.kind ?? null,
      mutationEvery: sec.execution?.every ?? null,
      mutationId: sec.execution?.id ?? null,
    });
    const end = now + secDur;
    band.setTrack(sec.track, { fadeIn, until: end, restart: true });
    // Advance simulated time so tick's lookahead window covers the section.
    while (now < end) {
      band.tick();
      now = Math.min(end, now + tickStep);
    }
    band.tick();
    now = end;
  }
  // Voices already own their releases. Never tick the final track into the tail.
  // Keep the final bus alive so legitimate earlier-note tails complete.

  return band;
}
