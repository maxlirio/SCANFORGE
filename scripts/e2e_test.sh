#!/usr/bin/env bash
# End-to-end test against a running server: upload a real photo set through the
# public API, wait for the reconstruction, and check the downloaded GLB.
#
#   scripts/e2e_test.sh data/testsets/fox/images [quality] [mode]
set -euo pipefail

IMAGES=${1:?usage: e2e_test.sh <image-dir> [quality] [mode]}
QUALITY=${2:-fast}
MODE=${3:-object}
API=${SCANFORGE_API:-http://127.0.0.1:5174}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== health =="
curl -sf "$API/api/health" | python3 -m json.tool | head -20

JOB=$(curl -sf -X POST "$API/api/jobs" -H 'content-type: application/json' \
  -d "{\"quality\":\"$QUALITY\",\"mode\":\"$MODE\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "== job $JOB =="

COUNT=0
BATCH=()
upload_batch() {
  [ ${#BATCH[@]} -eq 0 ] && return 0
  local args=()
  for f in "${BATCH[@]}"; do args+=(-F "photos=@$f"); done
  curl -sf -X POST "$API/api/jobs/$JOB/images" "${args[@]}" > /dev/null
  BATCH=()
}
for f in "$IMAGES"/*; do
  # macOS ships bash 3.2, so lowercase with tr rather than ${var,,}
  case "$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')" in
    *.jpg|*.jpeg|*.png|*.webp) ;; *) continue ;;
  esac
  BATCH+=("$f"); COUNT=$((COUNT + 1))
  [ ${#BATCH[@]} -ge 5 ] && upload_batch
done
upload_batch
echo "uploaded $COUNT photos"

curl -sf -X POST "$API/api/jobs/$JOB/start" > /dev/null
echo "== running =="

STATUS=running
while [ "$STATUS" = "running" ] || [ "$STATUS" = "queued" ]; do
  sleep 5
  LINE=$(curl -sf "$API/api/jobs/$JOB" | python3 "$ROOT/scripts/_job_status.py" line)
  STATUS=${LINE%% *}
  printf '\r  %-72s' "$LINE"
done
echo ""

curl -sf "$API/api/jobs/$JOB" | python3 "$ROOT/scripts/_job_status.py" full

OUT="$ROOT/data/e2e_$JOB"
mkdir -p "$OUT"
curl -sf "$API/api/jobs/$JOB/files/model.glb?download=1" -o "$OUT/model.glb"
echo "downloaded $(wc -c < "$OUT/model.glb") bytes to $OUT/model.glb"
"$ROOT/pipeline/.venv/bin/python" "$ROOT/scripts/inspect_glb.py" "$OUT/model.glb"
