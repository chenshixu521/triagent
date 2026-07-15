import type { DatabaseSync } from 'node:sqlite';

import type { AgentCapabilities } from '../../src/agents/agent-capabilities.js';
import {
  requireVerifiedCompatibility,
  type CompatibilityCliName,
  type CompatibilityKey,
} from '../../src/agents/compatibility-matrix.js';
import {
  HealthEvidenceRepository,
  type HealthAuthStatus,
} from '../../src/agents/health/health-evidence-repository.js';
import { BudgetRepository } from '../../src/budget/budget-repository.js';
import type { AttemptId, TaskId } from '../../src/domain/ids.js';
import type { AgentKind, AgentRole } from '../../src/domain/task.js';
import { GuardDecisionRepository } from '../../src/guard/guard-decision-repository.js';
import {
  ProjectGuard,
  type GuardDecision,
} from '../../src/guard/project-guard.js';
import type { WorkerStartGateInput } from '../../src/workers/agent-worker-manager.js';

function agentKindToCliName(agentKind: AgentKind | string): CompatibilityCliName {
  switch (agentKind) {
    case 'claude':
      return 'claude';
    case 'grok':
      return 'grok';
    case 'codex':
    default:
      return 'codex';
  }
}

const DEFAULT_VERSION: Record<CompatibilityCliName, string> = {
  codex: '0.144.1',
  claude: '2.1.206',
  grok: '0.2.93',
};

export interface SeededWorkerStartGate {
  readonly startGate: WorkerStartGateInput;
  readonly capabilityKey: CompatibilityKey;
  readonly guardDecision: GuardDecision;
  readonly reservedBudgetId: string;
  readonly healthEvidenceId?: string;
  readonly readinessEvidenceId?: string;
}

/**
 * Seeds real Task 9 GuardDecision + Task 10 BudgetRepository reservation rows
 * + Task 13 HealthEvidence and returns identifiers-only startGate refs
 * (no caller-claimed auth/readiness booleans).
 */
export function seedVerifiedWorkerStartGate(
  database: DatabaseSync,
  options: {
    readonly taskId: TaskId;
    readonly attemptId: AttemptId;
    readonly role?: AgentRole;
    readonly agentKind?: AgentKind | string;
    readonly version?: string;
    readonly projectRoot?: string;
    readonly decisionTtlMs?: number | null;
    readonly now?: () => Date;
    /** Persisted auth status for Codex/Claude health evidence. */
    readonly authStatus?: HealthAuthStatus;
    /** When true, seed a successful readiness evidence row (Grok). */
    readonly readinessSucceeded?: boolean;
    /** Skip seeding readiness even when Grok would require it. */
    readonly skipReadiness?: boolean;
    /** Skip seeding auth evidence even when Codex/Claude would require it. */
    readonly skipAuth?: boolean;
    /** Override limits so tests can exhaust budget separately. */
    readonly maxExternalCalls?: number;
    readonly skipBudget?: boolean;
    readonly skipGuard?: boolean;
    readonly forgeGuardId?: string;
    readonly forgeBudgetId?: string;
    readonly forgeHealthId?: string;
    readonly forgeReadinessId?: string;
    readonly reservationStatus?: 'reserved' | 'launched' | 'released' | 'consumed';
    readonly bindReservationToOtherAttempt?: AttemptId;
    /** Bind guard decision to a different task (cross-task attack). */
    readonly bindGuardToOtherTaskId?: TaskId;
    /** Leave reservation.guardDecisionId null. */
    readonly nullGuardDecisionIdOnReservation?: boolean;
    /** Bind reservation.guardDecisionId to a different decision id. */
    readonly bindReservationToOtherGuardId?: string;
    /** Auth evidence capability key override (version mismatch tests). */
    readonly healthCapabilityVersion?: string;
    /** Readiness evidence expiry override. */
    readonly readinessExpiresAt?: string | null;
    /** Auth evidence expiry override. */
    readonly authExpiresAt?: string | null;
    /**
     * Optional capabilities override for ProjectGuard evaluation.
     * Used to simulate loaded Grok enforcement proof (elevated writeModes)
     * without claiming the static matrix is proven.
     */
    readonly capabilitiesOverride?: AgentCapabilities;
  },
): SeededWorkerStartGate {
  const cliName = agentKindToCliName(options.agentKind ?? 'codex');
  const version = options.version ?? DEFAULT_VERSION[cliName];
  const capabilityRecord = requireVerifiedCompatibility({
    cliName,
    version,
    platform: process.platform,
  });
  const role = options.role ?? 'implementer';
  const requiresReadiness = cliName === 'grok';
  const requiresAuth = cliName !== 'grok';
  const authStatus: HealthAuthStatus = options.authStatus
    ?? (cliName === 'grok' ? 'unknown' : 'authenticated');
  const guardCapabilities =
    options.capabilitiesOverride ?? capabilityRecord.capabilities;

  const guards = new GuardDecisionRepository(database);
  const budget = new BudgetRepository(database);
  const health = new HealthEvidenceRepository(database);
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();

  let guardDecision: GuardDecision;
  if (options.skipGuard === true) {
    // Minimal placeholder for negative tests that forge IDs.
    guardDecision = {
      id: options.forgeGuardId ?? 'missing-guard-will-not-be-stored',
      mode: 'auto_allowed',
      scope: {
        kind: 'adapter_start',
        role,
        profileMode: 'project_write',
        executionScope: 'live_project',
      },
      reason: 'not persisted',
      attemptId: String(options.attemptId),
      createdAt: nowIso,
      expiresAt: null,
      capabilityEvidence: {
        verified: true,
        adapter: { kind: cliName, version },
        writeModes: [...guardCapabilities.writeModes],
        nativePermissionRules: guardCapabilities.nativePermissionRules,
        structuredOutput: guardCapabilities.structuredOutput,
        profileMode: 'project_write',
        notes: [],
      },
      role,
      userConfirmationRequired: false,
    };
  } else {
    const guard = new ProjectGuard({
      projectRoot: options.projectRoot ?? process.cwd(),
      decisionTtlMs: options.decisionTtlMs === undefined ? null : options.decisionTtlMs,
      now,
    });
    guardDecision = guard.evaluateAdapterStart({
      attemptId: options.attemptId,
      role,
      capabilities: guardCapabilities,
      adapter: { kind: cliName, version },
    });
    const guardTaskId = options.bindGuardToOtherTaskId ?? options.taskId;
    guards.put(guardDecision, { taskId: guardTaskId });
  }

  let reservedBudgetId = options.forgeBudgetId ?? '';
  if (options.skipBudget !== true) {
    // Respect already-persisted Task 10 limits (BudgetController may seed first).
    const existingState = budget.getTaskState(options.taskId);
    if (existingState === undefined) {
      budget.ensureTaskState(
        options.taskId,
        {
          totalActiveRuntimeMs: 60_000,
          perAttemptTimeoutMs: 30_000,
          maxExternalCalls: options.maxExternalCalls ?? 10,
        },
        nowIso,
      );
    }
    const reservationAttempt =
      options.bindReservationToOtherAttempt ?? options.attemptId;
    let guardDecisionIdForReservation: string | undefined = guardDecision.id;
    if (options.nullGuardDecisionIdOnReservation === true) {
      guardDecisionIdForReservation = undefined;
    } else if (options.bindReservationToOtherGuardId !== undefined) {
      guardDecisionIdForReservation = options.bindReservationToOtherGuardId;
    }
    const reservation = budget.insertReservation({
      taskId: options.taskId,
      attemptId: reservationAttempt,
      idempotencyKey: `start-gate:${options.taskId}:${String(reservationAttempt)}:${guardDecision.id}:${Math.random().toString(36).slice(2, 8)}`,
      ...(guardDecisionIdForReservation === undefined
        ? {}
        : { guardDecisionId: guardDecisionIdForReservation }),
      reservedAt: nowIso,
    });
    reservedBudgetId = reservation.reservationId;

    if (options.reservationStatus === 'launched') {
      budget.markLaunched(reservation.reservationId, nowIso);
    } else if (options.reservationStatus === 'released') {
      budget.releaseReservation(reservation.reservationId, nowIso);
    } else if (options.reservationStatus === 'consumed') {
      budget.markLaunched(reservation.reservationId, nowIso);
      budget.consumeReservation(reservation.reservationId, nowIso);
    }
  } else if (options.forgeBudgetId !== undefined) {
    reservedBudgetId = options.forgeBudgetId;
  }

  let healthEvidenceId: string | undefined;
  if (options.forgeHealthId !== undefined) {
    healthEvidenceId = options.forgeHealthId;
  } else if (requiresAuth && options.skipAuth !== true) {
    const healthKey = options.healthCapabilityVersion === undefined
      ? capabilityRecord.key
      : {
        ...capabilityRecord.key,
        version: options.healthCapabilityVersion,
      };
    const auth = health.putAuth({
      capabilityKey: healthKey,
      taskId: options.taskId,
      attemptId: options.attemptId,
      authStatus,
      probeCommand: {
        executable: cliName,
        args: cliName === 'claude'
          ? ['auth', 'status']
          : ['login', 'status'],
      },
      probedAt: nowIso,
      expiresAt: options.authExpiresAt === undefined ? null : options.authExpiresAt,
    });
    healthEvidenceId = auth.evidenceId;
  }

  let readinessEvidenceId: string | undefined;
  if (options.forgeReadinessId !== undefined) {
    readinessEvidenceId = options.forgeReadinessId;
  } else if (
    requiresReadiness
    && options.skipReadiness !== true
    && (options.readinessSucceeded ?? true)
  ) {
    const readiness = health.putReadiness({
      capabilityKey: capabilityRecord.key,
      taskId: options.taskId,
      attemptId: options.attemptId,
      readinessSucceeded: options.readinessSucceeded ?? true,
      probeCommand: {
        executable: 'grok',
        args: ['--help'],
      },
      probedAt: nowIso,
      expiresAt:
        options.readinessExpiresAt === undefined
          ? null
          : options.readinessExpiresAt,
    });
    readinessEvidenceId = readiness.evidenceId;
  } else if (
    requiresReadiness
    && options.skipReadiness !== true
    && options.readinessSucceeded === false
  ) {
    const readiness = health.putReadiness({
      capabilityKey: capabilityRecord.key,
      taskId: options.taskId,
      attemptId: options.attemptId,
      readinessSucceeded: false,
      probeCommand: {
        executable: 'grok',
        args: ['--help'],
      },
      probedAt: nowIso,
      expiresAt:
        options.readinessExpiresAt === undefined
          ? null
          : options.readinessExpiresAt,
    });
    readinessEvidenceId = readiness.evidenceId;
  }

  const startGate: WorkerStartGateInput = {
    capabilityKey: capabilityRecord.key,
    projectGuardDecisionId:
      options.forgeGuardId ?? guardDecision.id,
    reservedBudgetId: reservedBudgetId || (options.forgeBudgetId ?? ''),
    ...(healthEvidenceId === undefined
      ? {}
      : { healthEvidenceId }),
    ...(readinessEvidenceId === undefined
      ? {}
      : { readinessEvidenceId }),
  };

  return {
    startGate,
    capabilityKey: capabilityRecord.key,
    guardDecision,
    reservedBudgetId: startGate.reservedBudgetId,
    ...(healthEvidenceId === undefined ? {} : { healthEvidenceId }),
    ...(readinessEvidenceId === undefined ? {} : { readinessEvidenceId }),
  };
}

/**
 * @deprecated Use {@link seedVerifiedWorkerStartGate} which persists real rows.
 * Kept only as a thin wrapper name used by older test imports during migration.
 */
export function verifiedWorkerStartGate(
  database: DatabaseSync,
  options: Parameters<typeof seedVerifiedWorkerStartGate>[1],
): WorkerStartGateInput {
  return seedVerifiedWorkerStartGate(database, options).startGate;
}
