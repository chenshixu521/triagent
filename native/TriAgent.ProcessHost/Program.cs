using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace TriAgent.ProcessHost;

/// <summary>
/// Windows Job Object process host.
/// Stays outside the target Job, owns the only non-inheritable Job handle,
/// creates the target suspended, assigns it, then resumes. Fail closed on any
/// create/assign/resume error. Never falls back to unmanaged execution.
/// </summary>
internal static class Program
{
    private static readonly object EmitLock = new();
    private static readonly Encoding Utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

    private static WindowsJob? _job;
    private static TargetProcess? _target;
    private static string? _activeAttemptId;
    private static volatile bool _stopping;
    private static volatile bool _exitedEmitted;
    private static string _exitReason = "exited";

    private static int Main()
    {
        // Binary-safe control channel on stdin/stdout (UTF-8 JSONL).
        Console.InputEncoding = Utf8NoBom;
        Console.OutputEncoding = Utf8NoBom;
        Console.Error.WriteLine("triagent-process-host ready");

        try
        {
            string? line;
            while ((line = Console.In.ReadLine()) is not null)
            {
                HandleLine(line);
            }
        }
        catch (Exception ex)
        {
            EmitError($"host_fatal: {ex.Message}");
            return 2;
        }
        finally
        {
            // Closing the Job handle with KILL_ON_JOB_CLOSE terminates the tree.
            CleanupAll();
        }

        return 0;
    }

    private static void HandleLine(string line)
    {
        HostCommand? command;
        try
        {
            command = Protocol.ParseCommand(line);
        }
        catch (JsonException ex)
        {
            EmitError($"invalid_json: {ex.Message}");
            return;
        }

        if (command is null)
        {
            EmitError("unknown_or_empty_command");
            return;
        }

        switch (command)
        {
            case StartCommand start:
                HandleStart(start);
                break;
            case StopCommand stop:
                HandleStop(stop);
                break;
            default:
                EmitError($"unsupported_command: {command.Type}");
                break;
        }
    }

    private static void HandleStart(StartCommand command)
    {
        if (_target is not null)
        {
            Emit(Protocol.StartFailed(command.AttemptId, "a target is already running in this host"));
            return;
        }

        _activeAttemptId = command.AttemptId;
        _stopping = false;
        _exitedEmitted = false;
        _exitReason = "exited";

        try
        {
            _job = new WindowsJob();
            _job.CreateWithKillOnClose();

            _target = TargetProcess.CreateSuspended(
                command.Command,
                command.Args ?? [],
                command.Cwd,
                command.Env);

            try
            {
                _job.AssignProcess(_target.ProcessHandle);
            }
            catch (Exception ex)
            {
                // Nested job / parent-job unsupported: fail closed, never unmanaged.
                _target.TerminateSuspended();
                _target.Dispose();
                _target = null;
                _job.Dispose();
                _job = null;
                Emit(Protocol.StartFailed(
                    command.AttemptId,
                    $"assign_failed: {ex.Message}"));
                return;
            }

            try
            {
                _target.Resume();
            }
            catch (Exception ex)
            {
                _target.TerminateSuspended();
                _target.Dispose();
                _target = null;
                _job.Dispose();
                _job = null;
                Emit(Protocol.StartFailed(
                    command.AttemptId,
                    $"resume_failed: {ex.Message}"));
                return;
            }

            // Drain stdout/stderr immediately after resume so a child that
            // fills the output pipe before reading stdin cannot deadlock.
            // Stdin is delivered concurrently (bounded payload) so the control
            // loop remains free to process stop while WriteFile may block.
            _target.BeginOutputRelay(
                onStdout: bytes =>
                {
                    if (_activeAttemptId is null) return;
                    Emit(Protocol.Stdout(_activeAttemptId, Convert.ToBase64String(bytes)));
                },
                onStderr: bytes =>
                {
                    if (_activeAttemptId is null) return;
                    Emit(Protocol.Stderr(_activeAttemptId, Convert.ToBase64String(bytes)));
                });

            var startedAt = DateTime.UtcNow.ToString("o");
            var startFileTime = _target.CreationFileTime;
            Emit(Protocol.Started(
                command.AttemptId,
                _target.ProcessId,
                startedAt,
                startFileTime));

            // Concurrent one-shot stdin delivery. Never log payload.
            // On write/decode failure: terminate tree and fail closed.
            var attemptIdForStdin = command.AttemptId;
            _ = Task.Run(() =>
            {
                try
                {
                    DeliverTargetStdin(command);
                }
                catch (Exception ex)
                {
                    FailClosedAfterStdinError(attemptIdForStdin, ex.Message);
                }
            });

            _ = Task.Run(() => WatchTargetExit(command.AttemptId));
        }
        catch (Exception ex)
        {
            try
            {
                _target?.TerminateSuspended();
            }
            catch
            {
                // ignore
            }

            _target?.Dispose();
            _target = null;
            _job?.Dispose();
            _job = null;
            Emit(Protocol.StartFailed(command.AttemptId, $"start_failed: {ex.Message}"));
        }
    }

    /// <summary>
    /// Decode optional base64 stdin, write exact bytes to target, then close.
    /// Payload content is never emitted to logs/events.
    /// Called from a background task so stdout/stderr relays can drain concurrently.
    /// </summary>
    private static void DeliverTargetStdin(StartCommand command)
    {
        var target = _target;
        if (target is null)
        {
            return;
        }

        var closeAfter = command.StdinCloseAfterWrite ?? true;
        byte[]? payload = null;

        if (!string.IsNullOrEmpty(command.StdinBase64))
        {
            try
            {
                payload = Convert.FromBase64String(command.StdinBase64);
            }
            catch (FormatException)
            {
                throw new InvalidOperationException("stdin base64 is invalid");
            }

            if (payload.Length > StartCommand.MaxStdinBytes)
            {
                throw new InvalidOperationException(
                    $"stdin payload too large: {payload.Length} exceeds {StartCommand.MaxStdinBytes}");
            }
        }

        if (payload is { Length: > 0 })
        {
            target.WriteStdin(payload);
        }

        if (closeAfter)
        {
            target.CloseStdin();
        }
    }

    /// <summary>
    /// Fail closed when concurrent stdin delivery fails after the target was resumed.
    /// Terminates the job tree, emits cleanup_failed, and leaves exit handling to WatchTargetExit.
    /// </summary>
    private static void FailClosedAfterStdinError(string attemptId, string message)
    {
        try
        {
            _job?.Terminate(1);
        }
        catch
        {
            // ignore
        }

        try
        {
            _target?.CloseStdin();
        }
        catch
        {
            // ignore
        }

        Emit(Protocol.CleanupFailed(
            attemptId,
            "force_stop",
            $"stdin delivery failed: {message}"));
    }

    private static void HandleStop(StopCommand command)
    {
        if (_target is null || _job is null || _activeAttemptId is null)
        {
            return;
        }

        if (command.AttemptId is not null
            && !string.Equals(command.AttemptId, _activeAttemptId, StringComparison.Ordinal))
        {
            return;
        }

        var mode = command.Mode?.Trim().ToLowerInvariant() ?? "force";
        if (mode is "graceful")
        {
            _exitReason = "graceful_stop";
            _stopping = true;
            try
            {
                // Cooperative: close target stdin (many CLIs exit) and try CTRL-break-less terminate of root only
                // via GenerateConsoleCtrlEvent is unreliable without a console. Prefer closing stdin + short wait
                // then force. On Windows Node, SIGTERM is not delivered; force path is authoritative.
                _target.CloseStdin();
            }
            catch
            {
                // ignore
            }

            var graceMs = command.GraceMs is > 0 and <= 120_000 ? command.GraceMs.Value : 5_000;
            _ = Task.Run(async () =>
            {
                await Task.Delay(graceMs).ConfigureAwait(false);
                if (_exitedEmitted) return;
                ForceStopTree("force_stop");
            });
            return;
        }

        ForceStopTree("force_stop");
    }

    private static void ForceStopTree(string reason)
    {
        if (_job is null || _activeAttemptId is null)
        {
            return;
        }

        _stopping = true;
        _exitReason = reason;
        try
        {
            _job.Terminate(1);
        }
        catch (Exception ex)
        {
            Emit(Protocol.CleanupFailed(_activeAttemptId, "force_stop", ex.Message));
            return;
        }

        // Wait for job to empty (kill-on-close / terminate).
        var deadline = Environment.TickCount64 + 15_000;
        while (Environment.TickCount64 < deadline)
        {
            if (_job.IsEmpty())
            {
                EmitTreeCleanAndExitIfNeeded("force_stop");
                return;
            }

            Thread.Sleep(25);
        }

        if (_job.IsEmpty())
        {
            EmitTreeCleanAndExitIfNeeded("force_stop");
            return;
        }

        Emit(Protocol.CleanupFailed(
            _activeAttemptId,
            "force_stop",
            "job still has active processes after TerminateJobObject"));
    }

    private static void WatchTargetExit(string attemptId)
    {
        try
        {
            _target?.WaitForExit();
            var exitCode = _target?.GetExitCode();
            // Wait for descendants: job may still hold children briefly.
            var deadline = Environment.TickCount64 + 15_000;
            while (Environment.TickCount64 < deadline)
            {
                if (_job is null || _job.IsEmpty())
                {
                    break;
                }

                Thread.Sleep(25);
            }

            if (_job is not null && !_job.IsEmpty())
            {
                // Natural root exit but tree not empty — force the remainder.
                try
                {
                    _job.Terminate(1);
                }
                catch
                {
                    // ignore
                }

                deadline = Environment.TickCount64 + 10_000;
                while (Environment.TickCount64 < deadline)
                {
                    if (_job.IsEmpty()) break;
                    Thread.Sleep(25);
                }
            }

            lock (EmitLock)
            {
                if (_exitedEmitted) return;
                _exitedEmitted = true;
                var pid = _target?.ProcessId ?? 0;
                var reason = _exitReason;
                if (_job is null || _job.IsEmpty())
                {
                    EmitUnlocked(Protocol.TreeClean(attemptId, reason is "force_stop" or "graceful_stop" ? reason : "natural"));
                    EmitUnlocked(Protocol.Exited(attemptId, pid, exitCode is null ? null : unchecked((int)exitCode.Value), reason));
                }
                else
                {
                    EmitUnlocked(Protocol.CleanupFailed(
                        attemptId,
                        reason is "force_stop" ? "force_stop" : "graceful_stop",
                        "target exited but job tree is not empty"));
                    EmitUnlocked(Protocol.Exited(attemptId, pid, exitCode is null ? null : unchecked((int)exitCode.Value), reason));
                }
            }
        }
        catch (Exception ex)
        {
            if (_activeAttemptId is not null)
            {
                Emit(Protocol.CleanupFailed(_activeAttemptId, "watch", ex.Message));
            }
        }
    }

    private static void EmitTreeCleanAndExitIfNeeded(string operation)
    {
        if (_activeAttemptId is null) return;
        lock (EmitLock)
        {
            if (_exitedEmitted) return;
            // Root may still be winding down; wait briefly for process handle.
            _target?.WaitForExit(2_000);
            var exitCode = _target?.GetExitCode();
            var pid = _target?.ProcessId ?? 0;
            _exitedEmitted = true;
            EmitUnlocked(Protocol.TreeClean(_activeAttemptId, operation));
            EmitUnlocked(Protocol.Exited(
                _activeAttemptId,
                pid,
                exitCode is null ? null : unchecked((int)exitCode.Value),
                operation is "force_stop" ? "force_stop" : "graceful_stop"));
        }
    }

    private static void CleanupAll()
    {
        try
        {
            _target?.Dispose();
        }
        catch
        {
            // ignore
        }

        _target = null;
        try
        {
            _job?.Dispose();
        }
        catch
        {
            // ignore
        }

        _job = null;
    }

    private static void Emit(object payload)
    {
        lock (EmitLock)
        {
            EmitUnlocked(payload);
        }
    }

    private static void EmitUnlocked(object payload)
    {
        var json = Protocol.EncodeEvent(payload);
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    private static void EmitError(string message)
    {
        Emit(new { type = "host_error", error = message });
    }
}

/// <summary>
/// Target process created via CreateProcessW(CREATE_SUSPENDED) with
/// STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_HANDLE_LIST so only stdio inherits.
/// </summary>
internal sealed class TargetProcess : IDisposable
{
    private IntPtr _processHandle = IntPtr.Zero;
    private IntPtr _threadHandle = IntPtr.Zero;
    private IntPtr _stdinWrite = IntPtr.Zero;
    private IntPtr _stdoutRead = IntPtr.Zero;
    private IntPtr _stderrRead = IntPtr.Zero;
    private bool _disposed;
    private CancellationTokenSource? _relayCts;

    public int ProcessId { get; private set; }
    public long CreationFileTime { get; private set; }
    public IntPtr ProcessHandle => _processHandle;

    public static TargetProcess CreateSuspended(
        string command,
        string[] args,
        string cwd,
        Dictionary<string, string>? env)
    {
        var target = new TargetProcess();
        try
        {
            target.CreateCore(command, args, cwd, env);
            return target;
        }
        catch
        {
            target.Dispose();
            throw;
        }
    }

    private void CreateCore(
        string command,
        string[] args,
        string cwd,
        Dictionary<string, string>? env)
    {
        // Pipes: child ends inheritable, parent ends NOT inheritable.
        CreateInheritablePipe(out var stdinRead, out _stdinWrite, parentIsWrite: true);
        CreateInheritablePipe(out _stdoutRead, out var stdoutWrite, parentIsWrite: false);
        CreateInheritablePipe(out _stderrRead, out var stderrWrite, parentIsWrite: false);

        // Attribute list with only the three child-side stdio handles.
        var inheritHandles = new[] { stdinRead, stdoutWrite, stderrWrite };
        var attributeList = IntPtr.Zero;
        var handleListPtr = IntPtr.Zero;
        IntPtr size = IntPtr.Zero;

        if (!NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size)
            && Marshal.GetLastWin32Error() != 122 /* ERROR_INSUFFICIENT_BUFFER */)
        {
            CloseHandleSafe(stdinRead);
            CloseHandleSafe(stdoutWrite);
            CloseHandleSafe(stderrWrite);
            throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList(size) failed");
        }

        attributeList = Marshal.AllocHGlobal(size);
        if (!NativeMethods.InitializeProcThreadAttributeList(attributeList, 1, 0, ref size))
        {
            var error = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(attributeList);
            CloseHandleSafe(stdinRead);
            CloseHandleSafe(stdoutWrite);
            CloseHandleSafe(stderrWrite);
            throw new Win32Exception(error, "InitializeProcThreadAttributeList failed");
        }

        handleListPtr = Marshal.AllocHGlobal(IntPtr.Size * inheritHandles.Length);
        for (var i = 0; i < inheritHandles.Length; i++)
        {
            Marshal.WriteIntPtr(handleListPtr, i * IntPtr.Size, inheritHandles[i]);
        }

        if (!NativeMethods.UpdateProcThreadAttribute(
                attributeList,
                0,
                (IntPtr)NativeMethods.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handleListPtr,
                (IntPtr)(IntPtr.Size * inheritHandles.Length),
                IntPtr.Zero,
                IntPtr.Zero))
        {
            var error = Marshal.GetLastWin32Error();
            NativeMethods.DeleteProcThreadAttributeList(attributeList);
            Marshal.FreeHGlobal(attributeList);
            Marshal.FreeHGlobal(handleListPtr);
            CloseHandleSafe(stdinRead);
            CloseHandleSafe(stdoutWrite);
            CloseHandleSafe(stderrWrite);
            throw new Win32Exception(error, "UpdateProcThreadAttribute(HANDLE_LIST) failed");
        }

        var startup = new NativeMethods.STARTUPINFOEXW
        {
            StartupInfo = new NativeMethods.STARTUPINFOW
            {
                cb = Marshal.SizeOf<NativeMethods.STARTUPINFOEXW>(),
                dwFlags = unchecked((int)NativeMethods.STARTF_USESTDHANDLES),
                hStdInput = stdinRead,
                hStdOutput = stdoutWrite,
                hStdError = stderrWrite,
            },
            lpAttributeList = attributeList,
        };

        var commandLine = BuildCommandLine(command, args);
        var environmentBlock = BuildEnvironmentBlock(env);
        var envPtr = IntPtr.Zero;
        if (environmentBlock is not null)
        {
            envPtr = Marshal.StringToHGlobalUni(environmentBlock);
        }

        var creationFlags =
            NativeMethods.CREATE_SUSPENDED
            | NativeMethods.CREATE_UNICODE_ENVIRONMENT
            | NativeMethods.EXTENDED_STARTUPINFO_PRESENT;

        NativeMethods.PROCESS_INFORMATION processInfo;
        bool created;
        try
        {
            // bInheritHandles must be true for HANDLE_LIST to apply; only listed handles inherit.
            created = NativeMethods.CreateProcessW(
                lpApplicationName: null,
                lpCommandLine: commandLine,
                lpProcessAttributes: IntPtr.Zero,
                lpThreadAttributes: IntPtr.Zero,
                bInheritHandles: true,
                dwCreationFlags: creationFlags,
                lpEnvironment: envPtr,
                lpCurrentDirectory: string.IsNullOrWhiteSpace(cwd) ? null : cwd,
                lpStartupInfo: ref startup,
                lpProcessInformation: out processInfo);
        }
        finally
        {
            if (envPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(envPtr);
            }

            NativeMethods.DeleteProcThreadAttributeList(attributeList);
            Marshal.FreeHGlobal(attributeList);
            Marshal.FreeHGlobal(handleListPtr);
            // Close child-side ends in the parent so only the child holds them.
            CloseHandleSafe(stdinRead);
            CloseHandleSafe(stdoutWrite);
            CloseHandleSafe(stderrWrite);
        }

        if (!created)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
        }

        _processHandle = processInfo.hProcess;
        _threadHandle = processInfo.hThread;
        ProcessId = processInfo.dwProcessId;

        if (!NativeMethods.GetProcessTimes(
                _processHandle,
                out var creation,
                out _,
                out _,
                out _))
        {
            // Non-fatal for start, but identity verification needs it.
            creation = 0;
        }

        CreationFileTime = creation;
    }

    public void Resume()
    {
        var previous = NativeMethods.ResumeThread(_threadHandle);
        if (previous == 0xFFFFFFFF)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
        }
    }

    public void TerminateSuspended()
    {
        if (_processHandle != IntPtr.Zero)
        {
            NativeMethods.TerminateProcess(_processHandle, 1);
        }
    }

    public void CloseStdin()
    {
        if (_stdinWrite != IntPtr.Zero)
        {
            NativeMethods.CloseHandle(_stdinWrite);
            _stdinWrite = IntPtr.Zero;
        }
    }

    /// <summary>
    /// Write exact bytes to target stdin. Does not close the handle.
    /// Throws on write failure (caller must fail closed / cleanup).
    /// </summary>
    public void WriteStdin(byte[] data)
    {
        if (data is null || data.Length == 0)
        {
            return;
        }

        if (_stdinWrite == IntPtr.Zero)
        {
            throw new InvalidOperationException("target stdin is already closed");
        }

        var offset = 0;
        while (offset < data.Length)
        {
            var remaining = data.Length - offset;
            var chunk = remaining > 64 * 1024 ? new byte[64 * 1024] : new byte[remaining];
            Buffer.BlockCopy(data, offset, chunk, 0, chunk.Length);
            if (!NativeMethods.WriteFile(
                    _stdinWrite,
                    chunk,
                    (uint)chunk.Length,
                    out var written,
                    IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WriteFile(stdin) failed");
            }

            if (written == 0)
            {
                throw new IOException("WriteFile(stdin) wrote zero bytes");
            }

            offset += (int)written;
        }
    }

    public void BeginOutputRelay(
        Action<byte[]> onStdout,
        Action<byte[]> onStderr)
    {
        _relayCts = new CancellationTokenSource();
        var token = _relayCts.Token;
        _ = Task.Run(() => RelayPipe(_stdoutRead, onStdout, token), token);
        _ = Task.Run(() => RelayPipe(_stderrRead, onStderr, token), token);
    }

    public void WaitForExit()
    {
        if (_processHandle == IntPtr.Zero) return;
        NativeMethods.WaitForSingleObject(_processHandle, NativeMethods.INFINITE);
    }

    public bool WaitForExit(uint milliseconds)
    {
        if (_processHandle == IntPtr.Zero) return true;
        var result = NativeMethods.WaitForSingleObject(_processHandle, milliseconds);
        return result == NativeMethods.WAIT_OBJECT_0;
    }

    public uint? GetExitCode()
    {
        if (_processHandle == IntPtr.Zero) return null;
        if (!NativeMethods.GetExitCodeProcess(_processHandle, out var code))
        {
            return null;
        }

        if (code == NativeMethods.STILL_ACTIVE)
        {
            return null;
        }

        return code;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            _relayCts?.Cancel();
        }
        catch
        {
            // ignore
        }

        _relayCts?.Dispose();
        CloseHandleSafe(ref _stdinWrite);
        CloseHandleSafe(ref _stdoutRead);
        CloseHandleSafe(ref _stderrRead);
        CloseHandleSafe(ref _threadHandle);
        CloseHandleSafe(ref _processHandle);
        GC.SuppressFinalize(this);
    }

    private static void RelayPipe(IntPtr readHandle, Action<byte[]> onData, CancellationToken token)
    {
        if (readHandle == IntPtr.Zero) return;
        var buffer = new byte[4096];
        while (!token.IsCancellationRequested)
        {
            if (!NativeMethods.ReadFile(
                    readHandle,
                    buffer,
                    (uint)buffer.Length,
                    out var read,
                    IntPtr.Zero))
            {
                break;
            }

            if (read == 0)
            {
                break;
            }

            var copy = new byte[read];
            Buffer.BlockCopy(buffer, 0, copy, 0, (int)read);
            try
            {
                onData(copy);
            }
            catch
            {
                // Listener failures must not stop relay / process lifetime.
            }
        }
    }

    private static void CreateInheritablePipe(
        out IntPtr readPipe,
        out IntPtr writePipe,
        bool parentIsWrite)
    {
        var sa = new NativeMethods.SECURITY_ATTRIBUTES
        {
            nLength = Marshal.SizeOf<NativeMethods.SECURITY_ATTRIBUTES>(),
            lpSecurityDescriptor = IntPtr.Zero,
            bInheritHandle = 1,
        };

        if (!NativeMethods.CreatePipe(out readPipe, out writePipe, ref sa, 0))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe failed");
        }

        // Parent end must NOT be inheritable so HANDLE_LIST is the only inheritance path
        // and Job/control handles never leak to the child.
        var parentEnd = parentIsWrite ? writePipe : readPipe;
        if (!NativeMethods.SetHandleInformation(
                parentEnd,
                NativeMethods.HANDLE_FLAG_INHERIT,
                0))
        {
            var error = Marshal.GetLastWin32Error();
            CloseHandleSafe(readPipe);
            CloseHandleSafe(writePipe);
            throw new Win32Exception(error, "SetHandleInformation(parent pipe) failed");
        }
    }

    private static string BuildCommandLine(string command, string[] args)
    {
        var builder = new StringBuilder();
        builder.Append(QuoteArgument(command));
        foreach (var arg in args)
        {
            builder.Append(' ');
            builder.Append(QuoteArgument(arg));
        }

        return builder.ToString();
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length == 0)
        {
            return "\"\"";
        }

        var needsQuotes = false;
        foreach (var ch in argument)
        {
            if (ch is ' ' or '\t' or '"')
            {
                needsQuotes = true;
                break;
            }
        }

        if (!needsQuotes)
        {
            return argument;
        }

        var builder = new StringBuilder();
        builder.Append('"');
        var backslashes = 0;
        foreach (var ch in argument)
        {
            if (ch == '\\')
            {
                backslashes += 1;
                continue;
            }

            if (ch == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }

            if (backslashes > 0)
            {
                builder.Append('\\', backslashes);
                backslashes = 0;
            }

            builder.Append(ch);
        }

        if (backslashes > 0)
        {
            builder.Append('\\', backslashes * 2);
        }

        builder.Append('"');
        return builder.ToString();
    }

    private static string? BuildEnvironmentBlock(Dictionary<string, string>? overrides)
    {
        // Merge current environment with overrides (override wins).
        var map = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            var key = entry.Key?.ToString();
            var value = entry.Value?.ToString();
            if (key is null || value is null) continue;
            map[key] = value;
        }

        if (overrides is not null)
        {
            foreach (var pair in overrides)
            {
                map[pair.Key] = pair.Value;
            }
        }

        var builder = new StringBuilder();
        foreach (var pair in map)
        {
            builder.Append(pair.Key);
            builder.Append('=');
            builder.Append(pair.Value);
            builder.Append('\0');
        }

        builder.Append('\0');
        return builder.ToString();
    }

    private static void CloseHandleSafe(IntPtr handle)
    {
        if (handle != IntPtr.Zero)
        {
            NativeMethods.CloseHandle(handle);
        }
    }

    private static void CloseHandleSafe(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero)
        {
            NativeMethods.CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }
}

