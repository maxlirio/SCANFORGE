"""A correct texture baker for TRELLIS.2 output on Apple Silicon.

The Apple Silicon port falls back to a KDTree baker when its Metal component is
unavailable (it needs a `metal` compiler, i.e. full Xcode). That fallback bakes
by looking up voxels *per texel*, and TRELLIS meshes are so dense that the median
UV triangle covers under two texels at 1024². Rendering then samples texels
written by unrelated charts, which comes out as coloured confetti.

Measured on a real run (236k vertices, 200k triangles):

    per-texel voxel lookup   colour difference across mesh edges: 58.6 / 255
    per-vertex voxel lookup  colour difference across mesh edges:  4.9 / 255
    (random pairs, for scale)                                     51.5 / 255

So the voxel colours, the mesh, and their alignment are all fine; only the
per-texel step is wrong. This bakes per-*vertex* first, then interpolates those
across each UV triangle, which is smooth by construction and independent of how
many texels a triangle happens to cover.
"""
from __future__ import annotations

import numpy as np


def vertex_colors_from_voxels(
    vertices: np.ndarray,
    voxel_coords: np.ndarray,
    voxel_attrs: np.ndarray,
    origin: np.ndarray,
    voxel_size: float,
    k: int = 4,
) -> np.ndarray:
    """Colour every vertex from the nearest voxels (inverse-distance weighted)."""
    from scipy.spatial import cKDTree

    centers = voxel_coords.astype(np.float32) * voxel_size + origin + voxel_size * 0.5
    tree = cKDTree(centers)
    k = max(1, min(k, len(centers)))
    dist, idx = tree.query(vertices, k=k, workers=-1)
    if k == 1:
        dist, idx = dist[:, None], idx[:, None]

    weights = 1.0 / (dist + voxel_size * 0.1)
    weights /= weights.sum(axis=1, keepdims=True)
    rgb = (voxel_attrs[idx, :3] * weights[..., None]).sum(axis=1)
    return np.clip(rgb, 0.0, 1.0).astype(np.float32)


def bake_atlas(
    vertices: np.ndarray,
    faces: np.ndarray,
    uvs: np.ndarray,
    vertex_rgb: np.ndarray,
    texture_size: int = 2048,
    dilate: int = 12,
) -> tuple[np.ndarray, np.ndarray]:
    """Rasterise UV triangles, interpolating vertex colour. Returns (rgb, mask)."""
    size = texture_size
    atlas = np.zeros((size, size, 3), dtype=np.float32)
    mask = np.zeros((size, size), dtype=bool)

    uv_px = uvs * np.array([size - 1, size - 1], dtype=np.float32)
    tri_uv = uv_px[faces]                 # (F,3,2)
    tri_rgb = vertex_rgb[faces]           # (F,3,3)

    lo = np.floor(tri_uv.min(axis=1)).astype(np.int32)
    hi = np.ceil(tri_uv.max(axis=1)).astype(np.int32)
    np.clip(lo, 0, size - 1, out=lo)
    np.clip(hi, 0, size - 1, out=hi)

    for f in range(len(faces)):
        x0, y0 = lo[f]
        x1, y1 = hi[f]
        if x1 < x0 or y1 < y0:
            continue
        a, b, c = tri_uv[f]
        d00, d01 = b[0] - a[0], c[0] - a[0]
        d10, d11 = b[1] - a[1], c[1] - a[1]
        denom = d00 * d11 - d01 * d10
        if abs(denom) < 1e-12:
            # Degenerate in UV space: paint the average colour so the triangle
            # is not left as a hole for dilation to invent something for.
            atlas[y0:y1 + 1, x0:x1 + 1] = tri_rgb[f].mean(axis=0)
            mask[y0:y1 + 1, x0:x1 + 1] = True
            continue

        xs = np.arange(x0, x1 + 1, dtype=np.float32)
        ys = np.arange(y0, y1 + 1, dtype=np.float32)
        px, py = np.meshgrid(xs + 0.5, ys + 0.5)
        dx, dy = px - a[0], py - a[1]
        u = (dx * d11 - d01 * dy) / denom
        v = (d00 * dy - dx * d10) / denom
        w = 1.0 - u - v
        # A small negative tolerance keeps sub-texel triangles from vanishing.
        inside = (u >= -0.25) & (v >= -0.25) & (w >= -0.25)
        if not inside.any():
            # Sub-texel triangle that covers no texel centre: stamp its centroid.
            cx = int(round(tri_uv[f, :, 0].mean()))
            cy = int(round(tri_uv[f, :, 1].mean()))
            atlas[cy, cx] = tri_rgb[f].mean(axis=0)
            mask[cy, cx] = True
            continue

        cols = (w[..., None] * tri_rgb[f, 0]
                + u[..., None] * tri_rgb[f, 1]
                + v[..., None] * tri_rgb[f, 2])
        iy, ix = np.nonzero(inside)
        atlas[ys.astype(int)[iy], xs.astype(int)[ix]] = cols[iy, ix]
        mask[ys.astype(int)[iy], xs.astype(int)[ix]] = True

    _dilate_into_gutters(atlas, mask, dilate)
    return np.clip(atlas * 255.0, 0, 255).astype(np.uint8), mask


def _dilate_into_gutters(atlas: np.ndarray, mask: np.ndarray, rounds: int) -> None:
    """Bleed colour outward so bilinear filtering never samples empty gutters."""
    from scipy.ndimage import binary_dilation, uniform_filter

    filled = mask.copy()
    for _ in range(rounds):
        grown = binary_dilation(filled)
        edge = grown & ~filled
        if not edge.any():
            break
        weight = uniform_filter(filled.astype(np.float32), size=3)
        for channel in range(3):
            smooth = uniform_filter(atlas[..., channel] * filled, size=3)
            atlas[..., channel] = np.where(edge, smooth / np.maximum(weight, 1e-6),
                                           atlas[..., channel])
        filled = grown
