import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { PatchApplier, PatchApplyResult } from '../guard/patch-applier.js';
import {
  completeBaselineManifest,
  type BuildingBaselineManifest,
} from '../tracking/baseline-manifest.js';
import { sha256, stableJson } from '../tracking/hash.js';

import type {
  WorkspaceCandidateChangeSet,
  WorkspaceChangeEntry,
} from './implementation-workspace-types.js';
import { changeSetToUnifiedPatch } from './workspace-change-set.js';
import { ImplementationWorkspaceRepository } from './implementation-workspace-repository.js';

export interface CanonicalFileFingerprint {
  readonly path: string;
  readonly hash: string | null;
  readonly size: number;
  readonly missing?: boolean;
}

export interface PromoteWorkspaceCandidateInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly baselineId: string;
  readonly sourceManifestHash: string;
  readonly changeSet: WorkspaceCandidateChangeSet;
  /**
   * Full-tree fingerprint of the canonical project at promote time.
   * Compared against expectedCanonicalFiles for global drift detection.
   */
  readonly currentCanonicalFiles: readonly CanonicalFileFingerprint[];
  /**
   * Full-tree fingerprint expected from the source baseline (prepare time).
   * When omitted, falls back to comparing current hash against sourceManifestHash
   * (test/compat path only).
   */
  readonly expectedCanonicalFiles?: readonly CanonicalFileFingerprint[];
  readonly nowIso: string;
  /**
   * Optional active lock owner check. When provided and mismatched, promotion
   * fails closed without writing.
   */
  readonly expectedLockOwner?: string;
  readonly actualLockOwner?: string | null;
}

export type PromoteWorkspaceCandidateResult =
  | {
      readonly ok: true;
      readonly patchResult: Extract<PatchApplyResult, { status: 'applied' }> | null;
      readonly promotedChangeSetHash: string;
      readonly postApplyVerified: true;
      readonly emptyChangeSet?: true;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly code:
        | 'promotion_blocked_original_drift'
        | 'promotion_blocked_lock_mismatch'
        | 'promotion_blocked_change_set'
        | 'promotion_blocked_patch'
        | 'promotion_blocked_workspace_state'
        | 'promotion_blocked_post_apply_mismatch';
    };

function comparisonPath(value: string): string {
  return process.platform === 'win32'
    ? value.replaceAll('/', '\\').toLocaleLowerCase('en-US')
    : value;
}

/**
 * Deterministic full-tree fingerprint for global drift checks.
 * Any path change, including unrelated files, blocks promotion.
 */
export function hashCanonicalManifest(
  files: readonly CanonicalFileFingerprint[],
): string {
  const normalized = [...files]
    .map((file) => ({
      path: file.path.replaceAll('\\', '/'),
      hash: file.hash === null ? null : file.hash.toLowerCase(),
      size: file.size,
      missing: file.missing === true,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256(stableJson(normalized));
}

export interface WorkspacePromotionServiceOptions {
  readonly repository: ImplementationWorkspaceRepository;
  readonly patchApplier: PatchApplier;
  readonly canonicalProjectRoot: string;
  /** Snapshot store used to materialize a promotion-scoped attempt baseline. */
  readonly snapshotStore: string;
}

function hashChangeSet(changeSet: WorkspaceCandidateChangeSet): string {
  return createHash('sha256')
    .update(
      `${stableJson({
        schema: changeSet.schema,
        taskId: changeSet.taskId,
        attemptId: changeSet.attemptId,
        workspaceId: changeSet.workspaceId,
        sourceBaselineId: changeSet.sourceBaselineId,
        sourceManifestHash: changeSet.sourceManifestHash,
        candidateManifestHash: changeSet.candidateManifestHash,
        entries: changeSet.entries,
      })}\n${changeSet.unifiedDiff}`,
      'utf8',
    )
    .digest('hex');
}

function kindMatches(
  entry: WorkspaceChangeEntry,
  appliedKind: string,
): boolean {
  if (entry.kind === 'add') return appliedKind === 'added';
  if (entry.kind === 'delete') return appliedKind === 'deleted';
  return appliedKind === 'modified';
}

/**
 * Verify post-apply filesystem + PatchApplier change-set match the reviewed
 * candidate change-set entry-for-entry (path, kind, after hash).
 */
export function verifyPostApplyChangeSetEquality(input: {
  readonly projectRoot: string;
  readonly changeSet: WorkspaceCandidateChangeSet;
  readonly applied: Extract<PatchApplyResult, { status: 'applied' }> | null;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const { projectRoot, changeSet, applied } = input;
  if (changeSet.entries.length === 0) {
    if (applied !== null && applied.changeSet.changes.length > 0) {
      return {
        ok: false,
        reason: 'empty reviewed change-set but PatchApplier reported file changes',
      };
    }
    return { ok: true };
  }
  if (applied === null) {
    return { ok: false, reason: 'missing PatchApplier result for non-empty change-set' };
  }

  const appliedByPath = new Map(
    applied.changeSet.changes.map((change) => [change.path.replaceAll('\\', '/'), change]),
  );
  if (appliedByPath.size !== changeSet.entries.length) {
    return {
      ok: false,
      reason:
        `post-apply change count mismatch: reviewed=${changeSet.entries.length} applied=${appliedByPath.size}`,
    };
  }

  for (const entry of changeSet.entries) {
    const path = entry.path.replaceAll('\\', '/');
    const appliedChange = appliedByPath.get(path);
    if (appliedChange === undefined) {
      return { ok: false, reason: `post-apply missing path ${path}` };
    }
    if (!kindMatches(entry, appliedChange.kind)) {
      return {
        ok: false,
        reason: `post-apply kind mismatch for ${path}: reviewed=${entry.kind} applied=${appliedChange.kind}`,
      };
    }

    const absolute = join(projectRoot, ...path.split('/'));
    if (entry.kind === 'delete') {
      if (existsSync(absolute)) {
        return { ok: false, reason: `post-apply delete left file present: ${path}` };
      }
      if (entry.afterHash !== null) {
        return { ok: false, reason: `delete entry afterHash must be null for ${path}` };
      }
      continue;
    }

    if (!existsSync(absolute)) {
      return { ok: false, reason: `post-apply missing written file: ${path}` };
    }
    const content = readFileSync(absolute);
    const diskHash = sha256(content);
    if (entry.afterHash === null || diskHash !== entry.afterHash.toLowerCase()) {
      return {
        ok: false,
        reason: `post-apply content hash mismatch for ${path}`,
      };
    }
    const appliedAfter = appliedChange.after?.hash ?? null;
    if (appliedAfter === null || appliedAfter.toLowerCase() !== entry.afterHash.toLowerCase()) {
      return {
        ok: false,
        reason: `post-apply PatchApplier after-hash mismatch for ${path}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Materialize a promotion-scoped attempt baseline that covers every change-set
 * path so PatchValidator can accept add/modify/delete plans.
 */
export function materializePromotionBaseline(input: {
  readonly snapshotStore: string;
  readonly projectRoot: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly baselineId: string;
  readonly parentTaskBaselineId: string;
  readonly changeSet: WorkspaceCandidateChangeSet;
}): void {
  const files: Array<BuildingBaselineManifest['files'][number]> = [];
  const blobs = new Map<string, Buffer>();

  for (const entry of input.changeSet.entries) {
    const path = entry.path.replaceAll('\\', '/');
    if (entry.kind === 'add') {
      files.push({
        path,
        type: 'other',
        size: 0,
        mtimeMs: null,
        hash: null,
        blobHash: null,
        missing: true,
        executable: false,
        binary: false,
        tracked: false,
      });
      continue;
    }

    const absolute = join(input.projectRoot, ...path.split('/'));
    const content = readFileSync(absolute);
    const hash = sha256(content);
    if (entry.beforeHash !== null && hash !== entry.beforeHash.toLowerCase()) {
      throw new Error(
        `promotion baseline source content drift for ${path}`,
      );
    }
    blobs.set(hash, content);
    files.push({
      path,
      type: 'file',
      size: content.length,
      mtimeMs: 1,
      hash,
      blobHash: hash,
      missing: false,
      executable: false,
      binary: false,
      tracked: true,
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));

  const git = {
    canonicalRoot: resolve(input.projectRoot),
    headSha: 'a'.repeat(40),
    branch: 'main',
    detached: false,
    statusRaw: '',
    statusEntries: [] as const,
  };

  const parentBuilding: BuildingBaselineManifest = {
    version: 1,
    status: 'building',
    kind: 'task',
    taskId: input.taskId,
    baselineId: input.parentTaskBaselineId,
    createdAt: '2026-07-15T00:00:00.000Z',
    git,
    files,
    exclusions: [],
  };
  completeBaselineManifest(input.snapshotStore, parentBuilding, blobs);

  const attemptBuilding: BuildingBaselineManifest = {
    version: 1,
    status: 'building',
    kind: 'attempt',
    taskId: input.taskId,
    baselineId: input.baselineId,
    attemptId: input.attemptId,
    attemptNumber: 1,
    parentTaskBaselineId: input.parentTaskBaselineId,
    createdAt: '2026-07-15T00:00:00.000Z',
    git,
    files,
    exclusions: [],
  };
  completeBaselineManifest(input.snapshotStore, attemptBuilding, blobs);
}

export class WorkspacePromotionService {
  readonly #repository: ImplementationWorkspaceRepository;
  readonly #patchApplier: PatchApplier;
  readonly #canonicalProjectRoot: string;
  readonly #snapshotStore: string;

  public constructor(options: WorkspacePromotionServiceOptions) {
    this.#repository = options.repository;
    this.#patchApplier = options.patchApplier;
    this.#canonicalProjectRoot = resolve(options.canonicalProjectRoot);
    this.#snapshotStore = resolve(options.snapshotStore);
  }

  public promote(
    input: PromoteWorkspaceCandidateInput,
  ): PromoteWorkspaceCandidateResult {
    const workspace = this.#repository.get(input.workspaceId);
    if (workspace === undefined) {
      return {
        ok: false,
        code: 'promotion_blocked_workspace_state',
        reason: `implementation workspace not found: ${input.workspaceId}`,
      };
    }
    if (workspace.taskId !== input.taskId || workspace.attemptId !== input.attemptId) {
      return {
        ok: false,
        code: 'promotion_blocked_workspace_state',
        reason: 'workspace task/attempt identity mismatch',
      };
    }
    if (
      workspace.status !== 'approved'
      && workspace.status !== 'validating'
      && workspace.status !== 'promoting'
    ) {
      return {
        ok: false,
        code: 'promotion_blocked_workspace_state',
        reason: `workspace status ${workspace.status} cannot promote`,
      };
    }
    if (workspace.sourceManifestHash !== input.sourceManifestHash.toLowerCase()) {
      return {
        ok: false,
        code: 'promotion_blocked_change_set',
        reason: 'workspace sourceManifestHash does not match promotion input',
      };
    }
    if (comparisonPath(workspace.canonicalProjectRoot) !== comparisonPath(this.#canonicalProjectRoot)) {
      return {
        ok: false,
        code: 'promotion_blocked_workspace_state',
        reason: 'canonical project root mismatch',
      };
    }

    if (
      input.expectedLockOwner !== undefined
      && (input.actualLockOwner === null
        || input.actualLockOwner === undefined
        || input.actualLockOwner !== input.expectedLockOwner)
    ) {
      return {
        ok: false,
        code: 'promotion_blocked_lock_mismatch',
        reason: 'active lock mismatch blocks promotion',
      };
    }

    const currentHash = hashCanonicalManifest(input.currentCanonicalFiles);
    if (input.expectedCanonicalFiles !== undefined) {
      const expectedHash = hashCanonicalManifest(input.expectedCanonicalFiles);
      if (currentHash !== expectedHash) {
        return {
          ok: false,
          code: 'promotion_blocked_original_drift',
          reason:
            'promotion_blocked_original_drift: canonical manifest hash diverged from source baseline',
        };
      }
    } else if (currentHash !== input.sourceManifestHash.toLowerCase()) {
      // Compat path used by unit tests that store content fingerprints as
      // sourceManifestHash. Production callers should pass expectedCanonicalFiles.
      return {
        ok: false,
        code: 'promotion_blocked_original_drift',
        reason:
          'promotion_blocked_original_drift: canonical manifest hash diverged from source baseline',
      };
    }

    // Re-verify affected paths still match the source side of the change set.
    for (const entry of input.changeSet.entries) {
      if (entry.kind === 'add') {
        const absolute = join(this.#canonicalProjectRoot, ...entry.path.split('/'));
        if (existsSync(absolute)) {
          return {
            ok: false,
            code: 'promotion_blocked_original_drift',
            reason: `promotion_blocked_original_drift: add target already exists ${entry.path}`,
          };
        }
        continue;
      }
      const absolute = join(this.#canonicalProjectRoot, ...entry.path.split('/'));
      if (!existsSync(absolute)) {
        if (entry.beforeHash !== null) {
          return {
            ok: false,
            code: 'promotion_blocked_original_drift',
            reason: `promotion_blocked_original_drift: missing source path ${entry.path}`,
          };
        }
        continue;
      }
      const content = readFileSync(absolute);
      if (sha256(content) !== (entry.beforeHash ?? '').toLowerCase()) {
        return {
          ok: false,
          code: 'promotion_blocked_original_drift',
          reason: `promotion_blocked_original_drift: content drift at ${entry.path}`,
        };
      }
    }

    let patch: string;
    try {
      if (input.changeSet.changeSetHash !== hashChangeSet(input.changeSet)) {
        return {
          ok: false,
          code: 'promotion_blocked_change_set',
          reason: 'reviewed change-set hash mismatch',
        };
      }
      if (
        input.changeSet.taskId !== input.taskId
        || input.changeSet.workspaceId !== input.workspaceId
      ) {
        return {
          ok: false,
          code: 'promotion_blocked_change_set',
          reason: 'change-set identity does not match promotion target',
        };
      }
      patch = changeSetToUnifiedPatch(input.changeSet);
    } catch (error) {
      return {
        ok: false,
        code: 'promotion_blocked_change_set',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (workspace.status === 'approved') {
      this.#repository.transition({
        workspaceId: input.workspaceId,
        expectedStatus: 'approved',
        status: 'validating',
        nowIso: input.nowIso,
      });
    }
    const beforePromote = this.#repository.get(input.workspaceId);
    if (beforePromote === undefined) {
      return {
        ok: false,
        code: 'promotion_blocked_workspace_state',
        reason: 'workspace disappeared before promote',
      };
    }
    if (beforePromote.status === 'validating') {
      this.#repository.transition({
        workspaceId: input.workspaceId,
        expectedStatus: 'validating',
        status: 'promoting',
        nowIso: input.nowIso,
        changeSetHash: input.changeSet.changeSetHash,
      });
    } else if (beforePromote.status !== 'promoting') {
      return {
        ok: false,
        code: 'promotion_blocked_workspace_state',
        reason: `workspace status ${beforePromote.status} cannot enter promoting`,
      };
    }

    // Empty reviewed change-set: no PatchApplier write; mark promoted after integrity.
    if (input.changeSet.entries.length === 0) {
      const emptyVerify = verifyPostApplyChangeSetEquality({
        projectRoot: this.#canonicalProjectRoot,
        changeSet: input.changeSet,
        applied: null,
      });
      if (!emptyVerify.ok) {
        this.#repository.transition({
          workspaceId: input.workspaceId,
          expectedStatus: 'promoting',
          status: 'recovery_required',
          nowIso: input.nowIso,
          lastError: emptyVerify.reason,
        });
        return {
          ok: false,
          code: 'promotion_blocked_post_apply_mismatch',
          reason: emptyVerify.reason,
        };
      }
      this.#repository.transition({
        workspaceId: input.workspaceId,
        expectedStatus: 'promoting',
        status: 'promoted',
        nowIso: input.nowIso,
        changeSetHash: input.changeSet.changeSetHash,
        lastError: null,
        retainedUntil: null,
      });
      return {
        ok: true,
        patchResult: null,
        promotedChangeSetHash: input.changeSet.changeSetHash,
        postApplyVerified: true,
        emptyChangeSet: true,
      };
    }

    const promotionBaselineId = `promotion-${input.baselineId}`;
    const parentBaselineId = `promotion-parent-${input.baselineId}`;
    try {
      materializePromotionBaseline({
        snapshotStore: this.#snapshotStore,
        projectRoot: this.#canonicalProjectRoot,
        taskId: input.taskId,
        attemptId: input.attemptId,
        baselineId: promotionBaselineId,
        parentTaskBaselineId: parentBaselineId,
        changeSet: input.changeSet,
      });
    } catch (error) {
      this.#repository.transition({
        workspaceId: input.workspaceId,
        expectedStatus: 'promoting',
        status: 'recovery_required',
        nowIso: input.nowIso,
        lastError: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        code: 'promotion_blocked_change_set',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const patchResult = this.#patchApplier.apply({
      patch,
      baselineId: promotionBaselineId,
      attemptId: input.attemptId,
      taskId: input.taskId,
    });
    if (patchResult.status !== 'applied') {
      this.#repository.transition({
        workspaceId: input.workspaceId,
        expectedStatus: 'promoting',
        status: 'recovery_required',
        nowIso: input.nowIso,
        lastError: patchResult.reason,
      });
      return {
        ok: false,
        code: 'promotion_blocked_patch',
        reason: patchResult.reason,
      };
    }

    const post = verifyPostApplyChangeSetEquality({
      projectRoot: this.#canonicalProjectRoot,
      changeSet: input.changeSet,
      applied: patchResult,
    });
    if (!post.ok) {
      // Best-effort rollback of applied files when post-hash fails.
      for (const entry of input.changeSet.entries) {
        const absolute = join(this.#canonicalProjectRoot, ...entry.path.split('/'));
        try {
          if (entry.kind === 'add') {
            if (existsSync(absolute)) unlinkSync(absolute);
          } else if (entry.kind === 'delete' || entry.kind === 'modify') {
            // Cannot fully reconstruct without stored before blob; leave recovery.
          }
        } catch {
          // recovery_required below is authoritative
        }
      }
      this.#repository.transition({
        workspaceId: input.workspaceId,
        expectedStatus: 'promoting',
        status: 'recovery_required',
        nowIso: input.nowIso,
        lastError: post.reason,
      });
      return {
        ok: false,
        code: 'promotion_blocked_post_apply_mismatch',
        reason: post.reason,
      };
    }

    this.#repository.transition({
      workspaceId: input.workspaceId,
      expectedStatus: 'promoting',
      status: 'promoted',
      nowIso: input.nowIso,
      changeSetHash: input.changeSet.changeSetHash,
      lastError: null,
      retainedUntil: null,
    });

    return {
      ok: true,
      patchResult,
      promotedChangeSetHash: input.changeSet.changeSetHash,
      postApplyVerified: true,
    };
  }
}
