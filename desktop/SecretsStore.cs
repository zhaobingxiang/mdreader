using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace MdReader;

/// <summary>
/// 各平台 API Key：DPAPI(CurrentUser) 加密后落 %LocalAppData%\mdreader\secrets.bin。
/// settings.json 与页面永远拿不到明文，只暴露「是否已配置 + 尾号」。
/// </summary>
internal static class SecretsStore
{
    /// <summary>
    /// 内置兜底 Key：MaaS 是全公司共用的网关，开箱就能用，不必每人去申请。
    /// 用户自己保存的 Key 优先；明文只存在这里，不进 settings.json 也不进页面。
    /// </summary>
    private static readonly Dictionary<string, string> BuiltinKeys = new()
    {
        ["maas"] = "sk-449b433303e944d89d7d478db574ac71",
    };

    private static JsonObject? _data;

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "mdreader",
        "secrets.bin");

    private static JsonObject Data
    {
        get
        {
            if (_data != null) return _data;
            _data = new JsonObject();
            try
            {
                if (File.Exists(FilePath) &&
                    JsonNode.Parse(File.ReadAllText(FilePath)) is JsonObject obj)
                {
                    _data = obj;
                }
            }
            catch
            {
                _data = new JsonObject();
            }
            return _data;
        }
    }

    public static string? Get(string providerId)
    {
        try
        {
            var raw = Data[providerId]?.GetValue<string>();
            if (!string.IsNullOrEmpty(raw))
            {
                var bytes = ProtectedData.Unprotect(
                    Convert.FromBase64String(raw),
                    null,
                    DataProtectionScope.CurrentUser);
                var saved = Encoding.UTF8.GetString(bytes);
                if (!string.IsNullOrEmpty(saved)) return saved;
            }
        }
        catch
        {
            // 本机 DPAPI 数据坏了也不至于不可用：下面回落到内置 Key
        }
        return BuiltinKeys.TryGetValue(providerId, out var builtin) ? builtin : null;
    }

    /// <summary>是否在用内置兜底 Key（页面据此说明为什么没填 Key 也能用）</summary>
    public static bool IsBuiltin(string providerId)
    {
        if (!BuiltinKeys.ContainsKey(providerId)) return false;
        try
        {
            return string.IsNullOrEmpty(Data[providerId]?.GetValue<string>());
        }
        catch
        {
            return true;
        }
    }

    /// <summary>空串等于删除；返回保存后是否可用</summary>
    public static bool Set(string providerId, string? key)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            Data.Remove(providerId);
        }
        else
        {
            var bytes = ProtectedData.Protect(
                Encoding.UTF8.GetBytes(key.Trim()),
                null,
                DataProtectionScope.CurrentUser);
            Data[providerId] = Convert.ToBase64String(bytes);
        }
        Save();
        return Get(providerId) != null;
    }

    public static (bool HasKey, string Tail) Status(string providerId)
    {
        var key = Get(providerId);
        if (string.IsNullOrEmpty(key)) return (false, string.Empty);
        var tail = key.Length <= 4 ? "…" : "…" + key[^4..];
        return (true, tail);
    }

    private static void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, Data.ToJsonString());
        }
        catch
        {
            // 写不进去时内存里仍可用，只影响下次启动
        }
    }
}
