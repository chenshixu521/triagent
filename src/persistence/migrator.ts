import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, type DatabaseSync } from 'node:sqlite';

import { withTransaction } from './transaction.js';

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

const MIGRATION_FILE = /^(\d{3})_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function discoverMigrations(directory: string): readonly MigrationFile[] {
  const migrations: MigrationFile[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.toLowerCase().endsWith('.sql')) {
      continue;
    }
    const match = MIGRATION_FILE.exec(entry.name);
    if (match === null) {
      throw new Error(
        `invalid migration SQL filename ${entry.name}; expected NNN_name.sql`,
      );
    }
    if (!entry.isFile()) {
      throw new Error(`migration SQL entry is not a regular file: ${entry.name}`);
    }
    const version = Number.parseInt(match[1]!, 10);
    const sql = readFileSync(join(directory, entry.name), 'utf8');
    migrations.push({
      version,
      name: entry.name,
      sql,
      checksum: checksum(sql),
    });
  }
  migrations.sort((left, right) => left.version - right.version);
  if (migrations.length === 0) {
    throw new Error(`no migration SQL files found in ${directory}`);
  }

  const versions = new Set<number>();
  for (const migration of migrations) {
    if (migration.version <= 0) {
      throw new Error(`invalid migration version: ${migration.name}`);
    }
    if (versions.has(migration.version)) {
      throw new Error(`duplicate migration version: ${migration.version}`);
    }
    versions.add(migration.version);
  }
  return migrations;
}

function readAppliedMigrations(database: DatabaseSync): readonly AppliedMigrationRow[] {
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (table === undefined) {
    return [];
  }
  const rows = database
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as unknown as AppliedMigrationRow[];
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.version) ||
      row.version <= 0 ||
      typeof row.name !== 'string' ||
      typeof row.checksum !== 'string'
    ) {
      throw new Error('schema_migrations contains an invalid row');
    }
  }
  return rows;
}

export function preflightMigrations(
  database: DatabaseSync,
  migrations: readonly MigrationFile[],
): readonly AppliedMigrationRow[] {
  const applied = readAppliedMigrations(database);
  const availableByVersion = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );
  for (const row of applied) {
    const migration = availableByVersion.get(row.version);
    if (migration === undefined) {
      throw new Error(`applied migration ${row.version} is missing from disk`);
    }
    if (migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(`migration checksum mismatch for ${row.name}`);
    }
  }

  const highestApplied = applied.at(-1)?.version ?? 0;
  const appliedVersions = new Set(applied.map((migration) => migration.version));
  for (const migration of migrations) {
    if (
      migration.version <= highestApplied &&
      !appliedVersions.has(migration.version)
    ) {
      throw new Error(
        `append-only migration sequence violation: older migration ${migration.name} was added beneath applied version ${highestApplied}`,
      );
    }
  }
  return applied;
}

function executeMigrationSql(database: DatabaseSync, sql: string): void {
  database.setAuthorizer((actionCode) =>
    actionCode === constants.SQLITE_TRANSACTION ||
    actionCode === constants.SQLITE_SAVEPOINT
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  try {
    database.exec(sql);
  } finally {
    database.setAuthorizer(null);
  }
}

export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly MigrationFile[],
): void {
  const applied = preflightMigrations(database, migrations);
  const appliedVersions = new Set(applied.map((migration) => migration.version));
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }
    withTransaction(database, () => {
      executeMigrationSql(database, migration.sql);
      database
        .prepare(
          'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          new Date().toISOString(),
        );
    });
  }
}
