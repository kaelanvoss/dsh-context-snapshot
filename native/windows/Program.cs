using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

namespace DshContextSnapshot;

internal static class Program
{
    private const int MaxPngBytes = 12 * 1024 * 1024;
    private const int MaxTextChars = 16_000;
    private const int MaxNodes = 300;
    private const int AppIconPixels = 32;
    private const int MaxAppIconPngBytes = 8 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly object OutputLock = new();
    private static readonly object WorkerLock = new();
    private static readonly HashSet<Process> Workers = [];
    private static readonly SemaphoreSlim CaptureGate = new(1, 1);
    private static readonly ShortcutGesture Gesture = new();
    private static readonly PhysicalShortcutRecorder Recorder = new();
    private static readonly object RecordingWindowLock = new();
    private static ShortcutRecordingWindow? recordingWindow;
    private static System.Threading.Timer? recorderTimer;
    private static readonly Native.HookProc HookCallback = KeyboardHook;
    private static readonly Native.WinEventProc FocusCallback = (_, _, _, _, _, _, _) =>
    { CheckRecorder(); };
    private static nint hook;
    private static nint focusHook;
    private static uint messageThread;
    private static int stopping;

    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);
        if (args is ["--self-test"]) return SelfTest();
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);

        if (args is ["--capture-window", var handleText, var processText])
        {
            try
            {
                Write(CaptureWindow(ParseHandle(handleText), uint.Parse(processText, CultureInfo.InvariantCulture)));
                return 0;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(exception.Message);
                Write(new WorkerError(ErrorCode(exception), exception.Message));
                return 1;
            }
        }
        if (args is ["--extract-text", var textHandle]) return ExtractTextWorker(ParseHandle(textHandle));
        if (args is ["--extract-icon", var iconHandle, var iconProcess])
        {
            string? encoded = null;
            try
            {
                using var process = Process.GetProcessById(int.Parse(iconProcess, CultureInfo.InvariantCulture));
                encoded = ReadAppIcon(ParseHandle(iconHandle), process);
            }
            catch (Exception exception)
            {
                // The optional icon worker reports absence if its owner went away.
                _ = exception;
            }
            Write(new IconResult(encoded));
            return 0;
        }
        if (args.Length != 0)
        {
            Console.Error.WriteLine("Usage: ContextSnapshot.exe [--self-test]");
            return 2;
        }

        // The host restores its saved shortcut after ready. Keep keyboard
        // capture paused until that configuration handshake explicitly ends.
        Gesture.SetRecording(true);
        messageThread = Native.GetCurrentThreadId();
        // Create the queue before the stdin reader can post WM_QUIT.
        Native.PeekMessage(out _, 0, 0, 0, 0);
        hook = Native.SetWindowsHookEx(13, HookCallback, Native.GetModuleHandle(null), 0);
        if (hook == 0)
        {
            WriteError(null, "hotkey_unavailable", $"Cannot install keyboard hook (Win32 {Marshal.GetLastWin32Error()}).");
            return 1;
        }
        Console.CancelKeyPress += (_, eventArgs) => { eventArgs.Cancel = true; Shutdown(); };
        focusHook = Native.SetWinEventHook(3, 3, 0, FocusCallback, 0, 0, 0);
        _ = Task.Run(ReadCommands);
        recorderTimer = new System.Threading.Timer(_ =>
        {
            CheckRecorder();
        }, null, 100, 100);
        Write(new { type = "ready", protocol = 1, platform = "win32", shortcut = Gesture.Configuration,
            supportedCodes = ShortcutKeys.SupportedCodes, recording = true, supportsShortcutRecording = true });
        try { Application.Run(); }
        finally
        {
            Interlocked.Exchange(ref stopping, 1);
            StopRecorder();
            recorderTimer?.Dispose();
            if (focusHook != 0) Native.UnhookWinEvent(focusHook);
            Native.UnhookWindowsHookEx(hook);
        }
        return 0;
    }

    private static nint KeyboardHook(int code, nint message, nint data)
    {
        // This callback must return immediately. All capture and UIA calls run in workers.
        if (code >= 0 && Volatile.Read(ref stopping) == 0)
        {
            var input = Marshal.PtrToStructure<Native.KeyboardInput>(data);
            if (!ShortcutKeys.IsInjected(input.flags) && (message == 0x100 || message == 0x104 || message == 0x101 || message == 0x105))
            {
                // Track unbound physical keys too: extra pressed keys must not
                // turn a larger combination into the configured shortcut.
                var key = ShortcutKeys.Resolve(input.vkCode, input.scanCode, input.flags)
                    ?? $"Unmapped:{input.vkCode}:{input.scanCode}:{input.flags & 1}";
                var down = message == 0x100 || message == 0x104;
                lock (RecordingWindowLock)
                    if (Recorder.Active) Recorder.Update(key, down, Environment.TickCount64, RecordingWindowFocused());
                if (Gesture.Update(key, down))
                {
                    var target = Native.GetForegroundWindow();
                    var captureId = Guid.NewGuid().ToString("D");
                    _ = Task.Run(() => QueueCapture(target, captureId));
                }
            }
        }
        return Native.CallNextHookEx(hook, code, message, data);
    }

    private static async Task ReadCommands()
    {
        try
        {
            while (Volatile.Read(ref stopping) == 0 && await Console.In.ReadLineAsync() is { } line)
            {
                if (line.Length > 8192) { WriteError(null, "invalid_request", "Request is too large."); continue; }
                string? id = null;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var request = document.RootElement;
                    if (request.TryGetProperty("id", out var idValue) && idValue.ValueKind == JsonValueKind.String)
                        id = idValue.GetString();
                    if (id?.Length > 128) throw new InvalidOperationException("Request id is too long.");
                    var method = request.GetProperty("method").GetString();
                    switch (method)
                    {
                        case "capture":
                            var target = Native.GetForegroundWindow();
                            _ = QueueCapture(target, id ?? Guid.NewGuid().ToString("D"));
                            break;
                        case "permissions":
                        case "requestPermissions":
                            Write(new { type = "result", id, ok = true, permissions = new { screenRecording = true, accessibility = true, inputMonitoring = true } });
                            break;
                        case "setShortcut":
                            Gesture.Configure(request.GetProperty("shortcut"));
                            Write(new { type = "result", id, ok = true, shortcut = Gesture.Configuration });
                            break;
                        case "setRecording":
                            var active = request.GetProperty("active").GetBoolean();
                            Gesture.SetRecording(active);
                            if (!active) StopRecorder();
                            Write(new { type = "result", id, ok = true, recording = active });
                            break;
                        case "beginShortcutRecording":
                        case "shortcutRecordingState":
                        case "endShortcutRecording":
                            if (!Gesture.Recording || hook == 0 || focusHook == 0)
                                throw new ShortcutRecordingException("RECORDING_NOT_READY", "Pause capture and confirm the listener before recording.");
                            var token = request.TryGetProperty("token", out var tokenValue) && tokenValue.ValueKind == JsonValueKind.String ? tokenValue.GetString() : null;
                            var recordingState = RecordCommand(method, token);
                            Write(new { type = "result", id, ok = true, recordingState });
                            break;
                        case "shutdown":
                            Write(new { type = "result", id, ok = true });
                            Shutdown();
                            return;
                        default:
                            Write(new { type = "result", id, ok = false, error = new { code = "invalid_method", message = "Unknown method." } });
                            break;
                    }
                }
                catch (Exception exception) when (exception is JsonException or InvalidOperationException or KeyNotFoundException)
                {
                    Write(new { type = "result", id, ok = false, error = new { code = exception is ShortcutRecordingException recordingFailure ? recordingFailure.Code : "invalid_request", message = exception.Message } });
                }
            }
        }
        catch (IOException exception) { Console.Error.WriteLine(exception.Message); }
        finally { Shutdown(); }
    }

    private static bool HarnessWindow(nint target)
    {
        if (target == 0) return false;
        Native.GetWindowThreadProcessId(target, out var id);
        try
        {
            using var process = Process.GetProcessById((int)id);
            return new[] { "dsh", "deepseek", "deepseek-harness", "deepseek harness", "dsh desktop" }
                .Contains(process.ProcessName, StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        { return false; }
    }
    private static bool RecordingWindowFocused()
    {
        if (recordingWindow is not { } expected) return false;
        var current = Native.GetForegroundWindow();
        Native.GetWindowThreadProcessId(current, out var processId);
        return expected.Matches(current, processId) && HarnessWindow(current);
    }
    private static void CheckRecorder()
    {
        lock (RecordingWindowLock)
            if (Recorder.Active) Recorder.Check(Environment.TickCount64, RecordingWindowFocused());
    }
    private static ShortcutRecordingState RecordCommand(string method, string? token)
    {
        lock (RecordingWindowLock)
        {
            if (method == "beginShortcutRecording")
            {
                var target = Native.GetForegroundWindow();
                Native.GetWindowThreadProcessId(target, out var processId);
                if (target == 0 || processId == 0 || !HarnessWindow(target) || Native.GetForegroundWindow() != target)
                    throw new ShortcutRecordingException("RECORDING_NOT_FOCUSED", "Keep the DeepSeek Harness recording window in the foreground.");
                var state = Recorder.Begin(token, Environment.TickCount64, true, HeldCodes());
                recordingWindow = new(target, processId);
                return state;
            }
            if (method == "endShortcutRecording")
            {
                var state = Recorder.End(token);
                recordingWindow = null;
                return state;
            }
            return Recorder.Read(token, Environment.TickCount64, RecordingWindowFocused());
        }
    }
    private static void StopRecorder()
    {
        lock (RecordingWindowLock) { Recorder.Stop(clearToken: true); recordingWindow = null; }
    }
    private static IEnumerable<string> HeldCodes()
    {
        // Used only before a fresh lease, not to reconstruct a candidate.
        for (uint key = 1; key < 255; key++)
            if ((Native.GetAsyncKeyState((int)key) & 0x8000) != 0 && key is not (1 or 2 or 4 or 5 or 6))
                yield return "held";
    }

    private static async Task QueueCapture(nint target, string captureId)
    {
        Write(new { type = "trigger", captureId });
        if (!await CaptureGate.WaitAsync(0))
        {
            WriteError(captureId, "capture_busy", "A capture is already in progress.");
            return;
        }
        try
        {
            var expectedProcessId = ValidateTarget(target);
            // PrintWindow can block inside another application's renderer. Terminating this
            // isolated worker enforces a deadline without leaking a hung thread per capture.
            var worker = await RunWorker(4000, "--capture-window", HandleString(target), expectedProcessId.ToString(CultureInfo.InvariantCulture));
            if (worker.TimedOut) throw new CaptureException("capture_timeout", "The window renderer did not respond within 4 seconds.");
            if (worker.ExitCode != 0)
            {
                try
                {
                    var failure = JsonSerializer.Deserialize<WorkerError>(worker.Output, JsonOptions);
                    throw new CaptureException(failure?.Code ?? "capture_failed", failure?.Message ?? "Window capture failed.");
                }
                catch (JsonException) { throw new CaptureException("capture_failed", "Window capture failed."); }
            }
            var capture = JsonSerializer.Deserialize<CaptureData>(worker.Output, JsonOptions)
                ?? throw new CaptureException("capture_failed", "Capture worker returned no image.");
            Write(new { type = "capture", captureId, capture });
        }
        catch (Exception exception) { WriteError(captureId, ErrorCode(exception), exception.Message); }
        finally { CaptureGate.Release(); }
    }

    private static CaptureData CaptureWindow(nint target, uint expectedProcessId)
    {
        var processId = ValidateTarget(target);
        if (processId != expectedProcessId)
            throw new CaptureException("invalid_window", "The foreground window was replaced before capture.");
        if (!Native.GetWindowRect(target, out var raw) || raw.Width <= 0 || raw.Height <= 0)
            throw new CaptureException("invalid_window", "The foreground window has no capture area.");
        if ((long)raw.Width * raw.Height > 32_000_000)
            throw new CaptureException("capture_too_large", "The foreground window exceeds the 32 megapixel capture limit.");
        var title = new StringBuilder(4096);
        Native.GetWindowText(target, title, title.Capacity);

        var frame = raw;
        if (Native.DwmGetWindowAttribute(target, 9, out Native.Rect visible, Marshal.SizeOf<Native.Rect>()) == 0 && visible.Width > 0 && visible.Height > 0)
            frame = Intersect(raw, visible);
        var desktop = SystemInformation.VirtualScreen;
        frame = Intersect(frame, new Native.Rect(desktop.Left, desktop.Top, desktop.Right, desktop.Bottom));
        if (frame.Width <= 0 || frame.Height <= 0)
            throw new CaptureException("invalid_window", "The foreground window is outside the visible desktop.");

        using var full = new Bitmap(raw.Width, raw.Height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(full))
        {
            graphics.Clear(Color.Black);
            var dc = graphics.GetHdc();
            try
            {
                if (!Native.PrintWindow(target, dc, 2))
                    throw new CaptureException("capture_unsupported", "The foreground application does not support window capture.");
            }
            finally { graphics.ReleaseHdc(dc); }
        }
        var imageCapturedAt = DateTime.UtcNow.ToString("O");
        using var image = full.Clone(new Rectangle(frame.Left - raw.Left, frame.Top - raw.Top, frame.Width, frame.Height), PixelFormat.Format32bppArgb);
        if (IsBlankBlack(image))
            throw new CaptureException("capture_unsupported", "The foreground application returned a blank window image.");
        using var stream = new MemoryStream();
        image.Save(stream, ImageFormat.Png);
        if (stream.Length > MaxPngBytes)
            throw new CaptureException("capture_too_large", "The PNG exceeds the 12 MiB attachment limit.");

        using var process = Process.GetProcessById((int)processId);
        var iconWorker = ReadAppIconWorker(target, processId);
        var textStartedAt = DateTime.UtcNow.ToString("O");
        var textWorker = RunWorker(1000, "--extract-text", HandleString(target)).GetAwaiter().GetResult();
        var textFinishedAt = DateTime.UtcNow.ToString("O");
        var accessible = new TextResult("", SnapshotCaptureQuality.Create("", [], 0), new SnapshotSource(), textStartedAt, textFinishedAt);
        if (textWorker.TimedOut || textWorker.ExitCode == 3) accessible = accessible with { CaptureQuality = SnapshotCaptureQuality.Create("", ["time_budget_reached"], 0) };
        else if (textWorker.ExitCode != 0) accessible = accessible with { CaptureQuality = SnapshotCaptureQuality.Create("", ["accessibility_unavailable"], 0) };
        else
        {
            try { accessible = JsonSerializer.Deserialize<TextResult>(textWorker.Output, JsonOptions) ??
                accessible with { CaptureQuality = SnapshotCaptureQuality.Create("", ["accessibility_unavailable"], 0) }; }
            catch (JsonException) { accessible = accessible with { CaptureQuality = SnapshotCaptureQuality.Create("", ["accessibility_unavailable"], 0) }; }
        }
        var finalProcessId = ValidateTarget(target);
        var finalTitle = new StringBuilder(4096);
        Native.GetWindowText(target, finalTitle, finalTitle.Capacity);
        if (finalProcessId != processId || Native.GetForegroundWindow() != target || finalTitle.ToString() != title.ToString())
            throw new CaptureException("window_context_changed", "The selected window changed during capture; capture it again.");
        return new CaptureData(Convert.ToBase64String(stream.ToArray()), title.ToString(), process.ProcessName,
            (int)processId, image.Width, image.Height, accessible.Text, imageCapturedAt, accessible.CaptureQuality,
            accessible.Source, new SnapshotTiming(imageCapturedAt, accessible.TextStartedAt, accessible.TextFinishedAt),
            accessible.CaptureQuality.Reasons.Where(reason => reason is "time_budget_reached" or "accessibility_unavailable")
                .Select(reason => reason == "time_budget_reached" ? "ui_automation_timeout" : "ui_automation_unavailable").ToArray(),
            iconWorker.GetAwaiter().GetResult());
    }

    private static async Task<string?> ReadAppIconWorker(nint target, uint processId)
    {
        try
        {
            // Optional resource/GDI reads are isolated from the completed PNG.
            // This worker overlaps UI Automation and cannot block it indefinitely.
            var worker = await RunWorker(400, "--extract-icon", HandleString(target), processId.ToString(CultureInfo.InvariantCulture));
            if (worker.TimedOut || worker.ExitCode != 0) return null;
            return JsonSerializer.Deserialize<IconResult>(worker.Output, JsonOptions)?.AppIconPngBase64;
        }
        catch (Exception exception)
        {
            // Spawn, serialization, and icon-process failures keep the window PNG.
            _ = exception;
            return null;
        }
    }

    private static string? ReadAppIcon(nint target, Process process)
    {
        try
        {
            Native.GetWindowThreadProcessId(target, out var owner);
            if (owner != process.Id) return null;
            // WM_GETICON can enter the application's thread. Keep each attempt
            // bounded inside the already deadline-owned capture subprocess.
            // ICON_SMALL2 can substitute a system-generated default; use only
            // the application's explicit large/small icon before other sources.
            foreach (var kind in new nuint[] { 1, 0 })
            {
                if (Native.SendMessageTimeout(target, 0x7F, kind, 0, 0x22, 80, out var handle) != 0 && handle != 0)
                {
                    var encoded = EncodeBorrowedIcon((nint)handle);
                    if (encoded != null) return encoded;
                }
            }
            foreach (var attribute in new[] { -14, -34 })
            {
                var handle = Native.GetClassLongPtr(target, attribute);
                if (handle == 0) continue;
                var encoded = EncodeBorrowedIcon(handle);
                if (encoded != null) return encoded;
            }
            var path = process.MainModule?.FileName;
            if (string.IsNullOrEmpty(path) || path.StartsWith(@"\\", StringComparison.Ordinal)) return null;
            var drive = Path.GetPathRoot(path);
            if (string.IsNullOrEmpty(drive) || new DriveInfo(drive).DriveType == DriveType.Network) return null;
            using var associated = Icon.ExtractAssociatedIcon(path);
            return associated == null ? null : EncodeAppIcon(associated);
        }
        catch (Exception exception)
        {
            // Optional foreground-app metadata must never invalidate its image
            // because of process permissions, disposed windows, or icon resources.
            _ = exception;
            return null;
        }
    }

    private static string? EncodeBorrowedIcon(nint handle)
    {
        try
        {
            // Window/class HICONs belong to the source application. FromHandle
            // is non-owning; only the independent clone is disposed as an owner.
            using var borrowed = Icon.FromHandle(handle);
            using var clone = (Icon)borrowed.Clone();
            return EncodeAppIcon(clone);
        }
        catch (Exception exception)
        {
            // A stale or malformed icon can fall through to the executable icon.
            _ = exception;
            return null;
        }
    }

    private static string? EncodeAppIcon(Icon icon)
    {
        using var source = icon.ToBitmap();
        using var image = new Bitmap(AppIconPixels, AppIconPixels, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(image))
        {
            graphics.Clear(Color.Transparent);
            graphics.CompositingMode = CompositingMode.SourceCopy;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.DrawImage(source, new Rectangle(0, 0, AppIconPixels, AppIconPixels));
        }
        using var stream = new MemoryStream();
        image.Save(stream, ImageFormat.Png);
        return stream.Length <= MaxAppIconPngBytes ? Convert.ToBase64String(stream.ToArray()) : null;
    }

    private static uint ValidateTarget(nint target)
    {
        if (target == 0 || !Native.IsWindow(target) || !Native.IsWindowVisible(target) || Native.IsIconic(target))
            throw new CaptureException("invalid_window", "No visible foreground window is available.");
        if (Native.DwmGetWindowAttribute(target, 14, out int cloaked, sizeof(int)) == 0 && cloaked != 0)
            throw new CaptureException("invalid_window", "The foreground window is hidden by the desktop compositor.");
        Native.GetWindowThreadProcessId(target, out var processId);
        if (processId == 0 || processId == Environment.ProcessId)
            throw new CaptureException("self_capture", "The snapshot helper cannot capture itself.");
        using var process = Process.GetProcessById((int)processId);
        if (TargetPolicy.IsExcluded(process.ProcessName))
            throw new CaptureException("self_capture", "Switch to the window you want to attach before capturing.");
        return processId;
    }

    private static bool IsBlankBlack(Bitmap bitmap)
    {
        for (var y = 0; y < bitmap.Height; y += Math.Max(1, bitmap.Height / 48))
            for (var x = 0; x < bitmap.Width; x += Math.Max(1, bitmap.Width / 48))
            {
                var color = bitmap.GetPixel(x, y);
                if (color.R > 4 || color.G > 4 || color.B > 4) return false;
            }
        return true;
    }

    private static Native.Rect Intersect(Native.Rect a, Native.Rect b) => new(
        Math.Max(a.Left, b.Left), Math.Max(a.Top, b.Top), Math.Min(a.Right, b.Right), Math.Min(a.Bottom, b.Bottom));

    private static int ExtractTextWorker(nint target)
    {
        TextResult? result = null;
        Exception? failure = null;
        var worker = new Thread(() =>
        {
            try { result = ReadWindowText(target); }
            catch (Exception exception) { failure = exception; }
        }) { IsBackground = true };
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        if (!worker.Join(900)) return 3;
        if (failure != null || result == null) { Console.Error.WriteLine(failure?.Message ?? "The UI Automation worker did not return a result."); return 1; }
        Write(result);
        return 0;
    }

    private static TextResult ReadWindowText(nint target)
    {
        var startedAt = DateTime.UtcNow.ToString("O");
        var clock = Stopwatch.StartNew();
        var root = AutomationElement.FromHandle(target);
        var output = new SnapshotTextTree(MaxTextChars, MaxNodes, 40);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var walker = TreeWalker.ControlViewWalker;
        var privacy = new CacheRequest { TreeScope = TreeScope.Element };
        privacy.Add(AutomationElement.IsPasswordProperty);
        privacy.Add(AutomationElement.IsOffscreenProperty);
        privacy.Add(AutomationElement.RuntimeIdProperty);
        var details = new CacheRequest { TreeScope = TreeScope.Element };
        foreach (var property in new[]
        {
            AutomationElement.ControlTypeProperty, AutomationElement.NameProperty, AutomationElement.HelpTextProperty,
            AutomationElement.IsEnabledProperty, AutomationElement.HasKeyboardFocusProperty,
            ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty,
            RangeValuePattern.ValueProperty, RangeValuePattern.MinimumProperty, RangeValuePattern.MaximumProperty,
            RangeValuePattern.IsReadOnlyProperty, SelectionItemPattern.IsSelectedProperty,
            ExpandCollapsePattern.ExpandCollapseStateProperty, TogglePattern.ToggleStateProperty,
        }) details.Add(property);
        var nodes = 0;
        var reasons = new HashSet<string>(StringComparer.Ordinal);
        var source = new SnapshotSource();
        bool WithinBudget() => clock.ElapsedMilliseconds < 650 && nodes < MaxNodes && output.CanAppend;
        object? Cached(AutomationElement element, AutomationProperty property, bool ignoreDefaultValue = true)
        {
            try
            {
                // Displayed fields omit unsupported properties. Only privacy
                // reads opt into UIA's documented IsPassword/IsOffscreen FALSE
                // defaults; an exception still returns null and fails closed.
                var value = element.GetCachedPropertyValue(property, ignoreDefaultValue);
                return ReferenceEquals(value, AutomationElement.NotSupported) ? null : value;
            }
            catch (Exception exception) when (exception is ElementNotAvailableException or InvalidOperationException or COMException)
            { reasons.Add("provider_read_failed"); return null; }
        }
        string? ReadRanges(TextPatternRange[] ranges)
        {
            var text = new StringBuilder();
            foreach (var range in ranges)
            {
                if (!WithinBudget() || text.Length >= SnapshotTextTree.FieldChars) break;
                var value = range.GetText(SnapshotTextTree.FieldChars - text.Length + 1);
                if (value.Length == 0) continue;
                if (text.Length != 0 && text.Length < SnapshotTextTree.FieldChars) text.Append('\n');
                var remaining = SnapshotTextTree.FieldChars - text.Length;
                if (value.Length > remaining) reasons.Add("field_truncated");
                text.Append(SnapshotTextTree.Bound(value, remaining));
            }
            return text.Length == 0 ? null : text.ToString();
        }
        string Identity(AutomationElement element) => string.Join(",", element.GetRuntimeId());
        var focusPath = new HashSet<string>(StringComparer.Ordinal);
        var focusChildren = new Dictionary<string, AutomationElement>(StringComparer.Ordinal);
        try
        {
            var focused = AutomationElement.FocusedElement;
            var route = new HashSet<string>(StringComparer.Ordinal);
            var routeChildren = new Dictionary<string, AutomationElement>(StringComparer.Ordinal);
            var rootIdentity = Identity(root);
            for (var depth = 0; focused != null && depth <= 40 && WithinBudget(); depth++)
            {
                var identity = Identity(focused);
                if (!route.Add(identity)) break;
                if (identity == rootIdentity) { focusPath = route; focusChildren = routeChildren; break; }
                var parent = walker.GetParent(focused);
                if (parent != null) routeChildren[Identity(parent)] = focused;
                focused = parent;
            }
        }
        catch (Exception exception) when (exception is ElementNotAvailableException or InvalidOperationException or COMException)
        { reasons.Add("provider_read_failed"); }
        void Visit(AutomationElement element, int depth)
        {
            if (!WithinBudget()) return;
            if (depth > 40) { reasons.Add("depth_budget_reached"); return; }
            nodes++;
            try
            {
                var guarded = element.GetUpdatedCache(privacy);
                // Privacy and visibility are fail closed for the whole subtree;
                // no labels, values, text, or child enumeration happen first.
                if (!SnapshotPrivacy.CanRead(Cached(guarded, AutomationElement.IsPasswordProperty, ignoreDefaultValue: false) as bool?,
                    Cached(guarded, AutomationElement.IsOffscreenProperty, ignoreDefaultValue: false) as bool?)) return;
                if (Cached(guarded, AutomationElement.RuntimeIdProperty) is int[] identity && identity.Length is > 0 and <= 64 &&
                    !seen.Add(string.Join(",", identity))) return;
                if (!WithinBudget()) return;
                var properties = element.GetUpdatedCache(details);
                var node = new SnapshotNode
                {
                    Role = (Cached(properties, AutomationElement.ControlTypeProperty) as ControlType)?.ProgrammaticName.Replace("ControlType.", "", StringComparison.Ordinal),
                    Name = Cached(properties, AutomationElement.NameProperty) as string,
                    Help = Cached(properties, AutomationElement.HelpTextProperty) as string,
                    Value = Cached(properties, ValuePattern.ValueProperty) as string,
                    Enabled = Cached(properties, AutomationElement.IsEnabledProperty) as bool?,
                    Focused = Cached(properties, AutomationElement.HasKeyboardFocusProperty) as bool?,
                    Selected = Cached(properties, SelectionItemPattern.IsSelectedProperty) as bool?,
                    ReadOnly = Cached(properties, ValuePattern.IsReadOnlyProperty) as bool? ??
                        Cached(properties, RangeValuePattern.IsReadOnlyProperty) as bool?,
                    Checked = Cached(properties, TogglePattern.ToggleStateProperty) is ToggleState toggle ? toggle switch
                    {
                        ToggleState.Off => SnapshotToggleState.Off,
                        ToggleState.On => SnapshotToggleState.On,
                        ToggleState.Indeterminate => SnapshotToggleState.Mixed,
                        _ => null,
                    } : null,
                    Expanded = Cached(properties, ExpandCollapsePattern.ExpandCollapseStateProperty) is ExpandCollapseState expand ? expand switch
                    {
                        ExpandCollapseState.Collapsed => SnapshotExpandState.Collapsed,
                        ExpandCollapseState.Expanded => SnapshotExpandState.Expanded,
                        ExpandCollapseState.PartiallyExpanded => SnapshotExpandState.Partial,
                        ExpandCollapseState.LeafNode => SnapshotExpandState.Leaf,
                        _ => null,
                    } : null,
                };
                if (Cached(properties, RangeValuePattern.ValueProperty) is double rangeValue &&
                    Cached(properties, RangeValuePattern.MinimumProperty) is double minimum &&
                    Cached(properties, RangeValuePattern.MaximumProperty) is double maximum)
                    node = node with { Range = new SnapshotRange(rangeValue, minimum, maximum) };
                // Optional text/selection providers can fail independently of
                // the primitive fields. Keep the captured node in that case.
                try
                {
                    if (WithinBudget() && element.TryGetCurrentPattern(TextPattern.Pattern, out var text) && text is TextPattern pattern)
                    {
                        if (WithinBudget() && pattern.SupportedTextSelection != SupportedTextSelection.None)
                            node = node with { SelectedText = ReadRanges(pattern.GetSelection()) };
                        if (WithinBudget()) node = node with { Text = ReadRanges(pattern.GetVisibleRanges()) };
                    }
                }
                catch (Exception exception) when (exception is ElementNotAvailableException or InvalidOperationException or COMException)
                { reasons.Add("provider_read_failed"); }
                try
                {
                    if (WithinBudget() && element.TryGetCurrentPattern(SelectionPattern.Pattern, out var selection) && selection is SelectionPattern pattern)
                        node = node with { SelectionCount = pattern.Current.GetSelection().Length };
                }
                catch (Exception exception) when (exception is ElementNotAvailableException or InvalidOperationException or COMException)
                { reasons.Add("provider_read_failed"); }
                if (node.Focused == true)
                    source = source with { FocusedRole = node.Role,
                        FocusedName = node.Name == null ? null : SnapshotTextTree.Bound(node.Name, 256) };
                if (!string.IsNullOrEmpty(node.SelectedText) && (source.SelectedText == null || node.Focused == true))
                    source = source with { SelectedText = node.SelectedText };
                // UIA has no general page-URL property. Admit only a Document
                // provider's explicit URL value, never guess from title or text.
                if (node.Role == "Document" && source.Url == null && SnapshotSource.VerifiedUrl(node.Value) is { } url)
                    source = source with { Url = url };
                output.Append(node, depth);
                // Read the already-rooted focus route before spending time
                // enumerating a wide sibling list. The ordinary Visit privacy
                // guard applies to each ancestor and the focused control.
                if (WithinBudget() && focusChildren.TryGetValue(Identity(element), out var focusedChild))
                    Visit(focusedChild, depth + 1);
                var child = WithinBudget() ? walker.GetFirstChild(element) : null;
                var children = new List<(AutomationElement Element, int Rank, int Index)>();
                while (child != null && WithinBudget() && children.Count < MaxNodes - nodes)
                {
                    var childIdentity = Identity(child);
                    children.Add((child, focusPath.Contains(childIdentity) ? 0 : 4, children.Count));
                    child = walker.GetNextSibling(child);
                }
                if (child != null && children.Count >= MaxNodes - nodes) reasons.Add("node_budget_reached");
                var rankingDeadline = Math.Min(650, clock.ElapsedMilliseconds + 75);
                for (var index = 0; index < Math.Min(children.Count, 24) && WithinBudget() && clock.ElapsedMilliseconds < rankingDeadline; index++)
                {
                    var item = children[index];
                    if (item.Rank == 0) continue;
                    var role = item.Element.GetCurrentPropertyValue(AutomationElement.ControlTypeProperty, true) as ControlType;
                    var modal = item.Element.GetCurrentPropertyValue(WindowPattern.IsModalProperty, true) is true;
                    var selected = item.Element.GetCurrentPropertyValue(SelectionItemPattern.IsSelectedProperty, true) is true;
                    children[index] = (item.Element, SnapshotPriority.Rank(false, modal,
                        role?.ProgrammaticName.Replace("ControlType.", "", StringComparison.Ordinal), selected), item.Index);
                }
                foreach (var item in children.OrderBy(item => item.Rank).ThenBy(item => item.Index))
                    if (WithinBudget()) Visit(item.Element, depth + 1);
            }
            catch (Exception exception) when (exception is ElementNotAvailableException or InvalidOperationException or COMException)
            { reasons.Add("provider_read_failed"); }
        }
        Visit(root, 0);
        if (clock.ElapsedMilliseconds >= 650) reasons.Add("time_budget_reached");
        if (nodes >= MaxNodes) reasons.Add("node_budget_reached");
        reasons.UnionWith(output.Reasons);
        var capturedText = output.ToString();
        if (capturedText.Length == 0) reasons.Add("no_accessible_content");
        return new TextResult(capturedText, SnapshotCaptureQuality.Create(capturedText, reasons, nodes), source,
            startedAt, DateTime.UtcNow.ToString("O"));
    }

    private static async Task<WorkerResult> RunWorker(int timeoutMilliseconds, params string[] arguments)
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Cannot locate helper executable.");
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "ContextSnapshot.dll"));
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        Process process;
        lock (WorkerLock)
        {
            if (Volatile.Read(ref stopping) != 0) throw new OperationCanceledException("Helper is stopping.");
            process = Process.Start(start) ?? throw new InvalidOperationException("Cannot start capture worker.");
            Workers.Add(process);
        }
        try
        {
            var output = process.StandardOutput.ReadToEndAsync();
            var diagnostic = process.StandardError.ReadToEndAsync();
            var exit = process.WaitForExitAsync();
            if (await Task.WhenAny(exit, Task.Delay(timeoutMilliseconds)) != exit)
            {
                try { process.Kill(entireProcessTree: true); }
                catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception) { }
                await exit;
                _ = await output;
                _ = await diagnostic;
                return new WorkerResult("", -1, true);
            }
            await exit;
            var stderr = await diagnostic;
            if (!string.IsNullOrWhiteSpace(stderr)) Console.Error.WriteLine(stderr.Trim());
            return new WorkerResult((await output).Trim(), process.ExitCode, false);
        }
        finally
        {
            lock (WorkerLock) Workers.Remove(process);
            process.Dispose();
        }
    }

    private static nint ParseHandle(string value) => (nint)long.Parse(value, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
    private static string HandleString(nint value) => value.ToInt64().ToString("X", CultureInfo.InvariantCulture);
    private static string ErrorCode(Exception exception) => exception is CaptureException capture ? capture.Code : "capture_failed";
    private static void WriteError(string? captureId, string code, string message) => Write(new { type = "error", captureId, error = new { code, message } });
    private static void Write(object value) { lock (OutputLock) Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions)); }
    private static void Shutdown()
    {
        if (Interlocked.Exchange(ref stopping, 1) != 0) return;
        StopRecorder();
        recorderTimer?.Dispose();
        lock (WorkerLock)
            foreach (var worker in Workers)
                try { worker.Kill(entireProcessTree: true); }
                catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception) { }
        Native.PostThreadMessage(messageThread, 0x12, 0, 0);
    }

    private static int SelfTest()
    {
        var checks = 0;
        void Assert(bool condition, string description)
        {
            checks++;
            if (!condition) throw new InvalidOperationException(description);
        }
        try
        {
            var state = new ShortcutGesture();
            Assert(!state.Update("ControlLeft", true), "Left Ctrl alone must not capture.");
            Assert(state.Update("ControlRight", true), "Both Ctrl keys must capture once.");
            Assert(!state.Update("ControlRight", true), "Key repeat must not capture.");
            Assert(!state.Update("ControlLeft", true), "Holding both keys must not repeat.");
            Assert(!state.Update("ControlRight", false), "Releasing a key must not capture.");
            Assert(state.Update("ControlRight", true), "Re-press after release must capture.");
            Assert(!state.Update("ControlLeft", false), "Left release resets the gesture.");
            Assert(!state.Update("ControlRight", false), "Both releases must not capture.");
            Assert(!state.Update("ControlRight", true), "Right Ctrl alone must not capture.");
            Assert(state.Update("ControlLeft", true), "Reverse press order must capture.");
            using var custom = JsonDocument.Parse("{\"version\":1,\"codes\":[\"ControlLeft\",\"KeyS\"]}");
            state.Configure(custom.RootElement);
            Assert(!state.Update("KeyS", true), "A partial custom pair must not capture.");
            Assert(!state.Update("ControlLeft", true), "Keys held across reconfiguration must be released first.");
            state.Update("ControlLeft", false);
            state.Update("ControlRight", false);
            Assert(state.Update("ControlLeft", true), "A complete custom chord captures after release.");
            state.SetRecording(true);
            Assert(!state.Update("KeyS", true), "Recording suspends capture.");
            state.SetRecording(false);
            Assert(!state.Update("ControlLeft", true), "Keys held through recording must not capture on repeat.");
            foreach (var key in custom.RootElement.GetProperty("codes").EnumerateArray()) state.Update(key.GetString(), false);
            Assert(!state.Update("ControlLeft", true) && state.Update("KeyS", true), "Recording cleanup permits the next fresh pair.");
            using var oversized = JsonDocument.Parse("{\"version\":1,\"codes\":[\"F8\",\"F9\",\"F10\"]}");
            var oversizedRejected = false;
            try { state.Configure(oversized.RootElement); } catch (InvalidOperationException) { oversizedRejected = true; }
            Assert(oversizedRejected && state.Configuration.Codes.Length == 2, "Old three-key configurations must be rejected without replacing the pair.");
            Assert(TargetPolicy.IsExcluded("DeepSeek.exe"), "DSH must not capture itself.");
            Assert(TargetPolicy.IsExcluded("dsh-context-snapshot"), "Helper must not capture itself.");
            Assert(!TargetPolicy.IsExcluded("deepseek-notes"), "Do not exclude unrelated process names by substring.");
            Assert(!TargetPolicy.IsExcluded("chrome"), "Browsers must remain eligible.");
            Assert(ShortcutKeys.Resolve(0x11, 0x1D, 1) == "ControlRight", "Extended generic Ctrl is right Ctrl.");
            Assert(ShortcutKeys.Resolve(0x11, 0x1D, 0) == "ControlLeft", "Non-extended generic Ctrl is left Ctrl.");
            var intersection = Intersect(new Native.Rect(0, 0, 100, 100), new Native.Rect(10, 20, 90, 80));
            Assert(intersection.Width == 80 && intersection.Height == 60, "Crop must remain within the target window.");
            using var iconSource = new Bitmap(16, 16, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(iconSource))
            {
                graphics.Clear(Color.Transparent);
                graphics.FillRectangle(Brushes.DodgerBlue, 4, 4, 8, 8);
            }
            var syntheticHandle = iconSource.GetHicon();
            try
            {
                var encodedIcon = EncodeBorrowedIcon(syntheticHandle);
                Assert(!string.IsNullOrEmpty(encodedIcon), "An available app icon must produce PNG data.");
                var iconBytes = Convert.FromBase64String(encodedIcon!);
                Assert(iconBytes.Length <= MaxAppIconPngBytes, "App icon PNG must stay within 8 KiB.");
                using var iconStream = new MemoryStream(iconBytes);
                using var decodedIcon = new Bitmap(iconStream);
                Assert(decodedIcon.Width == AppIconPixels && decodedIcon.Height == AppIconPixels, "App icons must be bounded to 32 pixels.");
                Assert(decodedIcon.GetPixel(0, 0).A == 0, "App icon transparency must survive PNG encoding.");
            }
            finally { Native.DestroyIcon(syntheticHandle); }
            Assert(EncodeBorrowedIcon(0) == null, "An unavailable app icon must be optional.");
            Write(new { type = "self-test", ok = true, checks });
            return 0;
        }
        catch (Exception exception) { Write(new { type = "self-test", ok = false, checks, error = exception.Message }); return 1; }
    }

    private sealed record CaptureData(string PngBase64, string Title, string AppName, int Pid, int Width, int Height, string Text, string CapturedAt,
        SnapshotCaptureQuality CaptureQuality, SnapshotSource Source, SnapshotTiming Timing,
        string[] Warnings,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? AppIconPngBase64);
    private sealed record TextResult(string Text, SnapshotCaptureQuality CaptureQuality, SnapshotSource Source, string TextStartedAt, string TextFinishedAt);
    private sealed record IconResult(string? AppIconPngBase64);
    private sealed record WorkerError(string Code, string Message);
    private sealed record WorkerResult(string Output, int ExitCode, bool TimedOut);
    private sealed class CaptureException(string code, string message) : Exception(message) { public string Code { get; } = code; }
}

internal static class Native
{
    internal delegate nint HookProc(int code, nint message, nint data);
    internal delegate void WinEventProc(nint hook, uint eventType, nint window, int objectId, int childId, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential)] internal struct KeyboardInput { public uint vkCode, scanCode, flags, time; public nuint extraInfo; }
    [StructLayout(LayoutKind.Sequential)] internal readonly struct Rect(int left, int top, int right, int bottom)
    {
        public readonly int Left = left, Top = top, Right = right, Bottom = bottom;
        public int Width => Right - Left;
        public int Height => Bottom - Top;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Message { public nint hwnd; public uint message; public nuint wParam; public nint lParam; public uint time; public int x, y; public uint privateValue; }
    [DllImport("user32.dll", SetLastError = true)] internal static extern nint SetWindowsHookEx(int hook, HookProc callback, nint module, uint threadId);
    [DllImport("user32.dll")] internal static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] internal static extern nint CallNextHookEx(nint hook, int code, nint message, nint data);
    [DllImport("user32.dll")] internal static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] internal static extern nint SetWinEventHook(uint minimum, uint maximum, nint module, WinEventProc callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] internal static extern bool UnhookWinEvent(nint hook);
    [DllImport("user32.dll")] internal static extern bool IsWindow(nint window);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] internal static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(nint window, out Rect rectangle);
    [DllImport("user32.dll")] internal static extern bool PrintWindow(nint window, nint deviceContext, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern nint SendMessageTimeout(nint window, uint message, nuint wParam, nint lParam, uint flags, uint timeout, out nuint result);
    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] internal static extern nint GetClassLongPtr(nint window, int attribute);
    [DllImport("user32.dll")] internal static extern bool DestroyIcon(nint icon);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(nint window, StringBuilder text, int maximum);
    [DllImport("user32.dll")] internal static extern bool PostThreadMessage(uint thread, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll")] internal static extern bool PeekMessage(out Message message, nint window, uint minimum, uint maximum, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern nint GetModuleHandle(string? module);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(nint window, uint attribute, out Rect rectangle, int bytes);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(nint window, uint attribute, out int value, int bytes);
}
