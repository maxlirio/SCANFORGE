"""Generate a 3D model from one photograph with TRELLIS.2, on this machine's GPU.

Runs inside the trellis-mac virtualenv (it needs torch/MPS), not the SCANFORGE
pipeline venv:

    ~/.scanforge/trellis-mac/.venv/bin/python -m scanforge.trellis_run \
        --images IN --out OUT --trellis-root ~/.scanforge/trellis-mac

Speaks the same newline-delimited JSON event protocol as the photogrammetry
pipeline, so the server and the browser cannot tell which one ran.

Unlike photogrammetry this *generates* geometry: it needs one good photograph and
infers the rest of the object from learned priors. Everything it produces about
the unseen sides is invention, and the result says so.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

# These must be set before torch is imported anywhere, including transitively.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("ATTN_BACKEND", "sdpa")
os.environ.setdefault("SPARSE_ATTN_BACKEND", "sdpa")

from . import events  # noqa: E402
from .trellis_bake import bake_atlas, vertex_colors_from_voxels  # noqa: E402


def _add_trellis_to_path(root: str) -> None:
    sys.path.insert(0, os.path.join(root, "TRELLIS.2"))
    sys.path.append(os.path.join(root, "stubs"))
    sys.path.append(root)  # for backends/
    try:
        import flex_gemm  # noqa: F401
        os.environ.setdefault("SPARSE_CONV_BACKEND", "flex_gemm")
    except Exception:
        os.environ.setdefault("SPARSE_CONV_BACKEND", "none")


def pick_best_photo(images_dir: str) -> tuple[str, dict]:
    """Choose the sharpest, sanely-exposed photo. One good frame is all it uses."""
    import numpy as np
    from PIL import Image, ImageOps

    valid = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    names = sorted(n for n in os.listdir(images_dir)
                   if os.path.splitext(n)[1].lower() in valid and not n.startswith("."))
    if not names:
        raise RuntimeError("No usable photographs were uploaded.")

    best, best_score, reports = None, -1.0, []
    for name in names:
        path = os.path.join(images_dir, name)
        try:
            img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        except Exception:
            continue
        probe = np.asarray(img.convert("L").resize((512, max(1, round(512 * img.height / img.width)))),
                           dtype=np.float32)
        lap = (probe[:-2, 1:-1] + probe[2:, 1:-1] + probe[1:-1, :-2]
               + probe[1:-1, 2:] - 4.0 * probe[1:-1, 1:-1])
        sharpness = float(lap.var())
        brightness = float(probe.mean())
        # Penalise photos that are very dark or blown out; sharpness decides the rest.
        penalty = 1.0 if 40 <= brightness <= 225 else 0.4
        score = sharpness * penalty
        reports.append({"name": name, "sharpness": round(sharpness, 1),
                        "brightness": round(brightness, 1)})
        if score > best_score:
            best, best_score = path, score

    if best is None:
        raise RuntimeError("None of the uploaded files could be read as an image.")
    return best, {"candidates": len(reports), "chosen": os.path.basename(best),
                  "reports": reports[:60]}


def _unwrap_with_deadline(work_dir: str, verts, faces, timeout: float):
    """Unwrap in a subprocess. Returns None if it exceeds `timeout` seconds."""
    import subprocess
    import numpy as _np

    os.makedirs(work_dir, exist_ok=True)
    src = os.path.join(work_dir, "unwrap_in.npz")
    dst = os.path.join(work_dir, "unwrap_out.npz")
    _np.savez(src, verts=verts, faces=faces)
    started = time.time()
    try:
        subprocess.run([sys.executable, "-m", "scanforge.uv_unwrap", src, dst],
                       check=True, timeout=timeout, capture_output=True)
    except subprocess.TimeoutExpired:
        events.log(f"UV unwrap exceeded {timeout:.0f}s and was stopped.", level="warn")
        return None
    except subprocess.CalledProcessError as exc:
        events.log(f"UV unwrap failed: {(exc.stderr or b'').decode()[-300:]}", level="warn")
        return None
    data = _np.load(dst)
    events.log(f"UV unwrap took {time.time() - started:.0f}s")
    return data["verts"], data["faces"], data["uvs"]


def main() -> int:
    ap = argparse.ArgumentParser(prog="scanforge-trellis")
    ap.add_argument("--images", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", default="")
    ap.add_argument("--trellis-root", default=os.path.expanduser("~/.scanforge/trellis-mac"))
    ap.add_argument("--quality", choices=["fast", "balanced", "high"], default="balanced")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    started = time.time()
    os.makedirs(args.out, exist_ok=True)

    # Quality maps onto generation resolution, mesh budget and texture size.
    profile = {
        "fast":     ("512", 40_000, 1024),
        "balanced": ("512", 100_000, 2048),
        "high":     ("1024", 200_000, 2048),
    }[args.quality]
    pipeline_type, target_faces, texture_size = profile

    import numpy as np
    from PIL import Image

    events.stage_start("preparing", "Choosing the sharpest photo", determinate=False)
    t0 = time.time()
    image_path, choice = pick_best_photo(args.images)
    if choice["candidates"] > 1:
        events.log(f"Using {choice['chosen']} — the sharpest of {choice['candidates']} photos. "
                   "This model builds the object from a single view.")
    events.stage_end("preparing", f"Selected {choice['chosen']}", time.time() - t0)

    _add_trellis_to_path(args.trellis_root)

    events.stage_start("sparse", "Loading the 3D model onto the GPU", determinate=False)
    t0 = time.time()
    import torch
    from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline

    if not torch.backends.mps.is_available():
        events.error("This machine has no Metal GPU available to PyTorch.")
        return 3
    pipeline = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
    pipeline.to(torch.device("mps"))
    events.stage_end("sparse", "Model loaded", time.time() - t0)

    events.stage_start("meshing", f"Generating geometry on the GPU ({pipeline_type})",
                       determinate=False)
    t0 = time.time()
    image = Image.open(image_path)
    outputs = pipeline.run(image, seed=args.seed, pipeline_type=pipeline_type)
    mesh_out = outputs[0] if isinstance(outputs, list) else outputs
    verts = mesh_out.vertices.cpu().numpy()
    faces = mesh_out.faces.cpu().numpy()
    if verts.shape[0] == 0 or faces.shape[0] == 0:
        events.error(
            "The GPU returned an empty mesh. On Apple Silicon this is usually the macOS "
            "GPU watchdog killing a long-running Metal kernel. Closing other windows, or "
            "using the 'fast' quality setting, usually clears it.")
        return 4
    gen_seconds = time.time() - t0
    events.stage_end("meshing", f"{faces.shape[0]:,} triangles generated", gen_seconds)

    # ---- decimate, unwrap, texture -----------------------------------------
    events.stage_start("texturing", "Simplifying the mesh", determinate=False)
    t0 = time.time()

    if len(faces) > target_faces:
        import fast_simplification
        ratio = 1.0 - (target_faces / len(faces))
        verts, faces = fast_simplification.simplify(
            verts.astype(np.float32), faces.astype(np.int32), ratio)
        events.log(f"Decimated to {len(faces):,} triangles for game-engine use.")

    has_color = getattr(mesh_out, "attrs", None) is not None
    voxel_args = None
    if has_color:
        voxel_args = (mesh_out.coords.cpu().numpy(),
                      mesh_out.attrs.cpu().float().numpy(),
                      mesh_out.origin.cpu().numpy(),
                      float(mesh_out.voxel_size))
    else:
        events.warn("The model produced no colour data; exporting untextured geometry.")

    # UV unwrapping runs in a subprocess under a deadline: xatlas is unbounded and
    # has been seen spending over an hour on a mesh that normally takes seconds.
    # A C extension cannot be interrupted in-process, hence the separate process.
    uv_verts, uv_faces, uvs = verts, faces, None
    if has_color:
        events.stage_progress("texturing", None, "Laying out the texture (UV unwrap)")
        uv = _unwrap_with_deadline(args.work or args.out, verts, faces,
                                  timeout=float(os.environ.get("SCANFORGE_UV_TIMEOUT", 300)))
        if uv is not None:
            uv_verts, uv_faces, uvs = uv
        else:
            events.warn("UV unwrapping took too long; exporting per-vertex colour "
                        "instead of a texture atlas. The model is unaffected, but it "
                        "carries vertex colours rather than an image.")

    texture_bytes = None
    vertex_rgb = None
    if has_color:
        assert voxel_args is not None
        vertex_rgb = vertex_colors_from_voxels(uv_verts, *voxel_args)
        if uvs is not None:
            events.stage_progress("texturing", None, "Baking the texture")
            atlas, _ = bake_atlas(uv_verts, uv_faces, uvs, vertex_rgb, texture_size=texture_size)
            Image.fromarray(atlas).save(os.path.join(args.out, "texture.jpg"),
                                        "JPEG", quality=92, subsampling=1)
            with open(os.path.join(args.out, "texture.jpg"), "rb") as fh:
                texture_bytes = fh.read()
    events.stage_end("texturing", "Texture built" if texture_bytes else "Colour applied",
                     time.time() - t0)

    # ---- export -------------------------------------------------------------
    events.stage_start("packaging", "Writing downloadable files", determinate=False)
    t0 = time.time()
    from . import glb as glb_writer
    from . import ply as ply_writer

    # TRELLIS puts the object in a unit box, Y up - already what the viewer wants.
    lo, hi = uv_verts.min(axis=0), uv_verts.max(axis=0)
    center = (lo + hi) / 2.0
    scale = 1.0 / max(float(np.max(hi - lo)), 1e-6)
    export_verts = ((uv_verts - center) * scale).astype(np.float32)

    glb_bytes = glb_writer.write(
        os.path.join(args.out, "model.glb"),
        vertices=export_verts, faces=uv_faces,
        # TRELLIS/xatlas UVs use the glTF convention (v=0 at the top), so they
        # must NOT be flipped again on the way out.
        face_uvs=uvs[uv_faces] if texture_bytes is not None else None,
        texture_bytes=texture_bytes, texture_mime="image/jpeg",
        vertex_colors=None if texture_bytes is not None else (
            (vertex_rgb * 255).astype(np.uint8) if vertex_rgb is not None else None),
        name="scan", flip_v=False)
    ply_writer.write_mesh(os.path.join(args.out, "model.ply"), export_verts, uv_faces)

    try:
        from . import render as sf_render
        tex = np.asarray(Image.open(os.path.join(args.out, "texture.jpg")).convert("RGB")) \
            if texture_bytes is not None else None
        flipped = uvs.copy()
        flipped[:, 1] = 1.0 - flipped[:, 1]   # the renderer samples bottom-left origin
        thumb = sf_render.render(export_verts, uv_faces, 640, 640,
                                 face_uvs=flipped[uv_faces] if tex is not None else None,
                                 texture=tex, azimuth_deg=25, elevation_deg=12)
        Image.fromarray(thumb).save(os.path.join(args.out, "thumbnail.jpg"), "JPEG", quality=88)
    except Exception as exc:
        events.warn(f"Could not render a preview image ({exc}).")

    files = [{"name": n, "bytes": os.path.getsize(os.path.join(args.out, n))}
             for n in ["model.glb", "model.ply", "texture.jpg", "thumbnail.jpg"]
             if os.path.exists(os.path.join(args.out, n))]
    events.stage_end("packaging", "Files ready", time.time() - t0)

    payload = {
        "tier": f"trellis2-local-mps ({pipeline_type})",
        "quality": args.quality,
        "mode": "object",
        "photosSubmitted": choice["candidates"],
        "photosUsed": 1,
        "photosRegistered": 1,
        "points": 0,
        "vertices": int(export_verts.shape[0]),
        "triangles": int(uv_faces.shape[0]),
        "textured": texture_bytes is not None,
        "textureFile": "texture.jpg" if texture_bytes else None,
        "glbBytes": glb_bytes,
        "durationSeconds": round(time.time() - started, 1),
        "generative": True,
        "providerNotes": [
            "Geometry was generated by TRELLIS.2 from a single photograph, not measured.",
            "Sides the photo never showed are plausible inventions.",
            "Scale is arbitrary; the model is normalised to a unit box.",
        ],
        "scaleNote": "normalised so the longest side is 1.0",
        "files": files,
        "inputChoice": choice,
    }
    with open(os.path.join(args.out, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    events.result(payload)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        import traceback
        events.error(str(exc), traceback.format_exc())
        raise SystemExit(1)
