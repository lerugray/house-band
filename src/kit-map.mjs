/**
 * Kit substitution map for `--kit-map a=b[,c=d]` at render time.
 * Replaces kit names in a score before validation; ids are not checked here.
 * After rename, variants missing from the target kit fall back to that lane's
 * default (or the same-role neutral lane); otherwise the hit is skipped.
 */

import { NEUTRAL_LANES, TIMBRE_LANES } from './kit/band.js';
import { KITS } from './presets/kits/index.mjs';

const TIMBRE_LANE_SET = new Set(TIMBRE_LANES);

/** Parse `from=to[,from=to…]` into a frozen Map. Throws Error naming the offending item. */
export function parseKitMap(text) {
  if (typeof text !== 'string') throw new Error(`invalid kit-map: ${text}`);
  const map = new Map();
  for (const item of text.split(',')) {
    if (item === '') throw new Error(`invalid kit-map entry: ${JSON.stringify(item)}`);
    const eq = item.indexOf('=');
    if (eq === -1) throw new Error(`invalid kit-map entry: ${item}`);
    const source = item.slice(0, eq);
    const target = item.slice(eq + 1);
    if (map.has(source)) throw new Error(`invalid kit-map entry: ${item}`);
    if (source === target) throw new Error(`invalid kit-map entry: ${item}`);
    map.set(source, target);
  }
  return Object.freeze(map);
}

/**
 * Deep-copy `spec` and replace every kit reference present in `map`.
 * Paths: top-level `kit`, `tracks[*].kit`, step `opts.kit` / `o.kit`.
 * Returns `{ spec, replaced: [{ path, from, to }] }`. Never mutates the input.
 */
export function applyKitMap(spec, map) {
  const copy = structuredClone(spec);
  const replaced = [];

  const replace = (holder, key, path) => {
    const from = holder[key];
    if (typeof from !== 'string' || !map.has(from)) return;
    const to = map.get(from);
    holder[key] = to;
    replaced.push({ path, from, to });
  };

  if (copy && typeof copy === 'object' && !Array.isArray(copy)) {
    if (Object.hasOwn(copy, 'kit')) replace(copy, 'kit', 'kit');
    const tracks = copy.tracks;
    if (tracks && typeof tracks === 'object') {
      for (const [name, track] of Object.entries(tracks)) {
        if (!track || typeof track !== 'object') continue;
        if (Object.hasOwn(track, 'kit')) replace(track, 'kit', `tracks.${name}.kit`);
        const steps = track.steps;
        if (!Array.isArray(steps)) continue;
        for (let i = 0; i < steps.length; i++) {
          const event = steps[i];
          if (!event || typeof event !== 'object') continue;
          if (event.opts && typeof event.opts === 'object' && Object.hasOwn(event.opts, 'kit')) {
            replace(event.opts, 'kit', `tracks.${name}.steps[${i}].opts.kit`);
          }
          if (event.o && typeof event.o === 'object' && Object.hasOwn(event.o, 'kit')) {
            replace(event.o, 'kit', `tracks.${name}.steps[${i}].o.kit`);
          }
        }
      }
    }
  }

  return { spec: copy, replaced };
}

/**
 * Target-kit lane for a drum voice: kit lane if present, else same-role neutral
 * (perc -> perc), else null.
 */
function resolveTargetLane(kitName, voice) {
  let lane = null;
  if (typeof kitName === 'string' && Object.hasOwn(KITS, kitName)) {
    lane = KITS[kitName]?.lanes?.[voice] ?? null;
  }
  if (!lane && TIMBRE_LANE_SET.has(voice)) {
    lane = NEUTRAL_LANES[voice] ?? null;
  }
  return lane;
}

function optsBag(event) {
  if (event.opts && typeof event.opts === 'object') return 'opts';
  if (event.o && typeof event.o === 'object') return 'o';
  return null;
}

/**
 * After kit rename: rewrite variants the target kit lacks to that lane's default,
 * or skip the hit when no lane exists (even via same-role neutral).
 * Returns `{ spec, substitutions: [{ lane, from, to }] }` (`to` is null when skipped).
 * Never mutates the input. Validation of the original score is unchanged.
 */
export function resolveKitMapVariants(spec) {
  const copy = structuredClone(spec);
  const substitutions = [];
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
    return { spec: copy, substitutions };
  }

  const tracks = copy.tracks;
  if (!tracks || typeof tracks !== 'object') {
    return { spec: copy, substitutions };
  }

  for (const [name, track] of Object.entries(tracks)) {
    if (!track || typeof track !== 'object' || !Array.isArray(track.steps)) continue;
    const kept = [];
    for (let i = 0; i < track.steps.length; i++) {
      const event = track.steps[i];
      if (!event || typeof event !== 'object') {
        kept.push(event);
        continue;
      }
      const bagKey = optsBag(event);
      const bag = bagKey ? event[bagKey] : null;
      const variant = bag && typeof bag.variant === 'string' ? bag.variant : undefined;
      if (variant === undefined) {
        kept.push(event);
        continue;
      }
      const voice = event.voice ?? event.v;
      const kitName = (bag && typeof bag.kit === 'string' ? bag.kit : undefined)
        ?? (typeof track.kit === 'string' ? track.kit : undefined)
        ?? (typeof copy.kit === 'string' ? copy.kit : undefined);
      const lane = resolveTargetLane(kitName, voice);
      if (!lane) {
        substitutions.push({ lane: typeof voice === 'string' ? voice : 'unknown', from: variant, to: null });
        continue;
      }
      if (!lane.variants) {
        kept.push(event);
        continue;
      }
      if (Object.hasOwn(lane.variants, variant)) {
        kept.push(event);
        continue;
      }
      const to = lane.default;
      if (typeof to !== 'string' || !Object.hasOwn(lane.variants, to)) {
        substitutions.push({ lane: typeof voice === 'string' ? voice : 'unknown', from: variant, to: null });
        continue;
      }
      bag.variant = to;
      substitutions.push({ lane: typeof voice === 'string' ? voice : 'unknown', from: variant, to });
      kept.push(event);
    }
    track.steps = kept;
  }

  return { spec: copy, substitutions };
}
