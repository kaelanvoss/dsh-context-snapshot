using System.IO;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace DshContextSnapshot;

internal enum ControlKey { None, Left, Right }

internal sealed class DualControlGesture
{
    private bool left;
    private bool right;
    private bool fired;
    public bool Update(ControlKey key, bool down)
    {
        if (key == ControlKey.Left) left = down;
        else if (key == ControlKey.Right) right = down;
        else return false;
        if (!left || !right) { fired = false; return false; }
        if (fired) return false;
        fired = true;
        return true;
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

internal enum SnapshotToggleState { Off, On, Mixed }
internal enum SnapshotExpandState { Collapsed, Expanded, Partial, Leaf }
internal sealed record SnapshotRange(double Value, double Minimum, double Maximum);
internal static class SnapshotPrivacy
{
    public static bool CanRead(bool? password, bool? offscreen) => password is false && offscreen is false;
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

    public bool Append(SnapshotNode node, int depth)
    {
        if (!CanAppend || depth < 0 || depth > maxDepth) return false;
        nodes++;
        var line = Format(node, depth);
        if (output.Length != 0) output.Append('\n');
        var remaining = Math.Max(0, maxChars - output.Length);
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
    private static string Bound(string value, int limit)
    {
        var length = Math.Min(value.Length, limit);
        if (length > 0 && char.IsHighSurrogate(value[length - 1])) length--;
        return value[..length];
    }
    public override string ToString() => output.ToString();
}
