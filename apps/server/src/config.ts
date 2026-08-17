import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** repo root: apps/server/src -> apps/server -> apps -> repo */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Prefer the pipeline virtualenv, but let an operator point elsewhere. */
function defaultPython(): string {
  const venv = path.join(REPO_ROOT, 'pipeline', '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : 'python3';
}

export const config = {
  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 5174),
  dataDir: path.resolve(env('SCANFORGE_DATA_DIR', path.join(REPO_ROOT, 'data'))),
  pipelineDir: path.join(REPO_ROOT, 'pipeline'),
  pythonBin: env('SCANFORGE_PYTHON', defaultPython()),
  colmapBin: process.env.COLMAP_BIN ?? '',
  /** Where the Apple Silicon TRELLIS.2 port lives (see docs/TRELLIS_LOCAL.md). */
  trellisRoot: env('SCANFORGE_TRELLIS_ROOT',
    path.join(process.env.HOME ?? '~', '.scanforge', 'trellis-mac')),
  defaultProvider: env('SCANFORGE_PROVIDER', 'trellis-local'),
  /** Reconstruction is CPU-bound; running two at once just makes both slower. */
  concurrency: envInt('SCANFORGE_CONCURRENCY', 1),
  maxImages: envInt('SCANFORGE_MAX_IMAGES', 250),
  /** Photos above this count switch to sequential matching (O(n) not O(n^2)). */
  exhaustiveMax: envInt('SCANFORGE_EXHAUSTIVE_MAX', 80),
  /** Default quality offered to new scans; small hosts should say 'fast'. */
  defaultQuality: env('SCANFORGE_DEFAULT_QUALITY', 'balanced') as 'fast' | 'balanced' | 'high',
  maxUploadBytes: envInt('SCANFORGE_MAX_UPLOAD_BYTES', 32 * 1024 * 1024),
  jobRetentionDays: envInt('SCANFORGE_RETENTION_DAYS', 30),
  /** Hard cap on stored scans; the oldest are deleted first. */
  maxJobs: envInt('SCANFORGE_MAX_JOBS', 60),
  kaggle: {
    /** Prebuilt CUDA extension wheels; without them every run compiles for ~25 min. */
    wheelsDataset: env('SCANFORGE_KAGGLE_WHEELS', ''),
    pollMs: envInt('SCANFORGE_KAGGLE_POLL_MS', 15_000),
    timeoutMinutes: envInt('SCANFORGE_KAGGLE_TIMEOUT_MIN', 45),
  },
  replicate: {
    token: env('REPLICATE_API_TOKEN', ''),
    model: env('REPLICATE_MODEL', 'firtoz/trellis'),
    version: env('REPLICATE_MODEL_VERSION', ''),
    imagesField: env('REPLICATE_IMAGES_FIELD', 'images'),
    pollMs: envInt('REPLICATE_POLL_MS', 3000),
  },
  version: '0.1.0',
  machine: {
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    arch: process.arch,
    cpus: os.cpus().length,
  },
};

export type Config = typeof config;
