#!/usr/bin/env bash
#
# Notarizes and staples the .dmg after `electron-builder` has built and signed it.
#
# electron-builder notarizes the .app inside but not the disk image around it; an unnotarized
# image draws a Gatekeeper prompt on first open even though the app inside is clean. Skipped
# when APPLE_KEYCHAIN_PROFILE is unset (an unsigned local build).

set -euo pipefail

if [ -z "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  echo "notarize-dmg: APPLE_KEYCHAIN_PROFILE not set; skipping"
  exit 0
fi

VERSION="$(node -p "require('./package.json').version")"
DMG="$HOME/Library/Caches/AIMgnal/release/AIMgnal-${VERSION}-arm64.dmg"
[ -f "$DMG" ] || { echo "notarize-dmg: $DMG not found" >&2; exit 1; }

xcrun notarytool submit "$DMG" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$DMG"
spctl -a -t open --context context:primary-signature "$DMG"
echo "notarize-dmg: $DMG notarized and stapled"
