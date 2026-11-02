using System.Text.RegularExpressions;

namespace MdReader;

/// <summary>
/// AI 会话产物目录：%AppData%\mdreader\workfile\&lt;会话id&gt;\。
/// 与文档同级目录完全隔离，避免优化过程留下的中间文件混进用户的文件夹。
/// 页面只能按会话 id 写固定的两个文件名，路径由宿主拼装。
/// </summary>
internal static class Workfile
{
    private static readonly Regex SafeId = new("^[A-Za-z0-9_-]{1,64}$", RegexOptions.Compiled);
    private static readonly HashSet<string> AllowedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "conversation.json",
        "proposal.md",
    };

    private static string Root => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "mdreader",
        "workfile");

    /// <summary>启动时清掉过期会话目录；失败不影响启动</summary>
    public static void CleanupOlderThan(int days = 7)
    {
        try
        {
            if (!Directory.Exists(Root)) return;
            var cutoff = DateTime.UtcNow.AddDays(-days);
            foreach (var dir in Directory.EnumerateDirectories(Root))
            {
                try
                {
                    if (Directory.GetLastWriteTimeUtc(dir) < cutoff) Directory.Delete(dir, true);
                }
                catch
                {
                    // 正被占用的目录留到下次
                }
            }
        }
        catch
        {
            // 清理是尽力而为
        }
    }

    public static string? Write(string sessionId, string name, string content)
    {
        if (!SafeId.IsMatch(sessionId) || !AllowedNames.Contains(name)) return null;
        try
        {
            var dir = Path.Combine(Root, sessionId);
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, name);
            File.WriteAllText(path, content, new System.Text.UTF8Encoding(false));
            return path;
        }
        catch
        {
            return null;
        }
    }

    public static void Remove(string sessionId)
    {
        if (!SafeId.IsMatch(sessionId)) return;
        try
        {
            var dir = Path.Combine(Root, sessionId);
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
        catch
        {
            // 删除失败留给启动清理
        }
    }
}
