/**
 * OpenAI-compatible provider adapter for the Composer's Desk.
 *
 * Extends the existing OpenAiCompatibleProvider from src/api/provider.mjs
 * so the message construction stays consistent, but injects the apiKey from
 * the constructor-supplied env object rather than reading process.env.
 */

import { OpenAiCompatibleProvider as ApiOpenAiProvider } from '../../api/provider.mjs';
import { BaseProvider, normalizeProviderResponse, providerError } from './base.mjs';
import { CODES } from '../errors.mjs';

export class OpenAiCompatibleDeskProvider extends BaseProvider {
  constructor(profile = {}, env = Object.create(null)) {
    super({
      laneId: profile.id ?? 'openai-compatible',
      model: profile.model ?? 'unknown',
      maxTransportAttempts: profile.maxTransportAttempts ?? 3,
      callTimeoutMs: profile.callTimeoutMs ?? 120_000,
      totalDeadlineMs: profile.totalDeadlineMs ?? 300_000,
    });
    this.profile = profile;
    this.env = env;
    this.apiKeyEnvVar = profile.apiKeyEnvVar;
    this.baseUrl = (profile.baseUrl ?? '').replace(/\/+$/, '');
    this.temperature = profile.temperature ?? 0.2;
    this.maxTokens = profile.maxTokens ?? 8_192;
    this.numPredict = profile.numPredict ?? null;
    this.responseFormat = { type: 'json_object' };
    this.inner = new ApiOpenAiProvider({
      baseUrl: this.baseUrl,
      apiKeyEnvVar: this.apiKeyEnvVar,
      model: this.model,
      laneId: this.laneId,
      displayName: profile.displayName ?? 'OpenAI-compatible provider',
      maxTransportAttempts: this.maxTransportAttempts,
      callTimeoutMs: this.callTimeoutMs,
      totalDeadlineMs: this.totalDeadlineMs,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      responseFormat: this.responseFormat,
    });
  }

  async health() {
    const configured = Boolean(this.env[this.apiKeyEnvVar]);
    return configured ? 'configured' : 'missing configuration';
  }

  async generate({ request, signal }) {
    const apiKey = this.env[this.apiKeyEnvVar];
    if (!apiKey) {
      throw providerError(CODES.CONFIG_MISSING, `environment variable ${this.apiKeyEnvVar} is not set`, { envVar: this.apiKeyEnvVar });
    }

    if (signal?.aborted) {
      throw signal.reason ?? new Error('cancelled');
    }

    const url = `${this.baseUrl}/chat/completions`;
    const messages = this.inner.buildMessages(request);
    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      response_format: this.responseFormat,
      ...(this.numPredict !== null && this.numPredict !== undefined ? { num_predict: this.numPredict } : {}),
    };

    const fetchOptions = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    };

    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      throw providerError(CODES.PROVIDER_UNREACHABLE, `provider transport error: ${error.message}`, { cause: error.message });
    }

    if (!response.ok) {
      let text = '';
      try { text = await response.text(); } catch {}
      const status = response.status;
      const limited = status === 429 || looksUnavailable(text);
      throw providerError(CODES.PROVIDER_UNREACHABLE, `provider returned HTTP ${status}`, {
        status,
        bodySnippet: text.slice(0, 500),
        ...(limited ? { status: 'unreachable/limited' } : {}),
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw providerError(CODES.PROVIDER_UNREACHABLE, 'provider returned non-JSON response body', { cause: error.message });
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw providerError(CODES.PROVIDER_UNREACHABLE, 'provider response missing assistant content', {});
    }
    return normalizeProviderResponse(content);
  }
}

function looksUnavailable(text) {
  const lower = text.toLowerCase();
  return ['rate limit', 'rate-limit', 'capacity', 'unavailable', 'too many requests'].some((p) => lower.includes(p));
}
