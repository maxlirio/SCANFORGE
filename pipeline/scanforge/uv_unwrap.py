"""UV unwrapping, in a separate process so it can be given a deadline.

xatlas is excellent but its chart computation is unbounded: on most TRELLIS meshes
it finishes in seconds, and on an occasional awkward one it runs for hours. Seen
in the wild — a 100k-triangle mesh where `xatlas::ComputeCharts` burned 76 minutes
at 300% CPU with no end in sight, while the GPU generation itself took nine.

There is no way to interrupt a C extension mid-call from Python, so the caller runs
this as a subprocess and kills it on timeout, falling back to per-vertex colour
(which needs no atlas at all).

    python -m scanforge.uv_unwrap in.npz out.npz

Cleaning the mesh first matters as much as the timeout: welded duplicate vertices
and dropped degenerate triangles are what make the pathological cases pathological.
"""
from __future__ import annotations

import sys

import numpy as np


def clean_mesh(vertices: np.ndarray, faces: np.ndarray,
               weld_tolerance: float = 1e-6) -> tuple[np.ndarray, np.ndarray]:
    """Weld coincident vertices and drop degenerate triangles."""
    verts = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)

    # Weld by quantised position, which removes the seams decimation leaves behind.
    quantised = np.round(verts / max(weld_tolerance, 1e-12)).astype(np.int64)
    _, unique_index, inverse = np.unique(quantised, axis=0,
                                         return_index=True, return_inverse=True)
    welded = verts[unique_index]
    faces = inverse[faces]

    # A triangle with a repeated corner has no area and no valid UV.
    ok = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
    faces = faces[ok]

    # Zero-area triangles confuse chart growth even when their indices differ.
    a, b, c = welded[faces[:, 0]], welded[faces[:, 1]], welded[faces[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    faces = faces[area > 1e-14]

    # Drop vertices no surviving face refers to.
    used, faces = np.unique(faces, return_inverse=True)
    return welded[used].astype(np.float32), faces.reshape(-1, 3).astype(np.uint32)


def unwrap(vertices: np.ndarray, faces: np.ndarray):
    import xatlas

    chart = xatlas.ChartOptions()
    # Fewer, larger charts: cheaper to compute and kinder to a texture atlas that
    # has to survive bilinear filtering.
    chart.max_iterations = 1
    chart.max_cost = 4.0
    chart.normal_deviation_weight = 1.0
    chart.roundness_weight = 0.0
    chart.straightness_weight = 3.0
    chart.fix_winding = False

    pack = xatlas.PackOptions()
    pack.padding = 2
    pack.bilinear = True
    pack.rotate_charts = True
    pack.bruteForce = False

    # `parametrize()` takes no options in xatlas 0.0.11; the Atlas API does, and
    # the options are the whole point here.
    atlas = xatlas.Atlas()
    atlas.add_mesh(np.ascontiguousarray(vertices, dtype=np.float32),
                   np.ascontiguousarray(faces, dtype=np.uint32))
    atlas.generate(chart_options=chart, pack_options=pack)
    vmapping, indices, uvs = atlas.get_mesh(0)
    return vertices[vmapping], indices.reshape(-1, 3), uvs


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    data = np.load(src)
    verts, faces = clean_mesh(data["verts"], data["faces"])
    uv_verts, uv_faces, uvs = unwrap(verts, faces)
    np.savez(dst, verts=uv_verts, faces=uv_faces, uvs=uvs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
