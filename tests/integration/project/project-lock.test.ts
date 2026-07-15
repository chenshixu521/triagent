import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { asTaskId } from '../../../src/domain/ids.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import { canonicalizeProjectPath } from '../../../src/project/canonical-path.js';
import { ProjectLockService } from '../../../src/project/project-lock-service.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-lock-'));
  temporaryDirectories.push(directory);
  return directory;
}

function trackedOpenDatabase(path: string): OpenedDatabase {
  const opened = openDatabase(path);
  openedDatabases.push(opened);
  return opened;
}

function requireReadWrite(opened: OpenedDatabase): ReadWriteDatabase {
  expect(opened.mode).toBe('read-write');
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return opened;
}

function seedTask(
  opened: ReadWriteDatabase,
  taskIdValue: string,
  projectId: string,
  rootPath: string,
): ReturnType<typeof asTaskId> {
  const taskId = asTaskId(taskIdValue);
  const repositories = createPersistenceRepositories(opened);
  repositories.tasks.createProject({ projectId, rootPath });
  repositories.tasks.create({
    taskId,
    projectId,
    workflowSnapshot: createInitialWorkflow(taskId),
    workflowVersion: 1,
    status: 'draft',
  });
  return taskId;
}

afterEach(() => {
  for (const opened of openedDatabases.splice(0).reverse()) {
    opened.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ProjectLockService', () => {
  it('atomically rejects same-root and parent-child locks while allowing siblings and textual prefixes', () => {
    const fixture = temporaryDirectory();
    const parent = join(fixture, 'repo');
    const child = join(parent, 'packages', 'a');
    const sibling = join(fixture, 'sibling');
    const textualPrefix = join(fixture, 'repo-a');
    mkdirSync(child, { recursive: true });
    mkdirSync(sibling);
    mkdirSync(textualPrefix);
    const opened = requireReadWrite(trackedOpenDatabase(join(fixture, 'triagent.sqlite')));
    const parentTask = seedTask(opened, 'task-parent', 'project-parent', parent);
    const childTask = seedTask(opened, 'task-child', 'project-child', child);
    const siblingTask = seedTask(opened, 'task-sibling', 'project-sibling', sibling);
    const prefixTask = seedTask(opened, 'task-prefix', 'project-prefix', textualPrefix);
    const service = new ProjectLockService(opened);
    const now = new Date('2026-07-12T00:00:00.000Z');
    const canonicalParent = canonicalizeProjectPath(parent);
    const canonicalChild = canonicalizeProjectPath(child);
    const canonicalSibling = canonicalizeProjectPath(sibling);
    const canonicalPrefix = canonicalizeProjectPath(textualPrefix);

    const acquired = service.acquire(
      parentTask,
      canonicalParent,
      'instance-parent',
      now,
      60_000,
    );
    expect(acquired.status).toBe('acquired');

    const same = service.acquire(
      parentTask,
      canonicalParent,
      'instance-other',
      now,
      60_000,
    );
    expect(same).toMatchObject({
      status: 'conflict',
      conflict: {
        taskId: parentTask,
        canonicalRoot: canonicalParent.canonicalRoot,
        ownerInstanceId: 'instance-parent',
        leaseExpiresAt: '2026-07-12T00:01:00.000Z',
        state: 'active',
        needsReconcile: false,
      },
    });

    expect(
      service.acquire(
        childTask,
        canonicalChild,
        'instance-child',
        now,
        60_000,
      ),
    ).toMatchObject({ status: 'conflict', conflict: { taskId: parentTask } });

    expect(
      service.acquire(
        siblingTask,
        canonicalSibling,
        'instance-sibling',
        now,
        60_000,
      ),
    ).toMatchObject({ status: 'acquired' });
    expect(
      service.acquire(
        prefixTask,
        canonicalPrefix,
        'instance-prefix',
        now,
        60_000,
      ),
    ).toMatchObject({ status: 'acquired' });
  }, 15_000);

  it('uses task-and-owner CAS for heartbeat and release', () => {
    const fixture = temporaryDirectory();
    const project = join(fixture, 'project');
    mkdirSync(project);
    const opened = requireReadWrite(trackedOpenDatabase(join(fixture, 'triagent.sqlite')));
    const taskId = seedTask(opened, 'task-cas', 'project-cas', project);
    const otherTaskId = seedTask(opened, 'task-other', 'project-other', fixture);
    const service = new ProjectLockService(opened);
    const acquired = service.acquire(
      taskId,
      canonicalizeProjectPath(project),
      'instance-1',
      new Date('2026-07-12T01:00:00.000Z'),
      60_000,
    );
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') return;

    expect(
      service.heartbeat(
        acquired.lock.lockId,
        taskId,
        'wrong-owner',
        new Date('2026-07-12T01:00:30.000Z'),
        60_000,
      ),
    ).toEqual({ status: 'owner_or_task_mismatch' });
    expect(
      service.heartbeat(
        acquired.lock.lockId,
        otherTaskId,
        'instance-1',
        new Date('2026-07-12T01:00:30.000Z'),
        60_000,
      ),
    ).toEqual({ status: 'owner_or_task_mismatch' });
    expect(service.get(acquired.lock.lockId)?.leaseExpiresAt).toBe(
      '2026-07-12T01:01:00.000Z',
    );

    expect(
      service.heartbeat(
        acquired.lock.lockId,
        taskId,
        'instance-1',
        new Date('2026-07-12T01:00:30.000Z'),
        60_000,
      ),
    ).toMatchObject({
      status: 'renewed',
      lock: {
        heartbeatAt: '2026-07-12T01:00:30.000Z',
        leaseExpiresAt: '2026-07-12T01:01:30.000Z',
      },
    });

    expect(
      service.release(
        acquired.lock.lockId,
        taskId,
        'wrong-owner',
        new Date('2026-07-12T01:00:40.000Z'),
      ),
    ).toEqual({ status: 'owner_or_task_mismatch' });
    expect(service.get(acquired.lock.lockId)?.releasedAt).toBeNull();
    expect(
      service.release(
        acquired.lock.lockId,
        taskId,
        'instance-1',
        new Date('2026-07-12T01:00:40.000Z'),
      ),
    ).toMatchObject({ status: 'released' });
  });

  it('does not let callers bypass task-and-owner CAS through LockRepository', () => {
    const fixture = temporaryDirectory();
    const project = join(fixture, 'project');
    mkdirSync(project);
    const opened = requireReadWrite(trackedOpenDatabase(join(fixture, 'triagent.sqlite')));
    const taskId = seedTask(opened, 'task-repository-cas', 'project-repository-cas', project);
    const service = new ProjectLockService(opened);
    const acquired = service.acquire(
      taskId,
      canonicalizeProjectPath(project),
      'repository-owner',
      new Date('2026-07-12T01:30:00.000Z'),
      60_000,
    );
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') return;
    const repository = createPersistenceRepositories(opened).locks;
    const legacyMutation = repository as unknown as {
      updateLease(lockId: string, leaseExpiresAt: string): void;
      release(lockId: string, releasedAt: string): void;
    };

    expect(() =>
      legacyMutation.updateLease(
        acquired.lock.lockId,
        '2026-07-12T01:40:00.000Z',
      ),
    ).toThrow(/owner|task|mismatch/i);
    expect(() =>
      legacyMutation.release(
        acquired.lock.lockId,
        '2026-07-12T01:31:00.000Z',
      ),
    ).toThrow(/owner|task|mismatch/i);
    expect(() =>
      repository.updateLease(
        acquired.lock.lockId,
        taskId,
        'wrong-owner',
        '2026-07-12T01:31:00.000Z',
        '2026-07-12T01:32:00.000Z',
      ),
    ).toThrow(/owner|task|mismatch/i);
    expect(() =>
      repository.release(
        acquired.lock.lockId,
        taskId,
        'wrong-owner',
        '2026-07-12T01:31:00.000Z',
      ),
    ).toThrow(/owner|task|mismatch/i);
    expect(service.get(acquired.lock.lockId)).toMatchObject({
      heartbeatAt: '2026-07-12T01:30:00.000Z',
      leaseExpiresAt: '2026-07-12T01:31:00.000Z',
      releasedAt: null,
    });

    repository.updateLease(
      acquired.lock.lockId,
      taskId,
      'repository-owner',
      '2026-07-12T01:30:30.000Z',
      '2026-07-12T01:31:30.000Z',
    );
    repository.release(
      acquired.lock.lockId,
      taskId,
      'repository-owner',
      '2026-07-12T01:30:40.000Z',
    );
    expect(service.get(acquired.lock.lockId)).toMatchObject({
      heartbeatAt: '2026-07-12T01:30:30.000Z',
      leaseExpiresAt: '2026-07-12T01:31:30.000Z',
      releasedAt: '2026-07-12T01:30:40.000Z',
    });
  });

  it('keeps expired leases as stale conflicts until explicit reconcile release', () => {
    const fixture = temporaryDirectory();
    const project = join(fixture, 'project');
    mkdirSync(project);
    const opened = requireReadWrite(trackedOpenDatabase(join(fixture, 'triagent.sqlite')));
    const firstTask = seedTask(opened, 'task-stale-1', 'project-stale-1', project);
    const secondTask = seedTask(opened, 'task-stale-2', 'project-stale-2', fixture);
    const service = new ProjectLockService(opened);
    const acquired = service.acquire(
      firstTask,
      canonicalizeProjectPath(project),
      'dead-instance',
      new Date('2026-07-12T02:00:00.000Z'),
      1_000,
    );
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') return;

    const stale = service.acquire(
      secondTask,
      canonicalizeProjectPath(project),
      'new-instance',
      new Date('2026-07-12T02:01:00.000Z'),
      60_000,
    );
    expect(stale).toMatchObject({
      status: 'conflict',
      conflict: {
        lockId: acquired.lock.lockId,
        state: 'stale_needs_reconcile',
        needsReconcile: true,
      },
    });
    expect(service.get(acquired.lock.lockId)).toBeDefined();
    expect(() =>
      createPersistenceRepositories(opened).locks.delete(acquired.lock.lockId),
    ).toThrow(/active|reconcile/i);
    expect(service.get(acquired.lock.lockId)).toBeDefined();

    expect(() =>
      service.releaseAfterReconcile(acquired.lock.lockId, {
        decision: 'release',
        reason: '',
        evidence: 'no process remains',
        reconciledAt: new Date('2026-07-12T02:01:10.000Z'),
      }),
    ).toThrow(/reason/i);
    expect(
      service.releaseAfterReconcile(acquired.lock.lockId, {
        decision: 'release',
        reason: 'process ownership was reconciled externally',
        evidence: 'no owned process or run attempt remains',
        reconciledAt: new Date('2026-07-12T02:01:10.000Z'),
      }),
    ).toEqual({ status: 'deleted' });

    expect(
      service.acquire(
        secondTask,
        canonicalizeProjectPath(project),
        'new-instance',
        new Date('2026-07-12T02:01:11.000Z'),
        60_000,
      ),
    ).toMatchObject({ status: 'acquired' });
  });

  it('persists active locks across database reopen', () => {
    const fixture = temporaryDirectory();
    const project = join(fixture, 'project');
    mkdirSync(project);
    const databasePath = join(fixture, 'triagent.sqlite');
    const firstOpen = requireReadWrite(trackedOpenDatabase(databasePath));
    const taskId = seedTask(firstOpen, 'task-reopen', 'project-reopen', project);
    const firstService = new ProjectLockService(firstOpen);
    const acquired = firstService.acquire(
      taskId,
      canonicalizeProjectPath(project),
      'instance-reopen',
      new Date('2026-07-12T03:00:00.000Z'),
      60_000,
    );
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') return;
    firstOpen.close();

    const reopened = requireReadWrite(trackedOpenDatabase(databasePath));
    const secondService = new ProjectLockService(reopened);

    expect(secondService.get(acquired.lock.lockId)).toMatchObject({
      taskId,
      ownerInstanceId: 'instance-reopen',
      canonicalRoot: canonicalizeProjectPath(project).canonicalRoot,
      releasedAt: null,
    });
  });

  it('serializes overlap checks across independent database connections', () => {
    const fixture = temporaryDirectory();
    const parent = join(fixture, 'repo');
    const child = join(parent, 'child');
    mkdirSync(child, { recursive: true });
    const databasePath = join(fixture, 'triagent.sqlite');
    const firstOpen = requireReadWrite(trackedOpenDatabase(databasePath));
    const firstTask = seedTask(firstOpen, 'task-connection-1', 'project-connection-1', parent);
    const secondTask = seedTask(firstOpen, 'task-connection-2', 'project-connection-2', child);
    const secondOpen = requireReadWrite(trackedOpenDatabase(databasePath));
    const firstService = new ProjectLockService(firstOpen);
    const secondService = new ProjectLockService(secondOpen);

    expect(
      firstService.acquire(
        firstTask,
        canonicalizeProjectPath(parent),
        'instance-1',
        new Date('2026-07-12T04:00:00.000Z'),
        60_000,
      ),
    ).toMatchObject({ status: 'acquired' });
    expect(
      secondService.acquire(
        secondTask,
        canonicalizeProjectPath(child),
        'instance-2',
        new Date('2026-07-12T04:00:00.000Z'),
        60_000,
      ),
    ).toMatchObject({ status: 'conflict', conflict: { taskId: firstTask } });
  });

  it('does not swallow SQLite constraint failures', () => {
    const fixture = temporaryDirectory();
    const firstProject = join(fixture, 'first');
    const secondProject = join(fixture, 'second');
    mkdirSync(firstProject);
    mkdirSync(secondProject);
    const opened = requireReadWrite(trackedOpenDatabase(join(fixture, 'triagent.sqlite')));
    const firstTask = seedTask(opened, 'task-constraint-1', 'project-constraint-1', firstProject);
    const secondTask = seedTask(opened, 'task-constraint-2', 'project-constraint-2', secondProject);
    const service = new ProjectLockService(opened, { lockIdFactory: () => 'fixed-lock-id' });
    const first = service.acquire(
      firstTask,
      canonicalizeProjectPath(firstProject),
      'instance-1',
      new Date('2026-07-12T05:00:00.000Z'),
      60_000,
    );
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;
    service.release(
      first.lock.lockId,
      firstTask,
      'instance-1',
      new Date('2026-07-12T05:00:01.000Z'),
    );

    expect(() =>
      service.acquire(
        secondTask,
        canonicalizeProjectPath(secondProject),
        'instance-2',
        new Date('2026-07-12T05:00:02.000Z'),
        60_000,
      ),
    ).toThrow(/constraint|unique|project_locks\.id/i);
  });

  it('guards active locks from task/project cascade deletion and permits deletion after release or reconcile', () => {
    const fixture = temporaryDirectory();
    const releasedProject = join(fixture, 'released-project');
    const reconciledProject = join(fixture, 'reconciled-project');
    mkdirSync(releasedProject);
    mkdirSync(reconciledProject);
    const opened = requireReadWrite(trackedOpenDatabase(join(fixture, 'triagent.sqlite')));
    const releasedTask = seedTask(
      opened,
      'task-trigger-release',
      'project-trigger-release',
      releasedProject,
    );
    const reconciledTask = seedTask(
      opened,
      'task-trigger-reconcile',
      'project-trigger-reconcile',
      reconciledProject,
    );
    const service = new ProjectLockService(opened);
    const releasedLock = service.acquire(
      releasedTask,
      canonicalizeProjectPath(releasedProject),
      'owner-release',
      new Date('2026-07-12T06:00:00.000Z'),
      60_000,
    );
    const reconciledLock = service.acquire(
      reconciledTask,
      canonicalizeProjectPath(reconciledProject),
      'owner-reconcile',
      new Date('2026-07-12T06:00:00.000Z'),
      60_000,
    );
    expect(releasedLock.status).toBe('acquired');
    expect(reconciledLock.status).toBe('acquired');
    if (releasedLock.status !== 'acquired' || reconciledLock.status !== 'acquired') return;

    let taskDeleteError: unknown;
    try {
      opened.connection.prepare('DELETE FROM tasks WHERE id = ?').run(releasedTask);
    } catch (error) {
      taskDeleteError = error;
    }
    let projectDeleteError: unknown;
    try {
      opened.connection
        .prepare('DELETE FROM projects WHERE id = ?')
        .run('project-trigger-reconcile');
    } catch (error) {
      projectDeleteError = error;
    }
    expect(taskDeleteError).toBeInstanceOf(Error);
    expect(String(taskDeleteError)).toMatch(/active project lock/i);
    expect(projectDeleteError).toBeInstanceOf(Error);
    expect(String(projectDeleteError)).toMatch(/active project lock/i);
    expect(service.get(releasedLock.lock.lockId)).toBeDefined();
    expect(service.get(reconciledLock.lock.lockId)).toBeDefined();
    expect(
      opened.connection
        .prepare('SELECT COUNT(*) AS count FROM project_lock_reconciliations')
        .get(),
    ).toEqual({ count: 0 });

    expect(
      service.release(
        releasedLock.lock.lockId,
        releasedTask,
        'owner-release',
        new Date('2026-07-12T06:00:10.000Z'),
      ),
    ).toMatchObject({ status: 'released' });
    opened.connection.prepare('DELETE FROM tasks WHERE id = ?').run(releasedTask);
    opened.connection
      .prepare('DELETE FROM projects WHERE id = ?')
      .run('project-trigger-release');

    expect(
      service.releaseAfterReconcile(reconciledLock.lock.lockId, {
        decision: 'release',
        reason: 'external ownership reconciliation completed',
        evidence: 'no process remains',
        reconciledAt: new Date('2026-07-12T06:00:20.000Z'),
      }),
    ).toEqual({ status: 'deleted' });
    opened.connection.prepare('DELETE FROM tasks WHERE id = ?').run(reconciledTask);
    opened.connection
      .prepare('DELETE FROM projects WHERE id = ?')
      .run('project-trigger-reconcile');
    expect(
      opened.connection
        .prepare(
          `SELECT lock_id, decision FROM project_lock_reconciliations
           WHERE lock_id = ?`,
        )
        .get(reconciledLock.lock.lockId),
    ).toEqual({
      lock_id: reconciledLock.lock.lockId,
      decision: 'release',
    });
  }, 15_000);

  it('cannot be constructed in diagnostic database mode', () => {
    const fixture = temporaryDirectory();
    const diagnostic = openDatabase(join(fixture, 'triagent.sqlite'), {
      migrationsDirectory: join(fixture, 'missing-migrations'),
    });
    openedDatabases.push(diagnostic);
    expect(diagnostic.mode).toBe('diagnostic');

    expect(() => new ProjectLockService(diagnostic)).toThrow(/diagnostic|read-only/i);
  });
});
