import { mkdtempSync, openSync, closeSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPersistenceRepositories,
  openDatabase,
  runIfWritable,
  type OpenedDatabase,
} from '../../../src/persistence/database.js';

const directories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

function temporaryPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-corrupt-'));
  directories.push(directory);
  return join(directory, name);
}

function trackedOpenDatabase(path: string): OpenedDatabase {
  const opened = openDatabase(path);
  openedDatabases.push(opened);
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

describe('corrupt database fail-closed diagnostics', () => {
  it('returns diagnostic mode for random bytes and blocks repositories and side effects', () => {
    const path = temporaryPath('random.sqlite');
    writeFileSync(path, Buffer.from('not a sqlite database\0\x01\x02', 'binary'));

    const opened = trackedOpenDatabase(path);
    expect(opened.mode).toBe('diagnostic');
    if (opened.mode !== 'diagnostic') {
      throw new Error('expected diagnostic mode');
    }
    expect(opened.diagnostics.path).toBe(path);
    expect(opened.diagnostics.error).toMatch(/database|malformed|file/i);
    expect(opened.diagnostics.sizeBytes).toBeGreaterThan(0);
    expect(() => createPersistenceRepositories(opened)).toThrow(/diagnostic|read-only/i);

    const sideEffect = vi.fn();
    expect(() => runIfWritable(opened, sideEffect)).toThrow(/diagnostic|read-only/i);
    expect(sideEffect).not.toHaveBeenCalled();
    opened.close();
  });

  it('returns diagnostic mode for a truncated formerly-valid database', () => {
    const path = temporaryPath('truncated.sqlite');
    const created = trackedOpenDatabase(path);
    expect(created.mode).toBe('read-write');
    created.close();
    const descriptor = openSync(path, 'r+');
    closeSync(descriptor);
    truncateSync(path, 100);

    const reopened = trackedOpenDatabase(path);
    expect(reopened.mode).toBe('diagnostic');
    if (reopened.mode === 'diagnostic') {
      expect(reopened.diagnostics.path).toBe(path);
      expect(reopened.diagnostics.error).toBeTruthy();
    }
    reopened.close();
  });
});
