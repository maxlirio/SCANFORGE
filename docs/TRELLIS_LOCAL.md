# TRELLIS.2 on your own Apple Silicon GPU

Single photo in, clean textured game-ready mesh out, generated locally on Metal.
No GPU rental, no per-scan cost, no photo leaves the machine.

Verified on an **M4 / 16 GB / macOS 26.3** on 2026-08-14.

| | |
|---|---|
| Time per model | ~7 min (512 pipeline), ~13 min including texture |
| Peak memory | fits in 16 GB (the port's README says 24 GB "recommended") |
| Disk | ~16 GB of weights |
| Output | ~111k triangles, 2048² texture, GLB + OBJ |

## Install

```bash
git clone https://github.com/shivampkumar/trellis-mac ~/.scanforge/trellis-mac
cd ~/.scanforge/trellis-mac
python3.11 -m venv .venv          # 3.11, NOT newer - some deps have no 3.14 wheels
bash setup.sh
./.venv/bin/pip install einops timm kornia   # BiRefNet's remote code needs these
```

Then log in to Hugging Face (`hf auth login`, a **read** token is enough) and accept:

- https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m — Meta, **manual approval**
- https://huggingface.co/briaai/RMBG-2.0 — instant

`microsoft/TRELLIS.2-4B` itself is open and needs no account.

### If Meta's approval has not come through

```bash
python scripts/trellis_dinov3_source.py --mirror     # ungated equivalents
python scripts/trellis_dinov3_source.py --official   # switch back once approved
```

Note the port's README points at `dinov3-vitl**14**`, which does not exist; the
repo it actually loads is `vitl**16**`.

## The texture baker has to be replaced

The port bakes textures with a Metal component (`o_voxel`) that needs a real
`metal` compiler — i.e. **full Xcode**, not Command Line Tools. Without it, it
falls back to a KDTree baker that produces coloured confetti.

The fallback looks up voxel colours **per texel**. TRELLIS meshes are dense
enough that the median UV triangle covers under two texels at 1024², so
rendering samples texels belonging to unrelated charts. Measured on a real run
(mean colour difference across mesh edges, 0-255; random pairs ≈ 51 for scale):

| Method | Edge difference |
|---|---|
| Port's per-texel voxel lookup | **58.6** (≈ random: broken) |
| Per-vertex voxel lookup | **4.9** (smooth) |

`pipeline/scanforge/trellis_bake.py` bakes per-*vertex* and interpolates across
UV triangles, which is smooth by construction. It also decimates to game density
(~100k triangles) first, so each triangle gets enough texels to survive filtering.

## Gotchas that cost real time here

- **`python3 -m venv` picked Python 3.14** on this machine and pulled wheels that
  do not match the port's expectations. Pin 3.11.
- **Dtype**: the port runs in half precision but the matting model builds a
  float32 tensor — `scripts/trellis_patch_rembg_dtype.py` fixes the crash.
- **UV origin**: TRELLIS/xatlas UVs are glTF-style (v=0 at the top). SCANFORGE's
  own COLMAP path uses OpenGL-style (v=0 at the bottom). Mixing them up produces
  a convincing-looking speckle that is easy to mistake for a broken bake.
