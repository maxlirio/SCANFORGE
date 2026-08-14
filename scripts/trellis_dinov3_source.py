#!/usr/bin/env python3
"""Repoint TRELLIS.2's two gated dependencies at sources you can actually fetch.

Out of the box TRELLIS.2 will not run without:
  * facebook/dinov3-vitl16  - Meta gates it behind *manual* approval (days)
  * briaai/RMBG-2.0         - gated, click-through, needs an account

Neither is essential to the method: a community mirror carries the identical
DINOv3 weights (with Meta's LICENSE.md), and RMBG-2.0 is a BiRefNet-architecture
matting model that the code already knows how to load - its own default is the
ungated ZhengPeng7/BiRefNet.

    python scripts/trellis_dinov3_source.py --mirror     # unblock now, no account
    python scripts/trellis_dinov3_source.py --official   # switch back once approved

Licence note: the DINOv3 weights remain under Meta's licence either way; this
only changes where they are fetched from. The official route is Meta's approval.
"""
import argparse, glob, json, os, sys

# (gated original, ungated equivalent)
SWAPS = [
    ("facebook/dinov3-vitl16-pretrain-lvd1689m", "camenduru/dinov3-vitl16-pretrain-lvd1689m"),
    ("briaai/RMBG-2.0", "ZhengPeng7/BiRefNet"),
]

def patch(use_official: bool) -> int:
    root = os.path.expanduser("~/.cache/huggingface/hub/models--microsoft--TRELLIS.2-4B/snapshots")
    files = glob.glob(os.path.join(root, "*", "*.json"))
    if not files:
        print("TRELLIS.2-4B is not downloaded yet.", file=sys.stderr)
        return 1
    changed = 0
    for path in files:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        original = text
        for gated, ungated in SWAPS:
            src, dst = (ungated, gated) if use_official else (gated, ungated)
            if src in text:
                text = text.replace(src, dst)
                print(f"  {os.path.basename(path)}: {src} -> {dst}")
        if text != original:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
            changed += 1
    print(f"{changed} file(s) updated." if changed else "Already set; nothing to do.")
    return 0

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--mirror", action="store_true", help="use ungated equivalents")
    g.add_argument("--official", action="store_true", help="use the gated originals")
    a = ap.parse_args()
    raise SystemExit(patch(use_official=a.official))
