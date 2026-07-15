import type {
  AgentAdapter,
  AgentEvent,
  AgentHealth,
  AgentRequest,
} from '../agent-adapter.js';
import { UnsupportedResumeError } from '../agent-adapter.js';
import type { AgentCapabilities } from '../agent-capabilities.js';
import {
  lookupCompatibility,
  type CompatibilityKey,
  type CompatibilityRecord,
} from '../compatibility-matrix.js';
import {
  SupervisedExecutionHandle,
  type ExecutionHandle,
} from '../execution-handle.js';
import {
  CODEX_CLI_NAME,
  checkCodexHealth,
  type CodexHealthReport,
} from '../health/codex-health.js';
import type { CommandProbe } from '../health/command-probe.js';
import type {
  LaunchAuthorizationIntent,
  LaunchAuthorizationPort,
} from '../launch-authorization-repository.js';
import type { ConversationId, TaskId } from '../../domain/ids.js';
import { resolvePackageResourcePath } from '../../process/native-helper-discovery.js';
import type { ProcessSupervisorPort } from '../../process/process-supervisor-port.js';
import {
  AdapterDisabledError,
  buildCodexCommand,
  shouldOmitCodexOutputSchema,
  type CodexCommandInput,
  type CodexGuardMode,
  type CodexRunIntent,
} from './codex-command.js';
import { parseCodexEventLine } from './codex-events.js';

const DEFAULT_SCHEMA_PATH = resolvePackageResourcePath(
  'schemas/agent-result.schema.json',
  import.meta.url,
);

/**
 * Extended start/resume request: AgentRequest plus Task 13/14 launch bindings.
 * Accepts only an opaque launchAuthorizationId (store-backed one-time nonce).
 * Forgeable WorkerStartGateRecord plain objects are rejected.
 */
export interface CodexRunRequest extends AgentRequest {
  readonly capabilityKey: CompatibilityKey;
  readonly projectGuardDecisionId: string;
  readonly reservedBudgetId: string;
  /** ProjectGuard profile / decision mode. */
  readonly mode: CodexGuardMode;
  readonly nonGit: boolean;
  readonly schemaPath?: string;
  /**
   * Opaque one-time launch authorization id issued by WorkerStartGateVerifier
   * after validating and consuming capability/Guard/Budget/Health evidence.
   * Required before any ProcessSupervisor.start. Resume needs a fresh id.
   */
  readonly launchAuthorizationId?: string;
  /**
   * Task id bound into the launch authorization. Defaults to a stable
   * derivation from attempt when omitted (tests may supply explicitly).
   */
  readonly taskId?: TaskId;
  /** Optional pre-looked-up capability record (tests). */
  readonly capabilityRecord?: CompatibilityRecord;
}

export interface CodexAdapterOptions {
  readonly supervisor: ProcessSupervisorPort;
  /**
   * Store-backed one-time launch authorization port. Required for real starts;
   * missing port ⇒ fail closed with zero ProcessSupervisor start.
   */
  readonly launchAuthorization?: LaunchAuthorizationPort;
  /** Health probe for checkAvailability / discoverCapabilities. */
  readonly healthProbe?: CommandProbe;
  /** Override executable name/path (tests). */
  readonly executable?: string;
  /** Default schema path for --output-schema. */
  readonly schemaPath?: string;
  /**
   * When set, skip live health and use this report for availability/capabilities.
   * Production should leave this unset.
   */
  readonly fixedHealth?: CodexHealthReport;
  /** Optional fixed capabilities (tests); otherwise from matrix/health. */
  readonly fixedCapabilities?: AgentCapabilities;
}

/**
 * Codex CLI adapter for the exact verified 0.144.1 contract.
 * Spawns only through ProcessSupervisorPort (Worker path) — never raw spawn.
 */
export class CodexAdapter implements AgentAdapter {
  public readonly kind = 'codex' as const;

  readonly #supervisor: ProcessSupervisorPort;
  readonly #launchAuthorization?: LaunchAuthorizationPort;
  readonly #healthProbe?: CommandProbe;
  readonly #executable?: string;
  readonly #schemaPath: string;
  readonly #fixedHealth?: CodexHealthReport;
  readonly #fixedCapabilities?: AgentCapabilities;
  readonly #usedAttemptIds = new Set<string>();
  #lastCapabilities: AgentCapabilities | undefined;
  #lastCompatibility: CompatibilityRecord | undefined;

  public constructor(options: CodexAdapterOptions) {
    this.#supervisor = options.supervisor;
    this.#launchAuthorization = options.launchAuthorization;
    this.#healthProbe = options.healthProbe;
    this.#executable = options.executable;
    this.#schemaPath = options.schemaPath ?? DEFAULT_SCHEMA_PATH;
    this.#fixedHealth = options.fixedHealth;
    this.#fixedCapabilities = options.fixedCapabilities;
  }

  public async checkAvailability(): Promise<AgentHealth> {
    const report = await this.#health();
    if (report.status === 'available') {
      return {
        status: 'available',
        ...(report.version === undefined ? {} : { version: report.version }),
      };
    }
    return {
      status: 'unavailable',
      reason: report.reason ?? `codex health status: ${report.status}`,
    };
  }

  public async discoverCapabilities(): Promise<AgentCapabilities> {
    if (this.#fixedCapabilities !== undefined) {
      this.#lastCapabilities = freezeCapabilities(this.#fixedCapabilities);
      return this.#lastCapabilities;
    }
    const report = await this.#health();
    if (report.compatibility !== undefined) {
      this.#lastCompatibility = report.compatibility;
      this.#lastCapabilities = freezeCapabilities(
        report.compatibility.capabilities,
      );
      return this.#lastCapabilities;
    }
    if (
      report.status === 'available'
      && report.version !== undefined
    ) {
      const record = lookupCompatibility({
        cliName: CODEX_CLI_NAME,
        version: report.version,
        platform: report.platform,
      });
      if (record !== undefined) {
        this.#lastCompatibility = record;
        this.#lastCapabilities = freezeCapabilities(record.capabilities);
        return this.#lastCapabilities;
      }
    }
    // Fail closed: unknown ⇒ all features disabled.
    const empty = freezeCapabilities({
      fixedSessionId: false,
      resume: false,
      structuredOutput: false,
      streamJson: false,
      realTimeInput: false,
      nativeSandbox: false,
      nativePermissionRules: false,
      budgetLimit: false,
      turnLimit: false,
      timeLimit: false,
      nonGitProjects: false,
      writeModes: [],
    });
    this.#lastCapabilities = empty;
    return empty;
  }

  public async start(
    request: AgentRequest | CodexRunRequest,
  ): Promise<ExecutionHandle> {
    return this.#launch(request as CodexRunRequest, undefined);
  }

  public async resume(
    conversationId: ConversationId,
    request: AgentRequest | CodexRunRequest,
  ): Promise<ExecutionHandle> {
    const capabilities = this.#lastCapabilities
      ?? await this.discoverCapabilities();
    if (!capabilities.resume) {
      throw new UnsupportedResumeError(this.kind);
    }
    return this.#launch(request as CodexRunRequest, conversationId);
  }

  /**
   * Parse one Codex JSONL line. attemptId must be supplied by the execution
   * handle context — this method alone cannot attribute lines without it.
   * Prefer {@link parseEventForAttempt}.
   */
  public parseEvent(line: string): AgentEvent | null {
    // Without attempt context we cannot safely attribute; return null so the
    // SupervisedExecutionHandle emits a bounded parse_error for the active attempt.
    void line;
    return null;
  }

  /** Preferred parse entry used by SupervisedExecutionHandle via closure. */
  public parseEventForAttempt(
    line: string,
    attemptId: CodexRunRequest['attemptId'],
  ): AgentEvent | null {
    return parseCodexEventLine(line, attemptId);
  }

  /** Last built run intent (tests / diagnostics). */
  public lastRunIntent: CodexRunIntent | undefined;

  async #health(): Promise<CodexHealthReport> {
    if (this.#fixedHealth !== undefined) return this.#fixedHealth;
    if (this.#healthProbe === undefined) {
      return {
        kind: 'codex',
        cliName: CODEX_CLI_NAME,
        status: 'error',
        auth: 'unknown',
        requiresReadinessProbe: false,
        reason: 'CodexAdapter has no health probe configured',
        evidence: [],
        platform: process.platform,
      };
    }
    return checkCodexHealth(this.#healthProbe, {
      ...(this.#executable === undefined
        ? {}
        : { executable: this.#executable }),
    });
  }

  async #launch(
    request: CodexRunRequest,
    conversationId: ConversationId | undefined,
  ): Promise<ExecutionHandle> {
    if (this.#usedAttemptIds.has(request.attemptId)) {
      throw new Error(
        `attempt already used; resume requires a distinct attempt: ${request.attemptId}`,
      );
    }

    this.#assertCodexRequest(request);

    const capabilityRecord =
      request.capabilityRecord
      ?? this.#lastCompatibility
      ?? lookupCompatibility(request.capabilityKey);

    const schemaPath = request.schemaPath ?? this.#schemaPath;
    const omitOutputSchema = shouldOmitCodexOutputSchema();
    const commandInput: CodexCommandInput = {
      capabilityKey: request.capabilityKey,
      capabilityRecord,
      projectRoot: request.projectRoot,
      ...(request.inspectionRoot === undefined
        ? {}
        : { inspectionRoot: request.inspectionRoot }),
      role: request.role,
      mode: request.mode,
      nonGit: request.nonGit,
      schemaPath,
      projectGuardDecisionId: request.projectGuardDecisionId,
      reservedBudgetId: request.reservedBudgetId,
      budgetAttemptId: request.attemptId,
      operation: conversationId === undefined ? 'start' : 'resume',
      emitOutputSchema: !omitOutputSchema,
      ...(conversationId === undefined
        ? {}
        : { conversationId: String(conversationId) }),
      ...(this.#executable === undefined ? {} : { executable: this.#executable }),
    };

    const built = buildCodexCommand(commandInput);
    if (!built.ok) {
      throw new AdapterDisabledError(built.reason);
    }

    // Opaque one-time launch authorization — consume before any supervisor start.
    this.#consumeLaunchAuthorization(request, built.intent, schemaPath);

    this.lastRunIntent = built.intent;
    this.#usedAttemptIds.add(request.attemptId);

    const capabilities = freezeCapabilities(
      capabilityRecord?.capabilities
        ?? this.#lastCapabilities
        ?? {
          fixedSessionId: false,
          resume: built.intent.operation === 'resume',
          structuredOutput: true,
          streamJson: true,
          realTimeInput: false,
          nativeSandbox: true,
          nativePermissionRules: true,
          budgetLimit: false,
          turnLimit: false,
          timeLimit: false,
          nonGitProjects: built.intent.nonGit,
          writeModes: built.intent.sandbox === 'workspace-write'
            ? ['read-only', 'workspace-write']
            : ['read-only'],
        },
    );

    const resultMode = built.intent.structuredPatchRequired
      ? 'patch_mode' as const
      : request.mode;

    // Freeform path (no --output-schema): recover AgentResult from agent_message
    // text / turn.completed, matching custom-provider streams.
    const streamState = {
      textParts: [] as string[],
      sawStructuredResult: false,
    };
    const handle = new SupervisedExecutionHandle({
      attemptId: request.attemptId,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
      capabilities,
      supervisor: this.#supervisor,
      parseEvent: (line) =>
        parseCodexEventLine(line, request.attemptId, {
          resultMode,
          streamState,
          // Only synthesize for implementers; reviewer/master must return parseable
          // AgentResult JSON in freeform text (auto-approve would be unsafe).
          synthesizeCompletedOnEnd:
            omitOutputSchema && request.role === 'implementer',
        }),
    });

    try {
      // ProcessSupervisorPort only — never child_process.spawn directly.
      // Prompt is delivered via one-shot stdin (argv ends with `-`); never
      // place prompt text in argv, shell, or error messages.
      await this.#supervisor.start({
        attemptId: request.attemptId,
        executable: built.executable,
        args: [...built.args],
        // Isolated review/master inspect the candidate tree, not the still-empty
        // canonical project. projectRoot remains the identity root for guards.
        cwd: request.inspectionRoot?.trim() || request.projectRoot,
        ...(request.timeoutMs === undefined
          ? {}
          : { timeoutMs: request.timeoutMs }),
        stdin: {
          encoding: 'utf8',
          data: request.prompt,
          closeAfterWrite: true,
        },
      });
    } catch (error) {
      this.#usedAttemptIds.delete(request.attemptId);
      throw error;
    }

    return handle;
  }

  #assertCodexRequest(request: CodexRunRequest): void {
    // Reject legacy forgeable startGate records entirely.
    if (
      'startGate' in (request as object)
      && (request as { startGate?: unknown }).startGate !== undefined
    ) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Codex rejects forgeable startGate records; '
          + 'pass opaque launchAuthorizationId only',
      );
    }
    if (
      request.capabilityKey === undefined
      || request.projectGuardDecisionId === undefined
      || request.reservedBudgetId === undefined
      || request.mode === undefined
      || request.nonGit === undefined
    ) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Codex run requires capabilityKey, projectGuardDecisionId, '
          + 'reservedBudgetId, mode, and nonGit bindings (Task 13 start gate)',
      );
    }
    if (request.capabilityKey.cliName !== 'codex') {
      throw new AdapterDisabledError(
        'AdapterDisabled: capabilityKey.cliName must be codex',
      );
    }
  }

  /**
   * Fail closed unless an opaque store-backed launch authorization id is present
   * and consumeAndVerify succeeds for the exact request/intent.
   * Missing, forged, mismatched, expired, or reused ⇒ zero ProcessSupervisor start.
   */
  #consumeLaunchAuthorization(
    request: CodexRunRequest,
    intent: CodexRunIntent,
    schemaPath: string,
  ): void {
    if (this.#launchAuthorization === undefined) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Codex start/resume requires injected LaunchAuthorizationPort',
      );
    }
    const authorizationId = request.launchAuthorizationId;
    if (
      authorizationId === undefined
      || typeof authorizationId !== 'string'
      || authorizationId.trim().length === 0
    ) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Codex start/resume requires opaque launchAuthorizationId '
          + '(store-backed one-time authorization); missing launchAuthorizationId',
      );
    }

    const taskId = request.taskId
      ?? (`task-for-${request.attemptId}` as TaskId);

    const launchIntent: LaunchAuthorizationIntent = {
      taskId,
      attemptId: request.attemptId,
      adapterKind: 'codex',
      adapterVersion: intent.capabilityKey.version,
      adapterPlatform: intent.capabilityKey.platform,
      role: request.role,
      mode: intent.mode,
      guardDecisionId: intent.projectGuardDecisionId,
      budgetReservationId: intent.reservedBudgetId,
      schemaPath,
      nonGit: intent.nonGit,
    };

    // Bindings on request must match built intent (fail closed before consume).
    if (request.projectGuardDecisionId !== intent.projectGuardDecisionId) {
      throw new Error(
        'Codex run projectGuardDecisionId does not match built intent',
      );
    }
    if (request.reservedBudgetId !== intent.reservedBudgetId) {
      throw new Error(
        'Codex run reservedBudgetId does not match built intent',
      );
    }
    if (request.mode !== intent.mode && request.mode !== 'auto_allowed') {
      // auto_allowed may map to project_write/read_only in intent.
      if (
        !(request.mode === 'project_write' || request.mode === 'read_only')
      ) {
        throw new Error(
          'Codex run mode does not match built intent',
        );
      }
    }

    const result = this.#launchAuthorization.consumeAndVerify(
      authorizationId,
      launchIntent,
    );
    if (!result.ok) {
      throw new AdapterDisabledError(
        `AdapterDisabled: launch authorization rejected (${result.reason})`,
      );
    }
  }
}

function freezeCapabilities(capabilities: AgentCapabilities): AgentCapabilities {
  return Object.freeze({
    ...capabilities,
    writeModes: Object.freeze([...capabilities.writeModes]),
  });
}
