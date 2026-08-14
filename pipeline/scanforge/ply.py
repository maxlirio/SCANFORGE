"""Minimal binary PLY reader/writer for the shapes COLMAP actually emits.

Handles:
  * point clouds  (x y z [nx ny nz] [red green blue])
  * plain meshes  (vertex + face vertex_indices)
  * textured meshes from `colmap mesh_texturer`, which store *per-corner* UVs as
    a per-face list property `texcoord` plus a `comment TextureFile <name>` line.

List properties are variable length in general, but COLMAP's meshes are pure
triangle soups, so after verifying the first record we can read the whole block
with one structured dtype instead of a Python loop.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

_NP = {
    "char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1",
    "short": "i2", "int16": "i2", "ushort": "u2", "uint16": "u2",
    "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4",
    "float": "f4", "float32": "f4", "double": "f8", "float64": "f8",
}


@dataclass
class PlyMesh:
    vertices: np.ndarray                      # (V,3) float32
    faces: np.ndarray                         # (F,3) int32
    face_uvs: np.ndarray | None = None        # (F,3,2) float32, per corner
    vertex_colors: np.ndarray | None = None   # (V,3) uint8
    texture_file: str | None = None
    comments: list[str] = field(default_factory=list)


def read(path: str) -> PlyMesh:
    with open(path, "rb") as fh:
        raw = fh.read()
    end = raw.find(b"end_header")
    if end < 0:
        raise ValueError(f"{path}: not a PLY file")
    header = raw[:end].decode("ascii", "replace")
    body_start = raw.index(b"\n", end) + 1

    fmt = "binary_little_endian" if "binary_little_endian" in header else (
        "ascii" if "format ascii" in header else "binary_big_endian")
    if fmt == "binary_big_endian":
        raise ValueError("big-endian PLY not supported")

    comments = [ln[8:].strip() for ln in header.splitlines() if ln.startswith("comment ")]
    texture_file = None
    for c in comments:
        m = re.match(r"TextureFile\s+(.+)", c)
        if m:
            texture_file = m.group(1).strip()

    elements: list[tuple[str, int, list]] = []
    current: list | None = None
    for line in header.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "element":
            current = []
            elements.append((parts[1], int(parts[2]), current))
        elif parts[0] == "property" and current is not None:
            if parts[1] == "list":
                current.append(("list", parts[2], parts[3], parts[4]))
            else:
                current.append(("scalar", parts[1], parts[2]))

    if fmt == "ascii":
        return _read_ascii(raw[body_start:].decode("ascii", "replace"), elements, texture_file, comments)

    offset = body_start
    vertices = faces = face_uvs = colors = None

    for name, count, props in elements:
        if all(p[0] == "scalar" for p in props):
            dtype = np.dtype([(p[2], "<" + _NP[p[1]]) for p in props])
            block = np.frombuffer(raw, dtype=dtype, count=count, offset=offset)
            offset += dtype.itemsize * count
            if name == "vertex":
                vertices = np.stack([block["x"], block["y"], block["z"]], axis=1).astype(np.float32)
                if "red" in block.dtype.names:
                    colors = np.stack([block["red"], block["green"], block["blue"]], axis=1).astype(np.uint8)
            continue

        # Element with list properties (faces). Assume uniform record size.
        if count == 0:
            continue
        fixed_fields, probe_offset = [], offset
        for p in props:
            if p[0] == "scalar":
                fixed_fields.append((p[2], "<" + _NP[p[1]], 1))
                probe_offset += np.dtype(_NP[p[1]]).itemsize
            else:
                _, count_type, item_type, prop_name = p
                n = int(np.frombuffer(raw, dtype=_NP[count_type], count=1, offset=probe_offset)[0])
                probe_offset += np.dtype(_NP[count_type]).itemsize + np.dtype(_NP[item_type]).itemsize * n
                fixed_fields.append((prop_name + "_n", "<" + _NP[count_type], 1))
                fixed_fields.append((prop_name, "<" + _NP[item_type], n))

        dtype = np.dtype([(f[0], f[1], (f[2],)) for f in fixed_fields])
        block = np.frombuffer(raw, dtype=dtype, count=count, offset=offset)
        offset += dtype.itemsize * count
        if name == "face":
            key = "vertex_indices" if "vertex_indices" in block.dtype.names else "vertex_index"
            faces = block[key].astype(np.int32)
            if faces.shape[1] != 3:
                raise ValueError("only triangle meshes are supported")
            if "texcoord" in block.dtype.names:
                face_uvs = block["texcoord"].astype(np.float32).reshape(-1, 3, 2)

    if vertices is None:
        raise ValueError(f"{path}: no vertex element")
    return PlyMesh(
        vertices=vertices,
        faces=faces if faces is not None else np.zeros((0, 3), np.int32),
        face_uvs=face_uvs,
        vertex_colors=colors,
        texture_file=texture_file,
        comments=comments,
    )


def _read_ascii(body: str, elements, texture_file, comments) -> PlyMesh:
    lines = [ln for ln in body.splitlines() if ln.strip()]
    idx = 0
    vertices = colors = faces = None
    for name, count, props in elements:
        rows = lines[idx: idx + count]
        idx += count
        if name == "vertex":
            arr = np.array([[float(x) for x in r.split()] for r in rows], dtype=np.float64)
            names = [p[2] for p in props if p[0] == "scalar"]
            vertices = arr[:, [names.index("x"), names.index("y"), names.index("z")]].astype(np.float32)
            if "red" in names:
                colors = arr[:, [names.index("red"), names.index("green"), names.index("blue")]].astype(np.uint8)
        elif name == "face":
            faces = np.array([[int(x) for x in r.split()[1:4]] for r in rows], dtype=np.int32)
    return PlyMesh(vertices=vertices, faces=faces if faces is not None else np.zeros((0, 3), np.int32),
                   vertex_colors=colors, texture_file=texture_file, comments=comments)


def write_mesh(path: str, vertices: np.ndarray, faces: np.ndarray,
               vertex_colors: np.ndarray | None = None) -> None:
    """Binary little-endian PLY, optionally with per-vertex colour."""
    v = np.asarray(vertices, dtype="<f4")
    f = np.asarray(faces, dtype="<i4")
    head = ["ply", "format binary_little_endian 1.0", "comment created by SCANFORGE",
            f"element vertex {v.shape[0]}",
            "property float x", "property float y", "property float z"]
    if vertex_colors is not None:
        head += ["property uchar red", "property uchar green", "property uchar blue"]
    head += [f"element face {f.shape[0]}", "property list uchar int vertex_indices", "end_header", ""]
    with open(path, "wb") as fh:
        fh.write("\n".join(head).encode("ascii"))
        if vertex_colors is None:
            fh.write(v.tobytes())
        else:
            c = np.asarray(vertex_colors, dtype="u1")
            rec = np.zeros(v.shape[0], dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                                              ("r", "u1"), ("g", "u1"), ("b", "u1")])
            rec["x"], rec["y"], rec["z"] = v[:, 0], v[:, 1], v[:, 2]
            rec["r"], rec["g"], rec["b"] = c[:, 0], c[:, 1], c[:, 2]
            fh.write(rec.tobytes())
        face_rec = np.zeros(f.shape[0], dtype=[("n", "u1"), ("i", "<i4", (3,))])
        face_rec["n"] = 3
        face_rec["i"] = f
        fh.write(face_rec.tobytes())


def write_points(path: str, points: np.ndarray, colors: np.ndarray | None = None) -> None:
    p = np.asarray(points, dtype="<f4")
    head = ["ply", "format binary_little_endian 1.0", "comment created by SCANFORGE",
            f"element vertex {p.shape[0]}",
            "property float x", "property float y", "property float z"]
    if colors is not None:
        head += ["property uchar red", "property uchar green", "property uchar blue"]
    head += ["end_header", ""]
    with open(path, "wb") as fh:
        fh.write("\n".join(head).encode("ascii"))
        if colors is None:
            fh.write(p.tobytes())
        else:
            c = np.asarray(colors, dtype="u1")
            rec = np.zeros(p.shape[0], dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                                              ("r", "u1"), ("g", "u1"), ("b", "u1")])
            rec["x"], rec["y"], rec["z"] = p[:, 0], p[:, 1], p[:, 2]
            rec["r"], rec["g"], rec["b"] = c[:, 0], c[:, 1], c[:, 2]
            fh.write(rec.tobytes())
