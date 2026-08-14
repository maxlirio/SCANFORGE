"""A small software rasteriser (numpy only).

Used for two things:
  * the thumbnail the web UI shows for a finished scan
  * headless visual verification of the exported geometry during development

Deliberately dependency-free: pyrender/OSMesa/EGL are painful headless on macOS,
and this only has to draw a few tens of thousands of triangles.
"""
from __future__ import annotations

import numpy as np


def _look_at(eye: np.ndarray, target: np.ndarray, up: np.ndarray) -> np.ndarray:
    f = target - eye
    f /= max(np.linalg.norm(f), 1e-9)
    s = np.cross(f, up)
    if np.linalg.norm(s) < 1e-9:
        s = np.cross(f, np.array([1.0, 0.0, 0.0]))
    s /= max(np.linalg.norm(s), 1e-9)
    u = np.cross(s, f)
    m = np.eye(4)
    m[0, :3], m[1, :3], m[2, :3] = s, u, -f
    m[:3, 3] = -m[:3, :3] @ eye
    return m


def render(
    vertices: np.ndarray,
    faces: np.ndarray,
    width: int = 640,
    height: int = 640,
    face_uvs: np.ndarray | None = None,
    texture: np.ndarray | None = None,     # (H,W,3) uint8
    vertex_colors: np.ndarray | None = None,
    azimuth_deg: float = 35.0,
    elevation_deg: float = 20.0,
    distance_scale: float = 2.4,
    background: tuple[int, int, int] = (24, 26, 32),
    up: np.ndarray | None = None,
) -> np.ndarray:
    V = np.asarray(vertices, dtype=np.float64)
    F = np.asarray(faces, dtype=np.int64)
    if F.size == 0:
        return np.full((height, width, 3), background, dtype=np.uint8)

    up = np.array([0.0, 1.0, 0.0]) if up is None else up
    center = (V.min(axis=0) + V.max(axis=0)) / 2.0
    radius = float(np.linalg.norm(V.max(axis=0) - V.min(axis=0))) / 2.0 or 1.0

    az, el = np.radians(azimuth_deg), np.radians(elevation_deg)
    direction = np.array([np.cos(el) * np.sin(az), np.sin(el), np.cos(el) * np.cos(az)])
    eye = center + direction * radius * distance_scale
    view = _look_at(eye, center, up)

    cam = (view @ np.hstack([V, np.ones((V.shape[0], 1))]).T).T[:, :3]
    fov = np.radians(40.0)
    focal = (height / 2.0) / np.tan(fov / 2.0)
    z = np.maximum(-cam[:, 2], 1e-6)
    sx = cam[:, 0] * focal / z + width / 2.0
    sy = -cam[:, 1] * focal / z + height / 2.0

    # Per-face lambert term from the geometric normal, lit from over the camera's shoulder.
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    fn = np.cross(b - a, c - a)
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    light = direction + np.array([0.0, 0.45, 0.0])
    light /= np.linalg.norm(light)
    shade = np.abs(fn @ light) * 0.65 + 0.35

    img = np.full((height, width, 3), background, dtype=np.float64)
    zbuf = np.full((height, width), np.inf)

    tri_x = sx[F]
    tri_y = sy[F]
    tri_z = z[F]
    behind = (cam[:, 2] > -1e-6)[F].any(axis=1)

    x0 = np.clip(np.floor(tri_x.min(axis=1)).astype(int), 0, width - 1)
    x1 = np.clip(np.ceil(tri_x.max(axis=1)).astype(int), 0, width - 1)
    y0 = np.clip(np.floor(tri_y.min(axis=1)).astype(int), 0, height - 1)
    y1 = np.clip(np.ceil(tri_y.max(axis=1)).astype(int), 0, height - 1)

    tex_h, tex_w = (texture.shape[0], texture.shape[1]) if texture is not None else (0, 0)
    order = np.argsort(-tri_z.mean(axis=1))       # far to near helps the z-test converge

    for t in order:
        if behind[t] or x1[t] <= x0[t] or y1[t] <= y0[t]:
            continue
        xs = np.arange(x0[t], x1[t] + 1)
        ys = np.arange(y0[t], y1[t] + 1)
        px, py = np.meshgrid(xs + 0.5, ys + 0.5)
        ax, ay = tri_x[t, 0], tri_y[t, 0]
        bx, by = tri_x[t, 1], tri_y[t, 1]
        cx, cy = tri_x[t, 2], tri_y[t, 2]
        denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(denom) < 1e-12:
            continue
        w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denom
        w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denom
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        inv_z = w0 / tri_z[t, 0] + w1 / tri_z[t, 1] + w2 / tri_z[t, 2]
        depth = 1.0 / np.maximum(inv_z, 1e-12)
        sub_y, sub_x = np.nonzero(inside)
        gy, gx = ys[sub_y], xs[sub_x]
        d = depth[inside]
        closer = d < zbuf[gy, gx]
        if not closer.any():
            continue
        gy, gx, d = gy[closer], gx[closer], d[closer]
        zbuf[gy, gx] = d

        if texture is not None and face_uvs is not None:
            uvs = face_uvs[t]
            pw0 = (w0 / tri_z[t, 0])[inside][closer] * d
            pw1 = (w1 / tri_z[t, 1])[inside][closer] * d
            pw2 = (w2 / tri_z[t, 2])[inside][closer] * d
            u = pw0 * uvs[0, 0] + pw1 * uvs[1, 0] + pw2 * uvs[2, 0]
            v = pw0 * uvs[0, 1] + pw1 * uvs[1, 1] + pw2 * uvs[2, 1]
            tx = np.clip((u * (tex_w - 1)).astype(int), 0, tex_w - 1)
            ty = np.clip(((1.0 - v) * (tex_h - 1)).astype(int), 0, tex_h - 1)
            color = texture[ty, tx].astype(np.float64)
        elif vertex_colors is not None:
            vc = vertex_colors[F[t]].astype(np.float64)
            color = (w0[inside][closer][:, None] * vc[0]
                     + w1[inside][closer][:, None] * vc[1]
                     + w2[inside][closer][:, None] * vc[2])
        else:
            color = np.full((d.shape[0], 3), 190.0)
        img[gy, gx] = np.clip(color * shade[t], 0, 255)

    return img.astype(np.uint8)


def render_points(points: np.ndarray, colors: np.ndarray | None = None,
                  width: int = 640, height: int = 640, azimuth_deg: float = 35.0,
                  elevation_deg: float = 20.0, background=(24, 26, 32),
                  up: np.ndarray | None = None) -> np.ndarray:
    P = np.asarray(points, dtype=np.float64)
    img = np.full((height, width, 3), background, dtype=np.uint8)
    if P.size == 0:
        return img
    up = np.array([0.0, 1.0, 0.0]) if up is None else up
    center = np.median(P, axis=0)
    radius = float(np.percentile(np.linalg.norm(P - center, axis=1), 95)) or 1.0
    az, el = np.radians(azimuth_deg), np.radians(elevation_deg)
    direction = np.array([np.cos(el) * np.sin(az), np.sin(el), np.cos(el) * np.cos(az)])
    view = _look_at(center + direction * radius * 3.0, center, up)
    cam = (view @ np.hstack([P, np.ones((P.shape[0], 1))]).T).T[:, :3]
    z = -cam[:, 2]
    ok = z > 1e-6
    focal = (height / 2.0) / np.tan(np.radians(20.0))
    sx = (cam[ok, 0] * focal / z[ok] + width / 2.0).astype(int)
    sy = (-cam[ok, 1] * focal / z[ok] + height / 2.0).astype(int)
    vis = (sx >= 0) & (sx < width) & (sy >= 0) & (sy < height)
    col = (colors[ok][vis] if colors is not None else np.full((vis.sum(), 3), 200, np.uint8))
    img[sy[vis], sx[vis]] = col
    return img
