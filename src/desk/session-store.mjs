/**
 * Composer's Desk session persistence.
 *
 * Sessions live in a visible House Band folder on the Mac and autosave on
 * every mutation. All mutable render state lives in the immutable validated
 * score takes; the session only holds references, change history, and UI
 * workflow state.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const DEFAULT_ROOT = resolve(homedir(), 'Music', 'House Band Composer', 'Sessions');

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}

export function sessionFilename(sessionId) {
  return `${sanitizeFilename(sessionId)}.json`;
}

export class SessionStore {
  constructor({ root = DEFAULT_ROOT } = {}) {
    this.root = root;
  }

  async init() {
    if (!existsSync(this.root)) {
      await mkdir(this.root, { recursive: true });
    }
    return this;
  }

  path(sessionId) {
    return resolve(this.root, sessionFilename(sessionId));
  }

  async create({ prompt = '', weissEnabled = true, profileId = null } = {}) {
    const sessionId = randomUUID();
    const session = {
      sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      prompt,
      revisionInstructions: [],
      weissEnabled,
      profileId,
      brief: null,
      takes: [],
      activeTakeId: null,
      exports: [],
      workflow: { currentStage: 'prompt' },
    };
    await this.write(session);
    return session;
  }

  async read(sessionId) {
    const data = await readFile(this.path(sessionId), 'utf8');
    return JSON.parse(data);
  }

  async write(session) {
    session.updatedAt = nowIso();
    await writeFile(this.path(session.sessionId), JSON.stringify(session, null, 2), 'utf8');
    return session;
  }

  async update(sessionId, mutator) {
    const session = await this.read(sessionId);
    const updated = await mutator(session);
    return this.write(updated);
  }

  async list() {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root);
    const sessions = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const data = await readFile(resolve(this.root, entry), 'utf8');
        const session = JSON.parse(data);
        sessions.push({
          sessionId: session.sessionId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          prompt: session.prompt,
          takeCount: session.takes.length,
          activeTakeId: session.activeTakeId,
        });
      } catch {
        // Skip unreadable files.
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
