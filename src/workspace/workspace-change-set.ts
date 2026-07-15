import { createHash } from 'node:crypto';

import { isBinaryContent, sha256, sha256Json, stableJson } from '../tracking/hash.js';
import type { TrackingFileEntry } from '../tracking/tracking-port.js';

import type {
  WorkspaceCandidateChangeSet,
  WorkspaceChangeEntry,
} from './implementation-workspace-types.js';

const MAX_DIFF_BYTES = 1_048_576;

export interface WorkspaceFileSnapshot {
  readonly path: string;
  readonly type: TrackingFileEntry['type'] | 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly hash: string | null;
  readonly blobHash: string | null;
  readonly missing?: boolean;
  readonly binary?: boolean;
  readonly content?: Buffer | null;
}

export interface BuildWorkspaceChangeSetInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly sourceBaselineId: string;
  readonly sourceManifestHash: string;
  readonly candidateManifestHash: string;
  readonly sourceFiles: readonly WorkspaceFileSnapshot[];
  readonly candidateFiles: readonly WorkspaceFileSnapshot[];
  readonly protectedPaths?: readonly string[];
}

function posixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function assertSafeRelativePath(value: string): string {
  const normalized = posixPath(value);
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.includes('\0')
    || normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`workspace change-set rejects absolute or unsafe path: ${value}`);
  }
  return normalized;
}

function comparisonKey(path: string): string {
  return process.platform === 'win32'
    ? path.toLocaleLowerCase('en-US')
    : path;
}

function requireTextBlob(
  entry: WorkspaceFileSnapshot | undefined,
  label: string,
): Buffer | null {
  if (entry === undefined || entry.missing === true) return null;
  if (entry.type !== 'file') {
    throw new Error(`workspace change-set rejects unsupported type ${entry.type} for ${label}`);
  }
  if (entry.binary === true) {
    throw new Error(`workspace change-set rejects binary content for ${label}`);
  }
  if (entry.content === undefined || entry.content === null) {
    if (entry.hash === null && entry.blobHash === null && entry.size === 0) {
      return Buffer.alloc(0);
    }
    throw new Error(`workspace change-set missing blob content for ${label}`);
  }
  if (isBinaryContent(entry.content) || entry.content.includes(0)) {
    throw new Error(`workspace change-set rejects binary content for ${label}`);
  }
  if (entry.content.length > MAX_DIFF_BYTES) {
    throw new Error(`workspace change-set rejects oversized payload for ${label}`);
  }
  const hash = sha256(entry.content);
  if (entry.hash !== null && entry.hash.toLowerCase() !== hash) {
    throw new Error(`workspace change-set content-hash mismatch for ${label}`);
  }
  if (entry.blobHash !== null && entry.blobHash.toLowerCase() !== hash) {
    throw new Error(`workspace change-set blob-hash mismatch for ${label}`);
  }
  return entry.content;
}

/**
 * Split text into logical lines matching PatchValidator.applyHunks semantics:
 * a trailing newline does not create a phantom empty line entry.
 */
function splitLinesForDiff(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n') && lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function unifiedDiffFor(
  path: string,
  before: Buffer | null,
  after: Buffer | null,
): string {
  const beforeText = before === null ? null : before.toString('utf8');
  const afterText = after === null ? null : after.toString('utf8');
  if (beforeText === afterText) return '';

  const lines: string[] = [];
  lines.push(`diff --git a/${path} b/${path}`);
  // Do not emit git mode lines: PatchValidator rejects mode metadata as unsafe.
  if (beforeText === null) {
    lines.push('--- /dev/null');
    lines.push(`+++ b/${path}`);
    // For brand-new files PatchValidator starts from empty original and does not
    // auto-append a trailing newline. Keep a final empty line entry when the
    // candidate text ends with LF so applyHunks reconstructs the same bytes.
    const afterLines = afterText!.endsWith('\n')
      ? afterText!.split('\n')
      : splitLinesForDiff(afterText!);
    lines.push(`@@ -0,0 +1,${Math.max(afterLines.length, 1)} @@`);
    for (const line of afterLines) {
      lines.push(`+${line}`);
    }
    return `${lines.join('\n')}\n`;
  }
  if (afterText === null) {
    lines.push(`--- a/${path}`);
    lines.push('+++ /dev/null');
    const beforeLines = splitLinesForDiff(beforeText);
    lines.push(`@@ -1,${Math.max(beforeLines.length, 1)} +0,0 @@`);
    for (const line of beforeLines) {
      lines.push(`-${line}`);
    }
    return `${lines.join('\n')}\n`;
  }
  const beforeLines = splitLinesForDiff(beforeText);
  const afterLines = splitLinesForDiff(afterText);
  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);
  lines.push(
    `@@ -1,${Math.max(beforeLines.length, 1)} +1,${Math.max(afterLines.length, 1)} @@`,
  );
  for (const line of beforeLines) lines.push(`-${line}`);
  for (const line of afterLines) lines.push(`+${line}`);
  return `${lines.join('\n')}\n`;
}

function indexByPath(
  files: readonly WorkspaceFileSnapshot[],
): Map<string, WorkspaceFileSnapshot> {
  const map = new Map<string, WorkspaceFileSnapshot>();
  const seenKeys = new Set<string>();
  for (const file of files) {
    const path = assertSafeRelativePath(file.path);
    const key = comparisonKey(path);
    if (seenKeys.has(key) || map.has(path)) {
      throw new Error(`workspace change-set rejects duplicate/case-colliding path: ${path}`);
    }
    seenKeys.add(key);
    map.set(path, { ...file, path });
  }
  return map;
}

/**
 * Build a deterministic source→candidate change set for review and promotion.
 * Renames are represented as delete+add (optional detectedFromPath metadata).
 */
export function buildWorkspaceCandidateChangeSet(
  input: BuildWorkspaceChangeSetInput,
): WorkspaceCandidateChangeSet {
  if (!/^[0-9a-f]{64}$/i.test(input.sourceManifestHash)) {
    throw new Error('sourceManifestHash must be a SHA-256 hex digest');
  }
  if (!/^[0-9a-f]{64}$/i.test(input.candidateManifestHash)) {
    throw new Error('candidateManifestHash must be a SHA-256 hex digest');
  }

  const protectedSet = new Set(
    (input.protectedPaths ?? []).map((path) => comparisonKey(assertSafeRelativePath(path))),
  );
  const source = indexByPath(input.sourceFiles);
  const candidate = indexByPath(input.candidateFiles);
  // Fail closed on case-only collisions across source and candidate path sets.
  const folded = new Map<string, string>();
  for (const path of [...source.keys(), ...candidate.keys()]) {
    const key = comparisonKey(path);
    const existing = folded.get(key);
    if (existing !== undefined && existing !== path) {
      throw new Error(
        `workspace change-set rejects duplicate/case-colliding path: ${existing} vs ${path}`,
      );
    }
    folded.set(key, path);
  }
  const allPaths = [...new Set([...source.keys(), ...candidate.keys()])]
    .sort((left, right) => left.localeCompare(right));

  const entries: WorkspaceChangeEntry[] = [];
  const diffParts: string[] = [];

  for (const path of allPaths) {
    if (protectedSet.has(comparisonKey(path))) {
      const before = source.get(path);
      const after = candidate.get(path);
      if (
        (before === undefined || before.missing === true)
        !== (after === undefined || after.missing === true)
        || (before?.hash ?? null) !== (after?.hash ?? null)
      ) {
        throw new Error(`workspace change-set rejects mutation of protected path: ${path}`);
      }
      continue;
    }

    const beforeEntry = source.get(path);
    const afterEntry = candidate.get(path);
    const beforeMissing = beforeEntry === undefined || beforeEntry.missing === true;
    const afterMissing = afterEntry === undefined || afterEntry.missing === true;

    if (beforeMissing && afterMissing) continue;

    if (!beforeMissing && afterMissing) {
      const beforeBlob = requireTextBlob(beforeEntry, path);
      entries.push({
        kind: 'delete',
        path,
        beforeHash: beforeEntry!.hash,
        afterHash: null,
        beforeSize: beforeEntry!.size,
        afterSize: 0,
        beforeBlobHash: beforeEntry!.blobHash ?? beforeEntry!.hash,
        afterBlobHash: null,
      });
      diffParts.push(unifiedDiffFor(path, beforeBlob, null));
      continue;
    }

    if (beforeMissing && !afterMissing) {
      const afterBlob = requireTextBlob(afterEntry, path);
      entries.push({
        kind: 'add',
        path,
        beforeHash: null,
        afterHash: afterEntry!.hash,
        beforeSize: 0,
        afterSize: afterEntry!.size,
        beforeBlobHash: null,
        afterBlobHash: afterEntry!.blobHash ?? afterEntry!.hash,
      });
      diffParts.push(unifiedDiffFor(path, null, afterBlob));
      continue;
    }

    const beforeBlob = requireTextBlob(beforeEntry, path);
    const afterBlob = requireTextBlob(afterEntry, path);
    if (
      (beforeEntry!.hash ?? null) === (afterEntry!.hash ?? null)
      && beforeEntry!.size === afterEntry!.size
    ) {
      continue;
    }
    entries.push({
      kind: 'modify',
      path,
      beforeHash: beforeEntry!.hash,
      afterHash: afterEntry!.hash,
      beforeSize: beforeEntry!.size,
      afterSize: afterEntry!.size,
      beforeBlobHash: beforeEntry!.blobHash ?? beforeEntry!.hash,
      afterBlobHash: afterEntry!.blobHash ?? afterEntry!.hash,
    });
    diffParts.push(unifiedDiffFor(path, beforeBlob, afterBlob));
  }

  const sortedEntries = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const unifiedDiff = diffParts.join('');
  if (unifiedDiff.includes(input.taskId) && /[A-Za-z]:\\/.test(unifiedDiff)) {
    throw new Error('workspace change-set unified diff must not contain absolute paths');
  }
  if (/[A-Za-z]:[\\/]/.test(unifiedDiff) || unifiedDiff.includes('\\\\')) {
    // Absolute Windows paths in hunk headers are forbidden.
    if (/\n(?:---|\+\+\+)\s+[A-Za-z]:/.test(`\n${unifiedDiff}`)) {
      throw new Error('workspace change-set unified diff must not contain absolute paths');
    }
  }

  const body = {
    schema: 'triagent.workspace_change_set.v1' as const,
    taskId: input.taskId,
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
    sourceBaselineId: input.sourceBaselineId,
    sourceManifestHash: input.sourceManifestHash.toLowerCase(),
    candidateManifestHash: input.candidateManifestHash.toLowerCase(),
    entries: sortedEntries,
    unifiedDiff,
  };
  const changeSetHash = sha256(
    `${stableJson({
      schema: body.schema,
      taskId: body.taskId,
      attemptId: body.attemptId,
      workspaceId: body.workspaceId,
      sourceBaselineId: body.sourceBaselineId,
      sourceManifestHash: body.sourceManifestHash,
      candidateManifestHash: body.candidateManifestHash,
      entries: body.entries,
    })}\n${unifiedDiff}`,
  );

  return Object.freeze({
    ...body,
    changeSetHash,
  });
}

/**
 * Convert a validated candidate change set into a textual multi-file patch
 * consumable by PatchApplier / PatchValidator conventions.
 */
export function changeSetToUnifiedPatch(changeSet: WorkspaceCandidateChangeSet): string {
  if (changeSet.schema !== 'triagent.workspace_change_set.v1') {
    throw new Error('unsupported workspace change-set schema');
  }
  if (changeSet.unifiedDiff.trim().length === 0 && changeSet.entries.length > 0) {
    throw new Error('change-set entries require a non-empty unified diff');
  }
  const expected = createHash('sha256')
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
  if (expected !== changeSet.changeSetHash) {
    throw new Error('workspace change-set hash mismatch');
  }
  return changeSet.unifiedDiff;
}

export function hashWorkspaceCandidateChangeSet(
  changeSet: Omit<WorkspaceCandidateChangeSet, 'changeSetHash'>,
): string {
  return sha256(
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
  );
}

void sha256Json;
