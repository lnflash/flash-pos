#!/bin/sh
# Registers the flashpos:// URL scheme in Debug builds only (ENG-634).
#
# The scheme exists for one link, flashpos://dev/card-bridge?url=…, which
# points the app's card sessions at a cardsim bridge for the simulator e2e
# flows (.maestro/flashcard/, docs/10-testing.md). Its JS handler is
# __DEV__-only; registering the scheme only in Debug means a release build
# does not even claim it.
#
# Runs as the last build phase of the flash_pos target, on the processed
# Info.plist in the product (never the source plist). Idempotent: an
# incremental build that did not re-process the plist finds the scheme and
# leaves it alone.
#
# Usage (Xcode): no arguments; reads CONFIGURATION, TARGET_BUILD_DIR,
# INFOPLIST_PATH and PRODUCT_BUNDLE_IDENTIFIER from the build environment.
# Usage (tests): CONFIGURATION=Debug register-dev-url-scheme.sh <plist>
set -e

if [ "${CONFIGURATION}" != "Debug" ]; then
  echo "flashpos:// is a dev-only scheme; not registered in ${CONFIGURATION:-this} build."
  exit 0
fi

PLIST="${1:-${TARGET_BUILD_DIR}/${INFOPLIST_PATH}}"
BUDDY=/usr/libexec/PlistBuddy
SCHEME=flashpos

if [ ! -f "$PLIST" ]; then
  echo "error: no Info.plist at $PLIST" >&2
  exit 1
fi

if "$BUDDY" -c "Print :CFBundleURLTypes" "$PLIST" 2>/dev/null |
  grep -Eq "^[[:space:]]*${SCHEME}\$"; then
  echo "${SCHEME}:// already registered in $PLIST"
  exit 0
fi

if ! "$BUDDY" -c "Print :CFBundleURLTypes" "$PLIST" >/dev/null 2>&1; then
  "$BUDDY" -c "Add :CFBundleURLTypes array" "$PLIST"
fi

# Append after any URL types the app already declares.
N=0
while "$BUDDY" -c "Print :CFBundleURLTypes:$N" "$PLIST" >/dev/null 2>&1; do
  N=$((N + 1))
done

"$BUDDY" \
  -c "Add :CFBundleURLTypes:$N dict" \
  -c "Add :CFBundleURLTypes:$N:CFBundleURLName string ${PRODUCT_BUNDLE_IDENTIFIER:-flash_pos}.dev-card-bridge" \
  -c "Add :CFBundleURLTypes:$N:CFBundleURLSchemes array" \
  -c "Add :CFBundleURLTypes:$N:CFBundleURLSchemes:0 string ${SCHEME}" \
  "$PLIST"
echo "Registered ${SCHEME}:// in $PLIST"
