#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  return full;
}

function sendFile(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (stat.isDirectory()) {
    return sendFile(req, res, path.join(filePath, 'index.html'));
  }

  const type = contentType(filePath);
  const isAudio = type.startsWith('audio/');
  const range = req.headers.range;

  if (isAudio && range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    let start = match[1] === '' ? 0 : Number(match[1]);
    let end = match[2] === '' ? stat.size - 1 : Number(match[2]);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': type,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': isAudio ? 'bytes' : 'none',
  });
  fs.createReadStream(filePath).pipe(res);
}

export function createServer(root = ROOT) {
  return http.createServer((req, res) => {
    const filePath = safeJoin(root, req.url || '/');
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    sendFile(req, res, filePath);
  });
}

export function listen(port = DEFAULT_PORT, root = ROOT) {
  const server = createServer(root);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({ server, port, root, url: `http://127.0.0.1:${port}/` });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || process.argv[2] || DEFAULT_PORT);
  const { url } = await listen(port);
  console.log(`serving ${ROOT} at ${url}`);
}
