import { asAttemptId, type AttemptId } from '../../domain/ids.js';
import { Redactor } from '../../logging/redact.js';
import { sanitizeTerminal } from '../../logging/sanitize-terminal.js';
import type {
  ProcessStartRequest,
  ProcessSupervisorPort,
  ProcessWaitResult,
} from '../../process/process-supervisor-port.js';

/** Default wall-clock bound for a single no-write probe command. */
export const DEFAULT_COMMAND_PROBE_TIMEOUT_MS = 5_000;

/**
 * After graceful stop request, escalate with forceStopTree and still finish
 * within this bound so CommandProbe never awaits `wait` forever.
 */
export const DEFAULT_COMMAND_PROBE_TERMINATION_GRACE_MS = 500;

/** Soft cap on captured stdout+stderr combined (characters after decode). */
export const DEFAULT_COMMAND_PROBE_MAX_OUTPUT_CHARS = 32 * 1024;

export interface CommandProbeEvidence {
  readonly attemptId: AttemptId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly durationMs: number;
  readonly pid?: number;
}

export interface CommandProbeRequest {
  readonly attemptId: AttemptId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Must be false — health probes never invoke a shell. */
  readonly shell: false;
  readonly environment?: Readonly<Record<string, string>>;
  readonly maxOutputChars?: number;
}

export interface CommandProbeResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly evidence: CommandProbeEvidence;
}

/**
 * Narrow no-write runner used by capability probes.
 * Implementations must use structural argv (no shell) and bound output/time.
 * Production uses ProcessSupervisorPort; test fixtures may inject a pure runner.
 */
export interface CommandProbeRunner {
  run(request: CommandProbeRequest): Promise<CommandProbeResult>;
}

export interface CommandProbeOptions {
  /** Working directory for probes; typically a temp/fixture dir, never a live project. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxOutputChars?: number;
  /**
   * Test-only / injected runner. Production code must supply
   * {@link CommandProbeOptions.supervisor} instead — never a default spawn path.
   */
  readonly runner?: CommandProbeRunner;
  /**
   * Required ProcessSupervisorPort for production probes (Job Object via ProcessHost).
   * Reserve/start/wait/timeout all go through this port; never raw PID kill.
   */
  readonly supervisor?: ProcessSupervisorPort;
  readonly createAttemptId?: () => AttemptId;
  readonly redactor?: Redactor;
  /** Bound after graceful stop before forceStopTree (default 500ms). */
  readonly terminationGraceMs?: number;
}

function positiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

const PROBE_SECRET_ASSIGNMENT =
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|token)\s*[=:]\s*)([^\s,;]+)/gi;

function scrubProbeSecrets(text: string): string {
  return text
    .replace(PROBE_SECRET_ASSIGNMENT, `$1[REDACTED]`)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]');
}

function sanitizeErrorText(text: string, redactor: Redactor): string {
  const redacted = redactor.redact(text).value;
  const asString = typeof redacted === 'string' ? redacted : String(redacted);
  return sanitizeTerminal(scrubProbeSecrets(asString), {
    maxLineCharacters: 512,
    maxChunkCharacters: 1_024,
  }).text;
}

function assertStructuralArgv(args: readonly string[]): void {
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new Error('command probe args must be strings');
    }
  }
}

/**
 * ProcessSupervisorPort-backed production runner.
 * Lifecycle: start → wait; on timeout requestGracefulStop then forceStopTree.
 * Returns timedOut only after cleanup success; cleanup failure fails closed.
 * Never kills raw/unverified PIDs; termination is Job-Object mediated only.
 */
export function createSupervisorCommandProbeRunner(
  supervisor: ProcessSupervisorPort,
  options: {
    readonly redactor?: Redactor;
    readonly maxOutputChars?: number;
    readonly terminationGraceMs?: number;
  } = {},
): CommandProbeRunner {
  const redactor = options.redactor ?? new Redactor();
  const defaultMaxOutput = options.maxOutputChars ?? DEFAULT_COMMAND_PROBE_MAX_OUTPUT_CHARS;
  const terminationGraceMs = positiveInt(
    options.terminationGraceMs ?? DEFAULT_COMMAND_PROBE_TERMINATION_GRACE_MS,
    'terminationGraceMs',
  );

  return {
    async run(request: CommandProbeRequest): Promise<CommandProbeResult> {
      if (request.shell !== false) {
        throw new Error('command probe refuses shell execution');
      }
      assertStructuralArgv(request.args);
      const timeoutMs = positiveInt(request.timeoutMs, 'timeoutMs');
      const maxOutputChars = positiveInt(
        request.maxOutputChars ?? defaultMaxOutput,
        'maxOutputChars',
      );
      const started = Date.now();
      // Hard bound: timeout + grace + force window so we never hang forever.
      const hardBoundMs = timeoutMs + terminationGraceMs * 2 + 250;

      const startRequest: ProcessStartRequest = {
        attemptId: request.attemptId,
        executable: request.executable,
        args: request.args,
        cwd: request.cwd,
        timeoutMs,
        ...(request.environment === undefined
          ? {}
          : { environment: request.environment }),
      };

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let cleanupFailedError: string | undefined;
      let cleanupSucceeded = false;
      let gracefulIssued = false;
      let forceIssued = false;

      const unsubscribe = supervisor.subscribe(request.attemptId, (event) => {
        if (event.type === 'stdout') {
          if (stdout.length >= maxOutputChars) {
            stdoutTruncated = true;
            return;
          }
          const remaining = maxOutputChars - stdout.length;
          stdout += event.chunk.slice(0, remaining);
          if (event.chunk.length > remaining) stdoutTruncated = true;
        }
        if (event.type === 'stderr') {
          if (stderr.length >= maxOutputChars) {
            stderrTruncated = true;
            return;
          }
          const remaining = maxOutputChars - stderr.length;
          stderr += event.chunk.slice(0, remaining);
          if (event.chunk.length > remaining) stderrTruncated = true;
        }
        if (event.type === 'cleanup_failed') {
          // Keep latest failure; a later force success clears this.
          cleanupFailedError = event.error;
          cleanupSucceeded = false;
        }
        if (event.type === 'cleanup_succeeded') {
          cleanupSucceeded = true;
          cleanupFailedError = undefined;
        }
      });

      let pid: number | undefined;
      let softKillTimer: ReturnType<typeof setTimeout> | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let hardBoundTimer: ReturnType<typeof setTimeout> | undefined;

      const clearTimers = (): void => {
        if (softKillTimer !== undefined) clearTimeout(softKillTimer);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        if (hardBoundTimer !== undefined) clearTimeout(hardBoundTimer);
        softKillTimer = undefined;
        forceKillTimer = undefined;
        hardBoundTimer = undefined;
      };

      const buildEvidence = (durationMs: number) => ({
        attemptId: request.attemptId,
        executable: request.executable,
        args: [...request.args],
        cwd: request.cwd,
        durationMs,
        ...(pid === undefined ? {} : { pid }),
      });

      const sanitizeIO = () => {
        const sanitizedStdout = sanitizeTerminal(
          stdoutTruncated ? `${stdout}[truncated]` : stdout,
        ).text;
        const sanitizedStderr = sanitizeTerminal(
          stderrTruncated ? `${stderr}[truncated]` : stderr,
        ).text;
        return { sanitizedStdout, sanitizedStderr };
      };

      try {
        const supervised = await supervisor.start(startRequest);
        pid = supervised.pid;

        softKillTimer = setTimeout(() => {
          gracefulIssued = true;
          void supervisor.requestGracefulStop(request.attemptId).catch(() => undefined);
          forceKillTimer = setTimeout(() => {
            forceIssued = true;
            void supervisor.forceStopTree(request.attemptId).catch(() => undefined);
          }, terminationGraceMs);
        }, timeoutMs);

        const waitResult = await new Promise<ProcessWaitResult | 'hard_bound'>(
          (resolve) => {
            hardBoundTimer = setTimeout(() => {
              resolve('hard_bound');
            }, hardBoundMs);
            void supervisor
              .wait(request.attemptId)
              .then((result) => {
                resolve(result);
              })
              .catch(() => {
                resolve('hard_bound');
              });
          },
        );

        clearTimers();
        const durationMs = Date.now() - started;
        const { sanitizedStdout, sanitizedStderr } = sanitizeIO();

        // Fail closed when Job Object cleanup could not be proven.
        if (cleanupFailedError !== undefined) {
          return {
            ok: false,
            exitCode: null,
            timedOut: false,
            stdout: sanitizedStdout,
            stderr: sanitizedStderr,
            error: `cleanup_failed: ${cleanupFailedError}`,
            evidence: buildEvidence(durationMs),
          };
        }

        if (waitResult === 'hard_bound') {
          // Still try force cleanup once more, but never claim clean timeout.
          if (!forceIssued) {
            void supervisor.forceStopTree(request.attemptId).catch(() => undefined);
          }
          return {
            ok: false,
            exitCode: null,
            timedOut: false,
            stdout: sanitizedStdout,
            stderr: sanitizedStderr,
            error: 'cleanup_failed: probe hard bound elapsed without verified cleanup',
            evidence: buildEvidence(durationMs),
          };
        }

        const stopPath = gracefulIssued || forceIssued
          || waitResult.reason === 'timed_out'
          || waitResult.reason === 'force_stop'
          || waitResult.reason === 'graceful_stop';

        if (stopPath) {
          // timedOut only after cleanup success (or natural exit after stop).
          if (cleanupSucceeded || waitResult.reason === 'graceful_stop'
            || waitResult.reason === 'force_stop'
            || waitResult.reason === 'timed_out'
            || waitResult.reason === 'exited') {
            return {
              ok: false,
              exitCode: waitResult.exitCode,
              timedOut: true,
              stdout: sanitizedStdout,
              stderr: sanitizedStderr,
              error: 'command probe timed out',
              evidence: buildEvidence(durationMs),
            };
          }
          return {
            ok: false,
            exitCode: null,
            timedOut: false,
            stdout: sanitizedStdout,
            stderr: sanitizedStderr,
            error: 'cleanup_failed: stop path without verified cleanup',
            evidence: buildEvidence(durationMs),
          };
        }

        return {
          ok: waitResult.exitCode === 0,
          exitCode: waitResult.exitCode,
          timedOut: false,
          stdout: sanitizedStdout,
          stderr: sanitizedStderr,
          evidence: buildEvidence(durationMs),
        };
      } catch (error) {
        clearTimers();
        const message = error instanceof Error ? error.message : String(error);
        const { sanitizedStdout, sanitizedStderr } = sanitizeIO();
        return {
          ok: false,
          exitCode: null,
          timedOut: false,
          stdout: sanitizedStdout,
          stderr: sanitizedStderr,
          error: sanitizeErrorText(message, redactor),
          evidence: buildEvidence(Date.now() - started),
        };
      } finally {
        clearTimers();
        unsubscribe();
      }
    },
  };
}

let probeAttemptCounter = 0;

function defaultAttemptId(): AttemptId {
  probeAttemptCounter += 1;
  return asAttemptId(`command-probe-${String(probeAttemptCounter)}`);
}

/**
 * Bounded, no-write command probe used by CLI health checks.
 * Never invokes a model, never uses a shell, and never writes project files.
 * Production requires a ProcessSupervisorPort (Job Object). No direct-spawn fallback.
 */
export class CommandProbe {
  readonly #runner: CommandProbeRunner;
  readonly #cwd: string;
  readonly #timeoutMs: number;
  readonly #maxOutputChars: number;
  readonly #createAttemptId: () => AttemptId;
  readonly #redactor: Redactor;

  public constructor(options: CommandProbeOptions) {
    this.#cwd = options.cwd;
    this.#timeoutMs = positiveInt(
      options.timeoutMs ?? DEFAULT_COMMAND_PROBE_TIMEOUT_MS,
      'timeoutMs',
    );
    this.#maxOutputChars = positiveInt(
      options.maxOutputChars
        ?? options.maxOutputBytes
        ?? DEFAULT_COMMAND_PROBE_MAX_OUTPUT_CHARS,
      'maxOutputChars',
    );
    this.#createAttemptId = options.createAttemptId ?? defaultAttemptId;
    this.#redactor = options.redactor ?? new Redactor();
    if (options.runner !== undefined) {
      // Injected runner is for tests/fixtures only — never a default production spawn.
      this.#runner = options.runner;
    } else if (options.supervisor !== undefined) {
      this.#runner = createSupervisorCommandProbeRunner(options.supervisor, {
        redactor: this.#redactor,
        maxOutputChars: this.#maxOutputChars,
        ...(options.terminationGraceMs === undefined
          ? {}
          : { terminationGraceMs: options.terminationGraceMs }),
      });
    } else {
      throw new Error(
        'CommandProbe requires ProcessSupervisorPort (production) or an injected '
          + 'test runner; direct spawn / raw-PID kill fallback is not permitted',
      );
    }
  }

  public get cwd(): string {
    return this.#cwd;
  }

  public get timeoutMs(): number {
    return this.#timeoutMs;
  }

  public createAttemptId(): AttemptId {
    return this.#createAttemptId();
  }

  public sanitizeError(text: string): string {
    return sanitizeErrorText(text, this.#redactor);
  }

  public async run(
    request: Omit<CommandProbeRequest, 'timeoutMs' | 'shell' | 'cwd' | 'maxOutputChars'> & {
      readonly timeoutMs?: number;
      readonly cwd?: string;
      readonly shell?: false;
      readonly maxOutputChars?: number;
    },
  ): Promise<CommandProbeResult> {
    const full: CommandProbeRequest = {
      attemptId: request.attemptId,
      executable: request.executable,
      args: request.args,
      cwd: request.cwd ?? this.#cwd,
      timeoutMs: request.timeoutMs ?? this.#timeoutMs,
      shell: false,
      maxOutputChars: request.maxOutputChars ?? this.#maxOutputChars,
      ...(request.environment === undefined
        ? {}
        : { environment: request.environment }),
    };
    const result = await this.#runner.run(full);
    if (result.error !== undefined) {
      return {
        ...result,
        error: this.sanitizeError(result.error),
      };
    }
    return result;
  }

  public async runArgv(
    executable: string,
    args: readonly string[],
  ): Promise<CommandProbeResult> {
    return this.run({
      attemptId: this.createAttemptId(),
      executable,
      args,
    });
  }
}
