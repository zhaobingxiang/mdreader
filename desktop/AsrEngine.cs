using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MdReader;

/// <summary>
/// 会记的本地语音转写引擎（sherpa-onnx + SenseVoice）。
///
/// 音频不进任何模型：转写在单机完成，输出的带时间戳文本再交给设置里配置的
/// 文本模型分析。所以这里只做四件事——装引擎、存会议音频、跑子进程转写、清理。
///
/// 引擎包 260MB 不可能进安装包，也不能假定用户机器出得了公网，因此安装走
/// 用户自己的网盘直链：边下边算 SHA256，解包后再按 manifest 逐文件核对，
/// 全部通过才把暂存目录换成正本——半途失败绝不留下一套「看着装好实则不能用」的引擎。
/// </summary>
internal sealed class AsrEngine : IDisposable
{
    /// <summary>解包白名单：只认这几个相对路径，其余条目一律跳过。
    /// licenses/ 是模型与引擎的许可原文——SenseVoice 权重按 FunASR 模型协议分发，
    /// 协议 2.2 要求保留署名与模型名，许可必须随包一起走</summary>
    private static readonly Regex SafeFilePattern =
        new(@"^(manifest\.json|bin/[a-z0-9._-]+|model/[a-z0-9._-]+|licenses/[a-z0-9._-]+)$", RegexOptions.Compiled);

    private static readonly Regex MeetKeyPattern = new("^[A-Za-z0-9_-]{1,40}$", RegexOptions.Compiled);

    /// <summary>网盘分享链接里的分享编号：?link=qf0cS67g</summary>
    private static readonly Regex LinkCodePattern = new(@"[?&]link=([A-Za-z0-9_-]{1,64})", RegexOptions.Compiled);

    /// <summary>单块最长秒数。SenseVoice 只吃短片段，分句交给 VAD；这里按 10 分钟
    /// 切块逐块起进程：长会有进度可看，进程内存也压得住</summary>
    private const int ChunkSeconds = 600;

    private const int SampleRate = 16_000;

    private readonly Form? _owner;
    private readonly Dictionary<int, CancellationTokenSource> _running = new();

    /// <summary>正在跑的转写数：安装前要确认没有进程占着引擎文件</summary>
    private int _transcribing;

    private readonly Dictionary<string, FileStream> _audioStreams = new();
    private readonly object _gate = new();

    public AsrEngine(Form? owner) => _owner = owner;

    private static string BaseDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "mdreader");

    public static string Root => Path.Combine(BaseDir, "asr");

    private static string StagingDir => Path.Combine(BaseDir, "asr-staging");

    public static string MeetDir => Path.Combine(BaseDir, "meet");

    private static string CliPath => Path.Combine(Root, "bin", "sherpa-onnx-vad-with-offline-asr.exe");
    private static string ModelPath => Path.Combine(Root, "model", "model.int8.onnx");
    private static string TokensPath => Path.Combine(Root, "model", "tokens.txt");
    private static string VadPath => Path.Combine(Root, "model", "silero_vad.onnx");

    /// <summary>上一次安装/转写失败的原因，界面要能复盘</summary>
    private string? _lastError;

    // ---------- 状态 ----------

    public JsonObject Status()
    {
        var ready = IsReady();
        return new JsonObject
        {
            ["ready"] = ready,
            ["dir"] = Root,
            ["version"] = ready ? ManifestVersion() : 0,
            ["error"] = _lastError ?? string.Empty,
            ["threads"] = DefaultThreads(),
        };
    }

    private static bool IsReady() =>
        File.Exists(CliPath) && File.Exists(ModelPath) && File.Exists(TokensPath) && File.Exists(VadPath);

    private static int ManifestVersion()
    {
        try
        {
            var manifest = Path.Combine(Root, "manifest.json");
            if (!File.Exists(manifest)) return 0;
            return JsonNode.Parse(File.ReadAllText(manifest))?["version"]?.GetValue<int>() ?? 0;
        }
        catch
        {
            // 清单坏了当作没装
            return 0;
        }
    }

    internal static int DefaultThreads() => Math.Clamp(Environment.ProcessorCount / 2, 2, 8);

    // ---------- 安装 ----------

    /// <summary>从网盘直链下载安装；进度与结果都通过 post 推回页面</summary>
    public void StartInstall(string url, int requestId, Action<JsonObject> post)
    {
        var cts = Track(requestId);
        if (cts == null) return;
        _ = Task.Run(() => InstallFromUrl(url, requestId, post, cts));
    }

    /// <summary>完全离线的环境：用户自己把 zip 拷到本机，从文件对话框装</summary>
    public void StartInstallFromZip(int requestId, Action<JsonObject> post)
    {
        var cts = Track(requestId);
        if (cts == null) return;

        if (_owner == null || !_owner.IsHandleCreated)
        {
            Untrack(requestId);
            Fail(requestId, "无法弹出文件对话框", post);
            return;
        }

        var dialog = new OpenFileDialog
        {
            Title = "选择语音模型包",
            Filter = "语音模型包|*.zip|所有文件|*.*",
            CheckFileExists = true,
        };

        // 对话框阻塞到用户操作完成，放到 UI 线程上跑，回包照旧走 post
        _owner.BeginInvoke((Action)(() =>
        {
            string? picked = dialog.ShowDialog(_owner) == DialogResult.OK ? dialog.FileName : null;
            dialog.Dispose();
            if (picked == null)
            {
                Untrack(requestId);
                post(new JsonObject { ["event"] = "asrDone", ["requestId"] = requestId, ["cancelled"] = true });
                return;
            }
            _ = Task.Run(() => Install(picked, requestId, post, cts));
        }));
    }

    private void InstallFromUrl(string url, int requestId, Action<JsonObject> post, CancellationTokenSource cts)
    {
        var tempZip = Path.Combine(Path.GetTempPath(), $"mdreader-asr-{Guid.NewGuid():N}.zip");
        try
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                (uri.Scheme != "http" && uri.Scheme != "https"))
            {
                Fail(requestId, "下载地址无效", post);
                return;
            }

            Download(url, tempZip, requestId, post, cts.Token);
            Install(tempZip, requestId, post, cts);
        }
        catch (OperationCanceledException)
        {
            post(new JsonObject { ["event"] = "asrDone", ["requestId"] = requestId, ["cancelled"] = true });
        }
        catch (Exception ex)
        {
            Fail(requestId, ex.Message, post);
        }
        finally
        {
            Untrack(requestId);
            TryDeleteFile(tempZip);
        }
    }

    private void Install(string zipPath, int requestId, Action<JsonObject> post, CancellationTokenSource cts)
    {
        try
        {
            Extract(zipPath, requestId, post, cts.Token);
            VerifyStaging();
            Commit();
            post(new JsonObject
            {
                ["event"] = "asrDone",
                ["requestId"] = requestId,
                ["cancelled"] = false,
                ["ready"] = true,
                ["dir"] = Root,
                ["version"] = ManifestVersion(),
            });
        }
        catch (OperationCanceledException)
        {
            CleanupStaging();
            post(new JsonObject { ["event"] = "asrDone", ["requestId"] = requestId, ["cancelled"] = true });
        }
        catch (Exception ex)
        {
            CleanupStaging();
            Fail(requestId, ex.Message, post);
        }
        finally
        {
            Untrack(requestId);
        }
    }

    private void Download(string url, string target, int requestId, Action<JsonObject> post, CancellationToken ct)
    {
        var handler = new SocketsHttpHandler { ConnectTimeout = TimeSpan.FromSeconds(20) };
        using var http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };

        url = ResolveShareUrl(url, http, requestId, post, ct);

        using var request = new HttpRequestMessage(HttpMethod.Get, url);

        using var response = http.Send(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
        {
            throw new IOException(
                $"下载失败（HTTP {(int)response.StatusCode}）：网盘直链可能已过期，或需要先登录");
        }

        var total = response.Content.Headers.ContentLength ?? -1L;
        using var source = response.Content.ReadAsStream(ct);
        using var sink = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20);

        var buffer = new byte[1 << 16];
        long done = 0;
        var lastReport = Environment.TickCount64;
        var lastBytes = 0L;

        while (true)
        {
            var read = source.ReadAsync(buffer, 0, buffer.Length, ct).GetAwaiter().GetResult();
            if (read == 0) break;
            sink.Write(buffer, 0, read);
            done += read;

            var now = Environment.TickCount64;
            if (now - lastReport < 500) continue;
            var speed = (done - lastBytes) * 1000 / Math.Max(1, now - lastReport);
            lastBytes = done;
            lastReport = now;

            post(new JsonObject
            {
                ["event"] = "asrProgress",
                ["requestId"] = requestId,
                ["phase"] = "download",
                ["percent"] = total > 0 ? (int)(done * 100 / total) : -1,
                ["bytes"] = done,
                ["total"] = total,
                ["speed"] = speed,
            });
        }

        if (total > 0 && done != total) throw new IOException($"下载不完整（{done}/{total} 字节）");
    }

    /// <summary>网盘分享链接的外层是下载页，不是文件本身，要两步换成预签名直链：
    /// linkPath → queryConfig 拿 instanceId → link/download 拿带签名的文件地址（24 小时有效，
    /// 所以每次安装现换，不能缓存）。分享的是文件夹时，link/download 认不出目录，
    /// 要先用 queryInstancePage 列出目录，从里面挑出模型包 zip。
    /// 不像网盘分享的地址原样返回，直链依旧可用。</summary>
    private static string ResolveShareUrl(string url, HttpClient http, int requestId, Action<JsonObject> post, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return url;
        if (!uri.Host.EndsWith("ticklink.com", StringComparison.OrdinalIgnoreCase) ||
            !uri.AbsolutePath.Contains("fileDownload", StringComparison.OrdinalIgnoreCase))
        {
            return url;
        }

        var code = LinkCodePattern.Match(uri.Query).Groups[1].Value;
        if (code.Length == 0) throw new IOException("网盘链接里没有分享编号（?link=…）");

        post(new JsonObject
        {
            ["event"] = "asrProgress",
            ["requestId"] = requestId,
            ["phase"] = "resolve",
            ["percent"] = -1,
        });

        var origin = $"{uri.Scheme}://{uri.Host}";
        var share = Uri.EscapeDataString(code);
        var cfg = ApiGet(http, $"{origin}/disk/api/link/queryConfig?linkPath={share}", ct);
        var instanceId = TextOf(cfg["data"]?["instanceId"]);
        if (instanceId.Length == 0) throw new IOException("网盘没返回文件编号，链接可能已失效或被取消分享");

        var direct = DownloadLink(http, origin, share, instanceId, ct);
        return direct ?? FromFolderShare(http, origin, share, instanceId, ct);
    }

    /// <summary>按 instanceId 换预签名直链；换不到（分享的是文件夹）返回 null，由调用方改走列目录</summary>
    private static string? DownloadLink(HttpClient http, string origin, string share, string instanceId, CancellationToken ct)
    {
        var obj = ApiSend(http, new HttpRequestMessage(HttpMethod.Get,
            $"{origin}/disk/api/link/download?instanceId={Uri.EscapeDataString(instanceId)}&linkPath={share}&fileSharingId="), ct);
        var file = TextOf(obj["data"]);
        return Ok(obj) && IsHttp(file) ? file : null;
    }

    /// <summary>文件夹分享：列出目录里的 zip，取最近改动的那个</summary>
    private static string FromFolderShare(HttpClient http, string origin, string share, string folderId, CancellationToken ct)
    {
        var page = ApiPost(http, new HttpRequestMessage(HttpMethod.Post,
            $"{origin}/disk/api/link/queryInstancePage?parentId={Uri.EscapeDataString(folderId)}&linkPath={share}&pageSize=100&pageNum=1"), ct);
        var rows = page["data"] as JsonArray ?? new JsonArray();
        JsonObject? picked = null;
        foreach (var row in rows)
        {
            if (row is not JsonObject item) continue;
            if (!string.Equals(TextOf(item["fileType"]), "zip", StringComparison.OrdinalIgnoreCase)) continue;
            if (picked == null || NumOf(item["modifyTime"]) > NumOf(picked["modifyTime"])) picked = item;
        }

        if (picked == null) throw new IOException($"分享目录里找到 {rows.Count} 个条目，没有可安装的 zip 包");
        var name = TextOf(picked["instanceName"], "分享目录里的压缩包");
        var childId = TextOf(picked["instanceId"]);
        var file = childId.Length > 0 ? DownloadLink(http, origin, share, childId, ct) : null;
        if (file == null) throw new IOException($"网盘没能给出「{name}」的下载地址");
        return file;
    }

    // 解析出来的标量值都是 JsonValue<JsonElement>，取字符串/数字都从 JsonElement 走
    private static string TextOf(JsonNode? node, string fallback = "") =>
        node is JsonValue value ? value.GetValue<JsonElement>().ToString() : fallback;

    private static long NumOf(JsonNode? node) => long.TryParse(TextOf(node), out var number) ? number : 0;

    private static bool Ok(JsonObject obj) => NumOf(obj["errcode"]) == 0;

    private static bool IsHttp(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    /// <summary>网盘接口出错也返回 HTTP 200，真正的成败在 errcode 里</summary>
    private static JsonObject ApiGet(HttpClient http, string url, CancellationToken ct)
    {
        var obj = ApiSend(http, new HttpRequestMessage(HttpMethod.Get, url), ct);
        return MustBeOk(obj);
    }

    private static JsonObject ApiPost(HttpClient http, HttpRequestMessage request, CancellationToken ct) =>
        MustBeOk(ApiSend(http, request, ct));

    private static JsonObject MustBeOk(JsonObject obj)
    {
        if (Ok(obj)) return obj;
        throw new IOException($"网盘接口报错：{TextOf(obj["errmsg"], "未知原因")}");
    }

    private static JsonObject ApiSend(HttpClient http, HttpRequestMessage request, CancellationToken ct)
    {
        string body;
        try
        {
            body = http.SendAsync(request, ct).GetAwaiter().GetResult().Content.ReadAsStringAsync(ct).GetAwaiter().GetResult();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            throw new IOException($"读取网盘接口失败：{ex.Message}");
        }

        return JsonNode.Parse(body) as JsonObject ?? throw new IOException("网盘接口返回的不是 JSON");
    }

    private void Extract(string zipPath, int requestId, Action<JsonObject> post, CancellationToken ct)
    {
        if (!File.Exists(zipPath)) throw new IOException("模型包不存在");
        CleanupStaging();
        Directory.CreateDirectory(StagingDir);

        using var archive = ZipFile.OpenRead(zipPath);
        var names = new List<string>();
        foreach (var entry in archive.Entries)
        {
            // zip 条目可能带 '\' 或 '../'，归一化后仍只允许白名单内的路径
            var name = entry.FullName.Replace('\\', '/').TrimStart('/');
            if (!SafeFilePattern.IsMatch(name) || name.EndsWith("/")) continue;
            names.Add(name);
        }

        var index = 0;
        foreach (var entry in archive.Entries)
        {
            ct.ThrowIfCancellationRequested();
            var name = entry.FullName.Replace('\\', '/').TrimStart('/');
            if (!names.Contains(name)) continue;

            var target = Path.Combine(StagingDir, name.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, overwrite: true);
            index += 1;

            post(new JsonObject
            {
                ["event"] = "asrProgress",
                ["requestId"] = requestId,
                ["phase"] = "extract",
                ["percent"] = (int)(index * 100.0 / Math.Max(1, names.Count)),
            });
        }
    }

    /// <summary>按 manifest 逐个核对大小与 sha256，任何一项不符都不落盘</summary>
    private static void VerifyStaging()
    {
        var manifestPath = Path.Combine(StagingDir, "manifest.json");
        if (!File.Exists(manifestPath)) throw new IOException("模型包缺少 manifest.json");
        if (JsonNode.Parse(File.ReadAllText(manifestPath))?["files"] is not JsonArray list)
        {
            throw new IOException("manifest.json 缺少 files 清单");
        }

        foreach (var item in list)
        {
            if (item is not JsonObject entry) continue;
            var name = entry["name"]?.GetValue<string>()?.Replace('\\', '/') ?? string.Empty;
            var bytes = entry["bytes"]?.GetValue<long>() ?? -1;
            var want = entry["sha256"]?.GetValue<string>()?.ToLowerInvariant() ?? string.Empty;

            if (!SafeFilePattern.IsMatch(name)) throw new IOException($"manifest 里的路径不合法：{name}");
            var path = Path.Combine(StagingDir, name.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(path)) throw new IOException($"模型包缺少 {name}");

            var info = new FileInfo(path);
            if (info.Length != bytes) throw new IOException($"{name} 大小不符（{info.Length}≠{bytes}）");
            if (want.Length > 0 && Sha256File(path) != want) throw new IOException($"{name} 校验不通过");
        }
    }

    private void Commit()
    {
        if (Volatile.Read(ref _transcribing) > 0) throw new InvalidOperationException("正在转写，先结束后再更新模型");

        Directory.CreateDirectory(BaseDir);
        if (Directory.Exists(Root)) Directory.Delete(Root, true);
        Directory.Move(StagingDir, Root);
    }

    private static string Sha256File(string path)
    {
        using var sha = SHA256.Create();
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20);
        return Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
    }

    private void CleanupStaging()
    {
        try
        {
            if (Directory.Exists(StagingDir)) Directory.Delete(StagingDir, true);
        }
        catch
        {
            // 残留目录下次安装前再清
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // 临时文件删不掉不影响功能
        }
    }

    // ---------- 会议音频落盘 ----------

    /// <summary>页面把重采样后的 16k 单声道 PCM 分段送上来，宿主拼成一个 WAV。
    /// 两小时会议的光 PCM 就 200MB+，留在页面内存里必然崩，只能边录边写盘</summary>
    public void AudioOpen(string key)
    {
        var path = MeetPath(key);
        Directory.CreateDirectory(MeetDir);
        var stream = new FileStream(path, FileMode.Create, FileAccess.ReadWrite, FileShare.None, 1 << 16);
        var header = WavHeader(0);
        stream.Write(header, 0, header.Length);

        lock (_gate)
        {
            if (_audioStreams.TryGetValue(key, out var old)) old.Dispose();
            _audioStreams[key] = stream;
        }
    }

    public void AudioAppend(string key, byte[] pcm)
    {
        FileStream stream;
        lock (_gate)
        {
            if (!_audioStreams.TryGetValue(key, out stream!)) throw new IOException("录音会话不存在");
        }
        stream.Write(pcm, 0, pcm.Length);
    }

    public JsonObject AudioClose(string key)
    {
        FileStream stream;
        lock (_gate)
        {
            if (!_audioStreams.TryGetValue(key, out stream!)) throw new IOException("录音会话不存在");
            _audioStreams.Remove(key);
        }

        long pcmBytes;
        using (stream)
        {
            pcmBytes = Math.Max(0, stream.Length - 44);
            stream.Position = 0;
            var header = WavHeader(pcmBytes);
            stream.Write(header, 0, header.Length);
        }

        var path = MeetPath(key);
        return new JsonObject
        {
            ["path"] = path,
            ["bytes"] = new FileInfo(path).Length,
            ["seconds"] = (long)Math.Round(pcmBytes / 2.0 / SampleRate),
        };
    }

    public void AudioClear(string key)
    {
        lock (_gate)
        {
            if (_audioStreams.TryGetValue(key, out var stream))
            {
                _audioStreams.Remove(key);
                stream.Dispose();
            }
        }
        TryDeleteFile(MeetPath(key));
    }

    /// <summary>录音和上传的音频都归到这个目录，页面只能按 key 取用</summary>
    public static string MeetPath(string key)
    {
        if (!MeetKeyPattern.IsMatch(key)) throw new IOException("录音标识不合法");
        return Path.Combine(MeetDir, key + ".wav");
    }

    private static byte[] WavHeader(long pcmBytes)
    {
        var data = (int)Math.Min(pcmBytes, int.MaxValue - 12);
        var header = new byte[44];
        void Text(int offset, string value) => Encoding.ASCII.GetBytes(value).CopyTo(header, offset);
        void I32(int offset, int value) => BitConverter.GetBytes(value).CopyTo(header, offset);
        void I16(int offset, short value) => BitConverter.GetBytes(value).CopyTo(header, offset);

        Text(0, "RIFF");
        I32(4, data + 36);
        Text(8, "WAVE");
        Text(12, "fmt ");
        I32(16, 16);
        I16(20, 1);            // PCM
        I16(22, 1);            // 单声道
        I32(24, SampleRate);
        I32(28, SampleRate * 2);
        I16(32, 2);            // 块对齐 = 声道×位深/8，sherpa 读文件时校验这个
        I16(34, 16);
        Text(36, "data");
        I32(40, data);
        return header;
    }

    // ---------- 转写 ----------

    public void StartTranscribe(string key, int requestId, int threads, Action<JsonObject> post)
    {
        var cts = Track(requestId);
        if (cts == null) return;

        Interlocked.Increment(ref _transcribing);
        var chosen = threads > 0 ? threads : DefaultThreads();
        _ = Task.Run(() =>
        {
            try
            {
                Transcribe(key, chosen, requestId, post, cts.Token);
            }
            finally
            {
                Interlocked.Decrement(ref _transcribing);
                Untrack(requestId);
            }
        });
    }

    private void Transcribe(string key, int threads, int requestId, Action<JsonObject> post, CancellationToken ct)
    {
        var chunkDir = Path.Combine(MeetDir, $"chunks-{requestId}");
        try
        {
            if (!IsReady())
            {
                Fail(requestId, "还没有安装语音模型：请在「设置 → 会记」里点下载", post);
                return;
            }

            var source = MeetPath(key);
            if (!File.Exists(source))
            {
                Fail(requestId, "录音文件不存在，可能已被清理", post);
                return;
            }

            var chunks = SplitWav(source, chunkDir, ct);
            var recognizer = new Recognizer(Math.Clamp(threads, 1, Math.Max(1, Environment.ProcessorCount)));
            var all = new JsonArray();

            for (var index = 0; index < chunks.Count; index++)
            {
                ct.ThrowIfCancellationRequested();
                var (path, offset) = chunks[index];
                foreach (var segment in recognizer.Run(path, offset, ct)) all.Add(segment);

                // 同一批段要整份带上：页面只需要最后一次的完整结果
                post(new JsonObject
                {
                    ["event"] = "asrSegments",
                    ["requestId"] = requestId,
                    ["segments"] = JsonNode.Parse(all.ToJsonString()),
                    ["chunk"] = index + 1,
                    ["chunks"] = chunks.Count,
                    ["percent"] = (int)((index + 1) * 100.0 / chunks.Count),
                });
            }

            post(new JsonObject
            {
                ["event"] = "asrDone",
                ["requestId"] = requestId,
                ["cancelled"] = false,
                ["segments"] = JsonNode.Parse(all.ToJsonString()),
                ["seconds"] = (long)Math.Round((new FileInfo(source).Length - 44) / 2.0 / SampleRate),
            });
        }
        catch (OperationCanceledException)
        {
            post(new JsonObject { ["event"] = "asrDone", ["requestId"] = requestId, ["cancelled"] = true });
        }
        catch (Exception ex)
        {
            Fail(requestId, ex.Message, post);
        }
        finally
        {
            try
            {
                if (Directory.Exists(chunkDir)) Directory.Delete(chunkDir, true);
            }
            catch
            {
                // 分块留给启动清理
            }
        }
    }

    /// <summary>按时长切块，切点尽量落在静音上：正好卡在词中间会丢字</summary>
    private static List<(string Path, double Offset)> SplitWav(string source, string chunkDir, CancellationToken ct)
    {
        Directory.CreateDirectory(chunkDir);
        var bytes = File.ReadAllBytes(source);
        if (bytes.Length < 44) throw new IOException("音频文件不完整");
        if (Encoding.ASCII.GetString(bytes, 0, 4) != "RIFF" || Encoding.ASCII.GetString(bytes, 8, 4) != "WAVE")
        {
            throw new IOException("不是合法的 WAV 音频");
        }
        if (BitConverter.ToInt16(bytes, 22) != 1 || BitConverter.ToInt16(bytes, 34) != 16)
        {
            throw new IOException("只支持 16 位单声道 PCM");
        }

        var rate = BitConverter.ToInt32(bytes, 24);
        if (rate != SampleRate) throw new IOException($"采样率应为 {SampleRate}，实际 {rate}");

        var dataStart = 44;
        var totalSamples = (long)(bytes.Length - dataStart) / 2;
        var perChunk = (long)ChunkSeconds * rate;
        var result = new List<(string, double)>();

        var cursor = 0L;
        while (cursor < totalSamples)
        {
            ct.ThrowIfCancellationRequested();
            var end = Math.Min(cursor + perChunk, totalSamples);
            if (end < totalSamples) end = SnapToSilence(bytes, dataStart, end, rate);
            // 静音搜索理论上可能把落刀点推回游标之前，那样就永远走不完
            if (end <= cursor) end = Math.Min(cursor + perChunk, totalSamples);

            var path = Path.Combine(chunkDir, $"{result.Count}.wav");
            WriteWavSlice(path, bytes, dataStart, cursor, end);
            result.Add((path, (double)cursor / rate));
            cursor = end;
        }

        if (result.Count == 0)
        {
            var path = Path.Combine(chunkDir, "0.wav");
            WriteWavSlice(path, bytes, dataStart, 0, 0);
            result.Add((path, 0));
        }
        return result;
    }

    /// <summary>在切点前 60 秒内找一段 80ms 静音落刀；找不到就用原切点</summary>
    private static long SnapToSilence(byte[] bytes, int dataStart, long preferred, int rate)
    {
        var span = (long)(rate * 0.08);
        var floor = Math.Max(span, preferred - rate * 60);

        for (var cursor = preferred - span; cursor >= floor; cursor -= rate / 4)
        {
            var peak = 0;
            for (var i = cursor; i < cursor + span; i++)
            {
                var sample = Math.Abs(BitConverter.ToInt16(bytes, dataStart + (int)i * 2));
                if (sample > peak) peak = sample;
            }
            if (peak < 220) return cursor + span / 2;
        }
        return preferred;
    }

    private static void WriteWavSlice(string path, byte[] source, int dataStart, long start, long end)
    {
        var pcmBytes = (end - start) * 2;
        var header = WavHeader(pcmBytes);
        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16);
        stream.Write(header, 0, header.Length);
        if (pcmBytes > 0) stream.Write(source, (int)(dataStart + start * 2), (int)pcmBytes);
    }

    /// <summary>一次进程调用识别一个分块。模型加载约 2 秒，所以宁可少切几刀</summary>
    private sealed class Recognizer
    {
        private static readonly Regex SegmentPattern =
            new(@"^\s*([0-9]+(?:\.[0-9]+)?)\s*--\s*([0-9]+(?:\.[0-9]+)?)\s*:\s*(.+?)\s*$", RegexOptions.Compiled);

        private readonly int _threads;

        public Recognizer(int threads) => _threads = threads;

        public List<JsonObject> Run(string wavPath, double offset, CancellationToken ct)
        {
            var output = new List<JsonObject>();
            var startInfo = new ProcessStartInfo(CliPath)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(CliPath)!,
                // 子进程输出是 UTF-8；按控制台默认的 GBK 解，中文转写稿会变乱码
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            startInfo.ArgumentList.Add($"--sense-voice-model={ModelPath}");
            startInfo.ArgumentList.Add($"--tokens={TokensPath}");
            startInfo.ArgumentList.Add($"--silero-vad-model={VadPath}");
            startInfo.ArgumentList.Add("--sense-voice-language=zh");
            // ITN：把「十月十五日」「三点四秒」口播规范成 10月15日 / 3.4 秒，纪要里能直接用
            startInfo.ArgumentList.Add("--sense-voice-use-itn=1");
            startInfo.ArgumentList.Add($"--num-threads={_threads}");
            startInfo.ArgumentList.Add(wavPath);

            using var process = Process.Start(startInfo) ?? throw new IOException("转写进程启动失败");
            var stderr = new StringBuilder();
            process.ErrorDataReceived += (_, args) =>
            {
                if (args.Data != null) stderr.AppendLine(args.Data);
            };
            process.BeginErrorReadLine();
            // 取消要立刻生效：转写块可能几分钟不出一个字，只等输出行是等不到的
            using var cancelKill = ct.Register(() =>
            {
                try
                {
                    if (!process.HasExited) process.Kill(true);
                }
                catch
                {
                    // 进程已经退出
                }
            });

            try
            {
                while (true)
                {
                    ct.ThrowIfCancellationRequested();
                    var line = process.StandardOutput.ReadLine();
                    if (line == null) break;

                    var match = SegmentPattern.Match(line);
                    if (!match.Success) continue;

                    output.Add(new JsonObject
                    {
                        ["start"] = Math.Round(offset + double.Parse(match.Groups[1].Value)),
                        ["end"] = Math.Round(offset + double.Parse(match.Groups[2].Value)),
                        ["text"] = match.Groups[3].Value.Trim(),
                    });
                }

                ct.ThrowIfCancellationRequested();
                // 输出读完就说明活儿干完了；给足时间，宁可等也别悄悄丢掉后半段转写
                if (!process.WaitForExit(10 * 60 * 1000)) throw new IOException("转写超时未完成，可以把「设置 → 会记」里的线程数调大再试");
                if (process.ExitCode != 0)
                {
                    var tail = stderr.ToString().Trim();
                    throw new IOException($"转写失败（退出码 {process.ExitCode}）：{Truncate(tail)}");
                }
            }
            finally
            {
                try
                {
                    if (!process.HasExited) process.Kill(true);
                }
                catch
                {
                    // 进程已经退出
                }
            }

            return output;
        }

        // sherpa 出错前会先打一屏参数，真正的报错在末尾，所以留尾巴不留开头
        private static string Truncate(string text) => text.Length <= 400 ? text : "…" + text[^400..];
    }

    // ---------- 任务跟踪 ----------

    private CancellationTokenSource? Track(int requestId)
    {
        if (requestId == 0) return null;
        lock (_gate)
        {
            if (_running.ContainsKey(requestId)) return null;
            var cts = new CancellationTokenSource();
            _running[requestId] = cts;
            return cts;
        }
    }

    private void Untrack(int requestId)
    {
        lock (_gate)
        {
            if (_running.Remove(requestId, out var cts)) cts.Dispose();
        }
    }

    public void Cancel(int requestId)
    {
        lock (_gate)
        {
            if (_running.TryGetValue(requestId, out var cts)) cts.Cancel();
        }
    }

    private void Fail(int requestId, string message, Action<JsonObject> post)
    {
        _lastError = message;
        post(new JsonObject
        {
            ["event"] = "asrError",
            ["requestId"] = requestId,
            ["message"] = message,
        });
    }

    /// <summary>启动时清掉上次崩溃留下的分块与录音</summary>
    public static void CleanupOlderThan(int days = 1)
    {
        try
        {
            if (!Directory.Exists(MeetDir)) return;
            var cutoff = DateTime.UtcNow.AddDays(-days);
            foreach (var path in Directory.EnumerateFileSystemEntries(MeetDir))
            {
                try
                {
                    if (Directory.GetLastWriteTimeUtc(path) >= cutoff) continue;
                    if (Directory.Exists(path)) Directory.Delete(path, true);
                    else File.Delete(path);
                }
                catch
                {
                    // 正在使用的录音留到下次
                }
            }
        }
        catch
        {
            // 清理是尽力而为
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var cts in _running.Values) cts.Cancel();
            _running.Clear();
            foreach (var stream in _audioStreams.Values)
            {
                try
                {
                    stream.Dispose();
                }
                catch
                {
                    // 忽略清理异常
                }
            }
            _audioStreams.Clear();
        }
    }
}
