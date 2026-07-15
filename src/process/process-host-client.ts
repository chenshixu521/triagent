import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discoverNativeHelper,
  NATIVE_HELPER_RELATIVE_PATH,
  resolvePackageRoot,
  type NativeHelperDiscoveryResult,
} from './native-helper-discovery.js';

export type { NativeHelperDiscoveryResult };

function pathKey(input: string): string {
  return process.platform === 'win32'
    ? input.replaceAll('/', '\\').toLocaleLowerCase('en-US')
    : input;
}

function canonicalHelperPath(packageRoot: string): string {
  return join(packageRoot, NATIVE_HELPER_RELATIVE_PATH);
}

/**
 * Resolve the packaged self-contained ProcessHost helper path.
 *
 * Production resolution is package-relative only with embedded trust verification.
 * Never searches PATH, cwd, project trees, or temp. TRIAGENT_PROCESS_HOST is ignored.
 */
export function resolveProcessHostExecutable(
  packageRoot?: string,
): string {
  const discovery = discoverNativeHelper(
    packageRoot === undefined ? {} : { packageRoot },
  );
  if (discovery.ok) {
    return discovery.helperPath;
  }
  if (discovery.helperPath !== undefined) {
    return discovery.helperPath;
  }
  let root = packageRoot;
  if (root === undefined) {
    try {
      root = resolvePackageRoot(import.meta.url);
    } catch {
      root = dirname(fileURLToPath(import.meta.url));
    }
  }
  return canonicalHelperPath(root);
}

export function discoverProcessHostHelper(
  packageRoot?: string,
): NativeHelperDiscoveryResult {
  return discoverNativeHelper(
    packageRoot === undefined ? {} : { packageRoot },
  );
}

export type ProcessHostEvent =
  | {
      readonly type: 'started';
      readonly attemptId: string;
      readonly pid: number;
      readonly startedAt: string;
      readonly startTimeFileTime?: number;
    }
  | {
      readonly type: 'stdout';
      readonly attemptId: string;
      readonly encoding: 'base64';
      readonly data: string;
    }
  | {
      readonly type: 'stderr';
      readonly attemptId: string;
      readonly encoding: 'base64';
      readonly data: string;
    }
  | {
      readonly type: 'exited';
      readonly attemptId: string;
      readonly pid: number;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly reason: string;
    }
  | {
      readonly type: 'tree_clean';
      readonly attemptId: string;
      readonly operation: string;
    }
  | {
      readonly type: 'cleanup_failed';
      readonly attemptId: string;
      readonly operation: string;
      readonly error: string;
    }
  | {
      readonly type: 'start_failed';
      readonly attemptId: string;
      readonly error: string;
    }
  | {
      readonly type: 'host_error';
      readonly error: string;
    }
  | {
      /** Helper readiness diagnostic (e.g. "triagent-process-host ready"). Not an error. */
      readonly type: 'host_ready';
      readonly message: string;
    }
  | {
      readonly type: 'host_exit';
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    };

export type ProcessHostEventListener = (event: ProcessHostEvent) => void;

/**
 * Production options: only package-relative trusted discovery may be used.
 * There is no public helperPath override for production.
 */
export interface ProcessHostClientOptions {
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Optional package root for discovery. Never a substitute helper path.
   */
  readonly packageRoot?: string;
}

/**
 * @internal Test-only construction. Not selectable via CLI/settings/env.
 * Production code must use {@link ProcessHostClient.create}.
 */
export interface ProcessHostClientTestOptions {
  readonly __testOnlyHelperPath: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly __testOnlyAllowUntrustedHelper: true;
}

export interface HostStartProcessRequest {
  readonly attemptId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdinBase64?: string;
  readonly stdinCloseAfterWrite?: boolean;
}

export interface HostStartedInfo {
  readonly attemptId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly startTimeFileTime?: number;
}

/**
 * JSONL client for the native ProcessHost helper.
 * Production instances always launch the package-relative trusted helper only.
 */
export class ProcessHostClient {
  readonly #helperPath: string;
  readonly #env: Readonly<Record<string, string>> | undefined;
  readonly #trustedProduction: boolean;
  readonly #listeners = new Set<ProcessHostEventListener>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #stdoutBuffer = '';
  #stderrBuffer = '';
  #started = false;
  #disposed = false;
  /** attemptIds that have reached a true terminal condition (exited / host death). */
  readonly #terminalAttemptsCompleted = new Set<string>();
  /** Non-terminal cleanup observed (tree_clean) — recorded only; does not settle waitForTerminal. */
  readonly #treeCleanSeen = new Set<string>();
  readonly #pendingStarts = new Map<
    string,
    {
      resolve: (info: HostStartedInfo) => void;
      reject: (error: Error) => void;
    }
  >();
  readonly #terminalWaiters = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
    }[]
  >();

  private constructor(
    helperPath: string,
    env: Readonly<Record<string, string>> | undefined,
    trustedProduction: boolean,
  ) {
    this.#helperPath = helperPath;
    this.#env = env;
    this.#trustedProduction = trustedProduction;
  }

  /**
   * Production factory: discovers and binds the package-relative trusted helper.
   * Throws if discovery fails (fail closed before any spawn).
   */
  public static create(options: ProcessHostClientOptions = {}): ProcessHostClient {
    const discovery = discoverNativeHelper(
      options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot },
    );
    if (!discovery.ok) {
      throw new Error(
        `ProcessHost helper verification failed: ${discovery.diagnostic}`,
      );
    }
    return new ProcessHostClient(discovery.helperPath, options.env, true);
  }

  /**
   * @internal Test-only factory. Cannot be selected by CLI/settings/untrusted input.
   * Requires the explicit magic flag so accidental production wiring is impossible.
   */
  public static createForTests(options: ProcessHostClientTestOptions): ProcessHostClient {
    if (options.__testOnlyAllowUntrustedHelper !== true) {
      throw new Error('ProcessHostClient.createForTests requires explicit test flag');
    }
    if (typeof options.__testOnlyHelperPath !== 'string' || options.__testOnlyHelperPath.length === 0) {
      throw new Error('ProcessHostClient.createForTests requires __testOnlyHelperPath');
    }
    return new ProcessHostClient(
      options.__testOnlyHelperPath,
      options.env,
      false,
    );
  }

  public get helperPath(): string {
    return this.#helperPath;
  }

  public get helperPid(): number | undefined {
    return this.#child?.pid;
  }

  public onEvent(listener: ProcessHostEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #assertHelperLaunchAllowed(): void {
    if (this.#trustedProduction) {
      const discovery = discoverNativeHelper();
      if (!discovery.ok) {
        throw new Error(
          `ProcessHost helper verification failed: ${discovery.diagnostic}`,
        );
      }
      if (pathKey(discovery.helperPath) !== pathKey(this.#helperPath)) {
        throw new Error(
          `ProcessHost helper path is not the trusted package helper `
          + `(bound=${this.#helperPath}, trusted=${discovery.helperPath})`,
        );
      }
      return;
    }
    // Test-only untrusted path: still require a regular existing file.
    if (!existsSync(this.#helperPath)) {
      throw new Error(`ProcessHost helper not found: ${this.#helperPath}`);
    }
  }

  public async start(): Promise<void> {
    if (this.#disposed) {
      throw new Error('ProcessHostClient is disposed');
    }
    if (this.#started) return;
    if (!existsSync(this.#helperPath)) {
      throw new Error(`ProcessHost helper not found: ${this.#helperPath}`);
    }

    this.#assertHelperLaunchAllowed();

    this.#child = spawn(this.#helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(this.#env ?? {}),
      },
    }) as ChildProcessWithoutNullStreams;

    this.#started = true;

    this.#child.stdout.setEncoding('utf8');
    this.#child.stderr.setEncoding('utf8');

    this.#child.stdout.on('data', (chunk: string) => {
      this.#onStdout(chunk);
    });
    this.#child.stderr.on('data', (chunk: string) => {
      // Line-buffered: only complete lines are classified (ready vs host_error).
      this.#onStderr(chunk);
    });
    this.#child.on('error', (error) => {
      this.#emit({
        type: 'host_error',
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.#child.on('exit', (code, signal) => {
      // Drain any residual stdout before settling so a final exited line is not lost.
      try {
        if (this.#stdoutBuffer.trim().length > 0) {
          const remaining = this.#stdoutBuffer;
          this.#stdoutBuffer = '';
          for (const line of remaining.split(/\r?\n/u)) {
            const trimmed = line.trim();
            if (trimmed.length > 0) this.#handleLine(trimmed);
          }
        }
      } catch {
        // ignore
      }
      this.#emit({
        type: 'host_exit',
        exitCode: code,
        signal,
      });
      this.#failAllPending(
        new Error(
          `ProcessHost exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
      // Host death is a true terminal condition for all outstanding attempts.
      for (const attemptId of [...this.#terminalWaiters.keys()]) {
        this.#terminalAttemptsCompleted.add(attemptId);
      }
      this.#resolveAllTerminals();
    });
  }

  // --- remaining protocol methods preserved from prior implementation ---

  public async startProcess(
    request: HostStartProcessRequest,
  ): Promise<HostStartedInfo> {
    if (!this.#started || this.#child === undefined) {
      throw new Error('ProcessHostClient.start() must be called first');
    }
    return new Promise<HostStartedInfo>((resolve, reject) => {
      this.#pendingStarts.set(request.attemptId, { resolve, reject });
      const payload = {
        type: 'start',
        attemptId: request.attemptId,
        command: request.command,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        stdinBase64: request.stdinBase64,
        stdinCloseAfterWrite: request.stdinCloseAfterWrite,
      };
      this.#writeLine(payload);
    });
  }

  /**
   * Request stop. Accepts host protocol ops and supervisor aliases.
   * Native StopCommand requires JSON property `mode` (`force` | `graceful`),
   * not `operation`. Optional graceMs is forwarded for the graceful path.
   */
  public requestStop(
    attemptId: string,
    operation:
      | 'graceful_stop'
      | 'force_stop'
      | 'graceful'
      | 'force'
      | 'force_stop_tree' = 'force_stop',
    graceMs?: number,
  ): void {
    const mode =
      operation === 'graceful' || operation === 'graceful_stop'
        ? 'graceful'
        : 'force';
    this.#writeLine({
      type: 'stop',
      attemptId,
      mode,
      ...(graceMs === undefined || mode !== 'graceful' ? {} : { graceMs }),
    });
  }

  public killHelper(): void {
    this.#child?.kill();
  }

  public closeStdin(): void {
    this.#child?.stdin.end();
  }

  public async waitForTerminal(attemptId: string, timeoutMs = 60_000): Promise<void> {
    // If a truly terminal event already arrived, resolve immediately.
    if (this.#terminalAttemptsCompleted.has(attemptId)) {
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const waiters = this.#terminalWaiters.get(attemptId) ?? [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`waitForTerminal timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      waiters.push({
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#terminalWaiters.set(attemptId, waiters);
      // Race: terminal may have completed between the set check and waiter registration.
      if (this.#terminalAttemptsCompleted.has(attemptId)) {
        this.#resolveTerminal(attemptId);
      }
    });
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#failAllPending(new Error('ProcessHostClient disposed'));
    // Drain any buffered stdout so a queued exited/tree_clean is not lost to kill.
    try {
      if (this.#stdoutBuffer.trim().length > 0) {
        const remaining = this.#stdoutBuffer;
        this.#stdoutBuffer = '';
        for (const line of remaining.split(/\r?\n/u)) {
          const trimmed = line.trim();
          if (trimmed.length > 0) this.#handleLine(trimmed);
        }
      }
    } catch {
      // ignore drain failures
    }
    // Do not force-resolve terminal waiters before host_exit — that would drop
    // a required exited event when dispose races natural completion. Wait briefly
    // for the helper exit after signaling shutdown.
    const child = this.#child;
    try {
      child?.stdin.end();
    } catch {
      // ignore
    }
    try {
      child?.kill();
    } catch {
      // ignore
    }
    if (child !== undefined) {
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        if (child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        const timer = setTimeout(done, 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    // After host_exit (or timeout), remaining waiters settle via #resolveAllTerminals
    // from the exit handler; ensure none are stranded.
    this.#resolveAllTerminals();
    this.#child = undefined;
  }

  #writeLine(payload: unknown): void {
    if (this.#child === undefined) {
      throw new Error('ProcessHost is not running');
    }
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    let index = this.#stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#stdoutBuffer.slice(0, index).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1);
      if (line.length > 0) this.#handleLine(line);
      index = this.#stdoutBuffer.indexOf('\n');
    }
  }

  #onStderr(chunk: string): void {
    this.#stderrBuffer += chunk;
    let index = this.#stderrBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#stderrBuffer.slice(0, index).replace(/\r$/u, '').trim();
      this.#stderrBuffer = this.#stderrBuffer.slice(index + 1);
      if (line.length === 0) {
        index = this.#stderrBuffer.indexOf('\n');
        continue;
      }
      // Exact normal readiness line is diagnostic only — never host_error.
      // All other stderr remains host_error.
      if (line === 'triagent-process-host ready') {
        // Swallow readiness; optional host_ready for diagnostics/tests.
        this.#emit({ type: 'host_ready', message: line });
      } else {
        this.#emit({ type: 'host_error', error: line });
      }
      index = this.#stderrBuffer.indexOf('\n');
    }
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#emit({ type: 'host_error', error: `invalid JSONL: ${line}` });
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const event = parsed as ProcessHostEvent & { type: string };
    if (event.type === 'started') {
      const pending = this.#pendingStarts.get(event.attemptId);
      if (pending) {
        this.#pendingStarts.delete(event.attemptId);
        pending.resolve({
          attemptId: event.attemptId,
          pid: event.pid,
          startedAt: event.startedAt,
          startTimeFileTime: event.startTimeFileTime,
        });
      }
    }
    if (
      event.type === 'start_failed'
      && 'attemptId' in event
      && typeof (event as { attemptId?: string }).attemptId === 'string'
    ) {
      const attemptId = (event as { attemptId: string }).attemptId;
      const pending = this.#pendingStarts.get(attemptId);
      if (pending) {
        this.#pendingStarts.delete(attemptId);
        pending.reject(new Error((event as { error: string }).error));
      }
      // start_failed is a true terminal failure for that attempt (no process run).
      this.#terminalAttemptsCompleted.add(attemptId);
      this.#resolveTerminal(attemptId);
    }
    if (event.type === 'tree_clean' && 'attemptId' in event) {
      // Non-terminal: record only. waitForTerminal must NOT settle on tree_clean.
      this.#treeCleanSeen.add(String((event as { attemptId: string }).attemptId));
    }
    if (event.type === 'cleanup_failed' && 'attemptId' in event) {
      // Non-terminal protocol event: emit only; waitForTerminal settles on exited
      // (or host_exit). Child host exit already resolves all waiters.
      void (event as { attemptId: string }).attemptId;
    }
    if (event.type === 'exited' && 'attemptId' in event) {
      // Sole protocol event that settles waitForTerminal for a run attempt.
      const attemptId = String((event as { attemptId: string }).attemptId);
      this.#terminalAttemptsCompleted.add(attemptId);
      this.#resolveTerminal(attemptId);
      // System.Text.Json omits null properties. Normalize the native payload
      // before it crosses the strict Worker IPC boundary.
      this.#emit({
        ...(event as Extract<ProcessHostEvent, { type: 'exited' }>),
        exitCode:
          (event as { exitCode?: number | null }).exitCode ?? null,
        signal:
          (event as { signal?: string | null }).signal ?? null,
      });
      return;
    }
    this.#emit(event as ProcessHostEvent);
  }

  #emit(event: ProcessHostEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // listener isolation
      }
    }
  }

  #failAllPending(error: Error): void {
    for (const [, waiter] of this.#pendingStarts) waiter.reject(error);
    this.#pendingStarts.clear();
  }

  #resolveTerminal(attemptId: string): void {
    const waiters = this.#terminalWaiters.get(attemptId) ?? [];
    this.#terminalWaiters.delete(attemptId);
    for (const waiter of waiters) waiter.resolve();
  }

  #resolveAllTerminals(): void {
    for (const attemptId of [...this.#terminalWaiters.keys()]) {
      this.#resolveTerminal(attemptId);
    }
  }
}

/** Module directory helper for tests that need relative fixture roots. */
export function processModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}
