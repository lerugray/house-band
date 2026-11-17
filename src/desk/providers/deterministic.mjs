/**
 * Deterministic test-double adapter for the Composer's Desk.
 *
 * Reuses the existing DeterministicScoreProvider and deterministicScore
 * implementation from src/api/provider.mjs. The desk boundary passes a
 * request object shaped by composerRequest(); this adapter converts the
 * basePrompt back into the admission shape deterministicScore expects.
 */

import { deterministicScore, DeterministicScoreProvider as ApiDeterministicProvider } from '../../api/provider.mjs';
import { canonicalJson } from '../../provenance.mjs';
import { arrange } from '../../cowrite/arranger.mjs';
import { BaseProvider } from './base.mjs';

function basePromptToAdmission(basePrompt) {
  return {
    prompt: basePrompt.userPrompt ?? '',
    titleHint: basePrompt.label,
    scoreSchemaVersion: basePrompt.scoreSchemaVersion,
    pack: basePrompt.packIdentity
      ? {
          identity: basePrompt.packIdentity,
          assetAllowlist: null,
          resolvedAssets: basePrompt.assetAllowlist ?? [],
        }
      : null,
    canonicalVoiceAllowlist: basePrompt.canonicalVoiceAllowlist,
    seed: basePrompt.seed,
    duration: basePrompt.duration,
    sections: basePrompt.sections,
  };
}

export class DeterministicProvider extends BaseProvider {
  constructor(profile = {}) {
    super({
      laneId: 'deterministic',
      model: profile.model ?? 'house-band-deterministic-score-author/1.0.0',
      maxTransportAttempts: profile.maxTransportAttempts ?? 1,
      callTimeoutMs: profile.callTimeoutMs ?? 5_000,
      totalDeadlineMs: profile.totalDeadlineMs ?? 30_000,
    });
    this.inner = new ApiDeterministicProvider();
  }

  async health() {
    return 'configured';
  }

  async generate({ request, signal }) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('cancelled');
    }
    // Brief-generation requests are plain-text; the deterministic double returns
    // a stable, schema-neutral brief so tests can exercise the full flow offline.
    if (request?.requestFormat === 'hb-desk-brief/1.0.0' || request?.task?.includes('brief')) {
      return JSON.stringify(`Clear pulse, moderate density, two distinct sections with harmonic movement. Prompt: ${request?.rawPrompt ?? ''}`).slice(1, -1);
    }
    const basePrompt = request?.basePrompt ?? request ?? {};
    // Co-write develop (OSS-22): the offline double answers with the arranger engine's
    // score for the same source, form and seed, which keeps every user note.
    if (basePrompt.cowrite) {
      const c = basePrompt.cowrite;
      const { spec } = arrange(c.sourceSong, { form: c.form, drafts: c.drafts ?? [], lengthBars: c.lengthBars ?? null, kit: c.kit, seed: c.seed });
      return canonicalJson(spec);
    }
    const admission = basePromptToAdmission(basePrompt);
    const raw = await this.inner.generate({ admission, fixedRegister: basePrompt.fixedRegister });
    return raw;
  }
}
