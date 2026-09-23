using System.IO.Pipes;
using System.Text;

namespace MdReader;

internal static class Program
{
    /// <summary>单实例互斥体名称</summary>
    private const string MutexName = @"Global\mdreader.single.instance";

    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // 双击 .md 打开时，Windows 会把路径作为第一个参数传进来
        var target = args.FirstOrDefault(a => a.Length > 0 && !a.StartsWith('-'));

        using var mutex = new Mutex(true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            // 已有实例在运行：把文件路径通过命名管道转过去，不新开窗口
            if (target is not null) ForwardToRunningInstance(target);
            return;
        }

        Application.Run(new MainForm(target));
    }

    private static void ForwardToRunningInstance(string path)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", HostBridge.PipeName, PipeDirection.Out);
            client.Connect(1500);
            using var writer = new StreamWriter(client, new UTF8Encoding(false));
            writer.Write(path);
            writer.Flush();
        }
        catch
        {
            // 转发失败就静默放弃，避免干扰用户
        }
    }
}
