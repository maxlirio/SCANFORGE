"""Structured progress events.

The pipeline speaks to the API server over stdout as newline-delimited JSON.
Every event is one line. The contract is mirrored in packages/shared/src/index.ts.

Progress rule: `progress` is either a real fraction in [0,1] derived from the
tool's own output, or `None` meaning "working, duration unknown". It is never
interpolated, animated or guessed.
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any, Optional

# Display groups shown to the user. Internal stages map onto these.
GROUP_PREPARE = "preparing"
GROUP_GEOMETRY = "geometry"
GROUP_TEXTURE = "texture"
GROUP_PACKAGE = "packaging"

STAGE_GROUPS = {
    "preparing": GROUP_PREPARE,
    "features": GROUP_GEOMETRY,
    "matching": GROUP_GEOMETRY,
    "sparse": GROUP_GEOMETRY,
    "filtering": GROUP_GEOMETRY,
    "dense": GROUP_GEOMETRY,
    "meshing": GROUP_GEOMETRY,
    "texturing": GROUP_TEXTURE,
    "packaging": GROUP_PACKAGE,
}


def _write(payload: dict[str, Any]) -> None:
    payload["ts"] = time.time()
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def stage_start(stage: str, message: str, determinate: bool = False) -> None:
    _write({
        "type": "stage",
        "stage": stage,
        "group": STAGE_GROUPS.get(stage, GROUP_GEOMETRY),
        "status": "start",
        "progress": 0.0 if determinate else None,
        "message": message,
    })


def stage_progress(stage: str, progress: Optional[float], message: str) -> None:
    _write({
        "type": "stage",
        "stage": stage,
        "group": STAGE_GROUPS.get(stage, GROUP_GEOMETRY),
        "status": "progress",
        "progress": None if progress is None else max(0.0, min(1.0, progress)),
        "message": message,
    })


def stage_end(stage: str, message: str, seconds: float) -> None:
    _write({
        "type": "stage",
        "stage": stage,
        "group": STAGE_GROUPS.get(stage, GROUP_GEOMETRY),
        "status": "end",
        "progress": 1.0,
        "message": message,
        "seconds": round(seconds, 2),
    })


def log(message: str, level: str = "info") -> None:
    _write({"type": "log", "level": level, "message": message})


def warn(message: str) -> None:
    _write({"type": "log", "level": "warn", "message": message})


def result(payload: dict[str, Any]) -> None:
    _write({"type": "result", "result": payload})


def error(message: str, detail: str = "") -> None:
    _write({"type": "error", "message": message, "detail": detail})
