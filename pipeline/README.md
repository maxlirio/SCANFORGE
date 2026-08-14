# SCANFORGE reconstruction pipeline

Standalone: it does not import anything from the web app, and can be run on its
own against a folder of photographs.

```bash
python -m scanforge.probe        # what can this machine do?
python -m scanforge.run --images IN --work SCRATCH --out OUT \
    --quality balanced --mode object
```

Stdout is newline-delimited JSON progress events (`pipeline/scanforge/events.py`,
mirrored in `packages/shared/src/index.ts`). Exit code 0 means `OUT` holds a model.

| Module | Responsibility |
|---|---|
| `run.py` | orchestration, export, thumbnail, `result.json` |
| `colmap.py` | COLMAP CLI wrappers + progress parsing from its own output |
| `prepare.py` | EXIF orientation, resizing, sharpness gate |
| `sfm_model.py` | reads COLMAP's text model; up-axis and object-crop estimation |
| `ply.py` / `glb.py` | mesh I/O; hand-written GLB exporter |
| `render.py` | numpy software rasteriser (thumbnails, headless QA) |
| `openmvs.py` | optional AGPL dense tier — see `docs/OPENMVS.md`, unverified here |

Only `numpy` and `Pillow` are required. COLMAP is an external binary.
