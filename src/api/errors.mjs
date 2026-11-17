export const API_VERSION = '1.0.0';

const HTTP_STATUS = Object.freeze({
  INVALID_REQUEST: 400,
  UNSUPPORTED_SCORE_SCHEMA: 422,
  MODEL_LANE_UNAVAILABLE: 503,
  COMPOSITION_DEADLINE_EXCEEDED: 503,
  WEISS_FAILED: 424,
  PACK_MISSING: 424,
  PACK_INCOMPATIBLE: 409,
  PACK_IDENTITY_MISMATCH: 409,
  COMPOSITION_INVALID_AFTER_RETRIES: 422,
  TOOLCHAIN_UNAVAILABLE: 503,
  RENDER_FAILED: 500,
  RENDER_MISMATCH: 500,
  ARTIFACT_WRITE_FAILED: 500,
  EVENT_CURSOR_EXPIRED: 409,
  JOB_CANCELED: 409,
  JOB_NOT_FOUND: 404,
  ARTIFACT_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
});

export class ApiError extends Error {
  constructor(code, message, { retryable = false, stage = 'request', details = {}, validationErrors, jobId, cause } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.code = code;
    this.retryable = retryable;
    this.stage = stage;
    this.details = Object.freeze({ apiVersion: API_VERSION, ...details });
    this.validationErrors = validationErrors;
    this.jobId = jobId;
    this.status = HTTP_STATUS[code] ?? 500;
  }

  envelope() {
    const body = {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        stage: this.stage,
        details: this.details,
      },
    };
    if (this.jobId) body.jobId = this.jobId;
    if (this.validationErrors) body.validationErrors = this.validationErrors;
    return body;
  }
}

export function unsupportedFeature(feature, supported = []) {
  return new ApiError('INVALID_REQUEST', `${feature} is not supported by API tranche 1`, {
    details: { feature, supported, tranche: 1 },
  });
}
