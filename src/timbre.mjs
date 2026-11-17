/**
 * Timbre Range resolution (kit 1.11.0): which kits, patches and sample packs a
 * score needs, and the plain-data bundle the band consumes.
 *
 * Runtime-neutral: no node: imports, so the Audition Room's browser renderer
 * shares it. Sample packs are loaded by the host (src/sample-pack-node.mjs in
 * node) and handed in as `packs`; a synth-only kit or patch needs none.
 *
 * A score with no `kit`, no `patches`, no event/track kit or patch and no
 * graph-routed samples resolves to null, and then nothing in this module has
 * touched the render: that is the byte-identical neutral path.
 */

import { assertScorePackMatch } from './sample-pack.mjs';
import { DRUM_LANES, NEUTRAL_LANES, PATCH_CLASSES, TIMBRE_LANES } from './kit/band.js';
import { KITS } from './presets/kits/index.mjs';
import { PATCHES } from './presets/patches/index.mjs';
import { isBrightDefaultKitVersion, isTimbreKitVersion } from './version.mjs';
import { BRIGHT_VOICE_PRESETS, brightPanValue, brightSides, isBrightVoice } from './presets/bright.mjs';

const DRUM_LANE_SET = new Set(DRUM_LANES);
const PATCH_CLASS_SET = new Set(PATCH_CLASSES);
const TIMBRE_LANE_SET = new Set(TIMBRE_LANES);

const eventOpts = (event) => event.opts ?? event.o ?? {};

/** Every kit and patch name a score references, at score, track and event level. */
export function timbreNames(spec) {
  const kits = new Set();
  const patches = new Set();
  if (spec.kit !== undefined) kits.add(spec.kit);
  if (spec.patches) for (const name of Object.values(spec.patches)) patches.add(name);
  for (const track of Object.values(spec.tracks)) {
    if (track.kit !== undefined) kits.add(track.kit);
    if (track.patches) for (const name of Object.values(track.patches)) patches.add(name);
    for (const event of track.steps) {
      const opts = eventOpts(event);
      if (opts.kit !== undefined) kits.add(opts.kit);
      if (opts.patch !== undefined) patches.add(opts.patch);
    }
  }
  return { kits, patches };
}

/** True when the score names any kit or patch (anywhere). */
export function usesNamedTimbre(spec) {
  const { kits, patches } = timbreNames(spec);
  return kits.size > 0 || patches.size > 0;
}

/** Phrase/spatial controls that, on kit 1.11.0, may sit beside bound samples. */
export function usesPhraseControls(spec) {
  return Object.values(spec.tracks).some((t) => t.pan !== undefined || t.width !== undefined || t.steps?.some((e) => e.accent !== undefined))
    || spec.sections.some((s) => s.shape !== undefined || s.mute !== undefined || s.dropouts !== undefined);
}

/**
 * Bound sample voices render IN-GRAPH (through the bus, sends and master) when a
 * kit-1.11.0 score pairs them with fx, mix or phrase controls. Without those
 * controls the integer Q16 sample bus keeps its custody guarantees untouched.
 */
export function usesGraphSamples(spec) {
  if (!spec.sampleVoices || Object.keys(spec.sampleVoices).length === 0) return false;
  if (!isTimbreKitVersion(spec.kitVersion)) return false;
  return spec.fx !== undefined || spec.mix !== undefined || usesPhraseControls(spec);
}

function defPack(def) {
  return def.pack ?? null;
}

/** The sample packs (by id) a score's kits and patches need. */
export function requiredPackIds(spec) {
  const { kits, patches } = timbreNames(spec);
  const ids = new Set();
  for (const name of kits) { const pack = defPack(KITS[name]); if (pack) ids.add(pack.packId); }
  for (const name of patches) { const pack = defPack(PATCHES[name]); if (pack) ids.add(pack.packId); }
  if (usesGraphSamples(spec)) ids.add(spec.samplePack.packId);
  return [...ids];
}

function takePack(packs, packId) {
  const pack = packs ? (typeof packs.get === 'function' ? packs.get(packId) : packs[packId]) : undefined;
  if (!pack) throw new Error(`timbre: sample pack "${packId}" is required but was not loaded`);
  return pack;
}

function assertPinned(def, pack, what) {
  const want = def.pack;
  if (pack.manifest.manifestSha256 !== want.manifestSha256 || pack.manifest.contentSha256 !== want.contentSha256) {
    throw new Error(`timbre: ${what} pins sample pack "${want.packId}" ${want.manifestSha256.slice(0, 12)}/${want.contentSha256.slice(0, 12)}, but the loaded pack differs`);
  }
}

/**
 * The bundle createBand({ timbre }) consumes, or null for a neutral score.
 * @param {object} spec validated score artifact
 * @param {Map|object|null} packs loaded, validated packs by packId
 */
export function resolveTimbre(spec, packs = null) {
  const { kits, patches } = timbreNames(spec);
  const graph = usesGraphSamples(spec);
  if (kits.size === 0 && patches.size === 0 && !graph) return null;

  const kitDefs = {};
  const patchDefs = {};
  const bank = new Map();
  const addPack = (def, what) => {
    const pack = takePack(packs, def.pack.packId);
    assertPinned(def, pack, what);
    for (const [assetId, asset] of Object.entries(pack.assets)) bank.set(`${def.pack.packId}/${assetId}`, asset.frames);
  };
  for (const name of kits) {
    kitDefs[name] = KITS[name];
    if (defPack(KITS[name])) addPack(KITS[name], `kit "${name}"`);
  }
  for (const name of patches) {
    patchDefs[name] = PATCHES[name];
    if (defPack(PATCHES[name])) addPack(PATCHES[name], `patch "${name}"`);
  }

  let boundSamples = null;
  if (graph) {
    const pack = takePack(packs, spec.samplePack.packId);
    assertScorePackMatch(spec, pack);
    const packId = spec.samplePack.packId;
    for (const [assetId, asset] of Object.entries(pack.assets)) bank.set(`${packId}/${assetId}`, asset.frames);
    boundSamples = {};
    for (const [voice, binding] of Object.entries(spec.sampleVoices)) {
      boundSamples[voice] = binding.kind === 'sampler'
        ? { kind: 'sampler', gain: binding.gain, release: binding.release, zones: binding.zones.map((z) => ({ lo: z.lo, hi: z.hi, root: z.rootNote, key: `${packId}/${z.assetId}` })) }
        : { kind: 'one-shot', gain: binding.gain, key: `${packId}/${binding.assetId}` };
    }
  }

  return Object.freeze({
    kits: kitDefs,
    kit: spec.kit ?? null,
    patches: patchDefs,
    patchDefaults: spec.patches ?? null,
    sampleBank: bank.size > 0 ? bank : null,
    boundSamples,
  });
}

/** Longest bound-sample asset (seconds), so a graph-routed render keeps its tail. */
export function graphSampleTailSeconds(spec, packs) {
  if (!usesGraphSamples(spec)) return 0;
  const pack = takePack(packs, spec.samplePack.packId);
  let longest = 0;
  for (const binding of Object.values(spec.sampleVoices)) {
    const ids = binding.kind === 'sampler' ? binding.zones.map((z) => z.assetId) : [binding.assetId];
    for (const id of ids) longest = Math.max(longest, (pack.assets[id]?.frames.length ?? 0) / 44100);
  }
  return longest > 0 ? longest + 0.1 : 0;
}

/**
 * The variant names a drum lane offers under a kit (or under the neutral recipe
 * when no kit is named), or null when the lane has a single sound. Used to turn
 * a misspelt `variant` into a validation error instead of a render-time one.
 */
export function laneVariantNames(kitName, voice) {
  let lane = kitName === undefined ? null : KITS[kitName]?.lanes?.[voice] ?? null;
  if (!lane && TIMBRE_LANE_SET.has(voice)) lane = NEUTRAL_LANES[voice];
  return lane?.variants ? Object.keys(lane.variants) : null;
}

/** Seconds a patch rings past its onset (mirrors the engines' envelope arithmetic). */
export function patchTailSeconds(def, dur, opts = {}) {
  const env = def.env ?? {};
  const a = opts.a ?? env.a ?? 0.01;
  const d = opts.d ?? env.d ?? 0.2;
  const r = opts.r ?? env.r ?? 0.3;
  const length = Number.isFinite(dur) && dur > 0 ? dur : 0;
  let tail = Math.max(a + d, length) + r;
  const p = def.params ?? {};
  if (def.engine === 'karplus') {
    tail = p.ring ? (p.decay ?? 1.6) : Math.min(p.decay ?? 1.6, Math.max(0.03, length * (p.holdScale ?? 1)) + r);
  } else if (def.engine === 'sample') {
    const natural = Math.max(...p.zones.map((z) => z.dur ?? 0));
    tail = Math.min(natural || tail, length + (p.ring || 0) + r) + 0.02;
  } else if (def.engine === 'additive') {
    // The slowest partial decays `d * (its d scale)`; the base d already covers d scale 1.
    tail = Math.max(a + d, length) + r;
  }
  return tail;
}

/**
 * Tail (seconds past onset) of an event whose sound comes from a kit lane or a
 * patch; null for everything else, which keeps its historical arithmetic.
 */
export function timbreTailSeconds(spec, track, voice, dur, opts) {
  if (DRUM_LANE_SET.has(voice)) {
    const kitName = opts.kit ?? track.kit ?? spec.kit;
    let lane = null;
    if (kitName !== undefined) lane = KITS[kitName]?.lanes?.[voice] ?? null;
    if (!lane && TIMBRE_LANE_SET.has(voice)) lane = NEUTRAL_LANES[voice];
    if (!lane) return null;
    if (lane.variants) lane = lane.variants[opts.variant] ?? lane.variants[lane.default];
    return opts.dur !== undefined ? opts.dur : lane.dur;
  }
  if (PATCH_CLASS_SET.has(voice)) {
    const name = opts.patch ?? track.patches?.[voice] ?? spec.patches?.[voice];
    if (name === undefined) return null;
    return patchTailSeconds(PATCHES[name], dur, opts);
  }
  return null;
}

/**
 * The kit and patch definitions a score uses, sorted by id, for custody
 * manifests (null for a neutral score). Hosts hash them with their own SHA-256:
 * node's is synchronous, the browser's is not.
 */
export function timbreDefs(spec) {
  const { kits, patches } = timbreNames(spec);
  if (kits.size === 0 && patches.size === 0 && !usesGraphSamples(spec)) return null;
  return {
    kits: [...kits].sort().map((name) => KITS[name]),
    patches: [...patches].sort().map((name) => PATCHES[name]),
    defaultKit: spec.kit,
    defaultPatches: spec.patches,
    graphSamples: usesGraphSamples(spec),
  };
}

/** A manifest row for one definition; `hash` is the host's SHA-256 over canonical JSON. */
export function timbreRow(def, hash) {
  return { id: def.id, version: def.version, kind: def.kind ?? def.engine, sha256: hash, pack: def.pack ?? null };
}

/** Synchronous convenience: the whole manifest block (node). */
export function timbreProvenance(spec, sha256, canonicalJson) {
  const defs = timbreDefs(spec);
  if (!defs) return null;
  const row = (def) => timbreRow(def, sha256(canonicalJson(def)));
  return {
    ...(defs.kits.length ? { kits: defs.kits.map(row) } : {}),
    ...(defs.patches.length ? { patches: defs.patches.map(row) } : {}),
    ...(defs.defaultKit !== undefined ? { defaultKit: defs.defaultKit } : {}),
    ...(defs.defaultPatches !== undefined ? { defaultPatches: defs.defaultPatches } : {}),
    ...(defs.graphSamples ? { graphSamples: true } : {}),
  };
}

/**
 * Kit 1.12.0 bright-voice mode of a score: its explicit `brightVoice` ("r10" | "off"), else "r10" on kit 1.12.0
 * and "off" on every earlier kit, so a score pinned to 1.11.0 renders exactly as it always did.
 */
export function brightVoiceMode(spec) {
  if (spec.brightVoice !== undefined) return spec.brightVoice;
  return isBrightDefaultKitVersion(spec.kitVersion) ? 'r10' : 'off';
}

/**
 * The plan createBand({ bright }) consumes, or null when the treatment is off or the score plays no bright voice
 * (then the band is built exactly as without it). Sides alternate across the bright classes the score plays
 * (src/presets/bright.mjs brightSides). Bound sample voices on the integer custody bus never reach the graph and are
 * not treated (they are left out of the side count).
 */
export function brightPlan(spec) {
  const mode = brightVoiceMode(spec);
  if (mode === 'off') return null;
  const preset = BRIGHT_VOICE_PRESETS[mode];
  const graph = usesGraphSamples(spec);
  const inUse = new Set();
  for (const track of Object.values(spec.tracks)) {
    for (const event of track.steps) {
      const voice = event.voice ?? event.v;
      if (!preset.classes[voice]) continue;
      if (spec.sampleVoices?.[voice] && !graph) continue;
      const opts = eventOpts(event);
      const patch = opts.patch ?? track.patches?.[voice] ?? spec.patches?.[voice];
      if (spec.sampleVoices?.[voice] ? preset.classes[voice].patches === true : isBrightVoice(preset, voice, patch)) inUse.add(voice);
    }
  }
  if (inUse.size === 0) return null;
  const sides = brightSides(preset, inUse);
  const voices = {};
  for (const cls of Object.keys(sides)) voices[cls] = Object.freeze({ side: sides[cls], patches: preset.classes[cls].patches });
  return Object.freeze({ preset, pan: brightPanValue(preset.panPct), voices: Object.freeze(voices) });
}

/** Manifest block for the bright-voice treatment (null when off or nothing bright plays). */
export function brightProvenance(spec, sha256, canonicalJson) {
  const plan = brightPlan(spec);
  if (!plan) return null;
  return {
    preset: plan.preset.id,
    version: plan.preset.version,
    sha256: sha256(canonicalJson(plan.preset)),
    explicit: spec.brightVoice !== undefined,
    sides: Object.fromEntries(Object.entries(plan.voices).map(([cls, v]) => [cls, v.side > 0 ? 'right' : 'left'])),
  };
}

/** Seconds the bright-voice dark tail can ring past a voice's own tail (0 when no plan), for the render length. */
export function brightTailSeconds(spec) {
  const plan = brightPlan(spec);
  return plan ? plan.preset.tail.seconds : 0;
}
