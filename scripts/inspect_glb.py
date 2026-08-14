#!/usr/bin/env python
"""Validate a .glb the way a viewer would, and render it for a visual check.

    python scripts/inspect_glb.py model.glb [--render out.png]

Checks the container, the JSON chunk and every accessor's byte range, then
reports what a renderer will actually find: vertices, triangles, UVs, texture.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))

import numpy as np  # noqa: E402

COMPONENT = {5120: "i1", 5121: "u1", 5122: "i2", 5123: "u2", 5125: "u4", 5126: "f4"}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def load_glb(path: str):
    raw = Path(path).read_bytes()
    magic, version, length = struct.unpack("<III", raw[:12])
    assert magic == 0x46546C67, "not a GLB (bad magic)"
    assert version == 2, f"unexpected glTF version {version}"
    assert length == len(raw), f"header length {length} != file size {len(raw)}"
    offset, gltf, blob = 12, None, b""
    while offset < len(raw):
        chunk_len, chunk_type = struct.unpack("<II", raw[offset:offset + 8])
        data = raw[offset + 8: offset + 8 + chunk_len]
        if chunk_type == 0x4E4F534A:
            gltf = json.loads(data)
        elif chunk_type == 0x004E4942:
            blob = data
        offset += 8 + chunk_len
    assert gltf is not None, "no JSON chunk"
    return gltf, blob


def read_accessor(gltf, blob, index):
    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    dtype = np.dtype("<" + COMPONENT[acc["componentType"]])
    n = NCOMP[acc["type"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    need = acc["count"] * n * dtype.itemsize
    assert start + need <= len(blob), f"accessor {index} runs past the buffer"
    arr = np.frombuffer(blob, dtype=dtype, count=acc["count"] * n, offset=start)
    return arr.reshape(acc["count"], n) if n > 1 else arr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("--render", default="")
    ap.add_argument("--views", type=int, default=1)
    args = ap.parse_args()

    gltf, blob = load_glb(args.glb)
    prim = gltf["meshes"][0]["primitives"][0]
    attrs = prim["attributes"]

    pos = read_accessor(gltf, blob, attrs["POSITION"])
    idx = read_accessor(gltf, blob, prim["indices"])
    uv = read_accessor(gltf, blob, attrs["TEXCOORD_0"]) if "TEXCOORD_0" in attrs else None
    nrm = read_accessor(gltf, blob, attrs["NORMAL"]) if "NORMAL" in attrs else None

    print(f"generator   : {gltf['asset'].get('generator')}")
    print(f"vertices    : {pos.shape[0]:,}")
    print(f"triangles   : {idx.shape[0] // 3:,}")
    print(f"has UVs     : {uv is not None}")
    print(f"has normals : {nrm is not None}")
    print(f"bbox min/max: {np.round(pos.min(axis=0), 3).tolist()} {np.round(pos.max(axis=0), 3).tolist()}")
    print(f"materials   : {len(gltf.get('materials', []))}, textures: {len(gltf.get('textures', []))}")

    assert idx.max() < pos.shape[0], "index buffer references a vertex that does not exist"
    assert idx.shape[0] % 3 == 0, "index count is not a multiple of 3"
    assert np.isfinite(pos).all(), "NaN/Inf in positions"
    if uv is not None:
        assert np.isfinite(uv).all(), "NaN/Inf in UVs"
        print(f"uv range    : {uv.min():.3f} .. {uv.max():.3f}")

    texture = None
    if gltf.get("images"):
        from io import BytesIO
        from PIL import Image
        image = gltf["images"][0]
        view = gltf["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        data = blob[start: start + view["byteLength"]]
        img = Image.open(BytesIO(data)).convert("RGB")
        print(f"texture     : {img.width}x{img.height} {image.get('mimeType')} ({len(data):,} bytes)")
        texture = np.asarray(img)

    if args.render:
        from scanforge import render as sfrender
        faces = idx.reshape(-1, 3).astype(np.int64)
        # glTF UVs are top-left origin; the renderer expects bottom-left, so undo
        # the flip the exporter applied instead of flipping a second time.
        face_uvs = None
        if uv is not None:
            flipped = uv.copy()
            flipped[:, 1] = 1.0 - flipped[:, 1]
            face_uvs = flipped[faces]
        frames = []
        for i in range(args.views):
            frames.append(sfrender.render(
                pos, faces, 512, 512, face_uvs=face_uvs, texture=texture,
                azimuth_deg=35 + i * (360 / max(args.views, 1)), elevation_deg=18))
        from PIL import Image
        strip = np.concatenate(frames, axis=1)
        Image.fromarray(strip).save(args.render)
        print(f"rendered    : {args.render}")

    print("GLB OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
