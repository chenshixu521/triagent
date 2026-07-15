import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { ActionRepository } from './action-repository.js';
import { AgentSessionRepository } from './agent-session-repository.js';
import { AttemptRepository } from './attempt-repository.js';
import {
  createDatabaseDiagnostics,
  runQuickCheck,
  type DatabaseDiagnostics,
} from './database-diagnostics.js';
import { LockRepository } from './lock-repository.js';
import {
  applyMigrations,
  discoverMigrations,
  preflightMigrations,
} from './migrator.js';
import { TaskRepository } from './task-repository.js';

export interface ReadWriteDatabase {
  readonly mode: 'read-write';
  readonly path: string;
  readonly connection: DatabaseSync;
  close(): void;
}

export interface DiagnosticDatabase {
  readonly mode: 'diagnostic';
  readonly path: string;
  readonly diagnostics: DatabaseDiagnostics;
  close(): void;
}

export type OpenedDatabase = ReadWriteDatabase | DiagnosticDatabase;

export interface PersistenceRepositories {
  readonly tasks: TaskRepository;
  readonly attempts: AttemptRepository;
  readonly actions: ActionRepository;
  readonly locks: LockRepository;
  readonly agentSessions: AgentSessionRepository;
}

export interface OpenDatabaseOptions {
  readonly migrationsDirectory?: string;
  /**
   * Forced diagnostic mode: never create, migrate, or write the database.
   * Used by `--diagnostic` even when the file is healthy or missing.
   */
  readonly diagnosticOnly?: boolean;
}

function defaultMigrationsDirectory(): string {
  return fileURLToPath(new URL('./migrations', import.meta.url));
}

function configureWritableDatabase(database: DatabaseSync, path: string): void {
  database.enableDefensive(true);
  database.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') {
    database.exec('PRAGMA journal_mode = WAL');
  }
  database.exec('PRAGMA synchronous = FULL');
  database.exec('PRAGMA busy_timeout = 5000');
}

export function openDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): OpenedDatabase {
  const normalizedPath = path === ':memory:' ? path : resolve(path);

  if (options.diagnosticOnly === true) {
    // Forced diagnostic: never create/migrate/modify. Optional read-only probe.
    let quickCheck: readonly string[] | undefined;
    const exists = normalizedPath !== ':memory:' && existsSync(normalizedPath);
    if (exists) {
      try {
        const readOnly = new DatabaseSync(normalizedPath, { readOnly: true });
        try {
          quickCheck = runQuickCheck(readOnly);
        } finally {
          readOnly.close();
        }
      } catch (error) {
        return {
          mode: 'diagnostic',
          path: normalizedPath,
          diagnostics: createDatabaseDiagnostics(normalizedPath, error, quickCheck),
          close(): void {
            // no writable connection
          },
        };
      }
    }
    return {
      mode: 'diagnostic',
      path: normalizedPath,
      diagnostics: createDatabaseDiagnostics(
        normalizedPath,
        new Error(
          exists
            ? 'forced diagnostic mode: database opened read-only; migrations and writes disabled'
            : 'forced diagnostic mode: database file is missing; create/migrate disabled',
        ),
        quickCheck,
      ),
      close(): void {
        // no writable connection
      },
    };
  }

  const existedBeforeOpen = normalizedPath !== ':memory:' && existsSync(normalizedPath);
  const migrationsDirectory = options.migrationsDirectory === undefined
    ? defaultMigrationsDirectory()
    : resolve(options.migrationsDirectory);
  let connection: DatabaseSync | undefined;
  let quickCheck: readonly string[] | undefined;
  try {
    const migrations = discoverMigrations(migrationsDirectory);
    if (existedBeforeOpen) {
      const readOnly = new DatabaseSync(normalizedPath, { readOnly: true });
      try {
        quickCheck = runQuickCheck(readOnly);
        preflightMigrations(readOnly, migrations);
      } finally {
        readOnly.close();
      }
    }
    connection = new DatabaseSync(normalizedPath);
    if (existedBeforeOpen) {
      quickCheck = runQuickCheck(connection);
      preflightMigrations(connection, migrations);
    }
    configureWritableDatabase(connection, normalizedPath);
    applyMigrations(connection, migrations);
    quickCheck = runQuickCheck(connection);
    let closed = false;
    return {
      mode: 'read-write',
      path: normalizedPath,
      connection,
      close(): void {
        if (!closed) {
          if (connection!.isOpen) {
            connection!.close();
          }
          closed = true;
        }
      },
    };
  } catch (error) {
    if (connection !== undefined) {
      try {
        connection.close();
      } catch {
        // Diagnostic mode must remain available even if SQLite cannot close cleanly.
      }
    }
    const diagnostics = createDatabaseDiagnostics(normalizedPath, error, quickCheck);
    return {
      mode: 'diagnostic',
      path: normalizedPath,
      diagnostics,
      close(): void {
        // No writable connection is retained in diagnostic mode.
      },
    };
  }
}

export function createPersistenceRepositories(
  database: OpenedDatabase,
): PersistenceRepositories {
  if (database.mode !== 'read-write') {
    throw new Error(
      `database is in diagnostic read-only mode: ${database.diagnostics.error}`,
    );
  }
  return {
    tasks: new TaskRepository(database.connection),
    attempts: new AttemptRepository(database.connection),
    actions: new ActionRepository(database.connection),
    locks: new LockRepository(database.connection),
    agentSessions: new AgentSessionRepository(database.connection),
  };
}

export function runIfWritable<Result>(
  database: OpenedDatabase,
  operation: (database: ReadWriteDatabase) => Result,
): Result {
  if (database.mode !== 'read-write') {
    throw new Error(
      `side effects are disabled in diagnostic read-only mode: ${database.diagnostics.error}`,
    );
  }
  return operation(database);
}
