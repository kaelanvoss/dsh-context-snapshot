using DshContextSnapshot;
using System.Globalization;
using System.Text.Json;

var checks = 0;
void Assert(bool condition, string description)
{
    checks++;
    if (!condition) throw new InvalidOperationException(description);
}

try
{
    var state = new DualControlGesture();
    Assert(!state.Update(ControlKey.Left, true), "Left Ctrl alone does not capture.");
    Assert(state.Update(ControlKey.Right, true), "Both Ctrl keys capture once.");
    Assert(!state.Update(ControlKey.Right, true), "Repeat does not capture.");
    Assert(!state.Update(ControlKey.Left, true), "Holding both does not capture again.");
    Assert(!state.Update(ControlKey.None, true), "Unrelated keys do not capture.");
    Assert(!state.Update(ControlKey.Right, false), "Release does not capture.");
    Assert(state.Update(ControlKey.Right, true), "Re-press after right release captures.");
    Assert(!state.Update(ControlKey.Left, false), "Left release resets.");
    Assert(!state.Update(ControlKey.Right, false), "Both releases do not capture.");
    Assert(!state.Update(ControlKey.Right, true), "Right alone does not capture.");
    Assert(state.Update(ControlKey.Left, true), "Reverse order captures.");
    Assert(!state.Update(ControlKey.Left, false), "Left release resets again.");
    Assert(state.Update(ControlKey.Left, true), "Re-press after left release captures.");
    Assert(TargetPolicy.IsExcluded("DeepSeek.exe"), "DSH is excluded case-insensitively.");
    Assert(TargetPolicy.IsExcluded("dsh-context-snapshot"), "Helper process is excluded.");
    Assert(TargetPolicy.IsExcluded("ContextSnapshot.exe"), "Published helper process is excluded.");
    Assert(TargetPolicy.IsExcluded("deepseek-harness"), "Exact DSH variant is excluded.");
    Assert(!TargetPolicy.IsExcluded("deepseek-notes"), "Substring lookalikes remain eligible.");
    Assert(!TargetPolicy.IsExcluded("chrome"), "Browsers remain eligible.");
    Assert(!TargetPolicy.IsExcluded("dsh-settings"), "Substring names are not over-filtered.");
    var tree = new SnapshotTextTree(16_000, 300, 40);
    Assert(tree.Append(new SnapshotNode { Role = "Window", Name = "测试窗口", Enabled = true, Focused = false }, 0), "The window enters the tree.");
    Assert(tree.Append(new SnapshotNode { Role = "Button", Name = "保存", Enabled = true, Focused = false }, 1), "The first matching label enters the tree.");
    Assert(tree.Append(new SnapshotNode { Role = "Button", Name = "保存", Enabled = false, Focused = true }, 2), "A repeated label is not deduplicated.");
    Assert(tree.ToString() == "Window (enabled=true, focused=false): \"测试窗口\"\n  Button (enabled=true, focused=false): \"保存\"\n    Button (enabled=false, focused=true): \"保存\"", "Indentation, duplicate labels, Unicode, and explicit true/false states survive.");
    var empty = SnapshotTextTree.Format(new SnapshotNode { Role = "Edit", Name = "字段" }, 0);
    Assert(empty == "Edit: \"字段\"", "Unsupported state and value fields are omitted instead of inventing defaults.");
    var stateful = SnapshotTextTree.Format(new SnapshotNode
    {
        Role = "CheckBox", Name = "选择", Enabled = false, Focused = true, Selected = false,
        Expanded = SnapshotExpandState.Partial, Checked = SnapshotToggleState.Mixed, ReadOnly = true, SelectionCount = 0,
        Value = "value", Help = "help", SelectedText = "chosen",
    }, 1);
    Assert(stateful == "  CheckBox (enabled=false, focused=true, selected=false, expanded=partial, checked=mixed, readOnly=true, selectionCount=0): \"选择\"; Value: \"value\"; Help: \"help\"; Selected text: \"chosen\"", "Supported selection, partial expansion, mixed toggle, read-only, value/help, and selected text are retained.");
    Assert(SnapshotTextTree.Format(new SnapshotNode { Role = "TreeItem", Expanded = SnapshotExpandState.Leaf }, 0) == "TreeItem (expanded=leaf)", "Leaf controls are not falsely described as collapsed.");
    Assert(SnapshotTextTree.Format(new SnapshotNode { Role = "TreeItem", Expanded = SnapshotExpandState.Collapsed }, 0) == "TreeItem (expanded=false)", "Collapsed state remains explicit.");
    Assert(SnapshotTextTree.Format(new SnapshotNode { Role = "TreeItem", Expanded = SnapshotExpandState.Expanded }, 0) == "TreeItem (expanded=true)", "Expanded state remains explicit.");
    Assert(SnapshotTextTree.Format(new SnapshotNode { Role = "CheckBox", Checked = SnapshotToggleState.Off, ReadOnly = false }, 0) == "CheckBox (checked=off, readOnly=false)", "Editable and off values differ from unsupported state.");
    Assert(SnapshotTextTree.Format(new SnapshotNode { Role = "CheckBox", Checked = SnapshotToggleState.On, Selected = true }, 0) == "CheckBox (selected=true, checked=on)", "Selected/on values remain true.");
    Assert(SnapshotTextTree.Format(new SnapshotNode { Role = "Edit", Value = "", Text = "line1\nline2\t\"quoted\"" }, 0) == "Edit; Value: \"\"; Text: \"line1\\nline2\\t\\\"quoted\\\"\"", "Known empty values and multiline text stay on one escaped node line.");
    var culture = CultureInfo.CurrentCulture;
    try
    {
        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-FR");
        Assert(SnapshotTextTree.Format(new SnapshotNode { Role = "Slider", Range = new SnapshotRange(1.5, 0, 2.5) }, 0) == "Slider; Range: 1.5 (min=0, max=2.5)", "Finite ranges use invariant numeric formatting.");
    }
    finally { CultureInfo.CurrentCulture = culture; }
    Assert(SnapshotTextTree.Format(new SnapshotNode { Role = "Slider", Range = new SnapshotRange(double.NaN, 0, 10) }, 0) == "Slider", "Non-finite range values are not admitted.");
    Assert(SnapshotTextTree.Format(new SnapshotNode { Role = "Slider", Range = new SnapshotRange(0, double.NegativeInfinity, double.PositiveInfinity) }, 0) == "Slider", "Non-finite range endpoints are not admitted.");
    var bounded = SnapshotTextTree.Format(new SnapshotNode { Role = new string('r', 300), Name = new string('n', 300), Value = new string('v', 2000), SelectedText = new string('s', 2000) }, 0);
    Assert(bounded == new string('r', 256) + ": \"" + new string('n', 256) + "\"; Value: \"" + new string('v', 1024) + "\"; Selected text: \"" + new string('s', 1024) + "\"", "Role/name and content fields respect separate limits.");
    Assert(SnapshotTextTree.Format(new SnapshotNode { Role = "Text\nButton", Name = "\"name\"\nText" }, 0) == "Text Button: \"\\\"name\\\"\\nText\"", "Unexpected control labels and names cannot forge sibling tree lines.");
    var limit = new SnapshotTextTree(24, 300, 40);
    limit.Append(new SnapshotNode { Role = "Text", Name = new string('x', 100) }, 0);
    Assert(limit.ToString().Length <= 24 && !limit.CanAppend, "Overall output is bounded independently of field limits.");
    var count = new SnapshotTextTree(16_000, 2, 1);
    Assert(!count.Append(new SnapshotNode { Role = "Text" }, 2), "Excessive tree depth is rejected.");
    Assert(count.Append(new SnapshotNode { Role = "Text", Name = "same" }, 0) && count.Append(new SnapshotNode { Role = "Text", Name = "same" }, 1), "Distinct repeated nodes consume separate node slots.");
    Assert(!count.Append(new SnapshotNode { Role = "Text" }, 0), "Node limit is enforced.");
    var unicode = new SnapshotTextTree(10, 1, 1);
    unicode.Append(new SnapshotNode { Role = "Text", Name = "😀😀😀" }, 0);
    Assert(!char.IsHighSurrogate(unicode.ToString()[^1]), "Overall truncation does not leave a dangling UTF-16 high surrogate.");
    Assert(SnapshotPrivacy.CanRead(false, false), "Explicit or framework-defined FALSE privacy defaults permit visible non-password elements.");
    Assert(!SnapshotPrivacy.CanRead(true, false) && !SnapshotPrivacy.CanRead(false, true), "Password and hidden subtrees are excluded.");
    Assert(!SnapshotPrivacy.CanRead(null, false) && !SnapshotPrivacy.CanRead(false, null) && !SnapshotPrivacy.CanRead(null, null), "Cache read exceptions remain unknown/null and fail closed rather than being converted to FALSE defaults.");
    Console.WriteLine(JsonSerializer.Serialize(new { type = "self-test", ok = true, checks }));
    return 0;
}
catch (Exception exception)
{
    Console.WriteLine(JsonSerializer.Serialize(new { type = "self-test", ok = false, checks, error = exception.Message }));
    return 1;
}
