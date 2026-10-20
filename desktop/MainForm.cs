using System.Diagnostics;
using System.Drawing;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MdReader;

internal sealed class MainForm : Form
{
    private readonly WebView2 _web;
    private readonly HostBridge _bridge;
    private string? _initialFile;
    private CancellationTokenSource? _pipeCts;
    private readonly Panel _loadingOverlay;
    private readonly Spinner _spinner;
    private readonly Label _loadingText;

    private bool _allowExit;
    private int _borderPx = 7;
    private System.Threading.Timer? _geometryTimer;

    public MainForm(string? initialFile)
    {
        _initialFile = initialFile;

        Text = "mdreader";
        MinimumSize = new Size(820, 560);
        Size = new Size(1340, 900);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(247, 247, 245);

        // 「记住窗口大小位置」开启时先用上次退出时的几何恢复
        ApplySavedGeometry();

        // 无边框窗口：标题栏 / 最小化 / 最大化 / 关闭全部由页面内自绘，
        // 深色模式才能整体一致；边缘留出一条缩放带（见 WndProc）
        FormBorderStyle = FormBorderStyle.None;

        try
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
            // 图标缺失不影响运行
        }

        _web = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.FromArgb(247, 247, 245),
        };
        Controls.Add(_web);

        // WebView2 初始化 + 页面首帧要两三秒：期间盖一层原生绘制（即开即画）的
        // 加载动画，页面首帧 ping 到位后撤掉，用户全程看到的是有反馈的启动。
        // 不用 Dock=Fill：两个 Fill 兄弟控件会互抢剩余区域，直接镜像 WebView2 边界
        _loadingOverlay = new Panel
        {
            BackColor = Color.FromArgb(247, 247, 245),
        };
        _spinner = new Spinner
        {
            Size = new Size(44, 44),
            ForeColor = Color.FromArgb(80, 90, 100),
        };
        _loadingText = new Label
        {
            Text = "正在启动 mdreader……",
            AutoSize = true,
            Font = new Font("Microsoft YaHei UI", 12F),
            ForeColor = Color.FromArgb(96, 106, 116),
            BackColor = Color.Transparent,
        };
        _loadingOverlay.Controls.Add(_spinner);
        _loadingOverlay.Controls.Add(_loadingText);
        _loadingOverlay.Resize += (_, _) => CenterLoading();
        CenterLoading();
        Controls.Add(_loadingOverlay);
        // WinForms 里 Controls.Add 是追加到 z 序底部，必须显式置顶才能盖住 WebView2
        _loadingOverlay.BringToFront();
        Layout += (_, _) => _loadingOverlay.Bounds = _web.Bounds;

        _bridge = new HostBridge(this, _web);

        Load += OnLoadAsync;
        // 兜底：页面脚本异常没发 ping 时，最迟 6 秒也要把窗口露出来
        _revealFallbackTimer = new System.Windows.Forms.Timer { Interval = 6000 };
        _revealFallbackTimer.Tick += (_, _) => RevealWindow();
        _revealFallbackTimer.Start();
        FormClosed += OnFormClosed;
        LocationChanged += (_, _) => ScheduleGeometrySave();
        SizeChanged += (_, _) => ScheduleGeometrySave();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        _borderPx = (int)Math.Round(7 * DeviceDpi / 96.0);
        Padding = new Padding(_borderPx);

        // Win11 圆角；Win10 上只是返回错误码，无副作用
        try
        {
            var round = 2; // DWMWCP_ROUND
            _ = DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int));
        }
        catch
        {
            // 无 dwmapi 环境忽略
        }
    }

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "mdreader",
                "WebView2");
            Directory.CreateDirectory(userData);

            // 必须在浏览器进程启动前改偏好：运行期 Chromium 用的是内存里的副本
            ApplyPrintHeaderFooterPref(userData);

            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await _web.EnsureCoreWebView2Async(environment);

            var core = _web.CoreWebView2;
            var appDir = Path.Combine(AppContext.BaseDirectory, "app");
            if (!Directory.Exists(appDir))
            {
                MessageBox.Show(
                    $"未找到前端资源目录：\n{appDir}\n\n请确认安装完整。",
                    "mdreader",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                Close();
                return;
            }

            // 关键：用虚拟主机名映射本地目录。
            // 直接 file:// 加载会让 ESM 的 CORS 校验失败，页面起不来。
            core.SetVirtualHostNameToFolderMapping(
                HostBridge.VirtualHost,
                appDir,
                CoreWebView2HostResourceAccessKind.Allow);

            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            // 缩放由页面内 JS 处理（只缩内容区字号），禁用 WebView2 的
            // 整体缩放，否则 Ctrl+滚轮会连菜单栏一起放大缩小
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsPinchZoomEnabled = false;

            core.WebMessageReceived += (_, args) => _bridge.Handle(args);
            core.NavigationCompleted += OnNavigationCompleted;
            core.ProcessFailed += OnProcessFailed;
            core.NewWindowRequested += OnNewWindowRequested;
            core.NavigationStarting += OnNavigationStarting;
            _bridge.AttachAssets(core, environment);

            core.Navigate($"https://{HostBridge.VirtualHost}/index.html");
            StartPipeServer();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"初始化 WebView2 失败：\n{ex.Message}\n\n请确认已安装 Microsoft Edge WebView2 Runtime。",
                "mdreader",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
        }
    }

    // ---------- 无边框窗口：拖动 / 缩放 / 最大化 ----------

    protected override void WndProc(ref Message m)
    {
        const int WM_NCHITTEST = 0x0084;
        const int WM_GETMINMAXINFO = 0x0024;

        switch (m.Msg)
        {
            case WM_NCHITTEST:
                var hit = HitTestEdge(m.LParam);
                if (hit != 0)
                {
                    m.Result = (IntPtr)hit;
                    return;
                }
                break;
            case WM_GETMINMAXINFO:
                // 无边框最大化默认会盖住任务栏，这里限制到工作区
                ClampMaximizeToWorkArea(m.LParam);
                return;
        }
        base.WndProc(ref m);
    }

    /// <summary>WebView2 铺满客户区，只有 Padding 留出的边缘带能被窗体命中</summary>
    private int HitTestEdge(IntPtr lParam)
    {
        if (WindowState != FormWindowState.Normal) return 0;

        var raw = lParam.ToInt32();
        var screen = new Point((short)(raw & 0xFFFF), (short)((raw >> 16) & 0xFFFF));
        var p = PointToClient(screen);
        var b = _borderPx;

        var left = p.X < b;
        var right = p.X >= Width - b;
        var top = p.Y < b;
        var bottom = p.Y >= Height - b;

        if (top && left) return HTTOPLEFT;
        if (top && right) return HTTOPRIGHT;
        if (bottom && left) return HTBOTTOMLEFT;
        if (bottom && right) return HTBOTTOMRIGHT;
        if (left) return HTLEFT;
        if (right) return HTRIGHT;
        if (top) return HTTOP;
        if (bottom) return HTBOTTOM;
        return 0;
    }

    private void ClampMaximizeToWorkArea(IntPtr lParam)
    {
        var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
        var monitor = MonitorFromWindow(Handle, MONITOR_DEFAULTTONEAREST);
        var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        if (GetMonitorInfo(monitor, ref info))
        {
            var work = info.rcWork;
            var mon = info.rcMonitor;
            mmi.ptMaxSize.x = work.Right - work.Left;
            mmi.ptMaxSize.y = work.Bottom - work.Top;
            mmi.ptMaxPosition.x = work.Left - mon.Left;
            mmi.ptMaxPosition.y = work.Top - mon.Top;
            mmi.ptMinTrackSize.x = Math.Min(MinimumSize.Width, mmi.ptMaxSize.x);
            mmi.ptMinTrackSize.y = Math.Min(MinimumSize.Height, mmi.ptMaxSize.y);
        }
        Marshal.StructureToPtr(mmi, lParam, true);
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        var maximized = WindowState == FormWindowState.Maximized;
        Padding = maximized ? new Padding(0) : new Padding(_borderPx);
        // 构造期间 Size 变化会先于 _bridge 赋值触发
        _bridge?.NotifyWindowState(maximized);
    }

    private bool _revealed;
    private System.Windows.Forms.Timer? _revealFallbackTimer;

    /// <summary>页面首帧就绪（启动 ping 到达）后撤掉加载层；兜底定时器防止永远停在加载动画</summary>
    public void RevealWindow()
    {
        if (_revealed) return;
        if (!IsHandleCreated)
        {
            BeginInvoke((Action)RevealWindow);
            return;
        }
        _revealed = true;
        _revealFallbackTimer?.Stop();
        _revealFallbackTimer?.Dispose();
        _revealFallbackTimer = null;
        // ping 到达只说明首帧已排上合成，再等一小会儿确保真正提交到屏幕，
        // 否则露窗瞬间仍可能看到未绘完的白底
        var settle = new System.Windows.Forms.Timer { Interval = 120 };
        settle.Tick += (_, _) =>
        {
            settle.Stop();
            settle.Dispose();
            _loadingOverlay.Visible = false;
            Activate();
        };
        settle.Start();
    }

    private void CenterLoading()
    {
        var cx = _loadingOverlay.ClientSize.Width / 2;
        var cy = _loadingOverlay.ClientSize.Height / 2;
        _spinner.Location = new Point(cx - _spinner.Width / 2, cy - 56);
        _loadingText.Location = new Point(cx - _loadingText.Width / 2, cy + 12);
    }

    /// <summary>启动加载用的旋转点圈动画：12 个点绕圈，尾部渐隐</summary>
    private sealed class Spinner : Control
    {
        private readonly System.Windows.Forms.Timer _timer;
        private int _phase;

        public Spinner()
        {
            SetStyle(
                ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                    | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor,
                true);
            BackColor = Color.Transparent;
            TabStop = false;
            _timer = new System.Windows.Forms.Timer { Interval = 70 };
            _timer.Tick += (_, _) =>
            {
                _phase = (_phase + 1) % 12;
                Invalidate();
            };
        }

        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            if (Visible) _timer.Start();
            else _timer.Stop();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var cx = Width / 2f;
            var cy = Height / 2f;
            var radius = Math.Min(Width, Height) / 2f - 6f;
            for (var i = 0; i < 12; i++)
            {
                var age = (i - _phase + 12) % 12; // 0 = 头部亮点
                var alpha = 255 - age * 18;
                var angle = i * Math.PI / 6;
                var x = cx + (float)(Math.Cos(angle) * radius);
                var y = cy + (float)(Math.Sin(angle) * radius);
                var dot = 5.5f - age * 0.25f;
                using var brush = new SolidBrush(Color.FromArgb(alpha, ForeColor));
                g.FillEllipse(brush, new RectangleF(x - dot / 2, y - dot / 2, dot, dot));
            }
        }
    }

    /// <summary>页面标题栏按下时交回系统做窗口拖动</summary>
    public void BeginDrag()
    {
        ReleaseCapture();
        _ = SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
    }

    public void MinimizeWindow() => WindowState = FormWindowState.Minimized;

    /// <summary>用户从资源管理器双击文件转到本实例时调用：窗口要跟着内容一起现身。
    /// 后台进程直接 SetForegroundWindow 会被系统拦下，标准解法是临时挂到
    /// 当前前台窗口的输入线程上；再不行退一步闪任务栏图标提示</summary>
    public void BringToFrontForFile()
    {
        if (!IsHandleCreated) return;
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        var hwnd = Handle;
        var fore = GetForegroundWindow();
        var curThread = GetCurrentThreadId();
        var foreThread = fore != IntPtr.Zero ? GetWindowThreadProcessId(fore, IntPtr.Zero) : 0;
        var attached = foreThread != 0 && foreThread != curThread && AttachThreadInput(curThread, foreThread, true);
        try
        {
            _ = BringWindowToTop(hwnd);
            _ = SetForegroundWindow(hwnd);
        }
        finally
        {
            if (attached) _ = AttachThreadInput(curThread, foreThread, false);
        }
        if (GetForegroundWindow() != hwnd)
        {
            // 锁屏/前台权限被剥夺时 AttachThreadInput 也拿不到焦点：
            // 退一步用「瞬时置顶再复原」保证窗口至少排在 z 序最上面
            _ = SetWindowPos(hwnd, HwndTopmost, 0, 0, 0, 0, SWPNoSizeMove | SWPNoActivate);
            _ = SetWindowPos(hwnd, HwndNotopmost, 0, 0, 0, 0, SWPNoSizeMove | SWPNoActivate);
            var info = new FLASHWINFO
            {
                cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<FLASHWINFO>(),
                hwnd = hwnd,
                dwFlags = FlashwAll | FlashwTimerNoFg,
                uCount = 3,
                dwTimeout = 0,
            };
            _ = FlashWindowEx(ref info);
        }
    }

    public void ToggleMaximize() =>
        WindowState = WindowState == FormWindowState.Maximized
            ? FormWindowState.Normal
            : FormWindowState.Maximized;

    public void RequestClose() => Close();

    /// <summary>前端确认弹窗的答复：proceed 才真正退出</summary>
    public void CompleteExit(bool proceed)
    {
        if (!proceed) return;
        _allowExit = true;
        BeginInvoke((Action)Close);
    }

    /// <summary>深浅主题下，边缘缩放带 / 客户区底色要跟页面一致</summary>
    public void SetChromeDark(bool dark)
    {
        var color = dark ? Color.FromArgb(13, 17, 23) : Color.FromArgb(247, 247, 245);
        if (BackColor != color) BackColor = color;
        _loadingOverlay.BackColor = color;
        _loadingText.ForeColor = dark ? Color.FromArgb(155, 165, 175) : Color.FromArgb(96, 106, 116);
        _spinner.ForeColor = dark ? Color.FromArgb(200, 210, 220) : Color.FromArgb(80, 90, 100);
    }

    /// <summary>
    /// 未保存退出拦截：WebView2 里 beforeunload 不会弹系统确认框，
    /// 确认 UI 放在页面内（风格统一），宿主只负责取消关闭并等答复。
    /// </summary>
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_allowExit && e.CloseReason == CloseReason.UserClosing && _bridge.DocumentDirty)
        {
            e.Cancel = true;
            // 页面活着走页内确认；页面不可用（崩溃等）退回原生框
            if (!_bridge.RequestExit())
            {
                if (MessageBox.Show(
                        "当前文档有未保存的修改，确定退出吗？",
                        "mdreader",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Warning) == DialogResult.Yes)
                {
                    _allowExit = true;
                    BeginInvoke((Action)Close);
                }
            }
            return;
        }
        base.OnFormClosing(e);
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        // 加载层继续盖着：导航完成 ≠ 内容画完，撤层时机由页面首帧 ping（RevealWindow）决定
        _bridge.MarkReady();

        if (!string.IsNullOrEmpty(_initialFile) && File.Exists(_initialFile))
        {
            _bridge.OpenPath(_initialFile);
        }
        _initialFile = null;
    }

    /// <summary>只允许在应用内导航，外链一律交给系统浏览器</summary>
    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (e.Uri.StartsWith($"https://{HostBridge.VirtualHost}/", StringComparison.OrdinalIgnoreCase)) return;
        if (e.Uri.StartsWith($"https://{HostBridge.AssetHost}/", StringComparison.OrdinalIgnoreCase)) return;
        if (e.Uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return;

        e.Cancel = true;
        OpenInSystemBrowser(e.Uri);
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        OpenInSystemBrowser(e.Uri);
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            MessageBox.Show(
                "浏览器内核意外退出，请重新启动 mdreader。",
                "mdreader",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private static void OpenInSystemBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            // 打不开就算了，不打断阅读
        }
    }

    /// <summary>监听命名管道：第二个实例把要打开的文件路径转过来</summary>
    private void StartPipeServer()
    {
        _pipeCts = new CancellationTokenSource();
        var token = _pipeCts.Token;

        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    // 默认 DACL 派生自进程令牌：只有当前用户与管理员能连接。
                    // 更严格的按身份限定（PipeSecurity / currentUserIdentity）需 .NET 8 API。
                    using var server = new NamedPipeServerStream(
                        HostBridge.PipeName,
                        PipeDirection.In,
                        1,
                        PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous);

                    await server.WaitForConnectionAsync(token);
                    using var reader = new StreamReader(server, new UTF8Encoding(false));
                    var path = (await reader.ReadToEndAsync()).Trim();

                    if (path.Length > 0 && File.Exists(path))
                    {
                        BeginInvoke((Action)(() =>
                        {
                            _bridge.OpenPath(path);
                            BringToFrontForFile();
                        }));
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch
                {
                    try
                    {
                        await Task.Delay(400, token);
                    }
                    catch
                    {
                        break;
                    }
                }
            }
        }, token);
    }

    private void OnFormClosed(object? sender, FormClosedEventArgs e)
    {
        _pipeCts?.Cancel();
        _pipeCts?.Dispose();
        _geometryTimer?.Dispose();
        _geometryTimer = null;
        SaveGeometryNow();
        _bridge.Dispose();
    }

    // ---------- 窗口几何记忆（rememberWindow） ----------

    /// <summary>
    /// 打印页眉页脚默认开关：浏览器的打印预览把勾选状态存在 WebView2 配置档
    /// Preferences 的粘性设置（appState 是一段内嵌 JSON 字符串）里。
    /// 按应用设置（printHeaderFooter）在启动前把它写好，实现"默认不带页眉页脚"；
    /// 单次打印仍可在打印对话框里临时改。
    /// </summary>
    private static void ApplyPrintHeaderFooterPref(string userData)
    {
        var want = SettingsStore.GetBool("printHeaderFooter", false);
        var prefsPath = Path.Combine(userData, "EBWebView", "Default", "Preferences");
        try
        {
            var doc = File.Exists(prefsPath)
                ? JsonNode.Parse(File.ReadAllText(prefsPath)) as JsonObject
                : new JsonObject();
            if (doc == null) return;

            if (doc["printing"] is not JsonObject printing)
            {
                printing = new JsonObject();
                doc["printing"] = printing;
            }
            if (printing["print_preview_sticky_settings"] is not JsonObject sticky)
            {
                sticky = new JsonObject();
                printing["print_preview_sticky_settings"] = sticky;
            }

            var raw = sticky["appState"]?.GetValue<string>();
            var state = !string.IsNullOrEmpty(raw)
                ? JsonNode.Parse(raw) as JsonObject
                : new JsonObject { ["version"] = 2 };
            if (state == null) return;

            if (state["isHeaderFooterEnabled"]?.GetValue<bool>() == want) return;
            state["isHeaderFooterEnabled"] = want;
            sticky["appState"] = state.ToJsonString();
            Directory.CreateDirectory(Path.GetDirectoryName(prefsPath)!);
            File.WriteAllText(prefsPath, doc.ToJsonString());
        }
        catch
        {
            // 偏好读不了就不干预，用运行时默认
        }
    }

    private void ApplySavedGeometry()
    {
        if (!SettingsStore.GetBool("rememberWindow", true)) return;
        if (SettingsStore.Get("window") is not JsonObject obj) return;
        try
        {
            var x = obj["x"]?.GetValue<int>() ?? 0;
            var y = obj["y"]?.GetValue<int>() ?? 0;
            var w = obj["w"]?.GetValue<int>() ?? 0;
            var h = obj["h"]?.GetValue<int>() ?? 0;
            var max = obj["max"]?.GetValue<bool>() ?? false;
            if (w < 640 || h < 400) return;
            // 显示器变化后旧坐标可能悬在屏幕外，落在任一工作区内才恢复
            var rect = new Rectangle(x, y, w, h);
            if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect))) return;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(x, y);
            Size = new Size(w, h);
            if (max) WindowState = FormWindowState.Maximized;
        }
        catch
        {
            // 记录损坏就用默认几何
        }
    }

    private void ScheduleGeometrySave()
    {
        // 构造期间的属性赋值也会触发事件，句柄就绪后才开始记时
        if (!IsHandleCreated) return;
        _geometryTimer ??= new System.Threading.Timer(_ =>
        {
            try
            {
                if (IsHandleCreated) BeginInvoke((Action)SaveGeometryNow);
            }
            catch
            {
                // 窗口正在关闭
            }
        }, null, Timeout.Infinite, Timeout.Infinite);
        _geometryTimer.Change(700, Timeout.Infinite);
    }

    private void SaveGeometryNow()
    {
        if (!SettingsStore.GetBool("rememberWindow", true)) return;
        try
        {
            var maximized = WindowState == FormWindowState.Maximized;
            var bounds = WindowState == FormWindowState.Normal
                ? new Rectangle(Location, Size)
                : RestoreBounds;
            if (bounds.Width <= 0 || bounds.Height <= 0) return;
            SettingsStore.Set("window", new JsonObject
            {
                ["x"] = bounds.X,
                ["y"] = bounds.Y,
                ["w"] = bounds.Width,
                ["h"] = bounds.Height,
                ["max"] = maximized,
            });
        }
        catch
        {
            // 写失败只影响下次启动的记忆
        }
    }

    // ---------- Win32 互操作 ----------

    private const int WM_NCLBUTTONDOWN = 0x00A1;
    private const int HTCAPTION = 2;
    private const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13;
    private const int HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
    private const int MONITOR_DEFAULTTONEAREST = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    private static readonly IntPtr HwndTopmost = new(-1);
    private static readonly IntPtr HwndNotopmost = new(-2);
    private const uint SWPNoSizeMove = 0x2;
    private const uint SWPNoActivate = 0x10;

    private const uint FlashwAll = 0x3;
    private const uint FlashwTimerNoFg = 0x4;

    [StructLayout(LayoutKind.Sequential)]
    private struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    [DllImport("user32.dll")]
    private static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int pvAttribute, int cbAttribute);
}
