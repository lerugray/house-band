#!/usr/bin/env node
/**
 * CLI: import one SF2 preset to house-band.samples.json + WAVs (OSS-15).
 *
 * Usage:
 *   node tools/samples/from-sf2.mjs <file.sf2> --class <class>
 *     [--preset <name|index>] [--id <slug>] [--out <config>] [--wav-dir <dir>]
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const { importSf2, Sf2Error } = await import(
  pathToFileURL(resolve(ROOT, 'src/samples/sf2.mjs')).href
);

const PATCH_CLASSES = new Set(['pad', 'bass', 'lead', 'pluck', 'bell']);

function usage() {
  return [
    'Usage: node tools/samples/from-sf2.mjs <file.sf2> --class <pad|bass|lead|pluck|bell>',
    '  [--preset <name|index>] [--id <slug>] [--out <config>] [--wav-dir <dir>]',
  ].join('\n');
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = argv.slice();
  /** @type {Record<string, string | boolean>} */
  const out = { _: [] };
  while (args.length) {
    const tok = args.shift();
    if (tok === '--class' || tok === '--preset' || tok === '--id' || tok === '--out' || tok === '--wav-dir') {
      const val = args.shift();
      if (val === undefined) throw new Sf2Error(`${tok} requires a value`);
      out[tok.slice(2)] = val;
    } else if (tok === '--help' || tok === '-h') {
      out.help = true;
    } else if (tok.startsWith('-')) {
      throw new Sf2Error(`unknown option ${tok}`);
    } else {
      out._.push(tok);
    }
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message || err);
    console.error(usage());
    process.exit(err.exitCode || 1);
  }

  if (opts.help) {
    console.log(usage());
    process.exit(0);
  }

  const sf2Path = opts._[0];
  if (!sf2Path) {
    console.error('missing <file.sf2>');
    console.error(usage());
    process.exit(1);
  }
  if (opts._.length > 1) {
    console.error('unexpected extra arguments');
    console.error(usage());
    process.exit(1);
  }
  if (!opts.class) {
    console.error('--class is required');
    console.error(usage());
    process.exit(1);
  }
  if (!PATCH_CLASSES.has(opts.class)) {
    console.error(`--class must be one of ${[...PATCH_CLASSES].join(', ')}`);
    process.exit(1);
  }

  let preset = opts.preset ?? 0;
  if (typeof preset === 'string' && /^\d+$/.test(preset)) preset = Number(preset);

  try {
    const result = importSf2({
      sf2Path,
      patchClass: opts.class,
      preset,
      id: opts.id,
      outPath: opts.out,
      wavDir: opts['wav-dir'],
    });

    console.log(`wrote ${result.outPath}`);
    console.log(`wav dir ${result.wavDir} (${result.sampleFiles.length} files)`);
    console.log(`preset ${result.presetIndex} "${result.preset.name}" -> patch ${result.config.id}`);
    if (result.ignoredText) {
      console.log(`ignored generators: ${result.ignoredText}`);
    } else {
      console.log('ignored generators: (none)');
    }
  } catch (err) {
    if (err instanceof Sf2Error) {
      console.error(err.message);
      process.exit(err.exitCode || 1);
    }
    throw err;
  }
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) main();

export { main };
