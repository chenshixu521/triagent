import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  asAttemptId,
  asBaselineId,
  asConversationId,
  asTaskId,
} from '../../../src/domain/ids.js';
import { createPendingRunAttempt } from '../../../src/domain/attempt.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';

const directories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

function openTemporaryDatabase(): ReadWriteDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-reconcile-'));
  directories.push(directory);
  const opened = openDatabase(join(directory, 'triagent.sqlite'));
  openedDatabases.push(opened);
  expect(opened.mode).toBe('read-write');
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return opened;
}

afterEach(() => {
  for (const opened of openedDatabases.splice(0).reverse()) {
    opened.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('intent/result and crash-window reconciliation', () => {
  it('persists attempt lifecycle fields and action results without duplicate intent keys', () => {
    const opened = openTemporaryDatabase();
    const repositories = createPersistenceRepositories(opened);
    const taskId = asTaskId('task-1');
    repositories.tasks.createProject({ projectId: 'project-1', rootPath: 'D:\\repo' });
    repositories.tasks.create({
      taskId,
      projectId: 'project-1',
      workflowSnapshot: createInitialWorkflow(taskId),
      workflowVersion: 1,
      status: 'draft',
    });

    const attemptId = asAttemptId('attempt-1');
    repositories.attempts.create(
      taskId,
      createPendingRunAttempt({
        attemptId,
        baselineId: asBaselineId('baseline-1'),
        requirementVersion: 1,
        startedAt: '2026-07-12T00:00:00.000Z',
      }),
    );
    repositories.attempts.markActive(attemptId, {
      role: 'implementer',
      pid: 4242,
      processStartedAt: '2026-07-12T00:00:01.000Z',
      conversationId: asConversationId('conversation-1'),
    });
    repositories.attempts.markCompleted(attemptId, {
      endedAt: '2026-07-12T00:01:00.000Z',
      exitReason: 'completed',
    });

    expect(repositories.attempts.get(attemptId)).toMatchObject({
      status: 'completed',
      role: 'implementer',
      pid: 4242,
      processStartedAt: '2026-07-12T00:00:01.000Z',
      endedAt: '2026-07-12T00:01:00.000Z',
      exitReason: 'completed',
      conversationId: 'conversation-1',
      baselineId: 'baseline-1',
      requirementVersion: 1,
    });

    repositories.actions.recordIntent({
      actionId: 'action-complete',
      taskId,
      idempotencyKey: 'start:attempt-1',
      type: 'start-process',
      payload: { command: 'codex' },
    });
    repositories.actions.markCompleted('action-complete', {
      result: { pid: 4242 },
    });
    repositories.actions.recordIntent({
      actionId: 'action-failed',
      taskId,
      idempotencyKey: 'deliver:message-1',
      type: 'deliver-message',
      payload: { messageId: 'message-1' },
    });
    repositories.actions.markFailed('action-failed', {
      error: 'agent unavailable',
      result: { retryable: true },
    });

    expect(() =>
      repositories.actions.recordIntent({
        actionId: 'action-duplicate',
        taskId,
        idempotencyKey: 'start:attempt-1',
        type: 'start-process',
        payload: { command: 'codex --again' },
      }),
    ).toThrow(/idempotency/i);
    expect(repositories.actions.listPending()).toEqual([]);
    opened.close();
  });

  it('rejects lossy or non-JSON action values before writing intent or result rows', () => {
    const opened = openTemporaryDatabase();
    const repositories = createPersistenceRepositories(opened);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const invalidValues: readonly (readonly [string, unknown])[] = [
      ['undefined', { nested: { value: undefined } }],
      ['function', { nested: [() => undefined] }],
      ['symbol', { nested: { value: Symbol('hidden') } }],
      ['bigint', { nested: { value: 1n } }],
      ['NaN', { nested: { value: Number.NaN } }],
      ['Infinity', { nested: { value: Number.POSITIVE_INFINITY } }],
      ['cycle', { nested: cycle }],
      ['Date', { nested: { value: new Date('2026-07-12T00:00:00.000Z') } }],
      ['Map', { nested: { value: new Map([['key', 'value']]) } }],
    ];

    for (const [index, [label, payload]] of invalidValues.entries()) {
      expect(
        () =>
          repositories.actions.recordIntent({
            actionId: `invalid-action-${index}`,
            idempotencyKey: `invalid:${index}`,
            type: 'invalid-json-test',
            payload,
          }),
        label,
      ).toThrow(/invalid JSON value|strict JSON/i);
    }
    expect(
      opened.connection.prepare('SELECT COUNT(*) AS count FROM pending_actions').get(),
    ).toEqual({ count: 0 });

    repositories.actions.recordIntent({
      actionId: 'invalid-result-action',
      idempotencyKey: 'invalid:result',
      type: 'invalid-result-test',
      payload: { valid: true },
    });
    expect(() =>
      repositories.actions.markCompleted('invalid-result-action', {
        result: { nested: new Date('2026-07-12T00:00:00.000Z') },
      }),
    ).toThrow(/invalid JSON value|strict JSON/i);
    expect(repositories.actions.get('invalid-result-action')).toMatchObject({
      status: 'intent',
    });
  });

  it('rejects conversation identity on pending attempts at the schema and mapping boundaries', () => {
    const opened = openTemporaryDatabase();
    const repositories = createPersistenceRepositories(opened);
    const taskId = asTaskId('task-pending-conversation');
    repositories.tasks.createProject({ projectId: 'project-1', rootPath: 'D:\\repo' });
    repositories.tasks.create({
      taskId,
      projectId: 'project-1',
      workflowSnapshot: createInitialWorkflow(taskId),
      workflowVersion: 1,
      status: 'draft',
    });
    const insertPendingWithConversation = opened.connection.prepare(
      `INSERT INTO run_attempts(
        id, task_id, status, started_at, baseline_id, requirement_version, conversation_id
      ) VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
    );

    expect(() =>
      insertPendingWithConversation.run(
        'attempt-schema-rejected',
        taskId,
        '2026-07-12T00:00:00.000Z',
        'baseline-schema-rejected',
        1,
        'conversation-too-early',
      ),
    ).toThrow(/check constraint/i);

    opened.connection.exec('PRAGMA ignore_check_constraints = ON');
    insertPendingWithConversation.run(
      'attempt-corrupt-history',
      taskId,
      '2026-07-12T00:00:00.000Z',
      'baseline-corrupt-history',
      1,
      'conversation-corrupt-history',
    );
    opened.connection.exec('PRAGMA ignore_check_constraints = OFF');

    expect(() =>
      repositories.attempts.get(asAttemptId('attempt-corrupt-history')),
    ).toThrow(/pending run attempt.*conversation/i);
    opened.close();
  });

  it('enumerates unresolved crash windows after reopening the database', () => {
    const opened = openTemporaryDatabase();
    const path = opened.path;
    const repositories = createPersistenceRepositories(opened);
    const taskId = asTaskId('task-crash');
    repositories.tasks.createProject({ projectId: 'project-1', rootPath: 'D:\\repo' });
    repositories.tasks.create({
      taskId,
      projectId: 'project-1',
      workflowSnapshot: createInitialWorkflow(taskId),
      workflowVersion: 1,
      status: 'draft',
    });
    repositories.attempts.create(
      taskId,
      createPendingRunAttempt({
        attemptId: asAttemptId('attempt-pending'),
        baselineId: asBaselineId('baseline-pending'),
        requirementVersion: 1,
        startedAt: '2026-07-12T00:00:00.000Z',
      }),
    );
    repositories.actions.recordIntent({
      actionId: 'intent-not-started',
      taskId,
      idempotencyKey: 'intent:not-started',
      type: 'start-process',
      payload: { attemptId: 'attempt-pending' },
    });
    opened.connection
      .prepare(
        "INSERT INTO file_baselines(id, task_id, attempt_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      )
      .run('baseline-pending', taskId, 'attempt-pending', '2026-07-12T00:00:00.000Z');
    opened.connection
      .prepare(
        "INSERT INTO user_messages(id, task_id, body, status, created_at) VALUES (?, ?, ?, 'queued', ?)",
      )
      .run('message-queued', taskId, 'continue', '2026-07-12T00:00:00.000Z');
    opened.close();

    const reopenedResult = openDatabase(path);
    openedDatabases.push(reopenedResult);
    expect(reopenedResult.mode).toBe('read-write');
    if (reopenedResult.mode !== 'read-write') {
      throw new Error(reopenedResult.diagnostics.error);
    }
    const reopened = createPersistenceRepositories(reopenedResult);

    expect(reopened.attempts.listIncomplete(taskId)).toEqual([
      expect.objectContaining({ attemptId: 'attempt-pending', status: 'pending' }),
    ]);
    expect(reopened.actions.listPending()).toEqual([
      expect.objectContaining({
        actionId: 'intent-not-started',
        status: 'intent',
        payload: { attemptId: 'attempt-pending' },
      }),
    ]);
    expect(
      reopenedResult.connection
        .prepare("SELECT id, status FROM file_baselines WHERE status != 'complete'")
        .all(),
    ).toEqual([{ id: 'baseline-pending', status: 'pending' }]);
    expect(
      reopenedResult.connection
        .prepare("SELECT id, status FROM user_messages WHERE status = 'queued'")
        .all(),
    ).toEqual([{ id: 'message-queued', status: 'queued' }]);
    reopenedResult.close();
  });

  it('provides persistent lock CRUD and owner-scoped lease fields without conflict policy', () => {
    const opened = openTemporaryDatabase();
    const repositories = createPersistenceRepositories(opened);
    repositories.tasks.createProject({ projectId: 'project-1', rootPath: 'D:\\repo' });
    const taskId = asTaskId('task-lock-1');
    repositories.tasks.create({
      taskId,
      projectId: 'project-1',
      workflowSnapshot: createInitialWorkflow(taskId),
      workflowVersion: 1,
      status: 'draft',
    });

    repositories.locks.create({
      lockId: 'lock-1',
      projectId: 'project-1',
      taskId,
      path: 'D:\\repo',
      ownerToken: 'owner-1',
      ownerInstanceId: 'owner-1',
      acquiredAt: '2026-07-12T00:00:00.000Z',
      leaseExpiresAt: '2026-07-12T00:05:00.000Z',
    });
    repositories.locks.updateLease(
      'lock-1',
      taskId,
      'owner-1',
      '2026-07-12T00:01:00.000Z',
      '2026-07-12T00:10:00.000Z',
    );
    expect(repositories.locks.get('lock-1')).toMatchObject({
      ownerToken: 'owner-1',
      leaseExpiresAt: '2026-07-12T00:10:00.000Z',
      releasedAt: null,
    });
    repositories.locks.release(
      'lock-1',
      taskId,
      'owner-1',
      '2026-07-12T00:02:00.000Z',
    );
    expect(repositories.locks.listActive()).toEqual([]);
    repositories.locks.delete('lock-1');
    expect(repositories.locks.get('lock-1')).toBeUndefined();
    opened.close();
  });
});
