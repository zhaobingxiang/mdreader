using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MdReader;

/// <summary>
/// 前端与宿主之间的消息桥。
///
/// 协议：前端 postMessage { id, action, ...payload }
///   宿主回 { id, ok, result } 或 { id, ok:false, error }
/// 事件：宿主主动推 { event, ...payload }
/// </summary>
internal sealed class HostBridge : IDisposable
{
    public const string VirtualHost = "mdreader.local";
    public const string PipeName = "mdreader.open.file";

    /// <summary>自己写入文件后，这段时间内忽略 watcher 的回声</summary>
    private const int SelfWriteGuardMs = 450;

    /// <summary>单次读取的文件大小上限，防止把整条内存吃光</summary>
    private const long MaxFileBytes = 16L * 1024 * 1024;

    private readonly MainForm _form;
    private readonly WebView2 _web;
    private readonly Dictionary<string, FileSystemWatcher> _watchers = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, DateTime> _selfWrites = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _allowedPaths = new(StringComparer.OrdinalIgnoreCase);
    private readonly Queue<string> _pendingOpen = new();

    private bool _ready;
    private bool _disposed;
    private bool _dirty;

    /// <summary>前端报告的当前文档未保存状态，供窗口关闭前确认</summary>
    public bool DocumentDirty => _dirty;

    public HostBridge(MainForm form, WebView2 web)
    {
        _form = form;
        _web = web;
    }

    public void MarkReady()
    {
        _ready = true;
        while (_pendingOpen.Count > 0)
        {
            PushFile(_pendingOpen.Dequeue());
        }
    }

    /// <summary>用指定路径打开文件（启动参数、管道转发、双击打开都会走这里）</summary>
    public void OpenPath(string path)
    {
        if (!_ready)
        {
            _pendingOpen.Enqueue(path);
            return;
        }
        PushFile(path);
    }

    private void PushFile(string path)
    {
        try
        {
            path = Path.GetFullPath(path);
            var info = new FileInfo(path);
            var text = ReadAllTextCapped(info);
            Authorize(path);
            AttachWatch(path);

            Post(new JsonObject
            {
                ["event"] = "openFile",
                ["path"] = path,
                ["name"] = info.Name,
                ["text"] = text,
                ["size"] = info.Length,
                ["lastModified"] = info.LastWriteTimeUtc.Ticks,
            });
        }
        catch (Exception ex)
        {
            Post(new JsonObject { ["event"] = "error", ["message"] = $"打开文件失败：{ex.Message}" });
        }
    }

    public void Handle(CoreWebView2WebMessageReceivedEventArgs args)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(args.WebMessageAsJson);
        }
        catch
        {
            return;
        }

        if (node is not JsonObject message) return;

        var id = message["id"]?.GetValue<int>() ?? 0;
        var action = message["action"]?.GetValue<string>() ?? string.Empty;

        try
        {
            switch (action)
            {
                case "ping":
                    Reply(id, new JsonObject { ["host"] = "webview2" });
                    break;
                case "openFile":
                    HandleOpenFile(id);
                    break;
                case "readFile":
                    HandleReadFile(id, message);
                    break;
                case "writeFile":
                    HandleWriteFile(id, message);
                    break;
                case "saveAs":
                    HandleSaveAs(id, message);
                    break;
                case "watch":
                    HandleWatch(id, message);
                    break;
                case "unwatch":
                    HandleUnwatch(id, message);
                    break;
                case "setTitle":
                    HandleSetTitle(message);
                    Reply(id, new JsonObject { ["ok"] = true });
                    break;
                case "reveal":
                    HandleReveal(message);
                    Reply(id, new JsonObject { ["ok"] = true });
                    break;
                default:
                    ReplyError(id, $"未知指令：{action}");
                    break;
            }
        }
        catch (Exception ex)
        {
            ReplyError(id, ex.Message);
        }
    }

    // ---------- 指令实现 ----------

    private void HandleOpenFile(int id)
    {
        using var dialog = new OpenFileDialog
        {
            Title = "打开 Markdown 文件",
            Filter = "Markdown 文档|*.md;*.markdown;*.mdown;*.mkd|文本文件|*.txt|所有文件|*.*",
            CheckFileExists = true,
            Multiselect = false,
        };

        if (dialog.ShowDialog(_form) != DialogResult.OK)
        {
            Reply(id, new JsonObject { ["cancelled"] = true });
            return;
        }

        // 用户通过对话框亲选的文件，视为已授权
        var path = Path.GetFullPath(dialog.FileName);
        var info = new FileInfo(path);
        var text = ReadAllTextCapped(info);
        Authorize(path);
        AttachWatch(path);

        Reply(id, new JsonObject
        {
            ["path"] = path,
            ["name"] = info.Name,
            ["text"] = text,
            ["size"] = info.Length,
            ["lastModified"] = info.LastWriteTimeUtc.Ticks,
        });
    }

    private void HandleReadFile(int id, JsonObject message)
    {
        if (!TryAuthorizedPath(message["path"]?.GetValue<string>(), id, out var path)) return;
        if (!File.Exists(path))
        {
            ReplyError(id, "文件不存在");
            return;
        }

        var info = new FileInfo(path);
        Reply(id, new JsonObject
        {
            ["path"] = path,
            ["name"] = info.Name,
            ["text"] = ReadAllTextCapped(info),
            ["size"] = info.Length,
            ["lastModified"] = info.LastWriteTimeUtc.Ticks,
        });
    }

    private void HandleWriteFile(int id, JsonObject message)
    {
        if (!TryAuthorizedPath(message["path"]?.GetValue<string>(), id, out var path)) return;
        var text = message["text"]?.GetValue<string>() ?? string.Empty;

        _selfWrites[path] = DateTime.UtcNow;
        File.WriteAllText(path, text, new UTF8Encoding(false));
        AttachWatch(path);

        Reply(id, new JsonObject
        {
            ["path"] = path,
            ["size"] = new FileInfo(path).Length,
        });
    }

    private void HandleSaveAs(int id, JsonObject message)
    {
        var suggested = message["suggested"]?.GetValue<string>() ?? "未命名.md";

        using var dialog = new SaveFileDialog
        {
            Title = "另存为",
            Filter = "Markdown 文档|*.md|所有文件|*.*",
            FileName = suggested,
            DefaultExt = "md",
            AddExtension = true,
        };

        if (dialog.ShowDialog(_form) != DialogResult.OK)
        {
            Reply(id, new JsonObject { ["cancelled"] = true });
            return;
        }

        // 保存位置由用户在对话框里确认，直接加入授权白名单
        var path = Path.GetFullPath(dialog.FileName);
        var text = message["text"]?.GetValue<string>() ?? string.Empty;

        _selfWrites[path] = DateTime.UtcNow;
        File.WriteAllText(path, text, new UTF8Encoding(false));
        Authorize(path);
        AttachWatch(path);

        Reply(id, new JsonObject
        {
            ["path"] = path,
            ["name"] = Path.GetFileName(path),
            ["size"] = new FileInfo(path).Length,
            ["lastModified"] = File.GetLastWriteTimeUtc(path).Ticks,
        });
    }

    private void HandleWatch(int id, JsonObject message)
    {
        if (TryAuthorizedPath(message["path"]?.GetValue<string>(), id, out var path))
        {
            AttachWatch(path);
        }
        Reply(id, new JsonObject { ["watching"] = _watchers.Count });
    }

    private void HandleUnwatch(int id, JsonObject message)
    {
        var raw = message["path"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(raw))
        {
            try
            {
                DetachWatch(Path.GetFullPath(raw));
            }
            catch
            {
                // 路径不合法就没有可撤销的监听
            }
        }
        Reply(id, new JsonObject { ["watching"] = _watchers.Count });
    }

    private void HandleSetTitle(JsonObject message)
    {
        var name = message["name"]?.GetValue<string>() ?? "mdreader";
        var dirty = message["dirty"]?.GetValue<bool>() ?? false;
        _dirty = dirty;
        var prefix = dirty ? "• " : string.Empty;

        if (_form.IsHandleCreated)
        {
            _form.BeginInvoke((Action)(() => _form.Text = $"{prefix}{name} — mdreader"));
        }
    }

    private void HandleReveal(JsonObject message)
    {
        if (!TryAuthorizedPath(message["path"]?.GetValue<string>(), 0, out var path)) return;
        if (!File.Exists(path)) return;

        try
        {
            // ArgumentList 逐项传参，不经过 shell，路径里的引号不会被解释成额外参数
            var startInfo = new ProcessStartInfo("explorer.exe")
            {
                UseShellExecute = false,
            };
            startInfo.ArgumentList.Add($"/select,{path}");
            Process.Start(startInfo);
        }
        catch
        {
            // 定位失败不影响使用
        }
    }

    // ---------- 路径授权 ----------

    /// <summary>只有经用户动作（启动参数、双击、打开/另存对话框）进过白名单的路径可读写</summary>
    private void Authorize(string fullPath) => _allowedPaths.Add(fullPath);

    private bool IsAuthorized(string fullPath) => _allowedPaths.Contains(fullPath);

    private bool TryAuthorizedPath(string? raw, int id, out string path)
    {
        path = string.Empty;
        if (string.IsNullOrEmpty(raw))
        {
            ReplyError(id, "缺少文件路径");
            return false;
        }

        try
        {
            path = Path.GetFullPath(raw);
        }
        catch
        {
            ReplyError(id, "路径不合法");
            return false;
        }

        if (!IsAuthorized(path))
        {
            ReplyError(id, "该路径未经用户授权，拒绝访问");
            return false;
        }
        return true;
    }

    private static string ReadAllTextCapped(FileInfo info)
    {
        if (info.Length > MaxFileBytes)
        {
            throw new IOException(
                $"文件过大（约 {info.Length / 1024 / 1024} MB），超出 {MaxFileBytes / 1024 / 1024} MB 上限");
        }
        return File.ReadAllText(info.FullName);
    }

    // ---------- 文件监听 ----------

    private void AttachWatch(string path)
    {
        if (_watchers.ContainsKey(path)) return;

        var directory = Path.GetDirectoryName(path);
        var fileName = Path.GetFileName(path);
        if (string.IsNullOrEmpty(directory) || string.IsNullOrEmpty(fileName) || !Directory.Exists(directory)) return;

        try
        {
            var watcher = new FileSystemWatcher(directory, fileName)
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName,
                EnableRaisingEvents = true,
            };

            watcher.Changed += (_, _) => OnFileChanged(path);
            watcher.Created += (_, _) => OnFileChanged(path);
            watcher.Renamed += (_, _) => OnFileChanged(path);

            _watchers[path] = watcher;
        }
        catch
        {
            // 目录不可监听时静默降级
        }
    }

    private void DetachWatch(string path)
    {
        if (_watchers.Remove(path, out var watcher))
        {
            watcher.EnableRaisingEvents = false;
            watcher.Dispose();
        }
    }

    private void OnFileChanged(string path)
    {
        if (_disposed) return;

        if (_selfWrites.TryGetValue(path, out var at) &&
            (DateTime.UtcNow - at).TotalMilliseconds < SelfWriteGuardMs)
        {
            return;
        }

        // 写入方可能还没写完，稍等再读
        _ = Task.Run(async () =>
        {
            await Task.Delay(180);
            try
            {
                var info = new FileInfo(path);
                if (!info.Exists) return;
                var text = ReadAllTextCapped(info);
                Post(new JsonObject
                {
                    ["event"] = "fileChanged",
                    ["path"] = path,
                    ["text"] = text,
                });
            }
            catch
            {
                // 文件可能被占用、删除或超限，忽略这次
            }
        });
    }

    // ---------- 回包 ----------

    private void Reply(int id, JsonObject result)
    {
        Post(new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result });
    }

    private void ReplyError(int id, string error)
    {
        Post(new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = error });
    }

    private void Post(JsonObject payload)
    {
        if (_disposed || !_form.IsHandleCreated) return;

        var json = payload.ToJsonString();
        _form.BeginInvoke((Action)(() =>
        {
            try
            {
                _web.CoreWebView2?.PostWebMessageAsJson(json);
            }
            catch
            {
                // 窗口正在关闭
            }
        }));
    }

    public void Dispose()
    {
        _disposed = true;
        foreach (var watcher in _watchers.Values)
        {
            try
            {
                watcher.EnableRaisingEvents = false;
                watcher.Dispose();
            }
            catch
            {
                // 忽略清理异常
            }
        }
        _watchers.Clear();
        _selfWrites.Clear();
        _pendingOpen.Clear();
    }
}
