/** Minimal REAPER project (.RPP) generator and structural validator. */

import { barSeconds, requireValidatedScoreArtifact } from '../src/spec.mjs';

function quoted(value) {
  const clean = String(value).replace(/[\r\n]/g, ' ').replaceAll('"', "'");
  return `"${clean}"`;
}

function fixed(value) {
  return Number(value.toFixed(9)).toString();
}

export function sectionMarkers(artifact) {
  requireValidatedScoreArtifact(artifact);
  let position = 0;
  return Object.freeze(artifact.sections.map((section, index) => {
    const marker = Object.freeze({
      index: index + 1,
      position,
      name: `Section ${index + 1} · ${section.track}`,
    });
    const track = artifact.tracks[section.track];
    position += section.bars * barSeconds(track.bpm ?? artifact.tempo);
    return marker;
  }));
}

export function generateRpp(artifact, stemFiles, opts = {}) {
  requireValidatedScoreArtifact(artifact);
  if (!Array.isArray(stemFiles) || stemFiles.length === 0) throw new Error('RPP needs at least one stem');
  const frames = opts.frames;
  const sampleRate = opts.sampleRate ?? artifact.sampleRate;
  if (!Number.isInteger(frames) || frames < 1) throw new Error('RPP frames must be a positive integer');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('RPP sample rate must be positive');
  const length = frames / sampleRate;
  const tempo = artifact.tempo ?? artifact.tracks[artifact.sections[0].track].bpm;
  const lines = [
    '<REAPER_PROJECT 0.1 "7.78/OSX64-clang" 0',
    `  TEMPO ${fixed(tempo)} 4 4`,
  ];

  for (const marker of sectionMarkers(artifact)) {
    lines.push(`  MARKER ${marker.index} ${fixed(marker.position)} ${quoted(marker.name)} 0 0 1 B`);
  }

  for (const stem of stemFiles) {
    if (!stem || typeof stem.voice !== 'string' || typeof stem.filename !== 'string') {
      throw new Error('RPP stem entries need voice and filename');
    }
    lines.push(
      '  <TRACK',
      `    NAME ${quoted(stem.voice)}`,
      '    <ITEM',
      '      POSITION 0',
      `      LENGTH ${fixed(length)}`,
      '      LOOP 0',
      `      NAME ${quoted(stem.voice)}`,
      '      SOFFS 0',
      '      PLAYRATE 1 1 0 -1 0 0.0025',
      '      <SOURCE WAVE',
      `        FILE ${quoted(stem.filename)}`,
      '      >',
      '    >',
      '  >',
    );
  }
  lines.push('>', '');
  const rpp = lines.join('\n');
  validateRpp(rpp, {
    tempo,
    voices: stemFiles.map((stem) => stem.voice),
    filenames: stemFiles.map((stem) => stem.filename),
    markers: sectionMarkers(artifact),
    length,
  });
  return rpp;
}

export function validateRpp(rpp, expected = {}) {
  if (typeof rpp !== 'string' || !rpp.endsWith('\n')) throw new Error('RPP must be newline-terminated text');
  const lines = rpp.trimEnd().split('\n');
  if (!/^<REAPER_PROJECT\s+0\.1\b/.test(lines[0])) throw new Error('RPP missing REAPER_PROJECT root');
  const stack = [];
  let tracks = 0;
  let items = 0;
  let sources = 0;
  const trackNames = [];
  const itemPositions = [];
  const sourceFiles = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('<')) {
      stack.push(line.slice(1).split(/\s+/)[0]);
      if (line === '<TRACK') tracks++;
      if (line === '<ITEM') items++;
      if (line === '<SOURCE WAVE') sources++;
    } else if (line === '>') {
      if (stack.length === 0) throw new Error('RPP has an unmatched closing chunk');
      stack.pop();
    } else if (stack.at(-1) === 'TRACK') {
      const name = line.match(/^NAME "([^"]+)"$/)?.[1];
      if (name) trackNames.push(name);
    } else if (stack.at(-1) === 'ITEM' && line.startsWith('POSITION ')) {
      itemPositions.push(Number(line.slice('POSITION '.length)));
    } else if (stack.at(-1) === 'SOURCE' && line.startsWith('FILE ')) {
      const filename = line.match(/^FILE "([^"]+)"$/)?.[1];
      if (filename) sourceFiles.push(filename);
    }
  }
  if (stack.length !== 0) throw new Error(`RPP has unclosed ${stack.at(-1)} chunk`);
  if (tracks === 0 || tracks !== items || tracks !== sources) throw new Error('RPP needs one WAVE item per track');

  const tempoLine = lines.find((line) => line.trimStart().startsWith('TEMPO '));
  if (!tempoLine) throw new Error('RPP missing project tempo');
  const markerLines = lines.filter((line) => line.trimStart().startsWith('MARKER '));

  if (expected.tempo !== undefined && !tempoLine.includes(`TEMPO ${fixed(expected.tempo)} 4 4`)) throw new Error('RPP tempo mismatch');
  if (expected.voices && tracks !== expected.voices.length) throw new Error('RPP track count mismatch');
  if (expected.voices && JSON.stringify(trackNames) !== JSON.stringify(expected.voices)) throw new Error('RPP track name mismatch');
  if (expected.filenames && JSON.stringify(sourceFiles) !== JSON.stringify(expected.filenames)) throw new Error('RPP source file mismatch');
  if (expected.markers && markerLines.length !== expected.markers.length) throw new Error('RPP marker count mismatch');
  if (expected.markers) {
    expected.markers.forEach((marker, index) => {
      if (marker.position === undefined || marker.name === undefined) return;
      const expectedPrefix = `MARKER ${index + 1} ${fixed(marker.position)} ${quoted(marker.name)}`;
      if (!markerLines[index].trim().startsWith(expectedPrefix)) throw new Error(`RPP marker ${index + 1} mismatch`);
    });
  }
  if (expected.length !== undefined && !lines.some((line) => line.trim() === `LENGTH ${fixed(expected.length)}`)) throw new Error('RPP item length mismatch');
  if (itemPositions.length !== tracks || itemPositions.some((position) => position !== 0)) throw new Error('RPP items must all start at zero');
  return Object.freeze({
    tracks,
    items,
    sources,
    markers: markerLines.length,
    trackNames: Object.freeze(trackNames),
    sourceFiles: Object.freeze(sourceFiles),
  });
}
