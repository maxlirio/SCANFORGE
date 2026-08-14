"""Optional OpenMVS tier (AGPL-3.0, operator-installed).

Only used if the binaries are actually present. `scripts/build_openmvs.sh` builds
them; see docs/OPENMVS.md for why they are not bundled. When present, OpenMVS
gives CPU dense reconstruction, which is the single biggest quality upgrade
available on a machine without CUDA.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time
from typing import Optional

from . import events

TOOLS = ["InterfaceCOLMAP", "DensifyPointCloud", "ReconstructMesh"]


def bin_dir() -> Optional[str]:
    explicit = os.environ.get("OPENMVS_BIN_DIR")
    candidates = [explicit] if explicit else []
    candidates += [os.path.expanduser("~/.scanforge/openmvs/bin"), "/opt/homebrew/bin", "/usr/local/bin"]
    for cand in candidates:
        if cand and all(os.path.exists(os.path.join(cand, t)) for t in TOOLS):
            return cand
    if all(shutil.which(t) for t in TOOLS):
        return os.path.dirname(shutil.which(TOOLS[0]))  # type: ignore[arg-type]
    return None


def available() -> bool:
    return bin_dir() is not None


def _run(tool: str, args: list[str], cwd: str, log_path: str,
         on_line=None) -> None:
    exe = os.path.join(bin_dir() or "", tool)
    with open(log_path, "w", encoding="utf-8") as log_file:
        log_file.write("$ " + " ".join([exe] + args) + "\n")
        proc = subprocess.Popen([exe] + args, cwd=cwd, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        assert proc.stdout is not None
        tail: list[str] = []
        for line in proc.stdout:
            log_file.write(line)
            tail.append(line.rstrip())
            if len(tail) > 20:
                tail.pop(0)
            if on_line:
                on_line(line.rstrip())
        code = proc.wait()
    if code != 0:
        raise RuntimeError(f"{tool} exited with {code}:\n" + "\n".join(tail[-10:]))


def densify_and_mesh(dense_workspace: str, out_dir: str, log_dir: str,
                     resolution_level: int = 2) -> tuple[str, dict]:
    """COLMAP dense workspace -> dense point cloud -> mesh. Returns (mesh_ply, stats)."""
    os.makedirs(out_dir, exist_ok=True)
    scene = os.path.join(out_dir, "scene.mvs")

    events.stage_start("dense", "Converting reconstruction for dense matching", determinate=False)
    started = time.time()
    _run("InterfaceCOLMAP", ["-i", dense_workspace, "-o", scene, "-w", out_dir],
         out_dir, os.path.join(log_dir, "mvs_interface.log"))
    events.stage_end("dense", "Reconstruction converted", time.time() - started)

    events.stage_start("dense", "Computing dense geometry (CPU, this is the slow part)",
                       determinate=False)
    started = time.time()

    def on_line(line: str) -> None:
        if "Estimated depth-map" in line or "Depth-maps" in line or "Fused" in line:
            events.stage_progress("dense", None, line.strip()[:110])

    _run("DensifyPointCloud", ["scene.mvs", "-w", out_dir,
                               "--resolution-level", str(resolution_level),
                               "--number-views", "6"],
         out_dir, os.path.join(log_dir, "mvs_densify.log"), on_line)
    events.stage_end("dense", "Dense geometry computed", time.time() - started)

    dense_mvs = os.path.join(out_dir, "scene_dense.mvs")
    if not os.path.exists(dense_mvs):
        raise RuntimeError("DensifyPointCloud produced no output")

    events.stage_start("meshing", "Building the surface from dense points", determinate=False)
    started = time.time()
    _run("ReconstructMesh", ["scene_dense.mvs", "-w", out_dir],
         out_dir, os.path.join(log_dir, "mvs_mesh.log"))
    events.stage_end("meshing", "Surface built", time.time() - started)

    mesh_ply = os.path.join(out_dir, "scene_dense_mesh.ply")
    if not os.path.exists(mesh_ply):
        raise RuntimeError("ReconstructMesh produced no mesh")
    return mesh_ply, {"tier": "openmvs", "resolutionLevel": resolution_level}
