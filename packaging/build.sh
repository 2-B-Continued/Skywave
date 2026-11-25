#!/bin/sh
# Builds the two release zips from this folder:
#   out/skywave.zip         the app: everything needed to run it, with packaging/README-app.md as its README
#   out/skywave-github.zip  the GitHub showcase: README.md, SECURITY.md, docs/screenshots and tools/screenshots.js
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/out"; work=$(mktemp -d)
mkdir -p "$out"
cp -a "$here" "$work/skywave"
cd "$work/skywave"
find . -name __pycache__ -prune -exec rm -rf {} +
rm -rf data docs out tools/screenshots.js .pytest_cache node_modules
cp "$here/packaging/README-app.md" README.md
cd "$work" && rm -f "$out/skywave.zip" && zip -qr "$out/skywave.zip" skywave
mkdir -p "$work/gh/skywave/tools"
cp "$here/README.md" "$here/SECURITY.md" "$work/gh/skywave/"
cp -a "$here/docs" "$work/gh/skywave/"
cp "$here/tools/screenshots.js" "$work/gh/skywave/tools/"
cd "$work/gh" && rm -f "$out/skywave-github.zip" && zip -qr "$out/skywave-github.zip" skywave
rm -rf "$work"
echo "Built $out/skywave.zip and $out/skywave-github.zip"
