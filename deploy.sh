#!/bin/bash
# ═══════════════════════════════════════════════════
# ROM Player by Coops — Deploy Script
# Run this instead of netlify deploy --prod
# It stamps the version automatically then deploys.
#
# Usage:  ./deploy.sh
# ═══════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HTML_FILE="$SCRIPT_DIR/index.html"
VERSION_FILE="$SCRIPT_DIR/version.json"
SW_FILE="$SCRIPT_DIR/sw.js"

# Generate version from current timestamp
VERSION=$(date -u +"%Y%m%d%H%M%S")
echo "🔖 Stamping version: $VERSION"

# Stamp version into index.html
sed -i.bak "s/const APP_VERSION = '[^']*'/const APP_VERSION = '$VERSION'/" "$HTML_FILE"
rm -f "$HTML_FILE.bak"

# Write version.json so the app can check for updates
echo "{ \"version\": \"$VERSION\" }" > "$VERSION_FILE"

# Bump the service worker cache version too, so old cached
# assets never linger across deploys.
sed -i.bak "s/const CACHE_VERSION = '[^']*'/const CACHE_VERSION = 'rp-$VERSION'/" "$SW_FILE"
rm -f "$SW_FILE.bak"

# Cache-bust emulator-backbone.js — same pattern already used for the
# icons. Without this it's served under _headers' site-wide
# Cache-Control: immutable, max-age=31536000 rule with no version marker
# of its own, so browsers (and the SW's own install-time cache.add())
# keep serving a year-old copy of it forever, even after CACHE_VERSION
# and APP_VERSION both roll forward — the exact bug that shipped 2026-08-16.
# Both references (the <script src> in index.html and the precache entry
# in sw.js) must be stamped together or they drift apart again.
EMULATOR_BACKBONE_FILE="$SCRIPT_DIR/emulator-backbone.js"
if [ -f "$EMULATOR_BACKBONE_FILE" ]; then
  sed -i.bak "s#emulator-backbone\.js?v=[A-Za-z0-9]*#emulator-backbone.js?v=$VERSION#" "$HTML_FILE"
  rm -f "$HTML_FILE.bak"
  sed -i.bak "s#/emulator-backbone\.js?v=[A-Za-z0-9]*#/emulator-backbone.js?v=$VERSION#" "$SW_FILE"
  rm -f "$SW_FILE.bak"
fi

# Same lockstep rule for mod-engine.js (Mod Loader engine). Two references again:
# the <script src> in index.html and the precache entry in sw.js. If this block
# is skipped the engine keeps its old ?v= and, under the site-wide immutable
# Cache-Control rule, browsers would keep serving a stale copy of it.
MOD_ENGINE_FILE="$SCRIPT_DIR/mod-engine.js"
if [ -f "$MOD_ENGINE_FILE" ]; then
  sed -i.bak "s#mod-engine\.js?v=[A-Za-z0-9]*#mod-engine.js?v=$VERSION#" "$HTML_FILE"
  rm -f "$HTML_FILE.bak"
  sed -i.bak "s#/mod-engine\.js?v=[A-Za-z0-9]*#/mod-engine.js?v=$VERSION#" "$SW_FILE"
  rm -f "$SW_FILE.bak"
fi

echo "✅ Version stamped (index.html, version.json, sw.js, emulator-backbone.js + mod-engine.js cache-bust)"
echo "🚀 Deploying to Netlify..."

# Deploy
netlify deploy --prod --dir="$SCRIPT_DIR"

echo ""
echo "✨ Done! Version $VERSION is live."
