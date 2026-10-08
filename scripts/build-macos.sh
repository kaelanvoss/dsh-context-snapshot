#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
task_arch="${DSH_MACOS_ARCH:-universal}"
case "$task_arch" in
  arm64|x86_64|universal) ;;
  *) echo "DSH_MACOS_ARCH must be universal, arm64 or x86_64" >&2; exit 1 ;;
esac
task_bundle="$task_root/native/macos/build/ContextSnapshot.app"
mkdir -p "$task_bundle/Contents/MacOS"
task_build_directory="$(mktemp -d "${TMPDIR:-/tmp}/dsh-context-snapshot.XXXXXX")"
trap 'rm -rf "$task_build_directory"' EXIT
build_architecture() {
  local target_arch="$1"
  xcrun swiftc -swift-version 6 -O -target "$target_arch-apple-macos13.0" \
    -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit \
    -framework CoreMedia -framework CoreImage \
    "$task_root/native/macos/ContextSnapshot.swift" \
    -o "$task_build_directory/ContextSnapshot-$target_arch"
}
if [[ "$task_arch" == universal ]]; then
  build_architecture arm64
  build_architecture x86_64
  xcrun lipo -create "$task_build_directory/ContextSnapshot-arm64" "$task_build_directory/ContextSnapshot-x86_64" \
    -output "$task_bundle/Contents/MacOS/ContextSnapshot"
else
  build_architecture "$task_arch"
  cp "$task_build_directory/ContextSnapshot-$task_arch" "$task_bundle/Contents/MacOS/ContextSnapshot"
fi
cp "$task_root/native/macos/Info.plist" "$task_bundle/Contents/Info.plist"
printf 'Built %s (%s). No Developer ID signing or notarization was performed.\n' "$task_bundle" "$task_arch"
"$task_bundle/Contents/MacOS/ContextSnapshot" --self-test
