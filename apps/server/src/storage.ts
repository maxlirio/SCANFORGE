/**
 * Storage seam.
 *
 * Everything the rest of the server does with bytes goes through this interface,
 * so swapping the local filesystem for S3/GCS later is a single new class rather
 * than a grep for `fs.` across the codebase.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { JobRecord, OutputFile } from '@scanforge/shared';

export interface Storage {
  /** Directories handed to a provider. Local providers need real paths. */
  imagesDir(jobId: string): string;
  workDir(jobId: string): string;
  outDir(jobId: string): string;
  ensureJob(jobId: string): Promise<void>;
  saveImage(jobId: string, filename: string, data: Readable): Promise<number>;
  listImages(jobId: string): Promise<string[]>;
  listOutputs(jobId: string): Promise<OutputFile[]>;
  outputPath(jobId: string, name: string): string | null;
  /** Drop a finished job's scratch space, keeping its uploads and outputs. */
  clearWork(jobId: string): Promise<void>;
  /** Delete jobs older than `maxAgeDays`, then trim to the newest `maxJobs`. */
  prune(maxAgeDays: number, maxJobs: number): Promise<string[]>;
  saveJob(record: JobRecord): Promise<void>;
  loadJob(jobId: string): Promise<JobRecord | null>;
  listJobs(limit?: number): Promise<JobRecord[]>;
  deleteJob(jobId: string): Promise<void>;
}

const OUTPUT_LABELS: Record<string, { label: string; primary?: boolean }> = {
  'model.glb': { label: 'GLB (recommended — geometry + texture in one file)', primary: true },
  'model.obj': { label: 'OBJ (needs model.mtl + texture.jpg)' },
  'model.mtl': { label: 'OBJ material' },
  'model.ply': { label: 'PLY mesh (untextured geometry)' },
  'points.ply': { label: 'Sparse point cloud' },
  'points_dense.ply': { label: 'Dense point cloud' },
  'texture.jpg': { label: 'Texture atlas' },
  'thumbnail.jpg': { label: 'Preview image' },
};

/** Reject anything that could escape the job directory. */
function safeName(name: string): string | null {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (!/^[\w.-]{1,120}$/.test(name)) return null;
  return name;
}

export class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  private jobDir(jobId: string): string {
    const id = safeName(jobId);
    if (!id) throw new Error('invalid job id');
    return path.join(this.root, 'jobs', id);
  }

  imagesDir(jobId: string): string {
    return path.join(this.jobDir(jobId), 'images');
  }

  workDir(jobId: string): string {
    return path.join(this.jobDir(jobId), 'work');
  }

  outDir(jobId: string): string {
    return path.join(this.jobDir(jobId), 'output');
  }

  async ensureJob(jobId: string): Promise<void> {
    await fsp.mkdir(this.imagesDir(jobId), { recursive: true });
    await fsp.mkdir(this.workDir(jobId), { recursive: true });
    await fsp.mkdir(this.outDir(jobId), { recursive: true });
  }

  async saveImage(jobId: string, filename: string, data: Readable): Promise<number> {
    const name = safeName(filename);
    if (!name) throw new Error(`unsafe filename: ${filename}`);
    const target = path.join(this.imagesDir(jobId), name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await pipeline(data, fs.createWriteStream(target));
    return (await fsp.stat(target)).size;
  }

  async listImages(jobId: string): Promise<string[]> {
    try {
      const names = await fsp.readdir(this.imagesDir(jobId));
      return names.filter((n) => !n.startsWith('.')).sort();
    } catch {
      return [];
    }
  }

  async listOutputs(jobId: string): Promise<OutputFile[]> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.outDir(jobId));
    } catch {
      return [];
    }
    const files: OutputFile[] = [];
    for (const name of names) {
      if (name.startsWith('.') || name === 'result.json') continue;
      const stat = await fsp.stat(path.join(this.outDir(jobId), name));
      if (!stat.isFile()) continue;
      const meta = OUTPUT_LABELS[name] ?? { label: name };
      files.push({ name, bytes: stat.size, label: meta.label, primary: meta.primary });
    }
    return files.sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false));
  }

  outputPath(jobId: string, name: string): string | null {
    const safe = safeName(name);
    if (!safe) return null;
    const full = path.join(this.outDir(jobId), safe);
    return full.startsWith(this.outDir(jobId)) && fs.existsSync(full) ? full : null;
  }

  async clearWork(jobId: string): Promise<void> {
    await fsp.rm(this.workDir(jobId), { recursive: true, force: true });
  }

  /**
   * Hosted deployments have small, often ephemeral disks, and a reconstruction
   * leaves hundreds of megabytes behind. Nothing here touches a job that is
   * still queued or running.
   */
  async prune(maxAgeDays: number, maxJobs: number): Promise<string[]> {
    const jobs = await this.listJobs(1000);
    const finished = jobs.filter((j) => j.status !== 'running' && j.status !== 'queued');
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const doomed = new Set<string>();
    for (const job of finished) {
      if (job.createdAt < cutoff) doomed.add(job.id);
    }
    const survivors = finished.filter((j) => !doomed.has(j.id));
    for (const job of survivors.slice(maxJobs)) doomed.add(job.id);
    for (const id of doomed) await this.deleteJob(id);
    return [...doomed];
  }

  async saveJob(record: JobRecord): Promise<void> {
    await this.ensureJob(record.id);
    const target = path.join(this.jobDir(record.id), 'job.json');
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await fsp.rename(tmp, target);   // atomic: a crash mid-write never truncates history
  }

  async loadJob(jobId: string): Promise<JobRecord | null> {
    try {
      const raw = await fsp.readFile(path.join(this.jobDir(jobId), 'job.json'), 'utf8');
      return JSON.parse(raw) as JobRecord;
    } catch {
      return null;
    }
  }

  async listJobs(limit = 50): Promise<JobRecord[]> {
    let ids: string[] = [];
    try {
      ids = await fsp.readdir(path.join(this.root, 'jobs'));
    } catch {
      return [];
    }
    const jobs: JobRecord[] = [];
    for (const id of ids) {
      const job = await this.loadJob(id);
      if (job) jobs.push(job);
    }
    return jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async deleteJob(jobId: string): Promise<void> {
    await fsp.rm(this.jobDir(jobId), { recursive: true, force: true });
  }
}
