import { resolve } from 'node:path';

import type {
  AgentAdapter,
  AgentRequest,
} from '../agents/agent-adapter.js';
import type { AgentCapabilities } from '../agents/agent-capabilities.js';
import {
  lookupCompatibility,
  type CompatibilityKey,
  type CompatibilityRecord,
} from '../agents/compatibility-matrix.js';
import { HealthEvidenceRepository } from '../agents/health/health-evidence-repository.js';
import type { AttemptId, TaskId } from '../domain/ids.js';
import type { AgentKind, AgentRole } from '../domain/task.js';
import type { ExecutionScope } from '../guard/adapter-permission-profile.js';
import { GuardDecisionRepository } from '../guard/guard-decision-repository.js';
import {
  ProjectGuard,
  type GuardDecision,
} from '../guard/project-guard.js';
import type { ReadWriteDatabase } from '../persistence/database.js';
import { resolvePackageResourcePath } from '../process/native-helper-discovery.js';
import {
  type AgentLaunchPreparation,
  type AgentLaunchPreparer,
} from '../workflow/command-runner.js';
import { WorkerStartGateVerifier } from '../workers/worker-start-gate-verifier.js';
import { ImplementationWorkspaceRepository } from '../workspace/implementation-workspace-repository.js';

const DEFAULT_EVIDENCE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SCHEMA_PATH = resolvePackageResourcePath(
  'schemas/agent-result.schema.json',
  import.meta.url,
);

export interface SafeAgentLaunchPreparation extends AgentLaunchPreparation {
  readonly kind: 'safe_agent_launch';
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly role: AgentRole;
  readonly adapterKind: AgentKind;
  readonly projectRoot: string;
  readonly capabilityKey: CompatibilityKey;
  readonly capabilityRecord: CompatibilityRecord;
  readonly mode: 'project_write' | 'workspace_write' | 'read_only';
  readonly healthEvidenceId: string;
  readonly readinessEvidenceId?: string;
  readonly schemaPath: string;
  readonly nonGit: boolean;
  readonly executionScope: ExecutionScope;
  readonly workspaceAuthorizationId?: string;
  readonly sourceManifestHash?: string;
  readonly executionRoot?: string;
}

export interface SafeAgentLaunchCoordinatorOptions {
  readonly database: ReadWriteDatabase;
  readonly projectRoot: string;
  readonly schemaPath?: string;
  readonly nonGit?: boolean;
  readonly now?: () => Date;
  /** Null keeps evidence unexpired; default is five minutes. */
  readonly evidenceTtlMs?: number | null;
  /** Null keeps the ProjectGuard decision unexpired; default is five minutes. */
  readonly guardDecisionTtlMs?: number | null;
}

function normalizedPath(value: string): string {
  const absolute = resolve(value);
  return process.platform === 'win32'
    ? absolute.toLocaleLowerCase('en-US')
    : absolute;
}

function capabilitiesEqual(
  discovered: AgentCapabilities,
  verified: AgentCapabilities,
): boolean {
  return (
    discovered.fixedSessionId === verified.fixedSessionId
    && discovered.resume === verified.resume
    && discovered.structuredOutput === verified.structuredOutput
    && discovered.streamJson === verified.streamJson
    && discovered.realTimeInput === verified.realTimeInput
    && discovered.nativeSandbox === verified.nativeSandbox
    && discovered.nativePermissionRules === verified.nativePermissionRules
    && discovered.budgetLimit === verified.budgetLimit
    && discovered.turnLimit === verified.turnLimit
    && discovered.timeLimit === verified.timeLimit
    && discovered.nonGitProjects === verified.nonGitProjects
    && discovered.writeModes.length === verified.writeModes.length
    && discovered.writeModes.every(
      (mode, index) => mode === verified.writeModes[index],
    )
  );
}

function expiration(
  now: Date,
  ttlMs: number | null,
): string | null {
  if (ttlMs === null) return null;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('launch evidence TTL must be a positive safe integer or null');
  }
  return new Date(now.getTime() + ttlMs).toISOString();
}

function assertAvailableVersion(
  health: Awaited<ReturnType<AgentAdapter['checkAvailability']>>,
  adapterKind: AgentKind,
): string {
  if (health.status !== 'available') {
    throw new Error(
      `${adapterKind} is unavailable: ${health.reason}`,
    );
  }
  const version = health.version?.trim() ?? '';
  if (version.length === 0) {
    throw new Error(`${adapterKind} health check did not return an exact version`);
  }
  return version;
}

function profileMode(
  decision: GuardDecision,
): 'project_write' | 'workspace_write' | 'read_only' {
  if (decision.scope.kind !== 'adapter_start') {
    throw new Error('ProjectGuard adapter-start decision has an invalid scope');
  }
  if (
    decision.scope.profileMode !== 'project_write'
    && decision.scope.profileMode !== 'workspace_write'
    && decision.scope.profileMode !== 'read_only'
  ) {
    throw new Error(
      `ProjectGuard profile ${decision.scope.profileMode} is not directly launchable`,
    );
  }
  return decision.scope.profileMode;
}

function requestExecutionScope(request: AgentRequest): ExecutionScope {
  return request.executionScope ?? 'live_project';
}

function assertNoRootConfusion(input: {
  readonly scope: ExecutionScope;
  readonly canonicalRoot: string;
  readonly requestProjectRoot: string;
  readonly executionRoot?: string;
}): void {
  if (input.scope !== 'isolated_implementation') {
    if (input.executionRoot !== undefined) {
      throw new Error(
        'executionRoot is only valid for isolated_implementation launches',
      );
    }
    return;
  }
  if (input.executionRoot === undefined || input.executionRoot.trim().length === 0) {
    throw new Error('isolated_implementation requires executionRoot (candidate workspace)');
  }
  if (normalizedPath(input.executionRoot) === normalizedPath(input.canonicalRoot)) {
    throw new Error(
      'launch request original/candidate root confusion: executionRoot must differ from canonical project',
    );
  }
  if (normalizedPath(input.requestProjectRoot) !== normalizedPath(input.canonicalRoot)) {
    throw new Error(
      'launch request original/candidate root confusion: projectRoot must remain the canonical project for isolated launches',
    );
  }
  if (normalizedPath(input.executionRoot) === normalizedPath(input.requestProjectRoot)) {
    throw new Error(
      'launch request original/candidate root confusion: executionRoot cannot equal projectRoot',
    );
  }
}

function isSafePreparation(
  preparation: AgentLaunchPreparation,
): preparation is SafeAgentLaunchPreparation {
  return (
    'kind' in preparation
    && preparation.kind === 'safe_agent_launch'
  );
}

/**
 * Bridges TaskOrchestrator launches to the persisted Task 9/10/13 gates.
 * Health probing is delegated to the configured Adapter and never invokes a
 * model by itself; unsupported or unverifiable profiles fail before reservation.
 */
export class SafeAgentLaunchCoordinator implements AgentLaunchPreparer {
  readonly #database: ReadWriteDatabase;
  readonly #projectRoot: string;
  readonly #schemaPath: string;
  readonly #nonGit: boolean;
  readonly #now: () => Date;
  readonly #evidenceTtlMs: number | null;
  readonly #guard: ProjectGuard;
  readonly #guards: GuardDecisionRepository;
  readonly #health: HealthEvidenceRepository;
  readonly #startGate: WorkerStartGateVerifier;
  readonly #workspaces: ImplementationWorkspaceRepository;

  public constructor(options: SafeAgentLaunchCoordinatorOptions) {
    this.#database = options.database;
    this.#projectRoot = resolve(options.projectRoot);
    this.#schemaPath = resolve(options.schemaPath ?? DEFAULT_SCHEMA_PATH);
    this.#nonGit = options.nonGit ?? false;
    this.#now = options.now ?? (() => new Date());
    this.#evidenceTtlMs =
      options.evidenceTtlMs === undefined
        ? DEFAULT_EVIDENCE_TTL_MS
        : options.evidenceTtlMs;
    const guardDecisionTtlMs =
      options.guardDecisionTtlMs === undefined
        ? DEFAULT_EVIDENCE_TTL_MS
        : options.guardDecisionTtlMs;
    this.#guard = new ProjectGuard({
      projectRoot: this.#projectRoot,
      decisionTtlMs: guardDecisionTtlMs,
      now: this.#now,
    });
    this.#guards = new GuardDecisionRepository(options.database.connection);
    this.#health = new HealthEvidenceRepository(options.database.connection);
    this.#startGate = new WorkerStartGateVerifier(options.database.connection);
    this.#workspaces = new ImplementationWorkspaceRepository(options.database.connection);
  }

  public async prepareBeforeBudget(input: {
    readonly actionId: string;
    readonly taskId: TaskId;
    readonly adapter: AgentAdapter;
    readonly request: AgentRequest;
  }): Promise<SafeAgentLaunchPreparation> {
    void input.actionId;
    if (normalizedPath(input.request.projectRoot) !== normalizedPath(this.#projectRoot)) {
      throw new Error('launch request projectRoot does not match the guarded project');
    }

    const executionScope = requestExecutionScope(input.request);
    assertNoRootConfusion({
      scope: executionScope,
      canonicalRoot: this.#projectRoot,
      requestProjectRoot: input.request.projectRoot,
      executionRoot: input.request.executionRoot,
    });

    const health = await input.adapter.checkAvailability();
    const version = assertAvailableVersion(health, input.adapter.kind);
    const capabilityRecord = lookupCompatibility({
      cliName: input.adapter.kind,
      version,
      platform: process.platform,
    });
    if (capabilityRecord === undefined || !capabilityRecord.verified) {
      throw new Error(
        `no verified capability record for ${input.adapter.kind}@${version}@${process.platform}`,
      );
    }
    const discovered = await input.adapter.discoverCapabilities();
    if (!capabilitiesEqual(discovered, capabilityRecord.capabilities)) {
      throw new Error(
        `discovered capabilities do not match the verified record for ${input.adapter.kind}@${version}`,
      );
    }

    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new Error('safe launch coordinator clock returned an invalid date');
    }
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    let workspaceAuthorizationValidated = false;
    let workspaceAuthorizationId: string | undefined;
    let sourceManifestHash: string | undefined;
    let executionRoot: string | undefined;

    if (executionScope === 'isolated_implementation') {
      workspaceAuthorizationId = input.request.workspaceAuthorizationId?.trim();
      sourceManifestHash = input.request.sourceManifestHash?.trim().toLowerCase();
      const rawExecutionRoot = input.request.executionRoot?.trim();
      if (
        workspaceAuthorizationId === undefined
        || workspaceAuthorizationId.length === 0
        || sourceManifestHash === undefined
        || sourceManifestHash.length === 0
        || rawExecutionRoot === undefined
        || rawExecutionRoot.length === 0
      ) {
        throw new Error(
          'isolated_implementation requires workspaceAuthorizationId, sourceManifestHash, and executionRoot',
        );
      }
      executionRoot = resolve(rawExecutionRoot);
      // Validate without consuming — consumption is atomic at authorizeAfterBudget.
      workspaceAuthorizationValidated = this.#peekWorkspaceAuthorizationReady({
        authorizationId: workspaceAuthorizationId,
        taskId: String(input.taskId),
        attemptId: String(input.request.attemptId),
        workspaceRoot: executionRoot,
        sourceManifestHash,
        nowMs,
      });
      if (!workspaceAuthorizationValidated) {
        throw new Error(
          `workspace authorization is not ready for isolated launch: ${workspaceAuthorizationId}`,
        );
      }
    }

    const healthEvidence = this.#health.putAuth({
      capabilityKey: capabilityRecord.key,
      taskId: input.taskId,
      attemptId: input.request.attemptId,
      authStatus:
        input.adapter.kind === 'grok' ? 'unknown' : 'authenticated',
      probedAt: nowIso,
      expiresAt: expiration(now, this.#evidenceTtlMs),
    });
    // Grok matrix requires readiness evidence. Availability + capability match
    // is recorded here as the no-model readiness gate for subsequent authorize.
    let readinessEvidenceId: string | undefined;
    if (input.adapter.kind === 'grok') {
      readinessEvidenceId = this.#health.putReadiness({
        capabilityKey: capabilityRecord.key,
        taskId: input.taskId,
        attemptId: input.request.attemptId,
        readinessSucceeded: true,
        probedAt: nowIso,
        expiresAt: expiration(now, this.#evidenceTtlMs),
      }).evidenceId;
    }
    const decision = this.#guard.evaluateAdapterStart({
      attemptId: input.request.attemptId,
      role: input.request.role,
      capabilities: discovered,
      adapter: {
        kind: input.adapter.kind,
        version,
      },
      capabilityRecord,
      executionScope,
      workspaceAuthorizationValidated,
    });
    this.#guards.put(decision, { taskId: input.taskId });
    if (decision.mode !== 'auto_allowed') {
      throw new Error(
        `ProjectGuard start is not auto-allowed (${decision.mode}): ${decision.reason}`,
      );
    }

    return Object.freeze({
      kind: 'safe_agent_launch' as const,
      guardDecisionId: decision.id,
      taskId: input.taskId,
      attemptId: input.request.attemptId,
      role: input.request.role,
      adapterKind: input.adapter.kind,
      projectRoot: this.#projectRoot,
      capabilityKey: capabilityRecord.key,
      capabilityRecord,
      mode: profileMode(decision),
      healthEvidenceId: healthEvidence.evidenceId,
      readinessEvidenceId,
      schemaPath: this.#schemaPath,
      nonGit: this.#nonGit,
      executionScope,
      workspaceAuthorizationId,
      sourceManifestHash,
      executionRoot,
    });
  }

  public async authorizeAfterBudget(input: {
    readonly actionId: string;
    readonly taskId: TaskId;
    readonly adapter: AgentAdapter;
    readonly request: AgentRequest;
    readonly preparation: AgentLaunchPreparation;
    readonly reservedBudgetId: string;
  }): Promise<AgentRequest> {
    void input.actionId;
    const preparation = input.preparation;
    if (!isSafePreparation(preparation)) {
      throw new Error('launch preparation was not issued by SafeAgentLaunchCoordinator');
    }
    if (
      preparation.taskId !== input.taskId
      || preparation.attemptId !== input.request.attemptId
      || preparation.role !== input.request.role
      || preparation.adapterKind !== input.adapter.kind
      || normalizedPath(preparation.projectRoot)
        !== normalizedPath(input.request.projectRoot)
    ) {
      throw new Error('launch preparation does not match the reserved Adapter request');
    }

    const executionScope = preparation.executionScope;
    assertNoRootConfusion({
      scope: executionScope,
      canonicalRoot: this.#projectRoot,
      requestProjectRoot: input.request.projectRoot,
      executionRoot: input.request.executionRoot ?? preparation.executionRoot,
    });

    if (executionScope === 'isolated_implementation') {
      const authorizationId =
        input.request.workspaceAuthorizationId ?? preparation.workspaceAuthorizationId;
      const sourceManifestHash =
        input.request.sourceManifestHash ?? preparation.sourceManifestHash;
      const executionRoot = input.request.executionRoot ?? preparation.executionRoot;
      if (
        authorizationId === undefined
        || sourceManifestHash === undefined
        || executionRoot === undefined
      ) {
        throw new Error('isolated_implementation authorization bindings are incomplete');
      }
      if (
        preparation.workspaceAuthorizationId !== authorizationId
        || preparation.sourceManifestHash !== sourceManifestHash.toLowerCase()
        || normalizedPath(preparation.executionRoot ?? '') !== normalizedPath(executionRoot)
      ) {
        throw new Error('isolated workspace authorization bindings changed after prepare');
      }
      const consumed = this.#workspaces.consumeAuthorization(
        authorizationId,
        {
          taskId: String(input.taskId),
          attemptId: String(input.request.attemptId),
          workspaceRoot: executionRoot,
          sourceManifestHash,
        },
        { nowMs: this.#now().getTime() },
      );
      if (!consumed.ok) {
        throw new Error(`workspace authorization consume failed: ${consumed.reason}`);
      }
    }

    const authorized = this.#startGate.authorizeForLaunch({
      taskId: input.taskId,
      attemptId: input.request.attemptId,
      role: input.request.role,
      agentKind: input.adapter.kind,
      refs: {
        capabilityKey: preparation.capabilityKey,
        projectGuardDecisionId: preparation.guardDecisionId,
        reservedBudgetId: input.reservedBudgetId,
        healthEvidenceId: preparation.healthEvidenceId,
        readinessEvidenceId: preparation.readinessEvidenceId,
      },
      schemaPath: preparation.schemaPath,
      nonGit: preparation.nonGit,
      mode: preparation.mode,
      nowMs: this.#now().getTime(),
    });
    if (!authorized.allowed) {
      throw new Error(
        `start gate denied: missing prerequisites [${authorized.missing.join(', ')}]`,
      );
    }

    return {
      ...input.request,
      taskId: input.taskId,
      capabilityKey: preparation.capabilityKey,
      capabilityRecord: preparation.capabilityRecord,
      projectGuardDecisionId: preparation.guardDecisionId,
      reservedBudgetId: input.reservedBudgetId,
      mode: preparation.mode,
      nonGit: preparation.nonGit,
      schemaPath: preparation.schemaPath,
      launchAuthorizationId: authorized.launchAuthorizationId,
      executionScope,
      workspaceAuthorizationId: preparation.workspaceAuthorizationId,
      sourceManifestHash: preparation.sourceManifestHash,
      executionRoot: preparation.executionRoot,
    } as AgentRequest;
  }

  #peekWorkspaceAuthorizationReady(input: {
    readonly authorizationId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly workspaceRoot: string;
    readonly sourceManifestHash: string;
    readonly nowMs: number;
  }): boolean {
    // Use a transactional peek via consume path that does not mutate:
    // ImplementationWorkspaceRepository only exposes consume; add get-by-auth.
    const record = this.#workspaces.getByAuthorizationId(input.authorizationId);
    if (record === undefined) return false;
    if (record.status !== 'ready') return false;
    if (record.authorizationConsumedAt !== null) return false;
    if (Date.parse(record.authorizationExpiresAt) <= input.nowMs) return false;
    if (record.taskId !== input.taskId || record.attemptId !== input.attemptId) {
      return false;
    }
    if (normalizedPath(record.workspaceRoot) !== normalizedPath(input.workspaceRoot)) {
      return false;
    }
    if (record.sourceManifestHash !== input.sourceManifestHash.toLowerCase()) {
      return false;
    }
    return true;
  }
}
