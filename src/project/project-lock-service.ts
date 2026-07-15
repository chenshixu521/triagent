import { randomUUID } from 'node:crypto';

import type { TaskId } from '../domain/ids.js';
import type { OpenedDatabase } from '../persistence/database.js';
import {
  LockRepository,
  type ProjectLock,
} from '../persistence/lock-repository.js';
import {
  areProjectRootsOverlapping,
  type CanonicalProjectPath,
} from './canonical-path.js';

export interface ProjectLockLease extends ProjectLock {}

export interface ProjectLockConflict {
  readonly lockId: string;
  readonly taskId: string | null;
  readonly canonicalRoot: string;
  readonly displayRoot: string;
  readonly ownerInstanceId: string;
  readonly leaseExpiresAt: string;
  readonly heartbeatAt: string;
  readonly state: 'active' | 'stale_needs_reconcile';
  readonly needsReconcile: boolean;
}

export type AcquireProjectLockResult =
  | { readonly status: 'acquired'; readonly lock: ProjectLockLease }
  | { readonly status: 'conflict'; readonly conflict: ProjectLockConflict };

export type HeartbeatProjectLockResult =
  | { readonly status: 'renewed'; readonly lock: ProjectLockLease }
  | { readonly status: 'owner_or_task_mismatch' }
  | { readonly status: 'not_found' };

export type ReleaseProjectLockResult =
  | { readonly status: 'released'; readonly lock: ProjectLockLease }
  | { readonly status: 'owner_or_task_mismatch' }
  | { readonly status: 'not_found' };

export interface ReleaseAfterReconcileDecision {
  readonly decision: 'release';
  readonly reason: string;
  readonly evidence: string;
  readonly reconciledAt: Date;
}

export interface ProjectLockServiceOptions {
  readonly lockIdFactory?: () => string;
}

function isoUtc(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
  return value.toISOString();
}

function leaseExpiry(now: Date, leaseDurationMs: number): string {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error('leaseDuration must be a positive integer number of milliseconds');
  }
  const expiry = now.getTime() + leaseDurationMs;
  if (!Number.isFinite(expiry)) {
    throw new Error('lease expiry is outside the supported date range');
  }
  return isoUtc(new Date(expiry), 'lease expiry');
}

function conflictFromLock(lock: ProjectLock, now: Date): ProjectLockConflict {
  const leaseTime = Date.parse(lock.leaseExpiresAt);
  if (!Number.isFinite(leaseTime)) {
    throw new Error(`project lock has an invalid lease_expires_at: ${lock.lockId}`);
  }
  const stale = leaseTime <= now.getTime();
  return {
    lockId: lock.lockId,
    taskId: lock.taskId,
    canonicalRoot: lock.canonicalRoot,
    displayRoot: lock.displayRoot,
    ownerInstanceId: lock.ownerInstanceId,
    leaseExpiresAt: lock.leaseExpiresAt,
    heartbeatAt: lock.heartbeatAt,
    state: stale ? 'stale_needs_reconcile' : 'active',
    needsReconcile: stale,
  };
}

export class ProjectLockService {
  private readonly locks: LockRepository;
  private readonly lockIdFactory: () => string;

  public constructor(
    database: OpenedDatabase,
    options: ProjectLockServiceOptions = {},
  ) {
    if (database.mode !== 'read-write') {
      throw new Error(
        `cannot construct ProjectLockService in diagnostic read-only mode: ${database.diagnostics.error}`,
      );
    }
    this.locks = new LockRepository(database.connection);
    this.lockIdFactory = options.lockIdFactory ?? randomUUID;
  }

  public acquire(
    taskId: TaskId | string,
    project: CanonicalProjectPath,
    ownerInstanceId: string,
    now: Date,
    leaseDurationMs: number,
  ): AcquireProjectLockResult {
    if (String(taskId).trim().length === 0) throw new Error('taskId must not be empty');
    if (ownerInstanceId.trim().length === 0) {
      throw new Error('ownerInstanceId must not be empty');
    }
    if (project.canonicalRoot.trim().length === 0 || project.comparisonKey.trim().length === 0) {
      throw new Error('canonical project root must not be empty');
    }
    const acquiredAt = isoUtc(now, 'now');
    const leaseExpiresAt = leaseExpiry(now, leaseDurationMs);
    const taskIdValue = String(taskId);

    return this.locks.transact((transaction) => {
      const projectId = transaction.findProjectIdForTask(taskIdValue);
      if (projectId === undefined) {
        throw new Error(`task not found for project lock: ${taskIdValue}`);
      }
      const conflict = transaction.listActive().find((active) => {
        if (active.pathFlavor !== project.pathFlavor) return false;
        return areProjectRootsOverlapping(
          active.canonicalRoot,
          project.canonicalRoot,
          project.pathFlavor,
        );
      });
      if (conflict !== undefined) {
        return { status: 'conflict', conflict: conflictFromLock(conflict, now) };
      }

      const lockId = this.lockIdFactory();
      if (lockId.trim().length === 0) throw new Error('lockIdFactory returned an empty lock ID');
      transaction.insert({
        lockId,
        projectId,
        taskId: taskIdValue,
        path: project.canonicalRoot,
        canonicalRoot: project.canonicalRoot,
        comparisonKey: project.comparisonKey,
        displayRoot: project.displayPath,
        pathFlavor: project.pathFlavor,
        ownerToken: ownerInstanceId,
        ownerInstanceId,
        acquiredAt,
        leaseExpiresAt,
        heartbeatAt: acquiredAt,
        updatedAt: acquiredAt,
      });
      const inserted = transaction.get(lockId);
      if (inserted === undefined) {
        throw new Error(`inserted project lock could not be reloaded: ${lockId}`);
      }
      return { status: 'acquired', lock: inserted };
    });
  }

  public heartbeat(
    lockId: string,
    taskId: TaskId | string,
    ownerInstanceId: string,
    now: Date,
    leaseDurationMs: number,
  ): HeartbeatProjectLockResult {
    const heartbeatAt = isoUtc(now, 'now');
    const leaseExpiresAt = leaseExpiry(now, leaseDurationMs);
    return this.locks.transact((transaction) => {
      const changes = transaction.heartbeat(
        lockId,
        String(taskId),
        ownerInstanceId,
        heartbeatAt,
        leaseExpiresAt,
      );
      if (changes === 1) {
        const lock = transaction.get(lockId);
        if (lock === undefined) throw new Error(`renewed lock disappeared: ${lockId}`);
        return { status: 'renewed', lock };
      }
      return transaction.get(lockId) === undefined
        ? { status: 'not_found' }
        : { status: 'owner_or_task_mismatch' };
    });
  }

  public release(
    lockId: string,
    taskId: TaskId | string,
    ownerInstanceId: string,
    now: Date,
  ): ReleaseProjectLockResult {
    const releasedAt = isoUtc(now, 'now');
    return this.locks.transact((transaction) => {
      const changes = transaction.release(
        lockId,
        String(taskId),
        ownerInstanceId,
        releasedAt,
      );
      if (changes === 1) {
        const lock = transaction.get(lockId);
        if (lock === undefined) throw new Error(`released lock disappeared: ${lockId}`);
        return { status: 'released', lock };
      }
      return transaction.get(lockId) === undefined
        ? { status: 'not_found' }
        : { status: 'owner_or_task_mismatch' };
    });
  }

  public releaseAfterReconcile(
    lockId: string,
    decision: ReleaseAfterReconcileDecision,
  ): { readonly status: 'deleted' | 'not_found' } {
    if (decision.decision !== 'release') {
      throw new Error('reconcile decision must explicitly authorize release');
    }
    if (decision.reason.trim().length === 0) {
      throw new Error('reconcile release reason must not be empty');
    }
    if (decision.evidence.trim().length === 0) {
      throw new Error('reconcile release evidence must not be empty');
    }
    const reconciledAt = isoUtc(decision.reconciledAt, 'reconciledAt');
    return this.locks.transact((transaction) => {
      const changes = transaction.reconcileAndDelete(lockId, {
        decision: 'release',
        reason: decision.reason,
        evidence: decision.evidence,
        reconciledAt,
      });
      return { status: changes === 1 ? 'deleted' : 'not_found' };
    });
  }

  public get(lockId: string): ProjectLockLease | undefined {
    return this.locks.get(lockId);
  }
}
