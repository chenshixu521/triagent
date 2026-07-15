import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { AppPaths } from '../config/app-paths.js';
import { evaluateIgnorePath } from '../tracking/ignore-policy.js';
import { sha256, sha256Json } from '../tracking/hash.js';
import type {
  BaselineTrackerPort,
  TrackingBaselineManifest,
  TrackingFileEntry,
} from '../tracking/tracking-port.js';

import { ImplementationWorkspaceRepository } from './implementation-workspace-repository.js';
import type {
  CandidateManifest,
  CandidateManifestFile,
  ImplementationWorkspaceRecord,
  MaterializeImplementationWorkspaceInput,
  MaterializeImplementationWorkspaceResult,
} from './implementation-workspace-types.js';

export interface ImplementationWorkspaceServiceOptions {
  readonly database: DatabaseSync;
  readonly paths: AppPaths;
  readonly tracker: BaselineTrackerPort;
}

/** Default retention for rejected/cancelled/abandoned candidate workspaces. */
export const DEFAULT_WORKSPACE_RETENTION_HOURS = 24;

export type WorkspaceRecoveryAction =
  | 'none'
  | 'cleanup_incomplete'
  | 'await_launch'
  | 'do_not_replay'
  | 'inspect'
  | 'resume_review'
  | 'allow_promotion'
  | 'require_audited_cancel'
  | 'cleanup_eligible'
  | 'cleanup_after_retention';

export interface WorkspaceRecoveryDecision {
  readonly workspaceId: string;
  readonly action: WorkspaceRecoveryAction;
  readonly reason: string;
  readonly record?: ImplementationWorkspaceRecord;
}

export interface WorkspaceHousekeepReport {
  readonly nowIso: string;
  readonly deleted: readonly string[];
  readonly skipped: readonly {
    readonly workspaceId: string;
    readonly reason: string;
  }[];
  readonly preservedEvidenceRoots: readonly string[];
}

const DEFAULT_RETENTION_HOURS = DEFAULT_WORKSPACE_RETENTION_HOURS;

function retentionDeadline(nowIso: string, hours: number): string {
  const base = Date.parse(nowIso);
  if (!Number.isFinite(base)) throw new Error('nowIso must be a valid ISO timestamp');
  return new Date(base + hours * 60 * 60 * 1000).toISOString();
}

/**
 * Tracker-free housekeeping used by startup reconcile and the workspace service.
 * Never deletes recovery_required or promoting rows.
 */
export function housekeepImplementationWorkspaces(
  repository: ImplementationWorkspaceRepository,
  nowIso: string,
): WorkspaceHousekeepReport {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error('nowIso must be a valid ISO timestamp');
  }
  const deleted: string[] = [];
  const skipped: Array<{ readonly workspaceId: string; readonly reason: string }> = [];
  const preservedEvidence: string[] = [];

  for (const record of repository.listAll()) {
    if (record.status === 'recovery_required') {
      skipped.push({
        workspaceId: record.workspaceId,
        reason: 'recovery_required never auto-deleted',
      });
      continue;
    }
    if (record.status === 'promoting') {
      skipped.push({
        workspaceId: record.workspaceId,
        reason: 'uncertain promotion never auto-cleaned',
      });
      continue;
    }

    const eligibleStatus =
      record.status === 'promoted'
      || record.status === 'abandoned'
      || record.status === 'rejected';
    if (!eligibleStatus) {
      skipped.push({
        workspaceId: record.workspaceId,
        reason: `status ${record.status} not eligible for automatic cleanup`,
      });
      continue;
    }

    if (record.status !== 'promoted') {
      if (record.retainedUntil === null) {
        skipped.push({
          workspaceId: record.workspaceId,
          reason: 'retention deadline not set',
        });
        continue;
      }
      const until = Date.parse(record.retainedUntil);
      if (!Number.isFinite(until) || until > nowMs) {
        skipped.push({
          workspaceId: record.workspaceId,
          reason: 'retention window still active',
        });
        continue;
      }
    }

    preservedEvidence.push(record.workspaceRoot);
    cleanupWorkspaceTree(record.workspaceRoot);
    repository.delete(record.workspaceId);
    PROTECTED_MEMORY.delete(record.workspaceId);
    deleted.push(record.workspaceId);
  }

  return Object.freeze({
    nowIso,
    deleted: Object.freeze([...deleted]),
    skipped: Object.freeze([...skipped]),
    preservedEvidenceRoots: Object.freeze([...preservedEvidence]),
  });
}

function cleanupWorkspaceTree(workspaceRoot: string): void {
  try {
    if (existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
    const attemptDir = dirname(workspaceRoot);
    for (const name of [
      'change-set.json',
      'review-bundle.json',
      'candidate-manifest.json',
    ]) {
      const sidecar = join(attemptDir, name);
      if (existsSync(sidecar)) rmSync(sidecar, { force: true });
    }
    try {
      const remaining = readdirSync(attemptDir);
      if (remaining.length === 0) {
        rmSync(attemptDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  } catch {
    // best-effort
  }
}

const ALWAYS_EXCLUDE_REASONS = new Set([
  'node_modules',
  'vcs-internal',
  'app-storage',
  'temp-cache',
  'build-output',
  'snapshot-destination',
]);

const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(?:\..+)?$/i,
  /^id_rsa$/i,
  /^id_dsa$/i,
  /^id_ecdsa$/i,
  /^id_ed25519$/i,
  /^.*\.pem$/i,
  /^.*\.p12$/i,
  /^.*\.pfx$/i,
  /^.*\.key$/i,
  /^credentials\.json$/i,
  /^service-account(?:[-_].+)?\.json$/i,
  /^.*secret.*$/i,
  /^.*credential.*$/i,
];

const PROTECTED_MEMORY = new Map<string, ReadonlySet<string>>();

function comparisonPath(value: string): string {
  const normalized = resolve(value).replaceAll('/', '\\');
  return process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function posixRelative(value: string): string {
  return value.replaceAll('\\', '/');
}

function requireAbsolute(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must be non-empty`);
  if (!isAbsolute(trimmed)) throw new Error(`${label} must be absolute`);
  return resolve(trimmed);
}

function isSecretRelativePath(relativePath: string): boolean {
  const normalized = posixRelative(relativePath);
  const base = normalized.split('/').at(-1) ?? normalized;
  return SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(base));
}

function isAlwaysExcludedPath(relativePath: string): boolean {
  const decision = evaluateIgnorePath(posixRelative(relativePath));
  if (decision.action === 'skip' && ALWAYS_EXCLUDE_REASONS.has(decision.reason)) {
    // generated/build outputs are always-excluded unless already handled as baseline preserve.
    // Task 3 preserves baseline-included generated files by only applying always-exclude to
    // VCS/cache/app/node_modules — not build-output — when the baseline listed them.
    if (decision.reason === 'build-output') return false;
    return true;
  }
  // Explicit always-exclude segments even if evaluateIgnorePath evolves.
  const parts = posixRelative(relativePath).split('/');
  for (const part of parts) {
    const lower = part.toLocaleLowerCase('en-US');
    if (
      lower === '.git'
      || lower === '.worktrees'
      || lower === 'node_modules'
      || lower === '.triagent'
      || lower === '.triagent-snapshots'
      || lower === '.cache'
      || lower === '.tmp'
      || lower === '.temp'
    ) {
      return true;
    }
  }
  return false;
}

function isProjectLocalTriAgentPath(relativePath: string): boolean {
  const normalized = posixRelative(relativePath);
  return (
    normalized === '.triagent'
    || normalized.startsWith('.triagent/')
    || normalized === '.triagent-snapshots'
    || normalized.startsWith('.triagent-snapshots/')
  );
}

function pathUnderAppRoot(absolutePath: string, appRoot: string): boolean {
  const parent = comparisonPath(appRoot);
  const child = comparisonPath(absolutePath);
  if (child === parent) return true;
  const prefix = parent.endsWith('\\') ? parent : `${parent}\\`;
  return child.startsWith(prefix);
}

function writeExclusiveFile(destination: string, content: Buffer, executable: boolean): void {
  mkdirSync(dirname(destination), { recursive: true });
  const descriptor = openSync(destination, 'wx');
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (executable && process.platform !== 'win32') {
    try {
      chmodSync(destination, 0o755);
    } catch {
      // Best-effort executable bit.
    }
  }
  const stats = lstatSync(destination);
  if (!stats.isFile()) {
    throw new Error(`materialized path is not a regular file: ${destination}`);
  }
  if (stats.nlink !== 1) {
    throw new Error(`materialized file must be an independent byte copy (nlink===1): ${destination}`);
  }
}

function readSourceExact(
  absolutePath: string,
  expectedHash: string | null,
  expectedSize: number,
  label: string,
): Buffer {
  let stats: Stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    throw new Error(`content-excluded source missing for ${label}: ${String(error)}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`content-excluded source is not a regular file: ${label}`);
  }
  if (stats.size !== expectedSize) {
    throw new Error(`content-hash mismatch for ${label}: size changed from baseline`);
  }
  const content = readFileSync(absolutePath);
  if (content.length !== expectedSize) {
    throw new Error(`content-hash mismatch for ${label}: read size changed from baseline`);
  }
  const hash = sha256(content);
  if (expectedHash !== null && hash !== expectedHash.toLowerCase()) {
    throw new Error(`content-hash mismatch for ${label}: source changed from baseline`);
  }
  return content;
}

function detectNestedRepository(
  projectRoot: string,
  files: readonly TrackingFileEntry[],
): string | undefined {
  const rootGit = join(projectRoot, '.git');
  const rootGitKey = comparisonPath(rootGit);
  const checked = new Set<string>();

  for (const entry of files) {
    if (entry.missing) continue;
    const parts = posixRelative(entry.path).split('/').filter((part) => part.length > 0);
    // Check each ancestor directory for a nested .git marker.
    for (let depth = 0; depth < parts.length; depth += 1) {
      const ancestorParts = parts.slice(0, depth);
      const markerRelative = [...ancestorParts, '.git'].join('/');
      if (checked.has(markerRelative)) continue;
      checked.add(markerRelative);
      const markerAbsolute = join(projectRoot, ...ancestorParts, '.git');
      // Project-root .git is the VCS root, not a nested repository.
      if (comparisonPath(markerAbsolute) === rootGitKey) continue;
      if (!existsSync(markerAbsolute)) continue;
      try {
        const stats = lstatSync(markerAbsolute);
        if (stats.isDirectory() || stats.isFile() || stats.isSymbolicLink()) {
          return markerRelative;
        }
      } catch {
        // Ignore races; absence is fine.
      }
    }
  }
  return undefined;
}

function loadBaselineOrThrow(
  tracker: BaselineTrackerPort,
  baselineId: string,
  expectedTaskId: string,
  expectedChecksum: string,
): TrackingBaselineManifest {
  const loaded = tracker.loadBaseline(baselineId);
  if (loaded.status !== 'loaded') {
    throw new Error(`baseline unavailable for materialization: ${loaded.diagnostic}`);
  }
  const manifest = loaded.manifest;
  if (manifest.taskId !== expectedTaskId) {
    throw new Error(
      `baseline taskId mismatch: expected ${expectedTaskId}, got ${manifest.taskId}`,
    );
  }
  if (manifest.checksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
    throw new Error('sourceManifestHash does not match loaded baseline checksum');
  }
  return manifest;
}

function candidateManifestHash(manifest: CandidateManifest): string {
  // Hash is content-identity only so identical source baselines yield the same
  // candidate hash across attempts; workspace/attempt ids remain in the sidecar.
  return sha256Json({
    schema: manifest.schema,
    sourceBaselineId: manifest.sourceBaselineId,
    sourceManifestHash: manifest.sourceManifestHash,
    files: manifest.files,
    protectedPaths: manifest.protectedPaths,
  });
}

export class ImplementationWorkspaceService {
  readonly #repository: ImplementationWorkspaceRepository;
  readonly #paths: AppPaths;
  readonly #tracker: BaselineTrackerPort;

  public constructor(options: ImplementationWorkspaceServiceOptions) {
    this.#repository = new ImplementationWorkspaceRepository(options.database);
    this.#paths = options.paths;
    this.#tracker = options.tracker;
  }

  public materializeFromBaseline(
    input: MaterializeImplementationWorkspaceInput,
  ): MaterializeImplementationWorkspaceResult {
    const canonicalProjectRoot = requireAbsolute(
      input.canonicalProjectRoot,
      'canonicalProjectRoot',
    );
    if (comparisonPath(canonicalProjectRoot) !== comparisonPath(this.#tracker.projectRoot)) {
      throw new Error('canonicalProjectRoot must match the tracker project root');
    }

    const workspaceRoot = resolve(
      join(
        this.#paths.implementationWorkspacesDirectory,
        input.taskId,
        input.attemptId,
        'project',
      ),
    );
    if (!pathUnderAppRoot(workspaceRoot, this.#paths.implementationWorkspacesDirectory)) {
      throw new Error('workspaceRoot escaped implementation workspaces directory');
    }

    const record = this.#repository.create({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      canonicalProjectRoot,
      workspaceRoot,
      sourceBaselineId: input.sourceBaselineId,
      sourceManifestHash: input.sourceManifestHash,
      authorizationId: input.authorizationId,
      authorizationExpiresAt: input.authorizationExpiresAt,
      nowIso: input.nowIso,
    });

    try {
      const result = this.#materializeInto(record, input);
      const ready = this.#repository.transition({
        workspaceId: record.workspaceId,
        expectedStatus: 'preparing',
        status: 'ready',
        nowIso: input.nowIso,
        candidateManifestHash: result.candidateManifestHash,
        lastError: null,
      });
      PROTECTED_MEMORY.set(record.workspaceId, new Set(result.protectedPaths));
      return {
        record: ready,
        protectedPaths: result.protectedPaths,
        candidateManifestHash: result.candidateManifestHash,
      };
    } catch (error) {
      this.#cleanupIncomplete(workspaceRoot);
      try {
        this.#repository.transition({
          workspaceId: record.workspaceId,
          expectedStatus: 'preparing',
          status: 'abandoned',
          nowIso: input.nowIso,
          lastError: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Best-effort terminalization; original error is authoritative.
      }
      throw error;
    }
  }

  public assertCandidatePathWritable(workspaceId: string, relativePath: string): void {
    const protectedPaths = PROTECTED_MEMORY.get(workspaceId);
    const normalized = posixRelative(relativePath);
    if (protectedPaths?.has(normalized)) {
      throw new Error(`protected path cannot be created or modified: ${normalized}`);
    }
    if (isSecretRelativePath(normalized) || isProjectLocalTriAgentPath(normalized)) {
      throw new Error(`protected path cannot be created or modified: ${normalized}`);
    }
    if (isAlwaysExcludedPath(normalized)) {
      throw new Error(`protected path cannot be created or modified: ${normalized}`);
    }
  }

  public getProtectedPaths(workspaceId: string): readonly string[] {
    return [...(PROTECTED_MEMORY.get(workspaceId) ?? [])].sort((a, b) => a.localeCompare(b));
  }

  public getRepository(): ImplementationWorkspaceRepository {
    return this.#repository;
  }

  /**
   * Mark a non-terminal workspace abandoned with a 24-hour retention window.
   * recovery_required requires an explicit audited cancel first.
   */
  public abandonWorkspace(input: {
    readonly workspaceId: string;
    readonly nowIso: string;
    readonly reason: string;
    readonly retentionHours?: number;
  }): ImplementationWorkspaceRecord {
    const current = this.#repository.get(input.workspaceId);
    if (current === undefined) {
      throw new Error(`implementation workspace not found: ${input.workspaceId}`);
    }
    if (current.status === 'promoted' || current.status === 'abandoned') {
      return current;
    }
    if (current.status === 'recovery_required') {
      // Explicit audited cancel of recovery_required → abandoned + retention.
      const retainedUntil = retentionDeadline(
        input.nowIso,
        input.retentionHours ?? DEFAULT_RETENTION_HOURS,
      );
      return this.#repository.transition({
        workspaceId: input.workspaceId,
        expectedStatus: 'recovery_required',
        status: 'abandoned',
        nowIso: input.nowIso,
        retainedUntil,
        lastError: input.reason,
      });
    }
    if (current.status === 'rejected') {
      const retainedUntil = retentionDeadline(
        input.nowIso,
        input.retentionHours ?? DEFAULT_RETENTION_HOURS,
      );
      // rejected is already terminal; only set retention if missing.
      if (current.retainedUntil !== null) return current;
      return this.#repository.setRetainedUntil({
        workspaceId: input.workspaceId,
        retainedUntil,
        nowIso: input.nowIso,
      });
    }
    // Drive toward abandoned via a legal single hop when possible.
    const retainedUntil = retentionDeadline(
      input.nowIso,
      input.retentionHours ?? DEFAULT_RETENTION_HOURS,
    );
    const abandonable = new Set([
      'preparing',
      'ready',
      'running',
      'candidate_ready',
      'under_review',
      'approved',
    ]);
    if (!abandonable.has(current.status)) {
      throw new Error(
        `workspace status ${current.status} cannot be abandoned without recovery cancel`,
      );
    }
    return this.#repository.transition({
      workspaceId: input.workspaceId,
      expectedStatus: current.status,
      status: 'abandoned',
      nowIso: input.nowIso,
      retainedUntil,
      lastError: input.reason,
    });
  }

  /**
   * Deterministic recovery decision for a persisted workspace row.
   * Never auto-replays uncertain promotion or reuses consumed authorization.
   */
  public decideWorkspaceRecovery(
    workspaceId: string,
    options: {
      readonly processLive?: boolean;
    } = {},
  ): WorkspaceRecoveryDecision {
    const record = this.#repository.get(workspaceId);
    if (record === undefined) {
      return {
        workspaceId,
        action: 'none',
        reason: 'workspace not found',
      };
    }
    switch (record.status) {
      case 'preparing':
        return {
          workspaceId,
          action: 'cleanup_incomplete',
          reason: 'incomplete prepare must be deleted and retried explicitly',
          record,
        };
      case 'ready':
        return {
          workspaceId,
          action: 'await_launch',
          reason: 'workspace ready; authorization not yet consumed',
          record,
        };
      case 'running':
        if (options.processLive === true) {
          return {
            workspaceId,
            action: 'do_not_replay',
            reason: 'live process evidence present; do not replay',
            record,
          };
        }
        return {
          workspaceId,
          action: 'inspect',
          reason: 'running without live process; preserve candidate for inspection',
          record,
        };
      case 'candidate_ready':
      case 'under_review':
        return {
          workspaceId,
          action: 'resume_review',
          reason: 'reconstruct immutable bundle from persisted hashes after integrity recheck',
          record,
        };
      case 'approved':
        return {
          workspaceId,
          action: 'allow_promotion',
          reason: 'approved before promotion; recheck baseline then promote',
          record,
        };
      case 'validating':
        return {
          workspaceId,
          action: 'inspect',
          reason: 'validating without matching session evidence requires inspect/cancel',
          record,
        };
      case 'promoting':
        return {
          workspaceId,
          action: 'do_not_replay',
          reason: 'uncertain promotion commit evidence; never auto-replay',
          record,
        };
      case 'promoted':
        return {
          workspaceId,
          action: 'cleanup_eligible',
          reason: 'promoted workspace may be deleted after evidence persistence',
          record,
        };
      case 'rejected':
      case 'abandoned':
        return {
          workspaceId,
          action: 'cleanup_after_retention',
          reason: 'retain 24h then remove by housekeeping',
          record,
        };
      case 'recovery_required':
        return {
          workspaceId,
          action: 'require_audited_cancel',
          reason: 'recovery_required is never auto-deleted',
          record,
        };
      default: {
        const _exhaustive: never = record.status;
        return {
          workspaceId,
          action: 'inspect',
          reason: `unknown workspace status: ${String(_exhaustive)}`,
          record,
        };
      }
    }
  }

  /**
   * Startup housekeeping: remove promoted workspaces and abandoned/rejected
   * workspaces whose retention window has elapsed. Never deletes recovery_required.
   */
  public housekeepExpiredWorkspaces(input: {
    readonly nowIso: string;
  }): WorkspaceHousekeepReport {
    return housekeepImplementationWorkspaces(this.#repository, input.nowIso);
  }

  #cleanupIncomplete(workspaceRoot: string): void {
    try {
      cleanupWorkspaceTree(workspaceRoot);
      // Incomplete prepare may also remove empty parents aggressively.
      const attemptDir = dirname(workspaceRoot);
      const taskDir = dirname(attemptDir);
      try {
        rmSync(attemptDir, { recursive: true, force: true });
      } catch {
        // Keep parent if non-empty or racing.
      }
      try {
        rmSync(taskDir, { recursive: true, force: true });
      } catch {
        // Keep parent if non-empty or racing.
      }
    } catch {
      // Cleanup is best-effort; callers still fail closed on status.
    }
  }

  #materializeInto(
    record: ImplementationWorkspaceRecord,
    input: MaterializeImplementationWorkspaceInput,
  ): { readonly candidateManifestHash: string; readonly protectedPaths: readonly string[] } {
    if (existsSync(record.workspaceRoot)) {
      throw new Error(`workspace root already exists: ${record.workspaceRoot}`);
    }

    const manifest = loadBaselineOrThrow(
      this.#tracker,
      input.sourceBaselineId,
      input.taskId,
      input.sourceManifestHash,
    );

    const nested = detectNestedRepository(record.canonicalProjectRoot, manifest.files);
    if (nested !== undefined) {
      throw new Error(`nested_repository_unsupported: ${nested}`);
    }

    mkdirSync(record.workspaceRoot, { recursive: true });

    const protectedPaths = new Set<string>();
    const candidateFiles: CandidateManifestFile[] = [];
    const sorted = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path));

    for (const entry of sorted) {
      if (entry.missing) continue;
      const relativePath = posixRelative(entry.path);

      if (isProjectLocalTriAgentPath(relativePath) || isAlwaysExcludedPath(relativePath)) {
        protectedPaths.add(relativePath);
        continue;
      }
      if (isSecretRelativePath(relativePath)) {
        protectedPaths.add(relativePath);
        continue;
      }

      const destination = resolve(join(record.workspaceRoot, ...relativePath.split('/')));
      if (!pathUnderAppRoot(destination, record.workspaceRoot)) {
        throw new Error(`materialization path escape: ${relativePath}`);
      }
      const sourceAbsolute = resolve(join(record.canonicalProjectRoot, ...relativePath.split('/')));
      if (
        pathUnderAppRoot(sourceAbsolute, this.#paths.root)
        && !pathUnderAppRoot(sourceAbsolute, record.canonicalProjectRoot)
      ) {
        protectedPaths.add(relativePath);
        continue;
      }

      const reparseEvidence = (entry as TrackingFileEntry & {
        readonly reparseEvidence?: unknown;
      }).reparseEvidence;
      if (entry.type === 'symlink' || reparseEvidence !== undefined) {
        const target = entry.linkTarget ?? '';
        const external = target.length > 0 && (isAbsolute(target) || target.includes('..'));
        if (external) {
          throw new Error(`reparse path escape for unsupported entry: ${relativePath}`);
        }
        throw new Error(`unsupported_entry: symlink/reparse is not materialized: ${relativePath}`);
      }

      if (entry.type === 'directory') {
        mkdirSync(destination, { recursive: true });
        candidateFiles.push({
          path: relativePath,
          type: 'directory',
          size: 0,
          hash: null,
          executable: false,
          binary: false,
        });
        continue;
      }

      if (entry.type !== 'file') {
        throw new Error(`unsupported_entry: ${entry.type} is not materialized: ${relativePath}`);
      }

      let content: Buffer;
      if (entry.blobHash !== null) {
        let blob: Buffer;
        try {
          blob = this.#tracker.readBlob(entry.blobHash);
        } catch (error) {
          throw new Error(
            `baseline content blob is missing or corrupt: ${entry.blobHash}: ${String(error)}`,
          );
        }
        if (sha256(blob) !== entry.blobHash.toLowerCase()) {
          throw new Error(`baseline content blob is missing or corrupt: ${entry.blobHash}`);
        }
        if (entry.hash !== null && sha256(blob) !== entry.hash.toLowerCase()) {
          throw new Error(`content-hash mismatch for ${relativePath}: blob disagrees with hash`);
        }
        content = blob;
      } else if (
        entry.contentCaptured === false
        || entry.contentExclusionReason !== undefined
        || entry.hash !== null
      ) {
        // Content-excluded regular files: re-read source and require hash match.
        content = readSourceExact(
          sourceAbsolute,
          entry.hash,
          entry.size,
          relativePath,
        );
      } else {
        throw new Error(`baseline content blob is missing or corrupt: ${relativePath}`);
      }

      writeExclusiveFile(destination, content, entry.executable);
      candidateFiles.push({
        path: relativePath,
        type: 'file',
        size: content.length,
        hash: sha256(content),
        executable: entry.executable,
        binary: entry.binary,
      });
    }

    const candidateManifest: CandidateManifest = {
      schema: 'triagent.candidate_manifest.v1',
      taskId: record.taskId,
      attemptId: record.attemptId,
      workspaceId: record.workspaceId,
      sourceBaselineId: record.sourceBaselineId,
      sourceManifestHash: record.sourceManifestHash,
      files: candidateFiles.sort((left, right) => left.path.localeCompare(right.path)),
      protectedPaths: [...protectedPaths].sort((left, right) => left.localeCompare(right)),
    };
    const hash = candidateManifestHash(candidateManifest);

    // Persist a durable sidecar for recovery/debug; not agent-visible as project content.
    const sidecar = join(dirname(record.workspaceRoot), 'candidate-manifest.json');
    writeExclusiveFile(sidecar, Buffer.from(JSON.stringify(candidateManifest), 'utf8'), false);

    return {
      candidateManifestHash: hash,
      protectedPaths: candidateManifest.protectedPaths,
    };
  }
}
