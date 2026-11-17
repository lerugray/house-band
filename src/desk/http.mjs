/**
 * Composer's Desk HTTP server.
 *
 * Loopback-only. No CORS. Static files from desk/. JSON API under /desk/.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeskError, CODES } from './errors.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const STATIC_ROOT = resolve(REPO_ROOT, 'desk');

const STATIC_PREFIXES = Object.freeze([
  { prefix: '/desk/', root: resolve(REPO_ROOT, 'desk') },
  { prefix: '/app/', root: resolve(REPO_ROOT, 'app') },
  { prefix: '/src/', root: resolve(REPO_ROOT, 'src') },
]);

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
});

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

function sendError(response, error) {
  if (response.headersSent) return;
  const deskError = error instanceof DeskError ? error : new DeskError(CODES.INVALID_REQUEST, error?.message || 'internal error');
  sendJson(response, 400, deskError.envelope());
}

async function readJson(request, limit = 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new DeskError(CODES.INVALID_REQUEST, 'request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new DeskError(CODES.INVALID_REQUEST, 'invalid JSON body');
  }
}

function exactHost(request) {
  const host = request.headers.host;
  const expected = `127.0.0.1:${request.socket.localPort}`;
  if (host !== expected) {
    throw new DeskError(CODES.INVALID_REQUEST, 'host header is not the loopback service origin');
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${expected}`) {
    throw new DeskError(CODES.INVALID_REQUEST, 'origin must be the loopback service origin');
  }
}

async function serveStatic(request, response, root, urlPath) {
  const safePath = urlPath.replace(/\.{2,}/g, '').replace(/^\//, '');
  const filePath = resolve(root, safePath);
  if (!filePath.startsWith(root)) {
    sendJson(response, 404, { error: { code: CODES.INVALID_REQUEST, message: 'not found' } });
    return;
  }
  let info;
  try {
    info = await stat(filePath);
  } catch {
    sendJson(response, 404, { error: { code: CODES.INVALID_REQUEST, message: 'not found' } });
    return;
  }
  if (!info.isFile()) {
    sendJson(response, 404, { error: { code: CODES.INVALID_REQUEST, message: 'not found' } });
    return;
  }
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': info.size,
    'cache-control': ext === '.html' || ext === '.css' || ext === '.js' || ext === '.mjs' ? 'no-store' : 'max-age=3600',
  });
  createReadStream(filePath).pipe(response);
}

export function createDeskHttpServer(service) {
  return createServer(async (request, response) => {
    try {
      exactHost(request);
      const url = new URL(request.url, `http://127.0.0.1:${request.socket.localPort}`);

      // Static assets (skip API routes under /desk/api/)
      if (url.pathname.startsWith('/desk/api/')) {
        // fall through to API handlers
      } else for (const { prefix, root } of STATIC_PREFIXES) {
        if (url.pathname.startsWith(prefix)) {
          let subPath = url.pathname.slice(prefix.length);
          if (prefix === '/desk/' && (subPath === '' || subPath === '/')) {
            subPath = 'index.html';
          }
          return serveStatic(request, response, root, subPath);
        }
      }
      if (url.pathname === '/desk' || url.pathname === '/desk/') {
        return serveStatic(request, response, STATIC_ROOT, 'index.html');
      }

      // API
      if (url.pathname === '/desk/api/health' && request.method === 'GET') {
        return sendJson(response, 200, service.health());
      }
      if (url.pathname === '/desk/api/capabilities' && request.method === 'GET') {
        return sendJson(response, 200, service.capabilities());
      }
      if (url.pathname === '/desk/api/packs' && request.method === 'GET') {
        return sendJson(response, 200, { packs: service.listPacks() });
      }
      const packAssetRoute = url.pathname.match(/^\/desk\/api\/packs\/([^/]+)\/assets\/([^/]+)\/wav$/);
      if (packAssetRoute && request.method === 'GET') {
        const [, packId, assetId] = packAssetRoute;
        const asset = await service.getPackAsset(decodeURIComponent(packId), decodeURIComponent(assetId));
        response.writeHead(200, {
          'content-type': asset.mediaType,
          'content-length': asset.bytes.length,
          'cache-control': 'no-store',
        });
        return response.end(asset.bytes);
      }
      if (url.pathname === '/desk/api/sessions' && request.method === 'GET') {
        return sendJson(response, 200, { sessions: await service.listSessions() });
      }
      if (url.pathname === '/desk/api/sessions' && request.method === 'POST') {
        const body = await readJson(request);
        const session = await service.createSession(body);
        return sendJson(response, 201, session);
      }

      const sessionRoute = url.pathname.match(/^\/desk\/api\/sessions\/([^/]+)$/);
      if (sessionRoute && request.method === 'GET') {
        return sendJson(response, 200, await service.getSession(sessionRoute[1]));
      }
      if (sessionRoute && request.method === 'PATCH') {
        const body = await readJson(request);
        if (body.profileId !== undefined) {
          return sendJson(response, 200, await service.setSessionProfile(sessionRoute[1], body.profileId));
        }
        if (body.weissEnabled !== undefined) {
          return sendJson(response, 200, await service.setWeissEnabled(sessionRoute[1], body.weissEnabled));
        }
        throw new DeskError(CODES.INVALID_REQUEST, 'PATCH body must include profileId or weissEnabled');
      }

      const briefRoute = url.pathname.match(/^\/desk\/api\/sessions\/([^/]+)\/brief$/);
      if (briefRoute && request.method === 'POST') {
        const body = await readJson(request);
        const abort = new AbortController();
        const onSocketClose = () => {
          if (!response.writableEnded) abort.abort();
        };
        request.socket?.on('close', onSocketClose);
        try {
          const result = await service.makeBrief(briefRoute[1], body.prompt, { signal: abort.signal });
          return sendJson(response, 200, result);
        } finally {
          request.socket?.off('close', onSocketClose);
        }
      }

      const composeRoute = url.pathname.match(/^\/desk\/api\/sessions\/([^/]+)\/compose$/);
      if (composeRoute && request.method === 'POST') {
        const body = await readJson(request);
        const result = await service.composeScore(composeRoute[1], body);
        return sendJson(response, 200, result);
      }

      const reviseRoute = url.pathname.match(/^\/desk\/api\/sessions\/([^/]+)\/revise$/);
      if (reviseRoute && request.method === 'POST') {
        const body = await readJson(request);
        const abort = new AbortController();
        const onSocketClose = () => {
          if (!response.writableEnded) abort.abort();
        };
        request.socket?.on('close', onSocketClose);
        try {
          const result = await service.reviseScore(reviseRoute[1], body.takeId, body.direction, {
            ...body,
            signal: abort.signal,
          });
          return sendJson(response, 200, result);
        } finally {
          request.socket?.off('close', onSocketClose);
        }
      }

      const suggestRoute = url.pathname.match(/^\/desk\/api\/sessions\/([^/]+)\/apply-suggestion$/);
      if (suggestRoute && request.method === 'POST') {
        const body = await readJson(request);
        const result = await service.applySuggestion(suggestRoute[1], body.takeId, body);
        return sendJson(response, 200, result);
      }

      const takeMixRoute = url.pathname.match(/^\/desk\/api\/sessions\/([^/]+)\/takes\/([^/]+)\/mix\.wav$/);
      if (takeMixRoute && request.method === 'GET') {
        const mix = await service.getTakeMix(takeMixRoute[1], takeMixRoute[2]);
        response.writeHead(200, {
          'content-type': mix.mediaType,
          'content-length': mix.bytes.length,
          'x-mix-sha256': mix.sha256,
          'cache-control': 'no-store',
        });
        return response.end(mix.bytes);
      }

      const activeRoute = url.pathname.match(/^\/desk\/api\/sessions\/([^/]+)\/active-take$/);
      if (activeRoute && request.method === 'POST') {
        const body = await readJson(request);
        const result = await service.setActiveTake(activeRoute[1], body.takeId);
        return sendJson(response, 200, result);
      }

      const rerollRoute = url.pathname.match(/^\/desk\/api\/sessions\/([^/]+)\/reroll-seed$/);
      if (rerollRoute && request.method === 'POST') {
        const body = await readJson(request);
        const result = await service.rerollSeed(rerollRoute[1], body.takeId, body.seed);
        return sendJson(response, 200, result);
      }

      const exportRoute = url.pathname.match(/^\/desk\/api\/sessions\/([^/]+)\/export$/);
      if (exportRoute && (request.method === 'POST' || request.method === 'GET')) {
        const body = request.method === 'POST' ? await readJson(request) : {};
        const params = url.searchParams;
        const takeId = body.takeId ?? params.get('takeId');
        const stems = body.stems ?? (params.get('stems') === 'true');
        const rpp = body.rpp ?? (params.get('rpp') === 'true');
        const bundle = await service.exportBundle(exportRoute[1], takeId, { stems, rpp });
        response.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': bundle.bytes.length,
          'content-disposition': `attachment; filename="${bundle.filename.replaceAll('"', "'")}"`,
          'cache-control': 'no-store',
        });
        return response.end(bundle.bytes);
      }

      throw new DeskError(CODES.INVALID_REQUEST, `unknown route ${request.method} ${url.pathname}`);
    } catch (error) {
      sendError(response, error);
    }
  });
}
