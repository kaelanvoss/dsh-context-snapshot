using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;
using System.Windows.Forms;

namespace DshContextSnapshot;

internal static class Program
{
    private const int MaxPngBytes = 12 * 1024 * 1024;
    private const int MaxTextChars = 16_000;
    private const int MaxNodes = 300;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly object OutputLock = new();
    private static readonly object WorkerLock = new();
    private static readonly HashSet<Process> Workers = [];
    private static readonly SemaphoreSlim CaptureGate = new(1, 1);
    private static readonly DualControlGesture Gesture = new();
    private static readonly Native.HookProc HookCallback = KeyboardHook;
    private static nint hook;
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
        if (args.Length != 0)
        {
            Console.Error.WriteLine("Usage: ContextSnapshot.exe [--self-test]");
            return 2;
        }

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
        _ = Task.Run(ReadCommands);
        Write(new { type = "ready", protocol = 1, platform = "win32" });
        try { Application.Run(); }
        finally
        {
            Interlocked.Exchange(ref stopping, 1);
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
            if ((input.flags & 0x10) == 0 && (message == 0x100 || message == 0x104 || message == 0x101 || message == 0x105))
            {
                var key = ResolveControl(input.vkCode, input.flags);
                var down = message == 0x100 || message == 0x104;
                if (key != ControlKey.None && Gesture.Update(key, down))
                {
                    var target = Native.GetForegroundWindow();
                    var captureId = Guid.NewGuid().ToString("D");
                    _ = Task.Run(() => QueueCapture(target, captureId));
                }
            }
        }
        return Native.CallNextHookEx(hook, code, message, data);
    }

    private static ControlKey ResolveControl(uint key, uint flags) => key switch
    {
        0xA2 => ControlKey.Left,
        0xA3 => ControlKey.Right,
        0x11 => (flags & 1) == 0 ? ControlKey.Left : ControlKey.Right,
        _ => ControlKey.None,
    };

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
                    Write(new { type = "result", id, ok = false, error = new { code = "invalid_request", message = exception.Message } });
                }
            }
        }
        catch (IOException exception) { Console.Error.WriteLine(exception.Message); }
        finally { Shutdown(); }
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
        using var image = full.Clone(new Rectangle(frame.Left - raw.Left, frame.Top - raw.Top, frame.Width, frame.Height), PixelFormat.Format32bppArgb);
        if (IsBlankBlack(image))
            throw new CaptureException("capture_unsupported", "The foreground application returned a blank window image.");
        using var stream = new MemoryStream();
        image.Save(stream, ImageFormat.Png);
        if (stream.Length > MaxPngBytes)
            throw new CaptureException("capture_too_large", "The PNG exceeds the 12 MiB attachment limit.");

        var title = new StringBuilder(4096);
        Native.GetWindowText(target, title, title.Capacity);
        using var process = Process.GetProcessById((int)processId);
        var textWorker = RunWorker(1000, "--extract-text", HandleString(target)).GetAwaiter().GetResult();
        var text = "";
        string[] warnings = [];
        if (textWorker.TimedOut) warnings = ["ui_automation_timeout"];
        else if (textWorker.ExitCode != 0) warnings = ["ui_automation_unavailable"];
        else
        {
            try { text = JsonSerializer.Deserialize<TextResult>(textWorker.Output, JsonOptions)?.Text ?? ""; }
            catch (JsonException) { warnings = ["ui_automation_unavailable"]; }
        }
        return new CaptureData(Convert.ToBase64String(stream.ToArray()), title.ToString(), process.ProcessName,
            (int)processId, image.Width, image.Height, text[..Math.Min(text.Length, MaxTextChars)], DateTime.UtcNow.ToString("O"), warnings);
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
        var result = new TextResult("");
        Exception? failure = null;
        var worker = new Thread(() =>
        {
            try { result = new TextResult(ReadWindowText(target)); }
            catch (Exception exception) { failure = exception; }
        }) { IsBackground = true };
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        if (!worker.Join(900)) return 3;
        if (failure != null) { Console.Error.WriteLine(failure.Message); return 1; }
        Write(result);
        return 0;
    }

    private static string ReadWindowText(nint target)
    {
        var clock = Stopwatch.StartNew();
        var root = AutomationElement.FromHandle(target);
        var output = new StringBuilder(MaxTextChars);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var walker = TreeWalker.ControlViewWalker;
        var nodes = 0;
        bool WithinBudget() => clock.ElapsedMilliseconds < 850 && nodes < MaxNodes && output.Length < MaxTextChars;
        void Add(string? value)
        {
            if (string.IsNullOrWhiteSpace(value) || output.Length >= MaxTextChars) return;
            var bounded = value.Trim();
            bounded = bounded[..Math.Min(bounded.Length, MaxTextChars - output.Length)];
            if (!seen.Add(bounded)) return;
            if (output.Length != 0 && output.Length < MaxTextChars) output.Append('\n');
            output.Append(bounded.AsSpan(0, Math.Min(bounded.Length, MaxTextChars - output.Length)));
        }
        void Visit(AutomationElement element, int depth)
        {
            if (!WithinBudget() || depth > 40) return;
            nodes++;
            try
            {
                var properties = element.Current;
                if (properties.IsPassword) return;
                if (!properties.IsPassword && !properties.IsOffscreen)
                {
                    Add(properties.Name);
                    if (WithinBudget() && element.TryGetCurrentPattern(ValuePattern.Pattern, out var value))
                        Add(((ValuePattern)value).Current.Value);
                    if (WithinBudget() && element.TryGetCurrentPattern(TextPattern.Pattern, out var text))
                        foreach (var range in ((TextPattern)text).GetVisibleRanges())
                        {
                            if (!WithinBudget()) break;
                            Add(range.GetText(MaxTextChars - output.Length));
                        }
                }
                var child = WithinBudget() ? walker.GetFirstChild(element) : null;
                while (child != null && WithinBudget())
                {
                    Visit(child, depth + 1);
                    child = WithinBudget() ? walker.GetNextSibling(child) : null;
                }
            }
            catch (ElementNotAvailableException) { }
            catch (InvalidOperationException) { }
        }
        Visit(root, 0);
        return output.ToString();
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
            var state = new DualControlGesture();
            Assert(!state.Update(ControlKey.Left, true), "Left Ctrl alone must not capture.");
            Assert(state.Update(ControlKey.Right, true), "Both Ctrl keys must capture once.");
            Assert(!state.Update(ControlKey.Right, true), "Key repeat must not capture.");
            Assert(!state.Update(ControlKey.Left, true), "Holding both keys must not repeat.");
            Assert(!state.Update(ControlKey.Right, false), "Releasing a key must not capture.");
            Assert(state.Update(ControlKey.Right, true), "Re-press after release must capture.");
            Assert(!state.Update(ControlKey.Left, false), "Left release resets the gesture.");
            Assert(!state.Update(ControlKey.Right, false), "Both releases must not capture.");
            Assert(!state.Update(ControlKey.Right, true), "Right Ctrl alone must not capture.");
            Assert(state.Update(ControlKey.Left, true), "Reverse press order must capture.");
            Assert(TargetPolicy.IsExcluded("DeepSeek.exe"), "DSH must not capture itself.");
            Assert(TargetPolicy.IsExcluded("dsh-context-snapshot"), "Helper must not capture itself.");
            Assert(!TargetPolicy.IsExcluded("deepseek-notes"), "Do not exclude unrelated process names by substring.");
            Assert(!TargetPolicy.IsExcluded("chrome"), "Browsers must remain eligible.");
            Assert(ResolveControl(0x11, 1) == ControlKey.Right, "Extended generic Ctrl is right Ctrl.");
            Assert(ResolveControl(0x11, 0) == ControlKey.Left, "Non-extended generic Ctrl is left Ctrl.");
            var intersection = Intersect(new Native.Rect(0, 0, 100, 100), new Native.Rect(10, 20, 90, 80));
            Assert(intersection.Width == 80 && intersection.Height == 60, "Crop must remain within the target window.");
            Write(new { type = "self-test", ok = true, checks });
            return 0;
        }
        catch (Exception exception) { Write(new { type = "self-test", ok = false, checks, error = exception.Message }); return 1; }
    }

    private sealed record CaptureData(string PngBase64, string Title, string AppName, int Pid, int Width, int Height, string Text, string CapturedAt, string[] Warnings);
    private sealed record TextResult(string Text);
    private sealed record WorkerError(string Code, string Message);
    private sealed record WorkerResult(string Output, int ExitCode, bool TimedOut);
    private sealed class CaptureException(string code, string message) : Exception(message) { public string Code { get; } = code; }
}

internal static class Native
{
    internal delegate nint HookProc(int code, nint message, nint data);
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
    [DllImport("user32.dll")] internal static extern bool IsWindow(nint window);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] internal static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(nint window, out Rect rectangle);
    [DllImport("user32.dll")] internal static extern bool PrintWindow(nint window, nint deviceContext, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(nint window, StringBuilder text, int maximum);
    [DllImport("user32.dll")] internal static extern bool PostThreadMessage(uint thread, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll")] internal static extern bool PeekMessage(out Message message, nint window, uint minimum, uint maximum, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern nint GetModuleHandle(string? module);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(nint window, uint attribute, out Rect rectangle, int bytes);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(nint window, uint attribute, out int value, int bytes);
}
