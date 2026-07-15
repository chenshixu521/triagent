import type { DatabaseSync } from 'node:sqlite';

import type { ProjectPathFlavor } from '../project/canonical-path.js';
import {
  withTransaction,
  type AsyncCallbackGuard,
} from './transaction.js';

export interface ProjectLock {
  readonly lockId: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly path: string;
  readonly canonicalRoot: string;
  readonly comparisonKey: string;
  readonly displayRoot: string;
  readonly pathFlavor: ProjectPathFlavor;
  readonly ownerToken: string;
  readonly ownerInstanceId: string;
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
  readonly heartbeatAt: string;
  readonly updatedAt: string;
  readonly releasedAt: string | null;
}

export interface NewProjectLock extends Omit<ProjectLock, 'releasedAt'> {}

interface LegacyProjectLockInput {
  readonly lockId: string;
  readonly projectId: string;
  readonly path: string;
  readonly ownerToken: string;
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
  readonly taskId?: string | null;
  readonly canonicalRoot?: string;
  readonly comparisonKey?: string;
  readonly displayRoot?: string;
  readonly pathFlavor?: ProjectPathFlavor;
  readonly ownerInstanceId?: string;
  readonly heartbeatAt?: string;
  readonly updatedAt?: string;
}

interface LockRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string | null;
  readonly path: string;
  readonly canonical_root: string | null;
  readonly comparison_key: string | null;
  readonly display_root: string | null;
  readonly path_flavor: ProjectPathFlavor | null;
  readonly owner_token: string;
  readonly owner_instance_id: string | null;
  readonly acquired_at: string;
  readonly lease_expires_at: string;
  readonly heartbeat_at: string | null;
  readonly updated_at: string | null;
  readonly released_at: string | null;
}

function lockFromRow(row: LockRow): ProjectLock {
  return {
    lockId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    path: row.path,
    canonicalRoot: row.canonical_root ?? row.path,
    comparisonKey: row.comparison_key ?? row.path.toLocaleLowerCase('en-US'),
    displayRoot: row.display_root ?? row.path,
    pathFlavor: row.path_flavor ?? 'windows',
    ownerToken: row.owner_token,
    ownerInstanceId: row.owner_instance_id ?? row.owner_token,
    acquiredAt: row.acquired_at,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at ?? row.acquired_at,
    updatedAt: row.updated_at ?? row.acquired_at,
    releasedAt: row.released_at,
  };
}

const SELECT_LOCK = `SELECT id, project_id, task_id, path, canonical_root,
  comparison_key, display_root, path_flavor, owner_token, owner_instance_id,
  acquired_at, lease_expires_at, heartbeat_at, updated_at, released_at
  FROM project_locks`;

export interface ReconciliationRecord {
  readonly decision: 'release';
  readonly reason: string;
  readonly evidence: string;
  readonly reconciledAt: string;
}

export interface LockRepositoryTransaction {
  findProjectIdForTask(taskId: string): string | undefined;
  get(lockId: string): ProjectLock | undefined;
  listActive(): readonly ProjectLock[];
  insert(lock: NewProjectLock): void;
  heartbeat(
    lockId: string,
    taskId: string,
    ownerInstanceId: string,
    heartbeatAt: string,
    leaseExpiresAt: string,
  ): number;
  release(
    lockId: string,
    taskId: string,
    ownerInstanceId: string,
    releasedAt: string,
  ): number;
  reconcileAndDelete(lockId: string, record: ReconciliationRecord): number;
}

export class LockRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public transact<Result>(
    operation: (transaction: LockRepositoryTransaction) => Result,
    ...asyncGuard: AsyncCallbackGuard<Result>
  ): Result {
    return withTransaction(
      this.database,
      () => operation(this.transactionView()),
      ...asyncGuard,
    );
  }

  public create(input: LegacyProjectLockInput): void {
    this.transact((transaction) => {
      transaction.insert({
        lockId: input.lockId,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        path: input.path,
        canonicalRoot: input.canonicalRoot ?? input.path,
        comparisonKey:
          input.comparisonKey ?? input.path.toLocaleLowerCase('en-US'),
        displayRoot: input.displayRoot ?? input.path,
        pathFlavor: input.pathFlavor ?? 'windows',
        ownerToken: input.ownerToken,
        ownerInstanceId: input.ownerInstanceId ?? input.ownerToken,
        acquiredAt: input.acquiredAt,
        leaseExpiresAt: input.leaseExpiresAt,
        heartbeatAt: input.heartbeatAt ?? input.acquiredAt,
        updatedAt: input.updatedAt ?? input.acquiredAt,
      });
    });
  }

  public get(lockId: string): ProjectLock | undefined {
    return this.readLock(lockId);
  }

  public updateLease(
    lockId: string,
    taskId: string,
    ownerInstanceId: string,
    heartbeatAt: string,
    leaseExpiresAt: string,
  ): void {
    if (
      typeof taskId !== 'string' ||
      taskId.trim().length === 0 ||
      typeof ownerInstanceId !== 'string' ||
      ownerInstanceId.trim().length === 0 ||
      typeof heartbeatAt !== 'string' ||
      typeof leaseExpiresAt !== 'string'
    ) {
      throw new Error(
        `project lock owner or task mismatch while renewing lease: ${lockId}`,
      );
    }
    this.transact((transaction) => {
      const changes = transaction.heartbeat(
        lockId,
        taskId,
        ownerInstanceId,
        heartbeatAt,
        leaseExpiresAt,
      );
      if (changes !== 1) {
        throw new Error(
          `project lock owner or task mismatch while renewing lease: ${lockId}`,
        );
      }
    });
  }

  public release(
    lockId: string,
    taskId: string,
    ownerInstanceId: string,
    releasedAt: string,
  ): void {
    if (
      typeof taskId !== 'string' ||
      taskId.trim().length === 0 ||
      typeof ownerInstanceId !== 'string' ||
      ownerInstanceId.trim().length === 0 ||
      typeof releasedAt !== 'string'
    ) {
      throw new Error(
        `project lock owner or task mismatch while releasing: ${lockId}`,
      );
    }
    this.transact((transaction) => {
      const changes = transaction.release(
        lockId,
        taskId,
        ownerInstanceId,
        releasedAt,
      );
      if (changes !== 1) {
        throw new Error(
          `project lock owner or task mismatch while releasing: ${lockId}`,
        );
      }
    });
  }

  public delete(lockId: string): void {
    withTransaction(this.database, () => {
      const result = this.database
        .prepare(
          'DELETE FROM project_locks WHERE id = ? AND released_at IS NOT NULL',
        )
        .run(lockId);
      if (result.changes === 0) {
        const existing = this.database
          .prepare('SELECT released_at FROM project_locks WHERE id = ?')
          .get(lockId) as { readonly released_at: string | null } | undefined;
        if (existing?.released_at === null) {
          throw new Error(
            `active project lock requires explicit reconcile before deletion: ${lockId}`,
          );
        }
      }
    });
  }

  public listActive(): readonly ProjectLock[] {
    return this.readActiveLocks();
  }

  private transactionView(): LockRepositoryTransaction {
    return {
      findProjectIdForTask: (taskId) => {
        const row = this.database
          .prepare('SELECT project_id FROM tasks WHERE id = ?')
          .get(taskId) as { readonly project_id: string } | undefined;
        return row?.project_id;
      },
      get: (lockId) => this.readLock(lockId),
      listActive: () => this.readActiveLocks(),
      insert: (lock) => {
        this.database
          .prepare(
            `INSERT INTO project_locks(
              id, project_id, task_id, path, canonical_root, comparison_key,
              display_root, path_flavor, owner_token, owner_instance_id,
              acquired_at, lease_expires_at, heartbeat_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            lock.lockId,
            lock.projectId,
            lock.taskId,
            lock.path,
            lock.canonicalRoot,
            lock.comparisonKey,
            lock.displayRoot,
            lock.pathFlavor,
            lock.ownerToken,
            lock.ownerInstanceId,
            lock.acquiredAt,
            lock.leaseExpiresAt,
            lock.heartbeatAt,
            lock.updatedAt,
          );
      },
      heartbeat: (
        lockId,
        taskId,
        ownerInstanceId,
        heartbeatAt,
        leaseExpiresAt,
      ) => Number(
        this.database
          .prepare(
            `UPDATE project_locks
             SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
             WHERE id = ? AND task_id = ? AND owner_instance_id = ?
               AND released_at IS NULL`,
          )
          .run(
            heartbeatAt,
            leaseExpiresAt,
            heartbeatAt,
            lockId,
            taskId,
            ownerInstanceId,
          ).changes,
      ),
      release: (lockId, taskId, ownerInstanceId, releasedAt) => Number(
        this.database
          .prepare(
            `UPDATE project_locks SET released_at = ?, updated_at = ?
             WHERE id = ? AND task_id = ? AND owner_instance_id = ?
               AND released_at IS NULL`,
          )
          .run(releasedAt, releasedAt, lockId, taskId, ownerInstanceId).changes,
      ),
      reconcileAndDelete: (lockId, record) => {
        const lock = this.readLock(lockId);
        if (lock === undefined) return 0;
        this.database
          .prepare(
            `INSERT INTO project_lock_reconciliations(
              lock_id, task_id, decision, reason, evidence,
              lock_snapshot_json, reconciled_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            lock.lockId,
            lock.taskId,
            record.decision,
            record.reason,
            record.evidence,
            JSON.stringify(lock),
            record.reconciledAt,
          );
        return Number(
          this.database.prepare('DELETE FROM project_locks WHERE id = ?').run(lockId)
            .changes,
        );
      },
    };
  }

  private readLock(lockId: string): ProjectLock | undefined {
    const row = this.database
      .prepare(`${SELECT_LOCK} WHERE id = ?`)
      .get(lockId) as unknown as LockRow | undefined;
    return row === undefined ? undefined : lockFromRow(row);
  }

  private readActiveLocks(): readonly ProjectLock[] {
    const rows = this.database
      .prepare(`${SELECT_LOCK} WHERE released_at IS NULL ORDER BY acquired_at, id`)
      .all() as unknown as LockRow[];
    return rows.map(lockFromRow);
  }

}
