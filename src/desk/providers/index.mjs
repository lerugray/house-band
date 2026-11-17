/**
 * Composer's Desk provider factory.
 */

import { PROFILE_TYPES } from '../config.mjs';
import { ClaudeCliProvider } from './claude-cli.mjs';
import { DeterministicProvider } from './deterministic.mjs';
import { OpenAiCompatibleDeskProvider } from './openai-compatible.mjs';

/**
 * Create the right provider adapter for a profile.
 */
export function createProvider(profile, env = Object.create(null)) {
  if (!profile || typeof profile !== 'object') {
    throw new TypeError('createProvider: profile is required');
  }
  switch (profile.type) {
    case PROFILE_TYPES.DETERMINISTIC:
      return new DeterministicProvider(profile, env);
    case PROFILE_TYPES.CLAUDE_CLI:
      return new ClaudeCliProvider(profile, env);
    case PROFILE_TYPES.OPENAI_COMPATIBLE:
      return new OpenAiCompatibleDeskProvider(profile, env);
    default:
      throw new TypeError(`createProvider: unsupported profile type ${profile.type}`);
  }
}

/**
 * Convenience helper that returns the provider's own health status string.
 */
export async function healthCheck(provider) {
  if (!provider || typeof provider.health !== 'function') {
    throw new TypeError('healthCheck: provider with health() method is required');
  }
  return provider.health();
}
