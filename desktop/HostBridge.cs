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
    public const string AssetHost = "mdasset.local";
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

    /// <summary>当前文档的目录，本地图片等相对资源以此为基准解析（见 mdasset.local）</summary>
    private string? _docDir;
    private CoreWebView2Environment? _environment;

    /// <summary>最近打开的文件（MRU），落盘在 LocalAppData，供「打开」下拉快速回访</summary>
    private readonly List<string> _recent = new();
    private bool _recentLoaded;
    private const int RecentMax = 8;

    private static string RecentFilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "mdreader",
        "recent.json");

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
            _docDir = Path.GetDirectoryName(path);

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
                    // 页面就绪：补发一次当前窗口状态，否则启动即最大化时按钮字形停留在"最大化"
                    NotifyWindowState(_form.WindowState == FormWindowState.Maximized);
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
                case "print":
                    HandlePrint(id);
                    break;
                case "recent":
                    Reply(id, RecentPayload());
                    break;
                case "openRecent":
                    HandleOpenRecent(id, message);
                    break;
                case "getSettings":
                    Reply(id, SettingsStore.Snapshot());
                    break;
                case "setSettings":
                    if (message["patch"] is JsonObject patch) SettingsStore.Patch(patch);
                    Reply(id, SettingsStore.Snapshot());
                    break;
                case "openPaths":
                    HandleOpenPaths(id, message);
                    break;
                case "beginDrag":
                    if (_form.IsHandleCreated) _form.BeginInvoke((Action)_form.BeginDrag);
                    Reply(id, new JsonObject { ["ok"] = true });
                    break;
                case "winMin":
                    if (_form.IsHandleCreated) _form.BeginInvoke((Action)_form.MinimizeWindow);
                    Reply(id, new JsonObject { ["ok"] = true });
                    break;
                case "winMax":
                    if (_form.IsHandleCreated) _form.BeginInvoke((Action)_form.ToggleMaximize);
                    Reply(id, new JsonObject { ["ok"] = true });
                    break;
                case "winClose":
                    Reply(id, new JsonObject { ["ok"] = true });
                    if (_form.IsHandleCreated) _form.BeginInvoke((Action)_form.RequestClose);
                    break;
                case "exitResult":
                    HandleExitResult(message);
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
        _docDir = Path.GetDirectoryName(path);

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
        _docDir = Path.GetDirectoryName(path);

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
        var dark = message["dark"]?.GetValue<bool>();
        _dirty = dirty;
        var prefix = dirty ? "• " : string.Empty;

        // 多标签下切页不会重推 openFile，本地资源（mdasset.local）的基准目录
        // 跟着活动文档走，这里用 setTitle 带上的路径同步
        var path = message["path"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(path))
        {
            try
            {
                _docDir = Path.GetDirectoryName(Path.GetFullPath(path));
            }
            catch
            {
                // 路径不合法就保持旧目录
            }
        }

        if (_form.IsHandleCreated)
        {
            _form.BeginInvoke((Action)(() =>
            {
                _form.Text = $"{prefix}{name} — mdreader";
                if (dark.HasValue) _form.SetChromeDark(dark.Value);
            }));
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

    // ---------- 窗口控制 / 退出确认 ----------

    private void HandleExitResult(JsonObject message)
    {
        var proceed = message["proceed"]?.GetValue<bool>() ?? false;
        if (_form.IsHandleCreated)
        {
            _form.BeginInvoke((Action)(() => _form.CompleteExit(proceed)));
        }
    }

    /// <summary>请前端弹自定义确认框；页面还没就绪时返回 false，调用方退回原生对话框</summary>
    public bool RequestExit()
    {
        if (!_ready || _disposed || !_form.IsHandleCreated) return false;
        Post(new JsonObject { ["event"] = "confirmExit" });
        return true;
    }

    public void NotifyWindowState(bool maximized)
    {
        Post(new JsonObject { ["event"] = "windowState", ["maximized"] = maximized });
    }

    // ---------- 打印 / 最近文件 ----------

    private void HandlePrint(int id)
    {
        // 先回包：系统打印对话框会阻塞到用户操作完成，不能让前端干等
        Reply(id, new JsonObject { ["ok"] = true });
        if (!_form.IsHandleCreated) return;

        _form.BeginInvoke((Action)(() =>
        {
            try
            {
                var core = _web.CoreWebView2;
                if (core == null) return;
                // PrintAsync 是静默打印（直接进默认打印机），用户没机会选"另存为 PDF"；
                // ShowPrintUI 弹打印预览界面，里面有"另存为 PDF"和系统打印机
                core.ShowPrintUI(CoreWebView2PrintDialogKind.Browser);
            }
            catch (Exception ex)
            {
                // 打印失败要让用户知道，而不是点了没反应
                Post(new JsonObject { ["event"] = "error", ["message"] = $"打印失败：{ex.Message}" });
            }
        }));
    }

    private void HandleOpenRecent(int id, JsonObject message)
    {
        var raw = message["path"]?.GetValue<string>() ?? string.Empty;
        string path;
        try
        {
            path = Path.GetFullPath(raw);
        }
        catch
        {
            ReplyError(id, "路径不合法");
            return;
        }

        EnsureRecentLoaded();
        // 只允许打开确实在最近列表里的路径，防止这一通道被当成任意文件读取器
        if (!_recent.Any(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase)) ||
            !File.Exists(path))
        {
            ReplyError(id, "该文件不在最近打开列表中");
            return;
        }

        Reply(id, new JsonObject { ["ok"] = true });
        OpenPath(path);
    }

    private static readonly string[] SessionExtensions =
        { ".md", ".markdown", ".mdown", ".mkd", ".txt" };

    /// <summary>会话恢复：前端把上次的 tab 路径列表交回来，逐个推送 openFile</summary>
    private void HandleOpenPaths(int id, JsonObject message)
    {
        if (message["paths"] is not JsonArray arr)
        {
            ReplyError(id, "缺少路径列表");
            return;
        }

        var opened = 0;
        foreach (var item in arr.Take(20))
        {
            var raw = item?.GetValue<string>();
            if (string.IsNullOrEmpty(raw)) continue;
            string path;
            try
            {
                path = Path.GetFullPath(raw);
            }
            catch
            {
                continue;
            }

            // 恢复的是用户自己打开过的文档：限定 markdown/txt 后缀且必须存在，
            // 不让这条通道变成任意文件读取器
            if (!File.Exists(path) ||
                !SessionExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }

            OpenPath(path);
            opened += 1;
        }

        Reply(id, new JsonObject { ["ok"] = true, ["opened"] = opened });
    }

    private JsonObject RecentPayload()
    {
        EnsureRecentLoaded();
        var items = new JsonArray();
        foreach (var p in _recent)
        {
            if (!File.Exists(p)) continue;
            items.Add(new JsonObject { ["path"] = p, ["name"] = Path.GetFileName(p) });
        }
        return new JsonObject { ["items"] = items };
    }

    private void EnsureRecentLoaded()
    {
        if (_recentLoaded) return;
        _recentLoaded = true;
        try
        {
            if (!File.Exists(RecentFilePath)) return;
            if (JsonNode.Parse(File.ReadAllText(RecentFilePath)) is not JsonArray arr) return;
            foreach (var item in arr)
            {
                var p = item?.GetValue<string>();
                if (!string.IsNullOrEmpty(p) && File.Exists(p) && _recent.Count < RecentMax)
                {
                    _recent.Add(p);
                }
            }
        }
        catch
        {
            // 列表损坏就当没有
        }
    }

    private void RecordRecent(string path)
    {
        EnsureRecentLoaded();
        _recent.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
        _recent.Insert(0, path);
        while (_recent.Count > RecentMax)
        {
            _recent.RemoveAt(_recent.Count - 1);
        }

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(RecentFilePath)!);
            var arr = new JsonArray(_recent.Select(p => JsonValue.Create(p)).ToArray());
            File.WriteAllText(RecentFilePath, arr.ToJsonString());
        }
        catch
        {
            // 写失败只影响下次启动的记忆
        }
    }

    // ---------- 路径授权 ----------

    /// <summary>
    /// 本地资源服务：md 里引用的相对路径图片会写成 https://mdasset.local/&lt;相对路径&gt;，
    /// 请求在这里拦截并按当前文档目录解析，不经过网络。
    /// </summary>
    public void AttachAssets(CoreWebView2 core, CoreWebView2Environment environment)
    {
        _environment = environment;
        core.AddWebResourceRequestedFilter($"https://{AssetHost}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnAssetRequest;
    }

    private void OnAssetRequest(object? sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        var environment = _environment;
        if (environment == null) return;

        // 读文件可能较慢，挂起事件让 WebView2 不必干等
        var deferral = args.GetDeferral();
        try
        {
            args.Response = ResolveAssetResponse(environment, args.Request.Uri);
        }
        catch
        {
            args.Response = environment.CreateWebResourceResponse(null, 500, "Internal Server Error", string.Empty);
        }
        finally
        {
            deferral.Complete();
        }
    }

    private CoreWebView2WebResourceResponse ResolveAssetResponse(CoreWebView2Environment environment, string uri)
    {
        var noStore = "Access-Control-Allow-Origin: *\r\nCache-Control: no-store";

        var docDir = _docDir;
        if (string.IsNullOrEmpty(docDir))
        {
            return environment.CreateWebResourceResponse(null, 404, "Not Found", noStore);
        }

        string absolutePath;
        try
        {
            var parsed = new Uri(uri);
            var relative = Uri.UnescapeDataString(parsed.AbsolutePath).TrimStart('/');
            if (relative.Length == 0)
            {
                return environment.CreateWebResourceResponse(null, 404, "Not Found", noStore);
            }
            absolutePath = Path.GetFullPath(Path.Combine(docDir, relative));
        }
        catch
        {
            return environment.CreateWebResourceResponse(null, 400, "Bad Request", noStore);
        }

        // 归一化之后必须仍落在当前文档目录子树内，防止 '..' 或绝对路径越权读盘
        var root = Path.TrimEndingDirectorySeparator(docDir);
        var separator = Path.DirectorySeparatorChar.ToString();
        if (!absolutePath.StartsWith(root + separator, StringComparison.OrdinalIgnoreCase))
        {
            return environment.CreateWebResourceResponse(null, 403, "Forbidden", noStore);
        }

        var info = new FileInfo(absolutePath);
        if (!info.Exists || info.Length > MaxFileBytes)
        {
            return environment.CreateWebResourceResponse(null, 404, "Not Found", noStore);
        }

        var stream = new FileStream(absolutePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var headers = $"Content-Type: {MimeFor(absolutePath)}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *";
        return environment.CreateWebResourceResponse(stream, 200, "OK", headers);
    }

    private static string MimeFor(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".bmp" => "image/bmp",
        ".ico" => "image/x-icon",
        ".avif" => "image/avif",
        ".apng" => "image/apng",
        ".tif" or ".tiff" => "image/tiff",
        _ => "application/octet-stream",
    };

    /// <summary>只有经用户动作（启动参数、双击、打开/另存对话框）进过白名单的路径可读写</summary>
    private void Authorize(string fullPath)
    {
        _allowedPaths.Add(fullPath);
        RecordRecent(fullPath);
    }

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
