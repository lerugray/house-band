#!/usr/bin/env node

import { resolve } from 'node:path';

import { createApiHttpServer, listenLoopback } from './api/http.mjs';
import { HouseBandApiService } from './api/service.mjs';

function args(argv) {
  const result = { host: '127.0.0.1', port: 3781, storeRoot: resolve('.house-band-api') };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--host') result.host = argv[++index];
    else if (value === '--port') result.port = Number(argv[++index]);
    else if (value === '--store') result.storeRoot = resolve(argv[++index]);
    else if (value === '--help' || value === '-h') result.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error('--port must be an integer from 0 through 65535');
  return result;
}

const options = args(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node src/api-server.mjs [--host 127.0.0.1] [--port 3781] [--store .house-band-api]');
} else {
  const service = await new HouseBandApiService({ storeRoot: options.storeRoot }).init();
  const server = createApiHttpServer(service);
  const address = await listenLoopback(server, options);
  console.log(`House Band API ${service.health().apiVersion} listening on http://${address.address}:${address.port}`);
}
