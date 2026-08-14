#!/usr/bin/env bash
# Start the SCANFORGE server inside a Codespace and report whether it came up.
set -u
pkill -f 'apps/server/dist/index.js' 2>/dev/null || true
mkdir -p "${SCANFORGE_DATA_DIR:-/data}"

nohup node /app/apps/server/dist/index.js > /tmp/scanforge.log 2>&1 &

for _ in $(seq 1 30); do
  sleep 1
  if curl -sf --max-time 3 http://127.0.0.1:7860/api/health > /tmp/health.json 2>/dev/null; then
    echo ""
    echo "  SCANFORGE is running on port 7860."
    python3 -c "import json;d=json.load(open('/tmp/health.json'));p=d['providers'][0];print('  reconstruction:', 'ready' if p['available'] else 'UNAVAILABLE - '+str(p.get('reason')))" 2>/dev/null || true
    echo ""
    echo "  To use it from a phone: open the PORTS tab, right-click port 7860,"
    echo "  set Port Visibility to Public, then copy the forwarded address."
    echo ""
    exit 0
  fi
done

echo "SCANFORGE did not start. Log:"
tail -30 /tmp/scanforge.log
exit 1
