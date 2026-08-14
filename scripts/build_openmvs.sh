#!/usr/bin/env bash
# Optional: build OpenMVS (AGPL-3.0) so the local provider gains CPU dense
# reconstruction. Not required to run SCANFORGE - the default COLMAP-only path
# works without it. See docs/OPENMVS.md.
set -euo pipefail
export PATH=/opt/homebrew/bin:$PATH

PREFIX=${OPENMVS_PREFIX:-$HOME/.scanforge/openmvs}
SRC=${OPENMVS_SRC:-$HOME/.scanforge/src}
JOBS=$(sysctl -n hw.ncpu)

brew list cmake >/dev/null 2>&1 || brew install cmake
for pkg in boost eigen cgal opencv ceres-solver glew glfw; do
  brew list "$pkg" >/dev/null 2>&1 || brew install "$pkg"
done

mkdir -p "$SRC"
cd "$SRC"
[ -d vcglib ] || git clone --depth 1 https://github.com/cdcseacave/VCG.git vcglib
[ -d openMVS ] || git clone --depth 1 --recurse-submodules https://github.com/cdcseacave/openMVS.git

# OpenMVS still targets Eigen 3.4; Homebrew now ships Eigen 5.x, which is a
# different API generation. Fetch a pinned 3.4 tree next to the source.
if [ ! -d "$SRC/eigen-3.4.0" ]; then
  curl -sL https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz -o eigen.tgz
  tar xf eigen.tgz && rm eigen.tgz
fi

mkdir -p openMVS/build && cd openMVS/build
cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DVCG_ROOT="$SRC/vcglib" \
  -DEIGEN3_INCLUDE_DIR="$SRC/eigen-3.4.0" \
  -DOpenMVS_USE_CUDA=OFF \
  -DOpenMVS_USE_OPENMP=ON \
  -DOpenMVS_BUILD_TOOLS=ON

cmake --build . -j "$JOBS"
cmake --install .
echo "OpenMVS installed to $PREFIX/bin"
ls "$PREFIX/bin"
