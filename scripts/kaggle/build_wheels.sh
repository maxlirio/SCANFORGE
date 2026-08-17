#!/usr/bin/env bash
# Build TRELLIS.2's CUDA extensions once on a Kaggle GPU and publish them as a
# private dataset, so each generation installs wheels instead of compiling for
# 15-30 minutes.
#
#   scripts/kaggle/build_wheels.sh
#
# Needs ~/.kaggle/kaggle.json. Takes 20-40 minutes on Kaggle's side; you can close
# the terminal and re-run this to resume from wherever it got to.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/Library/Python/3.9/bin:$HOME/.local/bin:$PATH"
USER_NAME=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.kaggle/kaggle.json')))['username'])")

STAGE=$(mktemp -d)
cp "$ROOT/scripts/kaggle/build_wheels.py" "$STAGE/build.py"
cat > "$STAGE/kernel-metadata.json" <<JSON
{
  "id": "$USER_NAME/scanforge-build-wheels",
  "title": "scanforge-build-wheels",
  "code_file": "build.py",
  "language": "python",
  "kernel_type": "script",
  "is_private": true,
  "enable_gpu": true,
  "enable_internet": true,
  "dataset_sources": [],
  "competition_sources": [],
  "kernel_sources": []
}
JSON

echo "==> pushing the build kernel"
kaggle kernels push -p "$STAGE"

echo "==> waiting for it to finish (20-40 min)"
until kaggle kernels status "$USER_NAME/scanforge-build-wheels" 2>/dev/null | grep -qiE "complete|error"; do
  sleep 60
  printf '.'
done
echo ""
kaggle kernels status "$USER_NAME/scanforge-build-wheels"

echo "==> collecting the wheels"
OUT=$(mktemp -d)
kaggle kernels output "$USER_NAME/scanforge-build-wheels" -p "$OUT" >/dev/null
ls -la "$OUT/wheels" 2>/dev/null || { echo "no wheels were produced - read the log:"; tail -40 "$OUT"/*.log; exit 1; }

echo "==> publishing them as a private dataset"
DS=$(mktemp -d)/scanforge-wheels
mkdir -p "$DS/wheels"
cp "$OUT/wheels/"*.whl "$DS/wheels/" 2>/dev/null || true
cp "$OUT/manifest.json" "$DS/" 2>/dev/null || true
cat > "$DS/dataset-metadata.json" <<JSON
{
  "title": "scanforge-wheels",
  "id": "$USER_NAME/scanforge-wheels",
  "licenses": [{"name": "other"}]
}
JSON
kaggle datasets create -p "$DS" -r zip --dir-mode zip 2>/dev/null \
  || kaggle datasets version -p "$DS" -m "rebuild" -r zip --dir-mode zip

echo ""
echo "Done. Point SCANFORGE at it:  SCANFORGE_KAGGLE_WHEELS=$USER_NAME/scanforge-wheels"
