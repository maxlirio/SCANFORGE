# SCANFORGE

A macOS app. Drop a photo of an object into it and get back a textured, game-ready
3D model, generated on your own GPU.

No account, no API key, no per-model cost, and no photo leaves the machine.
Microsoft's [TRELLIS.2](https://github.com/microsoft/TRELLIS) (MIT) runs locally on
Apple Silicon via Metal.

```
photo.jpg  ──▶  SCANFORGE.app  ──▶  model.glb (≈100k triangles, 2048² texture)
                     │
                     └── TRELLIS.2 on this machine's GPU, ~10–15 min
```

It **generates** geometry rather than measuring it: one photo tells it what the
object looks like, and it infers the rest from learned priors. That is why it
handles plain, untextured things — a white cube comes out as a clean white cube —
and also why the sides your photo never showed are invention, and the scale is
arbitrary. A photogrammetry engine is included for when you need real measurements
instead (see *Engines* below).

---

## Install

**1. The app**

```bash
npm install
npm run desktop:app          # builds build/app/SCANFORGE-darwin-arm64/SCANFORGE.app
cp -R build/app/SCANFORGE-darwin-arm64/SCANFORGE.app /Applications/
```

Open it once from Applications, then right-click its dock icon → *Options* →
*Keep in Dock*.

**2. The 3D engine** (once, ~16 GB of model weights)

TRELLIS is not bundled — it is large and updates independently. Follow
[docs/TRELLIS_LOCAL.md](docs/TRELLIS_LOCAL.md); it takes about fifteen minutes and
ends with the app reporting a green *TRELLIS.2 on this machine's GPU*.

Requirements: Apple Silicon, macOS 14+, ~20 GB free disk, Python 3.11. Verified on
an M4 / 16 GB / macOS 26.3.

---

## Using it

- **Drop a photo** on the window, or on the dock icon, or ⌘O, or
  `open -a SCANFORGE photo.jpg`.
- Pick **Detail** (fast ≈10 min / balanced ≈15 min / high, longer).
- **Generate**. Live GPU progress shows while it works; you can leave it running.
- Rotate, zoom, toggle wireframe and lighting in the viewer, then **download**
  GLB / PLY / the texture.

Scripted use: `SCANFORGE.app/Contents/MacOS/SCANFORGE photo.jpg --generate`.

Finished models live in `~/Library/Application Support/SCANFORGE/scans`
(*SCANFORGE → Open Scans Folder*).

### What makes a good photo

One object, filling most of the frame, in even light, against a background it
stands out from. Several objects at once will come back as one confused object.

---

## Engines

Reconstruction sits behind one narrow interface
(`apps/server/src/providers/types.ts`), so it can be swapped without touching the
UI, the job queue or the viewer.

| Engine | What it does | Needs |
|---|---|---|
| **`trellis-local`** (default) | TRELLIS.2 on this machine's GPU. One photo → clean game-ready mesh. Generative. | Apple Silicon + the weights |
| `colmap-local` | Real photogrammetry: measures your actual object from 8+ overlapping photos. Coarse without CUDA, and blind to untextured surfaces. | `brew install colmap` |
| `replicate` | Hosted GPU, for machines with no usable GPU. Costs per model. **Untested** — needs an account. | `REPLICATE_API_TOKEN` |

The app picks whichever is actually available, preferring the GPU one. Check with:

```bash
npm run doctor
```

---

## Architecture

```
apps/desktop    Electron shell: window, dock, drag-and-drop, starts the engine
apps/server     Fastify API on 127.0.0.1 — jobs, queue, storage, progress stream
apps/web        React + three.js — drop zone, progress, 3D viewer
pipeline/       Python: TRELLIS runner, texture baker, COLMAP photogrammetry
packages/shared TypeScript contracts shared by all of them
```

The window loads the local server rather than `file://`, so uploads, the progress
stream and the viewer are all same-origin. The server binds `127.0.0.1` on a port
chosen at launch and is never exposed to the network.

Progress is never invented: a stage shows a percentage only when the underlying
tool reports a real counter, and an indeterminate indicator otherwise.

---

## Development

```bash
npm install
npm run build
npm run desktop      # runs the app from source
npm run doctor       # what this machine can actually do
```

Useful checks:

```bash
scripts/e2e_test.sh <image-dir> balanced object   # drive the API directly
scripts/inspect_glb.py model.glb --render out.png # validate + render a GLB headlessly
```

`docs/` covers the TRELLIS install and its traps, and the optional AGPL dense
photogrammetry tier. `DECISION.md` records why this technology and this
architecture, including what was rejected.

The container image (`Dockerfile`) and the CPU photogrammetry pipeline are still
here and still work — they were the earlier server-hosted incarnation of this
project, and they remain the answer for measuring real objects on a machine
without an Apple GPU.

---

## Limitations

- **~10–15 minutes per model** on an M4. A CUDA GPU does this in seconds; that is
  the price of not renting one.
- **Generated, not measured.** Unseen sides are invented and the scale is
  arbitrary. Use the photogrammetry engine if that matters.
- **One object per photo.**
- The app is **unsigned**, so the first launch needs right-click → *Open*.
- TRELLIS's own texture baker is broken on Apple Silicon without full Xcode;
  SCANFORGE ships a corrected one (`pipeline/scanforge/trellis_bake.py`), and
  [docs/TRELLIS_LOCAL.md](docs/TRELLIS_LOCAL.md) explains why.

## Licences

| Component | Licence |
|---|---|
| SCANFORGE | MIT |
| TRELLIS.2 (Microsoft) | MIT |
| DINOv3 weights (Meta) | Meta DINOv3 licence, gated |
| RMBG-2.0 (BRIA) | non-commercial without a licence |
| COLMAP | BSD-3-Clause |
| Electron, React, three.js, Fastify | MIT |

DINOv3 and RMBG-2.0 are downloaded by the TRELLIS installer, not redistributed
here. RMBG-2.0's terms are the one thing to check before commercial use.
