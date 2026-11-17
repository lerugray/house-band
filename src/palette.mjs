/**
 * The Timbre-Variety Law at compose time (Ray, 2026-08-29): a score must say
 * which kit and patches it plays and how that differs from its sibling scores.
 * This module reads a PARSED score (validated or not; it tolerates older kits and
 * foreign shapes) and reduces it to its palette: the set of named timbre choices
 * it actually plays. Two scores with the same palette are the violation.
 *
 * Runtime-neutral (no fs): src/palette-node.mjs reads files, tools/palette-check.mjs
 * is the CLI, and src/compose.mjs warns with it.
 */

const DRUM_LANES = new Set(['kick', 'snare', 'hat', 'tomLow', 'tomMid', 'tomHigh', 'clap', 'rim', 'ride', 'crash', 'perc']);
export const PATCH_CLASSES = Object.freeze(['pad', 'bass', 'lead', 'pluck', 'bell']);
// Voices with neither a kit nor a patch selector still colour a score; they are
// reported (so a chip score is visible as one) but cannot be varied by name.
const FIXED_VOICES = new Set(['drone', 'air', 'chipPulse', 'chipTriangle', 'chipNoise']);

const isScoreShaped = (spec) => spec && typeof spec === 'object' && spec.tracks && typeof spec.tracks === 'object' && Array.isArray(spec.sections);

/** The palette of one parsed score, or null when it is not a House Band score. */
export function scorePalette(spec) {
  if (!isScoreShaped(spec)) return null;
  const kits = new Set();
  const patches = Object.fromEntries(PATCH_CLASSES.map((cls) => [cls, new Set()]));
  const fixed = new Set();
  const samples = new Set();
  for (const track of Object.values(spec.tracks)) {
    for (const event of track.steps ?? []) {
      const voice = event.voice ?? event.v;
      const opts = event.opts ?? event.o ?? {};
      if (DRUM_LANES.has(voice)) kits.add(opts.kit ?? track.kit ?? spec.kit ?? 'default');
      else if (patches[voice]) patches[voice].add(opts.patch ?? track.patches?.[voice] ?? spec.patches?.[voice] ?? 'default');
      else if (FIXED_VOICES.has(voice)) fixed.add(voice);
      if (spec.sampleVoices && Object.hasOwn(spec.sampleVoices, voice)) {
        const binding = spec.sampleVoices[voice];
        samples.add(`${spec.samplePack?.packId ?? 'pack'}:${voice}=${binding.assetId ?? (binding.zones ?? []).map((z) => z.assetId).sort().join('+')}`);
      }
    }
  }
  const used = Object.fromEntries(PATCH_CLASSES.filter((cls) => patches[cls].size > 0).map((cls) => [cls, [...patches[cls]].sort()]));
  return {
    kits: [...kits].sort(),
    patches: used,
    fixedVoices: [...fixed].sort(),
    samples: [...samples].sort(),
    declared: spec.palette !== undefined,
    differsFrom: typeof spec.palette?.differsFrom === 'string' ? spec.palette.differsFrom : null,
    kitVersion: spec.kitVersion?.semver ?? null,
  };
}

/** Flat, comparable list of the palette's components: `kit:tr808`, `pad:glass-fm`, ... */
export function paletteComponents(palette) {
  return [
    ...palette.kits.map((k) => `kit:${k}`),
    ...Object.entries(palette.patches).flatMap(([cls, names]) => names.map((n) => `${cls}:${n}`)),
    ...palette.samples.map((s) => `sample:${s}`),
  ].sort();
}

/** Human line for a palette: "kit tr808 | pad glass-fm | bass reese". */
export function describePalette(palette) {
  const parts = [];
  if (palette.kits.length) parts.push(`kit ${palette.kits.join('+')}`);
  for (const [cls, names] of Object.entries(palette.patches)) parts.push(`${cls} ${names.join('+')}`);
  if (palette.samples.length) parts.push(`${palette.samples.length} bound sample(s)`);
  if (palette.fixedVoices.length) parts.push(`fixed: ${palette.fixedVoices.join(', ')}`);
  return parts.join(' | ') || '(no timbre voices)';
}

/** How many palette components differ between two scores (0 = identical palettes). */
export function paletteDistance(a, b) {
  const x = new Set(paletteComponents(a));
  const y = new Set(paletteComponents(b));
  let differing = 0;
  for (const c of x) if (!y.has(c)) differing++;
  for (const c of y) if (!x.has(c)) differing++;
  return differing;
}

/**
 * Findings for one candidate score against its siblings.
 * `minDiff` is how many components must differ from EVERY sibling (default 1:
 * only an identical palette is a defect).
 */
export function checkPalette(name, palette, siblings, { minDiff = 1 } = {}) {
  const findings = [];
  const eligible = palette.kitVersion === '1.11.0' || palette.kitVersion === '1.12.0';
  if (eligible && !palette.declared) {
    findings.push({ level: 'warn', code: 'palette-undeclared', message: `${name}: declares no \`palette.differsFrom\` note (Timbre-Variety Law: say how this score differs from the last three siblings)` });
  }
  if (!eligible) {
    findings.push({ level: 'info', code: 'legacy-kit', message: `${name}: kit ${palette.kitVersion ?? 'unknown'} cannot name a kit or patches, so it plays the default palette (${describePalette(palette)})` });
  }
  for (const [siblingName, sibling] of siblings) {
    const distance = paletteDistance(palette, sibling);
    if (distance < minDiff) {
      findings.push({
        level: 'error', code: 'palette-identical', sibling: siblingName,
        message: `${name}: palette is ${distance === 0 ? 'IDENTICAL to' : `only ${distance} component(s) from`} sibling ${siblingName} (${describePalette(palette)}). Change the kit or a patch, or say why not.`,
      });
    }
  }
  return findings;
}
