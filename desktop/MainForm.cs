using System.Diagnostics;
using System.Drawing;
using System.IO.Pipes;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MdReader;

internal sealed class MainForm : Form
{
    private readonly WebView2 _web;
    private readonly HostBridge _bridge;
    private string? _initialFile;
    private CancellationTokenSource? _pipeCts;
    private readonly Label _loadingLabel;

    public MainForm(string? initialFile)
    {
        _initialFile = initialFile;

        Text = "mdreader";
        MinimumSize = new Size(820, 560);
        Size = new Size(1340, 900);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(247, 247, 245);
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

        // WebView2 初始化 + 页面加载需要几秒，期间用提示盖住空白，
        // 避免用户面对一个空荡荡的程序框
        _loadingLabel = new Label
        {
            Text = "正在打开文档，请稍后……",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Microsoft YaHei UI", 14F),
            ForeColor = Color.FromArgb(96, 106, 116),
            BackColor = Color.FromArgb(247, 247, 245),
        };
        Controls.Add(_loadingLabel); // 后加的控件 z 序更高，正好盖住下层的 WebView2

        _bridge = new HostBridge(this, _web);

        Load += OnLoadAsync;
        FormClosed += OnFormClosed;
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

    /// <summary>
    /// WebView2 里 beforeunload 不会弹系统确认框，未保存拦截必须由宿主做。
    /// 脏状态由前端 setTitle 持续同步进 HostBridge。
    /// </summary>
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (_bridge.DocumentDirty)
        {
            var answer = MessageBox.Show(
                "当前文档有未保存的修改，确定退出吗？",
                "mdreader",
                MessageBoxButtons.YesNoCancel,
                MessageBoxIcon.Warning);
            if (answer != DialogResult.Yes)
            {
                e.Cancel = true;
                return;
            }
        }
        base.OnFormClosing(e);
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        // 页面就绪，撤掉启动提示
        if (_loadingLabel.Visible)
        {
            _loadingLabel.Visible = false;
        }

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
                        BeginInvoke((Action)(() => _bridge.OpenPath(path)));
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
        _bridge.Dispose();
    }
}
