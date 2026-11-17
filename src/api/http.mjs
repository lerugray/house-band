import { createServer } from 'node:http';
import { isIP } from 'node:net';

import { ApiError, API_VERSION, unsupportedFeature } from './errors.mjs';
import { parseJsonNoDuplicates } from './json.mjs';

const TERMINAL_EVENTS = new Set(['job_succeeded', 'job_failed', 'job_canceled']);

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function sendEvent(response, event) {
  const data = JSON.stringify(event.data);
  response.write(`id: ${event.id}\nevent: ${event.event}\ndata: ${data}\n\n`);
}

function sendSseError(response, error) {
  if (response.headersSent) return;
  const envelope = error instanceof ApiError ? error.envelope() : new ApiError('RENDER_FAILED', error?.message || 'internal service error', { stage: 'request' }).envelope();
  const body = Buffer.from(JSON.stringify(envelope), 'utf8');
  response.writeHead(error instanceof ApiError ? error.status : 500, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function streamEvents(service, jobId, cursor, response) {
  let stream;
  try {
    stream = await service.eventStream(jobId, cursor);
  } catch (error) {
    return sendSseError(response, error);
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });
  for (let index = stream.startFrom; index < stream.events.length; index++) {
    sendEvent(response, stream.events[index]);
  }
  if (stream.terminal) {
    response.end();
    return;
  }
  let lastSentId = stream.events.length > 0 ? stream.events[stream.events.length - 1].id : cursor;
  let heartbeatAt = Date.now();
  const interval = setInterval(async () => {
    try {
      const refreshed = await service.eventStream(jobId, lastSentId);
      for (let index = refreshed.startFrom; index < refreshed.events.length; index++) {
        const event = refreshed.events[index];
        sendEvent(response, event);
        lastSentId = event.id;
        if (TERMINAL_EVENTS.has(event.event)) {
          clearInterval(interval);
          response.end();
          return;
        }
      }
      if (Date.now() - heartbeatAt >= 15000) {
        response.write(':heartbeat\n\n');
        heartbeatAt = Date.now();
      }
      if (refreshed.terminal) {
        clearInterval(interval);
        response.end();
      }
    } catch (error) {
      clearInterval(interval);
      response.end();
    }
  }, 500);
  response.on('close', () => clearInterval(interval));
}

function requestError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError('INVALID_REQUEST', error?.message || 'invalid request', {
    details: { parserError: error?.name || 'Error' },
    cause: error,
  });
}

async function readJson(request, limit = 1024 * 1024) {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError('INVALID_REQUEST', 'Content-Type must be application/json');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new ApiError('INVALID_REQUEST', `JSON request exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) throw new ApiError('INVALID_REQUEST', 'request body must not be empty');
  try {
    return Object.freeze({ raw, value: parseJsonNoDuplicates(raw) });
  } catch (error) {
    throw requestError(error);
  }
}

function links(jobId, artifacts = false) {
  return Object.freeze({
    status: `/v1/jobs/${jobId}`,
    events: `/v1/jobs/${jobId}/events`,
    ...(artifacts ? { artifacts: `/v1/jobs/${jobId}/artifacts` } : {}),
  });
}

function accepted(job) {
  return Object.freeze({
    jobId: job.jobId,
    state: job.state,
    createdAt: job.createdAt,
    links: links(job.jobId, job.artifacts?.length > 0),
  });
}

function method(request, expected) {
  if (request.method !== expected) throw new ApiError('METHOD_NOT_ALLOWED', `method ${request.method} is not allowed`, { details: { expected } });
}

function exactHost(request, configuredHosts) {
  const host = request.headers.host;
  const dynamic = `127.0.0.1:${request.socket.localPort}`;
  const allowed = configuredHosts?.length ? configuredHosts : [dynamic];
  if (typeof host !== 'string' || !allowed.includes(host)) {
    throw new ApiError('INVALID_REQUEST', 'Host header is not an allowed exact loopback service host', { details: { allowedHosts: allowed } });
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) {
    throw new ApiError('INVALID_REQUEST', 'Origin must be the exact same service origin', { details: { expectedOrigin: `http://${host}` } });
  }
}

export function createApiHttpServer(service, { allowedHosts, bodyLimit = 1024 * 1024 } = {}) {
  return createServer(async (request, response) => {
    try {
      exactHost(request, allowedHosts);
      if (request.method === 'OPTIONS') throw new ApiError('INVALID_REQUEST', 'cross-origin preflight is not supported');
      const url = new URL(request.url, 'http://127.0.0.1');

      if (url.pathname === '/v1/health') {
        method(request, 'GET');
        return sendJson(response, 200, service.health());
      }
      if (url.pathname === '/v1/capabilities') {
        method(request, 'GET');
        return sendJson(response, 200, service.capabilities());
      }
      if (url.pathname === '/v1/packs') {
        method(request, 'GET');
        return sendJson(response, 200, { packs: service.listPacks() });
      }
      if (url.pathname === '/v1/scores/validate') {
        method(request, 'POST');
        const body = await readJson(request, bodyLimit);
        return sendJson(response, 200, service.validateScoreRequest(body.value));
      }

      if (url.pathname === '/v1/songs') {
        method(request, 'POST');
        const body = await readJson(request, bodyLimit);
        const submitted = await service.submitSong(body.value, body.raw);
        if (submitted.execution.mode === 'sync_wait') {
          const completed = await service.waitForJob(submitted.job.jobId, submitted.execution.waitTimeoutMs);
          if (completed) return sendJson(response, 200, accepted(completed));
        }
        return sendJson(response, 202, accepted(submitted.job));
      }

      if (url.pathname === '/v1/renders') {
        method(request, 'POST');
        const body = await readJson(request, bodyLimit);
        const submitted = await service.submitRender(body.value, body.raw);
        if (submitted.execution.mode === 'sync_wait') {
          const completed = await service.waitForJob(submitted.job.jobId, submitted.execution.waitTimeoutMs);
          if (completed) return sendJson(response, 200, accepted(completed));
        }
        return sendJson(response, 202, accepted(submitted.job));
      }

      const artifactRoute = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/artifacts\/([^/]+)$/);
      if (artifactRoute) {
        method(request, 'GET');
        const found = await service.getArtifact(decodeURIComponent(artifactRoute[1]), decodeURIComponent(artifactRoute[2]));
        response.writeHead(200, {
          'content-type': found.artifact.mediaType,
          'content-length': found.bytes.length,
          'content-disposition': `attachment; filename="${found.artifact.filename.replaceAll('"', "'")}"`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        return response.end(found.bytes);
      }

      const artifactList = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/artifacts$/);
      if (artifactList) {
        method(request, 'GET');
        const jobId = decodeURIComponent(artifactList[1]);
        const artifacts = await service.listArtifacts(jobId);
        return sendJson(response, 200, { jobId, artifacts });
      }

      const eventsRoute = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/events$/);
      if (eventsRoute) {
        method(request, 'GET');
        const jobId = decodeURIComponent(eventsRoute[1]);
        const lastEventId = request.headers['last-event-id'];
        const after = url.searchParams.get('after');
        if (lastEventId !== undefined && after !== null) {
          throw new ApiError('INVALID_REQUEST', 'use Last-Event-ID header or after query parameter, not both', { details: { jobId } });
        }
        const cursor = Number(lastEventId ?? after ?? 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ApiError('INVALID_REQUEST', 'event cursor must be a non-negative integer', { details: { cursor } });
        return streamEvents(service, jobId, cursor, response);
      }
      const cancelRoute = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
      if (cancelRoute) throw unsupportedFeature('POST /v1/jobs/{jobId}/cancel', []);

      const jobRoute = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (jobRoute) {
        method(request, 'GET');
        return sendJson(response, 200, await service.getJob(decodeURIComponent(jobRoute[1])));
      }

      throw new ApiError('INVALID_REQUEST', `unknown API route ${url.pathname}`, { details: { path: url.pathname } });
    } catch (error) {
      const failure = error instanceof ApiError
        ? error
        : new ApiError('RENDER_FAILED', error?.message || 'internal service error', { stage: 'request', cause: error });
      if (!response.headersSent) sendJson(response, failure.status, failure.envelope());
      else response.destroy(error);
    }
  });
}

export function assertLoopbackBind(host) {
  if (host !== '127.0.0.1' || isIP(host) !== 4) {
    throw new ApiError('INVALID_REQUEST', 'unauthenticated service must bind exactly to 127.0.0.1', { details: { host } });
  }
}

export async function listenLoopback(server, { host = '127.0.0.1', port = 0 } = {}) {
  assertLoopbackBind(host);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server.address();
}
