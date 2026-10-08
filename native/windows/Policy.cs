using System.IO;

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
