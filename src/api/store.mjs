import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { canonicalJson, sha256 } from '../provenance.mjs';
import { ApiError } from './errors.mjs';

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value), 'utf8');
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

export class FileJobStore {
  constructor(root) {
    if (!root) throw new Error('job store root is required');
    this.root = root;
    this.queues = new Map();
  }

  jobDir(jobId) {
    return join(this.root, 'jobs', jobId);
  }

  async init() {
    await Promise.all([
      mkdir(join(this.root, 'jobs'), { recursive: true }),
      mkdir(join(this.root, 'index'), { recursive: true }),
    ]);
  }

  enqueue(jobId, operation) {
    const prior = this.queues.get(jobId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    this.queues.set(jobId, next);
    return next.finally(() => {
      if (this.queues.get(jobId) === next) this.queues.delete(jobId);
    });
  }

  async writeJobNow(job) {
    await atomicWrite(join(this.jobDir(job.jobId), 'job.json'), `${canonicalJson(job)}\n`);
  }

  async writeJob(job) {
    return this.enqueue(job.jobId, () => this.writeJobNow(job));
  }

  async readJob(jobId) {
    try {
      return JSON.parse(await readFile(join(this.jobDir(jobId), 'job.json'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new ApiError('JOB_NOT_FOUND', `job ${jobId} was not found`, { details: { jobId } });
      throw error;
    }
  }

  async writeArtifact(job, { kind, filename, mediaType, acceptance, canonicalSongIdentity = false, data }) {
    return this.enqueue(job.jobId, async () => {
      const body = bytes(data);
      const artifactId = `${String(job.artifacts.length + 1).padStart(4, '0')}-${kind}`;
      const path = join(this.jobDir(job.jobId), 'artifacts', artifactId);
      try {
        await atomicWrite(path, body);
      } catch (cause) {
        throw new ApiError('ARTIFACT_WRITE_FAILED', `could not retain ${kind} artifact`, {
          stage: job.currentStage,
          jobId: job.jobId,
          details: { kind, filename },
          cause,
        });
      }
      const artifact = Object.freeze({
        artifactId,
        kind,
        filename,
        mediaType,
        sizeBytes: body.length,
        sha256: sha256(body),
        createdAt: new Date().toISOString(),
        acceptance,
        canonicalSongIdentity,
      });
      job.artifacts.push(artifact);
      await this.writeJobNow(job);
      return artifact;
    });
  }

  async readArtifact(jobId, artifactId) {
    const job = await this.readJob(jobId);
    const artifact = job.artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) throw new ApiError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} was not found`, { details: { jobId, artifactId } });
    return Object.freeze({ artifact, bytes: await readFile(join(this.jobDir(jobId), 'artifacts', artifactId)) });
  }

  async readArtifactByKind(jobId, kind) {
    const job = await this.readJob(jobId);
    const artifact = [...job.artifacts].reverse().find((candidate) => candidate.kind === kind);
    if (!artifact) throw new ApiError('ARTIFACT_NOT_FOUND', `job ${jobId} has no ${kind} artifact`, { details: { jobId, kind } });
    return this.readArtifact(jobId, artifact.artifactId);
  }

  async appendEvent(jobId, event) {
    return this.enqueue(jobId, async () => {
      const path = join(this.jobDir(jobId), 'events.json');
      let events = [];
      try {
        events = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      events.push(event);
      await atomicWrite(path, `${canonicalJson(events)}\n`);
      return event;
    });
  }

  async readEvents(jobId) {
    try {
      return JSON.parse(await readFile(join(this.jobDir(jobId), 'events.json'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeIndex(jobId, value) {
    await atomicWrite(join(this.root, 'index', `${jobId}.json`), `${canonicalJson(value)}\n`);
  }

  async readIndex(jobId) {
    try {
      return JSON.parse(await readFile(join(this.root, 'index', `${jobId}.json`), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new ApiError('JOB_NOT_FOUND', `job index ${jobId} was not found`, { details: { jobId } });
      throw error;
    }
  }
}
