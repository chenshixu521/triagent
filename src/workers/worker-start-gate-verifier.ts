import type { DatabaseSync } from 'node:sqlite';

import {
  lookupCompatibility,
  workerStartPrerequisites,
  type CompatibilityCliName,
  type CompatibilityKey,
  type WorkerStartGateRecord,
  type WorkerStartMissingPrerequisite,
  type WorkerStartPrerequisitesResult,
} from '../agents/compatibility-matrix.js';
import {
  HealthEvidenceRepository,
  type HealthAuthStatus,
  type HealthEvidenceRecord,
} from '../agents/health/health-evidence-repository.js';
import {
  LaunchAuthorizationRepository,
  type LaunchAuthorizationRecord,
} from '../agents/launch-authorization-repository.js';
import type { AttemptId, TaskId } from '../domain/ids.js';
import type { AgentKind, AgentRole } from '../domain/task.js';
import {
  BudgetRepository,
  type BudgetCallReservation,
} from '../budget/budget-repository.js';
import { GuardDecisionRepository } from '../guard/guard-decision-repository.js';
import type { GuardDecision } from '../guard/project-guard.js';

/**
 * Identifiers only — never caller-claimed auth/readiness/budget booleans.
 * Auth and readiness are derived from persisted HealthEvidence records.
 */
export interface WorkerStartGateRefs {
  /** Exact immutable matrix key (cliName + version + platform). */
  readonly capabilityKey: CompatibilityKey;
  readonly projectGuardDecisionId: string;
  readonly reservedBudgetId: string;
  /**
   * Persisted no-write health auth evidence id (Codex/Claude).
   * Grok 0.2.93 always treats auth as unknown from the matrix contract;
   * an auth evidence id is optional and never elevates Grok to authenticated.
   */
  readonly healthEvidenceId?: string;
  /**
   * Persisted readiness probe evidence id. Required for Grok (and any CLI
   * whose CompatibilityRecord implies readiness) until a valid readiness
   * record proves success for the exact capability key + task/attempt.
   */
  readonly readinessEvidenceId?: string;
}

export interface WorkerStartGateVerifyInput {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly role: AgentRole;
  readonly agentKind: AgentKind;
  readonly refs: WorkerStartGateRefs;
  /** Clock override for expiry checks (ms since epoch). */
  readonly nowMs?: number;
}

export type WorkerStartGateVerifyResult =
  | {
      readonly allowed: true;
      readonly missing: readonly [];
      readonly gate: WorkerStartGateRecord;
      readonly guardDecision: GuardDecision;
      readonly reservation: BudgetCallReservation;
      readonly healthEvidence?: HealthEvidenceRecord;
      readonly readinessEvidence?: HealthEvidenceRecord;
    }
  | {
      readonly allowed: false;
      readonly missing: readonly WorkerStartMissingPrerequisite[];
      readonly capabilityKey?: CompatibilityKey;
      readonly projectGuardDecisionId?: string;
      readonly reservedBudgetId?: string;
    };

export interface WorkerLaunchAuthorizeInput extends WorkerStartGateVerifyInput {
  /** Schema path bound into the one-time launch authorization. */
  readonly schemaPath: string;
  readonly nonGit: boolean;
  /** Adapter / guard profile mode bound into authorization. */
  readonly mode: string;
  /** Authorization TTL in ms (default 5 minutes). */
  readonly authorizationTtlMs?: number;
}

export type WorkerLaunchAuthorizeResult =
  | {
      readonly allowed: true;
      readonly missing: readonly [];
      readonly gate: WorkerStartGateRecord;
      readonly guardDecision: GuardDecision;
      readonly reservation: BudgetCallReservation;
      readonly launchAuthorizationId: string;
      readonly launchAuthorization: LaunchAuthorizationRecord;
      readonly healthEvidence?: HealthEvidenceRecord;
      readonly readinessEvidence?: HealthEvidenceRecord;
    }
  | {
      readonly allowed: false;
      readonly missing: readonly WorkerStartMissingPrerequisite[];
      readonly capabilityKey?: CompatibilityKey;
      readonly projectGuardDecisionId?: string;
      readonly reservedBudgetId?: string;
    };

function agentKindToCliName(
  agentKind: AgentKind,
): CompatibilityCliName | undefined {
  switch (agentKind) {
    case 'codex':
      return 'codex';
    case 'claude':
      return 'claude';
    case 'grok':
      return 'grok';
    default:
      return undefined;
  }
}

function isLaunchableReservationStatus(
  status: BudgetCallReservation['status'],
): boolean {
  // reserved is the only pre-launch status. launched/consumed/released are reused.
  return status === 'reserved';
}

function capabilityKeysEqual(
  a: CompatibilityKey,
  b: CompatibilityKey,
): boolean {
  return (
    a.cliName === b.cliName
    && a.version === b.version
    && a.platform === b.platform
  );
}

function isExpired(expiresAt: string | null, nowMs: number): boolean {
  if (expiresAt === null) return false;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return true;
  return ms <= nowMs;
}

/**
 * Derive auth/readiness requirements from the exact CompatibilityRecord,
 * never from caller booleans.
 *
 * - Grok 0.2.93: always auth unknown + readiness required until persisted
 *   readiness evidence proves success.
 * - Codex/Claude: auth comes from persisted no-write health evidence.
 */
function deriveAuthAndReadinessRequirements(
  cliName: CompatibilityCliName,
  version: string,
): {
  readonly alwaysAuthUnknown: boolean;
  readonly requiresReadinessProbe: boolean;
  readonly requiresAuthEvidence: boolean;
} {
  if (cliName === 'grok') {
    // Grok contract: cannot prove auth without a model call.
    return {
      alwaysAuthUnknown: true,
      requiresReadinessProbe: true,
      requiresAuthEvidence: false,
    };
  }
  // Codex / Claude: no readiness probe; auth from health evidence.
  void version;
  return {
    alwaysAuthUnknown: false,
    requiresReadinessProbe: false,
    requiresAuthEvidence: true,
  };
}

/**
 * Fail-closed verifier that loads real Task 9 GuardDecision rows,
 * Task 10 BudgetRepository reservation rows, and Task 13 HealthEvidence.
 * Callers supply identifiers only.
 */
export class WorkerStartGateVerifier {
  readonly #guards: GuardDecisionRepository;
  readonly #budget: BudgetRepository;
  readonly #health: HealthEvidenceRepository;
  readonly #launchAuth: LaunchAuthorizationRepository;

  public constructor(database: DatabaseSync) {
    this.#guards = new GuardDecisionRepository(database);
    this.#budget = new BudgetRepository(database);
    this.#health = new HealthEvidenceRepository(database);
    this.#launchAuth = new LaunchAuthorizationRepository(database);
  }

  public verify(input: WorkerStartGateVerifyInput): WorkerStartGateVerifyResult {
    const missing: WorkerStartMissingPrerequisite[] = [];
    const nowMs = input.nowMs ?? Date.now();
    const expectedCli = agentKindToCliName(input.agentKind);

    // Reject any legacy caller truth-claims if they leaked through refs.
    const legacy = input.refs as unknown as Record<string, unknown>;
    if (
      'authStatus' in legacy
      || 'requiresReadinessProbe' in legacy
      || 'readinessProbeCompleted' in legacy
      || 'budgetCanLaunch' in legacy
      || 'capabilityRecord' in legacy
      || 'projectGuardMode' in legacy
    ) {
      // Caller tried to claim auth/readiness/budget truths — fail closed.
      missing.push('authenticated');
      missing.push('readiness_probe');
      missing.push('verified_capability_record');
    }

    // 1) Exact verified CompatibilityRecord by immutable key.
    const capabilityRecord = lookupCompatibility(input.refs.capabilityKey);
    if (capabilityRecord === undefined || !capabilityRecord.verified) {
      missing.push('verified_capability_record');
    } else if (
      expectedCli !== undefined
      && capabilityRecord.key.cliName !== expectedCli
    ) {
      missing.push('capability_mismatch');
    } else if (
      !capabilityKeysEqual(capabilityRecord.key, input.refs.capabilityKey)
    ) {
      missing.push('capability_mismatch');
    }

    const requirements =
      capabilityRecord !== undefined && capabilityRecord.verified
        ? deriveAuthAndReadinessRequirements(
          capabilityRecord.key.cliName,
          capabilityRecord.key.version,
        )
        : {
          alwaysAuthUnknown: false,
          requiresReadinessProbe: false,
          requiresAuthEvidence: true,
        };

    // 2) Persisted GuardDecision bound to task/attempt/role/adapter, unexpired.
    const storedGuard = this.#guards.getStored(input.refs.projectGuardDecisionId);
    const guardDecision = storedGuard?.decision;
    if (guardDecision === undefined) {
      missing.push('project_guard_decision');
    } else {
      // taskId binding (preserved on GuardDecisionRepository.put)
      if (
        storedGuard?.taskId === undefined
        || storedGuard.taskId !== input.taskId
      ) {
        missing.push('project_guard_decision');
      }
      if (guardDecision.attemptId !== String(input.attemptId)) {
        missing.push('attempt_mismatch');
      }
      if (guardDecision.role !== input.role) {
        missing.push('project_guard_mode');
      }
      // Only auto_allowed / proven profiles may start without confirmation.
      if (guardDecision.mode !== 'auto_allowed') {
        missing.push('project_guard_mode');
      }
      if (!guardDecision.capabilityEvidence.verified) {
        missing.push('project_guard_mode');
      }
      if (guardDecision.scope.kind !== 'adapter_start') {
        missing.push('project_guard_mode');
      }
      if (isExpired(guardDecision.expiresAt, nowMs)) {
        missing.push('expired_prerequisite');
      }
      // Adapter kind+version must exactly match capabilityKey (platform via key).
      if (capabilityRecord !== undefined && capabilityRecord.verified) {
        const adapter = guardDecision.capabilityEvidence.adapter;
        if (
          adapter.kind !== capabilityRecord.key.cliName
          || adapter.version !== capabilityRecord.key.version
        ) {
          missing.push('capability_mismatch');
        }
      }
    }

    // 3) Budget reservation: taskId+attemptId exact AND guardDecisionId exact.
    const reservation = this.#budget.getReservation(input.refs.reservedBudgetId);
    if (reservation === undefined) {
      missing.push('reserved_budget');
    } else {
      if (reservation.taskId !== input.taskId) {
        missing.push('reserved_budget');
      }
      if (reservation.attemptId !== input.attemptId) {
        missing.push('attempt_mismatch');
      }
      if (!isLaunchableReservationStatus(reservation.status)) {
        // Reused / already launched / consumed / released fails closed.
        missing.push('budget_can_launch');
        missing.push('reserved_budget');
      }
      // null or mismatched guardDecisionId is denied.
      if (
        reservation.guardDecisionId === null
        || reservation.guardDecisionId === undefined
        || (guardDecision !== undefined
          && reservation.guardDecisionId !== guardDecision.id)
        || (guardDecision === undefined)
        || reservation.guardDecisionId !== input.refs.projectGuardDecisionId
      ) {
        if (
          reservation.guardDecisionId === null
          || reservation.guardDecisionId === undefined
          || reservation.guardDecisionId !== input.refs.projectGuardDecisionId
          || (guardDecision !== undefined
            && reservation.guardDecisionId !== guardDecision.id)
        ) {
          missing.push('project_guard_decision');
        }
      }
      const taskState = this.#budget.getTaskState(input.taskId);
      if (
        taskState === undefined
        || taskState.failClosed
        || taskState.exhaustedReason !== null
      ) {
        missing.push('budget_can_launch');
      }
    }

    // 4) Auth evidence — derived from CompatibilityRecord + persisted store.
    let authStatus: HealthAuthStatus = 'unknown';
    let healthEvidence: HealthEvidenceRecord | undefined;

    if (requirements.alwaysAuthUnknown) {
      // Grok: always unknown until readiness proves operational readiness.
      // Caller cannot claim authenticated via any path.
      authStatus = 'unknown';
      // Optional auth evidence must still match if supplied (fail closed on forge).
      if (
        input.refs.healthEvidenceId !== undefined
        && input.refs.healthEvidenceId.trim().length > 0
      ) {
        healthEvidence = this.#health.get(input.refs.healthEvidenceId);
        if (
          healthEvidence === undefined
          || healthEvidence.kind !== 'auth'
          || healthEvidence.status !== 'valid'
          || healthEvidence.taskId !== input.taskId
          || (capabilityRecord !== undefined
            && !capabilityKeysEqual(
              healthEvidence.capabilityKey,
              capabilityRecord.key,
            ))
          || isExpired(healthEvidence.expiresAt, nowMs)
        ) {
          // Forged / mismatched optional auth evidence fails closed.
          missing.push('authenticated');
        }
        // Even valid auth evidence cannot elevate Grok beyond unknown.
        authStatus = 'unknown';
      }
    } else if (requirements.requiresAuthEvidence) {
      if (
        input.refs.healthEvidenceId === undefined
        || input.refs.healthEvidenceId.trim().length === 0
      ) {
        missing.push('authenticated');
      } else {
        healthEvidence = this.#health.get(input.refs.healthEvidenceId);
        if (
          healthEvidence === undefined
          || healthEvidence.kind !== 'auth'
          || healthEvidence.status !== 'valid'
        ) {
          missing.push('authenticated');
        } else {
          if (healthEvidence.taskId !== input.taskId) {
            missing.push('authenticated');
          }
          if (
            healthEvidence.attemptId !== undefined
            && healthEvidence.attemptId !== input.attemptId
          ) {
            missing.push('attempt_mismatch');
          }
          if (
            capabilityRecord !== undefined
            && !capabilityKeysEqual(
              healthEvidence.capabilityKey,
              capabilityRecord.key,
            )
          ) {
            missing.push('capability_mismatch');
          }
          if (isExpired(healthEvidence.expiresAt, nowMs)) {
            missing.push('expired_prerequisite');
          }
          // Codex/Claude: only exact authenticated may start. unknown /
          // logged_out / error / missing all fail closed (zero Worker start).
          const persistedAuth = healthEvidence.authStatus ?? 'error';
          if (persistedAuth !== 'authenticated') {
            missing.push('authenticated');
          }
          authStatus = persistedAuth;
        }
      }
    }

    // 5) Readiness evidence — required when matrix contract demands it (Grok).
    let readinessProbeCompleted = false;
    let readinessEvidence: HealthEvidenceRecord | undefined;

    if (requirements.requiresReadinessProbe) {
      if (
        input.refs.readinessEvidenceId === undefined
        || input.refs.readinessEvidenceId.trim().length === 0
      ) {
        missing.push('readiness_probe');
      } else {
        readinessEvidence = this.#health.get(input.refs.readinessEvidenceId);
        if (
          readinessEvidence === undefined
          || readinessEvidence.kind !== 'readiness'
          || readinessEvidence.status !== 'valid'
          || readinessEvidence.readinessSucceeded !== true
        ) {
          missing.push('readiness_probe');
        } else {
          if (readinessEvidence.taskId !== input.taskId) {
            missing.push('readiness_probe');
          }
          if (readinessEvidence.attemptId !== input.attemptId) {
            missing.push('attempt_mismatch');
          }
          if (
            capabilityRecord !== undefined
            && !capabilityKeysEqual(
              readinessEvidence.capabilityKey,
              capabilityRecord.key,
            )
          ) {
            missing.push('capability_mismatch');
          }
          if (isExpired(readinessEvidence.expiresAt, nowMs)) {
            missing.push('expired_prerequisite');
            missing.push('readiness_probe');
          }
          if (
            readinessEvidence.status === 'valid'
            && readinessEvidence.readinessSucceeded === true
            && readinessEvidence.taskId === input.taskId
            && readinessEvidence.attemptId === input.attemptId
            && capabilityRecord !== undefined
            && capabilityKeysEqual(
              readinessEvidence.capabilityKey,
              capabilityRecord.key,
            )
            && !isExpired(readinessEvidence.expiresAt, nowMs)
          ) {
            readinessProbeCompleted = true;
          }
        }
      }
    } else {
      // Readiness not required — if caller supplies an id, still validate it
      // (forged readiness must not silently pass when mismatched).
      if (
        input.refs.readinessEvidenceId !== undefined
        && input.refs.readinessEvidenceId.trim().length > 0
      ) {
        readinessEvidence = this.#health.get(input.refs.readinessEvidenceId);
        if (
          readinessEvidence === undefined
          || readinessEvidence.kind !== 'readiness'
          || readinessEvidence.status !== 'valid'
          || readinessEvidence.taskId !== input.taskId
          || (capabilityRecord !== undefined
            && !capabilityKeysEqual(
              readinessEvidence.capabilityKey,
              capabilityRecord.key,
            ))
          || isExpired(readinessEvidence.expiresAt, nowMs)
        ) {
          missing.push('readiness_probe');
        } else {
          readinessProbeCompleted = readinessEvidence.readinessSucceeded === true;
        }
      } else {
        readinessProbeCompleted = true; // not required
      }
    }

    if (missing.length > 0) {
      return {
        allowed: false,
        missing: Object.freeze([...new Set(missing)]),
        ...(capabilityRecord === undefined
          ? {}
          : { capabilityKey: capabilityRecord.key }),
        ...(guardDecision === undefined
          ? {}
          : { projectGuardDecisionId: guardDecision.id }),
        ...(reservation === undefined
          ? {}
          : { reservedBudgetId: reservation.reservationId }),
      };
    }

    // Pure structural gate for residual fields (mode string, etc.).
    const structural = workerStartPrerequisites({
      capabilityRecord: capabilityRecord!,
      ...(expectedCli === undefined ? {} : { expectedCliName: expectedCli }),
      projectGuardDecisionId: guardDecision!.id,
      projectGuardMode: guardDecision!.mode,
      projectGuardAttemptId: guardDecision!.attemptId,
      startAttemptId: String(input.attemptId),
      budgetCanLaunch: true,
      reservedBudgetId: reservation!.reservationId,
      authStatus,
      requiresReadinessProbe: requirements.requiresReadinessProbe,
      readinessProbeCompleted,
      nowMs,
    });

    if (!structural.allowed) {
      return {
        allowed: false,
        missing: structural.missing,
        ...(structural.capabilityKey === undefined
          ? {}
          : { capabilityKey: structural.capabilityKey }),
        ...(structural.projectGuardDecisionId === undefined
          ? {}
          : { projectGuardDecisionId: structural.projectGuardDecisionId }),
        ...(structural.reservedBudgetId === undefined
          ? {}
          : { reservedBudgetId: structural.reservedBudgetId }),
      };
    }

    return {
      allowed: true,
      missing: Object.freeze([]) as readonly [],
      gate: structural.gate,
      guardDecision: guardDecision!,
      reservation: reservation!,
      ...(healthEvidence === undefined ? {} : { healthEvidence }),
      ...(readinessEvidence === undefined ? {} : { readinessEvidence }),
    };
  }

  /**
   * Atomically mark the reservation launched after gate success (idempotent).
   * Must be called only after {@link verify} allowed and before Worker spawn
   * completes — failure here fails closed with zero Worker start.
   * Also consumes single-use readiness evidence when present.
   */
  public consumeLaunchReservation(
    reservationId: string,
    nowIso: string,
    readinessEvidenceId?: string,
  ): void {
    const reservation = this.#budget.getReservation(reservationId);
    if (reservation === undefined) {
      throw new Error(`budget reservation not found: ${reservationId}`);
    }
    if (reservation.status === 'launched' || reservation.status === 'consumed') {
      // Idempotent re-entry for the same launch path is not allowed for start gate
      // (reused reservation). Only first transition reserved→launched is valid.
      throw new Error(`budget reservation already used: ${reservationId}`);
    }
    if (reservation.status !== 'reserved') {
      throw new Error(`budget reservation is not launchable: ${reservationId}`);
    }
    this.#budget.markLaunched(reservationId, nowIso);

    if (
      readinessEvidenceId !== undefined
      && readinessEvidenceId.trim().length > 0
    ) {
      this.#health.markConsumed(readinessEvidenceId, nowIso);
    }
  }

  /**
   * Validate + consume exact capability/Guard/Budget/Health evidence, then issue
   * a durable opaque one-time LaunchAuthorization id. Adapters accept only this
   * id (never a forgeable WorkerStartGateRecord plain object).
   */
  public authorizeForLaunch(
    input: WorkerLaunchAuthorizeInput,
  ): WorkerLaunchAuthorizeResult {
    const verified = this.verify(input);
    if (!verified.allowed) {
      return {
        allowed: false,
        missing: verified.missing,
        ...(verified.capabilityKey === undefined
          ? {}
          : { capabilityKey: verified.capabilityKey }),
        ...(verified.projectGuardDecisionId === undefined
          ? {}
          : { projectGuardDecisionId: verified.projectGuardDecisionId }),
        ...(verified.reservedBudgetId === undefined
          ? {}
          : { reservedBudgetId: verified.reservedBudgetId }),
      };
    }

    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    try {
      this.consumeLaunchReservation(
        verified.reservation.reservationId,
        nowIso,
        input.refs.readinessEvidenceId,
      );
    } catch {
      return {
        allowed: false,
        missing: Object.freeze([
          'budget_can_launch',
          'reserved_budget',
        ] as WorkerStartMissingPrerequisite[]),
        capabilityKey: verified.gate.capabilityKey,
        projectGuardDecisionId: verified.gate.projectGuardDecisionId,
        reservedBudgetId: verified.reservation.reservationId,
      };
    }

    const ttlMs = input.authorizationTtlMs ?? 5 * 60 * 1000;
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const issued = this.#launchAuth.issue(
      {
        taskId: input.taskId,
        attemptId: input.attemptId,
        adapterKind: input.agentKind,
        adapterVersion: verified.gate.capabilityKey.version,
        adapterPlatform: verified.gate.capabilityKey.platform,
        role: input.role,
        mode: input.mode,
        guardDecisionId: verified.gate.projectGuardDecisionId,
        budgetReservationId: verified.reservation.reservationId,
        schemaPath: input.schemaPath,
        nonGit: input.nonGit,
      },
      { nowIso, expiresAt },
    );

    return {
      allowed: true,
      missing: Object.freeze([]) as readonly [],
      gate: verified.gate,
      guardDecision: verified.guardDecision,
      reservation: verified.reservation,
      launchAuthorizationId: issued.authorizationId,
      launchAuthorization: issued,
      ...(verified.healthEvidence === undefined
        ? {}
        : { healthEvidence: verified.healthEvidence }),
      ...(verified.readinessEvidence === undefined
        ? {}
        : { readinessEvidence: verified.readinessEvidence }),
    };
  }

  /** Port used by adapters / tests for consume-and-verify. */
  public get launchAuthorizationPort(): LaunchAuthorizationRepository {
    return this.#launchAuth;
  }
}

export type { WorkerStartPrerequisitesResult };
