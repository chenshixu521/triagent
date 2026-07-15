import type { AttemptId } from '../domain/ids.js';
import {
  ProcessHostClient,
  discoverProcessHostHelper,
  resolveProcessHostExecutable,
  type ProcessHostEvent,
} from './process-host-client.js';

function pathKey(input: string): string {
  return process.platform === 'win32'
    ? input.replaceAll('/', '\\').toLocaleLowerCase('en-US')
    : input;
}
import {
  classifyIdentityLiveness,
  interpretIdentityProbe,
  queryProcessIdentity,
  type IdentityProbeRaw,
  type IdentityProbeResult,
  type QueryIdentityOptions,
} from './process-identity-probe.js';
import type {
  ProcessCleanupOperation,
  ProcessEventListener,
  ProcessEventUnsubscribe,
  ProcessExitReason,
  ProcessStartRequest,
  ProcessSupervisorEvent,
  ProcessSupervisorPort,
  ProcessWaitResult,
  SupervisedProcess,
} from './process-supervisor-port.js';
import { validateProcessStdinPayload } from './process-supervisor-port.js';
import { resolveWindowsAgentExecutable } from './windows-agent-cli-resolver.js';

export interface ProcessSupervisorOptions {
  /**
   * @deprecated Production must not pass a helper path. Use package discovery.
   * Accepted only when paired with explicit test factory / test options.
   */
  readonly helperPath?: string;
  /**
   * @internal Test-only: allow an untrusted helper path via createForTests.
   * Cannot be selected by CLI/settings/untrusted input.
   */
  readonly __testOnlyAllowUntrustedHelper?: true;
  /** Optional identity probe options (powershell path / injected runner). */
  readonly identityProbe?: QueryIdentityOptions;
}

interface TrackedIdentity {
  readonly pid: number;
  /** ISO start time from host / CIM, when available. */
  readonly startedAt: string;
  /** Windows FILETIME from GetProcessTimes when available. */
  readonly startTimeFileTime?: number;
}

interface ActiveRun {
  readonly attemptId: AttemptId;
  readonly client: ProcessHostClient;
  readonly unsubscribeHost: () => void;
  /** Root identity from ProcessHost started event. */
  identity: TrackedIdentity | undefined;
  /**
   * All known target identities (root + descendants observed via stdout).
   * Success requires each entry's PID+start-time to be proven gone.
   */
  readonly knownIdentities: Map<number, TrackedIdentity>;
  /** PIDs seen before start-time capture completes. */
  readonly knownPids: Set<number>;
  /**
   * PIDs with an in-flight CIM identity capture for this run.
   * Dedupes fixture lines that re-emit the same PID before the first probe completes
   * (e.g. child_pid + child_self_pid, duplicate grandchild_pid).
   */
  readonly pendingIdentityCapturePids: Set<number>;
  settled: boolean;
  wait: Promise<ProcessWaitResult>;
  resolveWait: (result: ProcessWaitResult) => void;
  lastCleanupOperation: ProcessCleanupOperation | undefined;
  treeCleanSeen: boolean;
  exitReason: ProcessExitReason;
  exitCode: number | null;
  signal: string | null;
  /** Serialize host events so tree_clean / exited cannot race. */
  eventChain: Promise<void>;
  /** Serialize CIM identity captures (avoid powershell storms under load). */
  identityCaptureChain: Promise<void>;
  /** Deferred listener failures (settled after terminal wait resolves). */
  deferredListenerFailures: unknown[];
}

function rethrowListenerFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(
    failures,
    'multiple process supervisor event listeners failed',
  );
}

function decodeBase64Chunk(data: string): string {
  try {
    return Buffer.from(data, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function encodeStdinBase64(
  stdin: ReturnType<typeof validateProcessStdinPayload>,
): string {
  if (stdin.encoding === 'base64') {
    return stdin.data.replace(/\s+/g, '');
  }
  return Buffer.from(stdin.data, 'utf8').toString('base64');
}

function mapExitReason(reason: string): ProcessExitReason {
  if (reason === 'force_stop') return 'force_stop';
  if (reason === 'graceful_stop') return 'graceful_stop';
  if (reason === 'timed_out') return 'timed_out';
  return 'exited';
}

type HostClientFactory = (options: {
  readonly helperPath: string;
}) => ProcessHostClient;

type IdentityProbeRunner = (pid: number) => Promise<IdentityProbeRaw>;

/**
 * Real {@link ProcessSupervisorPort} bound to the Windows ProcessHost helper.
 *
 * On helper crash / stdin close, verifies cleanup using only persisted
 * PID + start-time identities. Never kills an unverified / reused PID.
 * Emits cleanup_failed when identity cannot be proven.
 *
 * Listener policy (documented): every subscriber receives fan-out. Terminal
 * wait state is resolved before listeners are notified for the settling
 * `exited` event. Listener exceptions are collected after fan-out and rethrown
 * after settlement so they cannot wedge wait or corrupt cleanup state.
 */
export class ProcessSupervisor implements ProcessSupervisorPort {
  /**
   * Test seam: replace ProcessHostClient construction.
   * Production always uses the real client.
   */
  public static createHostClientForTests:
    | HostClientFactory
    | undefined;

  /**
   * Test seam: install an identity probe raw-runner. Returns a restore fn.
   */
  public static installIdentityProbeForTests(
    runner: IdentityProbeRunner,
  ): () => void {
    const previous = ProcessSupervisor.#testIdentityRunner;
    ProcessSupervisor.#testIdentityRunner = runner;
    return () => {
      ProcessSupervisor.#testIdentityRunner = previous;
    };
  }

  static #testIdentityRunner: IdentityProbeRunner | undefined;

  readonly #helperPath: string;
  readonly #identityProbeOptions: QueryIdentityOptions;
  readonly #listeners = new Map<AttemptId, Set<ProcessEventListener>>();
  readonly #active = new Map<AttemptId, ActiveRun>();

  readonly #testOnlyUntrusted: boolean;

  public constructor(options: ProcessSupervisorOptions = {}) {
    const testOnly =
      options.__testOnlyAllowUntrustedHelper === true
      && typeof options.helperPath === 'string'
      && options.helperPath.length > 0;

    if (testOnly) {
      // Explicit test-only path; never reachable from CLI/settings.
      this.#helperPath = options.helperPath!;
      this.#testOnlyUntrusted = true;
    } else if (options.helperPath !== undefined) {
      // Production-style helperPath without the explicit test flag is ignored;
      // bind package-relative discovery only (fail closed at start if untrusted).
      const discovery = discoverProcessHostHelper();
      this.#helperPath = discovery.ok
        ? discovery.helperPath
        : resolveProcessHostExecutable();
      this.#testOnlyUntrusted = false;
    } else {
      const discovery = discoverProcessHostHelper();
      this.#helperPath = discovery.ok
        ? discovery.helperPath
        : resolveProcessHostExecutable();
      this.#testOnlyUntrusted = false;
    }
    this.#identityProbeOptions = options.identityProbe ?? {};
  }

  /**
   * Whether the packaged native helper is present and trusted for real runs.
   */
  public isNativeHelperTrusted(): boolean {
    if (this.#testOnlyUntrusted) return false;
    const discovery = discoverProcessHostHelper();
    return discovery.ok && pathKey(discovery.helperPath) === pathKey(this.#helperPath);
  }

  public nativeHelperDiagnostic(): string | undefined {
    if (this.#testOnlyUntrusted) {
      return 'test-only untrusted helper path is active';
    }
    const discovery = discoverProcessHostHelper();
    return discovery.ok ? undefined : discovery.diagnostic;
  }

  public subscribe(
    attemptId: AttemptId,
    listener: ProcessEventListener,
  ): ProcessEventUnsubscribe {
    const listeners = this.#listeners.get(attemptId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(attemptId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(attemptId);
    };
  }

  public async start(request: ProcessStartRequest): Promise<SupervisedProcess> {
    if (this.#active.has(request.attemptId)) {
      throw new Error(`attempt is already supervised: ${request.attemptId}`);
    }

    // Validate / bound stdin before launching the helper so oversized prompts
    // fail closed with zero ProcessHost start.
    const stdin = request.stdin === undefined
      ? undefined
      : validateProcessStdinPayload(request.stdin);
    const stdinBase64 = stdin === undefined
      ? undefined
      : encodeStdinBase64(stdin);
    const resolutionEnvironment = request.environment === undefined
      ? process.env
      : { ...process.env, ...request.environment };
    const resolvedAgentExecutable = resolveWindowsAgentExecutable({
      executable: request.executable,
      environment: resolutionEnvironment,
      cwd: request.cwd,
    });
    const executable = resolvedAgentExecutable?.resolvedPath ?? request.executable;

    const factory = ProcessSupervisor.createHostClientForTests;
    const client = factory === undefined
      ? (
        this.#testOnlyUntrusted
          ? ProcessHostClient.createForTests({
            __testOnlyHelperPath: this.#helperPath,
            __testOnlyAllowUntrustedHelper: true,
          })
          : ProcessHostClient.create()
      )
      : factory({ helperPath: this.#helperPath });
    await client.start();

    let resolveWait!: (result: ProcessWaitResult) => void;
    const wait = new Promise<ProcessWaitResult>((resolve) => {
      resolveWait = resolve;
    });

    const run: ActiveRun = {
      attemptId: request.attemptId,
      client,
      unsubscribeHost: () => undefined,
      identity: undefined,
      knownIdentities: new Map(),
      knownPids: new Set(),
      pendingIdentityCapturePids: new Set(),
      settled: false,
      wait,
      resolveWait,
      lastCleanupOperation: undefined,
      treeCleanSeen: false,
      exitReason: 'exited',
      exitCode: null,
      signal: null,
      eventChain: Promise.resolve(),
      identityCaptureChain: Promise.resolve(),
      deferredListenerFailures: [],
    };

    const unsubscribeHost = client.onEvent((event) => {
      // Serialize async handlers: exited must not settle before tree_clean
      // identity proof finishes, and concurrent host events must not interleave.
      // Listener failures are deferred until after wait settles — never swallow
      // settlement, and never leave wait pending because a listener threw.
      run.eventChain = run.eventChain
        .then(async () => {
          try {
            await this.#onHostEvent(run, event);
          } catch (error) {
            // Unexpected handler errors fail closed rather than wedging wait.
            if (!run.settled) {
              this.#settleCleanupFailed(
                run,
                run.lastCleanupOperation ?? 'force_stop_tree',
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          this.#flushDeferredListenerFailures(run);
        })
        .catch(() => undefined);
    });
    // Replace placeholder.
    (run as { unsubscribeHost: () => void }).unsubscribeHost = unsubscribeHost;

    this.#active.set(request.attemptId, run);

    try {
      const started = await client.startProcess({
        attemptId: request.attemptId,
        command: executable,
        args: request.args,
        cwd: request.cwd,
        env: request.environment,
        ...(stdinBase64 === undefined ? {} : { stdinBase64 }),
        ...(stdin === undefined
          ? {}
          : { stdinCloseAfterWrite: stdin.closeAfterWrite !== false }),
      });
      run.identity = {
        pid: started.pid,
        startedAt: started.startedAt,
        ...(started.startTimeFileTime === undefined
          ? {}
          : { startTimeFileTime: started.startTimeFileTime }),
      };
      run.knownPids.add(started.pid);
      run.knownIdentities.set(started.pid, run.identity);
      this.#emit(run, {
        type: 'started',
        pid: started.pid,
      });
      return {
        attemptId: request.attemptId,
        pid: started.pid,
        startedAt: started.startedAt,
      };
    } catch (error) {
      this.#active.delete(request.attemptId);
      unsubscribeHost();
      await client.dispose().catch(() => undefined);
      throw error instanceof Error
        ? error
        : new Error(String(error));
    }
  }

  public async requestGracefulStop(attemptId: AttemptId): Promise<void> {
    const run = this.#active.get(attemptId);
    if (run === undefined || run.settled) return;
    run.lastCleanupOperation = 'graceful_stop';
    run.exitReason = 'graceful_stop';
    run.client.requestStop(attemptId, 'graceful', 5_000);
  }

  public async forceStopTree(attemptId: AttemptId): Promise<void> {
    const run = this.#active.get(attemptId);
    if (run === undefined || run.settled) return;
    run.lastCleanupOperation = 'force_stop_tree';
    run.exitReason = 'force_stop';
    run.client.requestStop(attemptId, 'force');
  }

  public wait(attemptId: AttemptId): Promise<ProcessWaitResult> {
    const run = this.#active.get(attemptId);
    if (run === undefined) {
      return Promise.reject(
        new Error(`attempt is not supervised: ${attemptId}`),
      );
    }
    return run.wait;
  }

  /** Test seam: kill the helper so Job KILL_ON_JOB_CLOSE fires. */
  public async crashHelperForTests(attemptId: AttemptId): Promise<void> {
    const run = this.#active.get(attemptId);
    if (run === undefined) return;
    run.lastCleanupOperation = 'force_stop_tree';
    run.client.killHelper();
    // Wait for the serialized host event chain to finish settling.
    await run.eventChain;
  }

  /** Test seam: close helper stdin (host exit closes Job handle). */
  public async closeHelperStdinForTests(attemptId: AttemptId): Promise<void> {
    const run = this.#active.get(attemptId);
    if (run === undefined) return;
    run.lastCleanupOperation = 'force_stop_tree';
    run.client.closeStdin();
    await run.eventChain;
  }

  public async dispose(): Promise<void> {
    for (const run of [...this.#active.values()]) {
      run.unsubscribeHost();
      await run.client.dispose().catch(() => undefined);
      if (!run.settled) {
        this.#settleCleanupFailed(
          run,
          run.lastCleanupOperation ?? 'force_stop_tree',
          'supervisor disposed while run active',
        );
      }
    }
    this.#active.clear();
  }

  async #onHostEvent(run: ActiveRun, event: ProcessHostEvent): Promise<void> {
    if (run.settled) return;

    switch (event.type) {
      case 'started':
        // Already emitted from start().
        return;
      case 'stdout': {
        const chunk = decodeBase64Chunk(event.data);
        this.#notePidsFromOutput(run, chunk);
        this.#emit(run, { type: 'stdout', chunk });
        return;
      }
      case 'stderr': {
        const chunk = decodeBase64Chunk(event.data);
        this.#notePidsFromOutput(run, chunk);
        this.#emit(run, { type: 'stderr', chunk });
        return;
      }
      case 'tree_clean': {
        run.treeCleanSeen = true;
        // Record cleanup intent only when host names a stop operation.
        // Natural tree_clean must not invent force_stop_tree.
        if (run.lastCleanupOperation === undefined) {
          if (
            event.operation === 'graceful_stop'
            || event.operation === 'graceful'
          ) {
            run.lastCleanupOperation = 'graceful_stop';
          } else if (
            event.operation === 'force_stop'
            || event.operation === 'force'
            || event.operation === 'force_stop_tree'
          ) {
            run.lastCleanupOperation = 'force_stop_tree';
          }
        }
        // Do NOT emit cleanup_succeeded yet — success requires PID+start-time
        // proof at settlement. tree_clean only means the host reported Job empty.
        return;
      }
      case 'cleanup_failed': {
        const operation: ProcessCleanupOperation =
          event.operation === 'graceful_stop' || event.operation === 'graceful'
            ? 'graceful_stop'
            : 'force_stop_tree';
        this.#emit(run, {
          type: 'cleanup_failed',
          operation,
          error: event.error,
        });
        // Non-terminal for graceful; force cleanup_failed still needs exit settlement.
        if (operation === 'force_stop_tree') {
          this.#settleExit(run, {
            reason: 'force_stop',
            exitCode: null,
            signal: 'SIGKILL',
          });
        }
        return;
      }
      case 'exited': {
        run.exitCode = event.exitCode;
        run.signal = event.signal;
        run.exitReason = mapExitReason(event.reason);
        // Wait for any in-flight identity captures so parent+child+grandchild
        // identities are recorded before force/settlement proof.
        await run.identityCaptureChain;
        await this.#proveCleanupBeforeSettle(run);
        this.#settleExit(run, {
          reason: run.exitReason,
          exitCode: event.exitCode,
          signal: event.signal,
        });
        return;
      }
      case 'start_failed':
        this.#settleCleanupFailed(
          run,
          'force_stop_tree',
          event.error,
        );
        return;
      case 'host_exit': {
        // Helper died: Job handle closed → KILL_ON_JOB_CLOSE. Verify identities only.
        await run.identityCaptureChain;
        await this.#handleHelperDeath(run);
        return;
      }
      case 'host_error':
        return;
      default:
        return;
    }
  }

  async #handleHelperDeath(run: ActiveRun): Promise<void> {
    if (run.settled) return;
    const operation = run.lastCleanupOperation ?? 'force_stop_tree';
    // Job handle closed → KILL_ON_JOB_CLOSE. Prove identities with a short poll.
    const verified = await this.#proveIdentitiesDead(run, 5_000);
    if (verified === 'clean') {
      this.#emit(run, { type: 'cleanup_succeeded', operation });
      this.#settleExit(run, {
        reason: 'force_stop',
        exitCode: null,
        signal: 'SIGKILL',
      });
      return;
    }
    if (verified === 'alive') {
      this.#emit(run, {
        type: 'cleanup_failed',
        operation,
        error:
          'helper died but verified PID+start-time identities are still alive; refuse taskkill',
      });
      this.#settleExit(run, {
        reason: 'force_stop',
        exitCode: null,
        signal: null,
      });
      return;
    }
    // Uncertain / probe unavailable / invalid: never treat as success.
    this.#emit(run, {
      type: 'cleanup_failed',
      operation,
      error:
        verified === 'probe_unavailable'
          ? 'helper died and identity probe is unavailable; refuse unverified PID kill'
          : verified === 'probe_invalid'
            ? 'helper died and identity probe returned invalid data; refuse unverified PID kill'
            : 'helper died and target identity could not be proven clean; refuse unverified PID kill',
    });
    this.#settleExit(run, {
      reason: 'force_stop',
      exitCode: null,
      signal: null,
    });
  }

  /**
   * Before resolving wait/success: prove every known PID+start-time identity is
   * gone. Host tree_clean (Job empty) is necessary but not sufficient.
   * Uncertainty or residual life → cleanup_failed (never silent success).
   */
  async #proveCleanupBeforeSettle(run: ActiveRun): Promise<void> {
    if (run.settled) return;

    const operation: ProcessCleanupOperation =
      run.lastCleanupOperation ?? 'force_stop_tree';
    const hasCleanupIntent =
      run.lastCleanupOperation !== undefined || run.treeCleanSeen;

    // Natural exit with no tree_clean and no stop request: do not invent success.
    // Host should emit tree_clean when the Job empties; if identities remain,
    // fail closed.
    if (!hasCleanupIntent) {
      if (run.knownIdentities.size === 0 && run.knownPids.size === 0) {
        return;
      }
      const verified = await this.#proveIdentitiesDead(run, 5_000);
      if (verified !== 'clean') {
        this.#emit(run, {
          type: 'cleanup_failed',
          operation: 'force_stop_tree',
          error:
            verified === 'alive'
              ? 'natural exit but verified PID+start-time identities still alive'
              : verified === 'probe_unavailable'
                ? 'natural exit and identity probe unavailable'
                : verified === 'probe_invalid'
                  ? 'natural exit and identity probe invalid'
                  : 'natural exit and target identity could not be proven clean',
        });
      }
      return;
    }

    const verified = await this.#proveIdentitiesDead(run, 8_000);
    if (verified === 'clean') {
      this.#emit(run, {
        type: 'cleanup_succeeded',
        operation,
      });
      return;
    }
    if (verified === 'alive') {
      this.#emit(run, {
        type: 'cleanup_failed',
        operation,
        error:
          'one or more verified target identities still alive after exit; refuse taskkill',
      });
      return;
    }
    this.#emit(run, {
      type: 'cleanup_failed',
      operation,
      error:
        verified === 'probe_unavailable'
          ? 'identity probe unavailable after exit; refuse unverified PID kill'
          : verified === 'probe_invalid'
            ? 'identity probe invalid after exit; refuse unverified PID kill'
            : 'could not prove PID+start-time identity cleanup after exit; refuse unverified PID kill',
    });
  }

  /**
   * Poll until identities are clean, residual life persists, or deadline.
   * Condition-based (not a single blind sleep).
   */
  async #proveIdentitiesDead(
    run: ActiveRun,
    timeoutMs: number,
  ): Promise<
    'clean' | 'alive' | 'uncertain' | 'probe_unavailable' | 'probe_invalid'
  > {
    const deadline = Date.now() + timeoutMs;
    let last:
      | 'clean'
      | 'alive'
      | 'uncertain'
      | 'probe_unavailable'
      | 'probe_invalid' = 'uncertain';
    while (Date.now() <= deadline) {
      last = await this.#verifyKnownPidsDead(run);
      if (last === 'clean') return 'clean';
      // Probe failures do not become clean by waiting; fail closed promptly.
      if (last === 'probe_unavailable' || last === 'probe_invalid') {
        return last;
      }
      await delay(40);
    }
    return last;
  }

  /**
   * Verify known identities are gone using PID + start-time.
   * Returns:
   * - clean: all known identities confirmed dead or PID-reused (different start)
   * - alive: at least one verified identity still matches a live process
   * - uncertain: could not prove (no identities recorded, or start-time missing
   *   while PID is still live)
   * - probe_unavailable / probe_invalid: probe infrastructure failed (fail closed)
   */
  async #verifyKnownPidsDead(
    run: ActiveRun,
  ): Promise<
    'clean' | 'alive' | 'uncertain' | 'probe_unavailable' | 'probe_invalid'
  > {
    // Ensure root is in the identity map.
    if (run.identity !== undefined && !run.knownIdentities.has(run.identity.pid)) {
      run.knownIdentities.set(run.identity.pid, run.identity);
    }

    // Opportunistically capture start-times for PIDs we only know by number.
    for (const pid of run.knownPids) {
      if (!run.knownIdentities.has(pid)) {
        const probe = await this.#probePid(pid);
        if (probe.status === 'alive') {
          run.knownIdentities.set(pid, { pid, startedAt: probe.startedAt });
        } else if (
          probe.status === 'probe_unavailable'
          || probe.status === 'probe_invalid'
        ) {
          // Cannot capture identity — fail closed rather than pretend gone.
          return probe.status;
        }
      }
    }

    if (run.knownIdentities.size === 0 && run.knownPids.size === 0) {
      return 'uncertain';
    }

    let anyUncertain = false;
    let anyAlive = false;
    let probeUnavailable = false;
    let probeInvalid = false;

    for (const identity of run.knownIdentities.values()) {
      const probe = await this.#probePid(identity.pid);
      const classification = classifyIdentityLiveness(
        identity.startedAt,
        probe,
      );
      if (classification === 'alive') {
        anyAlive = true;
        continue;
      }
      if (classification === 'gone' || classification === 'reused') {
        continue;
      }
      // uncertain from probe error
      if (probe.status === 'probe_unavailable') {
        probeUnavailable = true;
      } else if (probe.status === 'probe_invalid') {
        probeInvalid = true;
      } else {
        anyUncertain = true;
      }
    }

    // PIDs observed but never given a start-time: if still live → uncertain
    // (refuse success; never taskkill an unverified PID).
    for (const pid of run.knownPids) {
      if (run.knownIdentities.has(pid)) continue;
      const probe = await this.#probePid(pid);
      if (probe.status === 'alive') {
        anyUncertain = true;
      } else if (probe.status === 'probe_unavailable') {
        probeUnavailable = true;
      } else if (probe.status === 'probe_invalid') {
        probeInvalid = true;
      }
    }

    if (anyAlive) return 'alive';
    if (probeUnavailable) return 'probe_unavailable';
    if (probeInvalid) return 'probe_invalid';
    if (anyUncertain) return 'uncertain';
    if (run.knownIdentities.size === 0) return 'uncertain';
    return 'clean';
  }

  async #probePid(pid: number): Promise<IdentityProbeResult> {
    const testRunner = ProcessSupervisor.#testIdentityRunner;
    if (testRunner !== undefined) {
      const raw = await testRunner(pid);
      return interpretIdentityProbe(raw);
    }
    return queryProcessIdentity(pid, this.#identityProbeOptions);
  }

  #notePidsFromOutput(run: ActiveRun, chunk: string): void {
    // Fixture emits parent_pid= / child_pid= / grandchild_pid=
    const patterns = [
      /\bparent_pid=(\d+)\b/gu,
      /\bchild_pid=(\d+)\b/gu,
      /\bchild_self_pid=(\d+)\b/gu,
      /\bgrandchild_pid=(\d+)\b/gu,
    ];
    for (const pattern of patterns) {
      for (const match of chunk.matchAll(pattern)) {
        const pid = Number.parseInt(match[1] ?? '', 10);
        if (Number.isSafeInteger(pid) && pid > 0) {
          // Always track the PID for fail-closed proof even when capture is
          // already pending or complete.
          run.knownPids.add(pid);
          // Capture start-time ASAP so force-stop proof is identity-based.
          // Dedup in-flight captures: fixture may re-emit the same PID (e.g.
          // child_pid + child_self_pid, duplicate grandchild_pid) before the
          // first async CIM probe finishes.
          if (
            !run.knownIdentities.has(pid)
            && !run.pendingIdentityCapturePids.has(pid)
          ) {
            run.pendingIdentityCapturePids.add(pid);
            run.identityCaptureChain = run.identityCaptureChain
              .then(() => this.#captureIdentity(run, pid))
              .catch(() => undefined)
              .finally(() => {
                run.pendingIdentityCapturePids.delete(pid);
              });
          }
        }
      }
    }
  }

  async #captureIdentity(run: ActiveRun, pid: number): Promise<void> {
    try {
      if (run.settled || run.knownIdentities.has(pid)) return;
      // A few quick retries — process may not be queryable on the first tick.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (run.settled || run.knownIdentities.has(pid)) return;
        const probe = await this.#probePid(pid);
        if (probe.status === 'alive') {
          if (!run.knownIdentities.has(pid)) {
            run.knownIdentities.set(pid, { pid, startedAt: probe.startedAt });
          }
          return;
        }
        if (
          probe.status === 'probe_unavailable'
          || probe.status === 'probe_invalid'
        ) {
          // Do not invent a start-time; leave PID in knownPids for fail-closed proof.
          return;
        }
        await delay(30);
      }
    } finally {
      // Always clear pending when this capture task finishes (success, fail, or early return).
      run.pendingIdentityCapturePids.delete(pid);
    }
  }

  /**
   * Settle terminal wait BEFORE notifying listeners of `exited`.
   * Fan-out still reaches every subscriber; failures are deferred and rethrown
   * after the event chain step so wait cannot wedge.
   */
  #settleExit(
    run: ActiveRun,
    details: {
      readonly reason: ProcessExitReason;
      readonly exitCode: number | null;
      readonly signal: string | null;
    },
  ): void {
    if (run.settled) return;
    run.settled = true;
    const pid = run.identity?.pid ?? 0;
    const waitResult: ProcessWaitResult = {
      attemptId: run.attemptId,
      pid,
      exitCode: details.exitCode,
      signal: details.signal,
      reason: details.reason,
      endedAt: new Date().toISOString(),
    };
    // Resolve wait first so throwing listeners cannot prevent settlement.
    run.resolveWait(waitResult);
    this.#emit(run, {
      type: 'exited',
      pid,
      exitCode: details.exitCode,
      signal: details.signal,
      reason: details.reason,
    }, { deferFailures: true });
    run.unsubscribeHost();
    void run.client.dispose().catch(() => undefined);
  }

  #settleCleanupFailed(
    run: ActiveRun,
    operation: ProcessCleanupOperation,
    error: string,
  ): void {
    if (run.settled) return;
    this.#emit(run, { type: 'cleanup_failed', operation, error });
    this.#settleExit(run, {
      reason: operation === 'force_stop_tree' ? 'force_stop' : 'graceful_stop',
      exitCode: null,
      signal: null,
    });
  }

  #emit(
    run: ActiveRun,
    planned: {
      readonly type: ProcessSupervisorEvent['type'];
      readonly [key: string]: unknown;
    },
    options: { readonly deferFailures?: boolean } = {},
  ): void {
    const event = {
      ...planned,
      attemptId: run.attemptId,
      occurredAt: new Date().toISOString(),
    } as ProcessSupervisorEvent;

    const listenerFailures: unknown[] = [];
    for (const listener of this.#listeners.get(run.attemptId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        listenerFailures.push(error);
      }
    }
    if (options.deferFailures === true) {
      run.deferredListenerFailures.push(...listenerFailures);
      return;
    }
    rethrowListenerFailures(listenerFailures);
  }

  #flushDeferredListenerFailures(run: ActiveRun): void {
    const failures = run.deferredListenerFailures.splice(0);
    rethrowListenerFailures(failures);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
