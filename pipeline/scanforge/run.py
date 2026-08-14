"""SCANFORGE reconstruction pipeline entry point.

    python -m scanforge.run --images IN --work WORK --out OUT [--quality balanced]

Writes newline-delimited JSON progress events to stdout and the finished assets
to OUT. Exit code 0 means OUT contains a model; anything else means it does not,
and the last `error` event says why.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import time
import traceback

import numpy as np
from PIL import Image

from . import colmap, events, glb, openmvs, ply, prepare, render
from .sfm_model import object_box, orientation_matrix, read_model, up_axis

QUALITY = {
    # name:      (image max edge, sift features, texture scale)
    "fast":      (1280, 8192, 0.5),
    "balanced":  (1600, 16384, 1.0),
    "high":      (2400, 32768, 1.0),
}


def _largest_submodel(sparse_dir: str) -> str:
    """The mapper can split a capture into several disconnected models."""
    subs = [d for d in sorted(os.listdir(sparse_dir)) if os.path.isdir(os.path.join(sparse_dir, d))]
    if not subs:
        raise RuntimeError("Structure-from-motion produced no reconstruction")
    best, best_size = None, -1
    for sub in subs:
        path = os.path.join(sparse_dir, sub)
        size = sum(os.path.getsize(os.path.join(path, f)) for f in os.listdir(path))
        if size > best_size:
            best, best_size = path, size
    if len(subs) > 1:
        events.warn(f"The capture split into {len(subs)} separate reconstructions; "
                    "using the largest. More overlap between photos would fix this.")
    return best  # type: ignore[return-value]


def _write_obj(path: str, verts: np.ndarray, faces: np.ndarray,
               face_uvs: np.ndarray | None, texture_name: str | None) -> None:
    base = os.path.splitext(os.path.basename(path))[0]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# SCANFORGE reconstruction\n")
        if texture_name:
            fh.write(f"mtllib {base}.mtl\nusemtl scan\n")
        for v in verts:
            fh.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
        if face_uvs is not None:
            for uv in face_uvs.reshape(-1, 2):
                fh.write(f"vt {uv[0]:.6f} {uv[1]:.6f}\n")
            for i, f in enumerate(faces):
                a, b, c = f + 1
                ta, tb, tc = i * 3 + 1, i * 3 + 2, i * 3 + 3
                fh.write(f"f {a}/{ta} {b}/{tb} {c}/{tc}\n")
        else:
            for f in faces:
                fh.write(f"f {f[0] + 1} {f[1] + 1} {f[2] + 1}\n")
    if texture_name:
        with open(os.path.splitext(path)[0] + ".mtl", "w", encoding="utf-8") as fh:
            fh.write(f"newmtl scan\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nd 1\nillum 1\nmap_Kd {texture_name}\n")


def main() -> int:
    ap = argparse.ArgumentParser(prog="scanforge")
    ap.add_argument("--images", required=True, help="directory of input photographs")
    ap.add_argument("--work", required=True, help="scratch directory")
    ap.add_argument("--out", required=True, help="output directory for the finished model")
    ap.add_argument("--quality", choices=list(QUALITY), default="balanced")
    ap.add_argument("--mode", choices=["object", "scene"], default="object")
    ap.add_argument("--matcher", choices=["auto", "exhaustive", "sequential"], default="auto")
    ap.add_argument("--features", choices=["SIFT", "ALIKED"], default="SIFT")
    ap.add_argument("--max-images", type=int, default=250)
    ap.add_argument("--keep-work", action="store_true")
    args = ap.parse_args()

    started = time.time()
    os.makedirs(args.work, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)
    log_dir = os.path.join(args.work, "logs")
    os.makedirs(log_dir, exist_ok=True)
    max_edge, max_features, texture_scale = QUALITY[args.quality]

    caps = colmap.probe()
    if not caps.available:
        events.error("COLMAP is not installed on the server.", caps.error)
        return 3
    events.log(f"COLMAP {caps.version} at {caps.path} (CUDA: {'yes' if caps.cuda else 'no'})")

    tier = "sparse"
    if caps.cuda:
        tier = "cuda-dense"
    elif openmvs.available():
        tier = "openmvs-dense"
    events.log(f"Reconstruction tier: {tier}")

    # ---------------- prepare ----------------
    prepared_dir = os.path.join(args.work, "images")
    reports, kept = prepare.prepare_images(
        args.images, prepared_dir, max_edge=max_edge, max_images=args.max_images)
    if len(kept) < 8:
        events.error(f"Only {len(kept)} usable photo(s). At least 8 are needed, "
                     "and 25-60 taken all the way around the object works far better.")
        return 4

    # ---------------- structure from motion ----------------
    db_path = os.path.join(args.work, "database.db")
    colmap.extract_features(db_path, prepared_dir, log_dir, feature_type=args.features,
                            max_image_size=max_edge, max_features=max_features)
    sequential = (args.matcher == "sequential") or (args.matcher == "auto" and len(kept) > 80)
    colmap.match_features(db_path, log_dir, len(kept), sequential=sequential)

    sparse_dir = os.path.join(args.work, "sparse")
    colmap.map_sparse(db_path, prepared_dir, sparse_dir, log_dir, len(kept))
    model_path = _largest_submodel(sparse_dir)

    events.stage_start("filtering", "Cleaning up the point cloud", determinate=False)
    t0 = time.time()
    filtered = os.path.join(args.work, "filtered")
    colmap.filter_points(model_path, filtered, log_dir)
    txt_dir = os.path.join(args.work, "model_txt")
    colmap.model_to_txt(filtered, txt_dir, log_dir)
    model = read_model(txt_dir)
    if model.num_images < 6 or model.num_points < 200:
        events.error(
            f"Only {model.num_images} photo(s) could be linked together "
            f"({model.num_points} points). The photos probably do not overlap enough, "
            "or the object has too little surface texture to track.")
        return 5
    registered_ratio = model.num_images / max(len(kept), 1)
    if registered_ratio < 0.6:
        events.warn(f"Only {model.num_images} of {len(kept)} photos could be positioned. "
                    "Consider re-shooting with more overlap.")

    up, up_conf, up_why = up_axis(model)
    if up_conf < 0.25:
        events.warn("Could not confidently work out which way is up from the camera "
                    "path; the model may be tilted.")

    final_model = filtered
    crop_info: dict = {"applied": False}
    if args.mode == "object":
        lo, hi, info = object_box(model)
        boundary = ",".join(f"{v:.6f}" for v in list(lo) + list(hi))
        cropped = os.path.join(args.work, "cropped")
        try:
            colmap.crop_model(filtered, cropped, boundary, log_dir)
            colmap.model_to_txt(cropped, os.path.join(args.work, "model_txt_cropped"), log_dir)
            cropped_model = read_model(os.path.join(args.work, "model_txt_cropped"))
            if cropped_model.num_points >= 200:
                final_model = cropped
                model = cropped_model
                crop_info = {"applied": True, **info}
            else:
                events.warn("Object isolation would have removed too much; keeping everything.")
        except Exception as exc:                      # cropping is a nicety, never fatal
            events.warn(f"Object isolation failed ({exc}); keeping the full reconstruction.")
    events.stage_end("filtering", f"{model.num_points} points kept", time.time() - t0)

    # ---------------- dense / meshing ----------------
    dense_dir = os.path.join(args.work, "dense")
    colmap.undistort(prepared_dir, final_model, dense_dir, log_dir, max_image_size=max_edge)

    mesh_ply = os.path.join(args.work, "mesh.ply")
    dense_points_ply = None
    if tier == "cuda-dense":
        colmap.patch_match_stereo(dense_dir, log_dir, max_image_size=min(max_edge, 1600))
        dense_points_ply = os.path.join(args.work, "fused.ply")
        colmap.stereo_fusion(dense_dir, dense_points_ply, log_dir)
        colmap.delaunay_mesh(dense_dir, mesh_ply, log_dir, input_type="dense")
    elif tier == "openmvs-dense":
        try:
            mvs_mesh, _ = openmvs.densify_and_mesh(dense_dir, os.path.join(args.work, "mvs"), log_dir)
            shutil.copy(mvs_mesh, mesh_ply)
        except Exception as exc:
            events.warn(f"OpenMVS tier failed ({exc}); falling back to sparse meshing.")
            tier = "sparse"
            colmap.delaunay_mesh(final_model, mesh_ply, log_dir, input_type="sparse")
    else:
        colmap.delaunay_mesh(final_model, mesh_ply, log_dir, input_type="sparse")

    if not os.path.exists(mesh_ply) or os.path.getsize(mesh_ply) < 200:
        events.error("Meshing produced an empty surface. The reconstruction was probably "
                     "too sparse - try more photos with more overlap.")
        return 6

    # ---------------- texturing ----------------
    textured_dir = os.path.join(args.work, "textured")
    texture_ok = True
    try:
        colmap.texture_mesh(dense_dir, mesh_ply, textured_dir, log_dir, texture_scale=texture_scale)
    except Exception as exc:
        texture_ok = False
        events.warn(f"Texturing failed ({exc}); exporting untextured geometry.")

    # ---------------- packaging ----------------
    events.stage_start("packaging", "Building downloadable files", determinate=False)
    t0 = time.time()

    textured_ply = os.path.join(textured_dir, "mesh.ply")
    if texture_ok and os.path.exists(textured_ply):
        mesh = ply.read(textured_ply)
        texture_path = os.path.join(textured_dir, mesh.texture_file or "texture.png")
    else:
        mesh = ply.read(mesh_ply)
        texture_path = None

    if mesh.faces.shape[0] == 0:
        events.error("The reconstructed surface has no triangles.")
        return 7

    # Orient (+Y up), centre on the object, normalise scale. Photogrammetry has no
    # absolute scale, so 1.0 = longest side rather than 1 metre; recorded in meta.
    R = orientation_matrix(up)
    rotated = mesh.vertices @ R.T
    lo, hi = rotated.min(axis=0), rotated.max(axis=0)
    center_rot = (lo + hi) / 2.0
    longest = float(np.max(hi - lo)) or 1.0
    scale = 1.0 / longest
    verts = ((rotated - center_rot) * scale).astype(np.float32)

    texture_bytes, texture_mime, texture_name = None, "image/jpeg", None
    if texture_path and os.path.exists(texture_path):
        img = Image.open(texture_path).convert("RGB")
        texture_name = "texture.jpg"
        img.save(os.path.join(args.out, texture_name), "JPEG", quality=92, subsampling=1)
        with open(os.path.join(args.out, texture_name), "rb") as fh:
            texture_bytes = fh.read()

    glb_path = os.path.join(args.out, "model.glb")
    glb_bytes = glb.write(
        glb_path,
        vertices=verts, faces=mesh.faces,
        face_uvs=mesh.face_uvs if texture_bytes is not None else None,
        texture_bytes=texture_bytes, texture_mime=texture_mime,
        vertex_colors=mesh.vertex_colors, name="scan")

    ply.write_mesh(os.path.join(args.out, "model.ply"), verts, mesh.faces, mesh.vertex_colors)
    _write_obj(os.path.join(args.out, "model.obj"), verts, mesh.faces,
               mesh.face_uvs if texture_bytes is not None else None, texture_name)

    cloud_points = ((model.points @ R.T - center_rot) * scale).astype(np.float32)
    ply.write_points(os.path.join(args.out, "points.ply"), cloud_points, model.colors)
    if dense_points_ply and os.path.exists(dense_points_ply):
        shutil.copy(dense_points_ply, os.path.join(args.out, "points_dense.ply"))

    # Thumbnail from the actual exported geometry.
    try:
        tex_arr = np.asarray(Image.open(os.path.join(args.out, texture_name)).convert("RGB")) \
            if texture_name else None
        thumb = render.render(verts, mesh.faces, 640, 640,
                              face_uvs=mesh.face_uvs if tex_arr is not None else None,
                              texture=tex_arr, vertex_colors=mesh.vertex_colors,
                              azimuth_deg=35, elevation_deg=18)
        Image.fromarray(thumb).save(os.path.join(args.out, "thumbnail.jpg"), "JPEG", quality=88)
    except Exception as exc:
        events.warn(f"Could not render a preview image ({exc}).")

    files = []
    for name in ["model.glb", "model.obj", "model.mtl", "model.ply", "points.ply",
                 "points_dense.ply", "texture.jpg", "thumbnail.jpg"]:
        path = os.path.join(args.out, name)
        if os.path.exists(path):
            files.append({"name": name, "bytes": os.path.getsize(path)})

    events.stage_end("packaging", "Files ready", time.time() - t0)

    payload = {
        "tier": tier,
        "colmap": caps.to_dict(),
        "quality": args.quality,
        "mode": args.mode,
        "matcher": "sequential" if sequential else "exhaustive",
        "photosSubmitted": len(reports),
        "photosUsed": len(kept),
        "photosRegistered": model.num_images,
        "points": model.num_points,
        "vertices": int(mesh.vertices.shape[0]),
        "triangles": int(mesh.faces.shape[0]),
        "textured": texture_bytes is not None,
        "textureFile": texture_name,
        "glbBytes": glb_bytes,
        "upAxisConfidence": round(up_conf, 3),
        "upAxisMethod": up_why,
        "objectIsolation": crop_info,
        "scaleNote": "normalised so the longest side is 1.0; photogrammetry has no absolute scale",
        "durationSeconds": round(time.time() - started, 1),
        "files": files,
        "imageReports": prepare.reports_to_json(reports),
    }
    with open(os.path.join(args.out, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    events.result(payload)

    if not args.keep_work:
        for path in [os.path.join(args.work, "dense"), os.path.join(args.work, "mvs")]:
            shutil.rmtree(path, ignore_errors=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - the server needs a structured failure
        events.error(str(exc), traceback.format_exc())
        raise SystemExit(1)
