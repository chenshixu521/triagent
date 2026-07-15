using System.Text.Json;
using System.Text.Json.Serialization;

namespace TriAgent.ProcessHost;

/// <summary>
/// JSONL control protocol between Node ProcessHost client and this helper.
/// Arbitrary target stdout/stderr is base64-encoded so binary/control bytes
/// cannot corrupt the line-delimited control channel.
/// </summary>
internal static class Protocol
{
    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    internal static HostCommand? ParseCommand(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return null;
        }

        using var document = JsonDocument.Parse(line);
        if (!document.RootElement.TryGetProperty("type", out var typeElement))
        {
            return null;
        }

        var type = typeElement.GetString();
        return type switch
        {
            "start" => JsonSerializer.Deserialize<StartCommand>(line, JsonOptions),
            "stop" => JsonSerializer.Deserialize<StopCommand>(line, JsonOptions),
            // Target stdin is delivered only via StartCommand.stdinBase64 (one-shot).
            _ => null,
        };
    }

    internal static string EncodeEvent(object payload)
        => JsonSerializer.Serialize(payload, JsonOptions);

    internal static object Started(string attemptId, int pid, string startedAtIso, long startTimeFileTime)
        => new
        {
            type = "started",
            attemptId,
            pid,
            startedAt = startedAtIso,
            startTimeFileTime,
        };

    internal static object Stdout(string attemptId, string dataBase64)
        => new
        {
            type = "stdout",
            attemptId,
            encoding = "base64",
            data = dataBase64,
        };

    internal static object Stderr(string attemptId, string dataBase64)
        => new
        {
            type = "stderr",
            attemptId,
            encoding = "base64",
            data = dataBase64,
        };

    internal static object Exited(
        string attemptId,
        int pid,
        int? exitCode,
        string reason)
        => new
        {
            type = "exited",
            attemptId,
            pid,
            exitCode,
            signal = (string?)null,
            reason,
        };

    internal static object TreeClean(string attemptId, string operation)
        => new
        {
            type = "tree_clean",
            attemptId,
            operation,
        };

    internal static object CleanupFailed(string attemptId, string operation, string error)
        => new
        {
            type = "cleanup_failed",
            attemptId,
            operation,
            error,
        };

    internal static object StartFailed(string attemptId, string error)
        => new
        {
            type = "start_failed",
            attemptId,
            error,
        };
}

internal abstract class HostCommand
{
    [JsonPropertyName("type")]
    public required string Type { get; init; }
}

internal sealed class StartCommand : HostCommand
{
    /// <summary>Hard bound for one-shot target stdin (512 KiB decoded).</summary>
    internal const int MaxStdinBytes = 512 * 1024;

    [JsonPropertyName("attemptId")]
    public required string AttemptId { get; init; }

    [JsonPropertyName("command")]
    public required string Command { get; init; }

    [JsonPropertyName("args")]
    public string[] Args { get; init; } = [];

    [JsonPropertyName("cwd")]
    public required string Cwd { get; init; }

    [JsonPropertyName("env")]
    public Dictionary<string, string>? Env { get; init; }

    /// <summary>
    /// Optional one-shot target stdin as base64. Written after resume, then
    /// stdin is closed. Never logged. Bound to <see cref="MaxStdinBytes"/>.
    /// </summary>
    [JsonPropertyName("stdinBase64")]
    public string? StdinBase64 { get; init; }

    /// <summary>When true (default), close target stdin after writing payload.</summary>
    [JsonPropertyName("stdinCloseAfterWrite")]
    public bool? StdinCloseAfterWrite { get; init; }
}

internal sealed class StopCommand : HostCommand
{
    [JsonPropertyName("mode")]
    public required string Mode { get; init; }

    [JsonPropertyName("graceMs")]
    public int? GraceMs { get; init; }

    [JsonPropertyName("attemptId")]
    public string? AttemptId { get; init; }
}
