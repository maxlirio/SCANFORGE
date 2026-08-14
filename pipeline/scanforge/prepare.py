"""Image intake: orientation, resizing, and an honest sharpness gate.

Blurry frames actively damage structure-from-motion (they generate features that
match nothing, or worse, match wrongly), so we drop the worst offenders. The rule
is deliberately conservative: never drop more than 20% of a capture, never drop
anything unless there are enough frames left to reconstruct from, and always
report exactly what was dropped and why.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, asdict

import numpy as np
from PIL import Image, ImageOps

from . import events

VALID_EXT = {".jpg", ".jpeg", ".png", ".heic", ".webp", ".bmp", ".tif", ".tiff"}

# Laplacian kernel used for the sharpness estimate.
_LAP = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float32)


@dataclass
class ImageReport:
    name: str
    width: int
    height: int
    sharpness: float
    brightness: float
    kept: bool
    reason: str = ""


def _sharpness(gray: np.ndarray) -> float:
    """Variance of the Laplacian on a fixed-width grayscale image."""
    a = gray
    lap = (a[:-2, 1:-1] + a[2:, 1:-1] + a[1:-1, :-2] + a[1:-1, 2:] - 4.0 * a[1:-1, 1:-1])
    return float(lap.var())


def prepare_images(
    src_dir: str,
    dst_dir: str,
    max_edge: int = 1600,
    jpeg_quality: int = 95,
    max_images: int = 250,
    drop_blurry: bool = True,
) -> tuple[list[ImageReport], list[str]]:
    os.makedirs(dst_dir, exist_ok=True)
    names = sorted(n for n in os.listdir(src_dir)
                   if os.path.splitext(n)[1].lower() in VALID_EXT and not n.startswith("."))
    if not names:
        raise RuntimeError(f"No images found in {src_dir}")
    if len(names) > max_images:
        step = len(names) / max_images
        names = [names[int(i * step)] for i in range(max_images)]
        events.warn(f"Capture had more than {max_images} photos; using an evenly spaced subset.")

    started = time.time()
    events.stage_start("preparing", "Reading and checking photos", determinate=True)
    reports: list[ImageReport] = []
    staged: list[tuple[str, Image.Image]] = []

    for i, name in enumerate(names):
        path = os.path.join(src_dir, name)
        try:
            img = Image.open(path)
            img = ImageOps.exif_transpose(img).convert("RGB")
        except Exception as exc:
            reports.append(ImageReport(name, 0, 0, 0.0, 0.0, False, f"unreadable ({exc})"))
            continue

        w, h = img.size
        if max(w, h) > max_edge:
            scale = max_edge / max(w, h)
            img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)

        probe = np.asarray(img.convert("L").resize((512, max(1, round(512 * img.height / img.width))),
                                                   Image.BILINEAR), dtype=np.float32)
        reports.append(ImageReport(name, img.width, img.height,
                                   _sharpness(probe), float(probe.mean()), True))
        staged.append((name, img))
        events.stage_progress("preparing", (i + 1) / len(names), f"Photo {i + 1} of {len(names)}")

    sharp = np.array([r.sharpness for r in reports if r.kept])
    if drop_blurry and len(sharp) >= 15:
        median = float(np.median(sharp))
        threshold = max(median * 0.35, 8.0)
        candidates = [r for r in reports if r.kept and r.sharpness < threshold]
        # Never throw away more than a fifth of the capture.
        budget = max(0, int(len(sharp) * 0.2))
        for r in sorted(candidates, key=lambda r: r.sharpness)[:budget]:
            r.kept = False
            r.reason = f"too blurry (sharpness {r.sharpness:.1f} vs median {median:.1f})"
        dropped = sum(1 for r in reports if not r.kept and r.reason.startswith("too blurry"))
        if dropped:
            events.warn(f"Skipped {dropped} blurry photo(s); {len(sharp) - dropped} usable.")

    kept_names = {r.name for r in reports if r.kept}
    written: list[str] = []
    for name, img in staged:
        if name not in kept_names:
            continue
        out_name = os.path.splitext(name)[0] + ".jpg"
        img.save(os.path.join(dst_dir, out_name), "JPEG", quality=jpeg_quality, subsampling=1)
        written.append(out_name)

    bright = np.array([r.brightness for r in reports if r.kept]) if kept_names else np.array([0.0])
    if bright.mean() < 45:
        events.warn("Photos are quite dark overall - reconstruction quality will suffer.")
    if bright.mean() > 225:
        events.warn("Photos look over-exposed; blown-out areas cannot be reconstructed.")

    events.stage_end("preparing", f"{len(written)} photos ready", time.time() - started)
    return reports, written


def reports_to_json(reports: list[ImageReport]) -> list[dict]:
    return [asdict(r) for r in reports]
