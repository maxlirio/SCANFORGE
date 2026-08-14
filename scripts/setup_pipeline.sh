#!/usr/bin/env bash
# Create the Python environment the reconstruction pipeline runs in.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/pipeline"

PY=${SCANFORGE_SETUP_PYTHON:-}
if [ -z "$PY" ]; then
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then PY=$(command -v "$candidate"); break; fi
  done
fi
[ -n "$PY" ] || { echo "No python3 found."; exit 1; }
echo "Using $PY ($("$PY" -V))"

"$PY" -m venv .venv
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -r requirements.txt
./.venv/bin/python -m scanforge.probe

if ! command -v colmap >/dev/null 2>&1 && [ -z "${COLMAP_BIN:-}" ]; then
  echo ""
  echo "COLMAP is not installed. The local provider needs it:"
  echo "  macOS:  brew install colmap"
  echo "  Ubuntu: sudo apt install colmap"
  echo "  else:   https://colmap.github.io/install.html"
fi
