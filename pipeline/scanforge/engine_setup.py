"""Fetch the model weights the 3D engine needs, and point it at sources that work.

Runs inside the engine's own virtualenv during first-run setup:

    <root>/.venv/bin/python -m scanforge.engine_setup --trellis-root <root>

Prints one JSON object per line so the app can show real download progress.

Why ungated sources by default: TRELLIS.2 itself is open, but its pipeline config
names two repositories that are not. `facebook/dinov3-*` needs *manual* approval
from Meta, which can take days and cannot be automated; `briaai/RMBG-2.0` needs an
account. Neither is essential — a public mirror carries the identical DINOv3
weights, and the background remover the code already defaults to (BiRefNet) is
ungated. An installed app cannot ask its user to go and negotiate a licence before
it will start, so it uses those, states the licences, and can be switched to the
official repositories afterwards with scripts/trellis_dinov3_source.py.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

TRELLIS_REPO = "microsoft/TRELLIS.2-4B"
# (what the pipeline config asks for, what we fetch instead)
SUBSTITUTIONS = [
    ("facebook/dinov3-vitl16-pretrain-lvd1689m", "camenduru/dinov3-vitl16-pretrain-lvd1689m"),
    ("briaai/RMBG-2.0", "ZhengPeng7/BiRefNet"),
]


def emit(message: str, progress: float | None = None) -> None:
    sys.stdout.write(json.dumps({"message": message, "progress": progress}) + "\n")
    sys.stdout.flush()


def fetch(repo: str, label: str) -> str:
    """Download a repository snapshot, reporting progress from real byte counts."""
    from huggingface_hub import snapshot_download

    state = {"last": 0.0}

    class Progress:
        """tqdm-compatible enough for huggingface_hub to drive."""

        def __init__(self, *_, total=None, **kwargs):
            self.total = total or 0
            self.n = 0
            self.desc = kwargs.get("desc") or label

        def update(self, amount=1):
            self.n += amount
            now = time.time()
            if self.total and now - state["last"] > 0.4:
                state["last"] = now
                emit(f"{label}: {self.n / 1e9:.1f} of {self.total / 1e9:.1f} GB",
                     min(1.0, self.n / self.total))

        def close(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        # huggingface_hub touches a few other tqdm members.
        def set_description(self, *_a, **_k):
            pass

        def refresh(self):
            pass

        @property
        def disable(self):
            return False

    emit(f"{label}: starting", None)
    try:
        return snapshot_download(repo, max_workers=8, tqdm_class=Progress)
    except TypeError:
        # Older huggingface_hub without tqdm_class: no per-byte progress available.
        emit(f"{label}: downloading (no progress available from this version)", None)
        return snapshot_download(repo, max_workers=8)


def can_access(repo: str) -> bool:
    """Is this repository actually fetchable with whatever credentials exist?"""
    from huggingface_hub import HfApi
    try:
        HfApi().model_info(repo)
        return True
    except Exception:
        return False


def repoint_pipeline_configs() -> int:
    """Substitute gated repositories only where the official one is unreachable.

    These configs live in the shared Hugging Face cache, so an unconditional
    rewrite would downgrade someone who *does* have Meta's approval. Check first,
    and leave the official name in place whenever it works.
    """
    import glob

    root = os.path.expanduser(
        "~/.cache/huggingface/hub/models--microsoft--TRELLIS.2-4B/snapshots")
    needed = []
    for gated, ungated in SUBSTITUTIONS:
        if can_access(gated):
            emit(f"Using the official {gated} (you have access)", None)
        else:
            emit(f"{gated} is gated here; using {ungated} instead", None)
            needed.append((gated, ungated))
    if not needed:
        return 0

    changed = 0
    for path in glob.glob(os.path.join(root, "*", "*.json")):
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        original = text
        for gated, ungated in needed:
            text = text.replace(gated, ungated)
        if text != original:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
            changed += 1
    return changed


def patch_rembg_dtype(trellis_root: str) -> bool:
    """The port runs in half precision; its matting model builds a float32 tensor."""
    target = os.path.join(trellis_root, "TRELLIS.2", "trellis2", "pipelines",
                          "rembg", "BiRefNet.py")
    if not os.path.exists(target):
        return False
    old = """        input_images = self.transform_image(image).unsqueeze(0).to(self.device)
        # Prediction
        with torch.no_grad():
            preds = self.model(input_images)[-1].sigmoid().cpu()"""
    new = """        model_dtype = next(self.model.parameters()).dtype
        input_images = self.transform_image(image).unsqueeze(0).to(self.device, model_dtype)
        # Prediction
        with torch.no_grad():
            preds = self.model(input_images)[-1].sigmoid().float().cpu()"""
    text = open(target, encoding="utf-8").read()
    if new in text:
        return True
    if old not in text:
        return False
    open(target, "w", encoding="utf-8").write(text.replace(old, new))
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trellis-root", required=True)
    args = ap.parse_args()

    emit("Fetching the 3D model (about 16 GB)", None)
    fetch(TRELLIS_REPO, "3D model")

    changed = repoint_pipeline_configs()
    emit(f"Pointed {changed} pipeline config(s) at ungated model sources", None)

    # Fetch whichever source the configs ended up naming.
    for (gated, ungated), label in zip(SUBSTITUTIONS, ["Image encoder", "Background remover"]):
        fetch(gated if can_access(gated) else ungated, label)

    if patch_rembg_dtype(args.trellis_root):
        emit("Applied the half-precision fix to the background remover", None)
    else:
        emit("Background remover did not need patching", None)

    emit("Weights ready", 1.0)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stdout.write(json.dumps({"message": f"error: {exc}"}) + "\n")
        raise SystemExit(1)
