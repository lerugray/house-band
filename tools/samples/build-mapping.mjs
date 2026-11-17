#!/usr/bin/env node
/**
 * Rebuild sample packs from examples/sample-mappings/*.mapping.json against a
 * local library root. Verifies source file hashes before build and pack hashes
 * after. Refuses to write into the repo's sample-packs/.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPack } from '../build-pack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE_PACKS = resolve(ROOT, 'sample-packs');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function usage() {
  return [
    'Usage: node tools/samples/build-mapping.mjs --mapping <dir-or-file> --input <library root> [--out <packs dir>]',
    '',
    'Default --out: first entry of $HOUSE_BAND_PACKS, else ~/.house-band/packs.',
    'Refuses (exit 2) if --out resolves inside the repo sample-packs/.',
  ].join('\n');
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { mapping: null, input: null, out: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--mapping') args.mapping = argv[++index];
    else if (arg === '--input') args.input = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else fail(`unknown argument: ${arg}`);
  }
  return args;
}

export function defaultOutDir(env = process.env) {
  const raw = env.HOUSE_BAND_PACKS;
  if (typeof raw === 'string' && raw.length > 0) {
    for (const entry of raw.split(delimiter)) {
      if (entry !== '') return resolve(entry);
    }
  }
  return join(homedir(), '.house-band', 'packs');
}

/** True when `child` is the same as or inside `parent`. */
export function pathIsInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function stripMappingForBuild(mapping) {
  const { libraryRootHint: _hint, expected: _expected, assets, ...rest } = mapping;
  return {
    ...rest,
    assets: assets.map((asset) => {
      const { expectedSourceSha256: _sha, ...assetRest } = asset;
      return assetRest;
    }),
  };
}

export function listMappingFiles(mappingPath) {
  const resolved = resolve(mappingPath);
  if (!existsSync(resolved)) fail(`mapping path does not exist: ${resolved}`);
  const info = statSync(resolved);
  if (info.isFile()) {
    if (!resolved.endsWith('.mapping.json')) fail(`mapping file must end with .mapping.json: ${resolved}`);
    return [resolved];
  }
  if (!info.isDirectory()) fail(`mapping path is neither a file nor a directory: ${resolved}`);
  return readdirSync(resolved)
    .filter((name) => name.endsWith('.mapping.json'))
    .sort()
    .map((name) => join(resolved, name));
}

function checkSources(mapping, inputRoot) {
  const problems = [];
  for (const asset of mapping.assets) {
    const sourcePath = resolve(inputRoot, asset.sourceFile.split('/').join(sep));
    const rel = relative(inputRoot, sourcePath);
    if (rel.startsWith('..') || rel === '') {
      problems.push(`escapes input root: ${asset.sourceFile}`);
      continue;
    }
    if (!existsSync(sourcePath)) {
      problems.push(`missing: ${asset.sourceFile}`);
      continue;
    }
    const actual = sha256File(sourcePath);
    if (actual !== asset.expectedSourceSha256) {
      problems.push(
        `different: ${asset.sourceFile} (expected ${asset.expectedSourceSha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
      );
    }
  }
  return problems;
}

async function buildOne(mapping, inputRoot, outRoot) {
  const packId = mapping.packId;
  const packOut = join(outRoot, packId);
  const tempRoot = mkdtempSync(join(tmpdir(), `hb-build-mapping-${packId}-`));
  try {
    const metadata = stripMappingForBuild(mapping);
    const metadataPath = join(tempRoot, `${packId}.build.json`);
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    if (existsSync(packOut)) rmSync(packOut, { recursive: true, force: true });
    mkdirSync(outRoot, { recursive: true });
    const result = await buildPack({
      inputDir: inputRoot,
      metadataPath,
      outputDir: packOut,
    });
    const { contentSha256, manifestSha256 } = result.manifest;
    const expected = mapping.expected;
    if (contentSha256 !== expected.contentSha256 || manifestSha256 !== expected.manifestSha256) {
      rmSync(packOut, { recursive: true, force: true });
      const lines = [`pack hash mismatch for ${packId}:`];
      if (contentSha256 !== expected.contentSha256) {
        lines.push(`  contentSha256 expected ${expected.contentSha256}, got ${contentSha256}`);
      }
      if (manifestSha256 !== expected.manifestSha256) {
        lines.push(`  manifestSha256 expected ${expected.manifestSha256}, got ${manifestSha256}`);
      }
      return { ok: false, lines };
    }
    return {
      ok: true,
      lines: [`OK ${packId} ${contentSha256.slice(0, 12)}`],
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function runBuildMapping({ mappingPath, inputDir, outDir }) {
  const inputRoot = resolve(inputDir);
  const outRoot = resolve(outDir);
  if (pathIsInside(SAMPLE_PACKS, outRoot)) {
    console.error(`refusing to write inside repo sample-packs/: ${outRoot}`);
    return 2;
  }
  if (!existsSync(inputRoot) || !statSync(inputRoot).isDirectory()) {
    console.error(`input library root is not a directory: ${inputRoot}`);
    return 1;
  }
  const files = listMappingFiles(mappingPath);
  if (files.length === 0) {
    console.error(`no .mapping.json files under ${resolve(mappingPath)}`);
    return 1;
  }
  let anyFailure = false;
  for (const file of files) {
    const mapping = JSON.parse(readFileSync(file, 'utf8'));
    const packId = mapping.packId || relative(ROOT, file);
    const sourceProblems = checkSources(mapping, inputRoot);
    if (sourceProblems.length > 0) {
      anyFailure = true;
      console.error(`edition mismatch for ${packId}:`);
      for (const line of sourceProblems) console.error(`  ${line}`);
      console.error(`skipped ${packId}`);
      continue;
    }
    const result = await buildOne(mapping, inputRoot, outRoot);
    for (const line of result.lines) {
      if (result.ok) console.log(line);
      else console.error(line);
    }
    if (!result.ok) anyFailure = true;
  }
  return anyFailure ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.mapping || !args.input) {
    console.error(`--mapping and --input are required\n${usage()}`);
    return 1;
  }
  const outDir = args.out ?? defaultOutDir();
  return runBuildMapping({
    mappingPath: args.mapping,
    inputDir: args.input,
    outDir,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`build-mapping failed: ${error.message}`);
      process.exitCode = 1;
    });
}
