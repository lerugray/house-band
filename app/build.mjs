/**
 * Build a single-file, file://-bootable dist/audition-room.html from app/main.mjs.
 *
 * This is intentionally a small regex bundler: it resolves local relative imports,
 * rewrites import/export statements, and inlines all source into one module script.
 * It is only expected to handle the ESM subset used by this app.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'app', 'main.mjs');
const stylePath = resolve(root, 'app', 'style.css');
const demoPath = resolve(root, 'examples', 'demo-spec.json');
const outPath = resolve(root, 'dist', 'audition-room.html');

function posix(p) {
  return p.split(sep).join('/');
}

function moduleKey(absPath) {
  return posix(relative(root, absPath));
}

function importReplacement(bindings, key) {
  const b = bindings.trim();
  if (b.startsWith('* as ')) {
    const name = b.slice(5).trim();
    return `const ${name} = __modules__[${JSON.stringify(key)}];`;
  }
  if (b.startsWith('{')) {
    const inner = b.slice(1, -1).trim();
    return `const { ${inner} } = __modules__[${JSON.stringify(key)}];`;
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(b)) {
    return `const ${b} = __modules__[${JSON.stringify(key)}].default;`;
  }
  return null;
}

function parseModule(absPath, seen = new Map()) {
  if (seen.has(absPath)) return seen.get(absPath);

  let src = readFileSync(absPath, 'utf8');

  // Inject the bundled demo spec into app/main.mjs.
  if (moduleKey(absPath) === 'app/main.mjs') {
    const demo = JSON.parse(readFileSync(demoPath, 'utf8'));
    src = src.replace(/__DEMO_SPEC__/g, JSON.stringify(demo));
  }

  // Fold the bounded named-import form used by shared validation/compiler files.
  // Other unsupported ESM forms still fail closed below.
  src = src.replace(/^import\s*\{([A-Za-z0-9_$,\s]+)\}\s*from\s*(['"])([^'"\r\n]+)\2\s*;?/gm,
    (_, names, quote, source) => `import { ${names.trim().replace(/\s+/g, ' ')} } from ${quote}${source}${quote};`);
  const lines = src.split(/\r?\n/);
  const outLines = [];
  const deps = [];
  const exports = [];
  let inBlock = false;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (inBlock) {
      const end = trimmed.indexOf('*/');
      if (end !== -1) inBlock = false;
      outLines.push(raw);
      continue;
    }

    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/', 2);
      if (end === -1) inBlock = true;
      outLines.push(raw);
      continue;
    }

    if (trimmed.startsWith('//')) {
      outLines.push(raw);
      continue;
    }

    // import { ... } from '...' / import * as x from '...' / import x from '...'
    const namedImport = trimmed.match(/^import\s+(.+?)\s+from\s+['"]([^'"]+)['"];?\s*$/);
    if (namedImport) {
      const bindings = namedImport[1];
      const source = namedImport[2];
      if (source.startsWith('./') || source.startsWith('../')) {
        const resolved = resolve(dirname(absPath), source);
        const key = moduleKey(resolved);
        deps.push({ key, absPath: resolved });
        const replacement = importReplacement(bindings, key);
        if (replacement) outLines.push(replacement);
      } else {
        outLines.push(raw);
      }
      continue;
    }

    // import '...'
    const sideImport = trimmed.match(/^import\s+['"]([^'"]+)['"];?\s*$/);
    if (sideImport) {
      const source = sideImport[1];
      if (source.startsWith('./') || source.startsWith('../')) {
        const resolved = resolve(dirname(absPath), source);
        const key = moduleKey(resolved);
        deps.push({ key, absPath: resolved });
      } else {
        outLines.push(raw);
      }
      continue;
    }

    // export declarations
    if (trimmed.startsWith('export ')) {
      const rest = trimmed.slice(7).trim();

      // export default ...
      if (rest.startsWith('default ')) {
        const body = rest.slice(8).trim();
        const namedDefault = body.match(/^(?:async\s+)?(?:function|class)\s+(\w+)/);
        if (namedDefault) {
          exports.push({ name: namedDefault[1], as: namedDefault[1] });
          outLines.push(body);
        } else {
          exports.push({ name: 'default', as: '__default__' });
          outLines.push(`const __default__ = ${body.replace(/;\s*$/, '')};`);
        }
        continue;
      }

      // export function/class/const/let/var/async function
      const decl = rest.match(/^(?:async\s+)?(?:function|class)\s+(\w+)/);
      if (decl) {
        exports.push({ name: decl[1], as: decl[1] });
        outLines.push(rest);
        continue;
      }

      const variable = rest.match(/^(const|let|var)\s+(\w+)/);
      if (variable) {
        exports.push({ name: variable[2], as: variable[2] });
        outLines.push(rest);
        continue;
      }

      // export { a, b as c }
      const list = rest.match(/^\{([^}]*)\}\s*;?$/);
      if (list) {
        const items = list[1].split(',').map((s) => s.trim()).filter(Boolean);
        for (const item of items) {
          const [name, asPart] = item.split(/\s+as\s+/).map((s) => s.trim());
          const as = asPart || name;
          exports.push({ name, as });
        }
        continue;
      }

      // Unknown export shape — leave it and hope for the best.
      outLines.push(raw);
      continue;
    }

    outLines.push(raw);
  }

  const body = outLines.join('\n');
  // Fail closed: the line-based parser cannot see multi-line import/export forms.
  // A leaked statement ships a bundle that dies at parse time in the browser.
  const leaked = body.match(/^\s*(import\s.+\sfrom\s|import\s*\{|export\s*\{|export\s+(?:const|let|var|function|class|default)\b)/m);
  if (leaked) {
    throw new Error(`Unbundled import/export leaked in ${moduleKey(absPath)}: ${leaked[0].trim()} — write imports on a single line or extend app/build.mjs`);
  }
  const returnEntries = exports.map((e) => `${JSON.stringify(e.as)}:${e.name}`).join(',');
  const moduleBody = `${body}\nreturn { ${returnEntries} };`;

  const mod = { key: moduleKey(absPath), absPath, deps, moduleBody };
  seen.set(absPath, mod);

  // Recurse into dependencies so they appear earlier in the output.
  for (const dep of deps) {
    if (!seen.has(dep.absPath)) parseModule(dep.absPath, seen);
  }

  return mod;
}

function topoSort(entryMod) {
  const order = [];
  const visited = new Set();
  function visit(mod) {
    if (visited.has(mod.key)) return;
    visited.add(mod.key);
    for (const dep of mod.deps) {
      visit(dep.mod);
    }
    order.push(mod);
  }
  // Attach resolved module references to deps for traversal.
  const byKey = new Map();
  function attach(mod) {
    if (byKey.has(mod.key)) return;
    byKey.set(mod.key, mod);
    for (const dep of mod.deps) {
      const child = parseModule(dep.absPath);
      dep.mod = child;
      attach(child);
    }
  }
  attach(entryMod);
  visit(entryMod);
  return order;
}

function build() {
  const entryMod = parseModule(entry);
  const modules = topoSort(entryMod);

  const css = readFileSync(stylePath, 'utf8');

  const moduleScripts = modules.map((mod) => {
    return `  __modules__[${JSON.stringify(mod.key)}] = (function() {\n${mod.moduleBody}\n  })();`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>House Band — Audition Room</title>
<style>
${css}
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>Audition Room</h1>
    <span class="subtitle">listen · shape · compare · hand off</span>
  </header>

  <div class="toolbar">
    <div class="toolbar-group">
      <label class="file-label" for="load-input">Load score</label>
      <input id="load-input" type="file" accept="application/json">
      <label class="file-label" for="pack-input">Load sample pack</label>
      <input id="pack-input" type="file" accept="application/json,audio/wav,.wav" multiple webkitdirectory>
      <button id="paste-open">Paste score</button>
      <button id="save-spec">Save spec</button>
    </div>
    <div class="toolbar-group">
      <button id="play-btn" class="primary">Play</button>
      <button id="stop-btn">Stop</button>
      <label><input id="loop-check" type="checkbox"> Loop</label>
    </div>
    <div class="toolbar-group">
      <span class="position" id="position">00:00.00 / 00:00.00</span>
    </div>
    <div class="toolbar-group">
      <button id="export-wav" disabled>Export WAV</button>
      <button id="export-manifest" disabled>Manifest</button>
      <button id="accept-take" class="primary" disabled>Accept this take</button>
      <button id="export-handoff" disabled>Stems + REAPER</button>
    </div>
  </div>

  <div class="status" id="status"></div>

  <dialog id="paste-dialog" class="paste-dialog" aria-labelledby="paste-title">
    <form method="dialog" id="paste-form">
      <h2 id="paste-title">Paste a score</h2>
      <p class="paste-help">Paste score JSON: one you wrote, one an LLM wrote for you, or one copied from the examples. It is checked against the score format before it plays; nothing leaves this page.</p>
      <textarea id="paste-text" spellcheck="false" rows="16" placeholder='{ "schemaVersion": "1.0.0", "tempo": 96, "tracks": { ... }, "sections": [ ... ] }'></textarea>
      <div class="paste-error" id="paste-error" role="alert"></div>
      <div class="paste-actions">
        <button type="button" id="paste-cancel">Cancel</button>
        <button type="submit" id="paste-load" class="primary">Load and play</button>
      </div>
    </form>
  </dialog>

  <div class="diff-bar" aria-live="polite">
    <span class="diff-title">Changes</span>
    <div id="diff-list" class="diff-list"></div>
  </div>

  <div class="layout">
    <aside class="sidebar">
      <div class="panel">
        <h2>Register</h2>
        <div id="register-panel"></div>
      </div>

      <div class="panel">
        <h2>Seed</h2>
        <div class="seed-row">
          <input id="seed-input" type="number" min="0" max="4294967295">
          <button id="reroll-btn">Re-roll</button>
        </div>
        <div class="ab-row">
          <button id="ab-a" class="active">A</button>
          <button id="ab-b">B</button>
        </div>
      </div>

      <div class="panel">
        <h2>Voice mix</h2>
        <div class="voice-list" id="voice-list"></div>
      </div>
      <div class="panel">
        <h2>Sample pack</h2>
        <div id="sample-pack-panel" class="sample-pack-panel">No pack loaded</div>
      </div>
    </aside>

    <main class="main">
      <details class="panel tweak-panel" open>
        <summary>Score controls</summary>
        <p class="panel-note">Each control maps to a score field. Invalid edits are rejected before rendering.</p>
        <div id="tweak-controls"></div>
      </details>
      <div class="panel" style="flex:1">
        <div class="grid-header">Pattern grid</div>
        <div id="grid"></div>
      </div>
    </main>
  </div>

  <footer>Drop a House Band score JSON, or select a local sample-pack directory.</footer>
</div>
<script type="module">
(function() {
  const __modules__ = {};
${moduleScripts}
})();
</script>
</body>
</html>
`;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`Wrote ${outPath} (${Buffer.byteLength(html)} bytes, ${modules.length} modules inlined)`);
}

build();
