/**
 * cowrite develop (OSS-22): run an engine, then hold the result to the keep layer.
 * Rendering and the audit gates live in tools/cowrite/develop.mjs; this module never
 * renders, so a broken keep layer stops here before any audio exists.
 */
import { arrange, FORMS } from './arranger.mjs';
import { developWithLlm } from './develop-llm.mjs';
import { checkKeepLayer } from './keep-layer.mjs';
import { validateSourceSong } from './source-song.mjs';

export const ENGINES = Object.freeze(['arranger', 'llm']);
export const DEVELOP_RECORD_FORMAT = 'house-band-cowrite-develop';
export const DEVELOP_RECORD_VERSION = 1;

/**
 * Every octave fold the keep layer saw must be listed in the record's changes; an unlisted
 * move is a broken keep layer even when the range rule would allow it.
 */
function requireListedFolds(keepLayer, changes, material) {
  const listed = new Set(changes
    .filter((c) => c.kind === 'octave-fold' && c.material === material)
    .map((c) => `${c.track}#${c.noteIndex}`));
  const unlisted = keepLayer.moved.filter((m) => !listed.has(`${m.track}#${m.noteIndex}`));
  if (unlisted.length === 0) return keepLayer;
  return {
    ...keepLayer,
    ok: false,
    missing: [
      ...keepLayer.missing,
      ...unlisted.map((m) => ({ track: m.track, noteIndex: m.noteIndex, beat: m.beat, midi: m.midi, note: m.note, section: m.section, reason: `octave fold to ${m.toNote} is not listed in develop.json` })),
    ],
  };
}

/**
 * @param {object} sourceInput house-band-source-song
 * @param {{ engine?: 'arranger'|'llm', form?: string, drafts?: object[], lengthBars?: number|null,
 *   kit?: string, seed?: number, brief?: string|null, provider?: object, profileId?: string,
 *   progressionVariant?: number, leadTrimDb?: number, sectionLeadTrimDb?: number[], maxValidationAttempts?: number }} [options]
 * @returns {Promise<{ spec: object, record: object, keepLayer: object, draftKeepLayers: object[] }>}
 */
export async function developScore(sourceInput, options = {}) {
  const source = validateSourceSong(JSON.parse(JSON.stringify(sourceInput)));
  const drafts = (options.drafts ?? []).map((d) => validateSourceSong(JSON.parse(JSON.stringify(d))));
  const engine = options.engine ?? 'arranger';
  if (!ENGINES.includes(engine)) throw new Error(`unknown engine "${engine}" (have ${ENGINES.join(', ')})`);
  const form = options.form ?? 'subtractive';
  if (!FORMS.includes(form)) throw new Error(`unknown form "${form}" (have ${FORMS.join(', ')})`);
  const common = {
    form,
    drafts,
    lengthBars: options.lengthBars ?? null,
    kit: options.kit ?? 'tr808',
    seed: options.seed ?? 1,
    brief: options.brief ?? null,
  };
  let spec;
  let record;
  if (engine === 'arranger') {
    ({ spec, record } = arrange(source, {
      ...common,
      progressionVariant: options.progressionVariant ?? 0,
      leadTrimDb: options.leadTrimDb ?? 0,
      sectionLeadTrimDb: options.sectionLeadTrimDb ?? [],
    }));
  } else {
    ({ spec, record } = await developWithLlm(source, {
      ...common,
      provider: options.provider,
      profileId: options.profileId,
      maxValidationAttempts: options.maxValidationAttempts,
    }));
  }
  let keepLayer = checkKeepLayer(source, spec, { sections: record.userSections });
  keepLayer = requireListedFolds(keepLayer, record.changes, 'A');
  const draftKeepLayers = drafts.map((d, k) => requireListedFolds(
    checkKeepLayer(d, spec, { sections: record.draftSections[k]?.sections ?? [] }),
    record.changes,
    k === 0 ? 'B' : 'C',
  ));
  return { spec, record, keepLayer, draftKeepLayers, source, drafts };
}
