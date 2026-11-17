/** PatternSpec and canonical kit identities. */
export const LEGACY_SCHEMA_VERSION = '1.0.0';
export const SCHEMA_VERSION = '1.1.0';
export const PHRASE_SCHEMA_VERSION = '1.2.0';
export const SUPPORTED_CURRENT_SCHEMAS = Object.freeze([SCHEMA_VERSION, PHRASE_SCHEMA_VERSION]);
export const COMPILER_VERSION = 'dr5-phrase/1.0.0';

const PRE_PERFORMANCE_KIT_VERSION = Object.freeze({
  semver: '1.1.0',
  sha: 'b2709519f2faf8481de28e0a5e9912cd2e80ae9e290fdfca88915c0377aaf773',
});

const PERFORMANCE_KIT_VERSION = Object.freeze({
  semver: '1.2.0',
  sha: '33eeb8aa5297953394dd56e00852ed9e3d5cc2721327b5794b6ca05c0247f05b',
});

const CHIP_FX_KIT_VERSION = Object.freeze({
  semver: '1.3.0',
  sha: '8ac798658c15d33ffbc6b1a4286bd155f78be4ffb825860d57958c7aca17680c',
});

const DOCTRINE_KIT_VERSION = Object.freeze({
  semver: '1.4.0',
  sha: 'b390d6fdc76e0b833f450b597118381dc6d3be70ab24cbe21a486fd6b7105fe0',
});

const PRE_ENVELOPE_CONTINUITY_KIT_VERSION = Object.freeze({
  semver: '1.5.0',
  sha: 'b8f8266f639b3f457c66545161ec5b68774dec7cba0408c8484e77bdf1d843ba',
});

const PRE_SAMPLER_KIT_VERSION = Object.freeze({
  semver: '1.6.0',
  sha: 'ec078304df4f79ee6c8a324a1e639b517e8948956d5db908583002e66562adeb',
});

const PRE_SUB_OPT_OUT_KIT_VERSION = Object.freeze({
  semver: '1.7.0',
  sha: '2f83511cf6e33ac684fc862ca200783382eb68ffaba7d5195e9f9e6560a77bc8',
});

const PRE_FX_KIT_VERSION = Object.freeze({
  semver: '1.7.1',
  sha: 'f097bd3810ad7ebd5ab588c804892bb1e44689faa003da664899a2f458d7a1d4',
});

const PRE_THEMATIC_FX_KIT_VERSION = Object.freeze({
  semver: '1.8.0',
  sha: '7a701628773a2b73373a94cb61b442897c33f8ef7374c2f121c4ce52ab5aabcb',
});

const PRE_PHRASE_KIT_VERSION = Object.freeze({
  semver: '1.9.0',
  sha: '4e27575dc63f5b01a7c5392a28d47ffeeec217b931755618dd7b51dd970c6417',
});

/**
 * Kit 1.10.0 (DR5 phrase pilot): the kit identity every shipped DR5-era score
 * declares. The current engine still renders it, natively: kit 1.11.0 only ADDS
 * (named kits, patches, in-graph samples) behind fields a 1.10.0 score cannot
 * carry, and a standing test pins byte-identity of the neutral path against
 * hashes recorded from the 1.10.0 engine (test/timbre-backcompat.test.mjs).
 */
export const PRE_TIMBRE_KIT_VERSION = Object.freeze({
  semver: '1.10.0',
  sha: '6861b59f29e8eaa74db36b6dd74cce94a91bf6dce14da64512457fde3e95dc12',
});

/**
 * Kit 1.11.0 (Timbre Range, s383): named drum kits, named instrument patches,
 * in-graph samples. Every score rendered before the bright-voice default pins
 * this identity, and the current engine still renders it natively and
 * byte-identically: kit 1.12.0 only changes a score whose kit is 1.12.0 or
 * that opts in with `brightVoice: "r10"` (test/bright-voice.test.mjs).
 */
export const PRE_BRIGHT_KIT_VERSION = Object.freeze({
  semver: '1.11.0',
  sha: 'e84cca174a353f8ae5519768de717667384eb5310fe2cad7fd270100ae5ca21a',
});

// sha is SHA-256 over path\0bytes\0 for band.js, prng.js, then (sorted) src/timbre.mjs and
// every file under src/presets/ (tools/lib/kit-identity.mjs). The source-hash tests make
// accidental version drift fail loudly even in an uncommitted lane.
// 1.12.0 (bright voice, s462): bells, glock and bright leads get the Darkness r10
// treatment by default (src/presets/bright.mjs). tools/dr5/update-identity.mjs rewrites this sha.
export const KIT_VERSION = Object.freeze({
  semver: '1.12.0',
  sha: 'ccc872103cf79c2163a615ae30bedfec82dc1f4248a2d7038d935805b45e482d',
});

/**
 * Explicit score-schema x kit compatibility matrix. Historical artifacts keep
 * their reviewed kit identity; the neutral performance path preserves their
 * synthesis output while new performance declarations require the current kit.
 */
export const SCORE_COMPATIBILITY = Object.freeze({
  [PHRASE_SCHEMA_VERSION]: Object.freeze([PRE_TIMBRE_KIT_VERSION, PRE_BRIGHT_KIT_VERSION, KIT_VERSION]),
  [LEGACY_SCHEMA_VERSION]: Object.freeze([PRE_PERFORMANCE_KIT_VERSION, PERFORMANCE_KIT_VERSION, CHIP_FX_KIT_VERSION, DOCTRINE_KIT_VERSION, PRE_ENVELOPE_CONTINUITY_KIT_VERSION, PRE_SAMPLER_KIT_VERSION, PRE_SUB_OPT_OUT_KIT_VERSION, PRE_FX_KIT_VERSION, PRE_THEMATIC_FX_KIT_VERSION, PRE_PHRASE_KIT_VERSION, PRE_TIMBRE_KIT_VERSION, PRE_BRIGHT_KIT_VERSION, KIT_VERSION]),
  [SCHEMA_VERSION]: Object.freeze([PRE_PERFORMANCE_KIT_VERSION, PERFORMANCE_KIT_VERSION, CHIP_FX_KIT_VERSION, DOCTRINE_KIT_VERSION, PRE_ENVELOPE_CONTINUITY_KIT_VERSION, PRE_SAMPLER_KIT_VERSION, PRE_SUB_OPT_OUT_KIT_VERSION, PRE_FX_KIT_VERSION, PRE_THEMATIC_FX_KIT_VERSION, PRE_PHRASE_KIT_VERSION, PRE_TIMBRE_KIT_VERSION, PRE_BRIGHT_KIT_VERSION, KIT_VERSION]),
});

export function isCompatibleKitVersion(schemaVersion, value) {
  return Boolean(SCORE_COMPATIBILITY[schemaVersion]?.some(
    (kit) => value?.semver === kit.semver && value?.sha === kit.sha,
  ));
}

/** Exactly the current kit (API admission, composer prompts, custody profiles). */
export function isCurrentKitVersion(value) {
  return value?.semver === KIT_VERSION.semver && value?.sha === KIT_VERSION.sha;
}

const sameKit = (value, kit) => value?.semver === kit.semver && value?.sha === kit.sha;

/**
 * Kits the current engine renders natively (1.10.0, 1.11.0 and 1.12.0), with the DR5
 * phrase/spatial/fx/retire/doctrine surface. Older kits go to the frozen
 * pre-DR5 renderer. Not the same question as isCurrentKitVersion: the API still
 * admits only the exact current kit.
 */
export function isNativeKitVersion(value) {
  return isCurrentKitVersion(value) || sameKit(value, PRE_TIMBRE_KIT_VERSION) || sameKit(value, PRE_BRIGHT_KIT_VERSION);
}

/** The Timbre Range surface (kit, patches, palette, added drum lanes, brightVoice) needs 1.11.0 or 1.12.0. */
export function isTimbreKitVersion(value) {
  return isCurrentKitVersion(value) || sameKit(value, PRE_BRIGHT_KIT_VERSION);
}

/**
 * Kit 1.12.0: bright voices get the r10 treatment unless the score says `brightVoice: "off"`.
 * A 1.11.0 score keeps its sound unless it says `brightVoice: "r10"`.
 */
export function isBrightDefaultKitVersion(value) {
  return isCurrentKitVersion(value);
}
