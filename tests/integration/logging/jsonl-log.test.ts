import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { asTaskId } from '../../../src/domain/ids.js';
import {
  JsonlLog,
  type JsonlLogRecord,
} from '../../../src/logging/jsonl-log.js';
import {
  LogIndexRepository,
  type LogIndexStore,
} from '../../../src/logging/log-index-repository.js';
import { Redactor } from '../../../src/logging/redact.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';

const directories: string[] = [];
const databases: OpenedDatabase[] = [];
const logs: JsonlLog[] = [];

function temporaryDirectory(prefix = 'triagent-jsonl-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function openTemporaryDatabase(directory = temporaryDirectory()): ReadWriteDatabase {
  const opened = openDatabase(join(directory, 'triagent.sqlite'));
  databases.push(opened);
  expect(opened.mode).toBe('read-write');
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return opened;
}

function createTask(database: ReadWriteDatabase, taskIdValue = 'task-log'): string {
  const taskId = asTaskId(taskIdValue);
  const repositories = createPersistenceRepositories(database);
  repositories.tasks.createProject({
    projectId: `project-${taskIdValue}`,
    rootPath: `D:\\${taskIdValue}`,
  });
  repositories.tasks.create({
    taskId,
    projectId: `project-${taskIdValue}`,
    workflowSnapshot: createInitialWorkflow(taskId),
    workflowVersion: 1,
    status: 'draft',
  });
  return taskId;
}

function checksumRecord(record: Omit<JsonlLogRecord, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
}

function rewriteSequence(path: string, lineIndex: number, sequence: number): void {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const original = JSON.parse(lines[lineIndex]!) as JsonlLogRecord;
  const { checksum: _oldChecksum, ...withoutChecksum } = original;
  const changed = { ...withoutChecksum, sequence };
  lines[lineIndex] = JSON.stringify({ ...changed, checksum: checksumRecord(changed) });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

async function trackedOpen(options: Parameters<typeof JsonlLog.open>[0]): Promise<JsonlLog> {
  const log = await JsonlLog.open(options);
  logs.push(log);
  return log;
}

function errorChainText(error: unknown): string {
  const seen = new Set<unknown>();
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message, current.stack ?? '');
    current = current.cause;
  }
  return messages.join('\n');
}

async function captureError(operation: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

afterEach(async () => {
  for (const log of logs.splice(0).reverse()) {
    await log.close();
  }
  for (const database of databases.splice(0).reverse()) {
    database.close();
  }
  for (const directory of directories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('JSONL logging and SQLite indexing', () => {
  it('does not echo invalid append or index validator values in exposed errors', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const log = await trackedOpen({
      directory: join(fixture, 'logs'),
      fileName: 'validator-errors.jsonl',
      database: database.connection,
    });
    const recognizableInvalidValue = 'recognizable-invalid-validator-value';
    const streamError = await captureError(() => log.append({
      taskId,
      stream: recognizableInvalidValue as never,
      eventType: 'partial',
      payload: null,
    }));
    const priorityError = await captureError(() => log.append({
      taskId,
      stream: 'stdout',
      eventType: 'partial',
      payload: null,
      display: { priority: recognizableInvalidValue as never },
    }));
    const indexError = await captureError(() =>
      new LogIndexRepository(database.connection).append({
        schemaVersion: 1,
        sequence: 1,
        taskId,
        stream: recognizableInvalidValue as never,
        eventType: 'partial',
        filePath: join(fixture, 'logs', 'validator-errors.jsonl'),
        byteOffset: 0,
        byteLength: 1,
        checksum: '0'.repeat(64),
        timestamp: '2026-07-12T00:00:00.000Z',
      }),
    );

    for (const error of [streamError, priorityError, indexError]) {
      expect(error).toBeInstanceOf(Error);
      expect(errorChainText(error)).not.toContain(recognizableInvalidValue);
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('appends complete UTF-8 lines with monotonic sequence, checksums, offsets, and metadata-only indexes', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const logDirectory = join(fixture, 'logs');
    const log = await trackedOpen({
      directory: logDirectory,
      fileName: 'task-log.jsonl',
      database: database.connection,
      redactor: new Redactor({ secrets: ['never-store-this-secret'] }),
      clock: () => new Date('2026-07-12T00:00:00.000Z'),
    });

    const first = await log.append({
      taskId,
      stream: 'stdout',
      eventType: 'partial',
      payload: { text: 'one' },
      display: { priority: 'low' },
    });
    const second = await log.append({
      taskId,
      stream: 'stderr',
      eventType: 'diagnostic',
      payload: { nested: { credential: 'never-store-this-secret' } },
      display: { priority: 'normal' },
    });
    const third = await log.append({
      taskId,
      stream: 'system',
      eventType: 'run_completed',
      payload: { exitCode: 0 },
      display: { priority: 'high' },
    });

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(first.offset).toBe(0);
    expect(second.offset).toBe(first.byteLength);
    expect(third.offset).toBe(first.byteLength + second.byteLength);
    expect(first.needsReindex).toBe(false);
    expect(second.record.redactionApplied).toBe(true);
    expect(readFileSync(log.path, 'utf8')).not.toContain('never-store-this-secret');

    const lines = readFileSync(log.path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain('\n');
      const record = JSON.parse(line) as JsonlLogRecord;
      const { checksum, ...withoutChecksum } = record;
      expect(checksum).toBe(checksumRecord(withoutChecksum));
      expect(record.schemaVersion).toBe(1);
    }

    const index = new LogIndexRepository(database.connection).listForFile(log.path);
    expect(index.map((entry) => ({
      sequence: entry.sequence,
      offset: entry.byteOffset,
      length: entry.byteLength,
      checksum: entry.checksum,
      eventType: entry.eventType,
    }))).toEqual([
      {
        sequence: 1,
        offset: first.offset,
        length: first.byteLength,
        checksum: first.checksum,
        eventType: 'partial',
      },
      {
        sequence: 2,
        offset: second.offset,
        length: second.byteLength,
        checksum: second.checksum,
        eventType: 'diagnostic',
      },
      {
        sequence: 3,
        offset: third.offset,
        length: third.byteLength,
        checksum: third.checksum,
        eventType: 'run_completed',
      },
    ]);
    const columns = database.connection
      .prepare("SELECT name FROM pragma_table_info('log_index') ORDER BY cid")
      .all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).not.toContain('payload_json');
  });

  it('never writes non-string values beneath exact sensitive keys to JSONL', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const log = await trackedOpen({
      directory: join(fixture, 'logs'),
      fileName: 'typed-secrets.jsonl',
      database: database.connection,
    });
    const result = await log.append({
      taskId,
      stream: 'stdout',
      eventType: 'diagnostic',
      payload: {
        password: 7_382_910,
        token: false,
        authorization: null,
        secret: ['array-disk-marker'],
        credential: { nested: 'object-disk-marker' },
      },
    });

    expect(result.record.redactionApplied).toBe(true);
    expect(result.record.payload).toEqual({
      password: '[REDACTED]',
      token: '[REDACTED]',
      authorization: '[REDACTED]',
      secret: '[REDACTED]',
      credential: '[REDACTED]',
    });
    const diskText = readFileSync(log.path, 'utf8');
    expect(diskText).not.toContain('7382910');
    expect(diskText).not.toContain('array-disk-marker');
    expect(diskText).not.toContain('object-disk-marker');
    expect((JSON.parse(diskText.trim()) as JsonlLogRecord).payload)
      .toEqual(result.record.payload);
  });

  it('reopens at the next verified sequence', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const options = {
      directory: join(fixture, 'logs'),
      fileName: 'resume.jsonl',
      database: database.connection,
    };
    const first = await trackedOpen(options);
    await first.append({ taskId, stream: 'stdout', eventType: 'partial', payload: 'a' });
    await first.append({ taskId, stream: 'stdout', eventType: 'partial', payload: 'b' });
    await first.close();

    const reopened = await trackedOpen(options);
    const result = await reopened.append({
      taskId,
      stream: 'stdout',
      eventType: 'partial',
      payload: 'c',
    });

    expect(result.sequence).toBe(3);
  });

  it('keeps a valid JSONL line and reports needsReindex when SQLite indexing fails', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const realIndex = new LogIndexRepository(database.connection);
    const failingIndex: LogIndexStore = {
      append(): void {
        throw new Error('synthetic index outage');
      },
      listForFile: realIndex.listForFile.bind(realIndex),
      replaceForFile: realIndex.replaceForFile.bind(realIndex),
    };
    const options = {
      directory: join(fixture, 'logs'),
      fileName: 'reindex.jsonl',
      database: database.connection,
    };
    const log = await trackedOpen({ ...options, indexRepository: failingIndex });

    const result = await log.append({
      taskId,
      stream: 'stderr',
      eventType: 'diagnostic',
      payload: { message: 'safe text' },
    });

    expect(result.needsReindex).toBe(true);
    expect(readFileSync(log.path, 'utf8').trimEnd().split('\n')).toHaveLength(1);
    expect(realIndex.listForFile(log.path)).toEqual([]);
    await log.close();

    const reopened = await trackedOpen(options);
    expect(await reopened.rebuildIndex()).toEqual({ indexedLines: 1, repairedTail: false });
    expect(realIndex.listForFile(reopened.path)).toHaveLength(1);
  });

  it('repairs a partial tail but fails closed on middle corruption', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const options = {
      directory: join(fixture, 'logs'),
      fileName: 'recover.jsonl',
      database: database.connection,
    };
    const log = await trackedOpen(options);
    await log.append({ taskId, stream: 'stdout', eventType: 'partial', payload: 'one' });
    await log.append({ taskId, stream: 'stdout', eventType: 'partial', payload: 'two' });
    const validSize = readFileSync(log.path).byteLength;
    await log.close();
    appendFileSync(log.path, '{"partial":', 'utf8');

    const recovered = await trackedOpen(options);
    expect(readFileSync(recovered.path).byteLength).toBe(validSize);
    await recovered.close();

    const lines = readFileSync(log.path, 'utf8').trimEnd().split('\n');
    lines[0] = '{broken-json';
    writeFileSync(log.path, `${lines.join('\n')}\n`, 'utf8');
    await expect(JsonlLog.open(options)).rejects.toThrow(/line 1|JSON|corrupt/i);
  });

  it('does not expose malformed unredacted JSON text through scan error causes', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const options = {
      directory: join(fixture, 'logs'),
      fileName: 'private-corruption.jsonl',
      database: database.connection,
    };
    const log = await trackedOpen(options);
    await log.append({ taskId, stream: 'stdout', eventType: 'partial', payload: 'safe' });
    await log.close();
    const recognizableSecret = 'recognizable-unredacted-scan-secret';
    appendFileSync(
      log.path,
      `{"payload":"${recognizableSecret}",BROKEN}\n`,
      'utf8',
    );

    let caught: unknown;
    try {
      await JsonlLog.open(options);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toHaveProperty('cause');
    expect(errorChainText(caught)).not.toContain(recognizableSecret);
  });

  it('does not echo malformed record field values in scan diagnostics', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const options = {
      directory: join(fixture, 'logs'),
      fileName: 'private-fields.jsonl',
      database: database.connection,
    };
    const log = await trackedOpen(options);
    await log.append({ taskId, stream: 'stdout', eventType: 'partial', payload: 'safe' });
    await log.close();
    const recognizableSecret = 'recognizable-unredacted-field-secret';
    appendFileSync(log.path, `${JSON.stringify({
      schemaVersion: 1,
      sequence: recognizableSecret,
      timestamp: '2026-07-12T00:00:00.000Z',
      taskId,
      stream: 'stdout',
      eventType: 'partial',
      payload: null,
      redactionApplied: false,
      display: { priority: 'low' },
      checksum: '0'.repeat(64),
    })}\n`, 'utf8');

    let caught: unknown;
    try {
      await JsonlLog.open(options);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(errorChainText(caught)).not.toContain(recognizableSecret);
  });

  it.each([
    ['checksum mismatch', (path: string) => {
      const contents = readFileSync(path, 'utf8').replace('"payload":"two"', '"payload":"tampered"');
      writeFileSync(path, contents, 'utf8');
    }, /checksum/i],
    ['sequence gap', (path: string) => rewriteSequence(path, 1, 3), /sequence.*expected 2/i],
    ['duplicate sequence', (path: string) => rewriteSequence(path, 1, 1), /sequence.*expected 2/i],
  ])('fails closed on %s', async (_name, corrupt, expected) => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const options = {
      directory: join(fixture, 'logs'),
      fileName: 'corrupt.jsonl',
      database: database.connection,
    };
    const log = await trackedOpen(options);
    await log.append({ taskId, stream: 'stdout', eventType: 'partial', payload: 'one' });
    await log.append({ taskId, stream: 'stdout', eventType: 'partial', payload: 'two' });
    await log.close();
    corrupt(log.path);

    await expect(JsonlLog.open(options)).rejects.toThrow(expected);
  });

  it('rebuilds indexes idempotently and repairs wrong metadata', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const log = await trackedOpen({
      directory: join(fixture, 'logs'),
      fileName: 'rebuild.jsonl',
      database: database.connection,
    });
    await log.append({ taskId, stream: 'stdout', eventType: 'partial', payload: 'one' });
    await log.append({ taskId, stream: 'stderr', eventType: 'diagnostic', payload: 'two' });
    database.connection.prepare('UPDATE log_index SET checksum = ? WHERE sequence = 1').run('0'.repeat(64));

    expect((await log.rebuildIndex()).indexedLines).toBe(2);
    const afterFirst = new LogIndexRepository(database.connection).listForFile(log.path);
    expect(afterFirst[0]!.checksum).not.toBe('0'.repeat(64));
    expect((await log.rebuildIndex()).indexedLines).toBe(2);
    expect(new LogIndexRepository(database.connection).listForFile(log.path)).toEqual(afterFirst);
  });

  it('makes close wait for an already-started rebuild and rejects later operations', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    const taskId = createTask(database);
    const log = await trackedOpen({
      directory: join(fixture, 'logs'),
      fileName: 'rebuild-close.jsonl',
      database: database.connection,
    });
    await log.append({ taskId, stream: 'stdout', eventType: 'partial', payload: 'one' });

    type MutableStatHandle = {
      stat: (...args: any[]) => Promise<any>;
    };
    const internalFile = (log as unknown as { file: MutableStatHandle }).file;
    const originalStat = internalFile.stat.bind(internalFile);
    let releaseStat!: () => void;
    let reportStatEntered!: () => void;
    const statGate = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });
    const statEntered = new Promise<void>((resolve) => {
      reportStatEntered = resolve;
    });
    let delayNextStat = true;
    internalFile.stat = async (...args: any[]): Promise<any> => {
      if (delayNextStat) {
        delayNextStat = false;
        reportStatEntered();
        await statGate;
      }
      return originalStat(...args);
    };

    const rebuild = log.rebuildIndex();
    await statEntered;
    const close = log.close();
    expect(log.close()).toBe(close);
    const appendAfterClose = log.append({
      taskId,
      stream: 'stdout',
      eventType: 'partial',
      payload: 'late',
    }).then(
      (value) => ({ status: 'fulfilled', value } as const),
      (reason: unknown) => ({ status: 'rejected', reason } as const),
    );
    const rebuildAfterClose = log.rebuildIndex().then(
      (value) => ({ status: 'fulfilled', value } as const),
      (reason: unknown) => ({ status: 'rejected', reason } as const),
    );
    let closeSettled = false;
    void close.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closeSettledBeforeRelease = closeSettled;
    releaseStat();

    const [rebuildResult, closeResult] = await Promise.allSettled([rebuild, close]);
    const [appendResult, lateRebuildResult] = await Promise.all([
      appendAfterClose,
      rebuildAfterClose,
    ]);

    expect(closeSettledBeforeRelease).toBe(false);
    expect(rebuildResult).toMatchObject({ status: 'fulfilled' });
    expect(closeResult).toMatchObject({ status: 'fulfilled' });
    expect(appendResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/closing|closed/i) }),
    });
    expect(lateRebuildResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/closing|closed/i) }),
    });
  });

  it('rejects a second writer for the same file and permits reopening after close', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    createTask(database);
    const options = {
      directory: join(fixture, 'logs'),
      fileName: 'locked.jsonl',
      database: database.connection,
    };
    const first = await trackedOpen(options);

    await expect(JsonlLog.open(options)).rejects.toThrow(/writer|lock|owned/i);
    await first.close();
    const reopened = await trackedOpen(options);
    expect(reopened.path).toBe(first.path);
  });

  it('rejects stores inside the project before creating project files', async () => {
    const fixture = temporaryDirectory();
    const projectRoot = join(fixture, 'project');
    const database = openTemporaryDatabase(fixture);
    createTask(database);
    writeFileSync(join(fixture, 'marker'), 'outside', 'utf8');
    writeFileSync(join(fixture, 'project-placeholder'), 'placeholder', 'utf8');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(projectRoot);
    writeFileSync(join(projectRoot, 'tracked.txt'), 'tracked', 'utf8');
    const before = readdirSync(projectRoot);

    await expect(JsonlLog.open({
      directory: join(projectRoot, '..', 'project', 'logs'),
      fileName: 'unsafe.jsonl',
      database: database.connection,
      projectRoot,
    })).rejects.toThrow(/outside project|inside project|store/i);

    expect(readdirSync(projectRoot)).toEqual(before);
    expect(existsSync(join(projectRoot, 'logs'))).toBe(false);
  });

  it('rejects dot-segment file names instead of resolving outside the store', async () => {
    const fixture = temporaryDirectory();
    const database = openTemporaryDatabase(fixture);
    createTask(database);

    await expect(JsonlLog.open({
      directory: join(fixture, 'logs'),
      fileName: '..',
      database: database.connection,
    })).rejects.toThrow(/fileName/i);
    expect(existsSync(`${fixture}.lock`)).toBe(false);
  });

  it('rejects a junction or symlink that resolves from an external store into the project', async () => {
    const fixture = temporaryDirectory();
    const projectRoot = join(fixture, 'project');
    const external = join(fixture, 'external');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(projectRoot);
    mkdirSync(external);
    writeFileSync(join(projectRoot, 'tracked.txt'), 'tracked', 'utf8');
    const junction = join(external, 'redirected-store');
    symlinkSync(projectRoot, junction, process.platform === 'win32' ? 'junction' : 'dir');
    const database = openTemporaryDatabase(fixture);
    createTask(database);

    await expect(JsonlLog.open({
      directory: junction,
      fileName: 'unsafe.jsonl',
      database: database.connection,
      projectRoot,
    })).rejects.toThrow(/outside project|inside project|store/i);

    expect(readdirSync(projectRoot)).toEqual(['tracked.txt']);
    expect(existsSync(join(projectRoot, 'unsafe.jsonl'))).toBe(false);
    expect(dirname(junction)).toBe(external);
  });

  it('rejects a pre-existing final log file hard-linked to a project file', async () => {
    const fixture = temporaryDirectory();
    const projectRoot = join(fixture, 'project');
    const external = join(fixture, 'external');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(projectRoot);
    mkdirSync(external);
    const projectFile = join(projectRoot, 'tracked.jsonl');
    const original = 'project file must remain unchanged';
    writeFileSync(projectFile, original, 'utf8');
    linkSync(projectFile, join(external, 'alias.jsonl'));
    const database = openTemporaryDatabase(fixture);
    createTask(database);

    let unexpectedLog: JsonlLog | undefined;
    let caught: unknown;
    try {
      unexpectedLog = await JsonlLog.open({
        directory: external,
        fileName: 'alias.jsonl',
        database: database.connection,
        projectRoot,
      });
    } catch (error) {
      caught = error;
    }
    if (unexpectedLog !== undefined) logs.push(unexpectedLog);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/hard.?link|multi.?link|alias/i);
    expect(readFileSync(projectFile, 'utf8')).toBe(original);
  });

  it('rejects a supported final log file symlink resolving into the project', async () => {
    const fixture = temporaryDirectory();
    const projectRoot = join(fixture, 'project');
    const external = join(fixture, 'external');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(projectRoot);
    mkdirSync(external);
    const projectFile = join(projectRoot, 'tracked.jsonl');
    const original = 'symlink target must remain unchanged';
    writeFileSync(projectFile, original, 'utf8');
    try {
      symlinkSync(projectFile, join(external, 'alias.jsonl'), 'file');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      expect(code).toMatch(/EPERM|EACCES|ENOTSUP/);
      return;
    }
    const database = openTemporaryDatabase(fixture);
    createTask(database);

    let unexpectedLog: JsonlLog | undefined;
    let caught: unknown;
    try {
      unexpectedLog = await JsonlLog.open({
        directory: external,
        fileName: 'alias.jsonl',
        database: database.connection,
        projectRoot,
      });
    } catch (error) {
      caught = error;
    }
    if (unexpectedLog !== undefined) logs.push(unexpectedLog);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/symbolic|symlink|reparse|alias|outside project/i);
    expect(readFileSync(projectFile, 'utf8')).toBe(original);
  });
});
