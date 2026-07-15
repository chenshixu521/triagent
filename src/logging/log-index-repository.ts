import type { DatabaseSync } from 'node:sqlite';

import { withTransaction } from '../persistence/transaction.js';

export type LogStream = 'stdout' | 'stderr' | 'system';

export interface LogIndexEntry {
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly stream: LogStream;
  readonly eventType: string;
  readonly filePath: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly checksum: string;
  readonly timestamp: string;
}

export interface LogIndexStore {
  append(entry: LogIndexEntry): void;
  listForFile(filePath: string): readonly LogIndexEntry[];
  replaceForFile(filePath: string, entries: readonly LogIndexEntry[]): void;
}

interface LogIndexRow {
  readonly task_id: string;
  readonly attempt_id: string | null;
  readonly stream: string;
  readonly file_path: string;
  readonly byte_offset: number;
  readonly byte_length: number;
  readonly created_at: string;
  readonly schema_version: number | null;
  readonly sequence: number | null;
  readonly checksum: string | null;
  readonly event_type: string | null;
  readonly log_timestamp: string | null;
}

const INSERT = `INSERT INTO log_index(
  task_id, attempt_id, stream, file_path, byte_offset, byte_length, created_at,
  schema_version, sequence, checksum, event_type, log_timestamp
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function nonEmpty(value: string, field: string): string {
  if (value.trim() === '') throw new Error(`${field} must be non-empty`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function validate(entry: LogIndexEntry): LogIndexEntry {
  positiveInteger(entry.schemaVersion, 'schemaVersion');
  positiveInteger(entry.sequence, 'sequence');
  nonEmpty(entry.taskId, 'taskId');
  if (entry.attemptId !== undefined) nonEmpty(entry.attemptId, 'attemptId');
  if (!['stdout', 'stderr', 'system'].includes(entry.stream)) {
    throw new Error('invalid log stream');
  }
  nonEmpty(entry.eventType, 'eventType');
  nonEmpty(entry.filePath, 'filePath');
  nonNegativeInteger(entry.byteOffset, 'byteOffset');
  positiveInteger(entry.byteLength, 'byteLength');
  if (!/^[a-f0-9]{64}$/u.test(entry.checksum)) {
    throw new Error('checksum must be a lowercase SHA-256 digest');
  }
  nonEmpty(entry.timestamp, 'timestamp');
  return entry;
}

function fromRow(row: LogIndexRow): LogIndexEntry {
  if (
    row.schema_version === null ||
    row.sequence === null ||
    row.checksum === null ||
    row.event_type === null ||
    row.log_timestamp === null
  ) {
    throw new Error('legacy log index row is missing integrity metadata');
  }
  if (row.stream !== 'stdout' && row.stream !== 'stderr' && row.stream !== 'system') {
    throw new Error('invalid indexed log stream');
  }
  return validate({
    schemaVersion: row.schema_version,
    sequence: row.sequence,
    taskId: row.task_id,
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    stream: row.stream,
    eventType: row.event_type,
    filePath: row.file_path,
    byteOffset: row.byte_offset,
    byteLength: row.byte_length,
    checksum: row.checksum,
    timestamp: row.log_timestamp,
  });
}

export class LogIndexRepository implements LogIndexStore {
  public constructor(private readonly database: DatabaseSync) {}

  public append(entry: LogIndexEntry): void {
    this.insert(validate(entry));
  }

  public listForFile(filePath: string): readonly LogIndexEntry[] {
    const rows = this.database.prepare(
      `SELECT task_id, attempt_id, stream, file_path, byte_offset, byte_length,
        created_at, schema_version, sequence, checksum, event_type, log_timestamp
       FROM log_index WHERE file_path = ? ORDER BY sequence`,
    ).all(nonEmpty(filePath, 'filePath')) as unknown as LogIndexRow[];
    return rows.map(fromRow);
  }

  public replaceForFile(
    filePath: string,
    entries: readonly LogIndexEntry[],
  ): void {
    const normalizedPath = nonEmpty(filePath, 'filePath');
    const validated = entries.map((entry) => {
      if (entry.filePath !== normalizedPath) {
        throw new Error('replacement index entry belongs to a different log file');
      }
      return validate(entry);
    });
    withTransaction(this.database, () => {
      this.database.prepare('DELETE FROM log_index WHERE file_path = ?').run(normalizedPath);
      for (const entry of validated) this.insert(entry);
    });
  }

  private insert(entry: LogIndexEntry): void {
    this.database.prepare(INSERT).run(
      entry.taskId,
      entry.attemptId ?? null,
      entry.stream,
      entry.filePath,
      entry.byteOffset,
      entry.byteLength,
      entry.timestamp,
      entry.schemaVersion,
      entry.sequence,
      entry.checksum,
      entry.eventType,
      entry.timestamp,
    );
  }
}
