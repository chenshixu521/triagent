import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import * as path from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import { assertJsonValue, type JsonValue } from '../persistence/json-value.js';
import {
  LogIndexRepository,
  type LogIndexEntry,
  type LogIndexStore,
  type LogStream,
} from './log-index-repository.js';
import { Redactor } from './redact.js';

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const writerRegistry = new Set<string>();

export type LogDisplayPriority = 'low' | 'normal' | 'high';

export interface JsonlLogRecord {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly timestamp: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly stream: LogStream;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly redactionApplied: boolean;
  readonly display: {
    readonly priority: LogDisplayPriority;
  };
  readonly checksum: string;
}

export interface JsonlAppendInput {
  readonly taskId: string;
  readonly attemptId?: string;
  readonly stream: LogStream;
  readonly eventType: string;
  readonly payload: unknown;
  readonly display?: {
    readonly priority: LogDisplayPriority;
  };
}

export interface JsonlAppendResult {
  readonly sequence: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly checksum: string;
  readonly record: JsonlLogRecord;
  readonly needsReindex: boolean;
}

export interface JsonlLogOptions {
  readonly directory: string;
  readonly fileName: string;
  readonly database: DatabaseSync;
  readonly projectRoot?: string;
  readonly redactor?: Redactor;
  readonly indexRepository?: LogIndexStore;
  readonly clock?: () => Date;
  readonly maxLineBytes?: number;
}

interface ScanResult {
  readonly entries: readonly LogIndexEntry[];
  readonly repairedTail: boolean;
  readonly completeBytes: number;
}

function nonEmpty(value: string, field: string): string {
  if (value.trim() === '') throw new Error(`${field} must be non-empty`);
  return value;
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function isSameOrChild(parent: string, candidate: string): boolean {
  const relative = path.relative(pathKey(parent), pathKey(candidate));
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

async function prospectiveRealPath(input: string): Promise<string> {
  let cursor = input;
  const missing: string[] = [];
  while (!(await exists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('log store has no existing ancestor');
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(await realpath(cursor), ...missing);
}

async function prepareStoreDirectory(
  directory: string,
  projectRoot?: string,
): Promise<string> {
  const absoluteDirectory = path.resolve(nonEmpty(directory, 'log directory'));
  if (projectRoot !== undefined) {
    const absoluteProject = path.resolve(nonEmpty(projectRoot, 'projectRoot'));
    const projectCanonical = await realpath(absoluteProject);
    if (
      isSameOrChild(absoluteProject, absoluteDirectory) ||
      isSameOrChild(projectCanonical, await prospectiveRealPath(absoluteDirectory))
    ) {
      throw new Error('log store must be outside project root');
    }
  }
  await mkdir(absoluteDirectory, { recursive: true });
  const canonicalDirectory = await realpath(absoluteDirectory);
  if (projectRoot !== undefined) {
    const projectCanonical = await realpath(path.resolve(projectRoot));
    if (isSameOrChild(projectCanonical, canonicalDirectory)) {
      throw new Error('log store must be outside project root');
    }
  }
  if (!(await stat(canonicalDirectory)).isDirectory()) {
    throw new Error('log store must be a directory');
  }
  return canonicalDirectory;
}

async function validateFinalLogPathBeforeOpen(
  filePath: string,
  projectCanonical?: string,
): Promise<void> {
  let linkStats;
  try {
    linkStats = await lstat(filePath, { bigint: true });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return;
    throw error;
  }
  if (linkStats.isSymbolicLink()) {
    throw new Error('final log file must not be a symbolic or reparse-point alias');
  }
  if (!linkStats.isFile()) {
    throw new Error('final log path must be a regular file');
  }
  if (linkStats.nlink !== 1n) {
    throw new Error('final log file must not be a hard-link or multi-link alias');
  }
  const canonicalTarget = await realpath(filePath);
  if (pathKey(canonicalTarget) !== pathKey(filePath)) {
    throw new Error('final log file must not resolve through an alias or reparse point');
  }
  if (
    projectCanonical !== undefined &&
    isSameOrChild(projectCanonical, canonicalTarget)
  ) {
    throw new Error('final log file must be outside project root');
  }
}

async function validateOpenedLogHandle(
  file: FileHandle,
  filePath: string,
  projectCanonical?: string,
): Promise<void> {
  const handleStats = await file.stat({ bigint: true });
  if (!handleStats.isFile()) {
    throw new Error('opened log handle must reference a regular file');
  }
  if (handleStats.nlink !== 1n) {
    throw new Error('opened log handle must not reference a hard-link or multi-link alias');
  }
  const linkStats = await lstat(filePath, { bigint: true });
  if (linkStats.isSymbolicLink()) {
    throw new Error('opened log path became a symbolic or reparse-point alias');
  }
  const pathStats = await stat(filePath, { bigint: true });
  if (pathStats.dev !== handleStats.dev || pathStats.ino !== handleStats.ino) {
    throw new Error('opened log path identity changed during validation');
  }
  if (pathStats.nlink !== 1n) {
    throw new Error('opened log path became a hard-link or multi-link alias');
  }
  const canonicalTarget = await realpath(filePath);
  if (pathKey(canonicalTarget) !== pathKey(filePath)) {
    throw new Error('opened log path resolves through an alias or reparse point');
  }
  if (
    projectCanonical !== undefined &&
    isSameOrChild(projectCanonical, canonicalTarget)
  ) {
    throw new Error('opened log file must be outside project root');
  }
}

function checksum(value: object): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function validTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateRecord(
  input: unknown,
  expectedSequence: number,
  lineNumber: number,
): JsonlLogRecord {
  assertJsonValue(input);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`corrupt JSONL line ${lineNumber}: record must be an object`);
  }
  const record = input as Record<string, JsonValue>;
  const allowed = new Set([
    'schemaVersion', 'sequence', 'timestamp', 'taskId', 'attemptId', 'stream',
    'eventType', 'payload', 'redactionApplied', 'display', 'checksum',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`corrupt JSONL line ${lineNumber}: unknown record field`);
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`corrupt JSONL line ${lineNumber}: unsupported schema version`);
  }
  if (record.sequence !== expectedSequence) {
    throw new Error(
      `corrupt JSONL line ${lineNumber}: invalid sequence, expected ${expectedSequence}`,
    );
  }
  if (typeof record.timestamp !== 'string' || !validTimestamp(record.timestamp)) {
    throw new Error(`corrupt JSONL line ${lineNumber}: invalid timestamp`);
  }
  if (typeof record.taskId !== 'string' || record.taskId.trim() === '') {
    throw new Error(`corrupt JSONL line ${lineNumber}: invalid taskId`);
  }
  if (
    record.attemptId !== undefined &&
    (typeof record.attemptId !== 'string' || record.attemptId.trim() === '')
  ) {
    throw new Error(`corrupt JSONL line ${lineNumber}: invalid attemptId`);
  }
  if (record.stream !== 'stdout' && record.stream !== 'stderr' && record.stream !== 'system') {
    throw new Error(`corrupt JSONL line ${lineNumber}: invalid stream`);
  }
  if (typeof record.eventType !== 'string' || record.eventType.trim() === '') {
    throw new Error(`corrupt JSONL line ${lineNumber}: invalid eventType`);
  }
  if (record.payload === undefined || typeof record.redactionApplied !== 'boolean') {
    throw new Error(`corrupt JSONL line ${lineNumber}: invalid payload metadata`);
  }
  if (
    record.display === null ||
    typeof record.display !== 'object' ||
    Array.isArray(record.display) ||
    Object.keys(record.display).length !== 1 ||
    !['low', 'normal', 'high'].includes(
      String((record.display as { readonly priority?: JsonValue }).priority),
    )
  ) {
    throw new Error(`corrupt JSONL line ${lineNumber}: invalid display metadata`);
  }
  if (typeof record.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(record.checksum)) {
    throw new Error(`corrupt JSONL line ${lineNumber}: invalid checksum`);
  }
  const { checksum: storedChecksum, ...withoutChecksum } = record;
  if (checksum(withoutChecksum) !== storedChecksum) {
    throw new Error(`corrupt JSONL line ${lineNumber}: checksum mismatch`);
  }
  return record as unknown as JsonlLogRecord;
}

function toIndexEntry(
  record: JsonlLogRecord,
  filePath: string,
  byteOffset: number,
  byteLength: number,
): LogIndexEntry {
  return {
    schemaVersion: record.schemaVersion,
    sequence: record.sequence,
    taskId: record.taskId,
    ...(record.attemptId === undefined ? {} : { attemptId: record.attemptId }),
    stream: record.stream,
    eventType: record.eventType,
    filePath,
    byteOffset,
    byteLength,
    checksum: record.checksum,
    timestamp: record.timestamp,
  };
}

async function scanFile(
  filePath: string,
  maxLineBytes: number,
  file?: FileHandle,
): Promise<ScanResult> {
  const entries: LogIndexEntry[] = [];
  let pending = Buffer.alloc(0);
  let completeBytes = 0;
  let lineNumber = 0;
  let oversizedPartial = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const stream = createReadStream(filePath, {
    highWaterMark: 64 * 1024,
    ...(file === undefined ? {} : { fd: file.fd, autoClose: false, start: 0 }),
  });

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    if (oversizedPartial) {
      if (chunk.includes(0x0a)) {
        throw new Error(`corrupt JSONL line ${lineNumber + 1}: line exceeds byte limit`);
      }
      continue;
    }
    let combined = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline = combined.indexOf(0x0a);
    while (newline !== -1) {
      const line = combined.subarray(0, newline);
      lineNumber += 1;
      if (line.length > maxLineBytes) {
        throw new Error(`corrupt JSONL line ${lineNumber}: line exceeds byte limit`);
      }
      let text: string;
      try {
        text = decoder.decode(line);
      } catch {
        throw new Error(`corrupt JSONL line ${lineNumber}: invalid UTF-8`);
      }
      if (text.endsWith('\r')) {
        throw new Error(`corrupt JSONL line ${lineNumber}: CRLF is not canonical JSONL`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`corrupt JSONL line ${lineNumber}: invalid JSON`);
      }
      const record = validateRecord(parsed, lineNumber, lineNumber);
      const canonical = JSON.stringify(record);
      if (canonical !== text) {
        throw new Error(`corrupt JSONL line ${lineNumber}: non-canonical record encoding`);
      }
      entries.push(toIndexEntry(record, filePath, completeBytes, line.length + 1));
      completeBytes += line.length + 1;
      combined = combined.subarray(newline + 1);
      newline = combined.indexOf(0x0a);
    }
    pending = Buffer.from(combined);
    if (pending.length > maxLineBytes) {
      oversizedPartial = true;
      pending = Buffer.alloc(0);
    }
  }

  return {
    entries,
    repairedTail: oversizedPartial || pending.length > 0,
    completeBytes,
  };
}

export class JsonlLog {
  public readonly path: string;
  private sequence: number;
  private offset: number;
  private operationTail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private closing = false;
  private unusable = false;

  private constructor(
    filePath: string,
    private readonly file: FileHandle,
    private readonly lockPath: string,
    private readonly lockFile: FileHandle,
    private readonly registryKey: string,
    private readonly projectCanonical: string | undefined,
    private readonly index: LogIndexStore,
    private readonly redactor: Redactor,
    private readonly clock: () => Date,
    private readonly maxLineBytes: number,
    scan: ScanResult,
  ) {
    this.path = filePath;
    this.sequence = scan.entries.length;
    this.offset = scan.completeBytes;
  }

  public static async open(options: JsonlLogOptions): Promise<JsonlLog> {
    if (
      path.basename(options.fileName) !== options.fileName ||
      options.fileName.trim() === '' ||
      options.fileName === '.' ||
      options.fileName === '..'
    ) {
      throw new Error('fileName must be a plain non-empty file name');
    }
    const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new Error('maxLineBytes must be a positive integer');
    }
    const directory = await prepareStoreDirectory(options.directory, options.projectRoot);
    const filePath = path.join(directory, options.fileName);
    const projectCanonical = options.projectRoot === undefined
      ? undefined
      : await realpath(path.resolve(options.projectRoot));
    await validateFinalLogPathBeforeOpen(filePath, projectCanonical);
    const registryKey = pathKey(filePath);
    if (writerRegistry.has(registryKey)) {
      throw new Error('JSONL file already has an active writer');
    }
    writerRegistry.add(registryKey);
    const lockPath = `${filePath}.lock`;
    let lockFile: FileHandle | undefined;
    let file: FileHandle | undefined;
    try {
      try {
        lockFile = await open(lockPath, 'wx');
      } catch (error) {
        throw new Error('JSONL writer lock is already owned', { cause: error });
      }
      await lockFile.writeFile(JSON.stringify({ pid: process.pid, owner: randomUUID() }), 'utf8');
      await lockFile.sync();
      try {
        file = await open(filePath, 'r+');
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'ENOENT') throw error;
        file = await open(filePath, 'wx+');
      }
      await validateOpenedLogHandle(file, filePath, projectCanonical);
      const scan = await scanFile(filePath, maxLineBytes, file);
      if (scan.repairedTail) {
        await validateOpenedLogHandle(file, filePath, projectCanonical);
        await file.truncate(scan.completeBytes);
        await file.sync();
      }
      return new JsonlLog(
        filePath,
        file,
        lockPath,
        lockFile,
        registryKey,
        projectCanonical,
        options.indexRepository ?? new LogIndexRepository(options.database),
        options.redactor ?? new Redactor(),
        options.clock ?? (() => new Date()),
        maxLineBytes,
        scan,
      );
    } catch (error) {
      if (file !== undefined) await file.close().catch(() => undefined);
      if (lockFile !== undefined) {
        await lockFile.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
      writerRegistry.delete(registryKey);
      throw error;
    }
  }

  public append(input: JsonlAppendInput): Promise<JsonlAppendResult> {
    if (this.closing) return Promise.reject(new Error('JSONL log is closing or closed'));
    if (this.unusable) return Promise.reject(new Error('JSONL log writer is unusable'));
    return this.enqueueOperation(() => this.appendOne(input));
  }

  public rebuildIndex(): Promise<{
    readonly indexedLines: number;
    readonly repairedTail: boolean;
  }> {
    if (this.closing) return Promise.reject(new Error('JSONL log is closing or closed'));
    return this.enqueueOperation(() => this.rebuildIndexOne());
  }

  private async rebuildIndexOne(): Promise<{
    readonly indexedLines: number;
    readonly repairedTail: boolean;
  }> {
    await validateOpenedLogHandle(this.file, this.path, this.projectCanonical);
    const scan = await scanFile(this.path, this.maxLineBytes, this.file);
    if (scan.repairedTail) {
      await validateOpenedLogHandle(this.file, this.path, this.projectCanonical);
      await this.file.truncate(scan.completeBytes);
      await this.file.sync();
      this.offset = scan.completeBytes;
      this.sequence = scan.entries.length;
    }
    this.index.replaceForFile(this.path, scan.entries);
    return { indexedLines: scan.entries.length, repairedTail: scan.repairedTail };
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = this.enqueueOperation(async () => {
      try {
        await this.file.sync();
      } finally {
        await this.file.close().catch(() => undefined);
        await this.lockFile.close().catch(() => undefined);
        await unlink(this.lockPath).catch(() => undefined);
        writerRegistry.delete(this.registryKey);
      }
    });
    return this.closePromise;
  }

  private enqueueOperation<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async appendOne(input: JsonlAppendInput): Promise<JsonlAppendResult> {
    const taskId = nonEmpty(input.taskId, 'taskId');
    const eventType = nonEmpty(input.eventType, 'eventType');
    if (input.attemptId !== undefined) nonEmpty(input.attemptId, 'attemptId');
    if (input.stream !== 'stdout' && input.stream !== 'stderr' && input.stream !== 'system') {
      throw new Error('invalid log stream');
    }
    const priority = input.display?.priority ?? 'normal';
    if (priority !== 'low' && priority !== 'normal' && priority !== 'high') {
      throw new Error('invalid display priority');
    }
    const redacted = this.redactor.redact(input.payload);
    const timestamp = this.clock().toISOString();
    const sequence = this.sequence + 1;
    const withoutChecksum = {
      schemaVersion: SCHEMA_VERSION,
      sequence,
      timestamp,
      taskId,
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      stream: input.stream,
      eventType,
      payload: redacted.value,
      redactionApplied: redacted.redactionApplied,
      display: { priority },
    } as const;
    const digest = checksum(withoutChecksum);
    const record: JsonlLogRecord = { ...withoutChecksum, checksum: digest };
    const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    if (buffer.length > this.maxLineBytes + 1) {
      throw new Error('JSONL record exceeds maximum line size');
    }
    const offset = this.offset;
    let written = 0;
    try {
      await validateOpenedLogHandle(this.file, this.path, this.projectCanonical);
      while (written < buffer.length) {
        const result = await this.file.write(
          buffer,
          written,
          buffer.length - written,
          offset + written,
        );
        if (result.bytesWritten < 1) throw new Error('JSONL write made no progress');
        written += result.bytesWritten;
      }
      await this.file.sync();
    } catch (error) {
      this.unusable = true;
      throw new Error('JSONL append failed; writer requires recovery', { cause: error });
    }
    this.sequence = sequence;
    this.offset += buffer.length;
    const indexEntry = toIndexEntry(record, this.path, offset, buffer.length);
    let needsReindex = false;
    try {
      this.index.append(indexEntry);
    } catch {
      needsReindex = true;
    }
    return {
      sequence,
      offset,
      byteLength: buffer.length,
      checksum: digest,
      record,
      needsReindex,
    };
  }
}
