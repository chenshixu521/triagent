import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { GitRepositoryIdentity, GitStatusEntry } from './git-client.js';
import { isBinaryContent, sha256, sha256Json, stableJson } from './hash.js';

export type BaselineKind = 'task' | 'attempt';
export type BaselineFileType = 'file' | 'symlink' | 'directory' | 'other';

export interface BaselineFileEntry {
  readonly path: string;
  readonly type: BaselineFileType;
  readonly size: number;
  readonly mtimeMs: number | null;
  readonly hash: string | null;
  readonly blobHash: string | null;
  readonly missing: boolean;
  readonly executable: boolean;
  readonly binary: boolean;
  readonly tracked: boolean;
  readonly linkTarget?: string;
  readonly reparseEvidence?: {
    readonly kind: 'symbolic-link-or-reparse-point';
    readonly linkTarget: string;
  };
}

export interface BaselineExclusion {
  readonly path: string;
  readonly reason: 'ancestor-reparse-point' | 'unsupported-file-type';
  readonly evidence: string;
}

export interface BaselineManifest {
  readonly version: 1;
  readonly status: 'complete';
  readonly kind: BaselineKind;
  readonly taskId: string;
  readonly baselineId: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly parentTaskBaselineId?: string;
  readonly createdAt: string;
  readonly git: GitRepositoryIdentity & {
    readonly statusRaw: string;
    readonly statusEntries: readonly GitStatusEntry[];
  };
  readonly files: readonly BaselineFileEntry[];
  readonly exclusions: readonly BaselineExclusion[];
  readonly checksum: string;
}

export interface BuildingBaselineManifest
  extends Omit<BaselineManifest, 'status' | 'checksum'> {
  readonly status: 'building';
}

export type BaselineLoadResult =
  | { readonly status: 'loaded'; readonly manifest: BaselineManifest }
  | { readonly status: 'ignored'; readonly diagnostic: string };

export interface BaselineLoadExpectations {
  readonly expectedProjectRoot?: string;
  readonly baselineId?: string;
  readonly taskId?: string;
  readonly parentTaskBaselineId?: string;
  readonly kind?: BaselineKind;
}

function validateIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a filesystem-safe identifier`);
  }
  return value;
}

function validateRelativePath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('manifest file path is not a string');
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized !== value ||
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`manifest contains an unsafe relative path: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireMtime(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be null or a non-negative finite number`);
  }
  return value;
}

function requireHashOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be null or a SHA-256 hash`);
  }
  return value;
}

function comparisonRoot(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function validateStatusEntry(value: unknown): void {
  const entry = requireObject(value, 'git status entry');
  if (!new Set(['ordinary', 'renamed-or-copied', 'unmerged', 'untracked', 'ignored']).has(String(entry.recordType))) {
    throw new Error('git status entry has an invalid recordType');
  }
  validateRelativePath(entry.path);
  requireNonEmptyString(entry.raw, 'git status entry raw');
  if (entry.xy !== undefined && (typeof entry.xy !== 'string' || entry.xy.length !== 2)) {
    throw new Error('git status entry xy must be a two-character string');
  }
  if (entry.recordType === 'renamed-or-copied') {
    validateRelativePath(entry.originalPath);
  } else if (entry.originalPath !== undefined) {
    throw new Error('only renamed-or-copied status entries may have originalPath');
  }
}

function validateGitMetadata(value: unknown): void {
  const git = requireObject(value, 'manifest git metadata');
  const canonicalRoot = requireNonEmptyString(git.canonicalRoot, 'git canonicalRoot');
  if (!isAbsolute(canonicalRoot)) throw new Error('git canonicalRoot must be absolute');
  const realRoot = realpathSync.native(canonicalRoot);
  if (comparisonRoot(realRoot) !== comparisonRoot(canonicalRoot)) {
    throw new Error('git canonicalRoot is not canonical');
  }
  if (typeof git.headSha !== 'string' || !/^[0-9a-f]{40,64}$/.test(git.headSha)) {
    throw new Error('git headSha is invalid');
  }
  const detached = requireBoolean(git.detached, 'git detached');
  if (git.branch !== null && (typeof git.branch !== 'string' || git.branch.trim().length === 0)) {
    throw new Error('git branch must be null or a non-empty string');
  }
  if (detached !== (git.branch === null)) {
    throw new Error('git branch and detached metadata disagree');
  }
  if (typeof git.statusRaw !== 'string') throw new Error('git statusRaw must be a string');
  if (!Array.isArray(git.statusEntries)) throw new Error('git statusEntries must be an array');
  git.statusEntries.forEach(validateStatusEntry);
}

function validateFileEntry(value: unknown): void {
  const file = requireObject(value, 'manifest file entry');
  validateRelativePath(file.path);
  const type = file.type;
  if (!new Set(['file', 'symlink', 'directory', 'other']).has(String(type))) {
    throw new Error('manifest file entry has an invalid type');
  }
  const size = requireNonNegativeSafeInteger(file.size, 'file size');
  const mtimeMs = requireMtime(file.mtimeMs, 'file mtimeMs');
  const hash = requireHashOrNull(file.hash, 'file hash');
  const blobHash = requireHashOrNull(file.blobHash, 'file blobHash');
  const missing = requireBoolean(file.missing, 'file missing');
  const executable = requireBoolean(file.executable, 'file executable');
  const binary = requireBoolean(file.binary, 'file binary');
  requireBoolean(file.tracked, 'file tracked');
  if (hash !== blobHash) throw new Error('manifest file hash and blob hash disagree');

  if (missing) {
    if (
      type !== 'other' ||
      size !== 0 ||
      mtimeMs !== null ||
      hash !== null ||
      executable ||
      binary ||
      file.linkTarget !== undefined ||
      file.reparseEvidence !== undefined
    ) {
      throw new Error('missing file entry has inconsistent metadata');
    }
    return;
  }
  if (mtimeMs === null) throw new Error('present file entry requires mtimeMs');
  if (type === 'file') {
    if (hash === null || file.linkTarget !== undefined || file.reparseEvidence !== undefined) {
      throw new Error('regular file entry has inconsistent content metadata');
    }
    return;
  }
  if (type === 'symlink') {
    const linkTarget = requireNonEmptyString(file.linkTarget, 'symlink linkTarget');
    const evidence = requireObject(file.reparseEvidence, 'symlink reparseEvidence');
    if (
      hash === null ||
      executable ||
      binary ||
      evidence.kind !== 'symbolic-link-or-reparse-point' ||
      evidence.linkTarget !== linkTarget
    ) {
      throw new Error('symlink file entry has inconsistent metadata');
    }
    return;
  }
  if (type === 'directory') {
    if (
      size !== 0 ||
      hash !== null ||
      executable ||
      binary ||
      file.linkTarget !== undefined ||
      file.reparseEvidence !== undefined
    ) {
      throw new Error('directory file entry has inconsistent metadata');
    }
    return;
  }
  throw new Error('present other file type is not supported');
}

function validateExclusion(value: unknown): void {
  const exclusion = requireObject(value, 'manifest exclusion');
  validateRelativePath(exclusion.path);
  if (!new Set(['ancestor-reparse-point', 'unsupported-file-type']).has(String(exclusion.reason))) {
    throw new Error('manifest exclusion has an invalid reason');
  }
  requireNonEmptyString(exclusion.evidence, 'manifest exclusion evidence');
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

function withoutChecksum(manifest: BaselineManifest): Omit<BaselineManifest, 'checksum'> {
  const { checksum: _checksum, ...rest } = manifest;
  return rest;
}

export function baselineManifestChecksum(
  manifest: Omit<BaselineManifest, 'checksum'>,
): string {
  return sha256Json(manifest);
}

export function baselineDirectory(snapshotStore: string, baselineId: string): string {
  return join(snapshotStore, 'baselines', validateIdentifier(baselineId, 'baselineId'));
}

export function blobPath(snapshotStore: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid SHA-256 blob hash');
  return join(snapshotStore, 'blobs', 'sha256', hash);
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

export function completeBaselineManifest(
  snapshotStore: string,
  building: BuildingBaselineManifest,
  blobs: ReadonlyMap<string, Buffer>,
): BaselineManifest {
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
    const completeWithoutChecksum: Omit<BaselineManifest, 'checksum'> = {
      ...building,
      status: 'complete',
    };
    const manifest: BaselineManifest = {
      ...completeWithoutChecksum,
      checksum: baselineManifestChecksum(completeWithoutChecksum),
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

/**
 * Canonical baseline manifest shape validation used by tracking services and
 * startup reconcile. Validates every file/exclusion/git entry, paths, hashes,
 * kinds, and required identity fields.
 */
export function validateManifestShape(value: unknown): BaselineManifest {
  const candidate = requireObject(value, 'manifest');
  if (candidate.version !== 1 || candidate.status !== 'complete') {
    throw new Error('manifest version/status is invalid or not complete');
  }
  if (candidate.kind !== 'task' && candidate.kind !== 'attempt') {
    throw new Error('manifest kind must be task or attempt');
  }
  const taskId = requireNonEmptyString(candidate.taskId, 'taskId');
  const baselineId = validateIdentifier(
    requireNonEmptyString(candidate.baselineId, 'baselineId'),
    'baselineId',
  );
  if (typeof candidate.createdAt !== 'string') throw new Error('createdAt must be a string');
  const createdAt = new Date(candidate.createdAt);
  if (Number.isNaN(createdAt.valueOf()) || createdAt.toISOString() !== candidate.createdAt) {
    throw new Error('createdAt must be a canonical ISO timestamp');
  }
  if (typeof candidate.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.checksum)) {
    throw new Error('manifest checksum must be a SHA-256 hash');
  }
  validateGitMetadata(candidate.git);
  if (!Array.isArray(candidate.files)) throw new Error('manifest files must be an array');
  candidate.files.forEach(validateFileEntry);
  const paths = candidate.files.map((entry) => (entry as Record<string, unknown>).path);
  if (new Set(paths).size !== paths.length) throw new Error('manifest contains duplicate file paths');
  if (!Array.isArray(candidate.exclusions)) throw new Error('manifest exclusions must be an array');
  candidate.exclusions.forEach(validateExclusion);

  if (candidate.kind === 'task') {
    if (
      candidate.attemptId !== undefined ||
      candidate.attemptNumber !== undefined ||
      candidate.parentTaskBaselineId !== undefined
    ) {
      throw new Error('task manifest must not contain attempt-only fields');
    }
  } else {
    requireNonEmptyString(candidate.attemptId, 'attemptId');
    if (
      typeof candidate.attemptNumber !== 'number' ||
      !Number.isSafeInteger(candidate.attemptNumber) ||
      candidate.attemptNumber < 1
    ) {
      throw new Error('attemptNumber must be a positive safe integer');
    }
    const parent = validateIdentifier(
      requireNonEmptyString(candidate.parentTaskBaselineId, 'parentTaskBaselineId'),
      'parentTaskBaselineId',
    );
    if (parent === baselineId) throw new Error('attempt baseline cannot be its own parent');
  }
  void taskId;
  return candidate as unknown as BaselineManifest;
}

/**
 * Parse stored manifest JSON through the canonical validator, recompute the
 * checksum, and reject forged or mismatched hashes. Optional identity checks
 * bind the manifest to the expected task/attempt/baseline row.
 */
export function parseAndVerifyBaselineManifest(
  value: unknown,
  expected: {
    readonly baselineId?: string;
    readonly taskId?: string;
    readonly attemptId?: string;
    readonly kind?: BaselineKind;
  } = {},
): BaselineManifest {
  const manifest = validateManifestShape(value);
  const expectedChecksum = baselineManifestChecksum(withoutChecksum(manifest));
  if (manifest.checksum !== expectedChecksum) {
    throw new Error('baseline manifest checksum mismatch');
  }
  if (expected.baselineId !== undefined && manifest.baselineId !== expected.baselineId) {
    throw new Error('baseline identity does not match expected baselineId');
  }
  if (expected.taskId !== undefined && manifest.taskId !== expected.taskId) {
    throw new Error('baseline identity does not match expected taskId');
  }
  if (expected.kind !== undefined && manifest.kind !== expected.kind) {
    throw new Error('baseline kind does not match expected kind');
  }
  if (expected.attemptId !== undefined) {
    if (manifest.kind !== 'attempt' || manifest.attemptId !== expected.attemptId) {
      throw new Error('baseline identity does not match expected attemptId');
    }
  }
  return manifest;
}

export function loadBaselineManifest(
  snapshotStore: string,
  baselineId: string,
  expected: BaselineLoadExpectations = {},
): BaselineLoadResult {
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
      return { status: 'ignored', diagnostic: 'baseline is missing its complete marker or manifest' };
    }
    const manifest = validateManifestShape(JSON.parse(readFileSync(manifestPath, 'utf8')));
    if (manifest.baselineId !== baselineId) {
      return { status: 'ignored', diagnostic: 'baseline identifier does not match its directory' };
    }
    const expectedChecksum = baselineManifestChecksum(withoutChecksum(manifest));
    const marker = readFileSync(markerPath, 'utf8').trim();
    if (manifest.checksum !== expectedChecksum || marker !== expectedChecksum) {
      return { status: 'ignored', diagnostic: 'baseline manifest checksum mismatch' };
    }
    if (expected.baselineId !== undefined && manifest.baselineId !== expected.baselineId) {
      return { status: 'ignored', diagnostic: 'baseline identity does not match expected baselineId' };
    }
    if (expected.taskId !== undefined && manifest.taskId !== expected.taskId) {
      return { status: 'ignored', diagnostic: 'baseline identity does not match expected taskId' };
    }
    if (expected.kind !== undefined && manifest.kind !== expected.kind) {
      return { status: 'ignored', diagnostic: 'baseline kind does not match expected kind' };
    }
    if (
      expected.parentTaskBaselineId !== undefined &&
      manifest.parentTaskBaselineId !== expected.parentTaskBaselineId
    ) {
      return {
        status: 'ignored',
        diagnostic: 'baseline identity does not match expected parentTaskBaselineId',
      };
    }
    if (expected.expectedProjectRoot !== undefined) {
      if (!isAbsolute(expected.expectedProjectRoot)) {
        return { status: 'ignored', diagnostic: 'expected project root must be absolute' };
      }
      const expectedRoot = realpathSync.native(expected.expectedProjectRoot);
      if (comparisonRoot(expectedRoot) !== comparisonRoot(manifest.git.canonicalRoot)) {
        return { status: 'ignored', diagnostic: 'baseline project root does not match expected project root' };
      }
    }
    const blobCache = new Map<string, Buffer>();
    for (const entry of manifest.files) {
      if (entry.blobHash === null) continue;
      let content = blobCache.get(entry.blobHash);
      if (content === undefined) {
        const contentPath = blobPath(snapshotStore, entry.blobHash);
        if (!existsSync(contentPath)) {
          return {
            status: 'ignored',
            diagnostic: `baseline content blob is missing or corrupt: ${entry.blobHash}`,
          };
        }
        content = readFileSync(contentPath);
        if (sha256(content) !== entry.blobHash) {
          return {
            status: 'ignored',
            diagnostic: `baseline content blob is missing or corrupt: ${entry.blobHash}`,
          };
        }
        blobCache.set(entry.blobHash, content);
      }
      if (entry.size !== content.length) {
        return {
          status: 'ignored',
          diagnostic: `baseline file size does not match its content blob: ${entry.path}`,
        };
      }
      if (entry.type === 'file' && entry.binary !== isBinaryContent(content)) {
        return {
          status: 'ignored',
          diagnostic: `baseline file binary classification does not match its content blob: ${entry.path}`,
        };
      }
      if (entry.type === 'symlink') {
        const linkTarget = content.toString('utf8');
        if (!Buffer.from(linkTarget, 'utf8').equals(content) || linkTarget !== entry.linkTarget) {
          return {
            status: 'ignored',
            diagnostic: `baseline symlink linkTarget does not match its UTF-8 content blob: ${entry.path}`,
          };
        }
      }
    }
    if (manifest.kind === 'attempt') {
      const parent = loadBaselineManifest(snapshotStore, manifest.parentTaskBaselineId!, {
        expectedProjectRoot: manifest.git.canonicalRoot,
        baselineId: manifest.parentTaskBaselineId,
        taskId: manifest.taskId,
        kind: 'task',
      });
      if (parent.status !== 'loaded') {
        return {
          status: 'ignored',
          diagnostic: `attempt parent task baseline identity is invalid: ${parent.diagnostic}`,
        };
      }
    }
    return { status: 'loaded', manifest };
  } catch (error) {
    return { status: 'ignored', diagnostic: `baseline recovery ignored invalid data: ${String(error)}` };
  }
}
