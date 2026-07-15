import type { DatabaseSync } from 'node:sqlite';

import { asTaskId, type TaskId } from '../domain/ids.js';
import {
  MAX_REWORKS,
  WORKFLOW_STATES,
  validateWorkflowSnapshot,
  type WorkflowSnapshot,
  type WorkflowState,
} from '../workflow/states.js';
import { parseJsonValue, serializeJsonValue } from './json-value.js';
import { withTransaction } from './transaction.js';

export interface PersistedTask {
  readonly taskId: TaskId;
  readonly projectId: string;
  readonly workflowSnapshot: WorkflowSnapshot;
  readonly workflowVersion: number;
  readonly status: WorkflowState;
}

export interface CreateTaskInput extends PersistedTask {}

export interface UpdateWorkflowInput {
  readonly workflowSnapshot: WorkflowSnapshot;
  readonly expectedVersion: number;
  readonly status: WorkflowState;
}

interface TaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly workflow_snapshot: string;
  readonly workflow_version: number;
  readonly status: string;
}

function assertPositiveVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error('workflow version must be a positive integer');
  }
}

function assertWorkflowState(status: string): asserts status is WorkflowState {
  if (!(WORKFLOW_STATES as readonly string[]).includes(status)) {
    throw new Error(`invalid task status: ${status}`);
  }
}

function assertSnapshot(
  snapshot: unknown,
  expectedTaskId: TaskId,
  expectedStatus: WorkflowState,
): asserts snapshot is WorkflowSnapshot {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Error('invalid workflow snapshot: expected an object');
  }
  const candidate = snapshot as Record<string, unknown>;
  if (
    candidate.taskId !== expectedTaskId ||
    candidate.state !== expectedStatus ||
    typeof candidate.requirementVersion !== 'number' ||
    !Number.isSafeInteger(candidate.requirementVersion) ||
    candidate.requirementVersion <= 0 ||
    typeof candidate.reworkCount !== 'number' ||
    !Number.isSafeInteger(candidate.reworkCount) ||
    candidate.reworkCount < 0 ||
    candidate.reworkCount > MAX_REWORKS ||
    typeof candidate.maxReworks !== 'number' ||
    candidate.maxReworks !== MAX_REWORKS ||
    typeof candidate.pauseAfterAttempt !== 'boolean'
  ) {
    throw new Error('invalid workflow snapshot: required fields do not match the task');
  }
  if (candidate.reworkRequest !== undefined) {
    const reworkRequest = candidate.reworkRequest;
    if (
      typeof reworkRequest !== 'object' ||
      reworkRequest === null ||
      !Number.isSafeInteger(
        (reworkRequest as Record<string, unknown>).nextReworkNumber,
      ) ||
      ((reworkRequest as Record<string, unknown>).nextReworkNumber as number) < 1 ||
      ((reworkRequest as Record<string, unknown>).nextReworkNumber as number) >
        MAX_REWORKS
    ) {
      throw new Error('invalid workflow snapshot: rework counter is outside domain bounds');
    }
  }
  const validation = validateWorkflowSnapshot(snapshot as WorkflowSnapshot);
  if (!validation.valid) {
    throw new Error(`invalid workflow snapshot: ${validation.reason}`);
  }
}

function serializeSnapshot(
  snapshot: WorkflowSnapshot,
  taskId: TaskId,
  status: WorkflowState,
): string {
  assertSnapshot(snapshot, taskId, status);
  const canonical: WorkflowSnapshot = {
    state: snapshot.state,
    taskId: snapshot.taskId,
    requirementVersion: snapshot.requirementVersion,
    reworkCount: snapshot.reworkCount,
    maxReworks: snapshot.maxReworks,
    pauseAfterAttempt: snapshot.pauseAfterAttempt,
    ...(snapshot.resumeTargetState === undefined
      ? {}
      : { resumeTargetState: snapshot.resumeTargetState }),
    ...(snapshot.pendingResumeAttempt === undefined
      ? {}
      : {
          pendingResumeAttempt: {
            attemptId: snapshot.pendingResumeAttempt.attemptId,
            baselineId: snapshot.pendingResumeAttempt.baselineId,
            role: snapshot.pendingResumeAttempt.role,
          },
        }),
    ...(snapshot.awaitingResumeTargetState === undefined
      ? {}
      : { awaitingResumeTargetState: snapshot.awaitingResumeTargetState }),
    ...(snapshot.inspectionResumeTargetState === undefined
      ? {}
      : { inspectionResumeTargetState: snapshot.inspectionResumeTargetState }),
    ...(snapshot.activeAttemptId === undefined
      ? {}
      : { activeAttemptId: snapshot.activeAttemptId }),
    ...(snapshot.activeAttemptBaselineId === undefined
      ? {}
      : { activeAttemptBaselineId: snapshot.activeAttemptBaselineId }),
    ...(snapshot.activeAttemptRole === undefined
      ? {}
      : { activeAttemptRole: snapshot.activeAttemptRole }),
    ...(snapshot.stopIntent === undefined
      ? {}
      : { stopIntent: snapshot.stopIntent }),
    ...(snapshot.awaitingReason === undefined
      ? {}
      : { awaitingReason: snapshot.awaitingReason }),
    ...(snapshot.allowedAwaitingActions === undefined
      ? {}
      : { allowedAwaitingActions: [...snapshot.allowedAwaitingActions] }),
    ...(snapshot.reworkRequest === undefined
      ? {}
      : {
          reworkRequest: {
            status: snapshot.reworkRequest.status,
            reason: snapshot.reworkRequest.reason,
            nextReworkNumber: snapshot.reworkRequest.nextReworkNumber,
          },
        }),
  } as WorkflowSnapshot;
  return serializeJsonValue(canonical);
}

function taskFromRow(row: TaskRow): PersistedTask {
  const taskId = asTaskId(row.id);
  assertWorkflowState(row.status);
  assertPositiveVersion(row.workflow_version);
  const parsed = parseJsonValue(row.workflow_snapshot, 'workflow snapshot');
  assertSnapshot(parsed, taskId, row.status);
  return {
    taskId,
    projectId: row.project_id,
    workflowSnapshot: parsed,
    workflowVersion: row.workflow_version,
    status: row.status,
  };
}

export class TaskRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public createProject(input: {
    readonly projectId: string;
    readonly rootPath: string;
  }): string {
    if (input.projectId.trim() === '' || input.rootPath.trim() === '') {
      throw new Error('project id and root path must be non-empty');
    }
    const projectId = input.projectId.trim();
    const rootPath = input.rootPath.trim();
    const now = new Date().toISOString();
    const row = this.database
      .prepare(
        `INSERT INTO projects(id, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(root_path) DO UPDATE SET updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(projectId, rootPath, now, now) as unknown as { readonly id: string } | undefined;
    if (row === undefined) {
      throw new Error(`failed to resolve project for root path: ${rootPath}`);
    }
    return row.id;
  }

  public create(input: CreateTaskInput): void {
    assertWorkflowState(input.status);
    assertPositiveVersion(input.workflowVersion);
    const serialized = serializeSnapshot(
      input.workflowSnapshot,
      input.taskId,
      input.status,
    );
    const now = new Date().toISOString();
    withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO tasks(
            id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.taskId,
          input.projectId,
          input.status,
          input.workflowVersion,
          serialized,
          now,
          now,
        );
    });
  }

  public get(taskId: TaskId): PersistedTask | undefined {
    const row = this.database
      .prepare(
        `SELECT id, project_id, workflow_snapshot, workflow_version, status
         FROM tasks WHERE id = ?`,
      )
      .get(taskId) as unknown as TaskRow | undefined;
    return row === undefined ? undefined : taskFromRow(row);
  }

  public updateWorkflow(taskId: TaskId, input: UpdateWorkflowInput): void {
    assertWorkflowState(input.status);
    assertPositiveVersion(input.expectedVersion);
    const nextVersion = input.expectedVersion + 1;
    assertPositiveVersion(nextVersion);
    const serialized = serializeSnapshot(
      input.workflowSnapshot,
      taskId,
      input.status,
    );
    withTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE tasks
           SET status = ?, workflow_version = ?, workflow_snapshot = ?, updated_at = ?
           WHERE id = ? AND workflow_version = ?`,
        )
        .run(
          input.status,
          nextVersion,
          serialized,
          new Date().toISOString(),
          taskId,
          input.expectedVersion,
        );
      if (result.changes !== 1) {
        throw new Error(
          `stale workflow version for task ${taskId}: expected ${input.expectedVersion}`,
        );
      }
    });
  }
}
