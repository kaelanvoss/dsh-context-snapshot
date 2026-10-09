using System.IO;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace DshContextSnapshot;

internal sealed record ShortcutConfiguration(int Version, string[] Codes);

internal static class ShortcutKeys
{
    // Scan codes identify physical keys, independently of the active keyboard
    // layout. Extended navigation keys differ from their numeric-pad peers.
    private static readonly Dictionary<uint, string> ScanCodes = new()
    {
        [0x01] = "Escape", [0x02] = "Digit1", [0x03] = "Digit2", [0x04] = "Digit3", [0x05] = "Digit4",
        [0x06] = "Digit5", [0x07] = "Digit6", [0x08] = "Digit7", [0x09] = "Digit8", [0x0A] = "Digit9",
        [0x0B] = "Digit0", [0x0C] = "Minus", [0x0D] = "Equal", [0x0E] = "Backspace", [0x0F] = "Tab",
        [0x10] = "KeyQ", [0x11] = "KeyW", [0x12] = "KeyE", [0x13] = "KeyR", [0x14] = "KeyT",
        [0x15] = "KeyY", [0x16] = "KeyU", [0x17] = "KeyI", [0x18] = "KeyO", [0x19] = "KeyP",
        [0x1A] = "BracketLeft", [0x1B] = "BracketRight", [0x1C] = "Enter", [0x1D] = "ControlLeft",
        [0x1E] = "KeyA", [0x1F] = "KeyS", [0x20] = "KeyD", [0x21] = "KeyF", [0x22] = "KeyG",
        [0x23] = "KeyH", [0x24] = "KeyJ", [0x25] = "KeyK", [0x26] = "KeyL", [0x27] = "Semicolon",
        [0x28] = "Quote", [0x29] = "Backquote", [0x2A] = "ShiftLeft", [0x2B] = "Backslash",
        [0x2C] = "KeyZ", [0x2D] = "KeyX", [0x2E] = "KeyC", [0x2F] = "KeyV", [0x30] = "KeyB",
        [0x31] = "KeyN", [0x32] = "KeyM", [0x33] = "Comma", [0x34] = "Period", [0x35] = "Slash",
        [0x36] = "ShiftRight", [0x37] = "NumpadMultiply", [0x38] = "AltLeft", [0x39] = "Space",
        [0x3B] = "F1", [0x3C] = "F2", [0x3D] = "F3", [0x3E] = "F4", [0x3F] = "F5",
        [0x40] = "F6", [0x41] = "F7", [0x42] = "F8", [0x43] = "F9", [0x44] = "F10",
        [0x47] = "Numpad7", [0x48] = "Numpad8", [0x49] = "Numpad9", [0x4A] = "NumpadSubtract",
        [0x4B] = "Numpad4", [0x4C] = "Numpad5", [0x4D] = "Numpad6", [0x4E] = "NumpadAdd",
        [0x4F] = "Numpad1", [0x50] = "Numpad2", [0x51] = "Numpad3", [0x52] = "Numpad0",
        [0x53] = "NumpadDecimal", [0x56] = "IntlBackslash", [0x57] = "F11", [0x58] = "F12",
    };
    private static readonly Dictionary<uint, string> ExtendedScanCodes = new()
    {
        [0x1C] = "NumpadEnter", [0x1D] = "ControlRight", [0x35] = "NumpadDivide", [0x38] = "AltRight",
        [0x47] = "Home", [0x48] = "ArrowUp", [0x49] = "PageUp", [0x4B] = "ArrowLeft",
        [0x4D] = "ArrowRight", [0x4F] = "End", [0x50] = "ArrowDown", [0x51] = "PageDown",
        [0x52] = "Insert", [0x53] = "Delete", [0x5B] = "MetaLeft", [0x5C] = "MetaRight",
    };
    public static readonly string[] SupportedCodes = ScanCodes.Values.Concat(ExtendedScanCodes.Values)
        .Concat(Enumerable.Range(1, 24).Select(number => "F" + number))
        .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
    private static readonly HashSet<string> Supported = new(SupportedCodes, StringComparer.Ordinal);

    public static bool IsInjected(uint flags) => (flags & 0x12) != 0;

    public static string? Resolve(uint virtualKey, uint scanCode, uint flags)
    {
        // Some keyboards report F13-F24 without the usual physical scan codes.
        if (virtualKey is >= 0x70 and <= 0x87) return "F" + (virtualKey - 0x70 + 1);
        if (virtualKey == 0xA0) return "ShiftLeft";
        if (virtualKey == 0xA1) return "ShiftRight";
        if (virtualKey == 0xA2) return "ControlLeft";
        if (virtualKey == 0xA3) return "ControlRight";
        if (virtualKey == 0xA4) return "AltLeft";
        if (virtualKey == 0xA5) return "AltRight";
        if (virtualKey == 0x5B) return "MetaLeft";
        if (virtualKey == 0x5C) return "MetaRight";
        var extended = (flags & 1) != 0;
        if (virtualKey == 0x11) return extended ? "ControlRight" : "ControlLeft";
        if (virtualKey == 0x12) return extended ? "AltRight" : "AltLeft";
        if (virtualKey == 0x10) return scanCode == 0x36 ? "ShiftRight" : "ShiftLeft";
        return (extended ? ExtendedScanCodes : ScanCodes).GetValueOrDefault(scanCode);
    }

    public static ShortcutConfiguration Validate(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object
            || !value.TryGetProperty("version", out var version) || !version.TryGetInt32(out var number) || number != 1
            || !value.TryGetProperty("codes", out var codes) || codes.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("Shortcut must have version 1 and an array of physical key codes.");
        var keys = new List<string>();
        var unique = new HashSet<string>(StringComparer.Ordinal);
        foreach (var valueCode in codes.EnumerateArray())
        {
            if (valueCode.ValueKind != JsonValueKind.String || valueCode.GetString() is not { } code || !Supported.Contains(code))
                throw new InvalidOperationException("Shortcut contains an unsupported physical key code.");
            if (!unique.Add(code)) throw new InvalidOperationException("Shortcut must use distinct physical keys.");
            keys.Add(code);
        }
        if (keys.Count != 2) throw new InvalidOperationException("Shortcut requires exactly two distinct physical keys.");
        return new ShortcutConfiguration(1, keys.ToArray());
    }
}

internal sealed class ShortcutGesture
{
    private readonly object sync = new();
    private readonly HashSet<string> pressed = new(StringComparer.Ordinal);
    private readonly HashSet<string> blockedUntilRelease = new(StringComparer.Ordinal);
    private ShortcutConfiguration configuration = new(1, ["ControlLeft", "ControlRight"]);
    private HashSet<string> binding = new(["ControlLeft", "ControlRight"], StringComparer.Ordinal);
    private bool fired;
    private bool recording;
    public ShortcutConfiguration Configuration
    {
        get { lock (sync) return new(configuration.Version, (string[])configuration.Codes.Clone()); }
    }
    public bool Recording { get { lock (sync) return recording; } }
    public void Configure(JsonElement value)
    {
        // Validate before taking ownership: a rejected update keeps the old
        // binding and its press state intact.
        var validated = ShortcutKeys.Validate(value);
        lock (sync)
        {
            configuration = validated;
            binding = new(validated.Codes, StringComparer.Ordinal);
            ResetForTransition();
        }
    }
    public void SetRecording(bool active)
    {
        lock (sync)
        {
            recording = active;
            ResetForTransition();
        }
    }
    private void ResetForTransition()
    {
        blockedUntilRelease.UnionWith(pressed);
        pressed.Clear();
        fired = false;
    }
    public bool Update(string? code, bool down)
    {
        if (code == null) return false;
        lock (sync)
        {
            if (!down)
            {
                blockedUntilRelease.Remove(code);
                pressed.Remove(code);
                if (binding.Contains(code)) fired = false;
                return false;
            }
            if (recording) { blockedUntilRelease.Add(code); return false; }
            if (blockedUntilRelease.Contains(code) || !pressed.Add(code)) return false;
            if (fired || blockedUntilRelease.Count != 0 || !pressed.SetEquals(binding)) return false;
            fired = true;
            return true;
        }
    }
}

internal static class TargetPolicy
{
    private static readonly HashSet<string> Excluded = new(StringComparer.OrdinalIgnoreCase)
    {
        "dsh", "deepseek", "deepseek-harness", "deepseek harness", "dsh desktop", "dsh-context-snapshot", "contextsnapshot",
    };
    public static bool IsExcluded(string processName) => Excluded.Contains(Path.GetFileNameWithoutExtension(processName.Trim()));
}

internal sealed class ShortcutRecordingException(string code, string message) : InvalidOperationException(message)
{ public string Code { get; } = code; }
internal sealed record ShortcutRecordingState(string Token, string State, string[] Current, string[] Peak);

internal readonly record struct ShortcutRecordingWindow(nint Handle, uint ProcessId)
{
    public bool Matches(nint handle, uint processId) => Handle != 0 && ProcessId != 0 && Handle == handle && ProcessId == processId;
}

/// A single short-lived physical chord, not a keyboard event log. This class
/// owns no character data and keeps only the held set and its simultaneous peak.
internal sealed class PhysicalShortcutRecorder
{
    private readonly object sync = new();
    private readonly HashSet<string> current = new(StringComparer.Ordinal);
    private HashSet<string> peak = new(StringComparer.Ordinal);
    private string? token;
    private string state = "ended";
    private long deadline;
    private bool released;
    public bool Active { get { lock (sync) return token != null && state is "waiting" or "holding"; } }
    private ShortcutRecordingState Snapshot() => new(token ?? "", state, current.Order(StringComparer.Ordinal).ToArray(), peak.Order(StringComparer.Ordinal).ToArray());
    public ShortcutRecordingState Begin(string? value, long now, bool focused, IEnumerable<string> held)
    {
        lock (sync)
        {
            if (value == null || value.Length is < 16 or > 128 || value == token)
                throw new ShortcutRecordingException("INVALID_RECORDING_TOKEN", "Recording requires a fresh short token.");
            if (!focused) throw new ShortcutRecordingException("RECORDING_NOT_FOCUSED", "Keep DeepSeek Harness in the foreground while recording.");
            if (held.Any()) throw new ShortcutRecordingException("KEYS_ALREADY_HELD", "Release every key before starting a new recording.");
            token = value; state = "waiting"; current.Clear(); peak.Clear(); released = false; deadline = now + 15_000;
            return Snapshot();
        }
    }
    public void Check(long now, bool focused)
    {
        lock (sync)
        {
            if (!Active) return;
            if (now >= deadline) { state = "expired"; current.Clear(); peak.Clear(); }
            else if (!focused) { state = "interrupted"; current.Clear(); peak.Clear(); }
        }
    }
    public void Update(string code, bool down, long now, bool focused)
    {
        lock (sync)
        {
            Check(now, focused);
            if (state is not ("waiting" or "holding")) return;
            if (!ShortcutKeys.SupportedCodes.Contains(code, StringComparer.Ordinal))
            { state = "interrupted"; current.Clear(); peak.Clear(); return; }
            if (down)
            {
                if (released) return;
                if (!current.Contains(code) && current.Count == 2)
                { state = "too_many"; current.Clear(); peak.Clear(); return; }
                current.Add(code);
                if (current.Count > peak.Count) peak = new(current, StringComparer.Ordinal);
                state = "holding";
            }
            else if (current.Remove(code))
            {
                released = true;
                if (current.Count == 0) state = "complete";
            }
        }
    }
    public ShortcutRecordingState Read(string? value, long now, bool focused)
    {
        lock (sync) { Require(value); Check(now, focused); return Snapshot(); }
    }
    public ShortcutRecordingState End(string? value)
    {
        lock (sync) { Require(value); Stop(); return Snapshot(); }
    }
    public void Stop(bool clearToken = false)
    {
        lock (sync) { state = "ended"; current.Clear(); peak.Clear(); released = false; if (clearToken) token = null; }
    }
    private void Require(string? value)
    {
        if (string.IsNullOrEmpty(value) || value != token)
            throw new ShortcutRecordingException("INVALID_RECORDING_TOKEN", "This recording lease is no longer current.");
    }
}

internal enum SnapshotToggleState { Off, On, Mixed }
internal enum SnapshotExpandState { Collapsed, Expanded, Partial, Leaf }
internal sealed record SnapshotRange(double Value, double Minimum, double Maximum);
internal static class SnapshotPrivacy
{
    public static bool CanRead(bool? password, bool? offscreen) => password is false && offscreen is false;
}

internal sealed record SnapshotCaptureQuality(string Status, string[] Reasons, string TextSource, int NodeCount,
    string Scope = "uia_control_view_visible")
{
    internal static SnapshotCaptureQuality Create(string text, IEnumerable<string> reasons, int nodes)
    {
        var unique = reasons.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        return new(text.Length == 0 ? "image_only" : unique.Length == 0 ? "available" : "partial", unique, "uia", nodes);
    }
}

internal sealed record SnapshotSource
{
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? Url { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? SelectedText { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? FocusedRole { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? FocusedName { get; init; }

    internal static string? VerifiedUrl(string? value) => value is { Length: <= 2048 } &&
        Uri.TryCreate(value, UriKind.Absolute, out var url) && url.Scheme is "http" or "https" or "file" ? value : null;
}

internal sealed record SnapshotTiming(string ImageCapturedAt, string TextStartedAt, string TextFinishedAt);

internal static class SnapshotPriority
{
    internal static int Rank(bool focusRoute, bool modalWindow, string? role, bool selected = false) =>
        focusRoute ? 0 : selected ? 1 : modalWindow ? 2 : role == "Document" ? 3 : 4;
}

// Only admitted primitive fields enter the formatter; UIA objects and text ranges
// stay in the capture worker and are never rendered through arbitrary ToString().
internal sealed record SnapshotNode
{
    public string? Role { get; init; }
    public string? Name { get; init; }
    public string? Value { get; init; }
    public string? Help { get; init; }
    public string? Text { get; init; }
    public string? SelectedText { get; init; }
    public bool? Enabled { get; init; }
    public bool? Focused { get; init; }
    public bool? Selected { get; init; }
    public bool? ReadOnly { get; init; }
    public SnapshotToggleState? Checked { get; init; }
    public SnapshotExpandState? Expanded { get; init; }
    public SnapshotRange? Range { get; init; }
    public int? SelectionCount { get; init; }
}

internal sealed class SnapshotTextTree(int maxChars, int maxNodes, int maxDepth)
{
    private const int LabelChars = 256;
    internal const int FieldChars = 1024;
    private static readonly JsonSerializerOptions StringOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private readonly StringBuilder output = new();
    private int nodes;
    public bool CanAppend => nodes < maxNodes && output.Length < maxChars;
    public HashSet<string> Reasons { get; } = new(StringComparer.Ordinal);

    public bool Append(SnapshotNode node, int depth)
    {
        if (nodes >= maxNodes) { Reasons.Add("node_budget_reached"); return false; }
        if (output.Length >= maxChars) { Reasons.Add("text_budget_reached"); return false; }
        if (depth < 0 || depth > maxDepth) { Reasons.Add("depth_budget_reached"); return false; }
        nodes++;
        if (node.Name?.Length > LabelChars || node.Role?.Length > LabelChars ||
            new[] { node.Value, node.Help, node.Text, node.SelectedText }.Any(value => value?.Length > FieldChars))
            Reasons.Add("field_truncated");
        var line = Format(node, depth);
        if (output.Length != 0) output.Append('\n');
        var remaining = Math.Max(0, maxChars - output.Length);
        if (line.Length > remaining) Reasons.Add("text_budget_reached");
        output.Append(Bound(line, remaining));
        return true;
    }

    internal static string Format(SnapshotNode node, int depth)
    {
        var role = string.IsNullOrWhiteSpace(node.Role) ? "UIAElement" : Bound(node.Role.Trim(), LabelChars);
        // ControlType names are normally fixed labels; keep unexpected provider
        // strings on one line instead of letting them forge a sibling node.
        role = new string(role.Select(character => char.IsControl(character) ? ' ' : character).ToArray());
        var line = new StringBuilder().Append(' ', depth * 2).Append(role);
        var states = new List<string>();
        void Boolean(string name, bool? value)
        {
            if (value is { } actual) states.Add(name + "=" + (actual ? "true" : "false"));
        }
        Boolean("enabled", node.Enabled);
        Boolean("focused", node.Focused);
        Boolean("selected", node.Selected);
        if (node.Expanded is { } expanded)
            states.Add("expanded=" + (expanded switch
            {
                SnapshotExpandState.Collapsed => "false",
                SnapshotExpandState.Expanded => "true",
                SnapshotExpandState.Partial => "partial",
                SnapshotExpandState.Leaf => "leaf",
                _ => throw new ArgumentOutOfRangeException(nameof(node)),
            }));
        if (node.Checked is { } check)
            states.Add("checked=" + (check switch
            {
                SnapshotToggleState.Off => "off",
                SnapshotToggleState.On => "on",
                SnapshotToggleState.Mixed => "mixed",
                _ => throw new ArgumentOutOfRangeException(nameof(node)),
            }));
        Boolean("readOnly", node.ReadOnly);
        if (node.SelectionCount is >= 0)
            states.Add("selectionCount=" + node.SelectionCount.Value.ToString(CultureInfo.InvariantCulture));
        if (states.Count != 0) line.Append(" (").AppendJoin(", ", states).Append(')');
        if (!string.IsNullOrEmpty(node.Name)) line.Append(": ").Append(Quote(node.Name, LabelChars));
        void Field(string label, string? value)
        {
            if (value != null) line.Append("; ").Append(label).Append(": ").Append(Quote(value, FieldChars));
        }
        Field("Value", node.Value);
        if (node.Range is { } range && double.IsFinite(range.Value) && double.IsFinite(range.Minimum) && double.IsFinite(range.Maximum))
            line.Append("; Range: ").Append(range.Value.ToString("R", CultureInfo.InvariantCulture))
                .Append(" (min=").Append(range.Minimum.ToString("R", CultureInfo.InvariantCulture))
                .Append(", max=").Append(range.Maximum.ToString("R", CultureInfo.InvariantCulture)).Append(')');
        Field("Help", node.Help);
        Field("Text", node.Text);
        Field("Selected text", node.SelectedText);
        return line.ToString();
    }

    private static string Quote(string value, int limit) => JsonSerializer.Serialize(Bound(value, limit), StringOptions);
    internal static string Bound(string value, int limit)
    {
        var length = Math.Min(value.Length, limit);
        if (length > 0 && char.IsHighSurrogate(value[length - 1])) length--;
        return value[..length];
    }
    public override string ToString() => output.ToString();
}
