/**
 * TRELLIS.2 running on this machine's own GPU (Apple Silicon / Metal).
 *
 * One photograph in, a clean textured game-ready mesh out, with no API key, no
 * per-scan cost and nothing leaving the machine. Unlike the photogrammetry
 * provider it *generates* geometry from learned priors rather than measuring it,
 * which is why it copes with the untextured objects photogrammetry cannot see.
 *
 * It runs in the trellis-mac virtualenv (which owns torch/MPS), not the
 * SCANFORGE pipeline venv, and speaks the same JSON event protocol.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PipelineEvent, ProviderStatus } from '@scanforge/shared';
import { config } from '../config.js';
import type { ReconstructionProvider, RunContext } from './types.js';

const execFileAsync = promisify(execFile);

export class TrellisLocalProvider implements ReconstructionProvider {
  readonly id = 'trellis-local';
  readonly label = 'TRELLIS.2 on this machine’s GPU';
  readonly description =
    'Generates a clean, game-ready textured mesh from a single photo, on this machine’s ' +
    'GPU. Handles plain, untextured objects that photogrammetry cannot see — but it ' +
    'invents the sides your photo never showed.';
  /** One good photograph is all it uses. */
  readonly minPhotos = 1;

  private get root(): string {
    return config.trellisRoot;
  }

  private get python(): string {
    return path.join(this.root, '.venv', 'bin', 'python');
  }

  async probe(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      id: this.id,
      label: this.label,
      description: this.description,
      available: false,
      generative: true,
      requiresNetwork: false,
      minPhotos: this.minPhotos,
    };

    if (!fs.existsSync(this.python)) {
      return {
        ...base,
        reason: `TRELLIS is not installed at ${this.root}. See docs/TRELLIS_LOCAL.md.`,
      };
    }
    if (!fs.existsSync(path.join(this.root, 'TRELLIS.2'))) {
      return { ...base, reason: 'The TRELLIS.2 checkout is missing; re-run its setup.sh.' };
    }

    // The weights are ~16 GB and download on first use; say so rather than
    // letting the first scan stall for twenty minutes with no explanation.
    const weights = path.join(
      os.homedir(), '.cache', 'huggingface', 'hub', 'models--microsoft--TRELLIS.2-4B');
    const weightsReady = fs.existsSync(weights);

    let torch = '';
    try {
      const { stdout } = await execFileAsync(
        this.python,
        ['-c', 'import torch;print(torch.__version__, torch.backends.mps.is_available())'],
        { timeout: 120_000 },
      );
      torch = stdout.trim();
    } catch (err) {
      return { ...base, reason: `PyTorch is not usable: ${(err as Error).message.split('\n')[0]}` };
    }
    const [version, mps] = torch.split(' ');
    if (mps !== 'True') {
      return { ...base, reason: 'PyTorch reports no Metal (MPS) GPU on this machine.' };
    }

    return {
      ...base,
      available: true,
      details: {
        torch: version,
        gpu: 'Apple Metal (MPS)',
        weights: weightsReady ? 'downloaded' : 'will download on first scan (~16 GB)',
        root: this.root,
      },
    };
  }

  async run(ctx: RunContext): Promise<void> {
    const args = [
      '-m', 'scanforge.trellis_run',
      '--images', ctx.imagesDir,
      '--out', ctx.outDir,
      '--work', ctx.workDir,
      '--trellis-root', this.root,
      '--quality', ctx.options.quality,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.python, args, {
        cwd: config.pipelineDir,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          // scanforge.* lives in the SCANFORGE pipeline directory, while the
          // interpreter belongs to the TRELLIS venv.
          PYTHONPATH: config.pipelineDir,
        },
      });

      let buffer = '';
      let reported: { message: string; detail?: string } | null = null;
      const onAbort = () => child.kill('SIGTERM');
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line) as PipelineEvent;
            if (event.type === 'error') reported = { message: event.message, detail: event.detail };
            ctx.emit(event);
          } catch {
            // TRELLIS prints plenty of unstructured progress; keep the last of it.
            ctx.emit({ type: 'log', level: 'info', message: line.slice(0, 300), ts: Date.now() / 1000 });
          }
        }
      });

      // tqdm writes to stderr; surface it as a live message so a long GPU phase
      // visibly moves, without pretending to know a percentage of the whole job.
      let stderrTail = '';
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-4000);
        const last = text.split(/[\r\n]/).filter((l) => l.trim()).pop();
        if (last && /\d+%|\d+\/\d+/.test(last)) {
          ctx.emit({
            type: 'stage', stage: 'meshing', group: 'geometry', status: 'progress',
            progress: null, message: last.trim().slice(0, 120), ts: Date.now() / 1000,
          });
        }
      });

      child.on('error', (err) => {
        ctx.signal.removeEventListener('abort', onAbort);
        reject(new Error(`Could not start TRELLIS: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        ctx.signal.removeEventListener('abort', onAbort);
        if (signal === 'SIGTERM' || ctx.signal.aborted) {
          reject(Object.assign(new Error('Generation cancelled'), { cancelled: true }));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        if (reported) {
          const err = new Error(reported.message);
          (err as Error & { detail?: string }).detail = reported.detail;
          reject(err);
          return;
        }
        reject(new Error(`TRELLIS failed (exit ${code}).\n${stderrTail.slice(-1200)}`));
      });
    });
  }
}
