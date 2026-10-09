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
    Configure(chord, "{\"version\":1,\"codes\":[\"ControlLeft\",\"KeyS\"]}");
    Assert(!chord.Update("KeyS", true), "Custom pairs require both physical keys.");
    Assert(chord.Update("ControlLeft", true), "Custom two-key chords are order independent.");
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
    Reject("{\"version\":1,\"codes\":[\"F8\",\"F9\",\"F10\"]}");
    Reject("{\"version\":1,\"codes\":[\"F8\",\"F9\",\"F10\",\"F11\"]}");
    Reject("{\"version\":1,\"codes\":[\"F8\",\"F8\"]}");
    Reject("{\"version\":2,\"codes\":[\"F8\",\"F9\"]}");
    Reject("{\"version\":1,\"codes\":[\"F8\",\"CapsLock\"]}");
    Reject("{\"version\":1,\"codes\":[\"F8\",null]}");
    Reject("{\"version\":1,\"codes\":\"F8+F9\"}");
    Assert(!transition.Update("F9", true), "Rejected configuration also preserves the existing press latch.");
    Reject("{\"version\":1,\"codes\":[\"KeyA\",\"KeyB\",\"KeyC\",\"KeyD\",\"KeyE\",\"KeyF\",\"KeyG\",\"KeyH\",\"KeyI\"]}");
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
    Assert(SnapshotCaptureQuality.Create("Window", [], 1).Status == "available", "Successful text stays available without invented caveats.");
    var partial = SnapshotCaptureQuality.Create("Window", ["text_budget_reached", "field_truncated", "text_budget_reached"], 3);
    Assert(partial.Status == "partial" && partial.Reasons.SequenceEqual(new[] { "field_truncated", "text_budget_reached" }), "Partial reasons are unique and deterministic.");
    Assert(SnapshotCaptureQuality.Create("", ["time_budget_reached"], 0).Status == "image_only", "A timed-out text provider produces image-only quality.");
    Assert(limit.Reasons.Contains("text_budget_reached") && count.Reasons.Contains("depth_budget_reached") && count.Reasons.Contains("node_budget_reached"), "Output reports factual character, depth and node budget limits.");
    var fieldLimited = new SnapshotTextTree(16_000, 300, 40);
    fieldLimited.Append(new SnapshotNode { Role = "Edit", SelectedText = new string('s', 2000) }, 0);
    Assert(fieldLimited.Reasons.Contains("field_truncated"), "Per-field truncation is reported even when the overall text budget is not exhausted.");
    Assert(SnapshotPriority.Rank(true, false, "ToolBar") == 0 && SnapshotPriority.Rank(false, false, "ListItem", true) == 1 &&
        SnapshotPriority.Rank(false, true, "Window") == 2 && SnapshotPriority.Rank(false, false, "Document") == 3 &&
        SnapshotPriority.Rank(false, false, "ToolBar") == 4,
        "Focus route, selected controls, modal dialog and document rank ahead of unrelated chrome without removing it.");
    Assert(SnapshotSource.VerifiedUrl("https://example.com/path?selected=1") == "https://example.com/path?selected=1" &&
        SnapshotSource.VerifiedUrl("example.com/from-title") == null && SnapshotSource.VerifiedUrl("javascript:alert(1)") == null,
        "Document source URLs require an explicit absolute supported scheme.");
    var recorder = new PhysicalShortcutRecorder();
    var recordingWindow = new ShortcutRecordingWindow(20, 321);
    Assert(recordingWindow.Matches(20, 321), "A recorder binds a specific foreground HWND and process.");
    Assert(!recordingWindow.Matches(21, 321) && !recordingWindow.Matches(20, 322) && !new ShortcutRecordingWindow(0, 0).Matches(0, 0),
        "Another Harness window, recycled HWND owner, and an unknown window must not match.");
    var recordToken = "recording-test-token-1";
    Assert(!recorder.Active, "Ordinary capture pause does not start a key recorder.");
    Assert(recorder.Begin(recordToken, 1000, true, []).State == "waiting", "An explicit focused lease begins with no retained keys.");
    var recordKeys = new[] { "ControlLeft", "ShiftRight" };
    foreach (var key in recordKeys) recorder.Update(key, true, 1100, true);
    Assert(recorder.Read(recordToken, 1200, true).Current.Length == 2 && recorder.Read(recordToken, 1200, true).Peak.Length == 2,
        "The recorder observes two physical keys including exact modifier sides.");
    recorder.Update("ShiftRight", true, 1200, true);
    Assert(recorder.Read(recordToken, 1200, true).Peak.Length == 2, "Key repeat does not add a key or create history.");
    recorder.Update("ControlLeft", false, 1300, true);
    Assert(recorder.Read(recordToken, 1300, true).State == "holding", "The first release freezes the chord but does not complete it early.");
    recorder.Update("KeyC", true, 1400, true);
    Assert(!recorder.Read(recordToken, 1400, true).Current.Contains("KeyC") && !recorder.Read(recordToken, 1400, true).Peak.Contains("KeyC"),
        "A post-release key cannot forge a never-simultaneous larger chord.");
    foreach (var key in recordKeys) recorder.Update(key, false, 1500, true);
    Assert(recorder.Read(recordToken, 1500, true).State == "complete" && recorder.Read(recordToken, 1500, true).Current.Length == 0,
        "Only all releases complete the frozen candidate.");
    Assert(recorder.Read(recordToken, 30_000, true).Peak.Length == 2 && recorder.Read(recordToken, 30_000, true).State == "complete",
        "A completed candidate remains reviewable after the acquisition deadline.");
    recorder.Check(31_000, false); recorder.Update("KeyC", true, 32_000, true);
    Assert(!recorder.Active && recorder.Read(recordToken, 32_000, true).State == "complete" &&
        recorder.Read(recordToken, 32_000, true).Peak.SequenceEqual(recordKeys.Order(StringComparer.Ordinal)),
        "A completed candidate survives later focus changes and ignores new physical events.");
    Assert(recorder.End(recordToken).Peak.Length == 0 && !recorder.Active, "Ending clears every key from memory.");
    void RejectRecorder(Action action, string code)
    {
        try { action(); throw new Exception("Invalid recorder operation was accepted."); }
        catch (ShortcutRecordingException exception) { Assert(exception.Code == code, "Recording errors retain their classified wire code."); }
    }
    RejectRecorder(() => recorder.Read("old-recording-token", 3000, true), "INVALID_RECORDING_TOKEN");
    RejectRecorder(() => recorder.Begin("recording-test-token-2", 3000, true, ["KeyA"]), "KEYS_ALREADY_HELD");
    RejectRecorder(() => recorder.Begin("recording-test-token-2", 3000, false, []), "RECORDING_NOT_FOCUSED");
    recorder.Begin("recording-test-token-2", 4000, true, []);
    RejectRecorder(() => recorder.Begin("recording-test-token-2", 4000, true, []), "INVALID_RECORDING_TOKEN");
    recorder.Update("KeyA", true, 4100, true);
    Assert(recorder.Read("recording-test-token-2", 19_000, true).State == "expired" &&
        recorder.Read("recording-test-token-2", 19_000, true).Peak.Length == 0, "A fixed 15-second lease expires and clears unfinished keys.");
    recorder.Begin("recording-test-token-3", 20_000, true, []);
    recorder.Update("KeyA", true, 20_100, true);
    Assert(recorder.Read("recording-test-token-3", 20_200, false).State == "interrupted" &&
        recorder.Read("recording-test-token-3", 20_300, true).Peak.Length == 0, "Focus loss clears keys and cannot resume an interrupted lease.");
    recorder.Begin("recording-test-token-4", 21_000, true, []);
    recorder.Update("KeyA", true, 21_100, true); recorder.Update("KeyA", false, 21_200, true);
    Assert(recorder.Read("recording-test-token-4", 21_300, true).State == "complete" &&
        recorder.Read("recording-test-token-4", 21_300, true).Peak.Length == 1, "Single-key completion is explicit for the UI to reject.");
    recorder.Update("KeyB", true, 21_350, true);
    Assert(recorder.Read("recording-test-token-4", 21_350, true).Peak.SequenceEqual(["KeyA"]),
        "Two non-overlapping single-key gestures must not become a pair.");
    recorder.Stop(clearToken: true);
    RejectRecorder(() => recorder.Read("recording-test-token-4", 21_400, true), "INVALID_RECORDING_TOKEN");
    var manyKeys = new[] { "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI" };
    recorder.Begin("recording-test-token-5", 22_000, true, []);
    foreach (var key in manyKeys[..3]) recorder.Update(key, true, 22_100, true);
    Assert(recorder.Read("recording-test-token-5", 22_100, true).State == "too_many" && !recorder.Active &&
        recorder.Read("recording-test-token-5", 22_100, true).Current.Length == 0 &&
        recorder.Read("recording-test-token-5", 22_100, true).Peak.Length == 0,
        "The third simultaneous key terminates recording and cannot retain the first pair.");
    foreach (var key in manyKeys[3..]) recorder.Update(key, true, 22_100, true);
    foreach (var key in manyKeys) recorder.Update(key, false, 22_200, true);
    Assert(recorder.Read("recording-test-token-5", 45_000, false).State == "too_many" &&
        recorder.Read("recording-test-token-5", 45_000, false).Peak.Length == 0, "Further keys, releases, focus and time cannot recover a rejected larger chord.");
    Assert(recorder.End("recording-test-token-5").State == "ended" && recorder.End("recording-test-token-5").Peak.Length == 0,
        "Explicit cleanup of a rejected larger chord is idempotent.");
    recorder.Begin("recording-test-token-6", 23_000, true, []);
    recorder.Update("unmapped-255", true, 23_100, true);
    Assert(recorder.Read("recording-test-token-6", 23_200, true).State == "interrupted" &&
        recorder.Read("recording-test-token-6", 23_200, true).Peak.Length == 0, "Unsupported physical events cannot manufacture a chord.");
    recorder.Begin("recording-test-token-7", 24_000, true, []);
    recorder.Update("KeyA", true, 24_100, true);
    recorder.Check(24_200, recordingWindow.Matches(21, 321));
    Assert(recorder.Read("recording-test-token-7", 24_300, true).State == "interrupted" &&
        recorder.Read("recording-test-token-7", 24_300, true).Peak.Length == 0, "Switching Harness windows terminates unfinished recording.");
    recorder.Begin("recording-test-token-8", 25_000, true, []);
    foreach (var key in new[] { "KeyA", "KeyB" }) recorder.Update(key, true, 25_100, true);
    foreach (var key in new[] { "KeyA", "KeyB" }) recorder.Update(key, false, 25_200, true);
    Assert(recorder.Read("recording-test-token-8", 25_300, true).State == "complete" &&
        recorder.Read("recording-test-token-8", 25_300, true).Peak.SequenceEqual(["KeyA", "KeyB"]),
        "A pair of different ordinary physical keys completes.");
    Console.WriteLine(JsonSerializer.Serialize(new { type = "self-test", ok = true, checks }));
    return 0;
}
catch (Exception exception)
{
    Console.WriteLine(JsonSerializer.Serialize(new { type = "self-test", ok = false, checks, error = exception.Message }));
    return 1;
}
