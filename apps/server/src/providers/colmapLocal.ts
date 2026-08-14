/**
 * Default provider: the local COLMAP photogrammetry pipeline.
 *
 * Runs `python -m scanforge.run` as a child process and translates its
 * newline-delimited JSON events straight through to the job. No progress is
 * synthesised here — if the pipeline says `null`, the UI shows indeterminate.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { PipelineEvent, ProviderStatus } from '@scanforge/shared';
import { config } from '../config.js';
import type { ReconstructionProvider, RunContext } from './types.js';

const execFileAsync = promisify(execFile);

export class ColmapLocalProvider implements ReconstructionProvider {
  readonly id = 'colmap-local';
  readonly label = 'COLMAP photogrammetry (local)';
  readonly description =
    'Measures your actual object from your actual photos. Runs entirely on this machine, ' +
    'no API key and nothing leaves the network.';

  async probe(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      id: this.id,
      label: this.label,
      description: this.description,
      available: false,
      generative: false,
      requiresNetwork: false,
    };

    if (!fs.existsSync(path.join(config.pipelineDir, 'scanforge', 'run.py'))) {
      return { ...base, reason: 'pipeline/ is missing from the install' };
    }

    let python: { ok: boolean; detail: string };
    try {
      const { stdout } = await execFileAsync(config.pythonBin, ['-c', 'import numpy, PIL; print("ok")'], {
        cwd: config.pipelineDir,
        timeout: 30_000,
      });
      python = { ok: stdout.trim().endsWith('ok'), detail: config.pythonBin };
    } catch (err) {
      return {
        ...base,
        reason: `Python environment not ready (${(err as Error).message.split('\n')[0]}). ` +
          'Run: npm run setup:pipeline',
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(config.pythonBin, ['-m', 'scanforge.probe'], {
        cwd: config.pipelineDir,
        timeout: 60_000,
        env: { ...process.env, ...(config.colmapBin ? { COLMAP_BIN: config.colmapBin } : {}) },
      });
      const info = JSON.parse((stdout || stderr).trim());
      if (!info.colmap?.available) {
        return {
          ...base,
          reason: info.colmap?.error || 'COLMAP is not installed. On macOS: brew install colmap',
          details: info,
        };
      }
      return {
        ...base,
        available: true,
        details: {
          python: python.detail,
          colmapVersion: info.colmap.version,
          colmapPath: info.colmap.path,
          cuda: info.colmap.cuda,
          tier: info.tier,
          openmvs: info.openmvs,
        },
      };
    } catch (err) {
      return { ...base, reason: `Could not probe COLMAP: ${(err as Error).message.split('\n')[0]}` };
    }
  }

  async run(ctx: RunContext): Promise<void> {
    const args = [
      '-m', 'scanforge.run',
      '--images', ctx.imagesDir,
      '--work', ctx.workDir,
      '--out', ctx.outDir,
      '--quality', ctx.options.quality,
      '--mode', ctx.options.mode,
      '--max-images', String(config.maxImages),
    ];
    if (ctx.options.matcher && ctx.options.matcher !== 'auto') {
      args.push('--matcher', ctx.options.matcher);
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(config.pythonBin, args, {
        cwd: config.pipelineDir,
        env: { ...process.env, PYTHONUNBUFFERED: '1', ...(config.colmapBin ? { COLMAP_BIN: config.colmapBin } : {}) },
      });

      let stdoutBuffer = '';
      let sawError: { message: string; detail?: string } | null = null;

      const onAbort = () => child.kill('SIGTERM');
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        let idx: number;
        while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, idx).trim();
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line) as PipelineEvent;
            if (event.type === 'error') sawError = { message: event.message, detail: event.detail };
            ctx.emit(event);
          } catch {
            ctx.emit({ type: 'log', level: 'info', message: line.slice(0, 500), ts: Date.now() / 1000 });
          }
        }
      });

      // The pipeline logs structured events on stdout; stderr is for real crashes.
      let stderrTail = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      });

      child.on('error', (err) => {
        ctx.signal.removeEventListener('abort', onAbort);
        reject(new Error(`Could not start the pipeline: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        ctx.signal.removeEventListener('abort', onAbort);
        if (signal === 'SIGTERM' || ctx.signal.aborted) {
          reject(Object.assign(new Error('Reconstruction cancelled'), { cancelled: true }));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        if (sawError) {
          const err = new Error(sawError.message);
          (err as Error & { detail?: string }).detail = sawError.detail;
          reject(err);
          return;
        }
        reject(new Error(`Reconstruction failed (exit ${code}).\n${stderrTail.slice(-1200)}`));
      });
    });
  }
}
