import { validateSamplePack } from '../src/sample-pack.mjs';
import { sha256 } from './provenance.mjs';

function relativePackPath(file) {
  const path = String(file.webkitRelativePath || file.name).replaceAll('\\', '/');
  if (path.endsWith('/pack.json') || path === 'pack.json') return 'pack.json';
  const marker = path.lastIndexOf('/assets/');
  if (marker >= 0) return path.slice(marker + 1);
  return path.startsWith('assets/') ? path : file.name;
}

export async function loadSamplePackFiles(fileList) {
  const files = [...fileList];
  const manifestFile = files.find((file) => relativePackPath(file) === 'pack.json');
  if (!manifestFile) throw new Error('sample pack selection must contain pack.json');
  let manifest;
  try {
    manifest = JSON.parse(await manifestFile.text());
  } catch (error) {
    throw new Error(`sample pack manifest is not valid JSON: ${error.message}`);
  }
  const bytes = new Map();
  for (const file of files) {
    let path = relativePackPath(file);
    if (path === 'pack.json') continue;
    if (!path.startsWith('assets/')) {
      const matches = (manifest.assets || []).filter((asset) => asset.file.endsWith(`/${file.name}`));
      if (matches.length === 1) path = matches[0].file;
    }
    if (!path.startsWith('assets/') || !path.endsWith('.wav')) throw new Error(`unexpected sample pack file: ${path}`);
    bytes.set(path, new Uint8Array(await file.arrayBuffer()));
  }
  return validateSamplePack(manifest, bytes, sha256);
}
