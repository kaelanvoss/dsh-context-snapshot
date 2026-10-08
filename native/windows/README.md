# Windows helper

Independent C# implementation for Windows 10/11 x64 and ARM64. The published helper includes the .NET 8 runtime. Building requires the .NET 8 SDK; using the published helper does not require a separate runtime install.

Press left Ctrl and right Ctrl together to capture the foreground window once. Holding the keys does not repeat the capture. Releasing either key resets the gesture. Injected keyboard events are ignored. The hook passes all events through to the original application.

The helper uses `PrintWindow` and DWM frame bounds, crops to the window's intersection with the virtual desktop, and never falls back to a whole-screen capture. Protected, elevated, exclusive-fullscreen, GPU-rendered, minimized, or unresponsive windows can reject capture. A black image is treated as unsupported. Switch to the source window first; exact DSH/helper process names are excluded.

UI Automation text is optional. It records an indented control tree with available roles, names, help, non-password values, visible text ranges, and supported enabled, focused, selected, read-only, toggle, expansion, range, and text-selection states. These are saved capture-time accessibility values, not OCR or live application inspection. Text is bounded to 16,000 UTF-16 units without splitting surrogate pairs, 300 elements, a maximum depth of 40, and a 900 ms isolated-worker timeout. A slow or unsupported provider can return a screenshot with empty text and a warning. Password and offscreen controls are filtered before reading values; actual privacy-property read failures fail closed. The helper does not attempt to bypass integrity-level or protected-content restrictions.

The foreground application's icon is optional metadata. The helper first reads the window's actual `WM_GETICON` or class icon, then tries the foreground process's local executable icon. Window-message reads have an 80 ms deadline per attempt; all icon reads and encoding run in an isolated subprocess with a 400 ms deadline alongside UI Automation. The borrowed native icon is cloned before encoding. The resulting transparent PNG is 32 × 32 pixels and at most 8 KiB. It never downloads icons or reads executable resources from network paths. Unavailable icons, timeouts, and process-access failures leave the screenshot usable without an icon.

Windows has no macOS-style permission grant for these APIs. Consequently `permissions` and `requestPermissions` return `true` for API availability; this is not a guarantee that every application permits capture or UI Automation. The helper runs with the user's ordinary privileges and never prompts for elevation.

## Build and checks

From the plugin root in PowerShell on Windows:

```powershell
pwsh -File scripts/build-windows.ps1
pwsh -File scripts/build-windows.ps1 -Runtime win-arm64
```

The script first runs 45 checks against the same pure C# gesture, target-filter, and accessibility-formatting policies used by the helper. It then runs the 22-check `--self-test` on the build machine's architecture without installing a keyboard hook or capturing a window; this also verifies bounded, transparent PNG encoding using a synthetic icon. It publishes the requested runtime to `native/windows/publish/<runtime>/ContextSnapshot.exe`. The same commands work in Windows CI with `actions/setup-dotnet` configured for `8.0.x` and Windows PowerShell 5.1 or PowerShell 7. The source can be cross-compiled on macOS/Linux with `dotnet build native/windows/ContextSnapshot.csproj -c Release`; Windows desktop interaction and native icon self-tests require Windows. For cross-publication use `-SkipSelfTest`; the portable policy checks still run.

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
{"type":"capture","captureId":"uuid","capture":{"pngBase64":"...","title":"...","appName":"...","pid":123,"width":1000,"height":700,"text":"...","capturedAt":"...","warnings":[],"appIconPngBase64":"..."}}
```

Requests have `{ "id": "request-id", "method": "capture|permissions|requestPermissions|shutdown" }`. A manual capture uses the request id as its capture id and emits `trigger` first. Errors use `{ "type": "error", "captureId": "...", "error": { "code": "...", "message": "..." } }`. Permission/shutdown responses use `type: "result"`, the original id, and `ok`. PNGs are limited to 12 MiB. A capture worker is terminated after four seconds, including its UI Automation subprocess.

`capture.appIconPngBase64` is omitted when the foreground app provides no usable icon. The icon PNG is separate from the window PNG and never replaces it.

## Verification boundary

On 2026-10-08, the helper was cross-compiled on macOS using .NET SDK 8.0.425 with zero warnings or errors, both `win-x64` and `win-arm64` were published, and the 45 pure policy checks passed for each build. Neither Windows executable has been run on a Windows machine, and the 22 native checks remain unrun. Pure policy tests and cross-compilation do not establish end-to-end Windows acceptance. Real-machine verification must cover both Ctrl keys, multi-monitor DPI, a browser window and its available control states, DSH draft preview/text switching/attachment/removal, protected-window errors, and UI Automation timeouts.

API references: [LowLevelKeyboardProc](https://learn.microsoft.com/windows/win32/winmsg/lowlevelkeyboardproc), [PrintWindow](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-printwindow), [DWM window attributes](https://learn.microsoft.com/windows/win32/api/dwmapi/nf-dwmapi-dwmgetwindowattribute), [UI Automation threading](https://learn.microsoft.com/dotnet/framework/ui-automation/ui-automation-threading-issues), [WM_GETICON](https://learn.microsoft.com/windows/win32/winmsg/wm-geticon), [SendMessageTimeout](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw).
