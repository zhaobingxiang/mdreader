using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace MdReader;

internal sealed record AiChatRequest(
    int RequestId,
    string BaseUrl,
    string Model,
    JsonArray Messages,
    JsonArray? Tools,
    string ThinkingParam,
    bool DeepThinking,
    int MaxTokens,
    string? FallbackModel = null);

/// <summary>JsonNode 深拷贝：走一次序列化，避免同一个节点被两棵父树同时持有</summary>
internal static class JsonClone
{
    public static T Clone<T>(JsonNode node) where T : JsonNode => (T)JsonNode.Parse(node.ToJsonString())!;
}

/// <summary>网关繁忙 / 临时故障：退避后可以再试一次</summary>
internal sealed class AiRetryableException : Exception
{
    public AiRetryableException(string message, int retryAfterMs = 0) : base(message)
    {
        RetryAfterMs = retryAfterMs;
    }

    public int RetryAfterMs { get; }
}

/// <summary>网关不认识这个模型 id：换个模型再试一次，而不是把它当成普通失败</summary>
internal sealed class AiModelUnavailableException : Exception
{
    public AiModelUnavailableException(string message) : base(message)
    {
    }
}

/// <summary>
/// OpenAI 兼容的流式客户端。
///
/// 请求体与 SSE 解析都在宿主做：页面跑在 https://mdreader.local，
/// 直连第三方网关会被 CORS 拦住，密钥也不该进页面内存。
/// 流式分片按 40ms 合并推送，避免 WebView2 消息通道被 token 级事件淹掉。
/// </summary>
internal sealed class AiClient : IDisposable
{
    private const int FirstByteTimeoutMs = 120_000;
    private const int IdleTimeoutMs = 180_000;
    private const int FlushIntervalMs = 40;
    private const int MaxAttempts = 3;

    private static readonly HttpClient Http = CreateHttp();

    private readonly Dictionary<int, CancellationTokenSource> _running = new();
    private readonly object _gate = new();

    private static HttpClient CreateHttp()
    {
        var handler = new SocketsHttpHandler
        {
            ConnectTimeout = TimeSpan.FromSeconds(20),
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        };
        // Proxy 留空 = 走系统代理；内网地址由 .NET 的绕过规则直连
        return new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public void Start(AiChatRequest request, string apiKey, Action<JsonObject> post)
    {
        var cts = new CancellationTokenSource();
        lock (_gate)
        {
            if (_running.ContainsKey(request.RequestId))
            {
                cts.Dispose();
                return;
            }
            _running[request.RequestId] = cts;
        }
        _ = Task.Run(() => RunAsync(request, apiKey, post, cts));
    }

    public void Cancel(int requestId)
    {
        lock (_gate)
        {
            if (_running.TryGetValue(requestId, out var cts)) cts.Cancel();
        }
    }

    private async Task RunAsync(AiChatRequest request, string apiKey, Action<JsonObject> post, CancellationTokenSource cts)
    {
        var ct = cts.Token;
        try
        {
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    await SendOnceAsync(request, apiKey, post, ct);
                    return;
                }
                catch (AiRetryableException ex) when (attempt < MaxAttempts)
                {
                    var delay = ex.RetryAfterMs > 0 ? ex.RetryAfterMs : attempt * 2500;
                    post(new JsonObject
                    {
                        ["event"] = "aiRetry",
                        ["requestId"] = request.RequestId,
                        ["attempt"] = attempt,
                        ["delayMs"] = delay,
                        ["message"] = ex.Message,
                    });
                    await Task.Delay(delay, ct);
                }
                catch (AiModelUnavailableException) when (
                    attempt < MaxAttempts &&
                    request.FallbackModel is { Length: > 0 } fallback &&
                    fallback != request.Model)
                {
                    var from = request.Model;
                    request = request with { Model = fallback };
                    post(new JsonObject
                    {
                        ["event"] = "aiModelFallback",
                        ["requestId"] = request.RequestId,
                        ["from"] = from,
                        ["to"] = fallback,
                    });
                }
            }
        }
        catch (OperationCanceledException)
        {
            post(new JsonObject
            {
                ["event"] = "aiDone",
                ["requestId"] = request.RequestId,
                ["cancelled"] = true,
            });
        }
        catch (Exception ex)
        {
            post(new JsonObject
            {
                ["event"] = "aiError",
                ["requestId"] = request.RequestId,
                ["message"] = ex.Message,
            });
        }
        finally
        {
            lock (_gate)
            {
                _running.Remove(request.RequestId);
            }
            cts.Dispose();
        }
    }

    private static async Task SendOnceAsync(
        AiChatRequest request,
        string apiKey,
        Action<JsonObject> post,
        CancellationToken ct)
    {
        var url = BuildUrl(request.BaseUrl);
        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, url);
        httpRequest.Headers.TryAddWithoutValidation("Authorization", "Bearer " + apiKey);
        httpRequest.Headers.TryAddWithoutValidation("Accept", "text/event-stream");
        httpRequest.Content = new StringContent(
            BuildBody(request).ToJsonString(),
            Encoding.UTF8,
            "application/json");

        using var attemptCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        attemptCts.CancelAfter(FirstByteTimeoutMs);

        HttpResponseMessage response;
        try
        {
            response = await Http.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, attemptCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new AiRetryableException("连接超时，网关没有响应");
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                var body = await ReadCappedAsync(response, attemptCts.Token);
                var status = (int)response.StatusCode;
                var message = DescribeError(status, body);
                var unavailable = IsModelUnavailable(status, body);
                if (unavailable)
                {
                    throw new AiModelUnavailableException(DescribeModelUnavailable(body));
                }
                if (status is 408 or 429 || status >= 500)
                {
                    throw new AiRetryableException(message, RetryAfterMs(response));
                }
                throw new InvalidOperationException(message);
            }

            var state = new StreamState();
            var firstByte = true;

            using var stream = await response.Content.ReadAsStreamAsync(attemptCts.Token);
            using var idleCts = CancellationTokenSource.CreateLinkedTokenSource(ct);

            void Flush(bool force)
            {
                var now = Environment.TickCount64;
                if (!force && now - state.LastFlush < FlushIntervalMs) return;
                if (state.Content.Length > 0)
                {
                    post(new JsonObject
                    {
                        ["event"] = "aiDelta",
                        ["requestId"] = request.RequestId,
                        ["kind"] = "content",
                        ["text"] = state.Content.ToString(),
                    });
                    state.Content.Clear();
                }
                if (state.Reasoning.Length > 0)
                {
                    post(new JsonObject
                    {
                        ["event"] = "aiDelta",
                        ["requestId"] = request.RequestId,
                        ["kind"] = "reasoning",
                        ["text"] = state.Reasoning.ToString(),
                    });
                    state.Reasoning.Clear();
                }
                state.LastFlush = now;
            }

            await PumpLinesAsync(
                stream,
                idleCts,
                ct,
                firstByte,
                line =>
                {
                    firstByte = false;
                    if (line.Length == 0 || line.StartsWith(':')) return;

                    if (line.StartsWith("event:", StringComparison.Ordinal)) return;
                    if (!line.StartsWith("data:", StringComparison.Ordinal) &&
                        !line.StartsWith('{'))
                    {
                        return;
                    }

                    var payload = line.StartsWith("data:", StringComparison.Ordinal)
                        ? line[5..].Trim()
                        : line.Trim();
                    if (payload.Length == 0) return;
                    if (payload == "[DONE]") return;

                    JsonObject? node;
                    try
                    {
                        node = JsonNode.Parse(payload) as JsonObject;
                    }
                    catch
                    {
                        return;
                    }
                    if (node == null) return;

                    if (node["error"] is { } error)
                    {
                        throw new InvalidOperationException(DescribePayloadError(error));
                    }

                    // 部分网关忽略 stream:true 直接回完整 JSON
                    // （末尾可能还有 choices 为空的 usage 帧，不能直接取 [0]）
                    if (node["choices"] is JsonArray { Count: > 0 } nonStream &&
                        nonStream[0]?["message"] is JsonObject message)
                    {
                        state.ConsumeFull(message);
                        if (nonStream[0]?["finish_reason"] != null)
                        {
                            state.FinishReason = nonStream[0]!["finish_reason"]!.GetValue<string>();
                        }
                        if (node["usage"] is JsonObject fullUsage) state.Usage = JsonClone.Clone<JsonObject>(fullUsage);
                        return;
                    }

                    state.ConsumeChunk(node);
                    Flush(false);
                });

            Flush(true);

            foreach (var (index, tool) in state.Tools)
            {
                post(new JsonObject
                {
                    ["event"] = "aiToolCall",
                    ["requestId"] = request.RequestId,
                    ["index"] = index,
                    ["id"] = tool.Id,
                    ["name"] = tool.Name,
                    ["arguments"] = tool.Args.ToString(),
                });
            }

            post(new JsonObject
            {
                ["event"] = "aiDone",
                ["requestId"] = request.RequestId,
                ["cancelled"] = false,
                ["finishReason"] = state.FinishReason,
                ["usage"] = state.Usage,
            });
        }
    }

    /// <summary>逐行读 SSE。idleCts 在每次拿到数据后重置，超时即视为网关卡死</summary>
    private static async Task PumpLinesAsync(
        Stream stream,
        CancellationTokenSource idleCts,
        CancellationToken userToken,
        bool firstByte,
        Action<string> onLine)
    {
        var buffer = new byte[8192];
        var chars = new char[8192];
        var decoder = Encoding.UTF8.GetDecoder();
        var pending = new StringBuilder();

        while (true)
        {
            idleCts.CancelAfter(firstByte ? FirstByteTimeoutMs : IdleTimeoutMs);

            int read;
            try
            {
                read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), idleCts.Token);
            }
            catch (OperationCanceledException) when (!userToken.IsCancellationRequested)
            {
                throw new AiRetryableException("等待响应超时");
            }

            if (read == 0) break;
            firstByte = false;

            var count = decoder.GetChars(buffer, 0, read, chars, 0);
            pending.Append(chars, 0, count);

            while (true)
            {
                var text = pending.ToString();
                var index = text.IndexOf('\n');
                if (index < 0) break;
                var line = text[..index].TrimEnd('\r');
                pending.Remove(0, index + 1);
                onLine(line);
            }
        }

        if (pending.Length > 0) onLine(pending.ToString().TrimEnd('\r'));
    }

    public async Task<JsonObject> ListModelsAsync(string baseUrl, string apiKey)
    {
        var url = baseUrl.TrimEnd('/') + "/models";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + apiKey);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        using var response = await Http.SendAsync(request, cts.Token);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return new JsonObject { ["unsupported"] = true };
        }
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"拉取模型列表失败（HTTP {(int)response.StatusCode}）");
        }

        var body = await response.Content.ReadAsStringAsync(cts.Token);
        var models = new JsonArray();
        if (JsonNode.Parse(body) is JsonObject obj && obj["data"] is JsonArray data)
        {
            foreach (var item in data)
            {
                if (item is JsonObject entry &&
                    entry["id"]?.GetValue<string>() is { Length: > 0 } id)
                {
                    models.Add(id);
                }
            }
        }
        return new JsonObject { ["models"] = models };
    }

    private static JsonObject BuildBody(AiChatRequest request)
    {
        var body = new JsonObject
        {
            ["model"] = request.Model,
            ["messages"] = NormalizeMessages(request.Messages),
            ["stream"] = true,
            ["max_tokens"] = Math.Clamp(request.MaxTokens, 256, 65_536),
        };
        if (request.Tools is { Count: > 0 }) body["tools"] = JsonClone.Clone<JsonArray>(request.Tools);

        if (request.DeepThinking)
        {
            switch (request.ThinkingParam)
            {
                case "chat_template":
                    body["chat_template_kwargs"] = new JsonObject { ["enable_thinking"] = true };
                    break;
                case "reasoning_effort":
                    body["reasoning_effort"] = "high";
                    break;
            }
        }
        return body;
    }

    /// <summary>
    /// 页面里的工具调用是 {id, name, arguments} 的简化结构，回放历史时要换成
    /// OpenAI 线格式 {id, type:"function", function:{name, arguments}}；
    /// 网关会校验缺字段，MaaS 直接 400 拒绝带 tool_calls 的后续请求。
    /// </summary>
    private static JsonArray NormalizeMessages(JsonArray messages)
    {
        var output = new JsonArray();
        foreach (var item in messages)
        {
            if (item is not JsonObject source)
            {
                continue;
            }
            var message = JsonClone.Clone<JsonObject>(source);
            if (message["tool_calls"] is not JsonArray calls)
            {
                output.Add(message);
                continue;
            }
            var normalized = new JsonArray();
            foreach (var call in calls)
            {
                if (call is not JsonObject entry)
                {
                    continue;
                }
                if (entry["function"] is JsonObject)
                {
                    normalized.Add(JsonClone.Clone<JsonObject>(entry));
                    continue;
                }
                normalized.Add(new JsonObject
                {
                    ["id"] = entry["id"]?.GetValue<string>() ?? string.Empty,
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = entry["name"]?.GetValue<string>() ?? string.Empty,
                        ["arguments"] = entry["arguments"]?.GetValue<string>() ?? "{}",
                    },
                });
            }
            message["tool_calls"] = normalized;
            message["content"] ??= string.Empty;
            output.Add(message);
        }
        return output;
    }

    private static string BuildUrl(string baseUrl)
    {
        var trimmed = baseUrl.Trim().TrimEnd('/');
        return trimmed.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase)
            ? trimmed
            : trimmed + "/chat/completions";
    }

    private static async Task<string> ReadCappedAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var buffer = new byte[4096];
            var read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), ct);
            return Encoding.UTF8.GetString(buffer, 0, Math.Max(read, 0));
        }
        catch
        {
            return string.Empty;
        }
    }

    private static int RetryAfterMs(HttpResponseMessage response)
    {
        var delta = response.Headers.RetryAfter?.Delta;
        return delta is { TotalMilliseconds: > 0 and < 30_000 }
            ? (int)delta.Value.TotalMilliseconds
            : 0;
    }

    /// <summary>
    /// 「模型 id 不认识」和「地址错了」都回 400/404，靠文案区分：
    /// MaaS 明确给 model_not_found / modelID 不正确，其它 OpenAI 兼容网关说
    /// "model ... not found"、"does not exist"。地址写错不会提到 model，
    /// 仍按原样报错，不去做无意义的换模型重试。
    /// </summary>
    private static bool IsModelUnavailable(int status, string body)
    {
        if (status is not (400 or 404)) return false;
        return body.Contains("model_not_found", StringComparison.OrdinalIgnoreCase) ||
               body.Contains("modelID", StringComparison.OrdinalIgnoreCase) ||
               (body.Contains("model", StringComparison.OrdinalIgnoreCase) &&
                (body.Contains("not found", StringComparison.OrdinalIgnoreCase) ||
                 body.Contains("does not exist", StringComparison.OrdinalIgnoreCase) ||
                 body.Contains("unsupported", StringComparison.OrdinalIgnoreCase) ||
                 body.Contains("不存在", StringComparison.OrdinalIgnoreCase) ||
                 body.Contains("不正确", StringComparison.OrdinalIgnoreCase)));
    }

    private static string DescribeModelUnavailable(string body)
    {
        var detail = ExtractErrorText(body);
        return detail.Length > 0 ? $"模型不可用（{detail}）" : "模型不可用";
    }

    private static string DescribeError(int status, string body)
    {
        var detail = ExtractErrorText(body);
        var prefix = status switch
        {
            400 => "请求被拒绝",
            401 or 403 => "鉴权失败，请检查 API Key",
            404 => "接口地址不正确",
            413 => "内容超出长度限制",
            429 => "网关繁忙",
            _ => $"请求失败（HTTP {status}）",
        };
        return detail.Length > 0 ? $"{prefix}：{detail}" : prefix;
    }

    private static string DescribePayloadError(JsonNode error)
    {
        if (error is JsonValue value && value.TryGetValue<string>(out var text)) return ExtractErrorText(text);
        if (error is JsonObject obj)
        {
            foreach (var key in new[] { "message", "error", "msg" })
            {
                if (obj[key] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0) return s;
            }
        }
        return "模型返回错误";
    }

    private static string ExtractErrorText(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return string.Empty;
        try
        {
            if (JsonNode.Parse(body) is JsonObject obj)
            {
                if (obj["error"] is JsonValue v && v.TryGetValue<string>(out var nested) && nested.Length > 0)
                {
                    return ExtractErrorText(nested);
                }
                foreach (var key in new[] { "message", "error", "msg" })
                {
                    if (obj[key] is JsonValue value && value.TryGetValue<string>(out var s) && s.Length > 0)
                    {
                        return Truncate(s);
                    }
                }
            }
        }
        catch
        {
            // 非 JSON 错误体，直接截断展示
        }
        return Truncate(body.Trim());
    }

    private static string Truncate(string text)
    {
        var oneLine = text.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return oneLine.Length <= 200 ? oneLine : oneLine[..200] + "…";
    }

    private sealed class ToolAccumulator
    {
        public string Id = string.Empty;
        public string Name = string.Empty;
        public readonly StringBuilder Args = new();
    }

    private sealed class StreamState
    {
        public readonly StringBuilder Content = new();
        public readonly StringBuilder Reasoning = new();
        public readonly SortedDictionary<int, ToolAccumulator> Tools = new();
        public string? FinishReason;
        public JsonObject? Usage;
        public long LastFlush = Environment.TickCount64;

        public void ConsumeChunk(JsonObject chunk)
        {
            if (chunk["usage"] is JsonObject usage) Usage = JsonClone.Clone<JsonObject>(usage);
            if (chunk["choices"] is not JsonArray { Count: > 0 } choices) return;
            if (choices[0] is not JsonObject choice) return;

            if (choice["finish_reason"] is JsonValue finish && finish.TryGetValue<string>(out var reason))
            {
                FinishReason = reason;
            }
            if (choice["delta"] is not JsonObject delta) return;

            if (TryString(delta["content"], out var content)) Content.Append(content);
            // Lanz 用 reasoning，OpenAI/DeepSeek 用 reasoning_content
            if (TryString(delta["reasoning"], out var r1)) Reasoning.Append(r1);
            if (TryString(delta["reasoning_content"], out var r2)) Reasoning.Append(r2);

            if (delta["tool_calls"] is JsonArray calls)
            {
                foreach (var item in calls)
                {
                    if (item is not JsonObject call) continue;
                    var index = call["index"]?.GetValue<int>() ?? 0;
                    if (!Tools.TryGetValue(index, out var acc))
                    {
                        acc = new ToolAccumulator();
                        Tools[index] = acc;
                    }
                    if (TryString(call["id"], out var id) && id.Length > 0) acc.Id = id;
                    if (call["function"] is JsonObject fn)
                    {
                        if (TryString(fn["name"], out var name) && name.Length > 0) acc.Name = name;
                        if (TryString(fn["arguments"], out var args)) acc.Args.Append(args);
                    }
                }
            }
        }

        public void ConsumeFull(JsonObject message)
        {
            if (TryString(message["content"], out var content)) Content.Append(content);
            if (TryString(message["reasoning"], out var r1)) Reasoning.Append(r1);
            if (TryString(message["reasoning_content"], out var r2)) Reasoning.Append(r2);

            if (message["tool_calls"] is JsonArray calls)
            {
                var index = 0;
                foreach (var item in calls)
                {
                    if (item is not JsonObject call) continue;
                    var acc = new ToolAccumulator();
                    if (TryString(call["id"], out var id)) acc.Id = id;
                    if (call["function"] is JsonObject fn)
                    {
                        if (TryString(fn["name"], out var name)) acc.Name = name;
                        if (TryString(fn["arguments"], out var args)) acc.Args.Append(args);
                    }
                    Tools[index++] = acc;
                }
            }
        }

        private static bool TryString(JsonNode? node, out string value)
        {
            value = string.Empty;
            if (node is JsonValue jsonValue && jsonValue.TryGetValue<string>(out var text) && !string.IsNullOrEmpty(text))
            {
                value = text;
                return true;
            }
            return false;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var cts in _running.Values)
            {
                try
                {
                    cts.Cancel();
                    cts.Dispose();
                }
                catch
                {
                    // 忽略清理异常
                }
            }
            _running.Clear();
        }
    }
}
