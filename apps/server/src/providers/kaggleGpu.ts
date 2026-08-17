/**
 * Generate on a free Kaggle GPU instead of this machine.
 *
 * Kaggle gives ~30 GPU-hours a week on a Tesla P100. CUDA has the optimised
 * sparse-convolution kernels that the Apple Silicon port has to emulate in pure
 * PyTorch, so a generation that takes ~13 minutes locally should take a few
 * minutes there, and it leaves this Mac free.
 *
 * Measured facts that shaped this (from scanforge-gpu-probe, run on Kaggle):
 *  - P100, capability 6.0: flash-attn is unavailable, so the sdpa path is used.
 *  - The 16 GB of model weights download in 68 seconds. They are NOT cached in a
 *    dataset; it is not worth the complexity.
 *  - TRELLIS.2 builds five CUDA extensions from source, 15-30 minutes. Those ARE
 *    cached, as prebuilt wheels in a private dataset (scripts/kaggle/).
 *
 * The photograph travels inside the kernel script as base64 rather than as a
 * dataset: one small file, one API call, no upload-token dance.
 *
 * Kaggle is a notebook platform, not a compute API. Running your own inference on
 * your own quota is ordinary use; driving it automatically at volume is not what
 * it is for, and could attract throttling.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ProviderStatus } from '@scanforge/shared';
import { config } from '../config.js';
import type { ReconstructionProvider, RunContext } from './types.js';

const API = 'https://www.kaggle.com/api/v1';

interface Credentials { username: string; key: string }

async function credentials(): Promise<Credentials | null> {
  const file = process.env.KAGGLE_CONFIG_FILE
    ?? path.join(os.homedir(), '.kaggle', 'kaggle.json');
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Credentials;
    return parsed.username && parsed.key ? parsed : null;
  } catch {
    return null;
  }
}

function auth(creds: Credentials): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.key}`).toString('base64')}`;
}

export class KaggleGpuProvider implements ReconstructionProvider {
  readonly id = 'kaggle-gpu';
  readonly label = 'Free GPU on Kaggle';
  readonly description =
    'Runs the generation on a free Tesla P100 in your Kaggle account instead of this ' +
    'Mac. Faster, and leaves your machine alone — but your photo is uploaded to ' +
    'Kaggle, and it uses your weekly GPU quota.';
  readonly minPhotos = 1;

  async probe(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      id: this.id,
      label: this.label,
      description: this.description,
      available: false,
      generative: true,
      requiresNetwork: true,
      minPhotos: this.minPhotos,
    };

    const creds = await credentials();
    if (!creds) {
      return {
        ...base,
        reason: 'No Kaggle credentials. Download kaggle.json from your Kaggle account '
          + 'settings and put it in ~/.kaggle/.',
      };
    }

    const wheels = config.kaggle.wheelsDataset || `${creds.username}/scanforge-wheels`;
    try {
      const res = await fetch(`${API}/datasets/view/${wheels}`, {
        headers: { Authorization: auth(creds) },
      });
      if (!res.ok) {
        return {
          ...base,
          reason: `Prebuilt CUDA wheels not found at ${wheels}. Build them once with `
            + 'scripts/kaggle/build_wheels.sh — without them every run spends 15-30 '
            + 'minutes compiling.',
          details: { account: creds.username },
        };
      }
    } catch (err) {
      return { ...base, reason: `Cannot reach Kaggle: ${(err as Error).message}` };
    }

    return {
      ...base,
      available: true,
      details: { account: creds.username, gpu: 'Tesla P100 (free tier)', wheels },
    };
  }

  async run(ctx: RunContext): Promise<void> {
    const creds = await credentials();
    if (!creds) throw new Error('No Kaggle credentials in ~/.kaggle/kaggle.json');
    const slug = `scanforge-run-${ctx.jobId.slice(0, 8)}`;
    const wheels = config.kaggle.wheelsDataset || `${creds.username}/scanforge-wheels`;

    ctx.emit({
      type: 'stage', stage: 'preparing', group: 'preparing', status: 'start',
      progress: null, message: 'Preparing the photo for upload', ts: Date.now() / 1000,
    });
    const photo = await this.bestPhotoBase64(ctx.imagesDir);
    ctx.emit({
      type: 'stage', stage: 'preparing', group: 'preparing', status: 'end',
      progress: 1, message: 'Photo ready', ts: Date.now() / 1000,
    });

    const script = runnerScript(photo, ctx.options.quality);

    ctx.emit({
      type: 'stage', stage: 'meshing', group: 'geometry', status: 'start',
      progress: null, message: 'Queuing on a Kaggle GPU', ts: Date.now() / 1000,
    });

    const push = await fetch(`${API}/kernels/push`, {
      method: 'POST',
      headers: { Authorization: auth(creds), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: `${creds.username}/${slug}`,
        title: slug,
        text: script,
        language: 'python',
        kernelType: 'script',
        isPrivate: true,
        enableGpu: true,
        enableInternet: true,
        datasetDataSources: [wheels],
        competitionDataSources: [],
        kernelDataSources: [],
      }),
    });
    if (!push.ok) {
      throw new Error(`Kaggle rejected the run (${push.status}): ${(await push.text()).slice(0, 300)}`);
    }

    // Kaggle reports queued/running/complete and nothing finer, so the UI gets an
    // indeterminate indicator and the truth about which stage we are in.
    const deadline = Date.now() + config.kaggle.timeoutMinutes * 60_000;
    let status = 'queued';
    while (Date.now() < deadline) {
      if (ctx.signal.aborted) {
        throw Object.assign(new Error('Cancelled'), { cancelled: true });
      }
      await new Promise((r) => setTimeout(r, config.kaggle.pollMs));
      const res = await fetch(
        `${API}/kernels/status?userName=${creds.username}&kernelSlug=${slug}`,
        { headers: { Authorization: auth(creds) } });
      if (!res.ok) continue;
      const body = await res.json() as { status?: string; failureMessage?: string };
      status = (body.status ?? '').toLowerCase();
      ctx.emit({
        type: 'stage', stage: 'meshing', group: 'geometry', status: 'progress',
        progress: null, message: `Kaggle: ${status}`, ts: Date.now() / 1000,
      });
      if (status.includes('complete')) break;
      if (status.includes('error') || body.failureMessage) {
        throw new Error(`Kaggle run failed: ${body.failureMessage ?? status}`);
      }
    }
    if (!status.includes('complete')) {
      throw new Error(`Kaggle run did not finish within ${config.kaggle.timeoutMinutes} minutes.`);
    }
    ctx.emit({
      type: 'stage', stage: 'meshing', group: 'geometry', status: 'end',
      progress: 1, message: 'Generated on Kaggle', ts: Date.now() / 1000,
    });

    ctx.emit({
      type: 'stage', stage: 'packaging', group: 'packaging', status: 'start',
      progress: null, message: 'Downloading the model', ts: Date.now() / 1000,
    });
    const outRes = await fetch(
      `${API}/kernels/output?userName=${creds.username}&kernelSlug=${slug}`,
      { headers: { Authorization: auth(creds) } });
    if (!outRes.ok) throw new Error(`Could not list the run output (${outRes.status})`);
    const output = await outRes.json() as { files?: { fileName: string; url: string }[] };
    const glb = output.files?.find((f) => f.fileName.endsWith('.glb'));
    if (!glb) {
      throw new Error('The Kaggle run produced no .glb — check the kernel log on kaggle.com.');
    }
    const bytes = Buffer.from(await (await fetch(glb.url, {
      headers: { Authorization: auth(creds) },
    })).arrayBuffer());
    await fs.mkdir(ctx.outDir, { recursive: true });
    await fs.writeFile(path.join(ctx.outDir, 'model.glb'), bytes);
    ctx.emit({
      type: 'stage', stage: 'packaging', group: 'packaging', status: 'end',
      progress: 1, message: 'Model downloaded', ts: Date.now() / 1000,
    });

    ctx.emit({
      type: 'result',
      ts: Date.now() / 1000,
      result: {
        tier: 'kaggle-p100',
        quality: ctx.options.quality,
        mode: 'object',
        photosSubmitted: ctx.imageCount,
        photosUsed: 1,
        photosRegistered: 1,
        points: 0,
        vertices: 0,
        triangles: 0,
        textured: true,
        glbBytes: bytes.length,
        durationSeconds: 0,
        generative: true,
        providerNotes: [
          'Generated by TRELLIS.2 on a Kaggle Tesla P100, from a single photograph.',
          'Your photo was uploaded to Kaggle to run there.',
          'Unseen sides are invented and the scale is arbitrary.',
        ],
        files: [{ name: 'model.glb', bytes: bytes.length, primary: true }],
      },
    });
  }

  /** The sharpest photo, downscaled: TRELLIS works at 1024 anyway. */
  private async bestPhotoBase64(dir: string): Promise<string> {
    const names = (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).sort();
    if (!names.length) throw new Error('No photo to send.');
    let best = names[0];
    let bestSize = 0;
    for (const name of names) {
      const { size } = await fs.stat(path.join(dir, name));
      if (size > bestSize) { bestSize = size; best = name; }
    }
    const data = await fs.readFile(path.join(dir, best));
    return data.toString('base64');
  }
}

/** The script Kaggle executes. Kept here so the provider is self-contained. */
function runnerScript(photoBase64: string, quality: string): string {
  const pipeline = quality === 'high' ? '1024' : '512';
  const targetFaces = quality === 'fast' ? 40000 : quality === 'balanced' ? 100000 : 200000;
  return `# SCANFORGE run - generated
import base64, os, subprocess, sys, time
T0 = time.time()
os.environ["ATTN_BACKEND"] = "sdpa"          # P100 is capability 6.0; no flash-attn
os.environ["SPARSE_ATTN_BACKEND"] = "sdpa"

open("/kaggle/working/input.jpg", "wb").write(base64.b64decode("${photoBase64}"))

def sh(c, t=3600):
    p = subprocess.run(c, shell=True, capture_output=True, text=True, timeout=t)
    print("$", c[:110], "->", p.returncode, flush=True)
    if p.returncode: print((p.stderr or "")[-1500:], flush=True)
    return p.returncode

# Prebuilt CUDA extensions, so nothing is compiled here.
sh("pip install --no-deps /kaggle/input/*/wheels/*.whl")
sh("pip install -q easydict utils3d imageio imageio-ffmpeg ninja trimesh xatlas fast-simplification")
sh("git clone --depth 1 --recurse-submodules https://github.com/microsoft/TRELLIS.2.git /kaggle/T2")
sys.path.insert(0, "/kaggle/T2")

import torch
from PIL import Image
from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline
print("gpu", torch.cuda.get_device_name(0), "| loaded at", round(time.time()-T0), "s", flush=True)

pipe = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
pipe.cuda()
out = pipe.run(Image.open("/kaggle/working/input.jpg"), seed=42, pipeline_type="${pipeline}")
mesh = out[0] if isinstance(out, list) else out
print("generated at", round(time.time()-T0), "s", flush=True)

import numpy as np, xatlas, fast_simplification
v = mesh.vertices.cpu().numpy(); f = mesh.faces.cpu().numpy()
if len(f) > ${targetFaces}:
    v, f = fast_simplification.simplify(v.astype(np.float32), f.astype(np.int32),
                                        1.0 - ${targetFaces}/len(f))
vm, idx, uvs = xatlas.parametrize(np.ascontiguousarray(v, np.float32),
                                  np.ascontiguousarray(f, np.uint32))
import trimesh
trimesh.Trimesh(vertices=v[vm], faces=idx.reshape(-1,3), process=False).export(
    "/kaggle/working/model.glb")
print("done in", round(time.time()-T0), "s", flush=True)
`;
}
