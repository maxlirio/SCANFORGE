# SCANFORGE

Turn photographs of a real object into a textured 3D model, from your phone.

Open the site on a phone or iPad, press **Start scan**, walk around an object taking
photos (or upload photos you already have), and it reconstructs a textured mesh you
can rotate, inspect and download as GLB / OBJ / PLY. It installs to the home screen
and runs full-screen like an app.

Reconstruction runs on a hosted server, not on your device and not on a laptop —
it is minutes of multi-core CPU work that no phone browser can do. One container
serves the website and does the reconstruction: see **Deploying** below.

The reconstruction is real photogrammetry — [COLMAP](https://colmap.github.io/)
solving where each photograph was taken from, building a surface from the points it
triangulates, and projecting your actual photographs onto it as a texture atlas.
Nothing is faked, substituted or pre-baked. If your photos can't be reconstructed,
the app says so instead of showing you a model.

Read [DECISION.md](DECISION.md) for why this technology and this architecture.

---

## Architecture

```
apps/web        React + TypeScript + three.js
                camera capture, quality checks, coverage tracking, 3D viewer
                        │  REST + Server-Sent Events
apps/server     Fastify + TypeScript
                jobs, queue, storage seam, provider seam
                        │  child process, newline-delimited JSON events
pipeline/       Python + COLMAP
                prepare → SfM → filter/crop → mesh → texture → GLB/OBJ/PLY
packages/shared TypeScript types shared by all three
```

Four seams, kept deliberately narrow:

| Seam | File | Swap it for |
|---|---|---|
| Reconstruction provider | `apps/server/src/providers/types.ts` | a CUDA box, a hosted GPU, next year's model |
| Storage | `apps/server/src/storage.ts` | S3/GCS instead of local disk |
| Progress events | `packages/shared/src/index.ts` | any provider that can report stages |
| Pipeline CLI | `pipeline/scanforge/run.py` | a different photogrammetry stack |

Two providers ship:

- **`colmap-local`** (default) — real photogrammetry, runs on this machine, no API
  key, nothing leaves your network. **Tested end to end.**
- **`replicate`** (optional) — hosted GPU running TRELLIS (MIT model) for people
  with no GPU. It *generates* geometry rather than measuring it, and the UI labels
  any such result. **Implemented against Replicate's documented API but never
  executed here** — that needs a funded account. Treat it as unverified.

---

## Deploying (so a phone can actually use it)

One image serves the site and reconstructs. It needs ~2 GB RAM and no GPU.

```bash
docker build -t scanforge .
docker run -p 7860:7860 -v scanforge-data:/data scanforge
```

**Free, no card — Hugging Face Spaces** (2 vCPU, 16 GB, public HTTPS URL):

```bash
pip install -U huggingface_hub
hf auth login
scripts/deploy_space.sh scanforge
```

Then open `https://<user>-scanforge.hf.space` on your phone and add it to your home
screen. The Space builds from this GitHub repo, so a rebuild picks up new commits.
Storage there is ephemeral — download your model when the scan finishes.

Anywhere else that runs a container (Fly.io, Railway, a VPS) works the same way;
set `PORT` and mount a volume at `/data` if you want scans to survive restarts.
Render's free tier has 512 MB of RAM, which is not enough for COLMAP.

---

## Running it locally

### 1. Requirements

| | |
|---|---|
| Node | 20+ (developed on 24) |
| Python | 3.10+ (3.11 used here) |
| COLMAP | 4.1+ — `brew install colmap` / `apt install colmap` |
| GPU | **not required**; CUDA is used automatically if present |
| API keys | **none** for the default provider |
| Model downloads | **none** for the default provider |

Disk: each scan keeps its uploads plus ~10–50 MB of outputs under `data/`.

### 2. Install

```bash
npm install
npm run setup:pipeline     # creates pipeline/.venv and checks COLMAP
npm run doctor             # prints exactly what this machine can do
```

`npm run doctor` is the source of truth. On this Mac it reports:

```
✅ colmap-local — COLMAP photogrammetry (local)
   colmapVersion: "4.1.1"   cuda: false   tier: "sparse"
```

### 3. Run

```bash
npm run dev          # web on https://localhost:5173, API on http://localhost:5174
```

or as a single process:

```bash
npm run build && npm start          # everything on http://localhost:5174
```

### 4. Scanning from your phone

`getUserMedia` only works over HTTPS or on `localhost`, so the dev server serves
HTTPS with a self-signed certificate. On your phone, open
`https://<your-laptop-ip>:5173` and accept the certificate warning once.

```bash
ipconfig getifaddr en0      # your LAN address
```

Set `SCANFORGE_HTTPS=0` if you only ever use `localhost`.

---

## How to capture

The reconstruction is only as good as the photographs.

- **25–60 photos**, moving roughly 15° between shots, all the way around.
- **Keep the object in frame** and let it fill a good part of it.
- **Move yourself, not the object.** Photogrammetry solves one rigid world; if the
  object turns relative to its surroundings, the solve fails.
- **Even, diffuse light.** Overcast outdoors or a bright room. Avoid hard shadows
  that move with you.
- **Do a second pass** from higher up and lower down for the top and underside.
- **Texture is what gets tracked.** Bark, fabric, print and stone reconstruct well;
  plain white, glossy, chrome and glass do not — that is physics, not a bug.
- A cluttered, textured background *helps* the solve. Object mode crops it away
  afterwards.

The capture screen measures sharpness, brightness and motion from the live frames
and warns you in real time. On phones it also tracks which compass sectors you have
photographed. On a laptop with no orientation sensors it says so and counts photos
instead of drawing a coverage dial that would mean nothing.

---

## Testing it without a camera

```bash
scripts/fetch_testsets.sh monstree          # 41 real iPhone photos of a tree trunk
npm start &
scripts/e2e_test.sh data/testsets/monstree/images balanced object
```

`e2e_test.sh` drives the real HTTP API: create job → upload → start → poll → download
the GLB → validate it with `scripts/inspect_glb.py` (which checks the container,
every accessor's byte range, the index buffer, UVs, and can render the result
headlessly for a visual check).

---

## What the outputs are

| File | What it is |
|---|---|
| `model.glb` | Geometry + UVs + texture in one file. Load this anywhere. |
| `model.obj` + `model.mtl` + `texture.jpg` | Same model as OBJ. All three files must stay together. |
| `model.ply` | Mesh geometry only, no texture. |
| `points.ply` | The sparse point cloud the mesh was built from. |
| `points_dense.ply` | Dense cloud — only on the CUDA or OpenMVS tiers. |
| `thumbnail.jpg` | Preview, rendered from the exported geometry by the pipeline. |
| `result.json` | Everything measurable about the run. |

Models are exported **+Y up**, centred on the object, and normalised so the longest
side is 1.0. Photogrammetry has no absolute scale — a 1.0 model is not one metre.

---

## Configuration

Copy `.env.example` to `.env`. Notable values:

| Variable | Default | Why you'd change it |
|---|---|---|
| `SCANFORGE_PROVIDER` | `colmap-local` | point at the hosted GPU provider |
| `SCANFORGE_CONCURRENCY` | `1` | more cores than one scan can use |
| `SCANFORGE_DATA_DIR` | `./data` | put scans on a bigger disk |
| `COLMAP_BIN` | auto | COLMAP not on `PATH` |
| `OPENMVS_BIN_DIR` | auto | enable the dense tier — see [docs/OPENMVS.md](docs/OPENMVS.md) |
| `REPLICATE_API_TOKEN` | unset | enable the hosted GPU provider |

---

## Limitations

Stated plainly, because they are real:

- **No CUDA here means no dense stereo.** Geometry comes from the sparse point
  cloud, so it is coarse and faceted; detail lives in the texture rather than the
  mesh. The upgrade paths are documented, not hidden.
- **Shiny, transparent and untextured objects fail.** Inherent to photogrammetry.
- **Minutes, not seconds.** ~40 s for 50 photos at `fast`, ~2 min at `balanced`,
  considerably longer at `high` on CPU.
- **The up axis is inferred** from the camera path. Orbit captures get it right;
  erratic ones may come out tilted, and the pipeline warns when it is unsure.
- **Object isolation is a heuristic** (track-length-weighted core of the point
  cloud). It can crop too much or too little; `scene` mode disables it.
- **The Replicate provider is untested** (no account). See above.

---

## Licences

| Component | Licence |
|---|---|
| SCANFORGE | MIT |
| COLMAP 4.1 | BSD-3-Clause |
| three.js, React, Vite, Fastify | MIT |
| numpy, Pillow | BSD-3 / MIT-CMU |
| OpenMVS (optional, not bundled) | **AGPL-3.0** — read [docs/OPENMVS.md](docs/OPENMVS.md) |
| TRELLIS (optional, via Replicate) | MIT |

No non-commercially-licensed model weights are used anywhere in the default path.
Test photo sets are downloaded by script, never vendored; `monstree` and `buddha`
belong to AliceVision (buddha is CC-BY-4.0), `fox` to NVlabs/instant-ngp.

---

## The published page (GitHub Pages)

`.github/workflows/pages.yml` publishes the **frontend** to GitHub Pages on every
push to `main`.

**What works there:** the landing page, the camera capture screen (Pages is HTTPS,
so `getUserMedia` is allowed), the 3D viewer, and one bundled **real** example
model reconstructed by this pipeline.

**What cannot work there:** the reconstruction itself. Pages serves static files;
it cannot run Node, Python or COLMAP. To scan from the published page you must run
a SCANFORGE server yourself and point the page at it:

1. `npm start` on your machine.
2. Expose it over **HTTPS** — an https page is not allowed to call an http backend.
   A tunnel is the easy way: `cloudflared tunnel --url http://localhost:5174`.
3. Paste that address into **Reconstruction server** on the published page, or
   open `…/#/?api=https://your-tunnel-url`. It is remembered in `localStorage`.

The page states all of this itself rather than looking broken.

To publish under a different repository name, change `SCANFORGE_BASE` in the
`build:pages` script — GitHub Pages serves project sites from `/<repo>/`.
