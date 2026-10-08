# Windows helper

Independent C# implementation for Windows 10/11 x64 and ARM64. The published helper includes the .NET 8 runtime. Building requires the .NET 8 SDK; using the published helper does not require a separate runtime install.

Press left Ctrl and right Ctrl together to capture the foreground window once. Holding the keys does not repeat the capture. Releasing either key resets the gesture. Injected keyboard events are ignored. The hook passes all events through to the original application.

The helper uses `PrintWindow` and DWM frame bounds, crops to the window's intersection with the virtual desktop, and never falls back to a whole-screen capture. Protected, elevated, exclusive-fullscreen, GPU-rendered, minimized, or unresponsive windows can reject capture. A black image is treated as unsupported. Switch to the source window first; exact DSH/helper process names are excluded.

UI Automation text is optional. It includes available names, non-password values, and visible text ranges, bounded to 16,000 characters, 300 elements, and one second in an isolated subprocess. A slow or unsupported provider returns a screenshot with empty text and a warning. The helper does not perform OCR and does not attempt to bypass integrity-level or protected-content restrictions.

Windows has no macOS-style permission grant for these APIs. Consequently `permissions` and `requestPermissions` return `true` for API availability; this is not a guarantee that every application permits capture or UI Automation. The helper runs with the user's ordinary privileges and never prompts for elevation.

## Build and checks

From the plugin root in PowerShell on Windows:

```powershell
pwsh -File scripts/build-windows.ps1
pwsh -File scripts/build-windows.ps1 -Runtime win-arm64
```

The script first runs 20 checks against the same pure C# gesture and target-filter policy used by the helper. It then runs `--self-test` on the build machine's architecture without installing a keyboard hook or capturing a window, and publishes the requested runtime to `native/windows/publish/<runtime>/ContextSnapshot.exe`. The same commands work in Windows CI with `actions/setup-dotnet` configured for `8.0.x` and Windows PowerShell 5.1 or PowerShell 7. The source can be cross-compiled on macOS/Linux with `dotnet build native/windows/ContextSnapshot.csproj -c Release`; Windows desktop interaction requires Windows.

The pure policy checks also run on macOS/Linux without any desktop APIs:

```sh
dotnet run --project native/windows/tests/PolicyTests.csproj -c Release
```

Each publication also writes `native/windows/publish/<runtime>/third-party/`
with the licenses and notices from the actual resolved .NET and Windows Desktop
runtime packs. The WPF notice is selected from the exact matching release tag,
and `manifest.json` records versions, public sources, and SHA-256 hashes. A
missing notice fails the build. Keep that directory with the self-contained
executable when redistributing it. The checked-in [notice snapshot](third-party/README.md)
covers runtime 8.0.31 used by the initial published binaries.

## Protocol

The long-lived helper reads one JSON request per stdin line and writes NDJSON to stdout. Diagnostics go to stderr. EOF and `shutdown` stop the keyboard hook. The process never writes screenshots to disk.

```json
{"type":"ready","protocol":1,"platform":"win32"}
{"type":"trigger","captureId":"uuid"}
{"type":"capture","captureId":"uuid","capture":{"pngBase64":"...","title":"...","appName":"...","pid":123,"width":1000,"height":700,"text":"...","capturedAt":"...","warnings":[]}}
```

Requests have `{ "id": "request-id", "method": "capture|permissions|requestPermissions|shutdown" }`. A manual capture uses the request id as its capture id and emits `trigger` first. Errors use `{ "type": "error", "captureId": "...", "error": { "code": "...", "message": "..." } }`. Permission/shutdown responses use `type: "result"`, the original id, and `ok`. PNGs are limited to 12 MiB. A capture worker is terminated after four seconds, including its UI Automation subprocess.

## Verification boundary

On 2026-10-08, the helper was cross-compiled on macOS using .NET SDK 8.0.425 with zero warnings or errors, both `win-x64` and `win-arm64` were published, and the 20 pure policy checks passed. Neither Windows executable has been run on a Windows machine. Pure state-machine tests and cross-compilation do not establish end-to-end Windows acceptance. Real-machine verification must cover both Ctrl keys, multi-monitor DPI, a browser window, DSH draft attachment/removal, protected-window errors, and UI Automation timeouts.

API references: [LowLevelKeyboardProc](https://learn.microsoft.com/windows/win32/winmsg/lowlevelkeyboardproc), [PrintWindow](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-printwindow), [DWM window attributes](https://learn.microsoft.com/windows/win32/api/dwmapi/nf-dwmapi-dwmgetwindowattribute), [UI Automation threading](https://learn.microsoft.com/dotnet/framework/ui-automation/ui-automation-threading-issues).
