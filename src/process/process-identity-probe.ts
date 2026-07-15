import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Result of probing a PID for liveness via start-time identity.
 *
 * Fail-closed contract:
 * - `gone`: CIM confirmed no process with this PID (verified absent)
 * - `alive`: process present with a parseable start-time
 * - `probe_unavailable`: PowerShell missing, spawn failure, access denied,
 *   or other nonzero probe failure — MUST NOT be treated as process gone
 * - `probe_invalid`: probe ran but returned malformed/empty identity data
 * - `pid_reused` is decided by the caller comparing start-times
 */
export type IdentityProbeResult =
  | { readonly status: 'gone' }
  | { readonly status: 'alive'; readonly startedAt: string }
  | { readonly status: 'probe_unavailable'; readonly reason: string }
  | { readonly status: 'probe_invalid'; readonly reason: string };

/** Raw observation from a PowerShell/CIM identity probe attempt. */
export type IdentityProbeRaw =
  | {
      readonly kind: 'spawn_error';
      readonly error: Error;
    }
  | {
      readonly kind: 'close';
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
    };

/**
 * Pure interpreter for identity probe outcomes.
 * Exit code 3 is the only "verified gone" signal from our CIM script —
 * and only when the script reported a clean successful empty query (no stderr).
 * Exit 5 (and other non-3 nonzero) is probe infrastructure failure.
 */
export function interpretIdentityProbe(raw: IdentityProbeRaw): IdentityProbeResult {
  if (raw.kind === 'spawn_error') {
    return {
      status: 'probe_unavailable',
      reason: `identity probe spawn failed: ${raw.error.message}`,
    };
  }

  const exitCode = raw.exitCode;
  const stdout = raw.stdout.trim();
  const stderr = raw.stderr.trim();

  // Exit 3 = successful empty CIM result only. Ambiguous exit-3+stderr is not gone.
  if (exitCode === 3) {
    if (stderr.length > 0) {
      return {
        status: 'probe_unavailable',
        reason: `identity probe exit 3 with stderr (ambiguous, not verified gone): ${stderr.slice(0, 200)}`,
      };
    }
    return { status: 'gone' };
  }

  if (exitCode === null) {
    return {
      status: 'probe_unavailable',
      reason: 'identity probe closed without an exit code',
    };
  }

  if (exitCode !== 0) {
    const detail = stderr.length > 0 ? stderr : `exit ${String(exitCode)}`;
    return {
      status: 'probe_unavailable',
      reason: `identity probe nonzero exit: ${detail}`,
    };
  }

  if (stdout.length === 0) {
    return {
      status: 'probe_invalid',
      reason: 'identity probe returned empty stdout with exit 0',
    };
  }

  const parsed = Date.parse(stdout);
  if (!Number.isFinite(parsed)) {
    return {
      status: 'probe_invalid',
      reason: `identity probe malformed start-time: ${stdout.slice(0, 80)}`,
    };
  }

  return {
    status: 'alive',
    startedAt: new Date(parsed).toISOString(),
  };
}

export interface QueryIdentityOptions {
  /** Override powershell executable (tests inject missing / fake paths). */
  readonly powershellPath?: string;
  /** Injected runner for unit tests; production uses real spawn. */
  readonly run?: (pid: number) => Promise<IdentityProbeRaw>;
  /**
   * Per-probe timeout in milliseconds for the production PowerShell runner.
   * Short safe default; tests may override. On timeout the spawned probe is
   * killed and the raw result is spawn_error with message "identity probe timed out"
   * so interpretIdentityProbe returns probe_unavailable (never gone).
   */
  readonly timeoutMs?: number;
}

const DEFAULT_POWERSHELL = 'powershell.exe';
/** Short production default: avoid wedging supervisor identity proof. */
export const DEFAULT_IDENTITY_PROBE_TIMEOUT_MS = 3_000;

/**
 * PowerShell body used by the production identity probe.
 *
 * Exit codes (reserved):
 * - 0: process found; stdout is ISO start-time
 * - 3: successful CIM query that definitively returned no process (verified gone)
 * - 5: PowerShell/CIM command or provider error (probe_unavailable — not gone)
 *
 * Never uses -ErrorAction SilentlyContinue: suppressed failures must not
 * collapse into the same `$null` path as a genuine empty result.
 *
 * Exported so unit tests can execute the real generated script under a CIM shim.
 */
export function buildIdentityProbeScript(pid: number): string {
  const pidLiteral = String(pid);
  // Single-line -Command body. try/catch covers terminating errors; $Error
  // after a successful call covers non-terminating Write-Error / provider noise.
  // Exit 3 only when the query completed with no error records and $p is null.
  return [
    `$Error.Clear()`,
    `try {`,
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pidLiteral}" -ErrorAction Stop`,
    `} catch {`,
    `[Console]::Error.WriteLine($_.Exception.Message)`,
    `exit 5`,
    `}`,
    `if ($Error.Count -gt 0) {`,
    `[Console]::Error.WriteLine(($Error | ForEach-Object { $_.ToString() } | Select-Object -First 3) -join '; ')`,
    `exit 5`,
    `}`,
    `if ($null -eq $p) { exit 3 }`,
    `$p.CreationDate.ToUniversalTime().ToString('o')`,
  ].join('; ');
}

function defaultRun(
  pid: number,
  powershellPath: string,
  timeoutMs: number,
): Promise<IdentityProbeRaw> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;

    const complete = (raw: IdentityProbeRaw): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolve(raw);
    };

    try {
      child = spawn(
        powershellPath,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // Exit 3 = verified process missing. Any other nonzero = probe failure.
          buildIdentityProbeScript(pid),
        ],
        { windowsHide: true },
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      complete({
        kind: 'spawn_error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    const safeTimeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_IDENTITY_PROBE_TIMEOUT_MS;

    timer = setTimeout(() => {
      if (settled) return;
      try {
        // Kill only the spawned PowerShell probe process.
        child?.kill();
      } catch {
        // ignore kill races
      }
      complete({
        kind: 'spawn_error',
        error: new Error('identity probe timed out'),
      });
    }, safeTimeout);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.on('error', (error) => {
      complete({ kind: 'spawn_error', error });
    });
    child.on('close', (code) => {
      complete({
        kind: 'close',
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Probe a PID for start-time identity. Never maps probe failures to "gone".
 */
export async function queryProcessIdentity(
  pid: number,
  options: QueryIdentityOptions = {},
): Promise<IdentityProbeResult> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return {
      status: 'probe_invalid',
      reason: `invalid pid: ${String(pid)}`,
    };
  }
  const powershellPath = options.powershellPath ?? DEFAULT_POWERSHELL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IDENTITY_PROBE_TIMEOUT_MS;
  const run =
    options.run
    ?? ((targetPid) => defaultRun(targetPid, powershellPath, timeoutMs));
  const raw = await run(pid);
  return interpretIdentityProbe(raw);
}

/**
 * Compare a known identity against a live probe.
 * - matching start-time → still alive
 * - different start-time → PID reused (our identity is gone; do not kill)
 * - gone → identity dead
 * - probe error → uncertain (fail closed)
 */
export function classifyIdentityLiveness(
  expectedStartedAt: string,
  probe: IdentityProbeResult,
  toleranceMs = 2_000,
): 'alive' | 'gone' | 'reused' | 'uncertain' {
  if (probe.status === 'gone') return 'gone';
  if (probe.status === 'probe_unavailable' || probe.status === 'probe_invalid') {
    return 'uncertain';
  }
  const expected = Date.parse(expectedStartedAt);
  const actual = Date.parse(probe.startedAt);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    return 'uncertain';
  }
  if (Math.abs(expected - actual) <= toleranceMs) {
    return 'alive';
  }
  return 'reused';
}
