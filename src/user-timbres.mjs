/**
 * User kits and patches (`user:<id>`, OSS-13): the runtime-neutral half.
 *
 * A score may name a user kit wherever it names a kit (`"kit": "user:my-drums"`) and a user patch wherever it names
 * a patch (`"patches": { "pluck": "user:my-keys" }`). The definitions come from `house-band.kit.json` and
 * `house-band.patches.json` in a user pack (written by `samples build`, OSS-12) and are loaded by the node host
 * (src/user-timbres-node.mjs) BEFORE validation. validateSpec binds the loaded registry to the validated artifact
 * (a WeakMap, so the artifact's bytes and its artifactSha256 are untouched), and the wrappers below consult it.
 *
 * This module deliberately lives outside src/timbre.mjs and src/presets/: both are hashed into the kit identity
 * (tools/lib/kit-identity.mjs), and user timbres must not change KIT_VERSION.sha. Every wrapper here delegates to
 * the src/timbre.mjs function it wraps, unchanged, whenever a score names no `user:` timbre, so every existing score
 * takes exactly the path it took before.
 *
 * No node: imports: the Audition Room bundle shares spec.mjs and schedule.mjs, which import this file.
 */

import { DRUM_LANES, NEUTRAL_LANES, PATCH_CLASSES, TIMBRE_LANES } from './kit/band.js';
import { KITS } from './presets/kits/index.mjs';
import { makeKit } from './presets/kits/_dsl.mjs';
import { PATCHES } from './presets/patches/index.mjs';
import { CLASS_VOL, makePatch } from './presets/patches/_dsl.mjs';
import { laneVariantNames, patchTailSeconds, requiredPackIds, resolveTimbre, timbreNames, timbreProvenance, timbreRow, timbreTailSeconds, usesGraphSamples } from './timbre.mjs';
import { assertScorePackMatch } from './sample-pack.mjs';

/** The reserved name prefix. No built-in kit or patch id contains a colon. */
export const USER_PREFIX = 'user:';
/** `<id>` in `user:<id>`: the same slug rule as `id` and patch ids in house-band.samples.json (OSS-10). */
export const USER_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const USER_KIT_FILE = 'house-band.kit.json';
export const USER_PATCHES_FILE = 'house-band.patches.json';

const DRUM_LANE_SET = new Set(DRUM_LANES);
const PATCH_CLASS_SET = new Set(PATCH_CLASSES);
const TIMBRE_LANE_SET = new Set(TIMBRE_LANES);
const HEX_256 = /^[a-f0-9]{64}$/;
const VARIANT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const KIT_FILE_FIELDS = new Set(['title', 'character', 'lineage', 'pack', 'fallbackKit', 'lanes']);
const PATCH_ENTRY_FIELDS = new Set(['id', 'class', 'gain', 'release', 'pack', 'zones']);
const ZONE_FIELDS = new Set(['lo', 'hi', 'rootNote', 'assetId', 'pcmSha256']);
const SAMPLE_LANE_FIELDS = new Set(['sample', 'gain', 'dur']);

export const isUserTimbreName = (name) => typeof name === 'string' && name.startsWith(USER_PREFIX);
export const userTimbreId = (name) => name.slice(USER_PREFIX.length);

const eventOpts = (event) => event.opts ?? event.o ?? {};
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Which user names a (possibly not yet validated) score references.
// ---------------------------------------------------------------------------------------------------------------

/**
 * `{ kits, patches }`: Sets of the `user:` names a raw score references at score, track and event level. Defensive
 * about shape (it runs before validation; anything malformed is validation's job to report).
 */
export function userTimbreNames(spec) {
  const kits = new Set();
  const patches = new Set();
  if (!isPlainObject(spec)) return { kits, patches };
  const addKit = (name) => { if (isUserTimbreName(name)) kits.add(name); };
  const addPatches = (map) => {
    if (!isPlainObject(map)) return;
    for (const name of Object.values(map)) if (isUserTimbreName(name)) patches.add(name);
  };
  addKit(spec.kit);
  addPatches(spec.patches);
  if (isPlainObject(spec.tracks)) {
    for (const track of Object.values(spec.tracks)) {
      if (!isPlainObject(track)) continue;
      addKit(track.kit);
      addPatches(track.patches);
      if (!Array.isArray(track.steps)) continue;
      for (const event of track.steps) {
        if (!isPlainObject(event)) continue;
        const opts = event.opts ?? event.o;
        if (!isPlainObject(opts)) continue;
        addKit(opts.kit);
        if (isUserTimbreName(opts.patch)) patches.add(opts.patch);
      }
    }
  }
  return { kits, patches };
}

// ---------------------------------------------------------------------------------------------------------------
// Turning the OSS-12 files into kit and patch definitions the band interprets.
// ---------------------------------------------------------------------------------------------------------------

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function checkPackIdentity(pack, packId, manifest, where) {
  check(isPlainObject(pack), `${where}.pack: required object`);
  check(pack.packId === packId, `${where}.pack.packId: expected "${packId}", found ${JSON.stringify(pack.packId)}`);
  check(typeof pack.manifestSha256 === 'string' && HEX_256.test(pack.manifestSha256), `${where}.pack.manifestSha256: required lowercase SHA-256`);
  check(typeof pack.contentSha256 === 'string' && HEX_256.test(pack.contentSha256), `${where}.pack.contentSha256: required lowercase SHA-256`);
  check(pack.manifestSha256 === manifest.manifestSha256 && pack.contentSha256 === manifest.contentSha256,
    `${where}.pack: pins ${pack.manifestSha256.slice(0, 12)}/${pack.contentSha256.slice(0, 12)} but pack.json beside it is ${String(manifest.manifestSha256).slice(0, 12)}/${String(manifest.contentSha256).slice(0, 12)}`);
}

function checkSampleLane(lane, packId, assetIds, where) {
  check(isPlainObject(lane), `${where}: must be an object`);
  for (const key of Object.keys(lane)) check(SAMPLE_LANE_FIELDS.has(key), `${where}.${key}: unknown field`);
  check(typeof lane.sample === 'string' && lane.sample.startsWith(`${packId}/`), `${where}.sample: must name an asset of ${packId} as "${packId}/<asset id>"`);
  check(assetIds.has(lane.sample.slice(packId.length + 1)), `${where}.sample: asset "${lane.sample}" is not in pack.json`);
  check(typeof lane.gain === 'number' && Number.isFinite(lane.gain) && lane.gain > 0 && lane.gain <= 4, `${where}.gain: must be a number in (0, 4]`);
  check(typeof lane.dur === 'number' && Number.isFinite(lane.dur) && lane.dur > 0 && lane.dur <= 10, `${where}.dur: must be a number of seconds in (0, 10]`);
}

/**
 * A user kit definition from the object in `house-band.kit.json` (the definition object OSS-12 writes, the same
 * shape as the second argument of makeKit). `manifest` is the pack.json beside it. Throws an Error naming the field
 * when the file is not well formed.
 *
 * Lanes the file does not map play the `fallbackKit` lane: they are copied into the definition (so the kit row
 * hashed into the manifest says exactly what played) and listed in `fallbackLanes`.
 */
export function userKitFromFile(name, file, manifest) {
  const id = userTimbreId(name);
  const packId = `user-${id}`;
  const where = USER_KIT_FILE;
  check(isPlainObject(file), `${where}: must be a JSON object`);
  for (const key of Object.keys(file)) check(KIT_FILE_FIELDS.has(key), `${where}.${key}: unknown field`);
  check(typeof file.title === 'string' && file.title.length > 0, `${where}.title: required string`);
  for (const key of ['character', 'lineage']) {
    if (file[key] !== undefined) check(typeof file[key] === 'string', `${where}.${key}: must be a string`);
  }
  checkPackIdentity(file.pack, packId, manifest, where);
  check(typeof file.fallbackKit === 'string' && Object.hasOwn(KITS, file.fallbackKit), `${where}.fallbackKit: must be a built-in kit id (have ${Object.keys(KITS).join(', ')})`);
  check(isPlainObject(file.lanes) && Object.keys(file.lanes).length > 0, `${where}.lanes: required non-empty object`);
  const assetIds = new Set((manifest.assets || []).map((asset) => asset.id));
  for (const [laneName, lane] of Object.entries(file.lanes)) {
    const at = `${where}.lanes.${laneName}`;
    check(DRUM_LANE_SET.has(laneName), `${at}: drum lanes are ${DRUM_LANES.join(', ')}`);
    if (isPlainObject(lane) && lane.variants !== undefined) {
      for (const key of Object.keys(lane)) check(key === 'default' || key === 'variants', `${at}.${key}: unknown field`);
      check(isPlainObject(lane.variants) && Object.keys(lane.variants).length > 0, `${at}.variants: required non-empty object`);
      for (const [variant, entry] of Object.entries(lane.variants)) {
        check(VARIANT_RE.test(variant), `${at}.variants.${variant}: variant names are lowercase slugs`);
        checkSampleLane(entry, packId, assetIds, `${at}.variants.${variant}`);
      }
      check(typeof lane.default === 'string' && Object.hasOwn(lane.variants, lane.default), `${at}.default: must name one of its variants`);
    } else {
      checkSampleLane(lane, packId, assetIds, at);
    }
  }
  const fallback = KITS[file.fallbackKit];
  const fallbackLanes = DRUM_LANES.filter((lane) => !Object.hasOwn(file.lanes, lane) && Object.hasOwn(fallback.lanes, lane));
  const kit = makeKit(name, file);
  const lanes = { ...kit.lanes };
  for (const lane of fallbackLanes) lanes[lane] = fallback.lanes[lane];
  return deepFreeze({
    ...kit,
    lanes,
    fallbackKit: file.fallbackKit,
    fallbackLanes,
  });
}

const round = (value, places) => Number(value.toFixed(places));

/**
 * A user patch definition (engine "sample", the same shape as the generated sampled patches in
 * src/presets/patches/sampled.mjs) from its entry in `house-band.patches.json`. Zone gain `g` peak-normalises each
 * zone and `dur` is its natural length, both from pack.json, exactly as tools/build-timbre-packs.mjs does for the
 * built-in sampled patches; the entry's `gain` is the patch trim and `release` its envelope release.
 */
export function userPatchFromEntry(name, entry, manifest, packId) {
  const id = userTimbreId(name);
  const where = `${USER_PATCHES_FILE}["${id}"]`;
  check(isPlainObject(entry), `${where}: must be an object`);
  for (const key of Object.keys(entry)) check(PATCH_ENTRY_FIELDS.has(key), `${where}.${key}: unknown field`);
  check(entry.id === name, `${where}.id: expected "${name}", found ${JSON.stringify(entry.id)}`);
  check(PATCH_CLASS_SET.has(entry.class), `${where}.class: must be one of ${PATCH_CLASSES.join(', ')}`);
  check(typeof entry.gain === 'number' && Number.isFinite(entry.gain) && entry.gain > 0 && entry.gain <= 4, `${where}.gain: must be a number in (0, 4]`);
  check(typeof entry.release === 'number' && Number.isFinite(entry.release) && entry.release >= 0 && entry.release <= 10, `${where}.release: must be a number of seconds in [0, 10]`);
  checkPackIdentity(entry.pack, packId, manifest, where);
  check(Array.isArray(entry.zones) && entry.zones.length > 0 && entry.zones.length <= 128, `${where}.zones: required array of 1..128 zones`);
  const assets = new Map((manifest.assets || []).map((asset) => [asset.id, asset]));
  const zones = entry.zones.map((zone, index) => {
    const at = `${where}.zones[${index}]`;
    check(isPlainObject(zone), `${at}: must be an object`);
    for (const key of Object.keys(zone)) check(ZONE_FIELDS.has(key), `${at}.${key}: unknown field`);
    for (const key of ['lo', 'hi', 'rootNote']) check(Number.isInteger(zone[key]) && zone[key] >= 0 && zone[key] <= 127, `${at}.${key}: must be a MIDI note 0..127`);
    check(zone.lo <= zone.hi, `${at}: lo must not be above hi`);
    const asset = assets.get(zone.assetId);
    check(asset !== undefined, `${at}.assetId: asset ${JSON.stringify(zone.assetId)} is not in pack.json`);
    check(zone.pcmSha256 === asset.pcmSha256, `${at}.pcmSha256: differs from the asset in pack.json`);
    check(Number.isInteger(asset.frameCount) && asset.frameCount > 0, `${at}: pack.json asset has no frameCount`);
    return {
      lo: zone.lo, hi: zone.hi, root: zone.rootNote, key: `${packId}/${zone.assetId}`,
      g: round(32768 / Math.max(1, asset.peakAbs ?? 32767), 4), dur: round(asset.frameCount / 44100, 3),
    };
  });
  const patch = makePatch(name, entry.class, 'sample', {
    title: id,
    character: 'user patch',
    lineage: 'user-supplied',
    vol: CLASS_VOL[entry.class],
    env: { a: 0.003, r: entry.release },
    pack: { packId, manifestSha256: entry.pack.manifestSha256, contentSha256: entry.pack.contentSha256 },
    params: { zones },
  });
  return deepFreeze({ ...patch, gain: entry.gain });
}

// ---------------------------------------------------------------------------------------------------------------
// The registry bound to a validated artifact.
// ---------------------------------------------------------------------------------------------------------------

const registries = new WeakMap();

/** Called by validateSpec: bind the user-timbre registry to the frozen artifact it validated. */
export function attachUserTimbres(artifact, registry) {
  registries.set(artifact, registry);
  return artifact;
}

/** The registry a validated artifact was validated against, or null (always null for a score with no `user:` name). */
export function userTimbresOf(spec) {
  return (spec && typeof spec === 'object' && registries.get(spec)) || null;
}

/** True when the validated artifact names a user kit or patch. */
export function usesUserTimbre(spec) {
  return userTimbresOf(spec) !== null;
}

/** A kit definition by name: built-in first, then the artifact's user registry. */
export function kitDefFor(spec, name) {
  if (Object.hasOwn(KITS, name)) return KITS[name];
  return userTimbresOf(spec)?.kits[name]?.def;
}

/** A patch definition by name: built-in first, then the artifact's user registry. */
export function patchDefFor(spec, name) {
  if (Object.hasOwn(PATCHES, name)) return PATCHES[name];
  return userTimbresOf(spec)?.patches[name]?.def;
}

/** laneVariantNames (src/timbre.mjs) that also knows the user kits in `registry`. */
export function laneVariantNamesWithUser(kitName, voice, registry) {
  if (!isUserTimbreName(kitName)) return laneVariantNames(kitName, voice);
  let lane = registry?.kits[kitName]?.def.lanes[voice] ?? null;
  if (!lane && TIMBRE_LANE_SET.has(voice)) lane = NEUTRAL_LANES[voice];
  return lane?.variants ? Object.keys(lane.variants) : null;
}

/** timbreTailSeconds (src/timbre.mjs) that also knows user kits and patches. */
export function timbreTailSecondsWithUser(spec, track, voice, dur, opts) {
  if (!usesUserTimbre(spec)) return timbreTailSeconds(spec, track, voice, dur, opts);
  if (DRUM_LANE_SET.has(voice)) {
    const kitName = opts.kit ?? track.kit ?? spec.kit;
    if (!isUserTimbreName(kitName)) return timbreTailSeconds(spec, track, voice, dur, opts);
    let lane = kitDefFor(spec, kitName)?.lanes?.[voice] ?? null;
    if (!lane && TIMBRE_LANE_SET.has(voice)) lane = NEUTRAL_LANES[voice];
    if (!lane) return null;
    if (lane.variants) lane = lane.variants[opts.variant] ?? lane.variants[lane.default];
    return opts.dur !== undefined ? opts.dur : lane.dur;
  }
  if (PATCH_CLASS_SET.has(voice)) {
    const name = opts.patch ?? track.patches?.[voice] ?? spec.patches?.[voice];
    if (!isUserTimbreName(name)) return timbreTailSeconds(spec, track, voice, dur, opts);
    return patchTailSeconds(patchDefFor(spec, name), dur, opts);
  }
  return null;
}

/** Packs one definition needs: its own, plus a sample-backed fallback kit's when it lends lanes. */
function defPacks(def) {
  const packs = [];
  if (def?.pack) packs.push({ pack: def.pack, def });
  if (def?.fallbackLanes?.length) {
    const fallback = KITS[def.fallbackKit];
    if (fallback.pack) packs.push({ pack: fallback.pack, def: fallback });
  }
  return packs;
}

/** requiredPackIds (src/timbre.mjs) including user packs (and a sample-backed fallback kit's pack). */
export function requiredPackIdsWithUser(spec) {
  if (!usesUserTimbre(spec)) return requiredPackIds(spec);
  const ids = new Set(requiredPackUsersWithUser(spec).keys());
  if (usesGraphSamples(spec)) ids.add(spec.samplePack.packId);
  return [...ids];
}

/**
 * Which kits and patches need which pack: Map<packId, string[]> of `kit:<id>` / `patch:<id>` labels, used to prefix
 * missing-pack errors with the names that need the pack (OSS-07), user kits and patches included. It lives here
 * rather than in src/timbre.mjs because that file is hashed into the kit identity.
 */
export function requiredPackUsersWithUser(spec) {
  const { kits, patches } = timbreNames(spec);
  const users = new Map();
  const add = (packId, label) => {
    const list = users.get(packId);
    if (!list) users.set(packId, [label]);
    else if (!list.includes(label)) list.push(label);
  };
  for (const name of kits) for (const { pack } of defPacks(kitDefFor(spec, name))) add(pack.packId, `kit:${name}`);
  for (const name of patches) for (const { pack } of defPacks(patchDefFor(spec, name))) add(pack.packId, `patch:${name}`);
  return users;
}

function takePack(packs, packId) {
  const pack = packs ? (typeof packs.get === 'function' ? packs.get(packId) : packs[packId]) : undefined;
  if (!pack) throw new Error(`timbre: sample pack "${packId}" is required but was not loaded`);
  return pack;
}

function assertPinned(want, pack, what) {
  if (pack.manifest.manifestSha256 !== want.manifestSha256 || pack.manifest.contentSha256 !== want.contentSha256) {
    throw new Error(`timbre: ${what} pins sample pack "${want.packId}" ${want.manifestSha256.slice(0, 12)}/${want.contentSha256.slice(0, 12)}, but the loaded pack differs`);
  }
}

/** resolveTimbre (src/timbre.mjs) that also resolves user kits and patches; identical for every other score. */
export function resolveTimbreWithUser(spec, packs = null) {
  if (!usesUserTimbre(spec)) return resolveTimbre(spec, packs);
  const { kits, patches } = timbreNames(spec);
  const kitDefs = {};
  const patchDefs = {};
  const bank = new Map();
  const addPacks = (def, what) => {
    for (const { pack: want } of defPacks(def)) {
      const pack = takePack(packs, want.packId);
      assertPinned(want, pack, what);
      for (const [assetId, asset] of Object.entries(pack.assets)) bank.set(`${want.packId}/${assetId}`, asset.frames);
    }
  };
  for (const name of kits) {
    kitDefs[name] = kitDefFor(spec, name);
    addPacks(kitDefs[name], `kit "${name}"`);
  }
  for (const name of patches) {
    patchDefs[name] = patchDefFor(spec, name);
    addPacks(patchDefs[name], `patch "${name}"`);
  }
  let boundSamples = null;
  if (usesGraphSamples(spec)) {
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

/** `{ <user patch name>: def }` for compileTrackStep, or null when the score names no user patch. */
export function userPatchDefs(spec) {
  const registry = userTimbresOf(spec);
  if (!registry || Object.keys(registry.patches).length === 0) return null;
  return Object.fromEntries(Object.entries(registry.patches).map(([name, entry]) => [name, entry.def]));
}

/**
 * timbreProvenance (src/timbre.mjs) with custody for user timbres; identical for every other score. Each user kit or
 * patch row adds `user`: the pack id, its manifest and content hashes, the file it came from and the SHA-256 of
 * its entry there (canonical JSON). A user kit row also names its fallback kit and the lanes it lent.
 */
export function timbreProvenanceWithUser(spec, sha256, canonicalJson) {
  const registry = userTimbresOf(spec);
  if (!registry) return timbreProvenance(spec, sha256, canonicalJson);
  const { kits, patches } = timbreNames(spec);
  const row = (name, def, entry) => {
    const base = timbreRow(def, sha256(canonicalJson(def)));
    if (!entry) return base;
    return {
      ...base,
      user: {
        packId: entry.packId,
        manifestSha256: entry.manifestSha256,
        contentSha256: entry.contentSha256,
        file: entry.file,
        entrySha256: entry.entrySha256,
        ...(entry.def.fallbackKit !== undefined ? {
          fallbackKit: { id: entry.def.fallbackKit, sha256: sha256(canonicalJson(KITS[entry.def.fallbackKit])), lanes: entry.def.fallbackLanes },
        } : {}),
      },
    };
  };
  const kitRows = [...kits].sort().map((name) => row(name, kitDefFor(spec, name), registry.kits[name]));
  const patchRows = [...patches].sort().map((name) => row(name, patchDefFor(spec, name), registry.patches[name]));
  return {
    ...(kitRows.length ? { kits: kitRows } : {}),
    ...(patchRows.length ? { patches: patchRows } : {}),
    ...(spec.kit !== undefined ? { defaultKit: spec.kit } : {}),
    ...(spec.patches !== undefined ? { defaultPatches: spec.patches } : {}),
    ...(usesGraphSamples(spec) ? { graphSamples: true } : {}),
  };
}

/**
 * The pack format version of the first user pack in a loadUserTimbres registry, or null when there is none. The API
 * custody profile treats a score with user timbres like a sample-backed score of that pack format.
 */
export function userPackFormatVersion(registry) {
  if (!registry) return null;
  const entries = [...Object.values(registry.kits), ...Object.values(registry.patches)];
  return entries.length > 0 ? entries[0].formatVersion : null;
}

/**
 * One line per user kit whose missing lanes the score actually plays:
 * `user kit my-drums: tomLow, ride, crash play tr808`. Empty when nothing falls back.
 */
export function userKitFallbackNotes(spec) {
  const registry = userTimbresOf(spec);
  if (!registry) return [];
  const played = new Map();
  for (const track of Object.values(spec.tracks)) {
    for (const event of track.steps) {
      const voice = event.voice ?? event.v;
      if (!DRUM_LANE_SET.has(voice)) continue;
      const kitName = eventOpts(event).kit ?? track.kit ?? spec.kit;
      if (!isUserTimbreName(kitName)) continue;
      if (!played.has(kitName)) played.set(kitName, new Set());
      played.get(kitName).add(voice);
    }
  }
  const notes = [];
  for (const name of [...played.keys()].sort()) {
    const def = registry.kits[name]?.def;
    if (!def) continue;
    const lanes = def.fallbackLanes.filter((lane) => played.get(name).has(lane));
    if (lanes.length > 0) notes.push(`user kit ${userTimbreId(name)}: ${lanes.join(', ')} play ${def.fallbackKit}`);
  }
  return notes;
}
