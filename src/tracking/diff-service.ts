import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { normalizeGitRelativePath } from './git-client.js';
import { GitBaselineService } from './git-baseline-service.js';
import type {
  BaselineTrackerPort,
  TrackingBaselineManifest,
  TrackingCurrentSnapshot,
  TrackingFileEntry,
} from './tracking-port.js';

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'type-changed' | 'renamed';

export interface FileVersionSummary {
  readonly hash: string | null;
  readonly size: number;
  readonly type: TrackingFileEntry['type'];
  readonly missing: boolean;
}

export interface FileChange {
  readonly kind: ChangeKind;
  readonly path: string;
  readonly fromPath?: string;
  readonly before: FileVersionSummary | null;
  readonly after: FileVersionSummary | null;
  readonly binary: boolean;
}

export interface ChangeSet {
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

function version(entry: TrackingFileEntry | undefined): FileVersionSummary | null {
  if (entry === undefined) return null;
  return {
    hash: entry.hash,
    size: entry.size,
    type: entry.type,
    missing: entry.missing,
  };
}

function change(
  kind: ChangeKind,
  path: string,
  before: TrackingFileEntry | undefined,
  after: TrackingFileEntry | undefined,
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

function entryChanged(before: TrackingFileEntry, after: TrackingFileEntry): boolean {
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

function compare(
  baseline: TrackingBaselineManifest,
  current: TrackingCurrentSnapshot,
  label: ChangeSet['label'],
): ChangeSet {
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
    renamed.push({
      ...change(
        'renamed',
        addition.path,
        beforeByPath.get(deletion.path),
        afterByPath.get(addition.path),
        deletion.path,
      ),
    });
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

function contentForEntry(
  entry: TrackingFileEntry | undefined,
  source: 'baseline' | 'current',
  tracker: BaselineTrackerPort,
  current: TrackingCurrentSnapshot,
): Buffer | null {
  if (entry === undefined || entry.missing || entry.blobHash === null) return null;
  return source === 'baseline'
    ? tracker.readBlob(entry.blobHash)
    : current.blobs.get(entry.blobHash) ?? null;
}

function sanitizePatch(
  patch: string,
  path: string,
  beforeExists: boolean,
  afterExists: boolean,
  forbiddenPaths: readonly string[],
): string {
  const beforeLabel = beforeExists ? `a/${path}` : '/dev/null';
  const afterLabel = afterExists ? `b/${path}` : '/dev/null';
  let state: 'outside' | 'headers' | 'payload' = 'outside';
  let oldHeaderRewritten = false;
  let newHeaderRewritten = false;
  const lines = patch.split(/(?<=\n)/).map((line) => {
    const ending = line.endsWith('\n') ? '\n' : '';
    const content = ending.length === 0 ? line : line.slice(0, -1);
    if (content.startsWith('diff --git ')) {
      state = 'headers';
      oldHeaderRewritten = false;
      newHeaderRewritten = false;
      return `diff --git a/${path} b/${path}${ending}`;
    }
    if (state !== 'headers') return line;
    if (content.startsWith('@@') || content === 'GIT binary patch') {
      state = 'payload';
      return line;
    }
    if (!oldHeaderRewritten && content.startsWith('--- ')) {
      oldHeaderRewritten = true;
      return `--- ${beforeLabel}${ending}`;
    }
    if (oldHeaderRewritten && !newHeaderRewritten && content.startsWith('+++ ')) {
      newHeaderRewritten = true;
      return `+++ ${afterLabel}${ending}`;
    }
    if (content.startsWith('Binary files ')) {
      state = 'payload';
      return `Binary files ${beforeLabel} and ${afterLabel} differ${ending}`;
    }
    return line;
  }).join('');
  for (const forbidden of forbiddenPaths) {
    const variants = new Set([forbidden, forbidden.replaceAll('\\', '/'), forbidden.replaceAll('/', '\\')]);
    for (const variant of variants) {
      if (variant.length > 0 && lines.includes(variant)) {
        throw new Error('refusing to return a patch containing an absolute project or temporary path');
      }
    }
  }
  return lines;
}

export class DiffService {
  readonly #tracker: BaselineTrackerPort;

  public constructor(tracker: BaselineTrackerPort) {
    this.#tracker = tracker;
  }

  public taskWindow(baselineId: string): ChangeSet {
    const baseline = this.#requireBaseline(baselineId);
    if (baseline.kind !== 'task') throw new Error('taskWindow requires a task baseline');
    return compare(baseline, this.#tracker.scanCurrent(), 'task-window changes');
  }

  public attemptWindow(baselineId: string): ChangeSet {
    const baseline = this.#requireBaseline(baselineId);
    if (baseline.kind !== 'attempt') throw new Error('attemptWindow requires an attempt baseline');
    return compare(baseline, this.#tracker.scanCurrent(), 'attempt-window changes');
  }

  public headToCurrent(): string {
    const tracker = this.#requireGitTracker();
    const patch = tracker.gitClient.headToCurrentPatch();
    const status = tracker.gitClient.status();
    const untracked = status.entries
      .filter((entry) => entry.recordType === 'untracked')
      .map((entry) => `# untracked: ${entry.path}`)
      .join('\n');
    return [patch.trimEnd(), untracked].filter((entry) => entry.length > 0).join('\n');
  }

  public patchForFile(baselineId: string, relativePathValue: string): string {
    const tracker = this.#requireGitTracker();
    const relativePath = normalizeGitRelativePath(relativePathValue);
    const baseline = this.#requireBaseline(baselineId);
    const current = tracker.scanCurrent();
    const beforeEntry = baseline.files.find((entry) => entry.path === relativePath);
    const afterEntry = current.files.find((entry) => entry.path === relativePath);
    const before = contentForEntry(beforeEntry, 'baseline', tracker, current);
    const after = contentForEntry(afterEntry, 'current', tracker, current);
    if (before === null && after === null) return '';
    const temporaryDirectory = mkdtempSync(join(tracker.snapshotStore, 'patch-'));
    try {
      const beforeDirectory = join(temporaryDirectory, 'before');
      const afterDirectory = join(temporaryDirectory, 'after');
      mkdirSync(beforeDirectory);
      mkdirSync(afterDirectory);
      const beforePath = join(beforeDirectory, 'content');
      const afterPath = join(afterDirectory, 'content');
      if (before !== null) writeFileSync(beforePath, before);
      if (after !== null) writeFileSync(afterPath, after);
      const rawPatch = tracker.gitClient.diffNoIndex(
        before === null ? '/dev/null' : beforePath,
        after === null ? '/dev/null' : afterPath,
      );
      return sanitizePatch(rawPatch, relativePath, before !== null, after !== null, [
        tracker.projectRoot,
        tracker.snapshotStore,
        temporaryDirectory,
      ]);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  #requireBaseline(baselineId: string): TrackingBaselineManifest {
    const loaded = this.#tracker.loadBaseline(baselineId);
    if (loaded.status !== 'loaded') {
      throw new Error(`baseline is unavailable: ${loaded.diagnostic}`);
    }
    return loaded.manifest;
  }

  #requireGitTracker(): GitBaselineService {
    if (!(this.#tracker instanceof GitBaselineService)) {
      throw new Error('Git patch operations require a Git baseline tracker');
    }
    return this.#tracker;
  }
}
