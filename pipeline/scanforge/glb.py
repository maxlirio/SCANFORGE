"""Write a self-contained binary glTF (.glb) — no external 3D library.

Two flavours, matching what the pipeline can produce:
  * textured   : per-corner UVs + one baseColor texture (the photogrammetric case)
  * vertex-lit : per-vertex COLOR_0 (fallback when no texture atlas was produced)

Writing this by hand rather than via a mesh library keeps the exporter honest
about the exact buffer layout, which matters because COLMAP hands us per-*corner*
UVs that have to be de-indexed before glTF can represent them.
"""
from __future__ import annotations

import json
import struct

import numpy as np


def _pad4(data: bytes, fill: bytes = b"\x00") -> bytes:
    rem = len(data) % 4
    return data if rem == 0 else data + fill * (4 - rem)


def compute_vertex_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Area-weighted smooth normals on the shared-vertex mesh."""
    v = vertices.astype(np.float64)
    n = np.zeros_like(v)
    a, b, c = v[faces[:, 0]], v[faces[:, 1]], v[faces[:, 2]]
    fn = np.cross(b - a, c - a)          # magnitude == 2 * triangle area
    for k in range(3):
        np.add.at(n, faces[:, k], fn)
    lens = np.linalg.norm(n, axis=1, keepdims=True)
    return (n / np.maximum(lens, 1e-12)).astype(np.float32)


def build(
    vertices: np.ndarray,
    faces: np.ndarray,
    face_uvs: np.ndarray | None = None,
    texture_bytes: bytes | None = None,
    texture_mime: str = "image/jpeg",
    vertex_colors: np.ndarray | None = None,
    name: str = "scan",
    flip_v: bool = True,
) -> bytes:
    vertices = np.asarray(vertices, dtype=np.float32)
    faces = np.asarray(faces, dtype=np.uint32)
    normals = compute_vertex_normals(vertices, faces)

    if face_uvs is not None and texture_bytes is not None:
        # De-index: every triangle corner becomes its own vertex so it can carry
        # its own UV. 20k triangles -> 60k vertices, which is fine for the web.
        pos = vertices[faces].reshape(-1, 3)
        nrm = normals[faces].reshape(-1, 3)
        uv = np.asarray(face_uvs, dtype=np.float32).reshape(-1, 2).copy()
        if flip_v:
            uv[:, 1] = 1.0 - uv[:, 1]     # PLY/OpenGL origin is bottom-left, glTF's is top-left
        idx = np.arange(pos.shape[0], dtype=np.uint32)
        colors = None
    else:
        pos, nrm, idx = vertices, normals, faces.reshape(-1)
        uv = None
        colors = None
        if vertex_colors is not None:
            colors = (np.asarray(vertex_colors, dtype=np.float32) / 255.0).astype(np.float32)

    buffers: list[bytes] = []
    views: list[dict] = []
    accessors: list[dict] = []
    offset = 0

    def add_view(data: bytes, target: int | None = None) -> int:
        nonlocal offset
        data = _pad4(data)
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data),
                      **({"target": target} if target else {})})
        buffers.append(data)
        offset += len(data)
        return len(views) - 1

    def add_accessor(data: np.ndarray, comp_type: int, type_str: str,
                     target: int | None = None, minmax: bool = False) -> int:
        view = add_view(data.tobytes(), target)
        acc = {"bufferView": view, "componentType": comp_type,
               "count": int(data.shape[0]), "type": type_str}
        if minmax:
            acc["min"] = [float(x) for x in np.atleast_1d(data.min(axis=0))]
            acc["max"] = [float(x) for x in np.atleast_1d(data.max(axis=0))]
        accessors.append(acc)
        return len(accessors) - 1

    FLOAT, UINT = 5126, 5125
    ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963

    attributes = {
        "POSITION": add_accessor(pos.astype(np.float32), FLOAT, "VEC3", ARRAY_BUFFER, minmax=True),
        "NORMAL": add_accessor(nrm.astype(np.float32), FLOAT, "VEC3", ARRAY_BUFFER),
    }
    if uv is not None:
        attributes["TEXCOORD_0"] = add_accessor(uv.astype(np.float32), FLOAT, "VEC2", ARRAY_BUFFER)
    if colors is not None:
        attributes["COLOR_0"] = add_accessor(colors.astype(np.float32), FLOAT, "VEC3", ARRAY_BUFFER)
    index_acc = add_accessor(idx.astype(np.uint32), UINT, "SCALAR", ELEMENT_ARRAY_BUFFER)

    gltf: dict = {
        "asset": {"version": "2.0", "generator": "SCANFORGE photogrammetry pipeline"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [
            {"attributes": attributes, "indices": index_acc, "material": 0, "mode": 4}]}],
        "materials": [{
            "name": "scan_material",
            "doubleSided": True,
            "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.95},
        }],
        "accessors": accessors,
        "bufferViews": views,
    }

    if texture_bytes is not None and uv is not None:
        img_view = add_view(texture_bytes)
        gltf["images"] = [{"bufferView": img_view, "mimeType": texture_mime, "name": "baseColor"}]
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
        gltf["textures"] = [{"sampler": 0, "source": 0}]
        gltf["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}

    bin_blob = b"".join(buffers)
    gltf["buffers"] = [{"byteLength": len(bin_blob)}]

    json_blob = _pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    bin_blob = _pad4(bin_blob)

    header = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_blob) + 8 + len(bin_blob))
    return (header
            + struct.pack("<II", len(json_blob), 0x4E4F534A) + json_blob
            + struct.pack("<II", len(bin_blob), 0x004E4942) + bin_blob)


def write(path: str, **kwargs) -> int:
    data = build(**kwargs)
    with open(path, "wb") as fh:
        fh.write(data)
    return len(data)
