#!/usr/bin/env node
/**
 * Copy page audio from git objects (not working trees) into site/audio and site/scores,
 * encode Appendix N MP3s, and write site/SOURCES.md.
 *
 * Env: TRISTATE_DIR (tristate-roguelike with da7c971), APPENDIX_N_DIR (appendix-n with
 * 1a74d0e6, 31795647, 19541e25). ffmpeg must be on PATH for Appendix N MP3s.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const ROOT = path.resolve(SITE, '..');

const DARKNESS_COMMIT = 'da7c971';
const DARKNESS_TRACKS = [
  '00-approaching',
  '01-main-street',
  '02-past-the-last-light',
  '03-tuesday-night',
  '04-sorry-about-the-wait',
  '05-off-season',
  '06-the-742',
  '07-forty-one-seconds',
  '08a-hold-music',
  '08b-hold-music',
];

const APPENDIX_FILES = [
  {
    commit: '1a74d0e6',
    originPath: 'assets/music/an-house-band-first-decent-2026-10-24.ogg',
    siteName: 'an-house-band-first-decent-2026-10-24.ogg',
  },
  {
    commit: '31795647',
    originPath: 'assets/music/an-house-band-maybe-an-2-2026-10-25.ogg',
    siteName: 'an-house-band-maybe-an-2-2026-10-25.ogg',
  },
  {
    commit: '19541e25',
    originPath: 'docs/listen/an-ray-pieces-s332/source-as-written-ANfirstdecent-2026-10-24.ogg',
    siteName: 'source-as-written-ANfirstdecent-2026-10-24.ogg',
  },
  {
    commit: '19541e25',
    originPath: 'docs/listen/an-ray-pieces-s332/source-as-written-maybean2-2026-10-24.ogg',
    siteName: 'source-as-written-maybean2-2026-10-24.ogg',
  },
];

const LICENCE = 'all rights reserved; streamed on this page only';

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`fetch-audio: set ${name} to a local checkout path`);
  if (!fs.existsSync(v)) die(`fetch-audio: ${name}=${v} does not exist`);
  return path.resolve(v);
}

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: opts.encoding ?? 'buffer',
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const err = (r.stderr && r.stderr.toString()) || r.error?.message || `exit ${r.status}`;
    die(`fetch-audio: git -C ${cwd} ${args.join(' ')} failed: ${err}`);
  }
  return r.stdout;
}

function requireCommit(dir, commit) {
  const r = spawnSync('git', ['-C', dir, 'cat-file', '-e', `${commit}^{commit}`]);
  if (r.status !== 0) {
    die(`fetch-audio: commit ${commit} missing in ${dir} (git cat-file -e)`);
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function writeBinary(filePath, buf) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

function siteRel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function main() {
  const tristate = requireEnv('TRISTATE_DIR');
  const appendix = requireEnv('APPENDIX_N_DIR');

  requireCommit(tristate, DARKNESS_COMMIT);
  for (const c of new Set(APPENDIX_FILES.map((f) => f.commit))) {
    requireCommit(appendix, c);
  }

  const rows = [];

  // Titles/loop lengths from MANIFEST (kept in git objects with the audio).
  const manifestRaw = git(tristate, ['show', `${DARKNESS_COMMIT}:audio/listen-sets/LS03/MANIFEST.json`], {
    encoding: 'utf8',
  });
  const manifest = JSON.parse(manifestRaw);
  const byFile = new Map(manifest.files.map((f) => [f.file, f]));

  for (const name of DARKNESS_TRACKS) {
    if (!byFile.has(name)) die(`fetch-audio: ${name} missing from LS03 MANIFEST.json`);
    for (const ext of ['mp3', 'ogg']) {
      const originPath = `audio/listen-sets/LS03/${name}.${ext}`;
      const buf = git(tristate, ['show', `${DARKNESS_COMMIT}:${originPath}`]);
      const dest = path.join(SITE, 'audio', 'darkness', `${name}.${ext}`);
      writeBinary(dest, buf);
      rows.push({
        sitePath: siteRel(dest),
        originRepo: 'tristate-roguelike',
        commit: DARKNESS_COMMIT,
        originPath,
        sha256: sha256(buf),
        bytes: buf.length,
        licence: LICENCE,
      });
    }
    const scoreOrigin = `audio/score/${name}.json`;
    const scoreBuf = git(tristate, ['show', `${DARKNESS_COMMIT}:${scoreOrigin}`]);
    const scoreDest = path.join(SITE, 'scores', 'darkness', `${name}.json`);
    writeBinary(scoreDest, scoreBuf);
    rows.push({
      sitePath: siteRel(scoreDest),
      originRepo: 'tristate-roguelike',
      commit: DARKNESS_COMMIT,
      originPath: scoreOrigin,
      sha256: sha256(scoreBuf),
      bytes: scoreBuf.length,
      licence: LICENCE,
    });
  }

  for (const item of APPENDIX_FILES) {
    const buf = git(appendix, ['show', `${item.commit}:${item.originPath}`]);
    const dest = path.join(SITE, 'audio', 'appendix-n', item.siteName);
    writeBinary(dest, buf);
    rows.push({
      sitePath: siteRel(dest),
      originRepo: 'appendix-n',
      commit: item.commit,
      originPath: item.originPath,
      sha256: sha256(buf),
      bytes: buf.length,
      licence: LICENCE,
    });

    const mp3Name = item.siteName.replace(/\.ogg$/i, '.mp3');
    const mp3Dest = path.join(SITE, 'audio', 'appendix-n', mp3Name);
    const ff = spawnSync(
      'ffmpeg',
      ['-y', '-i', dest, '-codec:a', 'libmp3lame', '-q:a', '2', mp3Dest],
      { encoding: 'utf8' },
    );
    if (ff.status !== 0) {
      die(`fetch-audio: ffmpeg MP3 failed for ${item.siteName}: ${ff.stderr || ff.error?.message}`);
    }
    const mp3Buf = fs.readFileSync(mp3Dest);
    rows.push({
      sitePath: siteRel(mp3Dest),
      originRepo: 'appendix-n',
      commit: item.commit,
      originPath: `${item.originPath} (ffmpeg libmp3lame -q:a 2)`,
      sha256: sha256(mp3Buf),
      bytes: mp3Buf.length,
      licence: LICENCE,
    });
  }

  const md = [
    '# Page audio sources',
    '',
    'Generated by `site/tools/fetch-audio.mjs`. Every audio and score file on the landing page',
    'is listed once. Darkness and Appendix N soundtrack audio is all rights reserved and streamed',
    'on this page only (not for redistribution).',
    '',
    '| site path | origin repo | commit | origin path | sha256 | bytes | licence |',
    '|---|---|---|---|---|---:|---|',
    ...rows.map((r) =>
      `| \`${r.sitePath}\` | ${r.originRepo} | \`${r.commit}\` | \`${r.originPath}\` | \`${r.sha256}\` | ${r.bytes} | ${r.licence} |`,
    ),
    '',
  ].join('\n');

  fs.writeFileSync(path.join(SITE, 'SOURCES.md'), md, 'utf8');
  console.log(`fetch-audio: wrote ${rows.length} rows to site/SOURCES.md`);
}

main();
