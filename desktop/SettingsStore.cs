using System.Text.Json.Nodes;

namespace MdReader;

/// <summary>
/// 进程级设置存储：%LocalAppData%\mdreader\settings.json。
/// 顶层键为设置项（openInNewWindow / restoreSession / rememberWindow 等），
/// 前端各窗口共享同一份；window 键存放记住的窗口尺寸位置。
/// </summary>
internal static class SettingsStore
{
    private static JsonObject _data = new();
    private static bool _loaded;

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "mdreader",
        "settings.json");

    public static void Load()
    {
        if (_loaded) return;
        _loaded = true;
        try
        {
            if (File.Exists(FilePath) && JsonNode.Parse(File.ReadAllText(FilePath)) is JsonObject obj)
            {
                _data = obj;
            }
        }
        catch
        {
            _data = new JsonObject();
        }
    }

    /// <summary>当前设置的整体快照（深拷贝，交给前端/其他窗口不会被就地改动）</summary>
    public static JsonObject Snapshot()
    {
        Load();
        return Clone(_data).AsObject();
    }

    public static bool GetBool(string key, bool fallback)
    {
        Load();
        try
        {
            return _data[key]?.GetValue<bool>() ?? fallback;
        }
        catch
        {
            return fallback;
        }
    }

    public static double? GetDouble(string key)
    {
        Load();
        try
        {
            var v = _data[key]?.GetValue<double>();
            return v;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>合并补丁并落盘；值为 null 的键会被删除</summary>
    public static void Patch(JsonObject patch)
    {
        Load();
        foreach (var (key, value) in patch)
        {
            if (value is null) _data.Remove(key);
            else _data[key] = Clone(value);
        }
        Save();
    }

    public static void Set(string key, JsonNode value)
    {
        Load();
        _data[key] = Clone(value);
        Save();
    }

    public static JsonNode? Get(string key)
    {
        Load();
        var node = _data[key];
        return node is null ? null : Clone(node);
    }

    /// <summary>.NET 6 没有 JsonNode.DeepClone，走一次 JSON 序列化做深拷贝</summary>
    private static JsonNode Clone(JsonNode node) => JsonNode.Parse(node.ToJsonString())!;

    private static void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, _data.ToJsonString());
        }
        catch
        {
            // 写失败只影响下次启动的记忆，不打断使用
        }
    }
}
