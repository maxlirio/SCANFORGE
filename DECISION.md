# Technical decision: which 3D reconstruction technology, and where does it run?

_Written 2026-08-13, before implementation. Measured numbers in this document come from
probes run on the target machine (Apple M4, 16 GB, macOS 26.3) — see `scripts/validate_colmap_cpu.sh`._

## 1. The constraint that decides almost everything

The machine this has to run on:

| | |
|---|---|
| CPU/GPU | Apple M4 (10-core), Metal — **no NVIDIA GPU, no CUDA** |
| RAM | 16 GB unified |
| Docker | not installed |
| Python | 3.9 (system), 3.11 (Homebrew) |

Every serious open-source reconstruction stack — COLMAP dense stereo, Meshroom/AliceVision,
3D Gaussian Splatting, TRELLIS, Hunyuan3D — assumes CUDA. So the real question is not
"which algorithm is best in the abstract" but **"which real reconstruction can actually run,
today, on this hardware, without faking anything"** — while keeping the door open for a GPU box
or a hosted GPU later.

## 2. Options surveyed

### A. Classical photogrammetry (SfM + MVS)

| Tool | License | Runs here? | Notes |
|---|---|---|---|
| **COLMAP 4.1.1** | BSD-3-Clause | **Yes** (Homebrew bottle, arm64) | SfM on CPU. 4.x also ships CPU meshing (`delaunay_mesher`, `advancing_front_mesher`, `poisson_mesher`) and **CPU texture-atlas generation (`mesh_texturer`)**. Only `patch_match_stereo` (dense depth maps) needs CUDA. |
| OpenMVS | **AGPL-3.0** | Source build only (no bottle, no conda-forge for osx-arm64) | Best CPU densifier + texturer. AGPL is viral over a network service, which is exactly what this app is. |
| Meshroom / AliceVision | MPL-2.0 | No | Depth maps require CUDA. |
| RealityCapture / Metashape | commercial | n/a | Closed, licensed, not integrable as an open pipeline. |

The decisive discovery: **COLMAP 4.1 alone can go photos → posed cameras → mesh → *textured* mesh
entirely on CPU.** That was not true of COLMAP 3.x, where meshing meant CUDA dense stereo first.
It also now ships ALIKED + LightGlue deep features/matcher running through ONNX Runtime on CPU,
which is far more robust on casual phone captures than SIFT.

### B. NeRF / Gaussian splatting

| Tool | License | Runs here? |
|---|---|---|
| INRIA 3DGS | **research/non-commercial** | No (CUDA rasterizer) |
| gsplat (Nerfstudio) | Apache-2.0 | No (CUDA rasterizer) |
| SuGaR / 2DGS (splat → mesh) | mixed, mostly non-commercial | No |

Splatting also produces a *radiance field*, not a mesh. Getting a watertight, textured, downloadable
GLB out of it needs a second non-trivial stage (SuGaR/Frosting), which is itself CUDA-only and
mostly non-commercially licensed. It also still needs COLMAP poses first. Rejected: strictly more
infrastructure than photogrammetry for an output shape that is *worse* for "download a model".

### C. Feed-forward AI image-to-3D

| Model | License | VRAM | Runs here? |
|---|---|---|---|
| TRELLIS / TRELLIS 2 (Microsoft) | **MIT** | ~16 GB CUDA | No locally; yes hosted |
| Hunyuan3D 2.1 (Tencent) | community licence w/ territorial + MAU restrictions | ~24 GB | No |
| TripoSR / InstantMesh | MIT / Apache-2.0 | ~8 GB | No (CUDA kernels) |
| Stable Fast 3D | Stability community (non-commercial) | ~7 GB | No |

These are genuinely excellent and *robust* — they hallucinate a plausible back side from few views,
so a sloppy capture still yields a clean asset. But they need an NVIDIA GPU, and they are
**generative, not metric**: the model is a plausible object, not a measurement of the user's object.

### D. Hosted GPU APIs

Replicate / fal (host the MIT-licensed TRELLIS), Tripo, Meshy, Luma. Real REST APIs, pay-per-use,
no local GPU. All require an account and an API key, and send the user's photos to a third party.

## 3. Where should reconstruction run?

> **Requirement change (2026-08-14):** this has to be a website you open on any
> phone or iPad, with no laptop running. That does not change *which* technology
> reconstructs — it changes *where the server lives*: a hosted container instead
> of a developer machine. The browser still cannot do the reconstruction (see
> below), so "no backend at all" was never on the table; the honest options were
> "a backend someone hosts" or "a third-party GPU API". See §7.

**Not in the browser.** SfM/MVS is hours of CPU work with multi-GB working sets; WebAssembly ports of
COLMAP-class SfM don't exist at usable quality, and WebGPU can't reach the CUDA kernels the AI models
are compiled against. A browser tab also can't survive being backgrounded on a phone mid-scan.
The browser's job is what it is genuinely best at: **camera capture, real-time capture-quality
feedback, and WebGL viewing.**

**Local backend, with a swappable remote.** The reconstruction runs as a server-side job. Because
the reconstruction technology is the part most likely to be replaced (a CUDA box, a hosted API, next
year's model), it sits behind a narrow `ReconstructionProvider` interface, and the backend never
assumes which one is in use.

## 4. Decision

```
 Browser (TypeScript/React/three.js)      Node API (TypeScript/Fastify)        Pipeline
 ─────────────────────────────────       ────────────────────────────────    ─────────────────
 capture + quality gating + viewer  ───►  jobs, storage, SSE progress   ───►  provider (swappable)
                                                                              ├─ colmap-local  ← default
                                                                              └─ replicate     ← optional
```

**Default provider: local COLMAP 4.1 photogrammetry, CPU-only, BSD-3-Clause, zero API keys.**

```
images → feature_extractor → exhaustive/sequential_matcher → mapper (SfM)
       → image_undistorter → [patch_match_stereo + stereo_fusion  ← only if CUDA]
       → delaunay_mesher   → mesh_texturer → PLY + texture atlas → GLB / OBJ / PLY
```

Why this one:

1. **It is a real measurement of the user's actual object**, from the user's actual photos. No
   generative substitution, no pre-made asset.
2. **It runs on the target machine today** with no GPU, no Docker, no model weights, no key.
3. **BSD-3-Clause throughout.** No AGPL contamination of a network service, no non-commercial weights.
4. **It degrades and upgrades along one axis.** Same code path gains CUDA dense stereo automatically
   if `colmap` reports CUDA support — the pipeline probes for it rather than assuming.

**Optional provider: Replicate (TRELLIS, MIT model on hosted GPU).** For users with no GPU who want
the generative-quality result, or few photos. Off unless `REPLICATE_API_TOKEN` is set. This exists to
prove the provider seam is real, not to be the default — it sends photos to a third party and it
invents geometry it did not observe.

**Rejected for the default:** OpenMVS (AGPL over a network service — but supported as an optional
tier if the operator installs it, see `docs/OPENMVS.md`), Gaussian splatting (CUDA + wrong output
type + licensing), local AI image-to-3D (no CUDA).

## 5. What this costs us — stated up front

Without CUDA there are **no dense depth maps**. The mesh is built from the SfM point cloud via
Delaunay meshing with visibility filtering, then textured with real photo data. That means:

- Geometry is **coarser** than a CUDA dense reconstruction. Fine detail lives in the texture, not the mesh.
- Texture-poor objects (plain white mug, glossy phone, glass) will reconstruct badly or not at all —
  this is inherent to photogrammetry, not to this implementation, and the capture UI warns about it.
- Reconstruction takes **minutes, not seconds**, on CPU. The UI reports real stage progress parsed
  from COLMAP's own output rather than inventing a percentage.

The honest upgrade path is documented, not hidden: point `SCANFORGE_PROVIDER` at a CUDA machine or a
hosted GPU and the same frontend gets dense-stereo or AI-grade results with no frontend changes.

## 6. Licences of everything integrated

| Component | Licence | Obligation |
|---|---|---|
| COLMAP 4.1.1 | BSD-3-Clause | attribution |
| ALIKED / LightGlue ONNX weights (COLMAP release) | Apache-2.0 (upstream ALIKED/LightGlue) | attribution; downloaded on first use |
| three.js | MIT | attribution |
| React, Vite, Fastify, trimesh, Pillow, numpy | MIT / BSD | attribution |
| TRELLIS (optional, via Replicate) | MIT | attribution; third-party service |
| OpenMVS (optional, operator-installed) | **AGPL-3.0** | if enabled and offered over a network, source-disclosure obligations attach — kept out of the default build for this reason |

No non-commercially-licensed model weights are used anywhere in the default path.

## 7. Hosting: making it a website, not a local tool

A phone-only, backend-free version does not exist. Structure-from-motion needs
minutes of multi-core CPU and gigabytes of working set; WebAssembly SfM ports are
toy-grade; and iOS Safari exposes no WebXR/ARKit poses to fall back on. Feed-forward
image-to-3D networks are ~1B parameters — far past what a phone browser can hold.
So the reconstruction runs in a hosted container, and the phone is a camera and a
viewer.

The container is the deliverable: `Dockerfile` builds one image that serves the
website *and* runs COLMAP, on one origin (no CORS, no mixed-content). COLMAP 4.1
comes from conda-forge, which publishes a Linux build — distro packages are still
on 3.x and lack the CPU meshing and texturing this design depends on.

Free always-on hosting with enough CPU for photogrammetry has essentially
disappeared. Checked 2026-08-14, by trying to deploy rather than by reading
marketing pages:

| Host | Cost | Fit |
|---|---|---|
| Hugging Face Spaces | **$9/mo (PRO)** | Docker and Gradio Spaces on cpu-basic now require PRO — the API returns `402 Payment Required`. Only *static* Spaces are free, which cannot run COLMAP. |
| Render free | free, no card | 512 MB RAM and **0.1 vCPU** — a scan that takes 2 minutes here would take most of an hour, if it didn't run out of memory first |
| Koyeb free | free, no card | 512 MB RAM, one service. Same memory problem. |
| Fly.io | ~$2–5/mo | free tier retired in 2024; a 1 GB machine is cheap and always on |
| **A small VPS** (Hetzner, DigitalOcean) | **~$5/mo** | 2 vCPU / 4 GB, always on, persistent disk. **Best value for a permanent site.** |
| **GitHub Codespaces** | free (120 core-hours/mo) | 2 vCPU / 8 GB — by far the best *free* compute, and needs no new account. But it is a session, not a site: 30-minute idle timeout (raisable to 4 h) and a new URL each time. |
| Google Cloud Run | free tier, card required | scales to zero, but its filesystem is RAM-backed, which fights a pipeline that writes hundreds of MB of scratch |
| Hosted GPU API (Tripo/Meshy/Replicate) | per scan | seconds instead of minutes, but it *generates* geometry rather than measuring yours |

The workload is the thing that rules the free tiers out: photogrammetry wants
~1–2 GB of RAM and real cores for a few minutes. 512 MB at 0.1 vCPU is not a
smaller version of that, it is a different thing that fails.

GitHub Pages keeps serving the frontend as a mirror, pointed at whichever backend
is deployed. It cannot host the backend itself — it serves static files only.
