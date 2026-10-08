# macOS helper

Requires macOS 13 or later and a Swift 6 / Xcode Command Line Tools compiler. Run `bash scripts/build-macos.sh` from the plugin root. The default builds a universal executable for Apple Silicon and Intel; `DSH_MACOS_ARCH=arm64` or `DSH_MACOS_ARCH=x86_64` selects one architecture. The `.app` identity is `io.dsh.context-snapshot.helper`.

The build is local and is not Developer ID signed or notarized. Apple Silicon linking may supply an ad hoc signature. Keep the helper at a stable path: moving or rebuilding it can require macOS privacy permission to be granted again. A public binary distribution should provide signed, notarized universal binaries.

The helper uses ScreenCaptureKit to capture one actual visible foreground window. It never falls back to a full display. macOS 14+ uses `SCScreenshotManager`; macOS 13 uses a one-frame `SCStream` with a five-second timeout. Accessibility text is best effort: at most 300 nodes, 16,000 Unicode characters, and approximately one second of traversal. Secure text-field subtrees are omitted. Pages or apps that do not expose accessibility text produce an empty string; no OCR is performed.

It only listens to modifier changes. The device-specific left and right Command flags must both be held. Holding the chord does not repeat; releasing either Command key re-arms it. The listener consumes no keys. DSH and helper windows are skipped. Screenshots are at most 4,096 pixels on their longest side and 12 MiB as PNG.

Starting the helper does not request privacy permission. The explicit `requestPermissions` command may present Screen Recording, Accessibility, and Input Monitoring prompts. The user may need to enable the corresponding switches in System Settings and restart the helper. `permissions` reads the current grants. Screen Recording is required for screenshots; Accessibility is required for extracted text and can also permit the keyboard listener. Input Monitoring permits the keyboard listener without Accessibility.

Stdin/stdout are newline-delimited JSON. Diagnostics go only to stderr. Commands use `{ "id": "request-id", "method": "capture" | "permissions" | "requestPermissions" | "shutdown" }`. A capture emits `trigger`, followed by `capture` or `error` with the same `captureId`. Startup emits `{ "type": "ready", "protocol": 1, "platform": "darwin" }`.

`ContextSnapshot.app/Contents/MacOS/ContextSnapshot --self-test` tests the chord state machine, Unicode text bound, and PNG encoder without requesting permission, listening to global keys, or taking a screenshot. Real foreground-window capture and privacy behavior still require a manual macOS acceptance test.
