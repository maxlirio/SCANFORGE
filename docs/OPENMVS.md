# The optional OpenMVS dense tier

## What it buys you

Without CUDA, SCANFORGE builds its surface from the **sparse** point cloud that
structure-from-motion produces — tens of thousands of points for a typical object.
That is enough for a recognisable, photo-textured model but not for fine geometric
detail.

OpenMVS adds CPU **dense** reconstruction (`DensifyPointCloud`), which turns those
tens of thousands of points into millions before meshing. It is the single largest
quality upgrade available on a machine with no NVIDIA GPU.

The pipeline auto-detects it: if `InterfaceCOLMAP`, `DensifyPointCloud` and
`ReconstructMesh` are on `PATH` or in `$OPENMVS_BIN_DIR`, the tier switches from
`sparse` to `openmvs-dense` with no configuration. `npm run doctor` shows which
tier is active.

## Why it is not installed by default

**Licence.** OpenMVS is **AGPL-3.0**. SCANFORGE is a network service, which is
exactly the case the AGPL's §13 network clause is written for. Bundling it would
push AGPL obligations onto anyone who deploys this. Keeping it as an optional,
operator-installed external binary keeps that decision with the operator. If you
enable it, make sure you understand what your deployment then owes.

**It does not currently build against Homebrew's dependency set.** Attempted on
2026-08-13, macOS 26.3 / Apple M4:

| Step | Result |
|---|---|
| `brew install boost eigen cgal opencv ceres-solver nanoflann` | fine |
| clone VCG + openMVS | fine |
| `cmake` | **fails** |

The failures are dependency-generation mismatches, not a broken build script:
Homebrew now ships **OpenCV 5.0** and **Eigen 5.0**, while OpenMVS targets OpenCV 4
and Eigen 3.4; CMake also required `nanoflann` and then `TinyEXIF` config packages
that Homebrew does not provide. `scripts/build_openmvs.sh` records the attempt and
pins an Eigen 3.4 checkout, but it did **not** produce working binaries here.

> The `openmvs-dense` code path in `pipeline/scanforge/openmvs.py` is therefore
> **written but unverified in this environment**. It is guarded: if any OpenMVS
> step throws, the pipeline logs a warning and falls back to sparse meshing rather
> than failing the scan.

## How to actually get it working

The reliable routes, in order of effort:

1. **Linux + apt/conda**, where the dependency generations line up:
   ```bash
   git clone --recurse-submodules https://github.com/cdcseacave/openMVS
   git clone https://github.com/cdcseacave/VCG.git vcglib
   cmake -S openMVS -B build -DVCG_ROOT=$PWD/vcglib -DOpenMVS_USE_CUDA=OFF
   cmake --build build -j
   export OPENMVS_BIN_DIR=$PWD/build/bin
   ```
2. **vcpkg on macOS**, which builds pinned OpenCV 4 / Eigen 3.4 from source
   (roughly an hour of compiling):
   ```bash
   git clone https://github.com/microsoft/vcpkg && ./vcpkg/bootstrap-vcpkg.sh
   ./vcpkg/vcpkg install opencv4 cgal boost-iostreams boost-program-options eigen3
   cmake -S openMVS -B build \
     -DCMAKE_TOOLCHAIN_FILE=$PWD/vcpkg/scripts/buildsystems/vcpkg.cmake \
     -DVCG_ROOT=$PWD/vcglib -DOpenMVS_USE_CUDA=OFF
   ```
3. **Don't.** Point `SCANFORGE_PROVIDER` at a machine that has CUDA instead — the
   pipeline detects CUDA COLMAP automatically and uses `patch_match_stereo` +
   `stereo_fusion`, which is better than OpenMVS on CPU and needs no AGPL code.

## Verifying

```bash
OPENMVS_BIN_DIR=/path/to/bin npm run doctor      # expect tier: openmvs-dense
```
Then run a scan and check `result.json`: `"tier": "openmvs-dense"` and a
`points_dense.ply` in the outputs.
