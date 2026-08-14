#!/usr/bin/env bash
# Download real photo sets for testing. Nothing is vendored into this repo -
# the images stay under data/testsets/ (gitignored) and belong to their authors.
#
#   scripts/fetch_testsets.sh [monstree|buddha|fox|all]
#
#   monstree  41 photos of a small tree ornament   github.com/alicevision/dataset_monstree
#   buddha    a Buddha figurine, CC-BY-4.0         github.com/alicevision/dataset_buddha
#   fox       50 photos of a dog, from instant-ngp github.com/NVlabs/instant-ngp
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHICH=${1:-all}

fetch_github_dir() {  # repo, path, dest, limit, pattern
  local repo=$1 path=$2 dest=$3 limit=${4:-999} pattern=${5:-.}
  mkdir -p "$dest"
  curl -s "https://api.github.com/repos/$repo/contents/$path" \
    | grep '"download_url"' | sed 's/.*: "//; s/".*//' \
    | grep -i "$pattern" | head -n "$limit" > /tmp/scanforge_urls.txt
  local n; n=$(wc -l < /tmp/scanforge_urls.txt | tr -d ' ')
  echo "  downloading $n files -> $dest"
  (cd "$dest" && xargs -n1 -P8 curl -sO < /tmp/scanforge_urls.txt)
}

if [ "$WHICH" = "monstree" ] || [ "$WHICH" = "all" ]; then
  echo "== monstree (41 photos, ~160 MB) =="
  fetch_github_dir alicevision/dataset_monstree full "$ROOT/data/testsets/monstree/images" 999 '\.JPG'
fi

if [ "$WHICH" = "buddha" ] || [ "$WHICH" = "all" ]; then
  echo "== buddha (30 photos, CC-BY-4.0, ~130 MB) =="
  fetch_github_dir alicevision/dataset_buddha buddha "$ROOT/data/testsets/buddha/images" 30 '_c\.png'
fi

if [ "$WHICH" = "fox" ] || [ "$WHICH" = "all" ]; then
  echo "== fox (50 photos, ~18 MB) =="
  fetch_github_dir NVlabs/instant-ngp data/nerf/fox/images "$ROOT/data/testsets/fox/images" 999 '\.jpg'
fi

echo "done:"
du -sh "$ROOT"/data/testsets/*/images 2>/dev/null || true
