import { existsSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export interface DatabaseDiagnostics {
  readonly path: string;
  readonly exists: boolean;
  readonly sizeBytes?: number;
  readonly error: string;
  readonly quickCheck?: readonly string[];
}

export function runQuickCheck(database: DatabaseSync): readonly string[] {
  const rows = database.prepare('PRAGMA quick_check').all();
  const results = rows.map((row) => {
    const value = row.quick_check;
    if (typeof value !== 'string') {
      throw new Error('PRAGMA quick_check returned an invalid result');
    }
    return value;
  });
  if (results.length !== 1 || results[0] !== 'ok') {
    throw new Error(`database quick_check failed: ${results.join('; ')}`);
  }
  return results;
}

export function createDatabaseDiagnostics(
  path: string,
  error: unknown,
  quickCheck?: readonly string[],
): DatabaseDiagnostics {
  const exists = path !== ':memory:' && existsSync(path);
  let sizeBytes: number | undefined;
  if (exists) {
    try {
      sizeBytes = statSync(path).size;
    } catch {
      // The error text remains the authoritative diagnostic.
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    path,
    exists,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    error: message,
    ...(quickCheck === undefined ? {} : { quickCheck }),
  };
}
