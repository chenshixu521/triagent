import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  IMPLEMENTATION_WORKSPACE_STATUSES,
  type ConsumeImplementationWorkspaceAuthorizationResult,
  type CreateImplementationWorkspaceInput,
  type ImplementationWorkspaceAuthorizationIntent,
  type ImplementationWorkspaceRecord,
  type ImplementationWorkspaceStatus,
  type TransitionImplementationWorkspaceInput,
} from './implementation-workspace-types.js';

const STATUS_SET = new Set<string>(IMPLEMENTATION_WORKSPACE_STATUSES);
const LEGAL_TRANSITIONS: Readonly<Record<ImplementationWorkspaceStatus, ReadonlySet<ImplementationWorkspaceStatus>>> = {
  preparing: new Set(['ready', 'abandoned', 'recovery_required']),
  ready: new Set(['running', 'abandoned', 'recovery_required']),
  running: new Set(['candidate_ready', 'abandoned', 'recovery_required']),
  candidate_ready: new Set(['under_review', 'abandoned', 'recovery_required']),
  under_review: new Set(['approved', 'rejected', 'abandoned', 'recovery_required']),
  approved: new Set(['validating', 'abandoned', 'recovery_required']),
  validating: new Set(['promoting', 'rejected', 'abandoned', 'recovery_required']),
  promoting: new Set(['promoted', 'recovery_required']),
  promoted: new Set(),
  rejected: new Set(),
  abandoned: new Set(),
  recovery_required: new Set(['abandoned']),
};

interface WorkspaceRow {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly canonicalProjectRoot: string;
  readonly workspaceRoot: string;
  readonly sourceBaselineId: string;
  readonly sourceManifestHash: string;
  readonly candidateManifestHash: string | null;
  readonly changeSetHash: string | null;
  readonly status: string;
  readonly authorizationId: string;
  readonly authorizationExpiresAt: string;
  readonly authorizationConsumedAt: string | null;
  readonly retainedUntil: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must be non-empty`);
  return trimmed;
}

function sha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
  return normalized;
}

function iso(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return normalized;
}

function absolutePath(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (!isAbsolute(normalized)) throw new Error(`${label} must be absolute`);
  return resolve(normalized);
}

function comparisonPath(value: string): string {
  const normalized = resolve(value).replaceAll('/', '\\');
  return process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function parseRow(row: WorkspaceRow | undefined): ImplementationWorkspaceRecord | undefined {
  if (row === undefined) return undefined;
  if (!STATUS_SET.has(row.status)) {
    throw new Error(`invalid implementation workspace status: ${row.status}`);
  }
  const record: ImplementationWorkspaceRecord = {
    workspaceId: requiredText(row.workspaceId, 'workspaceId'),
    taskId: requiredText(row.taskId, 'taskId'),
    attemptId: requiredText(row.attemptId, 'attemptId'),
    canonicalProjectRoot: absolutePath(row.canonicalProjectRoot, 'canonicalProjectRoot'),
    workspaceRoot: absolutePath(row.workspaceRoot, 'workspaceRoot'),
    sourceBaselineId: requiredText(row.sourceBaselineId, 'sourceBaselineId'),
    sourceManifestHash: sha256(row.sourceManifestHash, 'sourceManifestHash'),
    candidateManifestHash: row.candidateManifestHash === null
      ? null
      : sha256(row.candidateManifestHash, 'candidateManifestHash'),
    changeSetHash: row.changeSetHash === null
      ? null
      : sha256(row.changeSetHash, 'changeSetHash'),
    status: row.status as ImplementationWorkspaceStatus,
    authorizationId: requiredText(row.authorizationId, 'authorizationId'),
    authorizationExpiresAt: iso(row.authorizationExpiresAt, 'authorizationExpiresAt'),
    authorizationConsumedAt: row.authorizationConsumedAt,
    retainedUntil: row.retainedUntil,
    lastError: row.lastError,
    createdAt: iso(row.createdAt, 'createdAt'),
    updatedAt: iso(row.updatedAt, 'updatedAt'),
  };
  return Object.freeze(record);
}

function expired(expiresAt: string, nowMs: number): boolean {
  const value = Date.parse(expiresAt);
  return !Number.isFinite(value) || value <= nowMs;
}

export class ImplementationWorkspaceRepository {
  readonly #database: DatabaseSync;

  public constructor(database: DatabaseSync) {
    this.#database = database;
  }

  public create(input: CreateImplementationWorkspaceInput): ImplementationWorkspaceRecord {
    const canonicalProjectRoot = absolutePath(
      input.canonicalProjectRoot,
      'canonicalProjectRoot',
    );
    const workspaceRoot = absolutePath(input.workspaceRoot, 'workspaceRoot');
    if (comparisonPath(canonicalProjectRoot) === comparisonPath(workspaceRoot)) {
      throw new Error('workspaceRoot must differ from canonicalProjectRoot');
    }
    const nowIso = iso(input.nowIso, 'nowIso');
    this.#database.prepare(
      `INSERT INTO implementation_workspaces(
         id, task_id, attempt_id, canonical_project_root, workspace_root,
         source_baseline_id, source_manifest_hash, candidate_manifest_hash,
         change_set_hash, status, authorization_id, authorization_expires_at,
         authorization_consumed_at, retained_until, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'preparing', ?, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(
      requiredText(input.workspaceId, 'workspaceId'),
      requiredText(input.taskId, 'taskId'),
      requiredText(input.attemptId, 'attemptId'),
      canonicalProjectRoot,
      workspaceRoot,
      requiredText(input.sourceBaselineId, 'sourceBaselineId'),
      sha256(input.sourceManifestHash, 'sourceManifestHash'),
      requiredText(input.authorizationId, 'authorizationId'),
      iso(input.authorizationExpiresAt, 'authorizationExpiresAt'),
      nowIso,
      nowIso,
    );
    return this.get(input.workspaceId)!;
  }

  public get(workspaceId: string): ImplementationWorkspaceRecord | undefined {
    const row = this.#database.prepare(
      `SELECT
         id AS workspaceId,
         task_id AS taskId,
         attempt_id AS attemptId,
         canonical_project_root AS canonicalProjectRoot,
         workspace_root AS workspaceRoot,
         source_baseline_id AS sourceBaselineId,
         source_manifest_hash AS sourceManifestHash,
         candidate_manifest_hash AS candidateManifestHash,
         change_set_hash AS changeSetHash,
         status,
         authorization_id AS authorizationId,
         authorization_expires_at AS authorizationExpiresAt,
         authorization_consumed_at AS authorizationConsumedAt,
         retained_until AS retainedUntil,
         last_error AS lastError,
         created_at AS createdAt,
         updated_at AS updatedAt
       FROM implementation_workspaces WHERE id = ?`,
    ).get(requiredText(workspaceId, 'workspaceId')) as WorkspaceRow | undefined;
    return parseRow(row);
  }

  public getByAuthorizationId(
    authorizationId: string,
  ): ImplementationWorkspaceRecord | undefined {
    const row = this.#database.prepare(
      `SELECT id AS workspaceId FROM implementation_workspaces
       WHERE authorization_id = ?`,
    ).get(requiredText(authorizationId, 'authorizationId')) as
      | { readonly workspaceId: string }
      | undefined;
    if (row === undefined) return undefined;
    return this.get(row.workspaceId);
  }

  public listAll(): readonly ImplementationWorkspaceRecord[] {
    const rows = this.#database.prepare(
      `SELECT id AS workspaceId FROM implementation_workspaces
       ORDER BY created_at ASC, id ASC`,
    ).all() as Array<{ readonly workspaceId: string }>;
    return rows.map((row) => this.get(row.workspaceId)!);
  }

  public listByTaskId(taskId: string): readonly ImplementationWorkspaceRecord[] {
    const rows = this.#database.prepare(
      `SELECT id AS workspaceId FROM implementation_workspaces
       WHERE task_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(requiredText(taskId, 'taskId')) as Array<{ readonly workspaceId: string }>;
    return rows.map((row) => this.get(row.workspaceId)!);
  }

  public delete(workspaceId: string): void {
    const result = this.#database.prepare(
      `DELETE FROM implementation_workspaces WHERE id = ?`,
    ).run(requiredText(workspaceId, 'workspaceId'));
    if (Number(result.changes) !== 1) {
      throw new Error(`implementation workspace not found for delete: ${workspaceId}`);
    }
  }

  /**
   * Set or clear retention deadline without changing lifecycle status.
   * Used for terminal rejected rows and post-promotion bookkeeping.
   */
  public setRetainedUntil(input: {
    readonly workspaceId: string;
    readonly retainedUntil: string | null;
    readonly nowIso: string;
  }): ImplementationWorkspaceRecord {
    const current = this.get(input.workspaceId);
    if (current === undefined) {
      throw new Error(`implementation workspace not found: ${input.workspaceId}`);
    }
    const retainedUntil = input.retainedUntil === null
      ? null
      : iso(input.retainedUntil, 'retainedUntil');
    this.#database.prepare(
      `UPDATE implementation_workspaces
       SET retained_until = ?, updated_at = ?
       WHERE id = ?`,
    ).run(retainedUntil, iso(input.nowIso, 'nowIso'), current.workspaceId);
    return this.get(current.workspaceId)!;
  }

  public transition(input: TransitionImplementationWorkspaceInput): ImplementationWorkspaceRecord {
    if (!LEGAL_TRANSITIONS[input.expectedStatus].has(input.status)) {
      throw new Error(
        `illegal implementation workspace transition: ${input.expectedStatus} -> ${input.status}`,
      );
    }
    const current = this.get(input.workspaceId);
    if (current === undefined) throw new Error(`implementation workspace not found: ${input.workspaceId}`);
    if (current.status !== input.expectedStatus) {
      throw new Error(
        `implementation workspace status mismatch: expected ${input.expectedStatus}, got ${current.status}`,
      );
    }
    const candidateManifestHash = input.candidateManifestHash === undefined
      ? current.candidateManifestHash
      : sha256(input.candidateManifestHash, 'candidateManifestHash');
    const changeSetHash = input.changeSetHash === undefined
      ? current.changeSetHash
      : sha256(input.changeSetHash, 'changeSetHash');
    const result = this.#database.prepare(
      `UPDATE implementation_workspaces
       SET status = ?, candidate_manifest_hash = ?, change_set_hash = ?,
           retained_until = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
    ).run(
      input.status,
      candidateManifestHash,
      changeSetHash,
      input.retainedUntil === undefined ? current.retainedUntil : input.retainedUntil,
      input.lastError === undefined ? current.lastError : input.lastError,
      iso(input.nowIso, 'nowIso'),
      current.workspaceId,
      input.expectedStatus,
    );
    if (Number(result.changes) !== 1) {
      throw new Error('implementation workspace transition lost an optimistic concurrency race');
    }
    return this.get(current.workspaceId)!;
  }

  public consumeAuthorization(
    authorizationId: string,
    intent: ImplementationWorkspaceAuthorizationIntent,
    options: { readonly nowMs?: number } = {},
  ): ConsumeImplementationWorkspaceAuthorizationResult {
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs)) return { ok: false, reason: 'invalid authorization time' };
    const id = requiredText(authorizationId, 'authorizationId');
    this.#database.exec('BEGIN IMMEDIATE');
    const reject = (reason: string): ConsumeImplementationWorkspaceAuthorizationResult => {
      this.#database.exec('ROLLBACK');
      return { ok: false, reason };
    };
    try {
      const row = this.#database.prepare(
        `SELECT id AS workspaceId FROM implementation_workspaces
         WHERE authorization_id = ?`,
      ).get(id) as { readonly workspaceId: string } | undefined;
      if (row === undefined) return reject(`workspace authorization not found: ${id}`);
      const record = this.get(row.workspaceId)!;
      if (record.authorizationConsumedAt !== null || record.status === 'running') {
        return reject(`workspace authorization already consumed (reused): ${id}`);
      }
      if (record.status !== 'ready') {
        return reject(`workspace authorization is not ready: ${record.status}`);
      }
      if (expired(record.authorizationExpiresAt, nowMs)) {
        return reject(`workspace authorization expired: ${id}`);
      }
      if (
        record.taskId !== intent.taskId
        || record.attemptId !== intent.attemptId
        || comparisonPath(record.workspaceRoot) !== comparisonPath(intent.workspaceRoot)
        || record.sourceManifestHash !== intent.sourceManifestHash.toLowerCase()
      ) {
        return reject(`workspace authorization intent mismatch: ${id}`);
      }
      const consumedAt = new Date(nowMs).toISOString();
      const result = this.#database.prepare(
        `UPDATE implementation_workspaces
         SET status = 'running', authorization_consumed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'ready' AND authorization_consumed_at IS NULL`,
      ).run(consumedAt, consumedAt, record.workspaceId);
      if (Number(result.changes) !== 1) {
        return reject(`workspace authorization already consumed (reused): ${id}`);
      }
      this.#database.exec('COMMIT');
      return { ok: true, record: this.get(record.workspaceId)! };
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }
}
