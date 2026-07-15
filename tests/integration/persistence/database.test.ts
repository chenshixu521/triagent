import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { asTaskId } from '../../../src/domain/ids.js';
import { createInitialWorkflow, transition } from '../../../src/workflow/workflow-engine.js';
import type { WorkflowSnapshot } from '../../../src/workflow/states.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import { withTransaction } from '../../../src/persistence/transaction.js';

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-persistence-'));
  temporaryDirectories.push(directory);
  return directory;
}

function requireReadWrite(
  opened: OpenedDatabase,
): ReadWriteDatabase {
  expect(opened.mode).toBe('read-write');
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return opened;
}

function trackedOpenDatabase(
  path: string,
  options?: Parameters<typeof openDatabase>[1],
): OpenedDatabase {
  const opened = openDatabase(path, options);
  openedDatabases.push(opened);
  return opened;
}

function copyInitialMigration(directory: string): string {
  const sourceMigration = fileURLToPath(
    new URL('../../../src/persistence/migrations/001_initial.sql', import.meta.url),
  );
  const copiedMigration = join(directory, '001_initial.sql');
  copyFileSync(sourceMigration, copiedMigration);
  return copiedMigration;
}

afterEach(() => {
  for (const opened of openedDatabases.splice(0).reverse()) {
    opened.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLite database and migrations', () => {
  it('creates the complete schema with fail-safe write pragmas', () => {
    const databasePath = join(temporaryDirectory(), 'triagent.sqlite');
    const opened = requireReadWrite(trackedOpenDatabase(databasePath));

    expect(opened.connection.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });
    expect(opened.connection.prepare('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'wal',
    });
    expect(opened.connection.prepare('PRAGMA synchronous').get()).toEqual({
      synchronous: 2,
    });
    expect(opened.connection.prepare('PRAGMA busy_timeout').get()).toEqual({
      timeout: 5000,
    });
    opened.connection.exec('PRAGMA writable_schema = ON');
    expect(opened.connection.prepare('PRAGMA writable_schema').get()).toEqual({
      writable_schema: 0,
    });

    const tables = opened.connection
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));

    expect(tables).toEqual(
      [
        'agent_sessions',
        'budget_active_intervals',
        'budget_call_reservations',
        'budget_task_state',
        'events',
        'file_baselines',
        'file_changes',
        'log_index',
        'pending_actions',
        'project_lock_reconciliations',
        'project_locks',
        'projects',
        'requirement_versions',
        'reviews',
        'run_attempts',
        'schema_migrations',
        'settings',
        'tasks',
        'user_messages',
        'workflow_transitions',
      ].sort(),
    );
    expect(
      opened.connection.prepare('SELECT version FROM schema_migrations').all(),
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
    ]);

    opened.close();
  });

  it('reopens and reruns migrations idempotently', () => {
    const databasePath = join(temporaryDirectory(), 'triagent.sqlite');
    requireReadWrite(trackedOpenDatabase(databasePath)).close();

    const reopened = requireReadWrite(trackedOpenDatabase(databasePath));
    expect(
      reopened.connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: 6 });
    reopened.close();
  });

  it('fails closed when an applied migration file checksum changes', () => {
    const directory = temporaryDirectory();
    const migrationsDirectory = join(directory, 'migrations');
    mkdirSync(migrationsDirectory);
    const copiedMigration = copyInitialMigration(migrationsDirectory);
    const databasePath = join(directory, 'triagent.sqlite');

    requireReadWrite(
      trackedOpenDatabase(databasePath, { migrationsDirectory }),
    ).close();
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec('PRAGMA journal_mode = DELETE');
    } finally {
      raw.close();
    }
    writeFileSync(
      copiedMigration,
      `${readFileSync(copiedMigration, 'utf8')}\n-- forbidden rewrite\n`,
      'utf8',
    );

    const reopened = trackedOpenDatabase(databasePath, { migrationsDirectory });
    expect(reopened.mode).toBe('diagnostic');
    if (reopened.mode === 'diagnostic') {
      expect(reopened.diagnostics.error).toMatch(/checksum/i);
    }
    const readOnly = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readOnly.prepare('PRAGMA journal_mode').get()).toEqual({
        journal_mode: 'delete',
      });
    } finally {
      readOnly.close();
    }
  });

  it('does not create a database file when the migration directory is missing', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'triagent.sqlite');
    const opened = trackedOpenDatabase(databasePath, {
      migrationsDirectory: join(directory, 'missing-migrations'),
    });

    expect(opened.mode).toBe('diagnostic');
    expect(existsSync(databasePath)).toBe(false);
  });

  it.each([
    ['misnamed SQL file', '002-typo.sql', 'file'] as const,
    ['uppercase SQL extension', '002_upper.SQL', 'file'] as const,
    ['SQL directory masquerading as a migration', '002_directory.sql', 'directory'] as const,
  ])('strictly rejects a %s before creating the database', (_label, entryName, kind) => {
    const directory = temporaryDirectory();
    const migrationsDirectory = join(directory, 'migrations');
    mkdirSync(migrationsDirectory);
    copyInitialMigration(migrationsDirectory);
    const invalidEntry = join(migrationsDirectory, entryName);
    if (kind === 'file') {
      writeFileSync(invalidEntry, 'SELECT 1;\n', 'utf8');
    } else {
      mkdirSync(invalidEntry);
    }
    const databasePath = join(directory, 'triagent.sqlite');

    const opened = trackedOpenDatabase(databasePath, { migrationsDirectory });

    expect(opened.mode).toBe('diagnostic');
    if (opened.mode === 'diagnostic') {
      expect(opened.diagnostics.error).toMatch(/migration|sql|file/i);
    }
    expect(existsSync(databasePath)).toBe(false);
  });

  it('rejects inserting an older migration beneath the applied migration head', () => {
    const directory = temporaryDirectory();
    const migrationsDirectory = join(directory, 'migrations');
    mkdirSync(migrationsDirectory);
    copyInitialMigration(migrationsDirectory);
    writeFileSync(
      join(migrationsDirectory, '003_future.sql'),
      'CREATE TABLE future_marker (id INTEGER PRIMARY KEY) STRICT;\n',
      'utf8',
    );
    const databasePath = join(directory, 'triagent.sqlite');
    requireReadWrite(trackedOpenDatabase(databasePath, { migrationsDirectory })).close();

    writeFileSync(
      join(migrationsDirectory, '002_backfilled.sql'),
      'CREATE TABLE backfilled_marker (id INTEGER PRIMARY KEY) STRICT;\n',
      'utf8',
    );
    const reopened = trackedOpenDatabase(databasePath, { migrationsDirectory });
    const mode = reopened.mode;
    const error = reopened.mode === 'diagnostic' ? reopened.diagnostics.error : '';
    reopened.close();

    expect(mode).toBe('diagnostic');
    expect(error).toMatch(/append|older|sequence/i);
  });

  it.each([
    ['COMMIT', 'COMMIT;'],
    ['SAVEPOINT', 'SAVEPOINT migration_escape;'],
  ])('rejects migration-level %s without leaking schema or migration state', (_label, escapeSql) => {
    const directory = temporaryDirectory();
    const migrationsDirectory = join(directory, 'migrations');
    mkdirSync(migrationsDirectory);
    writeFileSync(
      join(migrationsDirectory, '001_escape.sql'),
      `CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE leaked_marker (value TEXT NOT NULL) STRICT;
      ${escapeSql}
      INSERT INTO leaked_marker(value) VALUES ('must-not-persist');\n`,
      'utf8',
    );
    const databasePath = join(directory, 'triagent.sqlite');

    const opened = trackedOpenDatabase(databasePath, { migrationsDirectory });

    expect(opened.mode).toBe('diagnostic');
    const inspect = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        inspect
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('leaked_marker', 'schema_migrations')",
          )
          .all(),
      ).toEqual([]);
    } finally {
      inspect.close();
    }
  });
});

describe('explicit transactions and repositories', () => {
  it('commits successful transactions, rolls back failures, and rejects nesting', () => {
    const opened = requireReadWrite(
      trackedOpenDatabase(join(temporaryDirectory(), 'triagent.sqlite')),
    );
    opened.connection.exec('CREATE TABLE transaction_probe (value TEXT NOT NULL) STRICT');

    withTransaction(opened.connection, () => {
      opened.connection.prepare('INSERT INTO transaction_probe(value) VALUES (?)').run('committed');
    });
    expect(() =>
      withTransaction(opened.connection, () => {
        opened.connection.prepare('INSERT INTO transaction_probe(value) VALUES (?)').run('rolled-back');
        throw new Error('explode');
      }),
    ).toThrow('explode');
    expect(() =>
      withTransaction(opened.connection, () =>
        withTransaction(opened.connection, () => undefined),
      ),
    ).toThrow(/nested transaction/i);

    opened.connection.exec('BEGIN IMMEDIATE');
    expect(() => withTransaction(opened.connection, () => undefined)).toThrow();
    opened.connection.exec('ROLLBACK');
    expect(() =>
      withTransaction(opened.connection, () => {
        opened.connection
          .prepare('INSERT INTO transaction_probe(value) VALUES (?)')
          .run('after-begin-failure');
      }),
    ).not.toThrow();

    expect(opened.connection.prepare('SELECT value FROM transaction_probe ORDER BY rowid').all()).toEqual([
      { value: 'committed' },
      { value: 'after-begin-failure' },
    ]);
    opened.close();
  });

  it('poisons a connection when rollback fails and reports both errors', () => {
    const commands: string[] = [];
    const fakeDatabase = {
      exec: vi.fn((sql: string) => {
        commands.push(sql);
        if (sql === 'ROLLBACK') {
          throw new Error('rollback broke');
        }
      }),
    } as unknown as DatabaseSync;

    expect(() =>
      withTransaction(fakeDatabase, () => {
        throw new Error('operation broke');
      }),
    ).toThrow(/operation broke.*rollback broke|rollback broke.*operation broke|poison/i);
    expect(() => withTransaction(fakeDatabase, () => undefined)).toThrow(
      /poison|must be closed/i,
    );
    expect(commands).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  it('closes a real connection when ordinary rollback fails and disables repositories', () => {
    const opened = requireReadWrite(
      trackedOpenDatabase(join(temporaryDirectory(), 'triagent.sqlite')),
    );
    const repositories = createPersistenceRepositories(opened);

    expect(() =>
      withTransaction(opened.connection, () => {
        opened.connection.exec('COMMIT');
        throw new Error('operation failed after manual commit');
      }),
    ).toThrow(/rollback failed|poison/i);
    expect(opened.connection.isOpen).toBe(false);
    expect(() => opened.connection.exec('SELECT 1')).toThrow(/closed|open/i);
    expect(() =>
      repositories.tasks.createProject({
        projectId: 'must-not-write',
        rootPath: 'D:\\must-not-write',
      }),
    ).toThrow(/closed|open|poison/i);
  });

  it('rejects async transaction callbacks before commit and closes the connection', async () => {
    const path = join(temporaryDirectory(), 'triagent.sqlite');
    const opened = requireReadWrite(trackedOpenDatabase(path));
    opened.connection.exec('CREATE TABLE async_probe (value TEXT NOT NULL) STRICT');
    const asyncOperation = async (): Promise<void> => {
      await Promise.resolve();
      opened.connection
        .prepare('INSERT INTO async_probe(value) VALUES (?)')
        .run('must-not-persist');
      throw new Error('late async failure');
    };

    if (false) {
      // @ts-expect-error transaction callbacks must complete synchronously
      withTransaction(opened.connection, asyncOperation);
    }
    expect(() =>
      withTransaction(
        opened.connection,
        asyncOperation as unknown as () => unknown,
      ),
    ).toThrow(/AsyncCallback|async transaction/i);
    expect(opened.connection.isOpen).toBe(false);
    expect(() => withTransaction(opened.connection, () => undefined)).toThrow(
      /poison|closed/i,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const reopened = requireReadWrite(trackedOpenDatabase(path));
    expect(reopened.connection.prepare('SELECT value FROM async_probe').all()).toEqual([]);
  });

  it('round-trips and validates task workflow snapshots', () => {
    const opened = requireReadWrite(
      trackedOpenDatabase(join(temporaryDirectory(), 'triagent.sqlite')),
    );
    const repositories = createPersistenceRepositories(opened);
    const taskId = asTaskId('task-persisted');
    const initial = createInitialWorkflow(taskId);
    repositories.tasks.createProject({ projectId: 'project-1', rootPath: 'D:\\repo' });
    repositories.tasks.create({
      taskId,
      projectId: 'project-1',
      workflowSnapshot: initial,
      workflowVersion: 1,
      status: 'draft',
    });

    const checking = transition(initial, { type: 'START' });
    repositories.tasks.updateWorkflow(taskId, {
      workflowSnapshot: checking,
      expectedVersion: 1,
      status: 'checking_environment',
    });

    expect(repositories.tasks.get(taskId)).toEqual({
      taskId,
      projectId: 'project-1',
      workflowSnapshot: {
        state: 'checking_environment',
        taskId,
        requirementVersion: 1,
        reworkCount: 0,
        maxReworks: 3,
        pauseAfterAttempt: false,
      },
      workflowVersion: 2,
      status: 'checking_environment',
    });
    expect(() =>
      repositories.tasks.updateWorkflow(taskId, {
        workflowSnapshot: checking,
        expectedVersion: 2,
        status: 'not-a-state' as 'draft',
      }),
    ).toThrow(/status/i);

    opened.connection
      .prepare('UPDATE tasks SET workflow_snapshot = ? WHERE id = ?')
      .run('{"state":null}', taskId);
    expect(() => repositories.tasks.get(taskId)).toThrow(/workflow snapshot/i);
    opened.close();
  });

  it('returns the existing project ID when the canonical root path is reused', () => {
    const opened = requireReadWrite(
      trackedOpenDatabase(join(temporaryDirectory(), 'triagent.sqlite')),
    );
    const repositories = createPersistenceRepositories(opened);

    const firstProjectId = repositories.tasks.createProject({
      projectId: 'project-root-first',
      rootPath: 'D:\\same-canonical-root',
    });
    const reusedProjectId = repositories.tasks.createProject({
      projectId: 'project-root-second',
      rootPath: 'D:\\same-canonical-root',
    });

    expect(firstProjectId).toBe('project-root-first');
    expect(reusedProjectId).toBe('project-root-first');
    expect(
      opened.connection
        .prepare('SELECT id, root_path AS rootPath FROM projects ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'project-root-first', rootPath: 'D:\\same-canonical-root' },
    ]);
  });

  it('uses compare-and-swap workflow versions and prevents stale downgrades', () => {
    const opened = requireReadWrite(
      trackedOpenDatabase(join(temporaryDirectory(), 'triagent.sqlite')),
    );
    const repositories = createPersistenceRepositories(opened);
    const taskId = asTaskId('task-cas');
    const initial = createInitialWorkflow(taskId);
    const checking = transition(initial, { type: 'START' });
    repositories.tasks.createProject({ projectId: 'project-cas', rootPath: 'D:\\cas' });
    repositories.tasks.create({
      taskId,
      projectId: 'project-cas',
      workflowSnapshot: initial,
      workflowVersion: 7,
      status: 'draft',
    });

    expect(() =>
      repositories.tasks.updateWorkflow(taskId, {
        workflowSnapshot: checking,
        expectedVersion: 1,
        status: 'checking_environment',
      }),
    ).toThrow(/stale workflow/i);
    expect(repositories.tasks.get(taskId)).toMatchObject({
      workflowVersion: 7,
      status: 'draft',
    });

    repositories.tasks.updateWorkflow(taskId, {
      workflowSnapshot: checking,
      expectedVersion: 7,
      status: 'checking_environment',
    });
    expect(repositories.tasks.get(taskId)).toMatchObject({
      workflowVersion: 8,
      status: 'checking_environment',
    });
  });

  it('rejects invalid workflow counters before writes and while reading corrupted rows', () => {
    const opened = requireReadWrite(
      trackedOpenDatabase(join(temporaryDirectory(), 'triagent.sqlite')),
    );
    const repositories = createPersistenceRepositories(opened);
    const taskId = asTaskId('task-counter-validation');
    const initial = createInitialWorkflow(taskId);
    repositories.tasks.createProject({ projectId: 'project-counters', rootPath: 'D:\\counters' });
    repositories.tasks.create({
      taskId,
      projectId: 'project-counters',
      workflowSnapshot: initial,
      workflowVersion: 1,
      status: 'draft',
    });
    const invalidSnapshots: readonly WorkflowSnapshot[] = [
      { ...initial, requirementVersion: Number.NaN },
      { ...initial, requirementVersion: Number.POSITIVE_INFINITY },
      { ...initial, requirementVersion: 0.5 },
      { ...initial, reworkCount: 0.5 },
      { ...initial, maxReworks: 999 as 3 },
    ];

    for (const workflowSnapshot of invalidSnapshots) {
      expect(() =>
        repositories.tasks.updateWorkflow(taskId, {
          workflowSnapshot,
          expectedVersion: 1,
          status: 'draft',
        }),
      ).toThrow(/workflow snapshot|JSON value|safe integer|maxReworks/i);
      expect(repositories.tasks.get(taskId)).toMatchObject({
        workflowVersion: 1,
        status: 'draft',
      });
    }

    expect(() =>
      repositories.tasks.updateWorkflow(taskId, {
        workflowSnapshot: {
          ...initial,
          pendingResumeAttempt: {
            attemptId: undefined,
            baselineId: 'baseline-invalid',
            role: 'implementer',
          },
        } as unknown as WorkflowSnapshot,
        expectedVersion: 1,
        status: 'draft',
      }),
    ).toThrow(/workflow snapshot|JSON value/i);
    expect(repositories.tasks.get(taskId)).toMatchObject({ workflowVersion: 1 });

    opened.connection
      .prepare('UPDATE tasks SET workflow_snapshot = ? WHERE id = ?')
      .run(JSON.stringify({ ...initial, maxReworks: 999 }), taskId);
    expect(() => repositories.tasks.get(taskId)).toThrow(
      /workflow snapshot|maxReworks/i,
    );
  });
});
