/**
 * Composer's Desk provider adapter boundary.
 *
 * Defines the common interface that every transport adapter must expose,
 * plus shared helpers for normalising raw responses and wrapping transport
 * failures in DeskError instances.
 */

import { DeskError, CODES } from '../errors.mjs';

/**
 * Base provider interface.
 *
 * All adapters must expose:
 *  - laneId: string identifier used for logging/metrics
 *  - model: string model name
 *  - maxTransportAttempts: number of provider calls the orchestrator may make
 *  - callTimeoutMs: per-call timeout
 *  - totalDeadlineMs: total budget across all attempts
 *  - async health(): returns a status string ('configured', 'missing configuration',
 *    'unreachable/limited', etc.)
 *  - async generate({ request, signal }): returns a raw JSON string
 *
 * Cancellation is negotiated through an optional AbortSignal. Adapters must
 * attempt to abort in-flight work when the signal fires, and must not throw
 * a DeskError for a user-initiated cancellation unless the caller expects one.
 */
export class BaseProvider {
  constructor({
    laneId,
    model,
    maxTransportAttempts = 1,
    callTimeoutMs = 30_000,
    totalDeadlineMs = 120_000,
  } = {}) {
    if (!laneId || typeof laneId !== 'string') throw new Error('BaseProvider: laneId is required');
    if (!model || typeof model !== 'string') throw new Error('BaseProvider: model is required');
    this.laneId = laneId;
    this.model = model;
    this.maxTransportAttempts = maxTransportAttempts;
    this.callTimeoutMs = callTimeoutMs;
    this.totalDeadlineMs = totalDeadlineMs;
  }

  async health() {
    return 'configured';
  }

  async generate({ request, signal }) {
    void request;
    void signal;
    throw new Error('BaseProvider: generate() must be implemented by subclass');
  }
}

/**
 * Normalise a provider response to a UTF-8 string.
 *
 * Accepts strings, Buffers, or anything with a toString method. Keeps the
 * adapter boundary focused on transport: validation happens upstream.
 */
export function normalizeProviderResponse(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw && typeof raw === 'object') {
    if (typeof raw.toString === 'function') {
      try {
        return raw.toString('utf8');
      } catch {
        return String(raw);
      }
    }
  }
  return String(raw);
}

/**
 * Wrap a transport failure in a DeskError.
 */
export function providerError(code, message, details = {}) {
  if (!Object.values(CODES).includes(code)) {
    throw new Error(`providerError: unknown error code ${code}`);
  }
  return new DeskError(code, message, details);
}
