"""Environment probe. Prints one JSON object describing what this machine can do.

    python -m scanforge.probe
"""
from __future__ import annotations

import json
import sys

from . import colmap, openmvs


def probe() -> dict:
    caps = colmap.probe()
    mvs = openmvs.bin_dir()
    if caps.cuda:
        tier = "cuda-dense"
    elif mvs:
        tier = "openmvs-dense"
    else:
        tier = "sparse"
    return {
        "colmap": caps.to_dict(),
        "openmvs": {"available": mvs is not None, "binDir": mvs},
        "tier": tier,
        "python": sys.version.split()[0],
    }


if __name__ == "__main__":
    print(json.dumps(probe()))
