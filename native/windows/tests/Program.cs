using DshContextSnapshot;
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
    Console.WriteLine(JsonSerializer.Serialize(new { type = "self-test", ok = true, checks }));
    return 0;
}
catch (Exception exception)
{
    Console.WriteLine(JsonSerializer.Serialize(new { type = "self-test", ok = false, checks, error = exception.Message }));
    return 1;
}
