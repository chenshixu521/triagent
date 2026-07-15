import { randomUUID } from 'node:crypto';

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
  CLAUDE_CLI_NAME,
  checkClaudeHealth,
  type ClaudeHealthReport,
} from '../health/claude-health.js';
import type { CommandProbe } from '../health/command-probe.js';
import type {
  LaunchAuthorizationIntent,
  LaunchAuthorizationPort,
} from '../launch-authorization-repository.js';
import type { AttemptId, ConversationId, TaskId } from '../../domain/ids.js';
import type {
  AgentSessionRepository,
} from '../../persistence/agent-session-repository.js';
import { resolvePackageResourcePath } from '../../process/native-helper-discovery.js';
import type { ProcessSupervisorPort } from '../../process/process-supervisor-port.js';
import {
  AdapterDisabledError,
  buildClaudeCommand,
  extractClaudePermissionProfile,
  hashClaudePermissionProfile,
  type ClaudeCommandInput,
  type ClaudeGuardMode,
  type ClaudeRunIntent,
} from './claude-command.js';
import { parseClaudeEventLine } from './claude-events.js';

const DEFAULT_SCHEMA_PATH = resolvePackageResourcePath(
  'schemas/agent-result.schema.json',
  import.meta.url,
);

/**
 * Extended start/resume request: AgentRequest plus Task 13/14 launch bindings.
 * Accepts only an opaque launchAuthorizationId (store-backed one-time nonce).
 * Forgeable WorkerStartGateRecord plain objects are rejected.
 */
export interface ClaudeRunRequest extends AgentRequest {
  readonly capabilityKey: CompatibilityKey;
  readonly projectGuardDecisionId: string;
  readonly reservedBudgetId: string;
  /** ProjectGuard profile / decision mode. */
  readonly mode: ClaudeGuardMode;
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
  /** Optional fixed session UUID for start (must be valid UUID). */
  readonly sessionId?: string;
  /**
   * @deprecated Prompt is always delivered via stdin for Claude 2.1.206.
   * Setting false is rejected by the command builder.
   */
  readonly promptViaStdin?: boolean;
}

export interface ClaudeAdapterOptions {
  readonly supervisor: ProcessSupervisorPort;
  /**
   * Store-backed one-time launch authorization port. Required for real starts;
   * missing port ⇒ fail closed with zero ProcessSupervisor start.
   */
  readonly launchAuthorization?: LaunchAuthorizationPort;
  /**
   * Store-backed agent session evidence for safe resume.
   * Required for resume; start records active session when present.
   */
  readonly agentSessions?: AgentSessionRepository;
  /** Health probe for checkAvailability / discoverCapabilities. */
  readonly healthProbe?: CommandProbe;
  /** Override executable name/path (tests). */
  readonly executable?: string;
  /** Default schema path for --json-schema content load. */
  readonly schemaPath?: string;
  /**
   * When set, skip live health and use this report for availability/capabilities.
   * Production should leave this unset.
   */
  readonly fixedHealth?: ClaudeHealthReport;
  /** Optional fixed capabilities (tests); otherwise from matrix/health. */
  readonly fixedCapabilities?: AgentCapabilities;
}

export interface MarkAttemptPersistedInput {
  readonly attemptId: AttemptId;
  readonly conversationId: ConversationId;
  readonly exitReason?: 'completed';
  readonly endedAt?: string;
}

export interface MarkAttemptUnresumableInput {
  readonly attemptId: AttemptId;
  readonly conversationId?: ConversationId;
  readonly reason: 'killed_unpersisted' | 'failed' | 'interrupted' | 'timed_out' | 'cancelled';
  readonly endedAt?: string;
}

interface ActiveSessionBinding {
  readonly sessionId: string;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly conversationId: string | undefined;
  readonly permissionProfileHash: string;
}

/**
 * Claude Code adapter for the exact verified 2.1.206 contract.
 * Spawns only through ProcessSupervisorPort (Worker path) — never raw spawn.
 */
export class ClaudeAdapter implements AgentAdapter {
  public readonly kind = 'claude' as const;

  readonly #supervisor: ProcessSupervisorPort;
  readonly #launchAuthorization?: LaunchAuthorizationPort;
  readonly #agentSessions?: AgentSessionRepository;
  readonly #healthProbe?: CommandProbe;
  readonly #executable?: string;
  readonly #schemaPath: string;
  readonly #fixedHealth?: ClaudeHealthReport;
  readonly #fixedCapabilities?: AgentCapabilities;
  readonly #usedAttemptIds = new Set<string>();
  readonly #sessionByAttempt = new Map<string, ActiveSessionBinding>();
  #lastCapabilities: AgentCapabilities | undefined;
  #lastCompatibility: CompatibilityRecord | undefined;

  public constructor(options: ClaudeAdapterOptions) {
    this.#supervisor = options.supervisor;
    this.#launchAuthorization = options.launchAuthorization;
    this.#agentSessions = options.agentSessions;
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
      reason: report.reason ?? `claude health status: ${report.status}`,
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
        cliName: CLAUDE_CLI_NAME,
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
    request: AgentRequest | ClaudeRunRequest,
  ): Promise<ExecutionHandle> {
    return this.#launch(request as ClaudeRunRequest, undefined);
  }

  public async resume(
    conversationId: ConversationId,
    request: AgentRequest | ClaudeRunRequest,
  ): Promise<ExecutionHandle> {
    const capabilities = this.#lastCapabilities
      ?? await this.discoverCapabilities();
    if (!capabilities.resume) {
      throw new UnsupportedResumeError(this.kind);
    }
    const id = String(conversationId).trim();
    if (id.length === 0) {
      throw new AdapterDisabledError(
        'AdapterDisabled: resume requires a persisted non-empty conversation-id; '
          + 'killed/unpersisted turns must start a new conversation (start-new-context)',
      );
    }

    // Require store-backed safe session evidence before any resume launch.
    this.#assertResumableSession(request as ClaudeRunRequest, conversationId);

    return this.#launch(request as ClaudeRunRequest, conversationId);
  }

  /**
   * After a successful completed turn, mark session evidence as
   * completed_persisted so a later resume may proceed.
   */
  public markAttemptPersisted(input: MarkAttemptPersistedInput): void {
    const binding = this.#sessionByAttempt.get(String(input.attemptId));
    if (this.#agentSessions === undefined) {
      throw new AdapterDisabledError(
        'AdapterDisabled: agentSessions repository required to persist resume evidence',
      );
    }
    if (binding === undefined) {
      throw new AdapterDisabledError(
        `AdapterDisabled: no active session binding for attempt ${input.attemptId}`,
      );
    }
    this.#agentSessions.markCompletedAndPersisted({
      sessionId: binding.sessionId,
      attemptId: input.attemptId,
      conversationId: input.conversationId,
      endedAt: input.endedAt ?? new Date().toISOString(),
      exitReason: input.exitReason ?? 'completed',
    });
  }

  /**
   * Mark a killed/failed/unpersisted turn non-resumable. Resume must fail closed
   * and force start-new-context rather than faking --resume.
   */
  public markAttemptUnresumable(input: MarkAttemptUnresumableInput): void {
    const binding = this.#sessionByAttempt.get(String(input.attemptId));
    if (this.#agentSessions === undefined) {
      throw new AdapterDisabledError(
        'AdapterDisabled: agentSessions repository required to mark unresumable',
      );
    }
    if (binding === undefined) {
      throw new AdapterDisabledError(
        `AdapterDisabled: no active session binding for attempt ${input.attemptId}`,
      );
    }
    this.#agentSessions.markUnresumable({
      sessionId: binding.sessionId,
      attemptId: input.attemptId,
      endedAt: input.endedAt ?? new Date().toISOString(),
      reason: input.reason,
    });
  }

  /**
   * Parse one Claude stream-json line. Without attempt context we cannot
   * safely attribute; return null so SupervisedExecutionHandle emits a
   * bounded parse_error for the active attempt.
   */
  public parseEvent(line: string): AgentEvent | null {
    void line;
    return null;
  }

  /** Preferred parse entry used by SupervisedExecutionHandle via closure. */
  public parseEventForAttempt(
    line: string,
    attemptId: ClaudeRunRequest['attemptId'],
  ): AgentEvent | null {
    return parseClaudeEventLine(line, attemptId);
  }

  /** Last built run intent (tests / diagnostics). */
  public lastRunIntent: ClaudeRunIntent | undefined;

  /** Last redacted argv for evidence (tests / diagnostics). */
  public lastArgsForEvidence: readonly string[] | undefined;

  async #health(): Promise<ClaudeHealthReport> {
    if (this.#fixedHealth !== undefined) return this.#fixedHealth;
    if (this.#healthProbe === undefined) {
      return {
        kind: 'claude',
        cliName: CLAUDE_CLI_NAME,
        status: 'error',
        auth: 'unknown',
        requiresReadinessProbe: false,
        reason: 'ClaudeAdapter has no health probe configured',
        evidence: [],
        platform: process.platform,
      };
    }
    return checkClaudeHealth(this.#healthProbe, {
      ...(this.#executable === undefined
        ? {}
        : { executable: this.#executable }),
    });
  }

  #assertResumableSession(
    request: ClaudeRunRequest,
    conversationId: ConversationId,
  ): void {
    if (this.#agentSessions === undefined) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Claude resume requires injected AgentSessionRepository '
          + 'with persisted safe session evidence; start-new-context without evidence',
      );
    }
    const taskId = request.taskId
      ?? (`task-for-${request.attemptId}` as TaskId);
    const found = this.#agentSessions.findResumable({
      taskId,
      agentKind: 'claude',
      conversationId,
      adapterVersion: request.capabilityKey.version,
      adapterPlatform: request.capabilityKey.platform,
    });
    if (found === undefined) {
      throw new AdapterDisabledError(
        'AdapterDisabled: no persisted safe session evidence for resume '
          + `(task/adapter/conversation mismatch, killed, or unpersisted); `
          + 'decision=start-new-context',
      );
    }
    if (!found.resumable || found.status !== 'completed_persisted') {
      throw new AdapterDisabledError(
        'AdapterDisabled: session evidence is not safely resumable '
          + `(status=${found.status}); decision=start-new-context`,
      );
    }
  }

  async #launch(
    request: ClaudeRunRequest,
    conversationId: ConversationId | undefined,
  ): Promise<ExecutionHandle> {
    if (this.#usedAttemptIds.has(request.attemptId)) {
      throw new Error(
        `attempt already used; resume requires a distinct attempt: ${request.attemptId}`,
      );
    }

    this.#assertClaudeRequest(request);

    const capabilityRecord =
      request.capabilityRecord
      ?? this.#lastCompatibility
      ?? lookupCompatibility(request.capabilityKey);

    const schemaPath = request.schemaPath ?? this.#schemaPath;
    const commandInput: ClaudeCommandInput = {
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
      prompt: request.prompt,
      ...(conversationId === undefined
        ? {}
        : { conversationId: String(conversationId) }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.promptViaStdin === undefined
        ? {}
        : { promptViaStdin: request.promptViaStdin }),
      ...(this.#executable === undefined ? {} : { executable: this.#executable }),
    };

    const built = buildClaudeCommand(commandInput);
    if (!built.ok) {
      throw new AdapterDisabledError(built.reason);
    }

    // Opaque one-time launch authorization — consume before any supervisor start.
    // Bind against the request schema path (same value used when issuing auth),
    // not the resolved patch/result path used for --json-schema content.
    this.#consumeLaunchAuthorization(request, built.intent, schemaPath);

    this.lastRunIntent = built.intent;
    this.lastArgsForEvidence = built.argsForEvidence;
    this.#usedAttemptIds.add(request.attemptId);

    const taskId = request.taskId
      ?? (`task-for-${request.attemptId}` as TaskId);
    const profile = extractClaudePermissionProfile(built);
    const permissionProfileHash = hashClaudePermissionProfile(profile);
    const sessionConversationId =
      conversationId === undefined
        ? (built.intent.sessionId as string | undefined)
        : String(conversationId);

    if (this.#agentSessions !== undefined && conversationId === undefined) {
      // Record active session evidence for start; resume requires a later
      // markAttemptPersisted after a completed turn.
      const sessionId = randomUUID();
      this.#agentSessions.create({
        sessionId,
        taskId,
        role: request.role,
        agentKind: 'claude',
        ...(sessionConversationId === undefined
          ? {}
          : { conversationId: sessionConversationId as ConversationId }),
        attemptId: request.attemptId,
        adapterVersion: request.capabilityKey.version,
        adapterPlatform: request.capabilityKey.platform,
        mode: built.intent.mode,
        permissionProfileHash,
        guardDecisionId: built.intent.projectGuardDecisionId,
        status: 'active',
        startedAt: new Date().toISOString(),
      });
      this.#sessionByAttempt.set(String(request.attemptId), {
        sessionId,
        taskId,
        attemptId: request.attemptId,
        conversationId: sessionConversationId,
        permissionProfileHash,
      });
    } else if (this.#agentSessions !== undefined && conversationId !== undefined) {
      // Resume path: bind new attempt to existing resumable session id if present.
      const existing = this.#agentSessions.findResumable({
        taskId,
        agentKind: 'claude',
        conversationId,
        adapterVersion: request.capabilityKey.version,
        adapterPlatform: request.capabilityKey.platform,
      });
      if (existing !== undefined) {
        this.#sessionByAttempt.set(String(request.attemptId), {
          sessionId: existing.sessionId,
          taskId,
          attemptId: request.attemptId,
          conversationId: String(conversationId),
          permissionProfileHash,
        });
      }
    }

    const capabilities = freezeCapabilities(
      capabilityRecord?.capabilities
        ?? this.#lastCapabilities
        ?? {
          fixedSessionId: true,
          resume: built.intent.operation === 'resume',
          structuredOutput: true,
          streamJson: true,
          realTimeInput: false,
          nativeSandbox: false,
          nativePermissionRules: true,
          budgetLimit: false,
          turnLimit: false,
          timeLimit: false,
          nonGitProjects: built.intent.nonGit,
          writeModes: ['read-only'],
        },
    );

    const resultMode = built.intent.structuredPatchRequired
      ? 'patch_mode' as const
      : request.mode === 'patch_mode'
        ? 'patch_mode' as const
        : 'default';

    const handle = new SupervisedExecutionHandle({
      attemptId: request.attemptId,
      ...(conversationId === undefined
        ? (built.intent.sessionId === undefined
          ? {}
          : { conversationId: built.intent.sessionId as ConversationId })
        : { conversationId }),
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
      capabilities,
      supervisor: this.#supervisor,
      parseEvent: (line) =>
        parseClaudeEventLine(line, request.attemptId, { resultMode }),
    });

    try {
      // ProcessSupervisorPort only — never child_process.spawn directly.
      // Prompt via one-shot stdin (--input-format text); never in argv.
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
          data: built.stdinPayload.data,
          closeAfterWrite: built.stdinPayload.closeAfterWrite !== false,
        },
      });
    } catch (error) {
      this.#usedAttemptIds.delete(request.attemptId);
      throw error;
    }

    return handle;
  }

  #assertClaudeRequest(request: ClaudeRunRequest): void {
    if (
      'startGate' in (request as object)
      && (request as { startGate?: unknown }).startGate !== undefined
    ) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Claude rejects forgeable startGate records; '
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
        'AdapterDisabled: Claude run requires capabilityKey, projectGuardDecisionId, '
          + 'reservedBudgetId, mode, and nonGit bindings (Task 13 start gate)',
      );
    }
    if (request.capabilityKey.cliName !== 'claude') {
      throw new AdapterDisabledError(
        'AdapterDisabled: capabilityKey.cliName must be claude',
      );
    }
  }

  /**
   * Fail closed unless an opaque store-backed launch authorization id is present
   * and consumeAndVerify succeeds for the exact request/intent.
   * Missing, forged, mismatched, expired, or reused ⇒ zero ProcessSupervisor start.
   */
  #consumeLaunchAuthorization(
    request: ClaudeRunRequest,
    intent: ClaudeRunIntent,
    schemaPath: string,
  ): void {
    if (this.#launchAuthorization === undefined) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Claude start/resume requires injected LaunchAuthorizationPort',
      );
    }
    const authorizationId = request.launchAuthorizationId;
    if (
      authorizationId === undefined
      || typeof authorizationId !== 'string'
      || authorizationId.trim().length === 0
    ) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Claude start/resume requires opaque launchAuthorizationId '
          + '(store-backed one-time authorization); missing launchAuthorizationId',
      );
    }

    const taskId = request.taskId
      ?? (`task-for-${request.attemptId}` as TaskId);

    // Authorization mode must match what was issued. Callers issue auth for the
    // request mode; intent may normalize auto_allowed → patch_mode.
    const authMode = request.mode;

    const launchIntent: LaunchAuthorizationIntent = {
      taskId,
      attemptId: request.attemptId,
      adapterKind: 'claude',
      adapterVersion: intent.capabilityKey.version,
      adapterPlatform: intent.capabilityKey.platform,
      role: request.role,
      mode: authMode,
      guardDecisionId: intent.projectGuardDecisionId,
      budgetReservationId: intent.reservedBudgetId,
      schemaPath,
      nonGit: intent.nonGit,
    };

    if (request.projectGuardDecisionId !== intent.projectGuardDecisionId) {
      throw new Error(
        'Claude run projectGuardDecisionId does not match built intent',
      );
    }
    if (request.reservedBudgetId !== intent.reservedBudgetId) {
      throw new Error(
        'Claude run reservedBudgetId does not match built intent',
      );
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
