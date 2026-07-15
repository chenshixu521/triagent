import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { CompatibilityKey } from '../compatibility-matrix.js';
import type { AttemptId, TaskId } from '../../domain/ids.js';
import { ActionRepository } from '../../persistence/action-repository.js';

export type HealthAuthStatus =
  | 'authenticated'
  | 'logged_out'
  | 'unknown'
  | 'error';

export type HealthEvidenceKind = 'auth' | 'readiness';

export type HealthEvidenceStatus = 'valid' | 'consumed';

export interface HealthProbeCommandEvidence {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly durationMs?: number;
}

/**
 * Persisted no-write health / readiness evidence.
 * Start-gate verifiers load by immutable evidence id only — callers never
 * claim authStatus / readiness booleans directly.
 */
export interface HealthEvidenceRecord {
  readonly evidenceId: string;
  readonly kind: HealthEvidenceKind;
  readonly status: HealthEvidenceStatus;
  /** Exact matrix key (cliName + version + platform). */
  readonly capabilityKey: CompatibilityKey;
  readonly taskId: TaskId;
  /** Required for readiness; optional binding for auth. */
  readonly attemptId?: AttemptId;
  /** Auth evidence only — never trusted from startGate caller fields. */
  readonly authStatus?: HealthAuthStatus;
  /** Readiness evidence only — true means probe succeeded. */
  readonly readinessSucceeded?: boolean;
  readonly probeCommand?: HealthProbeCommandEvidence;
  readonly probedAt: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly consumedAt?: string;
}

const AUTH_ACTION_TYPE = 'health_auth_evidence';
const READINESS_ACTION_TYPE = 'health_readiness_evidence';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthStatus(value: unknown): value is HealthAuthStatus {
  return (
    value === 'authenticated'
    || value === 'logged_out'
    || value === 'unknown'
    || value === 'error'
  );
}

function isCompatibilityKey(value: unknown): value is CompatibilityKey {
  if (!isRecord(value)) return false;
  return (
    (value.cliName === 'codex'
      || value.cliName === 'claude'
      || value.cliName === 'grok')
    && typeof value.version === 'string'
    && value.version.trim().length > 0
    && typeof value.platform === 'string'
    && value.platform.trim().length > 0
  );
}

function parseHealthEvidence(payload: unknown): HealthEvidenceRecord | undefined {
  if (!isRecord(payload)) return undefined;
  const evidenceId = payload.evidenceId;
  const kind = payload.kind;
  const status = payload.status;
  const capabilityKey = payload.capabilityKey;
  const taskId = payload.taskId;
  const attemptId = payload.attemptId;
  const authStatus = payload.authStatus;
  const readinessSucceeded = payload.readinessSucceeded;
  const probeCommand = payload.probeCommand;
  const probedAt = payload.probedAt;
  const expiresAt = payload.expiresAt;
  const createdAt = payload.createdAt;
  const consumedAt = payload.consumedAt;

  if (
    typeof evidenceId !== 'string'
    || (kind !== 'auth' && kind !== 'readiness')
    || (status !== 'valid' && status !== 'consumed')
    || !isCompatibilityKey(capabilityKey)
    || typeof taskId !== 'string'
    || typeof probedAt !== 'string'
    || !(expiresAt === null || typeof expiresAt === 'string')
    || typeof createdAt !== 'string'
  ) {
    return undefined;
  }

  if (kind === 'auth') {
    if (!isAuthStatus(authStatus)) return undefined;
  } else {
    if (typeof readinessSucceeded !== 'boolean') return undefined;
    if (typeof attemptId !== 'string' || attemptId.trim().length === 0) {
      return undefined;
    }
  }

  let parsedProbe: HealthProbeCommandEvidence | undefined;
  if (probeCommand !== undefined) {
    if (!isRecord(probeCommand)) return undefined;
    if (
      typeof probeCommand.executable !== 'string'
      || !Array.isArray(probeCommand.args)
      || !probeCommand.args.every((a) => typeof a === 'string')
    ) {
      return undefined;
    }
    parsedProbe = {
      executable: probeCommand.executable,
      args: [...(probeCommand.args as readonly string[])],
      ...(typeof probeCommand.cwd === 'string' ? { cwd: probeCommand.cwd } : {}),
      ...(typeof probeCommand.durationMs === 'number'
        ? { durationMs: probeCommand.durationMs }
        : {}),
    };
  }

  return {
    evidenceId,
    kind,
    status,
    capabilityKey: {
      cliName: capabilityKey.cliName,
      version: capabilityKey.version,
      platform: capabilityKey.platform as NodeJS.Platform,
    },
    taskId: taskId as TaskId,
    ...(typeof attemptId === 'string'
      ? { attemptId: attemptId as AttemptId }
      : {}),
    ...(kind === 'auth' && isAuthStatus(authStatus)
      ? { authStatus }
      : {}),
    ...(kind === 'readiness' && typeof readinessSucceeded === 'boolean'
      ? { readinessSucceeded }
      : {}),
    ...(parsedProbe === undefined ? {} : { probeCommand: parsedProbe }),
    probedAt,
    expiresAt,
    createdAt,
    ...(typeof consumedAt === 'string' ? { consumedAt } : {}),
  };
}

function actionTypeFor(kind: HealthEvidenceKind): string {
  return kind === 'auth' ? AUTH_ACTION_TYPE : READINESS_ACTION_TYPE;
}

/**
 * Persists Task 13 health/readiness probe evidence for fail-closed start-gate
 * verification. Callers pass evidence ids only — never free-form auth claims.
 *
 * Storage: pending_actions intent holds the initial record; single-use readiness
 * consumption is recorded by completing the action with an updated payload so
 * reuse fails closed on subsequent loads.
 */
export class HealthEvidenceRepository {
  readonly #actions: ActionRepository;

  public constructor(database: DatabaseSync) {
    this.#actions = new ActionRepository(database);
  }

  public put(record: HealthEvidenceRecord): HealthEvidenceRecord {
    const existing = this.get(record.evidenceId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(
          `health evidence id already stored with different payload: ${record.evidenceId}`,
        );
      }
      return existing;
    }
    this.#actions.recordIntent({
      actionId: record.evidenceId,
      taskId: record.taskId,
      idempotencyKey: `health-evidence:${record.kind}:${record.evidenceId}`,
      type: actionTypeFor(record.kind),
      payload: record,
    });
    return record;
  }

  public putAuth(input: {
    readonly evidenceId?: string;
    readonly capabilityKey: CompatibilityKey;
    readonly taskId: TaskId;
    readonly attemptId?: AttemptId;
    readonly authStatus: HealthAuthStatus;
    readonly probeCommand?: HealthProbeCommandEvidence;
    readonly probedAt: string;
    readonly expiresAt?: string | null;
    readonly createdAt?: string;
  }): HealthEvidenceRecord {
    const evidenceId = input.evidenceId ?? randomUUID();
    const createdAt = input.createdAt ?? input.probedAt;
    return this.put({
      evidenceId,
      kind: 'auth',
      status: 'valid',
      capabilityKey: {
        cliName: input.capabilityKey.cliName,
        version: input.capabilityKey.version,
        platform: input.capabilityKey.platform,
      },
      taskId: input.taskId,
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      authStatus: input.authStatus,
      ...(input.probeCommand === undefined
        ? {}
        : { probeCommand: input.probeCommand }),
      probedAt: input.probedAt,
      expiresAt: input.expiresAt === undefined ? null : input.expiresAt,
      createdAt,
    });
  }

  public putReadiness(input: {
    readonly evidenceId?: string;
    readonly capabilityKey: CompatibilityKey;
    readonly taskId: TaskId;
    readonly attemptId: AttemptId;
    readonly readinessSucceeded: boolean;
    readonly probeCommand?: HealthProbeCommandEvidence;
    readonly probedAt: string;
    readonly expiresAt?: string | null;
    readonly createdAt?: string;
  }): HealthEvidenceRecord {
    const evidenceId = input.evidenceId ?? randomUUID();
    const createdAt = input.createdAt ?? input.probedAt;
    return this.put({
      evidenceId,
      kind: 'readiness',
      status: 'valid',
      capabilityKey: {
        cliName: input.capabilityKey.cliName,
        version: input.capabilityKey.version,
        platform: input.capabilityKey.platform,
      },
      taskId: input.taskId,
      attemptId: input.attemptId,
      readinessSucceeded: input.readinessSucceeded,
      ...(input.probeCommand === undefined
        ? {}
        : { probeCommand: input.probeCommand }),
      probedAt: input.probedAt,
      expiresAt: input.expiresAt === undefined ? null : input.expiresAt,
      createdAt,
    });
  }

  public get(evidenceId: string): HealthEvidenceRecord | undefined {
    const action = this.#actions.get(evidenceId);
    if (action === undefined) return undefined;
    if (
      action.type !== AUTH_ACTION_TYPE
      && action.type !== READINESS_ACTION_TYPE
    ) {
      return undefined;
    }
    // After single-use consume, completed result holds the consumed record.
    if (action.status === 'completed' && action.result !== undefined) {
      return parseHealthEvidence(action.result);
    }
    return parseHealthEvidence(action.payload);
  }

  /**
   * Single-use consumption for readiness evidence after a successful start gate.
   * Reuse of the same readiness id fails closed on the next verify.
   */
  public markConsumed(evidenceId: string, consumedAt: string): HealthEvidenceRecord {
    const existing = this.get(evidenceId);
    if (existing === undefined) {
      throw new Error(`health evidence not found: ${evidenceId}`);
    }
    if (existing.status === 'consumed') {
      throw new Error(`health evidence already consumed: ${evidenceId}`);
    }
    if (existing.kind !== 'readiness') {
      throw new Error(`only readiness evidence may be consumed: ${evidenceId}`);
    }
    const updated: HealthEvidenceRecord = {
      ...existing,
      status: 'consumed',
      consumedAt,
    };
    this.#actions.markCompleted(evidenceId, { result: updated });
    const reloaded = this.get(evidenceId);
    if (reloaded === undefined) {
      throw new Error(`health evidence missing after consume: ${evidenceId}`);
    }
    return reloaded;
  }
}
