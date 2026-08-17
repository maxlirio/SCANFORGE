/**
 * First-run engine installation.
 *
 * The app ships without the 3D engine: TRELLIS.2 is a Python program with ~16 GB
 * of model weights, which has no business inside a 260 MB app bundle. This module
 * installs it on demand and reports honest progress, so a user never sees a
 * terminal, a README or a package manager.
 *
 * Deliberate choices:
 *  - No `git`: a fresh Mac has none, and asking for it triggers Apple's Command
 *    Line Tools installer. Sources come down as an HTTPS tarball.
 *  - No Homebrew: if the system Python is unsuitable, a self-contained CPython
 *    build is downloaded instead of touching the system.
 *  - No Hugging Face account: the official DINOv3 weights are gated behind manual
 *    approval that can take days, so the installer uses ungated equivalents by
 *    default (see LICENCE_NOTE, surfaced in the UI).
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export const LICENCE_NOTE =
  'Model weights are downloaded from their publishers. TRELLIS.2 is MIT-licensed. ' +
  'The DINOv3 image encoder is under Meta\'s DINOv3 licence and is fetched from a ' +
  'public mirror, because the official repository requires manual approval; the ' +
  'background remover (BiRefNet) is Apache-2.0. Review those licences before ' +
  'commercial use.';

const TRELLIS_TARBALL = 'https://codeload.github.com/shivampkumar/trellis-mac/tar.gz/refs/heads/main';
/** Self-contained CPython, used only when the system Python is unsuitable. */
const PYTHON_STANDALONE =
  'https://github.com/astral-sh/python-build-standalone/releases/download/20250918/'
  + 'cpython-3.11.13+20250918-aarch64-apple-darwin-install_only.tar.gz';

export type StepId = 'python' | 'source' | 'deps' | 'patch' | 'weights' | 'verify';

export interface EngineEvent {
  type: 'step' | 'log' | 'done' | 'error';
  step?: StepId;
  status?: 'start' | 'progress' | 'end';
  /** Real fraction when the underlying tool reports one, otherwise null. */
  progress?: number | null;
  message?: string;
  detail?: string;
}

export interface EngineState {
  installed: boolean;
  installing: boolean;
  step?: StepId;
  message?: string;
  progress?: number | null;
  error?: string;
  root: string;
  /** Bytes this will download, roughly, so the user can decide. */
  downloadEstimateGb: number;
  licenceNote: string;
}

type Emit = (event: EngineEvent) => void;

export class EngineInstaller {
  private running = false;
  private state: EngineState = {
    installed: false,
    installing: false,
    root: config.trellisRoot,
    downloadEstimateGb: 18,
    licenceNote: LICENCE_NOTE,
  };
  private readonly listeners = new Set<Emit>();

  get snapshot(): EngineState {
    return { ...this.state };
  }

  subscribe(listener: Emit): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    if (event.type === 'step') {
      this.state.step = event.step;
      this.state.message = event.message;
      this.state.progress = event.progress ?? null;
    }
    if (event.type === 'error') this.state.error = event.message;
    for (const listener of this.listeners) listener(event);
  }

  async refresh(): Promise<EngineState> {
    const python = path.join(config.trellisRoot, '.venv', 'bin', 'python');
    const source = path.join(config.trellisRoot, 'TRELLIS.2');
    this.state.installed = await exists(python) && await exists(source);
    return this.snapshot;
  }

  /** Idempotent: resumes wherever a previous attempt stopped. */
  async install(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.state.installing = true;
    this.state.error = undefined;
    try {
      const python = await this.ensurePython();
      await this.ensureSource();
      await this.ensureDeps(python);
      await this.applyPatches();
      await this.fetchWeights();
      await this.verify();
      this.state.installed = true;
      this.emit({ type: 'done', message: 'The 3D engine is ready.' });
    } catch (err) {
      const error = err as Error;
      this.emit({ type: 'error', message: error.message, detail: error.stack });
    } finally {
      this.running = false;
      this.state.installing = false;
    }
  }

  // ---------------------------------------------------------------- python
  private async ensurePython(): Promise<string> {
    this.emit({ type: 'step', step: 'python', status: 'start', progress: null,
      message: 'Looking for a usable Python' });

    const bundled = path.join(config.trellisRoot, 'python', 'bin', 'python3');
    if (await exists(bundled)) {
      this.emit({ type: 'step', step: 'python', status: 'end', progress: 1,
        message: 'Using the previously downloaded Python' });
      return bundled;
    }

    // TRELLIS's dependencies target 3.11-3.13; 3.14 has no wheels for some of them.
    for (const candidate of ['python3.13', 'python3.12', 'python3.11', 'python3']) {
      const found = await which(candidate);
      if (!found) continue;
      try {
        const { stdout } = await execFileAsync(found, ['-c',
          'import sys;print("%d.%d" % sys.version_info[:2])']);
        const [major, minor] = stdout.trim().split('.').map(Number);
        if (major === 3 && minor >= 11 && minor <= 13) {
          this.emit({ type: 'step', step: 'python', status: 'end', progress: 1,
            message: `Using Python ${stdout.trim()} already on this Mac` });
          return found;
        }
      } catch { /* try the next candidate */ }
    }

    this.emit({ type: 'step', step: 'python', status: 'progress', progress: null,
      message: 'Downloading a self-contained Python (about 60 MB)' });
    const archive = path.join(os.tmpdir(), 'scanforge-python.tar.gz');
    await download(PYTHON_STANDALONE, archive, (fraction) =>
      this.emit({ type: 'step', step: 'python', status: 'progress', progress: fraction,
        message: 'Downloading Python' }));
    await fs.mkdir(config.trellisRoot, { recursive: true });
    // The archive contains a top-level `python/` directory.
    await run('tar', ['xzf', archive, '-C', config.trellisRoot], (line) =>
      this.emit({ type: 'log', message: line }));
    await fs.rm(archive, { force: true });
    if (!await exists(bundled)) throw new Error('the downloaded Python did not unpack as expected');
    this.emit({ type: 'step', step: 'python', status: 'end', progress: 1,
      message: 'Python ready' });
    return bundled;
  }

  // ---------------------------------------------------------------- source
  private async ensureSource(): Promise<void> {
    const marker = path.join(config.trellisRoot, 'generate.py');
    if (await exists(marker)) {
      this.emit({ type: 'step', step: 'source', status: 'end', progress: 1,
        message: 'Engine source already present' });
      return;
    }
    this.emit({ type: 'step', step: 'source', status: 'start', progress: null,
      message: 'Downloading the engine' });
    const archive = path.join(os.tmpdir(), 'scanforge-trellis.tar.gz');
    await download(TRELLIS_TARBALL, archive, (fraction) =>
      this.emit({ type: 'step', step: 'source', status: 'progress', progress: fraction,
        message: 'Downloading the engine' }));
    await fs.mkdir(config.trellisRoot, { recursive: true });
    // --strip-components drops the repo's own top-level folder name.
    await run('tar', ['xzf', archive, '-C', config.trellisRoot, '--strip-components', '1']);
    await fs.rm(archive, { force: true });
    if (!await exists(marker)) throw new Error('the engine archive did not unpack as expected');
    this.emit({ type: 'step', step: 'source', status: 'end', progress: 1,
      message: 'Engine downloaded' });
  }

  // ------------------------------------------------------------------ deps
  private async ensureDeps(python: string): Promise<void> {
    const venvPython = path.join(config.trellisRoot, '.venv', 'bin', 'python');
    if (!await exists(venvPython)) {
      this.emit({ type: 'step', step: 'deps', status: 'start', progress: null,
        message: 'Creating an isolated Python environment' });
      await run(python, ['-m', 'venv', path.join(config.trellisRoot, '.venv')]);
    }

    this.emit({ type: 'step', step: 'deps', status: 'progress', progress: null,
      message: 'Installing PyTorch and friends (about 3 GB — the long part)' });

    const packages = [
      'torch', 'torchvision', 'numpy', 'pillow', 'scipy', 'transformers',
      'huggingface_hub', 'safetensors', 'einops', 'timm', 'kornia',
      'xatlas', 'trimesh', 'fast-simplification', 'tqdm', 'omegaconf', 'opencv-python-headless',
    ];
    await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], () => undefined);
    await run(venvPython, ['-m', 'pip', 'install', ...packages], (line) => {
      // pip's own output is the only honest progress signal available here.
      const match = /^(Collecting|Downloading|Installing|Building) (.+)$/.exec(line.trim());
      if (match) {
        this.emit({ type: 'step', step: 'deps', status: 'progress', progress: null,
          message: `${match[1]} ${match[2].slice(0, 60)}` });
      }
    });
    this.emit({ type: 'step', step: 'deps', status: 'end', progress: 1,
      message: 'Python environment ready' });
  }

  // ----------------------------------------------------------------- patch
  private async applyPatches(): Promise<void> {
    this.emit({ type: 'step', step: 'patch', status: 'start', progress: null,
      message: 'Applying Apple Silicon fixes' });
    const venvPython = path.join(config.trellisRoot, '.venv', 'bin', 'python');
    // The port's own setup applies its MPS patches and builds what it can; failures
    // there are expected on a Mac without full Xcode and are not fatal.
    await run('bash', ['setup.sh'], (line) => this.emit({ type: 'log', message: line }), {
      cwd: config.trellisRoot,
      env: { SKIP_METAL: '1', PATH: `${path.dirname(venvPython)}:${process.env.PATH ?? ''}` },
      allowFailure: true,
    });
    this.emit({ type: 'step', step: 'patch', status: 'end', progress: 1,
      message: 'Fixes applied' });
  }

  // --------------------------------------------------------------- weights
  private async fetchWeights(): Promise<void> {
    this.emit({ type: 'step', step: 'weights', status: 'start', progress: null,
      message: 'Downloading model weights (about 16 GB)' });
    const venvPython = path.join(config.trellisRoot, '.venv', 'bin', 'python');
    await run(venvPython, ['-m', 'scanforge.engine_setup', '--trellis-root', config.trellisRoot], (line) => {
      try {
        const event = JSON.parse(line) as EngineEvent & { fraction?: number };
        this.emit({ type: 'step', step: 'weights', status: 'progress',
          progress: event.progress ?? null, message: event.message ?? 'Downloading' });
      } catch {
        this.emit({ type: 'log', message: line.slice(0, 200) });
      }
    }, {
      cwd: config.pipelineDir,
      env: { PYTHONPATH: config.pipelineDir, PYTHONUNBUFFERED: '1' },
    });
    this.emit({ type: 'step', step: 'weights', status: 'end', progress: 1,
      message: 'Weights downloaded' });
  }

  // ---------------------------------------------------------------- verify
  private async verify(): Promise<void> {
    this.emit({ type: 'step', step: 'verify', status: 'start', progress: null,
      message: 'Checking the GPU' });
    const venvPython = path.join(config.trellisRoot, '.venv', 'bin', 'python');
    const { stdout } = await execFileAsync(venvPython, ['-c',
      'import torch;print(torch.__version__, torch.backends.mps.is_available())'],
      { timeout: 180_000 });
    if (!stdout.includes('True')) {
      throw new Error('PyTorch cannot see a Metal GPU on this Mac.');
    }
    this.emit({ type: 'step', step: 'verify', status: 'end', progress: 1,
      message: `GPU ready (torch ${stdout.trim().split(' ')[0]})` });
  }
}

// ---------------------------------------------------------------- helpers

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function which(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/which', [command]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function download(url: string, target: string,
                        onProgress: (fraction: number | null) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let seen = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    const now = Date.now();
    if (now - lastReport > 400) {
      lastReport = now;
      onProgress(total > 0 ? Math.min(1, seen / total) : null);
    }
  });
  await streamPipeline(body, createWriteStream(target));
}

async function run(
  command: string,
  args: string[],
  onLine?: (line: string) => void,
  opts: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let tail = '';
    const consume = (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      if (onLine) for (const line of text.split('\n')) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || opts.allowFailure) resolve();
      else reject(new Error(`${path.basename(command)} failed (exit ${code}): ${tail.slice(-500)}`));
    });
  });
}
