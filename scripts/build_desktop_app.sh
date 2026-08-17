#!/usr/bin/env bash
# Package SCANFORGE.app - a real dock application.
#
#   npm run desktop:app
#
# Stages only what the app needs (the built server, the built UI, the pipeline
# and the server's production dependencies) and packages that, rather than
# shipping the whole workspace with Electron and every dev dependency inside it.
#
# TRELLIS itself is NOT bundled: it lives in ~/.scanforge/trellis-mac with its own
# 16 GB of weights, and the app calls into it. See docs/TRELLIS_LOCAL.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/build/stage"
OUT="$ROOT/build/app"

cd "$ROOT"
echo "==> building workspaces"
npm run build >/dev/null

echo "==> staging"
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE"/{apps/desktop,apps/server,apps/web,packages/shared}

cp -R apps/desktop/dist "$STAGE/apps/desktop/dist"
cp apps/desktop/index.js "$STAGE/apps/desktop/index.js"
cp -R apps/server/dist "$STAGE/apps/server/dist"
cp apps/server/package.json "$STAGE/apps/server/package.json"
cp -R apps/web/dist "$STAGE/apps/web/dist"
cp -R packages/shared/dist "$STAGE/packages/shared/dist"
cp packages/shared/package.json "$STAGE/packages/shared/package.json"

# The reconstruction pipeline, minus its virtualenv and caches.
mkdir -p "$STAGE/pipeline"
cp pipeline/requirements.txt "$STAGE/pipeline/"
cp -R pipeline/scanforge "$STAGE/pipeline/scanforge"
find "$STAGE/pipeline" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

# A minimal manifest so Electron and the server resolve normally inside the app.
node - "$STAGE" <<'NODE'
const fs = require('fs');
const path = require('path');
const stage = process.argv[2];
const server = JSON.parse(fs.readFileSync('apps/server/package.json', 'utf8'));
const deps = { ...server.dependencies };
delete deps['@scanforge/shared'];   // vendored below instead of resolved from the registry
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'scanforge',
  productName: 'SCANFORGE',
  version: require(path.resolve('package.json')).version,
  private: true,
  type: 'module',
  main: 'apps/desktop/index.js',
  dependencies: deps,
}, null, 2));
NODE

echo "==> installing production dependencies"
(cd "$STAGE" && npm install --omit=dev --silent --no-audit --no-fund >/dev/null)
# @scanforge/shared is a workspace package, so link it in by hand.
mkdir -p "$STAGE/node_modules/@scanforge"
cp -R "$STAGE/packages/shared" "$STAGE/node_modules/@scanforge/shared"

echo "==> packaging"
npx --yes @electron/packager "$STAGE" SCANFORGE \
  --platform=darwin --arch=arm64 \
  --out "$OUT" \
  --icon "$ROOT/build/scanforge.icns" \
  --app-bundle-id dev.scanforge.app \
  --app-category-type public.app-category.graphics-design \
  --overwrite >/dev/null

APP="$OUT/SCANFORGE-darwin-arm64/SCANFORGE.app"
[ -d "$APP" ] || { echo "packaging produced no app"; exit 1; }
echo ""
echo "Built: $APP"
du -sh "$APP" | awk '{print "Size : " $1}'
echo ""
echo "Install it:  cp -R \"$APP\" /Applications/"
echo "Then open it once from Applications and keep it in the Dock."
