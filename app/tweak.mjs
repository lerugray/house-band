/**
 * Surface B artifact edits.
 *
 * Every operation clones an already-valid artifact, changes exactly one path,
 * and crosses the strict schema boundary again before returning.
 */

import { validateSpec } from '../src/spec.mjs';

const clone = (value) => structuredClone(value);

export function pathKey(path) {
  return path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
}

export function formatPath(path) {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${part}` : part;
  }
  return out;
}

export function getAtPath(value, path) {
  let current = value;
  for (const part of path) {
    if (current === undefined || current === null || !Object.hasOwn(current, part)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function setAtPath(target, path, value, exists = true) {
  if (path.length === 0) throw new Error('edit path cannot be empty');
  let parent = target;
  for (const part of path.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, part)) {
      throw new Error(`edit path does not exist: ${formatPath(path)}`);
    }
    parent = parent[part];
  }
  const leaf = path[path.length - 1];
  if (exists) parent[leaf] = clone(value);
  else delete parent[leaf];
}

export function applySpecEdit(artifact, path, value) {
  const source = validateSpec(clone(artifact));
  const draft = clone(source);
  setAtPath(draft, path, value, true);
  return validateSpec(draft);
}

export function revertSpecPath(loadedArtifact, workingArtifact, path) {
  const loaded = validateSpec(clone(loadedArtifact));
  const working = validateSpec(clone(workingArtifact));
  const original = getAtPath(loaded, path);
  const draft = clone(working);
  setAtPath(draft, path, original.value, original.exists);
  return validateSpec(draft);
}

function equalJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function collectDiffs(loaded, working, path, out) {
  if (equalJson(loaded, working)) return;

  const loadedObject = loaded !== null && typeof loaded === 'object';
  const workingObject = working !== null && typeof working === 'object';
  const bothArrays = Array.isArray(loaded) && Array.isArray(working);
  const bothObjects = loadedObject && workingObject && !Array.isArray(loaded) && !Array.isArray(working);

  if (bothArrays && loaded.length === working.length) {
    for (let index = 0; index < loaded.length; index++) {
      collectDiffs(loaded[index], working[index], [...path, index], out);
    }
    return;
  }

  if (bothObjects) {
    const keys = new Set([...Object.keys(loaded), ...Object.keys(working)]);
    for (const key of keys) {
      if (!Object.hasOwn(loaded, key) || !Object.hasOwn(working, key)) {
        out.push(Object.freeze({
          path: Object.freeze([...path, key]),
          before: Object.hasOwn(loaded, key) ? clone(loaded[key]) : undefined,
          after: Object.hasOwn(working, key) ? clone(working[key]) : undefined,
        }));
      } else {
        collectDiffs(loaded[key], working[key], [...path, key], out);
      }
    }
    return;
  }

  out.push(Object.freeze({
    path: Object.freeze([...path]),
    before: clone(loaded),
    after: clone(working),
  }));
}

export function diffSpecs(loadedArtifact, workingArtifact) {
  const loaded = validateSpec(clone(loadedArtifact));
  const working = validateSpec(clone(workingArtifact));
  const out = [];
  collectDiffs(loaded, working, [], out);
  return Object.freeze(out);
}

export function describeValue(value) {
  if (value === undefined) return 'unset';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
