#!/usr/bin/env node

/**
 * Build the macOS launcher bundle for Composer's Desk.
 *
 * Produces dist/House Band Composer.app with an executable that locates the
 * House Band repo, starts the local Desk server, and opens the default browser.
 * Vendors the two pinned Not Jam faces and their license files into both the
 * app bundle and the served desk/assets/fonts/ directory.
 */

import { mkdir, cp, writeFile, chmod, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const DIST_DIR = resolve(REPO_ROOT, 'dist');
const APP_BUNDLE = resolve(DIST_DIR, 'House Band Composer.app');
const CONTENTS = resolve(APP_BUNDLE, 'Contents');
const MACOS = resolve(CONTENTS, 'MacOS');
const RESOURCES = resolve(CONTENTS, 'Resources');
const APP_FONTS = resolve(RESOURCES, 'fonts');
const DESK_FONTS = resolve(REPO_ROOT, 'desk', 'assets', 'fonts');

const MONO_FONT_NAME = 'NotJamMonoClean8.ttf';
const DISPLAY_FONT_NAME = 'NotJamChunky8.ttf';
const MONO_LICENSE_NAME = 'NotJamMonoClean8-Licence.txt';
const DISPLAY_LICENSE_NAME = 'NotJamChunky8-Licence.txt';

const MONO_FONT_SRC = resolve(DESK_FONTS, MONO_FONT_NAME);
const MONO_LICENSE_SRC = resolve(DESK_FONTS, MONO_LICENSE_NAME);
const DISPLAY_FONT_SRC = resolve(DESK_FONTS, DISPLAY_FONT_NAME);
const DISPLAY_LICENSE_SRC = resolve(DESK_FONTS, DISPLAY_LICENSE_NAME);

async function ensureDir(path) {
  if (!existsSync(path)) await mkdir(path, { recursive: true });
}

async function copyFont(src, destDir, destName) {
  if (!existsSync(src)) throw new Error(`Font not found: ${src}`);
  const dest = resolve(destDir, destName);
  if (resolve(src) === resolve(dest)) return;
  await cp(src, dest);
}

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>House Band Composer</string>
  <key>CFBundleIdentifier</key>
  <string>io.github.lerugray.houseband.composer</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>House Band Composer</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;

const LAUNCHER_SCRIPT = `#!/bin/bash
set -euo pipefail

# The executable lives at .../House Band Composer.app/Contents/MacOS/House Band Composer
MACOS_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$MACOS_DIR/../.." && pwd)"

# Try the bundled repo layout first: app inside repo/dist.
REPO_ROOT="$(cd "$APP_ROOT/../../.." 2>/dev/null && pwd || true)"

# If that does not contain the House Band package, search upward for it.
if [[ ! -f "$REPO_ROOT/package.json" ]] || ! grep -q '"name": "house-band"' "$REPO_ROOT/package.json" 2>/dev/null; then
  SEARCH_DIR="$APP_ROOT"
  for _ in $(seq 1 6); do
    if [[ -f "$SEARCH_DIR/package.json" ]] && grep -q '"name": "house-band"' "$SEARCH_DIR/package.json" 2>/dev/null; then
      REPO_ROOT="$SEARCH_DIR"
      break
    fi
    SEARCH_DIR="$(cd "$SEARCH_DIR/.." && pwd)"
  done
fi

if [[ -z "\${REPO_ROOT:-}" ]] || [[ ! -f "$REPO_ROOT/package.json" ]]; then
  osascript -e 'display dialog "Could not find the House Band installation." buttons {"Quit"} default button "Quit" with icon stop' || true
  exit 1
fi

cd "$REPO_ROOT"
exec node src/desk-server.mjs --open
`;

async function main() {
  await ensureDir(DIST_DIR);
  await ensureDir(MACOS);
  await ensureDir(RESOURCES);
  await ensureDir(APP_FONTS);
  await ensureDir(DESK_FONTS);

  await copyFont(MONO_FONT_SRC, APP_FONTS, MONO_FONT_NAME);
  await copyFont(MONO_LICENSE_SRC, APP_FONTS, MONO_LICENSE_NAME);
  await copyFont(DISPLAY_FONT_SRC, APP_FONTS, DISPLAY_FONT_NAME);
  await copyFont(DISPLAY_LICENSE_SRC, APP_FONTS, DISPLAY_LICENSE_NAME);

  await copyFont(MONO_FONT_SRC, DESK_FONTS, MONO_FONT_NAME);
  await copyFont(MONO_LICENSE_SRC, DESK_FONTS, MONO_LICENSE_NAME);
  await copyFont(DISPLAY_FONT_SRC, DESK_FONTS, DISPLAY_FONT_NAME);
  await copyFont(DISPLAY_LICENSE_SRC, DESK_FONTS, DISPLAY_LICENSE_NAME);

  const executable = resolve(MACOS, 'House Band Composer');
  await writeFile(executable, LAUNCHER_SCRIPT, { mode: 0o755 });
  await chmod(executable, 0o755);

  await writeFile(resolve(CONTENTS, 'Info.plist'), INFO_PLIST, 'utf8');

  const info = await stat(APP_BUNDLE);
  console.log(`Built ${APP_BUNDLE} (${Math.round(info.size / 1024)} KB executable + bundled fonts)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
