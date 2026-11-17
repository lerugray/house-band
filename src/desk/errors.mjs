/**
 * Desk-specific errors mapped to operator-readable messages.
 */

export class DeskError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DeskError';
    this.code = code;
    this.details = details;
  }

  envelope() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export const CODES = Object.freeze({
  CONFIG_MISSING: 'CONFIG_MISSING',
  PROVIDER_UNREACHABLE: 'PROVIDER_UNREACHABLE',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  WEISS_FAILED: 'WEISS_FAILED',
  COMPOSITION_FAILED: 'COMPOSITION_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  TAKE_NOT_FOUND: 'TAKE_NOT_FOUND',
  RENDER_FAILED: 'RENDER_FAILED',
  EXPORT_FAILED: 'EXPORT_FAILED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  TOOLCHAIN_UNAVAILABLE: 'TOOLCHAIN_UNAVAILABLE',
  PACK_MISSING: 'PACK_MISSING',
  PACK_IDENTITY_MISMATCH: 'PACK_IDENTITY_MISMATCH',
});

export function operatorMessage(error) {
  if (error instanceof DeskError) {
    switch (error.code) {
      case CODES.CONFIG_MISSING:
        return 'The model configuration is missing.';
      case CODES.PROVIDER_UNREACHABLE:
        return 'Sonnet could not be reached.';
      case CODES.PROVIDER_TIMEOUT:
        return 'The model did not answer in time.';
      case CODES.WEISS_FAILED:
        return 'Weiss did not answer.';
      case CODES.COMPOSITION_FAILED:
        return 'The model could not compose a valid score.';
      case CODES.VALIDATION_FAILED:
        return 'The model answered, but the score still breaks composition rules.';
      case CODES.RENDER_FAILED:
        return 'Rendering failed.';
      case CODES.EXPORT_FAILED:
        return 'Export failed.';
      case CODES.TOOLCHAIN_UNAVAILABLE:
        return 'The custody renderer is not available on this machine.';
      default:
        return error.message;
    }
  }
  return error?.message || 'Something went wrong.';
}
