import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AttemptId, BaselineId, TaskId } from '../domain/ids.js';
import { loadBaselineManifest } from '../tracking/baseline-manifest.js';
import { sha256 } from '../tracking/hash.js';
import { PathPolicy } from './path-policy.js';

export interface PatchFilePlan {
  readonly path: string;
  readonly relativePath: string;
  readonly kind: 'modify' | 'add' | 'delete';
  readonly beforeText: string | null;
  readonly afterText: string | null;
  readonly hunks: readonly string[];
}

export type PatchValidationResult =
  | {
      readonly ok: true;
      readonly files: readonly string[];
      readonly plans: readonly PatchFilePlan[];
      readonly baselineId: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly failClosed: true;
    };

export interface ValidatePatchInput {
  readonly patch: string;
  readonly baselineId: BaselineId | string;
  readonly attemptId: AttemptId | string;
  readonly taskId?: TaskId | string;
}

interface ParsedFileDiff {
  headerPath: string;
  oldPath: string | null;
  newPath: string | null;
  lines: string[];
  isBinary: boolean;
  hasUnsafeMode: boolean;
}

function deny(reason: string): PatchValidationResult {
  return { ok: false, reason, failClosed: true };
}

function isUnsafePathToken(token: string): boolean {
  if (token.length === 0) return true;
  if (token.includes('\0')) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  if (token.startsWith('/') || token.startsWith('\\')) return true;
  if (token.includes('\\\\')) return true;
  if (token.includes(':')) return true; // ADS / device
  if (token.split(/[\\/]/).some((part) => part === '..')) return true;
  return false;
}

function stripAbPrefix(pathToken: string): string {
  if (pathToken === '/dev/null') return pathToken;
  if (pathToken.startsWith('a/') || pathToken.startsWith('b/')) {
    return pathToken.slice(2);
  }
  return pathToken;
}

function parseUnifiedDiff(patch: string): ParsedFileDiff[] | { error: string } {
  if (patch.includes('\0')) {
    return { error: 'binary or NUL-containing patch is not supported' };
  }
  const normalized = patch.replaceAll('\r\n', '\n');
  if (/^GIT binary patch/m.test(normalized) || /^Binary files /m.test(normalized)) {
    return { error: 'binary patch formats are not supported' };
  }
  if (/^(old|new) mode \d+/m.test(normalized) || /^new file mode /m.test(normalized) || /^deleted file mode /m.test(normalized)) {
    // Mode changes are unsafe for auto-apply in v1.
    // We still parse but mark unsafe mode on the file.
  }

  const lines = normalized.split('\n');
  const files: ParsedFileDiff[] = [];
  let current: ParsedFileDiff | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) files.push(current);
      const match = /^diff --git (.+) (.+)$/.exec(line);
      if (match === null) return { error: 'malformed diff --git header' };
      const left = stripAbPrefix(match[1]!);
      const right = stripAbPrefix(match[2]!);
      current = {
        headerPath: right === '/dev/null' ? left : right,
        oldPath: left === '/dev/null' ? null : left,
        newPath: right === '/dev/null' ? null : right,
        lines: [line],
        isBinary: false,
        hasUnsafeMode: false,
      };
      continue;
    }
    if (current === null) {
      if (line.trim().length === 0) continue;
      return { error: 'patch content before diff --git header' };
    }
    current.lines.push(line);
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
      current.isBinary = true;
    }
    if (
      /^(old|new) mode \d+/.test(line) ||
      /^new file mode /.test(line) ||
      /^deleted file mode /.test(line)
    ) {
      current.hasUnsafeMode = true;
    }
    if (line.startsWith('--- ')) {
      const token = stripAbPrefix(line.slice(4).trim());
      current.oldPath = token === '/dev/null' ? null : token;
    }
    if (line.startsWith('+++ ')) {
      const token = stripAbPrefix(line.slice(4).trim());
      current.newPath = token === '/dev/null' ? null : token;
      if (current.newPath !== null) current.headerPath = current.newPath;
      else if (current.oldPath !== null) current.headerPath = current.oldPath;
    }
  }
  if (current !== null) files.push(current);
  if (files.length === 0) return { error: 'patch contains no file diffs' };
  return files;
}

function applyHunks(
  original: string,
  fileLines: readonly string[],
): { ok: true; next: string } | { ok: false; reason: string } {
  const sourceLines = original.length === 0 ? [] : original.split('\n');
  // Preserve whether original ended with newline
  const originalEndsWithNewline = original.endsWith('\n');
  if (originalEndsWithNewline && sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === '') {
    sourceLines.pop();
  }

  let cursor = 0;
  const output: string[] = [];
  let i = 0;
  while (i < fileLines.length && !fileLines[i]!.startsWith('@@')) {
    i += 1;
  }

  while (i < fileLines.length) {
    const header = fileLines[i]!;
    if (!header.startsWith('@@')) {
      i += 1;
      continue;
    }
    const hunkMatch =
      /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/.exec(header);
    if (hunkMatch === null) {
      return { ok: false, reason: `malformed hunk header: ${header}` };
    }
    const oldStart = Number(hunkMatch[1]);
    i += 1;

    // Copy unchanged prefix
    const prefixEnd = Math.max(0, oldStart - 1);
    if (prefixEnd < cursor) {
      return { ok: false, reason: 'overlapping or out-of-order hunks' };
    }
    while (cursor < prefixEnd) {
      if (cursor >= sourceLines.length) {
        return { ok: false, reason: 'hunk old start exceeds file length' };
      }
      output.push(sourceLines[cursor]!);
      cursor += 1;
    }

    while (i < fileLines.length) {
      const line = fileLines[i]!;
      if (line.startsWith('@@') || line.startsWith('diff --git ')) break;
      if (line.startsWith('\\')) {
        // "\ No newline at end of file"
        i += 1;
        continue;
      }
      if (line.startsWith(' ')) {
        const expected = line.slice(1);
        if (cursor >= sourceLines.length || sourceLines[cursor] !== expected) {
          return {
            ok: false,
            reason: 'baseline content mismatch while applying context line',
          };
        }
        output.push(expected);
        cursor += 1;
        i += 1;
        continue;
      }
      if (line.startsWith('-')) {
        const expected = line.slice(1);
        if (cursor >= sourceLines.length || sourceLines[cursor] !== expected) {
          return {
            ok: false,
            reason: 'baseline content mismatch for deleted line',
          };
        }
        cursor += 1;
        i += 1;
        continue;
      }
      if (line.startsWith('+')) {
        output.push(line.slice(1));
        i += 1;
        continue;
      }
      if (line.trim().length === 0) {
        i += 1;
        continue;
      }
      // index / other metadata after hunks
      break;
    }
  }

  while (cursor < sourceLines.length) {
    output.push(sourceLines[cursor]!);
    cursor += 1;
  }

  let next = output.join('\n');
  if (originalEndsWithNewline || next.length > 0) {
    // unified diffs for single-line files in tests omit trailing markers; normalize to LF file with newline
    if (!next.endsWith('\n') && (originalEndsWithNewline || original.length > 0)) {
      next = `${next}\n`;
    }
  }
  return { ok: true, next };
}

export class PatchValidator {
  readonly #pathPolicy: PathPolicy;
  readonly #snapshotStore: string;
  readonly #projectRoot: string;

  public constructor(options: {
    readonly projectRoot: string;
    readonly snapshotStore: string;
  }) {
    this.#projectRoot = options.projectRoot;
    this.#snapshotStore = options.snapshotStore;
    this.#pathPolicy = new PathPolicy({ projectRoot: options.projectRoot });
  }

  public validate(input: ValidatePatchInput): PatchValidationResult {
    const parsed = parseUnifiedDiff(input.patch);
    if ('error' in parsed) return deny(parsed.error);

    const expectedTaskId =
      input.taskId === undefined ? undefined : String(input.taskId);

    const baselineLoad = loadBaselineManifest(
      this.#snapshotStore,
      String(input.baselineId),
      {
        expectedProjectRoot: this.#projectRoot,
        baselineId: String(input.baselineId),
        taskId: expectedTaskId,
        kind: 'attempt',
      },
    );
    if (baselineLoad.status !== 'loaded') {
      return deny(`baseline load failed: ${baselineLoad.diagnostic}`);
    }
    const baseline = baselineLoad.manifest;

    // Strict identity: attempt-kind baseline with exact attemptId (+ optional taskId).
    if (baseline.kind !== 'attempt') {
      return deny('baseline identity rejected: expected attempt-kind baseline');
    }
    if (baseline.attemptId !== String(input.attemptId)) {
      return deny(
        `baseline identity rejected: attemptId mismatch (expected ${String(input.attemptId)})`,
      );
    }
    if (
      expectedTaskId !== undefined &&
      baseline.taskId !== expectedTaskId
    ) {
      return deny(
        `baseline identity rejected: taskId mismatch (expected ${expectedTaskId})`,
      );
    }

    const baselineByPath = new Map(
      baseline.files.map((entry) => [entry.path, entry]),
    );

    const plans: PatchFilePlan[] = [];
    const files: string[] = [];

    for (const file of parsed) {
      if (file.isBinary) {
        return deny('binary patch formats are not supported');
      }
      if (file.hasUnsafeMode) {
        return deny('unsafe file mode changes are not supported');
      }

      const candidatePath = file.newPath ?? file.oldPath ?? file.headerPath;
      if (candidatePath === null || isUnsafePathToken(candidatePath)) {
        return deny(`absolute, outside, device, or unsafe patch path: ${candidatePath}`);
      }
      if (file.oldPath !== null && isUnsafePathToken(file.oldPath)) {
        return deny(`unsafe old path in patch: ${file.oldPath}`);
      }
      if (file.newPath !== null && isUnsafePathToken(file.newPath)) {
        return deny(`unsafe new path in patch: ${file.newPath}`);
      }

      const pathResult = this.#pathPolicy.evaluatePath(candidatePath);
      if (!pathResult.allowed) {
        return deny(`patch path denied: ${pathResult.reason}`);
      }

      const relativePath = pathResult.relativePath.replaceAll('\\', '/');
      const baselineEntry = baselineByPath.get(relativePath);
      const diskPath = join(this.#projectRoot, ...relativePath.split('/'));

      // Strict present/missing coverage: every patched path must appear in the baseline.
      if (baselineEntry === undefined) {
        return deny(
          `baseline coverage rejected: path is absent from attempt baseline: ${relativePath}`,
        );
      }
      if (baselineEntry.missing) {
        // Adds against a missing baseline entry are allowed only when the file is truly absent.
        if (file.oldPath !== null) {
          return deny(
            `baseline coverage rejected: path is marked missing in baseline: ${relativePath}`,
          );
        }
      } else {
        if (baselineEntry.binary) {
          return deny(`baseline marks file as binary: ${relativePath}`);
        }
        if (baselineEntry.type !== 'file') {
          return deny(`baseline entry is not a regular file: ${relativePath}`);
        }
      }

      let diskText: string | null = null;
      if (existsSync(diskPath)) {
        try {
          const buffer = readFileSync(diskPath);
          if (buffer.includes(0)) {
            return deny(`binary file content is not supported for patch: ${relativePath}`);
          }
          diskText = buffer.toString('utf8');
        } catch (error) {
          return deny(
            `failed to read path for baseline coverage (${relativePath}): ${String(error)}`,
          );
        }
      }

      if (!baselineEntry.missing) {
        if (diskText === null) {
          return deny(`baseline file missing on disk: ${relativePath}`);
        }
        const diskHash = sha256(diskText);
        if (baselineEntry.hash !== diskHash) {
          return deny(
            `baseline content mismatch for ${relativePath}: disk does not match attempt baseline`,
          );
        }
      } else if (diskText !== null && file.oldPath === null) {
        // Add plan but file already exists while baseline says missing.
        return deny(
          `baseline coverage rejected: missing baseline entry but file exists on disk: ${relativePath}`,
        );
      }

      const beforeText = baselineEntry.missing ? null : diskText;
      const applied =
        beforeText === null
          ? applyHunks('', file.lines)
          : applyHunks(beforeText, file.lines);
      if (!applied.ok) {
        return deny(`${applied.reason} (${relativePath})`);
      }

      let kind: PatchFilePlan['kind'] = 'modify';
      if (file.oldPath === null) kind = 'add';
      if (file.newPath === null) kind = 'delete';

      plans.push({
        path: relativePath,
        relativePath,
        kind,
        beforeText,
        afterText: kind === 'delete' ? null : applied.next,
        hunks: file.lines,
      });
      files.push(relativePath);
    }

    return {
      ok: true,
      files,
      plans,
      baselineId: String(input.baselineId),
    };
  }
}
