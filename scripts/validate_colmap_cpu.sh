#!/usr/bin/env bash
# Validation probe: can COLMAP 4.1 produce a TEXTURED mesh on this Mac (no CUDA)?
# Not part of the app - this is the experiment that decides the architecture.
set -eo pipefail
export PATH=/opt/homebrew/bin:$PATH

IMAGES=${1:-/Users/maxlirio/Developer/SCANFORGE/data/testsets/fox/images}
WORK=${2:-/Users/maxlirio/Developer/SCANFORGE/data/testsets/fox/work}
rm -rf "$WORK"; mkdir -p "$WORK/sparse"

t() { local label=$1; shift; local s=$(date +%s); "$@" > "$WORK/$label.log" 2>&1 || { echo "FAIL $label (see $WORK/$label.log)"; tail -20 "$WORK/$label.log"; exit 1; }; echo "OK   $label  $(( $(date +%s) - s ))s"; }

t features colmap feature_extractor \
  --database_path "$WORK/db.db" --image_path "$IMAGES" \
  --ImageReader.single_camera 1 --ImageReader.camera_model SIMPLE_RADIAL \
  --FeatureExtraction.use_gpu 0 --FeatureExtraction.max_image_size 1600

t matching colmap exhaustive_matcher \
  --database_path "$WORK/db.db" --FeatureMatching.use_gpu 0

t mapper colmap mapper \
  --database_path "$WORK/db.db" --image_path "$IMAGES" --output_path "$WORK/sparse"

colmap model_analyzer --path "$WORK/sparse/0" 2>&1 | grep -v "^I2026" | head -12

t undistort colmap image_undistorter \
  --image_path "$IMAGES" --input_path "$WORK/sparse/0" --output_path "$WORK/dense" \
  --output_type COLMAP --max_image_size 1600

t mesh colmap delaunay_mesher \
  --input_path "$WORK/sparse/0" --input_type sparse --output_path "$WORK/mesh.ply"

ls -la "$WORK/mesh.ply"

mkdir -p "$WORK/textured"
t texture colmap mesh_texturer \
  --workspace_path "$WORK/dense" --input_path "$WORK/mesh.ply" --output_path "$WORK/textured"

ls -la "$WORK/textured"
echo "=== DONE ==="
