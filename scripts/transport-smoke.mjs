#!/usr/bin/env node
/**
 * Live provider-transport smoke test for the orchestrator.
 *
 * Usage:
 *   node scripts/transport-smoke.mjs BASE_URL API_KEY_ENV MODEL [--store .house-band-smoke]
 *
 * The API key is read from the named environment variable at runtime. The
 * script performs exactly one end-to-end prompt-to-song composition using the
 * real OpenAI-compatible adapter and exits non-zero if the job does not succeed.
 */

import { resolve } from 'node:path';
import { HouseBandApiService } from '../src/api/service.mjs';
import { OpenAiCompatibleProvider } from '../src/api/provider.mjs';

function usage() {
  return 'Usage: node scripts/transport-smoke.mjs BASE_URL API_KEY_ENV MODEL [--store .house-band-smoke]';
}

function parseArgs(argv) {
  if (argv.length < 3) throw new Error(usage());
  const [baseUrl, apiKeyEnvVar, model, ...rest] = argv;
  const options = { baseUrl, apiKeyEnvVar, model, storeRoot: resolve('.house-band-smoke') };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === '--store') options.storeRoot = resolve(value);
    else throw new Error(`unknown argument: ${flag}\n${usage()}`);
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env[args.apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(`environment variable ${args.apiKeyEnvVar} is not set`);
  }

  const provider = new OpenAiCompatibleProvider({
    baseUrl: args.baseUrl,
    apiKeyEnvVar: args.apiKeyEnvVar,
    model: args.model,
    maxTransportAttempts: 3,
    callTimeoutMs: 60_000,
    totalDeadlineMs: 180_000,
  });

  const service = await new HouseBandApiService({ storeRoot: args.storeRoot, provider }).init();
  const submitted = await service.submitSong({
    prompt: 'Live transport smoke test: a short deterministic pulse for end-to-end provider validation.',
    seed: 0xdecafbad,
    canonicalVoiceAllowlist: ['kick', 'snare', 'hat'],
    composition: { maxValidationAttempts: 3 },
    render: { fullMix: true },
    execution: { mode: 'sync_wait', waitTimeoutMs: 60_000 },
  });

  const job = await submitted.completion;
  if (job.state !== 'succeeded') {
    console.error(JSON.stringify({ jobId: job.jobId, state: job.state, error: job.error }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    jobId: job.jobId,
    state: job.state,
    transportCallCount: job.transportCallCount,
    validationCandidateCount: job.validationCandidateCount,
    ...job.provenanceSummary,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
