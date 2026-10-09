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
    var state = new ShortcutGesture();
    Assert(!state.Update("ControlLeft", true), "Left Ctrl alone does not capture.");
    Assert(state.Update("ControlRight", true), "Both Ctrl keys capture once.");
    Assert(!state.Update("ControlRight", true), "Repeat does not capture.");
    Assert(!state.Update("ControlLeft", true), "Holding both does not capture again.");
    Assert(!state.Update(null, true), "Absent key codes do not capture.");
    Assert(!state.Update("ControlRight", false), "Release does not capture.");
    Assert(state.Update("ControlRight", true), "Re-press after right release captures.");
    Assert(!state.Update("ControlLeft", false), "Left release resets.");
    Assert(!state.Update("ControlRight", false), "Both releases do not capture.");
    Assert(!state.Update("ControlRight", true), "Right alone does not capture.");
    Assert(state.Update("ControlLeft", true), "Reverse order captures.");
    Assert(!state.Update("ControlLeft", false), "Left release resets again.");
    Assert(state.Update("ControlLeft", true), "Re-press after left release captures.");
    var configuration = state.Configuration;
    configuration.Codes[0] = "KeyZ";
    Assert(state.Configuration.Codes.SequenceEqual(["ControlLeft", "ControlRight"]), "Configuration snapshots cannot mutate the active chord.");
    void Configure(ShortcutGesture gesture, string json)
    {
        using var document = JsonDocument.Parse(json);
        gesture.Configure(document.RootElement);
    }
    var chord = new ShortcutGesture();
    Configure(chord, "{\"version\":1,\"codes\":[\"ControlLeft\",\"ShiftRight\",\"KeyS\"]}");
    Assert(!chord.Update("KeyS", true) && !chord.Update("ShiftRight", true), "Custom chords require every physical key.");
    Assert(chord.Update("ControlLeft", true), "Custom three-key chords are order independent.");
    Assert(!chord.Update("KeyS", true), "Custom ordinary-key repeat cannot recapture.");
    chord.Update("ShiftLeft", true);
    chord.Update("ShiftLeft", false);
    Assert(!chord.Update("KeyS", true), "Adding and releasing an extra key cannot reset the capture latch.");
    chord.Update("KeyS", false);
    Assert(chord.Update("KeyS", true), "Releasing a bound ordinary key permits another capture.");
    var extra = new ShortcutGesture();
    Configure(extra, "{\"version\":1,\"codes\":[\"ControlRight\",\"KeyS\"]}");
    extra.Update("ShiftLeft", true);
    extra.Update("ControlRight", true);
    Assert(!extra.Update("KeyS", true), "Extra modifiers block capture.");
    Assert(!extra.Update("ShiftLeft", false), "Releasing an extra modifier never captures on key-up.");
    Assert(!extra.Update("KeyS", true), "A held key repeat cannot complete a previously blocked chord.");
    extra.Update("KeyS", false);
    Assert(extra.Update("KeyS", true), "A fresh press captures after the extra modifier is released.");
    extra.Update("KeyS", false);
    extra.Update("KeyA", true);
    Assert(!extra.Update("KeyS", true), "Extra ordinary keys also block capture.");
    extra.Update("KeyA", false);
    extra.Update("KeyS", false);
    Assert(extra.Update("KeyS", true), "A fresh chord captures after the extra ordinary key is released.");
    var recording = new ShortcutGesture();
    recording.Update("ControlLeft", true);
    recording.SetRecording(true);
    Assert(!recording.Update("ControlRight", true), "Recording suspends the native shortcut.");
    recording.SetRecording(false);
    Assert(!recording.Update("ControlLeft", true) && !recording.Update("ControlRight", true), "Recording cleanup blocks keys held until their release.");
    recording.Update("ControlLeft", false);
    recording.Update("ControlRight", false);
    Assert(!recording.Update("ControlLeft", true) && recording.Update("ControlRight", true), "A fresh chord works after recording ends.");
    var transition = new ShortcutGesture();
    transition.Update("ControlLeft", true);
    Configure(transition, "{\"version\":1,\"codes\":[\"F8\",\"F9\"]}");
    transition.Update("F8", true);
    Assert(!transition.Update("F9", true), "An unbound key held across configuration blocks the new chord.");
    transition.Update("ControlLeft", false);
    transition.Update("F9", false);
    Assert(transition.Update("F9", true), "The new chord works after old held keys are released.");
    void Reject(string json)
    {
        var previous = transition.Configuration;
        try { Configure(transition, json); throw new Exception("Invalid shortcut was accepted."); }
        catch (InvalidOperationException) { }
        Assert(transition.Configuration.Version == previous.Version && transition.Configuration.Codes.SequenceEqual(previous.Codes), "Rejected shortcut keeps the previous configuration.");
    }
    Reject("{\"version\":1,\"codes\":[\"F8\"]}");
    Reject("{\"version\":1,\"codes\":[\"F8\",\"F8\"]}");
    Reject("{\"version\":2,\"codes\":[\"F8\",\"F9\"]}");
    Reject("{\"version\":1,\"codes\":[\"F8\",\"CapsLock\"]}");
    Reject("{\"version\":1,\"codes\":[\"F8\",null]}");
    Reject("{\"version\":1,\"codes\":\"F8+F9\"}");
    Assert(!transition.Update("F9", true), "Rejected configuration also preserves the existing press latch.");
    var many = new ShortcutGesture();
    Configure(many, "{\"version\":1,\"codes\":[\"KeyA\",\"KeyB\",\"KeyC\",\"KeyD\",\"KeyE\",\"KeyF\",\"KeyG\",\"KeyH\",\"KeyI\"]}");
    foreach (var code in many.Configuration.Codes[..^1]) Assert(!many.Update(code, true), "A long chord must not fire before its final key.");
    Assert(many.Update("KeyI", true), "The gesture adds no arbitrary eight-key ceiling.");
    Assert(ShortcutKeys.Resolve(0x11, 0x1D, 1) == "ControlRight" && ShortcutKeys.Resolve(0x11, 0x1D, 0) == "ControlLeft", "Generic Ctrl preserves physical sides.");
    Assert(ShortcutKeys.Resolve(0x10, 0x36, 0) == "ShiftRight" && ShortcutKeys.Resolve(0x10, 0x2A, 0) == "ShiftLeft", "Generic Shift preserves physical sides.");
    Assert(ShortcutKeys.Resolve(0x12, 0x38, 1) == "AltRight" && ShortcutKeys.Resolve(0x12, 0x38, 0) == "AltLeft", "Generic Alt preserves physical sides.");
    Assert(ShortcutKeys.Resolve(0x51, 0x1E, 0) == "KeyA", "Ordinary keys are mapped by physical location instead of layout-specific virtual letters.");
    Assert(ShortcutKeys.Resolve(0x0D, 0x1C, 0) == "Enter" && ShortcutKeys.Resolve(0x0D, 0x1C, 1) == "NumpadEnter", "Main and numeric-pad Enter are distinct.");
    Assert(ShortcutKeys.Resolve(0x24, 0x47, 0) == "Numpad7" && ShortcutKeys.Resolve(0x24, 0x47, 1) == "Home", "Numeric-pad navigation remains distinct when Num Lock is off.");
    Assert(ShortcutKeys.Resolve(0xBF, 0x35, 0) == "Slash" && ShortcutKeys.Resolve(0x6F, 0x35, 1) == "NumpadDivide", "Main and numeric-pad punctuation are distinct.");
    Assert(ShortcutKeys.Resolve(0x87, 0, 0) == "F24", "F24 is supported without a scan code.");
    Assert(ShortcutKeys.IsInjected(0x10) && ShortcutKeys.IsInjected(0x02) && !ShortcutKeys.IsInjected(1), "Both injected-event flags are excluded without rejecting physical extended keys.");
    Assert(!ShortcutKeys.SupportedCodes.Contains("Pause") && !ShortcutKeys.SupportedCodes.Contains("CapsLock") && !ShortcutKeys.SupportedCodes.Contains("PrintScreen"), "Keys without consistent cross-platform press/release behavior are excluded.");
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
