import { randomUUID } from 'node:crypto';

import type {
  AgentAdapter,
  AgentEvent,
  AgentHealth,
  AgentRequest,
  AgentRunResult,
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
  GROK_CLI_NAME,
  checkGrokHealth,
  type GrokHealthReport,
} from '../health/grok-health.js';
import type { CommandProbe } from '../health/command-probe.js';
import type {
  LaunchAuthorizationIntent,
  LaunchAuthorizationPort,
} from '../launch-authorization-repository.js';
import type { AttemptId, ConversationId, TaskId } from '../../domain/ids.js';
import type {
  AgentSessionRecord,
  AgentSessionRepository,
} from '../../persistence/agent-session-repository.js';
import { resolvePackageResourcePath } from '../../process/native-helper-discovery.js';
import type { ProcessSupervisorPort } from '../../process/process-supervisor-port.js';
import type { ImmutableReviewBundleRef } from '../../protocol/immutable-review-bundle.js';
import {
  AdapterDisabledError,
  SensitiveArtifactCleanupError,
  buildGrokCommand,
  extractGrokPermissionProfile,
  hashGrokPermissionProfile,
  resolveGrokPatchSchemaPath,
  type GrokCommandInput,
  type GrokGuardMode,
  type GrokPromptCleanupResult,
  type GrokRunIntent,
} from './grok-command.js';
import { parseGrokEventLine } from './grok-events.js';
import {
  registerLoadedGrokEnforcementProof,
} from './grok-enforcement-proof.js';
import {
  createDefaultPromptArtifactStore,
  type PromptArtifactRef,
  type PromptArtifactStore,
  PromptArtifactStoreError,
} from './prompt-artifact-store.js';

// Re-export for tests that load proofs via adapter package surface.
export { registerLoadedGrokEnforcementProof };

const DEFAULT_SCHEMA_PATH = resolvePackageResourcePath(
  'schemas/agent-result.schema.json',
  import.meta.url,
);

/**
 * Extended start/resume request: AgentRequest plus Task 13/14 launch bindings.
 * Accepts only an opaque launchAuthorizationId (store-backed one-time nonce).
 * Forgeable WorkerStartGateRecord plain objects are rejected.
 */
export interface GrokRunRequest extends AgentRequest {
  readonly capabilityKey: CompatibilityKey;
  readonly projectGuardDecisionId: string;
  readonly reservedBudgetId: string;
  /** ProjectGuard profile / decision mode. */
  readonly mode: GrokGuardMode;
  readonly nonGit: boolean;
  readonly schemaPath?: string;
  /**
   * Opaque one-time launch authorization id issued by WorkerStartGateVerifier
   * after validating and consuming capability/Guard/Budget/Health evidence.
   * Required before any ProcessSupervisor.start. Resume needs a fresh id.
   * Consumed BEFORE any prompt file is created.
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
  /** Optional max turns override when capability.turnLimit is verified. */
  readonly maxTurns?: number;
  /**
   * @deprecated Prompt is always delivered via --prompt-file for Grok 0.2.93.
   * Setting false is rejected by the command builder.
   */
  readonly promptViaFile?: boolean;
  /**
   * Narrow immutable review bundle reference/manifest (Task 17 builds full bundles).
   * Required: --cwd is routed only to this bundle; never the live project.
   */
  readonly immutableReviewBundle?: ImmutableReviewBundleRef;
}

export interface GrokAdapterOptions {
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
  /** Default schema path for launch-authorization binding. */
  readonly schemaPath?: string;
  /**
   * When set, skip live health and use this report for availability/capabilities.
   * Production should leave this unset.
   */
  readonly fixedHealth?: GrokHealthReport;
  /** Optional fixed capabilities (tests); otherwise from matrix/health. */
  readonly fixedCapabilities?: AgentCapabilities;
  /** Optional directory for secure prompt files (tests). */
  readonly promptFileDirectory?: string;
  /**
   * Optional pre-verified PromptArtifactStore. When omitted, adapter builds a
   * verified store from promptFileDirectory (or default outside-project base).
   * No insecure fallback is allowed.
   */
  readonly promptArtifactStore?: import('./prompt-artifact-store.js').PromptArtifactStore;
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
  cleanupPromptFile?: () => GrokPromptCleanupResult;
  cleanupDone?: boolean;
  lastCleanupFailure?: GrokPromptCleanupResult & { ok: false };
}

/**
 * Grok CLI adapter for the exact verified 0.2.93 contract.
 * Spawns only through ProcessSupervisorPort (Worker path) — never raw spawn.
 * LaunchAuthorization is consumed BEFORE any prompt file is created.
 * --cwd is always an immutable review bundle (never live project).
 */
export class GrokAdapter implements AgentAdapter {
  public readonly kind = 'grok' as const;

  readonly #supervisor: ProcessSupervisorPort;
  readonly #launchAuthorization?: LaunchAuthorizationPort;
  readonly #agentSessions?: AgentSessionRepository;
  readonly #healthProbe?: CommandProbe;
  readonly #executable?: string;
  readonly #schemaPath: string;
  readonly #fixedHealth?: GrokHealthReport;
  readonly #fixedCapabilities?: AgentCapabilities;
  readonly #promptFileDirectory?: string;
  readonly #promptArtifactStoreOption?: PromptArtifactStore;
  readonly #usedAttemptIds = new Set<string>();
  readonly #sessionByAttempt = new Map<string, ActiveSessionBinding>();
  readonly #storeByProjectRoot = new Map<string, PromptArtifactStore>();
  #lastCapabilities: AgentCapabilities | undefined;
  #lastCompatibility: CompatibilityRecord | undefined;

  public constructor(options: GrokAdapterOptions) {
    this.#supervisor = options.supervisor;
    this.#launchAuthorization = options.launchAuthorization;
    this.#agentSessions = options.agentSessions;
    this.#healthProbe = options.healthProbe;
    this.#executable = options.executable;
    this.#schemaPath = options.schemaPath ?? DEFAULT_SCHEMA_PATH;
    this.#fixedHealth = options.fixedHealth;
    this.#fixedCapabilities = options.fixedCapabilities;
    this.#promptFileDirectory = options.promptFileDirectory;
    this.#promptArtifactStoreOption = options.promptArtifactStore;
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
      reason: report.reason ?? `grok health status: ${report.status}`,
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
        cliName: GROK_CLI_NAME,
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
    request: AgentRequest | GrokRunRequest,
  ): Promise<ExecutionHandle> {
    return this.#launch(request as GrokRunRequest, undefined);
  }

  public async resume(
    conversationId: ConversationId,
    request: AgentRequest | GrokRunRequest,
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
    // Permission-profile hash equivalence is enforced inside #launch after the
    // dry command build (current hash) and before auth / supervisor start.
    const resumableSession = this.#assertResumableSession(
      request as GrokRunRequest,
      conversationId,
    );

    return this.#launch(
      request as GrokRunRequest,
      conversationId,
      resumableSession,
    );
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
    this.#cleanupBinding(binding);
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
    this.#cleanupBinding(binding);
  }

  /**
   * Bounded cleanup for abandoned handles (force-stop / process death).
   * Surfaces sensitive_artifact_cleanup_failed when unlink permanently fails.
   */
  public cleanupAbandonedAttempt(attemptId: AttemptId): GrokPromptCleanupResult {
    const binding = this.#sessionByAttempt.get(String(attemptId));
    if (binding === undefined) {
      return { ok: true };
    }
    return this.#cleanupBinding(binding);
  }

  /**
   * Parse one Grok streaming-json line. Without attempt context we cannot
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
    attemptId: GrokRunRequest['attemptId'],
  ): AgentEvent | null {
    return parseGrokEventLine(line, attemptId);
  }

  /** Last built run intent (tests / diagnostics). */
  public lastRunIntent: GrokRunIntent | undefined;

  /** Last redacted argv for evidence (tests / diagnostics). */
  public lastArgsForEvidence: readonly string[] | undefined;

  /** Last prompt file path (tests / diagnostics). */
  public lastPromptFilePath: string | undefined;

  /** Last cleanup failure (tests / diagnostics). */
  public lastCleanupFailure:
    | (GrokPromptCleanupResult & { ok: false })
    | undefined;

  async #health(): Promise<GrokHealthReport> {
    if (this.#fixedHealth !== undefined) return this.#fixedHealth;
    if (this.#healthProbe === undefined) {
      return {
        kind: 'grok',
        cliName: GROK_CLI_NAME,
        status: 'error',
        auth: 'unknown',
        requiresReadinessProbe: true,
        reason: 'GrokAdapter has no health probe configured',
        evidence: [],
        platform: process.platform,
      };
    }
    return checkGrokHealth(this.#healthProbe, {
      ...(this.#executable === undefined
        ? {}
        : { executable: this.#executable }),
    });
  }

  #assertResumableSession(
    request: GrokRunRequest,
    conversationId: ConversationId,
  ): AgentSessionRecord {
    if (this.#agentSessions === undefined) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Grok resume requires injected AgentSessionRepository '
          + 'with persisted safe session evidence; start-new-context without evidence',
      );
    }
    const taskId = request.taskId
      ?? (`task-for-${request.attemptId}` as TaskId);
    const found = this.#agentSessions.findResumable({
      taskId,
      agentKind: 'grok',
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
    return found;
  }

  /**
   * Resume permission-profile equivalence: current dry-built hash must exactly
   * equal the stored completed_persisted permissionProfileHash. Divergent
   * stable security fields (role/mode/maxTurns/tools/permission/cwd/bundle/
   * capability version/platform) force start-new-context with zero
   * ProcessSupervisor start. Fresh launch auth is necessary but not sufficient.
   *
   * Per-launch projectGuardDecisionId / reservedBudgetId are NOT part of this
   * hash; they are rebound and validated via one-time LaunchAuthorization.
   */
  #assertResumePermissionProfileEquivalence(
    stored: AgentSessionRecord,
    currentHash: string,
  ): void {
    const storedHash = stored.permissionProfileHash;
    if (
      storedHash === undefined
      || storedHash.trim().length === 0
      || storedHash !== currentHash
    ) {
      throw new AdapterDisabledError(
        'AdapterDisabled: resume permission profile hash mismatch '
          + `(stored=${storedHash ?? 'missing'} current=${currentHash}); `
          + 'changed role, effective mode, maxTurns, tools, permission mode, '
          + 'execution root/bundle, output format, prompt delivery, or '
          + 'capability version/platform force decision=start-new-context',
      );
    }
  }

  async #launch(
    request: GrokRunRequest,
    conversationId: ConversationId | undefined,
    resumableSession?: AgentSessionRecord,
  ): Promise<ExecutionHandle> {
    if (this.#usedAttemptIds.has(request.attemptId)) {
      throw new Error(
        `attempt already used; resume requires a distinct attempt: ${request.attemptId}`,
      );
    }

    this.#assertGrokRequest(request);

    const capabilityRecord =
      request.capabilityRecord
      ?? this.#lastCompatibility
      ?? lookupCompatibility(request.capabilityKey);

    const schemaPath = request.schemaPath ?? this.#schemaPath;
    // Auth binding schema: patch_mode implementer binds patch schema path.
    const authSchemaPath =
      request.mode === 'patch_mode' && request.role === 'implementer'
        ? resolveGrokPatchSchemaPath(schemaPath)
        : request.mode === 'auto_allowed' && request.role === 'implementer'
          ? resolveGrokPatchSchemaPath(schemaPath)
          : schemaPath;

    // Phase 1: pure structural dry-run (no PromptArtifactRef ⇒ no FS/ACL work).
    // Auth must succeed before any sensitive prompt artifact exists.
    const dryInput = this.#commandInput(
      request,
      conversationId,
      capabilityRecord,
      authSchemaPath,
    );
    const dryBuilt = buildGrokCommand(dryInput);
    if (!dryBuilt.ok) {
      throw new AdapterDisabledError(dryBuilt.reason);
    }

    // Resume profile equivalence BEFORE auth consume / supervisor start.
    // Fresh auth is necessary later but not sufficient for mismatched profiles.
    if (conversationId !== undefined) {
      const session =
        resumableSession
        ?? this.#assertResumableSession(request, conversationId);
      const currentHash = hashGrokPermissionProfile(
        extractGrokPermissionProfile(dryBuilt),
      );
      this.#assertResumePermissionProfileEquivalence(session, currentHash);
    }

    // Phase 2: consume one-time LaunchAuthorization BEFORE prompt artifact create.
    try {
      this.#consumeLaunchAuthorization(request, dryBuilt.intent, schemaPath);
    } catch (error) {
      // Auth rejected/mismatch ⇒ no prompt file was created.
      throw error;
    }

    // Phase 3: SecurePromptArtifactStore creates/verifies artifact once, then
    // pure builder consumes the verified PromptArtifactRef (zero OS work).
    let artifact: PromptArtifactRef;
    try {
      const store = this.#verifiedPromptStore(request.projectRoot);
      artifact = store.createPromptFile({
        prompt: request.prompt,
        projectRoot: request.projectRoot,
      });
    } catch (error) {
      if (error instanceof PromptArtifactStoreError) {
        throw new AdapterDisabledError(
          `AdapterDisabled: secure prompt artifact create failed: ${error.message}`,
        );
      }
      throw new AdapterDisabledError(
        `AdapterDisabled: secure prompt artifact create failed: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }

    const liveInput = this.#commandInput(
      request,
      conversationId,
      capabilityRecord,
      authSchemaPath,
      artifact,
    );
    const built = buildGrokCommand(liveInput);
    if (!built.ok) {
      artifact.cleanup();
      throw new AdapterDisabledError(built.reason);
    }

    this.lastRunIntent = built.intent;
    this.lastArgsForEvidence = built.argsForEvidence;
    this.lastPromptFilePath = built.promptFilePath;
    this.#usedAttemptIds.add(request.attemptId);

    const taskId = request.taskId
      ?? (`task-for-${request.attemptId}` as TaskId);
    const profile = extractGrokPermissionProfile(built);
    const permissionProfileHash = hashGrokPermissionProfile(profile);
    const sessionConversationId =
      conversationId === undefined
        ? (built.intent.sessionId as string | undefined)
        : String(conversationId);

    if (this.#agentSessions !== undefined && conversationId === undefined) {
      const sessionId = randomUUID();
      this.#agentSessions.create({
        sessionId,
        taskId,
        role: request.role,
        agentKind: 'grok',
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
        cleanupPromptFile: built.cleanupPromptFile,
        cleanupDone: false,
      });
    } else if (this.#agentSessions !== undefined && conversationId !== undefined) {
      const existing = this.#agentSessions.findResumable({
        taskId,
        agentKind: 'grok',
        conversationId,
        adapterVersion: request.capabilityKey.version,
        adapterPlatform: request.capabilityKey.platform,
      });
      this.#sessionByAttempt.set(String(request.attemptId), {
        sessionId: existing?.sessionId ?? randomUUID(),
        taskId,
        attemptId: request.attemptId,
        conversationId: String(conversationId),
        permissionProfileHash,
        cleanupPromptFile: built.cleanupPromptFile,
        cleanupDone: false,
      });
    } else {
      this.#sessionByAttempt.set(String(request.attemptId), {
        sessionId: randomUUID(),
        taskId,
        attemptId: request.attemptId,
        conversationId: sessionConversationId,
        permissionProfileHash,
        cleanupPromptFile: built.cleanupPromptFile,
        cleanupDone: false,
      });
    }

    // Capability record for the handle: keep matrix truth (often writeModes=[]).
    const capabilities = freezeCapabilities(
      capabilityRecord?.capabilities
        ?? this.#lastCapabilities
        ?? {
          fixedSessionId: true,
          resume: built.intent.operation === 'resume',
          structuredOutput: false,
          streamJson: true,
          realTimeInput: false,
          nativeSandbox: false,
          nativePermissionRules: false,
          budgetLimit: false,
          turnLimit: true,
          timeLimit: false,
          nonGitProjects: built.intent.nonGit,
          writeModes: [],
        },
    );

    const resultMode = built.intent.structuredPatchRequired
      ? 'patch_mode' as const
      : request.mode === 'patch_mode'
        ? 'patch_mode' as const
        : 'default';

    const activeBinding = this.#sessionByAttempt.get(String(request.attemptId));

    // Grok 0.2.x streams text/thought/end without a structured result event when
    // matrix structuredOutput=false. Accumulate text and synthesize EndTurn
    // results only for isolated workspace_write implementers.
    const streamState = {
      textParts: [] as string[],
      sawStructuredResult: false,
    };
    const synthesizeCompletedOnEnd =
      request.mode === 'workspace_write' && request.role === 'implementer';
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
        parseGrokEventLine(line, request.attemptId, {
          resultMode,
          streamState,
          synthesizeCompletedOnEnd,
        }),
    });

    // Wrap wait/stop/force so prompt cleanup always runs (finally).
    const wrapped = this.#wrapHandle(handle, activeBinding);

    try {
      // ProcessSupervisorPort only — never child_process.spawn directly.
      // cwd is the immutable review bundle root — never live projectRoot.
      await this.#supervisor.start({
        attemptId: request.attemptId,
        executable: built.executable,
        args: [...built.args],
        cwd: built.intent.cwd,
        ...(request.timeoutMs === undefined
          ? {}
          : { timeoutMs: request.timeoutMs }),
      });
    } catch (error) {
      this.#usedAttemptIds.delete(request.attemptId);
      const cleanup = this.#cleanupBinding(activeBinding);
      this.#sessionByAttempt.delete(String(request.attemptId));
      if (cleanup.ok === false) {
        throw new SensitiveArtifactCleanupError(
          cleanup.reason,
          cleanup.pathRedacted,
        );
      }
      throw error;
    }

    return wrapped;
  }

  #verifiedPromptStore(projectRoot: string): PromptArtifactStore {
    if (this.#promptArtifactStoreOption !== undefined) {
      return this.#promptArtifactStoreOption;
    }
    const key = projectRoot;
    const cached = this.#storeByProjectRoot.get(key);
    if (cached !== undefined) return cached;
    try {
      const store = createDefaultPromptArtifactStore(
        projectRoot,
        this.#promptFileDirectory,
      );
      this.#storeByProjectRoot.set(key, store);
      return store;
    } catch (error) {
      if (error instanceof PromptArtifactStoreError) {
        throw new AdapterDisabledError(
          `AdapterDisabled: verified PromptArtifactStore required: ${error.message}`,
        );
      }
      throw new AdapterDisabledError(
        `AdapterDisabled: verified PromptArtifactStore required: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  #commandInput(
    request: GrokRunRequest,
    conversationId: ConversationId | undefined,
    capabilityRecord: CompatibilityRecord | undefined,
    authSchemaPath: string,
    promptArtifact?: PromptArtifactRef,
  ): GrokCommandInput {
    const taskId = request.taskId
      ?? (`task-for-${request.attemptId}` as TaskId);
    // Map orchestrator/coordinator isolated bindings into the command-builder
    // isolatedWorkspace ref (workspace_write mode requires this object).
    const isolatedWorkspace =
      request.mode === 'workspace_write'
      || request.executionScope === 'isolated_implementation'
        ? (() => {
            const workspaceRoot = request.executionRoot?.trim() ?? '';
            const authorizationId = request.workspaceAuthorizationId?.trim() ?? '';
            const sourceManifestHash =
              request.sourceManifestHash?.trim().toLowerCase() ?? '';
            if (
              workspaceRoot.length === 0
              || authorizationId.length === 0
              || sourceManifestHash.length === 0
            ) {
              return undefined;
            }
            return {
              workspaceRoot,
              authorizationId,
              sourceManifestHash,
            };
          })()
        : undefined;
    return {
      capabilityKey: request.capabilityKey,
      capabilityRecord,
      projectRoot: request.projectRoot,
      role: request.role,
      mode: request.mode,
      nonGit: request.nonGit,
      schemaPath: authSchemaPath,
      projectGuardDecisionId: request.projectGuardDecisionId,
      reservedBudgetId: request.reservedBudgetId,
      budgetAttemptId: request.attemptId,
      taskId,
      operation: conversationId === undefined ? 'start' : 'resume',
      prompt: request.prompt,
      ...(promptArtifact === undefined ? {} : { promptArtifact }),
      ...(conversationId === undefined
        ? {}
        : { conversationId: String(conversationId) }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
      ...(request.promptViaFile === undefined
        ? {}
        : { promptViaFile: request.promptViaFile }),
      ...(this.#executable === undefined ? {} : { executable: this.#executable }),
      ...(request.immutableReviewBundle === undefined
        ? {}
        : { immutableReviewBundle: request.immutableReviewBundle }),
      ...(isolatedWorkspace === undefined ? {} : { isolatedWorkspace }),
    };
  }

  #wrapHandle(
    handle: SupervisedExecutionHandle,
    binding: ActiveSessionBinding | undefined,
  ): ExecutionHandle {
    const adapter = this;
    return {
      attemptId: handle.attemptId,
      events: () => handle.events(),
      sendMessage: (content) => handle.sendMessage(content),
      requestStop: async () => {
        try {
          await handle.requestStop();
        } finally {
          adapter.#cleanupBinding(binding);
        }
      },
      forceKillTree: async () => {
        try {
          await handle.forceKillTree();
        } finally {
          adapter.#cleanupBinding(binding);
        }
      },
      wait: async (): Promise<AgentRunResult> => {
        // Always settle the underlying wait (listener settlement) first, then
        // run prompt cleanup. Cleanup failure must not be silent: surface a
        // failed/invalid run while preserving prior raw evidence fields.
        let settled: AgentRunResult;
        try {
          settled = await handle.wait();
        } catch (error) {
          const cleanup = adapter.#cleanupBinding(binding);
          if (cleanup.ok === false) {
            const prior =
              error instanceof Error ? error.message : String(error);
            throw new SensitiveArtifactCleanupError(
              `${cleanup.reason}; prior wait error: ${prior}`,
              cleanup.pathRedacted,
            );
          }
          throw error;
        }
        const cleanup = adapter.#cleanupBinding(binding);
        if (cleanup.ok === false) {
          const priorError =
            settled.error === undefined || settled.error.trim().length === 0
              ? undefined
              : settled.error;
          return Object.freeze({
            ...settled,
            status: 'failed' as const,
            error:
              `${cleanup.reason}`
              + (priorError === undefined
                ? ''
                : `; priorStatus=${settled.status}; priorError=${priorError}`)
              + `; pathRedacted=${cleanup.pathRedacted}`,
          });
        }
        return settled;
      },
    };
  }

  #cleanupBinding(
    binding: ActiveSessionBinding | undefined,
  ): GrokPromptCleanupResult {
    if (binding === undefined) return { ok: true };
    if (binding.cleanupDone) {
      return binding.lastCleanupFailure ?? { ok: true };
    }
    binding.cleanupDone = true;
    if (binding.cleanupPromptFile === undefined) {
      return { ok: true };
    }
    const result = binding.cleanupPromptFile();
    binding.cleanupPromptFile = undefined;
    if (result.ok === false) {
      binding.lastCleanupFailure = result;
      this.lastCleanupFailure = result;
    }
    return result;
  }

  #assertGrokRequest(request: GrokRunRequest): void {
    if (
      'startGate' in (request as object)
      && (request as { startGate?: unknown }).startGate !== undefined
    ) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Grok rejects forgeable startGate records; '
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
        'AdapterDisabled: Grok run requires capabilityKey, projectGuardDecisionId, '
          + 'reservedBudgetId, mode, and nonGit bindings (Task 13 start gate)',
      );
    }
    if (request.capabilityKey.cliName !== 'grok') {
      throw new AdapterDisabledError(
        'AdapterDisabled: capabilityKey.cliName must be grok',
      );
    }
  }

  /**
   * Fail closed unless an opaque store-backed launch authorization id is present
   * and consumeAndVerify succeeds for the exact request/intent.
   * Missing, forged, mismatched, expired, or reused ⇒ zero ProcessSupervisor start
   * and zero prompt-file creation (caller must invoke before createPromptFile).
   */
  #consumeLaunchAuthorization(
    request: GrokRunRequest,
    intent: GrokRunIntent,
    schemaPath: string,
  ): void {
    if (this.#launchAuthorization === undefined) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Grok start/resume requires injected LaunchAuthorizationPort',
      );
    }
    const authorizationId = request.launchAuthorizationId;
    if (
      authorizationId === undefined
      || typeof authorizationId !== 'string'
      || authorizationId.trim().length === 0
    ) {
      throw new AdapterDisabledError(
        'AdapterDisabled: Grok start/resume requires opaque launchAuthorizationId '
          + '(store-backed one-time authorization); missing launchAuthorizationId',
      );
    }

    const taskId = request.taskId
      ?? (`task-for-${request.attemptId}` as TaskId);

    const authMode = request.mode;

    const launchIntent: LaunchAuthorizationIntent = {
      taskId,
      attemptId: request.attemptId,
      adapterKind: 'grok',
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
        'Grok run projectGuardDecisionId does not match built intent',
      );
    }
    if (request.reservedBudgetId !== intent.reservedBudgetId) {
      throw new Error(
        'Grok run reservedBudgetId does not match built intent',
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
