import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { canonicalizeProjectPath } from '../project/canonical-path.js';

import {
  blobPath,
  completeBaselineManifest,
  loadBaselineManifest,
  type BaselineExclusion,
  type BaselineFileEntry,
  type BaselineLoadResult,
  type BaselineLoadExpectations,
  type BaselineManifest,
  type BuildingBaselineManifest,
} from './baseline-manifest.js';
import {
  GitClient,
  normalizeGitRelativePath,
  type GitClientOptions,
  type GitRepositoryIdentity,
  type GitStatusSnapshot,
} from './git-client.js';
import { isBinaryContent, sha256 } from './hash.js';

export interface GitBaselineServiceOptions {
  readonly projectRoot: string;
  readonly snapshotStore: string;
  readonly gitClient?: GitClient;
  readonly gitClientOptions?: GitClientOptions;
  readonly maxReadAttempts?: number;
  readonly maxScanAttempts?: number;
  readonly fileReadHook?: (relativePath: string, attempt: number) => void;
}

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

export interface CurrentSnapshot {
  readonly git: GitRepositoryIdentity & {
    readonly statusRaw: string;
    readonly statusEntries: GitStatusSnapshot['entries'];
  };
  readonly files: readonly BaselineFileEntry[];
  readonly exclusions: readonly BaselineExclusion[];
  readonly blobs: ReadonlyMap<string, Buffer>;
}

export class SnapshotStoreInsideProject extends Error {
  public override readonly name = 'SnapshotStoreInsideProject';

  public constructor(path: string) {
    super(`SnapshotStoreInsideProject: snapshot store must be outside the canonical project root: ${path}`);
  }
}

export class ReparseEscape extends Error {
  public override readonly name = 'ReparseEscape';

  public constructor(path: string) {
    super(`ReparseEscape: snapshot store reparse resolution enters the canonical project root: ${path}`);
  }
}

interface FileScanResult {
  readonly entry?: BaselineFileEntry;
  readonly exclusion?: BaselineExclusion;
  readonly blob?: Buffer;
  readonly verificationKey: string;
}

interface StableStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

function sameStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function toMtimeMs(signature: StableStat): number {
  return Number(signature.mtimeNs) / 1_000_000;
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

class WorkingTreeUnstableError extends Error {
  public override readonly name = 'WorkingTreeUnstableError';

  public constructor(message: string, options?: ErrorOptions) {
    super(`working tree whole scan verification failed: ${message}`, options);
  }
}

function isSameOrChild(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath.length === 0 ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
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

export class GitBaselineService {
  readonly #projectRoot: string;
  readonly #snapshotStore: string;
  readonly #gitClient: GitClient;
  readonly #maxReadAttempts: number;
  readonly #maxScanAttempts: number;
  readonly #fileReadHook?: (relativePath: string, attempt: number) => void;

  public constructor(options: GitBaselineServiceOptions) {
    if (!isAbsolute(options.projectRoot) || !isAbsolute(options.snapshotStore)) {
      throw new Error('projectRoot and snapshotStore must be absolute');
    }
    this.#gitClient =
      options.gitClient ?? new GitClient(options.projectRoot, options.gitClientOptions);
    this.#projectRoot = this.#gitClient.projectRoot;
    this.#snapshotStore = validateAndCreateSnapshotStore(
      this.#projectRoot,
      options.snapshotStore,
    );
    this.#maxReadAttempts = options.maxReadAttempts ?? 3;
    this.#maxScanAttempts = options.maxScanAttempts ?? 2;
    this.#fileReadHook = options.fileReadHook;
    if (this.#maxReadAttempts < 1 || !Number.isInteger(this.#maxReadAttempts)) {
      throw new Error('maxReadAttempts must be a positive integer');
    }
    if (this.#maxScanAttempts < 1 || !Number.isInteger(this.#maxScanAttempts)) {
      throw new Error('maxScanAttempts must be a positive integer');
    }
  }

  public get projectRoot(): string {
    return this.#projectRoot;
  }

  public get snapshotStore(): string {
    return this.#snapshotStore;
  }

  public get gitClient(): GitClient {
    return this.#gitClient;
  }

  public captureTaskBaseline(input: CaptureTaskBaselineInput): BaselineManifest {
    return this.#capture({
      ...input,
      kind: 'task',
    });
  }

  public captureAttemptBaseline(input: CaptureAttemptBaselineInput): BaselineManifest {
    if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) {
      throw new Error('attemptNumber must be a positive integer');
    }
    const parent = this.loadBaseline(input.parentTaskBaselineId, {
      taskId: input.taskId,
      kind: 'task',
    });
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

  public loadBaseline(
    baselineId: string,
    expected: Omit<BaselineLoadExpectations, 'expectedProjectRoot' | 'baselineId'> = {},
  ): BaselineLoadResult {
    return loadBaselineManifest(this.#snapshotStore, baselineId, {
      ...expected,
      expectedProjectRoot: this.#projectRoot,
      baselineId,
    });
  }

  public readBlob(hash: string): Buffer {
    return readFileSync(blobPath(this.#snapshotStore, hash));
  }

  public scanCurrent(): CurrentSnapshot {
    let lastUnstableError: WorkingTreeUnstableError | undefined;
    for (let attempt = 1; attempt <= this.#maxScanAttempts; attempt += 1) {
      try {
        return this.#scanCurrentAttempt();
      } catch (error) {
        if (!(error instanceof WorkingTreeUnstableError)) throw error;
        lastUnstableError = error;
        if (attempt === this.#maxScanAttempts) throw error;
      }
    }
    throw lastUnstableError ?? new WorkingTreeUnstableError('scan attempts were exhausted');
  }

  #scanCurrentAttempt(): CurrentSnapshot {
    const identity = this.#gitClient.repositoryIdentity();
    const initialStatus = this.#gitClient.status();
    const initialPaths = [...this.#gitClient.listFiles()].sort();
    const tracked = this.#gitClient.listTrackedFiles();
    const files: BaselineFileEntry[] = [];
    const exclusions: BaselineExclusion[] = [];
    const blobs = new Map<string, Buffer>();
    const verificationKeys = new Map<string, string>();
    for (const relativePath of initialPaths) {
      const result = this.#scanFile(relativePath, tracked.has(relativePath), true);
      verificationKeys.set(relativePath, result.verificationKey);
      if (result.entry !== undefined) files.push(result.entry);
      if (result.exclusion !== undefined) exclusions.push(result.exclusion);
      if (result.entry?.blobHash !== null && result.entry?.blobHash !== undefined && result.blob !== undefined) {
        blobs.set(result.entry.blobHash, result.blob);
      }
    }
    for (const relativePath of initialPaths) {
      const verified = this.#scanFile(relativePath, tracked.has(relativePath), false);
      if (verified.verificationKey !== verificationKeys.get(relativePath)) {
        throw new WorkingTreeUnstableError(
          `path changed between capture and verification pass: ${relativePath}`,
        );
      }
    }
    const finalPaths = [...this.#gitClient.listFiles()].sort();
    const finalStatus = this.#gitClient.status();
    if (!sameStringArrays(initialPaths, finalPaths) || initialStatus.raw !== finalStatus.raw) {
      throw new WorkingTreeUnstableError(
        'Git paths or porcelain status changed while building the baseline',
      );
    }
    return {
      git: {
        ...identity,
        statusRaw: initialStatus.raw,
        statusEntries: initialStatus.entries,
      },
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      exclusions: exclusions.sort((left, right) => left.path.localeCompare(right.path)),
      blobs,
    };
  }

  #capture(
    input: CaptureTaskBaselineInput & {
      readonly kind: 'task' | 'attempt';
      readonly attemptId?: string;
      readonly attemptNumber?: number;
      readonly parentTaskBaselineId?: string;
    },
  ): BaselineManifest {
    requireNonEmpty(input.taskId, 'taskId');
    requireNonEmpty(input.baselineId, 'baselineId');
    validateAndCreateSnapshotStore(this.#projectRoot, this.#snapshotStore);
    const snapshot = this.scanCurrent();
    const building: BuildingBaselineManifest = {
      version: 1,
      status: 'building',
      kind: input.kind,
      taskId: input.taskId,
      baselineId: input.baselineId,
      ...(input.attemptId === undefined ? {} : { attemptId: requireNonEmpty(input.attemptId, 'attemptId') }),
      ...(input.attemptNumber === undefined ? {} : { attemptNumber: input.attemptNumber }),
      ...(input.parentTaskBaselineId === undefined
        ? {}
        : { parentTaskBaselineId: input.parentTaskBaselineId }),
      createdAt: (input.createdAt ?? new Date()).toISOString(),
      git: snapshot.git,
      files: snapshot.files,
      exclusions: snapshot.exclusions,
    };
    return completeBaselineManifest(this.#snapshotStore, building, snapshot.blobs);
  }

  #scanFile(
    relativePathValue: string,
    tracked: boolean,
    invokeHook: boolean,
  ): FileScanResult {
    const relativePath = normalizeGitRelativePath(relativePathValue);
    const components = relativePath.split('/');
    let current = this.#projectRoot;
    for (let index = 0; index < components.length - 1; index += 1) {
      current = join(current, components[index]!);
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
            hash: null,
            blobHash: null,
            missing: true,
            executable: false,
            binary: false,
            tracked,
          },
          verificationKey: 'missing',
        };
      }
    }
    const absolutePath = join(this.#projectRoot, ...components);
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
          hash: null,
          blobHash: null,
          missing: true,
          executable: false,
          binary: false,
          tracked,
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
          throw new WorkingTreeUnstableError(`symbolic link changed while reading: ${relativePath}`);
        }
        const content = Buffer.from(linkTarget, 'utf8');
        const hash = sha256(content);
        return {
          entry: {
            path: relativePath,
            type: 'symlink',
            size: content.length,
            mtimeMs: toMtimeMs(after),
            hash,
            blobHash: hash,
            missing: false,
            executable: false,
            binary: false,
            tracked,
            linkTarget,
            reparseEvidence: {
              kind: 'symbolic-link-or-reparse-point',
              linkTarget,
            },
          },
          blob: content,
          verificationKey: `symlink:${statVerificationKey(after)}:${hash}:${linkTarget}`,
        };
      }
      throw new WorkingTreeUnstableError(`symbolic link remained unstable: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      const signature = signatureFromStat(stat);
      return {
        entry: {
          path: relativePath,
          type: 'directory',
          size: 0,
          mtimeMs: toMtimeMs(signature),
          hash: null,
          blobHash: null,
          missing: false,
          executable: false,
          binary: false,
          tracked,
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
    for (let attempt = 1; attempt <= this.#maxReadAttempts; attempt += 1) {
      let before: StableStat;
      let content: Buffer;
      let after: StableStat;
      let descriptor: number | undefined;
      try {
        before = statSignature(absolutePath);
        if (invokeHook) this.#fileReadHook?.(relativePath, attempt);
        descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const descriptorBefore = signatureFromStat(fstatSync(descriptor, { bigint: true }));
        if (!sameStat(before, descriptorBefore)) {
          closeSync(descriptor);
          descriptor = undefined;
          if (attempt < this.#maxReadAttempts) continue;
          throw new WorkingTreeUnstableError(
            `file remained unstable or changed while opening: ${relativePath}`,
          );
        }
        content = readFileSync(descriptor);
        const descriptorAfter = signatureFromStat(fstatSync(descriptor, { bigint: true }));
        closeSync(descriptor);
        descriptor = undefined;
        after = statSignature(absolutePath);
        if (!sameStat(descriptorBefore, descriptorAfter)) {
          if (attempt < this.#maxReadAttempts) continue;
          throw new WorkingTreeUnstableError(
            `file remained unstable or changed while reading: ${relativePath}`,
          );
        }
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        if (isMissingError(error) && attempt < this.#maxReadAttempts) continue;
        if (isMissingError(error)) {
          throw new WorkingTreeUnstableError(`file disappeared while reading: ${relativePath}`, {
            cause: error,
          });
        }
        throw error;
      }
      if (!sameStat(before, after) || BigInt(content.length) !== after.size) {
        if (attempt < this.#maxReadAttempts) continue;
        throw new WorkingTreeUnstableError(
          `file remained unstable or changed while reading: ${relativePath}`,
        );
      }
      const hash = sha256(content);
      const binary = isBinaryContent(content);
      return {
        entry: {
          path: relativePath,
          type: 'file',
          size: content.length,
          mtimeMs: toMtimeMs(after),
          hash,
          blobHash: hash,
          missing: false,
          executable: process.platform === 'win32' ? false : (Number(after.mode) & 0o111) !== 0,
          binary,
          tracked,
        },
        blob: content,
        verificationKey: `file:${statVerificationKey(after)}:${hash}:${binary ? 'binary' : 'text'}`,
      };
    }
    throw new WorkingTreeUnstableError(`file remained unstable while reading: ${relativePath}`);
  }
}
