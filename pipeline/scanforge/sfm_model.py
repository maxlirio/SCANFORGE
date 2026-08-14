"""Read COLMAP's text model export and derive object framing.

Two jobs:
  1. parse cameras/images/points from `model_converter --output_type TXT`
  2. work out (a) which part of the reconstruction is *the object* and
     (b) which way is up, so the exported model isn't arbitrarily oriented.

Up-axis heuristic: for an orbit capture the camera centres lie close to a plane
(or a band) around the object, so the smallest-variance direction of the camera
centres is the world up axis. The sign is resolved by the fact that people shoot
slightly *downward* at an object on a table: the mean camera forward vector has a
negative component along up. If the cameras are too poorly spread for that to
mean anything we say so and leave the model unrotated.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class SfmModel:
    points: np.ndarray            # (N,3)
    colors: np.ndarray            # (N,3) uint8
    track_lengths: np.ndarray     # (N,)
    errors: np.ndarray            # (N,)
    centers: np.ndarray           # (M,3) camera centres
    forwards: np.ndarray          # (M,3) camera viewing directions
    names: list[str] = field(default_factory=list)

    @property
    def num_points(self) -> int:
        return int(self.points.shape[0])

    @property
    def num_images(self) -> int:
        return int(self.centers.shape[0])


def _quat_to_rot(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def read_model(txt_dir: str) -> SfmModel:
    import os

    pts, cols, tracks, errs = [], [], [], []
    with open(os.path.join(txt_dir, "points3D.txt"), encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.split()
            pts.append([float(parts[1]), float(parts[2]), float(parts[3])])
            cols.append([int(parts[4]), int(parts[5]), int(parts[6])])
            errs.append(float(parts[7]))
            tracks.append((len(parts) - 8) // 2)

    centers, forwards, names = [], [], []
    with open(os.path.join(txt_dir, "images.txt"), encoding="utf-8") as fh:
        first_of_pair = True
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            if not first_of_pair:            # the POINTS2D line
                first_of_pair = True
                continue
            parts = line.split()
            q = np.array([float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])])
            t = np.array([float(parts[5]), float(parts[6]), float(parts[7])])
            R = _quat_to_rot(q)              # world -> camera
            centers.append(-R.T @ t)         # camera centre in world
            forwards.append(R.T @ np.array([0.0, 0.0, 1.0]))  # camera looks +Z
            names.append(parts[9] if len(parts) > 9 else "")
            first_of_pair = False

    return SfmModel(
        points=np.asarray(pts, dtype=np.float64).reshape(-1, 3),
        colors=np.asarray(cols, dtype=np.uint8).reshape(-1, 3),
        track_lengths=np.asarray(tracks, dtype=np.int32),
        errors=np.asarray(errs, dtype=np.float64),
        centers=np.asarray(centers, dtype=np.float64).reshape(-1, 3),
        forwards=np.asarray(forwards, dtype=np.float64).reshape(-1, 3),
        names=names,
    )


def object_box(model: SfmModel, keep_percentile: float = 88.0, pad: float = 0.08
               ) -> tuple[np.ndarray, np.ndarray, dict]:
    """Robustly bound the thing the cameras were pointed at.

    Points seen by more cameras are far more likely to belong to the subject than
    to the background, so the centre is a track-length-weighted median, and we
    then keep the inner `keep_percentile`% of points by distance from it.
    """
    pts = model.points
    if pts.shape[0] < 32:
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        return lo, hi, {"kept": int(pts.shape[0]), "total": int(pts.shape[0]), "method": "bbox-all"}

    weights = np.clip(model.track_lengths, 1, 20).astype(np.float64)
    order = np.argsort(pts, axis=0)
    center = np.empty(3)
    for axis in range(3):
        idx = order[:, axis]
        cw = np.cumsum(weights[idx])
        center[axis] = pts[idx[np.searchsorted(cw, cw[-1] * 0.5)], axis]

    # Two refinement passes: tighten onto the dense core, ignoring outliers.
    for _ in range(2):
        d = np.linalg.norm(pts - center, axis=1)
        cut = np.percentile(d, keep_percentile)
        inner = d <= cut
        if inner.sum() < 32:
            break
        center = np.average(pts[inner], axis=0, weights=weights[inner])

    d = np.linalg.norm(pts - center, axis=1)
    cut = np.percentile(d, keep_percentile)
    keep = d <= cut
    kept = pts[keep]
    lo, hi = kept.min(axis=0), kept.max(axis=0)
    span = np.maximum(hi - lo, 1e-6)
    lo = lo - span * pad
    hi = hi + span * pad
    return lo, hi, {"kept": int(keep.sum()), "total": int(pts.shape[0]), "method": "weighted-core"}


def up_axis(model: SfmModel) -> tuple[np.ndarray, float, str]:
    """Return (up_vector, confidence 0..1, explanation)."""
    C = model.centers
    if C.shape[0] < 6:
        return np.array([0.0, -1.0, 0.0]), 0.0, "too few cameras to estimate up"
    centered = C - C.mean(axis=0)
    _, s, vt = np.linalg.svd(centered, full_matrices=False)
    up = vt[2]                                  # least-variance direction
    # Confidence: how flat is the camera distribution? A ring is flat (s3 << s2).
    flatness = 1.0 - (s[2] / max(s[1], 1e-9))
    mean_fwd = model.forwards.mean(axis=0)
    if float(np.dot(mean_fwd, up)) > 0:         # cameras should look *down*
        up = -up
    up = up / max(np.linalg.norm(up), 1e-9)
    return up, float(np.clip(flatness, 0.0, 1.0)), "camera-plane normal"


def orientation_matrix(up: np.ndarray) -> np.ndarray:
    """Rotation taking `up` onto +Y (glTF's up axis)."""
    up = up / max(np.linalg.norm(up), 1e-9)
    target = np.array([0.0, 1.0, 0.0])
    v = np.cross(up, target)
    c = float(np.dot(up, target))
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))
