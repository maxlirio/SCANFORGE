"""Thin subprocess layer over the COLMAP CLI, with real progress extraction.

COLMAP logs through glog, so every line looks like:
    I20260813 18:33:12.123456 0x1f1ecf100 feature_extraction.cc:274] Processed file [12/50]
We strip the prefix and look for the counters COLMAP genuinely prints. Stages
that print no counter report indeterminate progress rather than a fake number.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Optional

from . import events

GLOG_PREFIX = re.compile(r"^[IWEF]\d{8} \d{2}:\d{2}:\d{2}\.\d+ +0x[0-9a-f]+ +[\w.\-]+:\d+\] ")

RE_PROCESSED_FILE = re.compile(r"Processed file \[(\d+)/(\d+)\]")
RE_MATCH_BLOCK = re.compile(r"Processing block \[(\d+)/(\d+), (\d+)/(\d+)\]")
RE_REGISTERING = re.compile(r"Registering image #\d+ \(num_reg_frames=(\d+)\)")
RE_FUSING = re.compile(r"Fusing image \[(\d+)/(\d+)\]")
RE_PATCHMATCH = re.compile(r"Processing view (\d+) / (\d+)")


class ColmapError(RuntimeError):
    pass


def colmap_bin() -> str:
    return os.environ.get("COLMAP_BIN") or shutil.which("colmap") or "/opt/homebrew/bin/colmap"


@dataclass
class ColmapCapabilities:
    available: bool
    version: str = ""
    cuda: bool = False
    path: str = ""
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "available": self.available,
            "version": self.version,
            "cuda": self.cuda,
            "path": self.path,
            "error": self.error,
        }


def probe() -> ColmapCapabilities:
    """Ask the installed binary what it is and whether it has CUDA."""
    path = colmap_bin()
    if not os.path.exists(path) and not shutil.which(path):
        return ColmapCapabilities(False, error=f"colmap not found (looked for {path})")
    try:
        out = subprocess.run([path, "-h"], capture_output=True, text=True, timeout=60)
    except Exception as exc:  # pragma: no cover - environment dependent
        return ColmapCapabilities(False, path=path, error=str(exc))
    text = (out.stdout or "") + (out.stderr or "")
    first = next((ln for ln in text.splitlines() if ln.startswith("COLMAP ")), "")
    version = first.split(" ")[1] if first else "unknown"
    # COLMAP prints "... with CUDA" or "... without CUDA" in its banner.
    cuda = ("without CUDA" not in first) and ("with CUDA" in first)
    return ColmapCapabilities(True, version=version, cuda=cuda, path=path)


def strip_prefix(line: str) -> str:
    return GLOG_PREFIX.sub("", line).rstrip()


def run(
    args: list[str],
    log_path: str,
    on_line: Optional[Callable[[str], None]] = None,
    env: Optional[dict] = None,
) -> None:
    """Run a colmap subcommand, streaming every line to `on_line` and a log file."""
    cmd = [colmap_bin()] + args + ["--log_target", "stderr"]
    with open(log_path, "w", encoding="utf-8") as log_file:
        log_file.write("$ " + " ".join(cmd) + "\n")
        log_file.flush()
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={**os.environ, **(env or {})},
        )
        assert proc.stdout is not None
        tail: list[str] = []
        for raw in proc.stdout:
            log_file.write(raw)
            clean = strip_prefix(raw)
            if clean:
                tail.append(clean)
                if len(tail) > 25:
                    tail.pop(0)
                if on_line:
                    on_line(clean)
        code = proc.wait()
    if code != 0:
        raise ColmapError(
            f"`colmap {args[0]}` exited with code {code}.\n" + "\n".join(tail[-12:])
        )


def _timed(stage: str, label: str, fn: Callable[[], None]) -> float:
    started = time.time()
    fn()
    took = time.time() - started
    events.stage_end(stage, label, took)
    return took


# --------------------------------------------------------------------------
# Individual pipeline steps. Each one owns its own progress interpretation.
# --------------------------------------------------------------------------

def extract_features(
    db_path: str,
    image_path: str,
    log_dir: str,
    feature_type: str = "SIFT",
    max_image_size: int = 1600,
    max_features: int = 8192,
) -> float:
    events.stage_start("features", "Detecting features in each photo", determinate=True)
    total_hint = {"n": 0}

    def on_line(line: str) -> None:
        m = RE_PROCESSED_FILE.search(line)
        if m:
            i, n = int(m.group(1)), int(m.group(2))
            total_hint["n"] = n
            events.stage_progress("features", i / max(n, 1), f"Photo {i} of {n}")

    args = [
        "feature_extractor",
        "--database_path", db_path,
        "--image_path", image_path,
        "--ImageReader.single_camera", "1",
        "--ImageReader.camera_model", "SIMPLE_RADIAL",
        "--FeatureExtraction.use_gpu", "0",
        "--FeatureExtraction.type", feature_type,
        "--FeatureExtraction.max_image_size", str(max_image_size),
    ]
    if feature_type == "SIFT":
        args += ["--SiftExtraction.max_num_features", str(max_features)]
    return _timed("features", "Features detected", lambda: run(args, os.path.join(log_dir, "features.log"), on_line))


def match_features(
    db_path: str,
    log_dir: str,
    num_images: int,
    sequential: bool = False,
    use_lightglue: bool = False,
) -> float:
    mode = "sequential" if sequential else "exhaustive"
    events.stage_start("matching", f"Matching photos to each other ({mode})", determinate=True)

    def on_line(line: str) -> None:
        m = RE_MATCH_BLOCK.search(line)
        if m:
            i, n, j, k = (int(g) for g in m.groups())
            done = ((i - 1) * k + j) / max(n * k, 1)
            events.stage_progress("matching", done, f"Block {i}/{n}, {j}/{k}")

    if sequential:
        args = [
            "sequential_matcher",
            "--database_path", db_path,
            "--SequentialMatching.overlap", "12",
            "--SequentialMatching.quadratic_overlap", "1",
        ]
    else:
        args = ["exhaustive_matcher", "--database_path", db_path]
    args += ["--FeatureMatching.use_gpu", "0"]
    if use_lightglue:
        args += ["--FeatureMatching.type", "SIFT_LIGHTGLUE"]
    return _timed("matching", "Photos matched", lambda: run(args, os.path.join(log_dir, "matching.log"), on_line))


def map_sparse(db_path: str, image_path: str, out_path: str, log_dir: str, num_images: int) -> float:
    events.stage_start("sparse", "Solving camera positions", determinate=True)
    os.makedirs(out_path, exist_ok=True)

    def on_line(line: str) -> None:
        m = RE_REGISTERING.search(line)
        if m:
            k = int(m.group(1))
            events.stage_progress("sparse", k / max(num_images, 1), f"{k} of {num_images} photos positioned")

    args = [
        "mapper",
        "--database_path", db_path,
        "--image_path", image_path,
        "--output_path", out_path,
    ]
    return _timed("sparse", "Camera positions solved", lambda: run(args, os.path.join(log_dir, "mapper.log"), on_line))


def filter_points(in_path: str, out_path: str, log_dir: str,
                  min_track_len: int = 3, max_reproj_error: float = 2.5,
                  min_tri_angle: float = 1.5) -> None:
    os.makedirs(out_path, exist_ok=True)
    run([
        "point_filtering",
        "--input_path", in_path,
        "--output_path", out_path,
        "--min_track_len", str(min_track_len),
        "--max_reproj_error", str(max_reproj_error),
        "--min_tri_angle", str(min_tri_angle),
    ], os.path.join(log_dir, "point_filtering.log"))


def crop_model(in_path: str, out_path: str, boundary: str, log_dir: str) -> None:
    os.makedirs(out_path, exist_ok=True)
    run([
        "model_cropper",
        "--input_path", in_path,
        "--output_path", out_path,
        "--boundary", boundary,
    ], os.path.join(log_dir, "model_cropper.log"))


def model_to_txt(in_path: str, out_path: str, log_dir: str) -> None:
    os.makedirs(out_path, exist_ok=True)
    run([
        "model_converter",
        "--input_path", in_path,
        "--output_path", out_path,
        "--output_type", "TXT",
    ], os.path.join(log_dir, "model_converter_txt.log"))


def model_to_ply(in_path: str, out_ply: str, log_dir: str) -> None:
    run([
        "model_converter",
        "--input_path", in_path,
        "--output_path", out_ply,
        "--output_type", "PLY",
    ], os.path.join(log_dir, "model_converter_ply.log"))


def undistort(image_path: str, model_path: str, out_path: str, log_dir: str,
              max_image_size: int = 1600) -> float:
    events.stage_start("dense", "Undistorting photos", determinate=False)
    args = [
        "image_undistorter",
        "--image_path", image_path,
        "--input_path", model_path,
        "--output_path", out_path,
        "--output_type", "COLMAP",
        "--max_image_size", str(max_image_size),
    ]
    return _timed("dense", "Photos undistorted", lambda: run(args, os.path.join(log_dir, "undistort.log")))


def patch_match_stereo(workspace: str, log_dir: str, max_image_size: int = 1200) -> float:
    """CUDA-only dense depth maps. Only called when probe() reports cuda=True."""
    events.stage_start("dense", "Computing dense depth maps (GPU)", determinate=True)

    def on_line(line: str) -> None:
        m = RE_PATCHMATCH.search(line)
        if m:
            i, n = int(m.group(1)), int(m.group(2))
            events.stage_progress("dense", i / max(n, 1), f"View {i} of {n}")

    args = [
        "patch_match_stereo",
        "--workspace_path", workspace,
        "--workspace_format", "COLMAP",
        "--PatchMatchStereo.max_image_size", str(max_image_size),
        "--PatchMatchStereo.geom_consistency", "1",
    ]
    return _timed("dense", "Dense depth maps computed",
                  lambda: run(args, os.path.join(log_dir, "patch_match.log"), on_line))


def stereo_fusion(workspace: str, out_ply: str, log_dir: str) -> float:
    events.stage_start("dense", "Fusing depth maps into a point cloud", determinate=True)

    def on_line(line: str) -> None:
        m = RE_FUSING.search(line)
        if m:
            i, n = int(m.group(1)), int(m.group(2))
            events.stage_progress("dense", i / max(n, 1), f"Fusing view {i} of {n}")

    args = [
        "stereo_fusion",
        "--workspace_path", workspace,
        "--workspace_format", "COLMAP",
        "--input_type", "geometric",
        "--output_path", out_ply,
    ]
    return _timed("dense", "Dense point cloud built",
                  lambda: run(args, os.path.join(log_dir, "stereo_fusion.log"), on_line))


def delaunay_mesh(input_path: str, out_ply: str, log_dir: str, input_type: str = "sparse",
                  quality_regularization: float = 1.0, max_side_length_factor: float = 25.0) -> float:
    events.stage_start("meshing", "Building the surface", determinate=False)
    args = [
        "delaunay_mesher",
        "--input_path", input_path,
        "--input_type", input_type,
        "--output_path", out_ply,
        "--DelaunayMeshing.quality_regularization", str(quality_regularization),
        "--DelaunayMeshing.max_side_length_factor", str(max_side_length_factor),
    ]
    return _timed("meshing", "Surface built", lambda: run(args, os.path.join(log_dir, "meshing.log")))


def texture_mesh(workspace: str, mesh_ply: str, out_dir: str, log_dir: str,
                 texture_scale: float = 1.0) -> float:
    events.stage_start("texturing", "Projecting photos onto the surface", determinate=False)
    os.makedirs(out_dir, exist_ok=True)
    args = [
        "mesh_texturer",
        "--workspace_path", workspace,
        "--input_path", mesh_ply,
        "--output_path", out_dir,
        "--MeshTextureMapping.texture_scale_factor", str(texture_scale),
        "--MeshTextureMapping.apply_color_correction", "1",
    ]
    return _timed("texturing", "Texture generated", lambda: run(args, os.path.join(log_dir, "texturing.log")))
