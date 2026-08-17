/**
 * Generate on a free Kaggle GPU instead of this machine.
 *
 * Kaggle gives ~30 GPU-hours a week on a Tesla P100. CUDA has the optimised
 * sparse-convolution kernels that the Apple Silicon port has to emulate in pure
 * PyTorch, so a generation that takes ~13 minutes locally should take a few
 * minutes there, and it leaves this Mac free.
 *
 * Measured facts that shaped this (from scanforge-gpu-probe, run on Kaggle):
 *  - The free tier's default GPU is a P100 (capability 6.0) and the API cannot ask
 *    for anything else: there is no accelerator field, only enable_gpu, and the
 *    accelerator is a per-notebook UI setting that an API push resets. So the run
 *    must work on a P100.
 *  - Kaggle's own torch (2.10+cu128) supports sm_70 upward, so it cannot run on a
 *    P100 at all - even a plain conv2d fails. torch 2.6.0+cu124, which TRELLIS
 *    pins anyway, ships sm_50..sm_90 and works. The wheels are built against it.
 *  - flash-attn needs capability 7.5+, so the sdpa attention path is used.
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
import jpeg from 'jpeg-js';
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
    'Runs the generation on a free Kaggle GPU instead of this Mac, leaving your ' +
    'machine alone. Set that notebook\'s accelerator to T4 x2 once in Kaggle: the ' +
    'default P100 is too old for current PyTorch. Your photo is uploaded to Kaggle ' +
    'and it uses your weekly GPU quota.';
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
      details: {
        account: creds.username,
        wheels,
        notebook: `https://www.kaggle.com/code/${creds.username}/${config.kaggle.kernelSlug}`,
        note: 'set the notebook accelerator to T4 x2 (P100 is unsupported by current PyTorch)',
      },
    };
  }

  async run(ctx: RunContext): Promise<void> {
    const creds = await credentials();
    if (!creds) throw new Error('No Kaggle credentials in ~/.kaggle/kaggle.json');
    // One notebook, re-pushed per job, rather than one per job. The Kaggle API
    // cannot choose the accelerator - that is a per-notebook setting made in the
    // web UI - so a fresh notebook each time would always land on the default
    // P100, whose architecture current PyTorch no longer ships kernels for.
    const slug = config.kaggle.kernelSlug;
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
        // The API wants `slug`; `id` is a numeric kernel id and sending the
        // "user/name" string there fails with a confusing integer-conversion error.
        slug: `${creds.username}/${slug}`,
        newTitle: slug,
        // Accepted but ignored by the API as of 2026-08: the accelerator is a
        // per-notebook setting made in the web UI. Sent anyway in case that changes.
        accelerator: 'nvidiaTeslaT4x2',
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

  /**
   * The photo travels inside the kernel source, and Kaggle rejects a script much
   * over ~1 MB — a full-resolution photo base64s well past that. Downscale to
   * 1024 px, which is what TRELLIS resizes to anyway, so nothing is lost.
   *
   * Done with a pure-JS codec on purpose: this provider's whole point is working
   * on a machine with no local engine, so it cannot assume Python or Pillow.
   */
  private async bestPhotoBase64(dir: string): Promise<string> {
    const names = (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).sort();
    if (!names.length) throw new Error('No photo to send.');
    let best = names[0];
    let bestSize = 0;
    for (const name of names) {
      const { size } = await fs.stat(path.join(dir, name));
      if (size > bestSize) { bestSize = size; best = name; }
    }
    const raw = await fs.readFile(path.join(dir, best));

    if (!/\.jpe?g$/i.test(best)) {
      // Not a JPEG: send as-is if it fits, otherwise say so plainly.
      if (raw.length > 700_000) {
        throw new Error(`${best} is too large to send to Kaggle and is not a JPEG, `
          + 'so it cannot be resized here. Re-save it as a JPEG and try again.');
      }
      return raw.toString('base64');
    }

    try {
      const decoded = jpeg.decode(raw, { useTArray: true });
      const scale = Math.min(1, 1024 / Math.max(decoded.width, decoded.height));
      if (scale >= 1 && raw.length < 600_000) return raw.toString('base64');

      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const out = Buffer.alloc(width * height * 4);
      // Box filter: average the source pixels each destination pixel covers, which
      // keeps detail far better than dropping samples.
      const xStep = decoded.width / width;
      const yStep = decoded.height / height;
      for (let y = 0; y < height; y += 1) {
        const y0 = Math.floor(y * yStep);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yStep));
        for (let x = 0; x < width; x += 1) {
          const x0 = Math.floor(x * xStep);
          const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xStep));
          let r = 0, g = 0, b = 0, n = 0;
          for (let sy = y0; sy < y1; sy += 1) {
            for (let sx = x0; sx < x1; sx += 1) {
              const i = (sy * decoded.width + sx) * 4;
              r += decoded.data[i]; g += decoded.data[i + 1]; b += decoded.data[i + 2];
              n += 1;
            }
          }
          const o = (y * width + x) * 4;
          out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
        }
      }
      const encoded = jpeg.encode({ data: out, width, height }, 86);
      return Buffer.from(encoded.data).toString('base64');
    } catch (err) {
      throw new Error(`Could not prepare ${best} for upload: ${(err as Error).message}`);
    }
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

# Kaggle's default torch cannot run on the P100 this will land on; 2.6.0+cu124 can,
# and the prebuilt wheels are built against it, so the versions must match.
sh("pip install -q torch==2.6.0 torchvision==0.21.0 "
   "--index-url https://download.pytorch.org/whl/cu124", 2400)

# Prebuilt CUDA extensions, so nothing is compiled here. Found with a recursive
# glob rather than a shell one: the dataset may mount nested, and an unmatched
# shell glob passes the literal "*.whl" to pip, which fails obscurely.
import glob as _g
wheels = _g.glob("/kaggle/input/**/*.whl", recursive=True)
print("attached inputs:", os.listdir("/kaggle/input") if os.path.isdir("/kaggle/input") else "none",
      flush=True)
print("wheels found:", [w.split("/")[-1] for w in wheels], flush=True)
if wheels:
    sh("pip install --no-deps " + " ".join(wheels))
else:
    raise SystemExit(
        "No prebuilt CUDA wheels are attached to this notebook. Attach the "
        "scanforge-wheels dataset (Add Input) or run scripts/kaggle/build_wheels.sh.")
# Installed one at a time: a single unresolvable pin (utils3d) otherwise aborts the
# whole line and takes trimesh with it, which then fails much later and obscurely.
# plyfile is imported by the shape decoder; einops/timm by the background
# remover's remote code. Missing either surfaces as an unrelated 401 later.
for pkg in ["easydict", "imageio", "imageio-ffmpeg", "ninja", "trimesh",
            "xatlas", "fast-simplification", "opencv-python-headless",
            "plyfile", "einops", "timm", "kornia"]:
    sh(f"pip install -q {pkg}")
# The exact utils3d commit TRELLIS pins; the PyPI releases conflict with Kaggle's stack.
sh("pip install -q --no-deps git+https://github.com/EasternJournalist/utils3d.git"
   "@9a4eb15e4021b67b12c460c7057d642626897ec8")
sh("git clone --depth 1 --recurse-submodules https://github.com/microsoft/TRELLIS.2.git /kaggle/T2")

# TRELLIS's loader tries "<path>/<value>" first and silently falls back to treating
# the value as a Hub reference. That fallback is load-bearing - one checkpoint lives
# in a different repository (microsoft/TRELLIS-image-large) - but it also hides the
# real reason a local checkpoint failed behind a confusing 401. Keep the fallback,
# report the primary error.
base_py = "/kaggle/T2/trellis2/pipelines/base.py"
src_txt = open(base_py).read()
src_txt = src_txt.replace(
    "            except Exception as e:\n                _models[k] = models.from_pretrained(v)",
    "            except Exception as e:\n                print('local load failed for', k, '->', repr(e)[:300], flush=True)\n                _models[k] = models.from_pretrained(v)")
open(base_py, "w").write(src_txt)

# Same half-precision fix the desktop installer applies: the pipeline runs in fp16
# but the matting model builds a float32 tensor, so it dies with
# "Input type (float) and bias type (c10::Half) should be the same".
rembg_py = "/kaggle/T2/trellis2/pipelines/rembg/BiRefNet.py"
rt = open(rembg_py).read()
before = rt
# Upstream has used both .to("cuda") and .to(self.device); handle either.
for old_call, new_call in [
    ('.unsqueeze(0).to("cuda")', '.unsqueeze(0).to("cuda", _dt)'),
    ('.unsqueeze(0).to(self.device)', '.unsqueeze(0).to(self.device, _dt)'),
]:
    line = "        input_images = self.transform_image(image)" + old_call
    if line in rt:
        rt = rt.replace(line,
                        "        _dt = next(self.model.parameters()).dtype\n"
                        "        input_images = self.transform_image(image)" + new_call)
rt = rt.replace("preds = self.model(input_images)[-1].sigmoid().cpu()",
                "preds = self.model(input_images)[-1].sigmoid().float().cpu()")
if rt == before:
    raise SystemExit("dtype patch did not apply - upstream BiRefNet.py changed shape")
open(rembg_py, "w").write(rt)
print("applied the half-precision fix to the background remover", flush=True)

sys.path.insert(0, "/kaggle/T2")

import torch
from PIL import Image
from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline
print("gpu", torch.cuda.get_device_name(0), "| loaded at", round(time.time()-T0), "s", flush=True)

# Load from the downloaded directory, not the repo id: the pipeline resolves its
# sub-checkpoints ("ckpts/...") relative to what it was given, and a repo id makes
# it ask the Hub for a repository called "ckpts/...".
from huggingface_hub import snapshot_download
local_model = snapshot_download("microsoft/TRELLIS.2-4B", max_workers=8)
# One checkpoint is referenced across repositories; fetch just that subfolder so the
# loader's Hub fallback resolves quickly instead of pulling a whole second model.
snapshot_download("microsoft/TRELLIS-image-large", max_workers=8,
                  allow_patterns=["ckpts/ss_dec_conv3d_16l8_fp16*"])

# The pipeline config names two gated repositories (Meta's DINOv3, BRIA's RMBG-2.0).
# There are no Hugging Face credentials in a Kaggle kernel, so point them at the
# ungated equivalents - the same substitution the desktop installer makes.
import glob as _glob
for cfg in _glob.glob(local_model + "/*.json"):
    txt = open(cfg).read()
    fixed = (txt.replace("facebook/dinov3-vitl16-pretrain-lvd1689m",
                         "camenduru/dinov3-vitl16-pretrain-lvd1689m")
                .replace("briaai/RMBG-2.0", "ZhengPeng7/BiRefNet"))
    if fixed != txt:
        open(cfg, "w").write(fixed)
        print("repointed", cfg.split("/")[-1], "at ungated model sources", flush=True)
print("weights at", local_model, "|", round(time.time()-T0), "s", flush=True)
pipe = Trellis2ImageTo3DPipeline.from_pretrained(local_model)
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
