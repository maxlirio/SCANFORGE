#!/usr/bin/env bash
# Start the SCANFORGE server inside a Codespace and say clearly what went wrong
# if it cannot. Safe to re-run at any time:  bash .devcontainer/start.sh
set -u
SERVER=/app/apps/server/dist/index.js

if [ ! -f "$SERVER" ]; then
  cat <<'MSG'

  ✗ This Codespace was not built from the project's Dockerfile, so the
    application is not installed (no /app).

    Fix: Command Palette (Cmd/Ctrl+Shift+P) -> "Codespaces: Rebuild Container".
    The rebuild takes 5-10 minutes; it installs COLMAP and builds the frontend.

MSG
  exit 1
fi

pkill -f 'apps/server/dist/index.js' 2>/dev/null || true
mkdir -p "${SCANFORGE_DATA_DIR:-/data}"
nohup node "$SERVER" > /tmp/scanforge.log 2>&1 &

for _ in $(seq 1 40); do
  sleep 1
  if curl -sf --max-time 3 http://127.0.0.1:7860/api/health > /tmp/health.json 2>/dev/null; then
    echo ""
    echo "  ✓ SCANFORGE is listening on port 7860."
    python3 - <<'PY' 2>/dev/null || true
import json
d = json.load(open('/tmp/health.json'))
p = d['providers'][0]
print('  reconstruction:', 'ready' if p['available'] else 'UNAVAILABLE — ' + str(p.get('reason')))
if p.get('details'):
    print('  colmap:', p['details'].get('colmapVersion'), '| tier:', p['details'].get('tier'))
PY
    cat <<'MSG'

  To use it from a phone:
    1. Open the PORTS tab (next to TERMINAL, bottom panel).
    2. Right-click port 7860 -> Port Visibility -> Public.
    3. Copy the Forwarded Address and open it on the phone.

MSG
    exit 0
  fi
done

echo ""
echo "  ✗ The server did not come up. Last lines of its log:"
tail -30 /tmp/scanforge.log
exit 1
