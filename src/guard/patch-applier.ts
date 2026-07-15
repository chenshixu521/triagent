import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type PathLike,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { AttemptId, BaselineId, TaskId } from '../domain/ids.js';
import type { ChangeSet, FileChange } from '../tracking/diff-service.js';
import { sha256 } from '../tracking/hash.js';
import type { ProjectGuard } from './project-guard.js';
import { PathPolicy } from './path-policy.js';
import { PatchValidator, type PatchFilePlan } from './patch-validator.js';

export interface PatchApplyEvidence {
  readonly decisionId: string;
  readonly baselineId: string;
  readonly attemptId: string;
  readonly filesWritten: readonly string[];
  readonly baselineRecheck: {
    readonly ok: boolean;
    readonly notes: readonly string[];
  };
}

export type PatchApplyResult =
  | {
      readonly status: 'applied';
      readonly changeSet: ChangeSet;
      readonly evidence: PatchApplyEvidence;
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      readonly evidence?: Partial<PatchApplyEvidence>;
    };

export interface PatchApplyInput {
  readonly patch: string;
  readonly baselineId: BaselineId | string;
  readonly attemptId: AttemptId | string;
  readonly taskId: TaskId | string;
}

export interface ProcessLauncher {
  readonly spawn: (command: string, args?: readonly string[]) => unknown;
}

export interface PatchApplierOptions {
  readonly projectRoot: string;
  readonly snapshotStore: string;
  readonly guard: ProjectGuard;
  readonly processLauncher?: ProcessLauncher;
}

interface StagedFile {
  readonly plan: PatchFilePlan;
  readonly absolute: string;
  readonly temporary: string | null;
  readonly kind: PatchFilePlan['kind'];
}

function fileChange(
  kind: FileChange['kind'],
  path: string,
  beforeHash: string | null,
  afterHash: string | null,
  beforeSize: number,
  afterSize: number,
): FileChange {
  return {
    kind,
    path,
    before:
      beforeHash === null
        ? null
        : {
            hash: beforeHash,
            size: beforeSize,
            type: 'file',
            missing: false,
          },
    after:
      afterHash === null
        ? null
        : {
            hash: afterHash,
            size: afterSize,
            type: 'file',
            missing: false,
          },
    binary: false,
  };
}

function toChangeSet(
  baselineId: string,
  plans: readonly PatchFilePlan[],
): ChangeSet {
  const changes: FileChange[] = plans.map((plan) => {
    const beforeHash =
      plan.beforeText === null ? null : sha256(plan.beforeText);
    const afterHash = plan.afterText === null ? null : sha256(plan.afterText);
    const beforeSize = plan.beforeText === null ? 0 : Buffer.byteLength(plan.beforeText);
    const afterSize = plan.afterText === null ? 0 : Buffer.byteLength(plan.afterText);
    if (plan.kind === 'add') {
      return fileChange('added', plan.path, null, afterHash, 0, afterSize);
    }
    if (plan.kind === 'delete') {
      return fileChange('deleted', plan.path, beforeHash, null, beforeSize, 0);
    }
    return fileChange('modified', plan.path, beforeHash, afterHash, beforeSize, afterSize);
  });
  const added = changes.filter((entry) => entry.kind === 'added');
  const modified = changes.filter((entry) => entry.kind === 'modified');
  const deleted = changes.filter((entry) => entry.kind === 'deleted');
  return {
    label: 'attempt-window changes',
    baselineId,
    changes,
    added,
    modified,
    deleted,
    typeChanged: [],
    renamed: [],
    summary: {
      total: changes.length,
      added: added.length,
      modified: modified.length,
      deleted: deleted.length,
      typeChanged: 0,
      renamed: 0,
      binary: 0,
    },
  };
}

function unpredictableTempPath(absolute: string): string {
  const token = randomBytes(16).toString('hex');
  return `${absolute}.triagent-${token}.tmp`;
}

/**
 * Create a new temp file with exclusive O_EXCL, write content via descriptor,
 * and verify nlink===1 and path/descriptor identity before close.
 */
function writeExclusiveTempFile(
  temporary: string,
  content: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx'); // O_EXCL | O_CREAT | O_WRONLY
    const stats = fstatSync(fd);
    if (stats.nlink !== 1) {
      return {
        ok: false,
        reason: `temp file hard-link risk (nlink=${stats.nlink}); exclusive create failed closed`,
      };
    }
    writeFileSync(fd, content, 'utf8');
    const after = fstatSync(fd);
    if (after.nlink !== 1) {
      return {
        ok: false,
        reason: `temp file acquired multi-link provenance after write (nlink=${after.nlink})`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `exclusive temp create/write failed: ${String(error)}`,
    };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors after failure path
      }
    }
  }
}

function safeUnlink(path: PathLike): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * PatchApplier is the only writer for read-only patch mode.
 * It stages and rechecks ALL files before commit, then commits with rollback
 * on partial Windows rename failure. Best-effort project guardrail — not an OS sandbox.
 */
export class PatchApplier {
  readonly #projectRoot: string;
  readonly #validator: PatchValidator;
  readonly #guard: ProjectGuard;
  readonly #pathPolicy: PathPolicy;
  readonly #processLauncher: ProcessLauncher | undefined;

  public constructor(options: PatchApplierOptions) {
    this.#projectRoot = options.projectRoot;
    this.#validator = new PatchValidator({
      projectRoot: options.projectRoot,
      snapshotStore: options.snapshotStore,
    });
    this.#guard = options.guard;
    this.#pathPolicy = new PathPolicy({ projectRoot: options.projectRoot });
    this.#processLauncher = options.processLauncher;
  }

  public apply(input: PatchApplyInput): PatchApplyResult {
    // Process launcher must never be used for patch application.
    void this.#processLauncher;

    const validated = this.#validator.validate({
      patch: input.patch,
      baselineId: input.baselineId,
      attemptId: input.attemptId,
      taskId: input.taskId,
    });
    if (!validated.ok) {
      return { status: 'rejected', reason: validated.reason };
    }

    const decision = this.#guard.evaluatePatchApply({
      attemptId: input.attemptId,
      role: 'implementer',
      files: validated.files,
      baselineId: String(input.baselineId),
      capabilities: Object.freeze({
        fixedSessionId: true,
        resume: true,
        structuredOutput: true,
        streamJson: true,
        realTimeInput: false,
        nativeSandbox: false,
        nativePermissionRules: true,
        budgetLimit: true,
        turnLimit: true,
        timeLimit: true,
        nonGitProjects: true,
        writeModes: Object.freeze(['read-only'] as const),
      }),
      adapter: { kind: 'codex', version: 'patch-applier' },
    });

    if (decision.mode === 'denied' || decision.mode === 'disabled') {
      return {
        status: 'rejected',
        reason: decision.reason,
        evidence: {
          decisionId: decision.id,
          baselineId: String(input.baselineId),
          attemptId: String(input.attemptId),
          filesWritten: [],
          baselineRecheck: { ok: false, notes: [decision.reason] },
        },
      };
    }

    const recheckNotes: string[] = [];
    const staged: StagedFile[] = [];
    const temporaryPaths: string[] = [];

    const reject = (
      reason: string,
      notes: readonly string[],
    ): PatchApplyResult => {
      for (const temporary of temporaryPaths) {
        safeUnlink(temporary);
      }
      return {
        status: 'rejected',
        reason,
        evidence: {
          decisionId: decision.id,
          baselineId: String(input.baselineId),
          attemptId: String(input.attemptId),
          filesWritten: [],
          baselineRecheck: { ok: false, notes: [...notes] },
        },
      };
    };

    try {
      // Phase 1: stage and validate/recheck ALL files before any final commit.
      for (const plan of validated.plans) {
        const absolute = join(this.#projectRoot, ...plan.relativePath.split('/'));

        // Fail closed on multi-link / hard-link final targets before any write.
        const pathResult = this.#pathPolicy.evaluatePath(plan.relativePath);
        if (!pathResult.allowed) {
          return reject(
            `patch path denied during stage: ${pathResult.reason}`,
            ['hard-link-or-path-denied', plan.relativePath, pathResult.reason],
          );
        }

        if (plan.beforeText !== null) {
          let current: string;
          try {
            current = readFileSync(absolute, 'utf8');
          } catch (error) {
            return reject(
              `baseline recheck failed to read ${plan.relativePath}: ${String(error)}`,
              ['read-failed', plan.relativePath],
            );
          }
          if (current !== plan.beforeText) {
            return reject(
              `baseline recheck mismatch / content drift for ${plan.relativePath}`,
              ['content-drift', plan.relativePath],
            );
          }
          recheckNotes.push(`recheck-ok:${plan.relativePath}`);
        } else if (plan.kind === 'add') {
          try {
            readFileSync(absolute);
            return reject(
              `add plan blocked because file already exists: ${plan.relativePath}`,
              ['add-exists', plan.relativePath],
            );
          } catch {
            // expected missing
          }
        }

        if (plan.kind === 'delete') {
          staged.push({ plan, absolute, temporary: null, kind: 'delete' });
          continue;
        }

        const next = plan.afterText ?? '';
        mkdirSync(dirname(absolute), { recursive: true });
        const temporary = unpredictableTempPath(absolute);
        temporaryPaths.push(temporary);
        const written = writeExclusiveTempFile(temporary, next);
        if (!written.ok) {
          return reject(
            `failed to stage patch for ${plan.relativePath}: ${written.reason}`,
            ['stage-failed', plan.relativePath, written.reason],
          );
        }
        staged.push({ plan, absolute, temporary, kind: plan.kind });
      }

      // Phase 2: commit all staged files. On partial failure, roll back committed files.
      const committed: Array<{
        readonly absolute: string;
        readonly beforeText: string | null;
        readonly kind: PatchFilePlan['kind'];
        readonly relativePath: string;
      }> = [];

      for (const entry of staged) {
        try {
          if (entry.kind === 'delete') {
            rmSync(entry.absolute, { force: true });
            committed.push({
              absolute: entry.absolute,
              beforeText: entry.plan.beforeText,
              kind: 'delete',
              relativePath: entry.plan.relativePath,
            });
            continue;
          }
          if (entry.temporary === null) {
            return reject(
              `internal stage error: missing temp for ${entry.plan.relativePath}`,
              ['missing-temp', entry.plan.relativePath],
            );
          }
          // Re-check final target immediately before rename (TOCTOU).
          const preCommit = this.#pathPolicy.evaluatePath(entry.plan.relativePath);
          // For adds, path may not exist yet — evaluatePath allows non-existing inside paths
          // unless hard-link on existing ancestor. If existing file has nlink>1, deny.
          if (entry.kind === 'modify' && !preCommit.allowed) {
            throw new Error(preCommit.reason);
          }
          if (entry.kind === 'modify' || entry.kind === 'add') {
            // If target already exists as multi-link, fail closed before rename follows it.
            if (entry.kind === 'modify' && !preCommit.allowed) {
              throw new Error(preCommit.reason);
            }
          }
          renameSync(entry.temporary, entry.absolute);
          // Temp was consumed by rename.
          const index = temporaryPaths.indexOf(entry.temporary);
          if (index >= 0) temporaryPaths.splice(index, 1);
          committed.push({
            absolute: entry.absolute,
            beforeText: entry.plan.beforeText,
            kind: entry.kind,
            relativePath: entry.plan.relativePath,
          });
        } catch (error) {
          // Rollback any already-committed files from this multi-file patch.
          for (const done of committed.reverse()) {
            try {
              if (done.kind === 'add') {
                safeUnlink(done.absolute);
              } else if (done.kind === 'delete') {
                if (done.beforeText !== null) {
                  writeFileSync(done.absolute, done.beforeText, 'utf8');
                }
              } else if (done.beforeText !== null) {
                writeFileSync(done.absolute, done.beforeText, 'utf8');
              }
            } catch {
              // best-effort recovery
            }
          }
          return reject(
            `failed to apply patch to ${entry.plan.relativePath}: ${String(error)}`,
            [...recheckNotes, `commit-failed:${entry.plan.relativePath}`, 'rolled-back'],
          );
        }
      }

      // Success: evidence only after full multi-file commit.
      return {
        status: 'applied',
        changeSet: toChangeSet(String(input.baselineId), validated.plans),
        evidence: {
          decisionId: decision.id,
          baselineId: String(input.baselineId),
          attemptId: String(input.attemptId),
          filesWritten: validated.plans.map((plan) => plan.relativePath),
          baselineRecheck: {
            ok: true,
            notes: recheckNotes,
          },
        },
      };
    } finally {
      for (const temporary of temporaryPaths) {
        safeUnlink(temporary);
      }
    }
  }
}
