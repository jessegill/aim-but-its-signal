#!/usr/bin/env bash
#
# Builds the app icon from resources/icons/icon.png (512x512 RGBA).
#
# Outputs, next to this script:
#   app-{16,32,64,128,256,512}.png   raster exports
#   AIMgnal.iconset/                 full macOS iconset including @2x
#   AIMgnal.icns                     what electron-builder packages
#
# Uses only tools that ship with macOS: sips and iconutil.
# The UI glyphs are still drawn by generate.py; it no longer touches the app icon.

set -euo pipefail
cd "$(dirname "$0")"

SRC=icon.png
[ -f "$SRC" ] || { echo "build-app-icon: $SRC not found" >&2; exit 1; }

resize() { sips -s format png -z "$1" "$1" "$SRC" --out "$2" >/dev/null; }

for size in 16 32 64 128 256 512; do
  resize "$size" "app-$size.png"
done

rm -rf AIMgnal.iconset
mkdir AIMgnal.iconset
for size in 16 32 128 256 512; do
  resize "$size" "AIMgnal.iconset/icon_${size}x${size}.png"
  resize "$((size * 2))" "AIMgnal.iconset/icon_${size}x${size}@2x.png"
done

iconutil -c icns AIMgnal.iconset -o AIMgnal.icns
echo "build-app-icon: wrote app-*.png, AIMgnal.iconset/, AIMgnal.icns from $SRC"
