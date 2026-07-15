import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  fsyncSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { canonicalizeProjectPath } from '../project/canonical-path.js';

import { evaluateIgnorePath, shouldPruneDirectoryName } from './ignore-policy.js';
import { isBinaryContent, sha256, sha256Json, stableJson } from './hash.js';

export type NonGitBaselineKind = 'task' | 'attempt';
export type NonGitFileType = 'file' | 'symlink' | 'directory' | 'other';

export type ContentExclusionReason = 'too-large' | 'unsupported-file-type' | 'symlink-not-followed';

export interface NonGitFileEntry {
  readonly path: string;
  readonly type: NonGitFileType;
  readonly size: number;
  readonly mtimeMs: number | null;
  readonly ctimeMs: number | null;
  readonly dev?: string;
  readonly ino?: string;
  readonly hash: string | null;
  readonly blobHash: string | null;
  readonly missing: boolean;
  readonly executable: boolean;
  readonly binary: boolean;
  readonly contentCaptured: boolean;
  readonly contentExclusionReason?: ContentExclusionReason;
  readonly linkTarget?: string;
  readonly reparseEvidence?: {
    readonly kind: 'symbolic-link-or-reparse-point';
    readonly linkTarget: string;
  };
}

export interface NonGitExclusion {
  readonly path: string;
  readonly reason: 'ancestor-reparse-point' | 'unsupported-file-type' | 'policy-skip';
  readonly evidence: string;
}

export interface NonGitProjectIdentity {
  readonly kind: 'directory';
  readonly canonicalRoot: string;
}

export interface NonGitBaselineManifest {
  readonly version: 1;
  readonly status: 'complete';
  readonly kind: NonGitBaselineKind;
  readonly taskId: string;
  readonly baselineId: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly parentTaskBaselineId?: string;
  readonly createdAt: string;
  readonly project: NonGitProjectIdentity;
  readonly files: readonly NonGitFileEntry[];
  readonly exclusions: readonly NonGitExclusion[];
  readonly checksum: string;
}

export interface BuildingNonGitBaselineManifest
  extends Omit<NonGitBaselineManifest, 'status' | 'checksum'> {
  readonly status: 'building';
}

export type NonGitBaselineLoadResult =
  | { readonly status: 'loaded'; readonly manifest: NonGitBaselineManifest }
  | { readonly status: 'ignored'; readonly diagnostic: string };

export interface CaptureTaskBaselineInput {
  readonly taskId: string;
  readonly baselineId: string;
  readonly createdAt?: Date;
}

export interface CaptureAttemptBaselineInput extends CaptureTaskBaselineInput {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly parentTaskBaselineId: string;
}

export interface NonGitCurrentSnapshot {
  readonly project: NonGitProjectIdentity;
  readonly files: readonly NonGitFileEntry[];
  readonly exclusions: readonly NonGitExclusion[];
  readonly blobs: ReadonlyMap<string, Buffer>;
}

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'type-changed' | 'renamed';

export interface FileVersionSummary {
  readonly hash: string | null;
  readonly size: number;
  readonly type: NonGitFileType;
  readonly missing: boolean;
  readonly contentCaptured: boolean;
}

export interface FileChange {
  readonly kind: ChangeKind;
  readonly path: string;
  readonly fromPath?: string;
  readonly before: FileVersionSummary | null;
  readonly after: FileVersionSummary | null;
  readonly binary: boolean;
}

export interface NonGitChangeSet {
  readonly label: 'task-window changes' | 'attempt-window changes';
  readonly baselineId: string;
  readonly changes: readonly FileChange[];
  readonly added: readonly FileChange[];
  readonly modified: readonly FileChange[];
  readonly deleted: readonly FileChange[];
  readonly typeChanged: readonly FileChange[];
  readonly renamed: readonly FileChange[];
  readonly summary: {
    readonly total: number;
    readonly added: number;
    readonly modified: number;
    readonly deleted: number;
    readonly typeChanged: number;
    readonly renamed: number;
    readonly binary: number;
  };
}

export interface NonGitBaselineServiceOptions {
  readonly projectRoot: string;
  readonly snapshotStore: string;
  readonly maxReadAttempts?: number;
  readonly maxScanAttempts?: number;
  /** Content larger than this is metadata-only (default 1 MiB). */
  readonly maxContentBytes?: number;
  /** Streaming hash/read chunk size (default 64 KiB). */
  readonly hashChunkBytes?: number;
  readonly fileReadHook?: (relativePath: string, attempt: number) => void;
}

export class SnapshotStoreInsideProject extends Error {
  public override readonly name = 'SnapshotStoreInsideProject';

  public constructor(path: string) {
    super(
      `SnapshotStoreInsideProject: snapshot store must be outside the canonical project root: ${path}`,
    );
  }
}

export class ReparseEscape extends Error {
  public override readonly name = 'ReparseEscape';

  public constructor(path: string) {
    super(
      `ReparseEscape: snapshot store reparse resolution enters the canonical project root: ${path}`,
    );
  }
}

export class NonGitBaselineUnstableError extends Error {
  public override readonly name = 'NonGitBaselineUnstableError';
  public readonly evidence: string;

  public constructor(message: string, evidence: string, options?: ErrorOptions) {
    super(`NonGitBaselineUnstableError: ${message}`, options);
    this.evidence = evidence;
  }
}

interface StableStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface FileScanResult {
  readonly entry?: NonGitFileEntry;
  readonly exclusion?: NonGitExclusion;
  readonly blob?: Buffer;
  readonly verificationKey: string;
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

function validateIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a filesystem-safe identifier`);
  }
  return value;
}

function normalizeRelativePath(value: string): string {
  const path = value.replaceAll('\\', '/');
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe relative path: ${JSON.stringify(value)}`);
  }
  return path;
}

function signatureFromStat(stat: BigIntStats): StableStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function statSignature(path: string): StableStat {
  return signatureFromStat(lstatSync(path, { bigint: true }));
}

function sameStat(left: StableStat, right: StableStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function statVerificationKey(stat: StableStat): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map(String)
    .join(':');
}

function toMs(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isSameOrChild(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath.length === 0 ||
    (!isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

function nearestExistingAncestor(path: string): string {
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`snapshot store has no existing ancestor: ${path}`);
    candidate = parent;
  }
  const stats = lstatSync(candidate);
  if (!stats.isDirectory() && !stats.isSymbolicLink()) {
    throw new Error(`nearest existing snapshot store ancestor is not a directory: ${candidate}`);
  }
  return candidate;
}

function comparisonPath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hasSymbolicLinkComponent(path: string): boolean {
  let candidate = resolve(path);
  while (true) {
    if (lstatSync(candidate).isSymbolicLink()) return true;
    const parent = dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

function canonicalizeSnapshotPath(path: string): ReturnType<typeof canonicalizeProjectPath> {
  const absolute = resolve(path);
  const real = realpathSync.native(absolute);
  const requiresFullReparseProbe =
    hasSymbolicLinkComponent(absolute) || comparisonPath(real) !== comparisonPath(absolute);
  return canonicalizeProjectPath(
    absolute,
    requiresFullReparseProbe ? {} : { reparseProbe: () => [] },
  );
}

function evidenceTargetsProject(
  projectRoot: string,
  evidence: ReturnType<typeof canonicalizeProjectPath>['reparsePoints'][number],
): boolean {
  return [evidence.targetPath, ...evidence.reportedTargets].some(
    (target) => isAbsolute(target) && isSameOrChild(projectRoot, target),
  );
}

function validateAndCreateSnapshotStore(projectRoot: string, requestedStore: string): string {
  const absoluteStore = resolve(requestedStore);
  if (isSameOrChild(projectRoot, absoluteStore)) {
    throw new SnapshotStoreInsideProject(absoluteStore);
  }
  const existingAncestor = nearestExistingAncestor(absoluteStore);
  const ancestor = canonicalizeSnapshotPath(existingAncestor);
  const unresolvedSuffix = relative(existingAncestor, absoluteStore);
  const resolvedCandidate = resolve(ancestor.canonicalRoot, unresolvedSuffix);
  if (
    isSameOrChild(projectRoot, resolvedCandidate) ||
    ancestor.reparsePoints.some((evidence) => evidenceTargetsProject(projectRoot, evidence))
  ) {
    throw new ReparseEscape(absoluteStore);
  }

  mkdirSync(absoluteStore, { recursive: true });
  const completedStore = canonicalizeSnapshotPath(absoluteStore);
  if (
    isSameOrChild(projectRoot, completedStore.canonicalRoot) ||
    completedStore.reparsePoints.some((evidence) => evidenceTargetsProject(projectRoot, evidence))
  ) {
    throw new ReparseEscape(absoluteStore);
  }
  return completedStore.canonicalRoot;
}

function ensureInsideRoot(projectRoot: string, absolutePath: string): void {
  if (!isSameOrChild(projectRoot, absolutePath)) {
    throw new Error(`path escapes project root: ${absolutePath}`);
  }
  // After open/stat, re-check realpath containment when resolvable.
  try {
    const real = realpathSync.native(absolutePath);
    if (!isSameOrChild(projectRoot, real) && !lstatSync(absolutePath).isSymbolicLink()) {
      throw new Error(`realpath escapes project root: ${absolutePath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('realpath escapes')) throw error;
    // Symlinks that cannot be fully resolved remain metadata-only later.
  }
}

function writeFlushed(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, 'wx');
  try {
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function blobPath(snapshotStore: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid SHA-256 blob hash');
  return join(snapshotStore, 'blobs', 'sha256', hash);
}

function baselineDirectory(snapshotStore: string, baselineId: string): string {
  return join(snapshotStore, 'baselines', validateIdentifier(baselineId, 'baselineId'));
}

function installBlob(snapshotStore: string, temporaryBlob: string, hash: string): void {
  const destination = blobPath(snapshotStore, hash);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    if (sha256(readFileSync(destination)) !== hash) {
      throw new Error(`existing content-addressed blob is corrupt: ${hash}`);
    }
    rmSync(temporaryBlob, { force: true });
    return;
  }
  try {
    renameSync(temporaryBlob, destination);
  } catch (error) {
    if (!existsSync(destination)) throw error;
    if (sha256(readFileSync(destination)) !== hash) throw error;
    rmSync(temporaryBlob, { force: true });
  }
}

function nonGitManifestChecksum(
  manifest: Omit<NonGitBaselineManifest, 'checksum'>,
): string {
  return sha256Json(manifest);
}

function completeNonGitManifest(
  snapshotStore: string,
  building: BuildingNonGitBaselineManifest,
  blobs: ReadonlyMap<string, Buffer>,
): NonGitBaselineManifest {
  validateIdentifier(building.baselineId, 'baselineId');
  const baselinesRoot = join(snapshotStore, 'baselines');
  mkdirSync(baselinesRoot, { recursive: true });
  const finalDirectory = baselineDirectory(snapshotStore, building.baselineId);
  if (existsSync(finalDirectory)) {
    throw new Error(`baseline already exists: ${building.baselineId}`);
  }
  const temporaryDirectory = join(
    baselinesRoot,
    `.tmp-${building.baselineId}-${randomUUID()}`,
  );
  mkdirSync(temporaryDirectory);
  try {
    writeFlushed(join(temporaryDirectory, 'building.json'), stableJson(building));
    const temporaryBlobs = join(temporaryDirectory, 'blobs');
    mkdirSync(temporaryBlobs);
    for (const [hash, content] of blobs) {
      if (sha256(content) !== hash) throw new Error(`blob hash mismatch before persistence: ${hash}`);
      const temporaryBlob = join(temporaryBlobs, hash);
      writeFlushed(temporaryBlob, content);
      installBlob(snapshotStore, temporaryBlob, hash);
    }
    rmSync(temporaryBlobs, { recursive: true, force: true });
    const completeWithoutChecksum: Omit<NonGitBaselineManifest, 'checksum'> = {
      ...building,
      status: 'complete',
    };
    const manifest: NonGitBaselineManifest = {
      ...completeWithoutChecksum,
      checksum: nonGitManifestChecksum(completeWithoutChecksum),
    };
    writeFlushed(join(temporaryDirectory, 'manifest.json'), stableJson(manifest));
    writeFlushed(join(temporaryDirectory, 'complete.marker'), `${manifest.checksum}\n`);
    rmSync(join(temporaryDirectory, 'building.json'));
    renameSync(temporaryDirectory, finalDirectory);
    return manifest;
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function version(entry: NonGitFileEntry | undefined): FileVersionSummary | null {
  if (entry === undefined) return null;
  return {
    hash: entry.hash,
    size: entry.size,
    type: entry.type,
    missing: entry.missing,
    contentCaptured: entry.contentCaptured,
  };
}

function change(
  kind: ChangeKind,
  path: string,
  before: NonGitFileEntry | undefined,
  after: NonGitFileEntry | undefined,
  fromPath?: string,
): FileChange {
  return {
    kind,
    path,
    ...(fromPath === undefined ? {} : { fromPath }),
    before: version(before),
    after: version(after),
    binary: Boolean(before?.binary || after?.binary),
  };
}

function entryChanged(before: NonGitFileEntry, after: NonGitFileEntry): boolean {
  return (
    before.hash !== after.hash ||
    before.size !== after.size ||
    before.executable !== after.executable ||
    before.linkTarget !== after.linkTarget ||
    before.contentCaptured !== after.contentCaptured ||
    before.contentExclusionReason !== after.contentExclusionReason
  );
}

function groupsByHash(changes: readonly FileChange[]): Map<string, FileChange[]> {
  const groups = new Map<string, FileChange[]>();
  for (const entry of changes) {
    const hash = entry.kind === 'deleted' ? entry.before?.hash : entry.after?.hash;
    if (hash === null || hash === undefined) continue;
    const group = groups.get(hash) ?? [];
    group.push(entry);
    groups.set(hash, group);
  }
  return groups;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSnapshots(
  baseline: NonGitBaselineManifest,
  current: NonGitCurrentSnapshot,
  label: NonGitChangeSet['label'],
): NonGitChangeSet {
  const beforeByPath = new Map(baseline.files.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(current.files.map((entry) => [entry.path, entry]));
  const allPaths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  const added: FileChange[] = [];
  const modified: FileChange[] = [];
  const deleted: FileChange[] = [];
  const typeChanged: FileChange[] = [];
  for (const path of [...allPaths].sort(comparePaths)) {
    const before = beforeByPath.get(path);
    const after = afterByPath.get(path);
    const beforePresent = before !== undefined && !before.missing;
    const afterPresent = after !== undefined && !after.missing;
    if (!beforePresent && !afterPresent) continue;
    if (!beforePresent && afterPresent) {
      added.push(change('added', path, before, after));
      continue;
    }
    if (beforePresent && !afterPresent) {
      deleted.push(change('deleted', path, before, after));
      continue;
    }
    if (before === undefined || after === undefined) continue;
    if (before.type !== after.type) {
      typeChanged.push(change('type-changed', path, before, after));
      continue;
    }
    if (entryChanged(before, after)) modified.push(change('modified', path, before, after));
  }

  const addedByHash = groupsByHash(added);
  const deletedByHash = groupsByHash(deleted);
  const renamed: FileChange[] = [];
  const renamedAdded = new Set<FileChange>();
  const renamedDeleted = new Set<FileChange>();
  for (const [hash, additions] of addedByHash) {
    const deletions = deletedByHash.get(hash);
    if (additions.length !== 1 || deletions?.length !== 1) continue;
    const addition = additions[0]!;
    const deletion = deletions[0]!;
    if (addition.after?.type !== deletion.before?.type) continue;
    renamed.push(
      change(
        'renamed',
        addition.path,
        beforeByPath.get(deletion.path),
        afterByPath.get(addition.path),
        deletion.path,
      ),
    );
    renamedAdded.add(addition);
    renamedDeleted.add(deletion);
  }
  const remainingAdded = added.filter((entry) => !renamedAdded.has(entry));
  const remainingDeleted = deleted.filter((entry) => !renamedDeleted.has(entry));
  const changes = [
    ...remainingAdded,
    ...modified,
    ...remainingDeleted,
    ...typeChanged,
    ...renamed,
  ].sort((left, right) => comparePaths(left.path, right.path));
  const sortedRenamed = renamed.sort((left, right) => comparePaths(left.path, right.path));
  return {
    label,
    baselineId: baseline.baselineId,
    changes,
    added: remainingAdded,
    modified,
    deleted: remainingDeleted,
    typeChanged,
    renamed: sortedRenamed,
    summary: {
      total: changes.length,
      added: remainingAdded.length,
      modified: modified.length,
      deleted: remainingDeleted.length,
      typeChanged: typeChanged.length,
      renamed: sortedRenamed.length,
      binary: changes.filter((entry) => entry.binary).length,
    },
  };
}

function loadNonGitManifest(
  snapshotStore: string,
  baselineId: string,
  expectedProjectRoot?: string,
): NonGitBaselineLoadResult {
  let directory: string;
  try {
    directory = baselineDirectory(snapshotStore, baselineId);
  } catch (error) {
    return { status: 'ignored', diagnostic: String(error) };
  }
  try {
    const markerPath = join(directory, 'complete.marker');
    const manifestPath = join(directory, 'manifest.json');
    if (!existsSync(markerPath) || !existsSync(manifestPath)) {
      return {
        status: 'ignored',
        diagnostic: 'baseline is missing its complete marker or manifest',
      };
    }
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as NonGitBaselineManifest;
    if (raw.status !== 'complete' || raw.version !== 1) {
      return { status: 'ignored', diagnostic: 'manifest version/status is invalid or not complete' };
    }
    if (raw.baselineId !== baselineId) {
      return { status: 'ignored', diagnostic: 'baseline identifier does not match its directory' };
    }
    const { checksum, ...withoutChecksum } = raw;
    const expectedChecksum = nonGitManifestChecksum(withoutChecksum);
    const marker = readFileSync(markerPath, 'utf8').trim();
    if (checksum !== expectedChecksum || marker !== expectedChecksum) {
      return { status: 'ignored', diagnostic: 'baseline manifest checksum mismatch' };
    }
    if (expectedProjectRoot !== undefined) {
      if (comparisonPath(expectedProjectRoot) !== comparisonPath(raw.project.canonicalRoot)) {
        return {
          status: 'ignored',
          diagnostic: 'baseline project root does not match expected project root',
        };
      }
    }
    for (const entry of raw.files) {
      if (entry.blobHash === null) continue;
      const contentPath = blobPath(snapshotStore, entry.blobHash);
      if (!existsSync(contentPath)) {
        return {
          status: 'ignored',
          diagnostic: `baseline content blob is missing or corrupt: ${entry.blobHash}`,
        };
      }
      const content = readFileSync(contentPath);
      if (sha256(content) !== entry.blobHash) {
        return {
          status: 'ignored',
          diagnostic: `baseline content blob is missing or corrupt: ${entry.blobHash}`,
        };
      }
    }
    return { status: 'loaded', manifest: raw };
  } catch (error) {
    return {
      status: 'ignored',
      diagnostic: `baseline recovery ignored invalid data: ${String(error)}`,
    };
  }
}

export class NonGitBaselineService {
  readonly #projectRoot: string;
  readonly #snapshotStore: string;
  readonly #maxReadAttempts: number;
  readonly #maxScanAttempts: number;
  readonly #maxContentBytes: number;
  readonly #hashChunkBytes: number;
  readonly #fileReadHook?: (relativePath: string, attempt: number) => void;

  public constructor(options: NonGitBaselineServiceOptions) {
    if (!isAbsolute(options.projectRoot) || !isAbsolute(options.snapshotStore)) {
      throw new Error('projectRoot and snapshotStore must be absolute');
    }
    const canonical = canonicalizeProjectPath(options.projectRoot, {
      reparseProbe: () => [],
    });
    this.#projectRoot = canonical.canonicalRoot;
    this.#snapshotStore = validateAndCreateSnapshotStore(
      this.#projectRoot,
      options.snapshotStore,
    );
    this.#maxReadAttempts = options.maxReadAttempts ?? 3;
    this.#maxScanAttempts = options.maxScanAttempts ?? 2;
    this.#maxContentBytes = options.maxContentBytes ?? 1_048_576;
    this.#hashChunkBytes = options.hashChunkBytes ?? 64 * 1024;
    this.#fileReadHook = options.fileReadHook;
    if (this.#maxReadAttempts < 1 || !Number.isInteger(this.#maxReadAttempts)) {
      throw new Error('maxReadAttempts must be a positive integer');
    }
    if (this.#maxScanAttempts < 1 || !Number.isInteger(this.#maxScanAttempts)) {
      throw new Error('maxScanAttempts must be a positive integer');
    }
    if (this.#maxContentBytes < 1 || !Number.isInteger(this.#maxContentBytes)) {
      throw new Error('maxContentBytes must be a positive integer');
    }
    if (this.#hashChunkBytes < 1 || !Number.isInteger(this.#hashChunkBytes)) {
      throw new Error('hashChunkBytes must be a positive integer');
    }
  }

  public get projectRoot(): string {
    return this.#projectRoot;
  }

  public get snapshotStore(): string {
    return this.#snapshotStore;
  }

  public captureTaskBaseline(input: CaptureTaskBaselineInput): NonGitBaselineManifest {
    return this.#capture({ ...input, kind: 'task' });
  }

  public captureAttemptBaseline(input: CaptureAttemptBaselineInput): NonGitBaselineManifest {
    if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) {
      throw new Error('attemptNumber must be a positive integer');
    }
    const parent = this.loadBaseline(input.parentTaskBaselineId);
    if (parent.status !== 'loaded' || parent.manifest.kind !== 'task') {
      throw new Error('attempt baseline requires a complete parent task baseline');
    }
    if (parent.manifest.taskId !== input.taskId) {
      throw new Error('attempt baseline taskId must match its parent task baseline');
    }
    return this.#capture({
      ...input,
      kind: 'attempt',
    });
  }

  public loadBaseline(baselineId: string): NonGitBaselineLoadResult {
    return loadNonGitManifest(this.#snapshotStore, baselineId, this.#projectRoot);
  }

  public readBlob(hash: string): Buffer {
    return readFileSync(blobPath(this.#snapshotStore, hash));
  }

  public scanCurrent(): NonGitCurrentSnapshot {
    let lastError: NonGitBaselineUnstableError | undefined;
    for (let attempt = 1; attempt <= this.#maxScanAttempts; attempt += 1) {
      try {
        return this.#scanCurrentAttempt();
      } catch (error) {
        if (!(error instanceof NonGitBaselineUnstableError)) throw error;
        lastError = error;
        if (attempt === this.#maxScanAttempts) throw error;
      }
    }
    throw (
      lastError ??
      new NonGitBaselineUnstableError('scan attempts were exhausted', 'maxScanAttempts exhausted')
    );
  }

  public diffAgainstBaseline(baselineId: string): NonGitChangeSet {
    const loaded = this.loadBaseline(baselineId);
    if (loaded.status !== 'loaded') {
      throw new Error(`baseline is unavailable: ${loaded.diagnostic}`);
    }
    const label =
      loaded.manifest.kind === 'attempt' ? 'attempt-window changes' : 'task-window changes';
    return compareSnapshots(loaded.manifest, this.scanCurrent(), label);
  }

  #capture(
    input: CaptureTaskBaselineInput & {
      readonly kind: NonGitBaselineKind;
      readonly attemptId?: string;
      readonly attemptNumber?: number;
      readonly parentTaskBaselineId?: string;
    },
  ): NonGitBaselineManifest {
    requireNonEmpty(input.taskId, 'taskId');
    requireNonEmpty(input.baselineId, 'baselineId');
    validateAndCreateSnapshotStore(this.#projectRoot, this.#snapshotStore);
    // Containment check before capture.
    ensureInsideRoot(this.#projectRoot, this.#projectRoot);
    const snapshot = this.scanCurrent();
    const building: BuildingNonGitBaselineManifest = {
      version: 1,
      status: 'building',
      kind: input.kind,
      taskId: input.taskId,
      baselineId: input.baselineId,
      ...(input.attemptId === undefined
        ? {}
        : { attemptId: requireNonEmpty(input.attemptId, 'attemptId') }),
      ...(input.attemptNumber === undefined ? {} : { attemptNumber: input.attemptNumber }),
      ...(input.parentTaskBaselineId === undefined
        ? {}
        : { parentTaskBaselineId: input.parentTaskBaselineId }),
      createdAt: (input.createdAt ?? new Date()).toISOString(),
      project: snapshot.project,
      files: snapshot.files,
      exclusions: snapshot.exclusions,
    };
    return completeNonGitManifest(this.#snapshotStore, building, snapshot.blobs);
  }

  #scanCurrentAttempt(): NonGitCurrentSnapshot {
    const discovered = this.#discoverRelativePaths();
    const files: NonGitFileEntry[] = [];
    const exclusions: NonGitExclusion[] = [];
    const blobs = new Map<string, Buffer>();
    const verificationKeys = new Map<string, string>();

    for (const relativePath of discovered) {
      const result = this.#scanFile(relativePath, true);
      verificationKeys.set(relativePath, result.verificationKey);
      if (result.entry !== undefined) files.push(result.entry);
      if (result.exclusion !== undefined) exclusions.push(result.exclusion);
      if (
        result.entry?.blobHash !== null &&
        result.entry?.blobHash !== undefined &&
        result.blob !== undefined
      ) {
        blobs.set(result.entry.blobHash, result.blob);
      }
    }

    // Second verification pass — fail closed on identity/stat/read changes.
    for (const relativePath of discovered) {
      const verified = this.#scanFile(relativePath, false);
      if (verified.verificationKey !== verificationKeys.get(relativePath)) {
        throw new NonGitBaselineUnstableError(
          `path changed between capture and verification pass: ${relativePath}`,
          `path=${relativePath}; before=${verificationKeys.get(relativePath) ?? ''}; after=${verified.verificationKey}`,
        );
      }
    }

    const rediscovered = this.#discoverRelativePaths();
    if (
      discovered.length !== rediscovered.length ||
      discovered.some((path, index) => path !== rediscovered[index])
    ) {
      throw new NonGitBaselineUnstableError(
        'project file set changed while building the baseline',
        `before=${discovered.join('|')}; after=${rediscovered.join('|')}`,
      );
    }

    return {
      project: {
        kind: 'directory',
        canonicalRoot: this.#projectRoot,
      },
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      exclusions: exclusions.sort((left, right) => left.path.localeCompare(right.path)),
      blobs,
    };
  }

  #discoverRelativePaths(): string[] {
    const results: string[] = [];
    const walk = (absoluteDirectory: string, relativeDirectory: string): void => {
      ensureInsideRoot(this.#projectRoot, absoluteDirectory);
      let dirStat: BigIntStats;
      try {
        dirStat = lstatSync(absoluteDirectory, { bigint: true });
      } catch (error) {
        if (isMissingError(error)) return;
        throw error;
      }
      if (dirStat.isSymbolicLink()) {
        // Directory symlink/junction at this node: record as a symlink path, do not follow.
        if (relativeDirectory.length > 0) {
          results.push(normalizeRelativePath(relativeDirectory));
        }
        return;
      }
      if (!dirStat.isDirectory()) return;

      let entries: string[];
      try {
        entries = readdirSync(absoluteDirectory);
      } catch (error) {
        if (isMissingError(error)) return;
        throw error;
      }
      for (const name of entries.sort((left, right) => left.localeCompare(right))) {
        if (name === '.' || name === '..') continue;
        const prune = shouldPruneDirectoryName(name);
        const childRelative =
          relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
        const normalizedChild = normalizeRelativePath(childRelative.replaceAll('\\', '/'));
        if (prune.prune || evaluateIgnorePath(normalizedChild).action === 'skip') {
          continue;
        }
        const childAbsolute = join(absoluteDirectory, name);
        ensureInsideRoot(this.#projectRoot, childAbsolute);
        let childStat: BigIntStats;
        try {
          childStat = lstatSync(childAbsolute, { bigint: true });
        } catch (error) {
          if (isMissingError(error)) continue;
          throw error;
        }
        if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
          walk(childAbsolute, normalizedChild);
          continue;
        }
        // Files, symlinks (file or dir), and other nodes are leaf discoveries.
        results.push(normalizedChild);
      }
    };
    walk(this.#projectRoot, '');
    return [...new Set(results)].sort((left, right) => left.localeCompare(right));
  }

  #scanFile(relativePathValue: string, invokeHook: boolean): FileScanResult {
    const relativePath = normalizeRelativePath(relativePathValue);
    if (evaluateIgnorePath(relativePath).action === 'skip') {
      return {
        exclusion: {
          path: relativePath,
          reason: 'policy-skip',
          evidence: `ignored by policy: ${evaluateIgnorePath(relativePath).reason}`,
        },
        verificationKey: `policy-skip:${relativePath}`,
      };
    }

    const components = relativePath.split('/');
    let current = this.#projectRoot;
    for (let index = 0; index < components.length - 1; index += 1) {
      current = join(current, components[index]!);
      ensureInsideRoot(this.#projectRoot, current);
      try {
        const stat = lstatSync(current, { bigint: true });
        if (stat.isSymbolicLink()) {
          const linkTarget = readlinkSync(current);
          return {
            exclusion: {
              path: relativePath,
              reason: 'ancestor-reparse-point',
              evidence: `ancestor ${components.slice(0, index + 1).join('/')} is a symbolic link or reparse point`,
            },
            verificationKey: `ancestor-reparse:${String(index)}:${statVerificationKey(signatureFromStat(stat))}:${linkTarget}`,
          };
        }
      } catch (error) {
        if (!isMissingError(error)) throw error;
        return {
          entry: {
            path: relativePath,
            type: 'other',
            size: 0,
            mtimeMs: null,
            ctimeMs: null,
            hash: null,
            blobHash: null,
            missing: true,
            executable: false,
            binary: false,
            contentCaptured: false,
          },
          verificationKey: 'missing',
        };
      }
    }

    const absolutePath = join(this.#projectRoot, ...components);
    ensureInsideRoot(this.#projectRoot, absolutePath);

    let stat: BigIntStats;
    try {
      stat = lstatSync(absolutePath, { bigint: true });
    } catch (error) {
      if (!isMissingError(error)) throw error;
      return {
        entry: {
          path: relativePath,
          type: 'other',
          size: 0,
          mtimeMs: null,
          ctimeMs: null,
          hash: null,
          blobHash: null,
          missing: true,
          executable: false,
          binary: false,
          contentCaptured: false,
        },
        verificationKey: 'missing',
      };
    }

    if (stat.isSymbolicLink()) {
      for (let attempt = 1; attempt <= this.#maxReadAttempts; attempt += 1) {
        const before = statSignature(absolutePath);
        const linkTarget = readlinkSync(absolutePath);
        const after = statSignature(absolutePath);
        if (!sameStat(before, after)) {
          if (attempt < this.#maxReadAttempts) continue;
          throw new NonGitBaselineUnstableError(
            `symbolic link changed while reading: ${relativePath}`,
            `path=${relativePath}`,
          );
        }
        // Record metadata only; never follow outside root / never capture target content.
        return {
          entry: {
            path: relativePath,
            type: 'symlink',
            size: Number(after.size),
            mtimeMs: toMs(after.mtimeNs),
            ctimeMs: toMs(after.ctimeNs),
            dev: String(after.dev),
            ino: String(after.ino),
            hash: null,
            blobHash: null,
            missing: false,
            executable: false,
            binary: false,
            contentCaptured: false,
            contentExclusionReason: 'symlink-not-followed',
            linkTarget,
            reparseEvidence: {
              kind: 'symbolic-link-or-reparse-point',
              linkTarget,
            },
          },
          verificationKey: `symlink:${statVerificationKey(after)}:${linkTarget}`,
        };
      }
      throw new NonGitBaselineUnstableError(
        `symbolic link remained unstable: ${relativePath}`,
        `path=${relativePath}`,
      );
    }

    if (stat.isDirectory()) {
      const signature = signatureFromStat(stat);
      return {
        entry: {
          path: relativePath,
          type: 'directory',
          size: 0,
          mtimeMs: toMs(signature.mtimeNs),
          ctimeMs: toMs(signature.ctimeNs),
          dev: String(signature.dev),
          ino: String(signature.ino),
          hash: null,
          blobHash: null,
          missing: false,
          executable: false,
          binary: false,
          contentCaptured: false,
        },
        verificationKey: `directory:${statVerificationKey(signature)}`,
      };
    }

    if (!stat.isFile()) {
      const signature = signatureFromStat(stat);
      return {
        exclusion: {
          path: relativePath,
          reason: 'unsupported-file-type',
          evidence: 'lstat did not report a regular file, directory, or symbolic link',
        },
        verificationKey: `other:${statVerificationKey(signature)}`,
      };
    }

    const size = Number(stat.size);
    if (size > this.#maxContentBytes) {
      for (let attempt = 1; attempt <= this.#maxReadAttempts; attempt += 1) {
        const before = signatureFromStat(stat);
        if (invokeHook) this.#fileReadHook?.(relativePath, attempt);
        const after = statSignature(absolutePath);
        if (!sameStat(before, after)) {
          if (attempt < this.#maxReadAttempts) {
            stat = lstatSync(absolutePath, { bigint: true });
            continue;
          }
          throw new NonGitBaselineUnstableError(
            `file remained unstable or changed while capturing metadata: ${relativePath}`,
            `path=${relativePath}`,
          );
        }
        return {
          entry: {
            path: relativePath,
            type: 'file',
            size: Number(after.size),
            mtimeMs: toMs(after.mtimeNs),
            ctimeMs: toMs(after.ctimeNs),
            dev: String(after.dev),
            ino: String(after.ino),
            hash: null,
            blobHash: null,
            missing: false,
            executable:
              process.platform === 'win32' ? false : (Number(after.mode) & 0o111) !== 0,
            binary: true,
            contentCaptured: false,
            contentExclusionReason: 'too-large',
          },
          verificationKey: `file-meta:${statVerificationKey(after)}:too-large`,
        };
      }
    }

    for (let attempt = 1; attempt <= this.#maxReadAttempts; attempt += 1) {
      let before: StableStat;
      let after: StableStat;
      let descriptor: number | undefined;
      let hash: string;
      let binary: boolean;
      let content: Buffer | undefined;
      try {
        before = statSignature(absolutePath);
        if (invokeHook) this.#fileReadHook?.(relativePath, attempt);
        const openFlags =
          process.platform === 'win32'
            ? constants.O_RDONLY
            : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
        descriptor = openSync(absolutePath, openFlags);
        const descriptorBefore = signatureFromStat(fstatSync(descriptor, { bigint: true }));
        if (!sameStat(before, descriptorBefore)) {
          closeSync(descriptor);
          descriptor = undefined;
          if (attempt < this.#maxReadAttempts) continue;
          throw new NonGitBaselineUnstableError(
            `file remained unstable or changed while opening: ${relativePath}`,
            `path=${relativePath}`,
          );
        }
        // Containment after open.
        ensureInsideRoot(this.#projectRoot, absolutePath);

        const hasher = createHash('sha256');
        const chunk = Buffer.alloc(Math.min(this.#hashChunkBytes, Math.max(1, Number(descriptorBefore.size) || 1)));
        let total = 0;
        const head = Buffer.alloc(0);
        const headChunks: Buffer[] = [];
        let headSize = 0;
        while (true) {
          const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          const slice = chunk.subarray(0, bytesRead);
          hasher.update(slice);
          total += bytesRead;
          if (headSize < 8_192) {
            const needed = Math.min(slice.length, 8_192 - headSize);
            headChunks.push(Buffer.from(slice.subarray(0, needed)));
            headSize += needed;
          }
        }
        void head;
        const descriptorAfter = signatureFromStat(fstatSync(descriptor, { bigint: true }));
        closeSync(descriptor);
        descriptor = undefined;
        after = statSignature(absolutePath);
        if (!sameStat(descriptorBefore, descriptorAfter) || !sameStat(before, after)) {
          if (attempt < this.#maxReadAttempts) continue;
          throw new NonGitBaselineUnstableError(
            `file remained unstable or changed while reading: ${relativePath}`,
            `path=${relativePath}`,
          );
        }
        if (BigInt(total) !== after.size) {
          if (attempt < this.#maxReadAttempts) continue;
          throw new NonGitBaselineUnstableError(
            `file remained unstable or changed while reading: ${relativePath}`,
            `path=${relativePath}; sizeMismatch`,
          );
        }
        hash = hasher.digest('hex');
        const headBuffer = Buffer.concat(headChunks);
        binary = isBinaryContent(headBuffer);
        // Persist content blob for captured files (bounded by maxContentBytes).
        // Re-read into a single buffer only when within policy — already enforced.
        content = readFileSync(absolutePath);
        if (sha256(content) !== hash || content.length !== total) {
          if (attempt < this.#maxReadAttempts) continue;
          throw new NonGitBaselineUnstableError(
            `file remained unstable or changed while reading: ${relativePath}`,
            `path=${relativePath}; hashMismatchOnReread`,
          );
        }
        const afterReread = statSignature(absolutePath);
        if (!sameStat(after, afterReread)) {
          if (attempt < this.#maxReadAttempts) continue;
          throw new NonGitBaselineUnstableError(
            `file remained unstable or changed while reading: ${relativePath}`,
            `path=${relativePath}; postReread`,
          );
        }
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        if (error instanceof NonGitBaselineUnstableError) throw error;
        if (isMissingError(error) && attempt < this.#maxReadAttempts) continue;
        if (isMissingError(error)) {
          throw new NonGitBaselineUnstableError(
            `file disappeared while reading: ${relativePath}`,
            `path=${relativePath}`,
            { cause: error },
          );
        }
        throw error;
      }

      return {
        entry: {
          path: relativePath,
          type: 'file',
          size: content!.length,
          mtimeMs: toMs(after!.mtimeNs),
          ctimeMs: toMs(after!.ctimeNs),
          dev: String(after!.dev),
          ino: String(after!.ino),
          hash: hash!,
          blobHash: hash!,
          missing: false,
          executable:
            process.platform === 'win32' ? false : (Number(after!.mode) & 0o111) !== 0,
          binary: binary!,
          contentCaptured: true,
        },
        blob: content,
        verificationKey: `file:${statVerificationKey(after!)}:${hash!}:${binary! ? 'binary' : 'text'}`,
      };
    }
    throw new NonGitBaselineUnstableError(
      `file remained unstable while reading: ${relativePath}`,
      `path=${relativePath}`,
    );
  }
}
