import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute, join, posix, win32 } from 'node:path';

import {
  canonicalizeProjectPath,
  type CanonicalProjectPath,
} from './canonical-path.js';

export type ProjectKind =
  | {
      readonly kind: 'git';
      readonly projectRoot: string;
      readonly repositoryRoot: string;
      readonly relationship: 'root' | 'nested';
      readonly gitMetadata: 'directory' | 'file' | 'ancestor';
    }
  | {
      readonly kind: 'directory';
      readonly projectRoot: string;
    }
  | {
      readonly kind: 'git-unavailable';
      readonly projectRoot: string;
      readonly error: string;
    };

export class GitDetectionError extends Error {
  public override readonly name = 'GitDetectionError';

  public constructor(message: string, options?: ErrorOptions) {
    super(`GitDetectionError: ${message}`, options);
  }
}

export interface GitCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  readonly windowsHide: true;
}

export interface GitCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error & { readonly code?: string };
}

export type GitCommandRunner = (
  request: GitCommandRequest,
) => GitCommandResult;

export interface DetectProjectKindOptions {
  readonly gitExecutable?: string;
  readonly runner?: GitCommandRunner;
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 256 * 1024;
const REPOSITORY_SHAPING_ENVIRONMENT_VARIABLES: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);

function defaultGitRunner(request: GitCommandRequest): GitCommandResult {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (REPOSITORY_SHAPING_ENVIRONMENT_VARIABLES.has(name.toUpperCase())) {
      delete environment[name];
    }
  }
  const result = spawnSync(request.executable, [...request.args], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: request.maxBuffer,
    timeout: request.timeoutMs,
    windowsHide: request.windowsHide,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function isSameOrAncestor(
  repository: CanonicalProjectPath,
  selected: CanonicalProjectPath,
): boolean {
  if (repository.pathFlavor !== selected.pathFlavor) return false;
  const implementation = selected.pathFlavor === 'windows' ? win32 : posix;
  const relativePath = implementation.relative(
    repository.comparisonKey,
    selected.comparisonKey,
  );
  return (
    relativePath.length === 0 ||
    (!implementation.isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${implementation.sep}`))
  );
}

function localGitMetadata(root: string): 'directory' | 'file' | 'ancestor' {
  try {
    const stats = lstatSync(join(root, '.git'));
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') throw error;
  }
  return 'ancestor';
}

function unavailableMessage(
  error: Error & { readonly code?: string },
  request: GitCommandRequest,
): string {
  if (error.code === 'ETIMEDOUT') {
    return `Git command timed out after ${String(request.timeoutMs)}ms (ETIMEDOUT)`;
  }
  if (error.code === 'ENOBUFS') {
    return `Git command exceeded the ${String(request.maxBuffer)} byte output limit (ENOBUFS)`;
  }
  return `${error.code === undefined ? '' : `${error.code}: `}${error.message}`;
}

function parseTopLevel(stdout: string, displayPath: string): string {
  if (!/^[^\r\n]+(?:\r?\n)?$/.test(stdout)) {
    throw new GitDetectionError(
      `Git must return exactly one non-empty top-level path line for ${displayPath}`,
    );
  }
  const topLevel = stdout.replace(/\r?\n$/, '');
  if (!isAbsolute(topLevel)) {
    throw new GitDetectionError(
      `Git returned a non-absolute top-level path for ${displayPath}: ${topLevel}`,
    );
  }
  return topLevel;
}

export function detectProjectKind(
  project: CanonicalProjectPath,
  options: DetectProjectKindOptions = {},
): ProjectKind {
  const gitExecutable = options.gitExecutable ?? 'git';
  const request: GitCommandRequest = {
    executable: gitExecutable,
    args: ['-C', project.canonicalRoot, 'rev-parse', '--show-toplevel'],
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  };
  const result = (options.runner ?? defaultGitRunner)(request);
  if (result.error !== undefined) {
    return {
      kind: 'git-unavailable',
      projectRoot: project.canonicalRoot,
      error: unavailableMessage(result.error, request),
    };
  }
  if (result.status === null) {
    return {
      kind: 'git-unavailable',
      projectRoot: project.canonicalRoot,
      error: 'Git command terminated without an exit status',
    };
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    if (/not a git repository/i.test(stderr)) {
      return { kind: 'directory', projectRoot: project.canonicalRoot };
    }
    throw new GitDetectionError(
      `Git repository detection failed for ${project.displayPath}: ${stderr || `exit ${String(result.status)}`}`,
    );
  }

  const repository = canonicalizeProjectPath(
    parseTopLevel(result.stdout, project.displayPath),
  );
  if (!isSameOrAncestor(repository, project)) {
    throw new GitDetectionError(
      `Git top-level must be equal to or an ancestor of the selected project: ${repository.canonicalRoot}`,
    );
  }
  const relationship =
    repository.comparisonKey === project.comparisonKey ? 'root' : 'nested';
  return {
    kind: 'git',
    projectRoot: project.canonicalRoot,
    repositoryRoot: repository.canonicalRoot,
    relationship,
    gitMetadata: relationship === 'root' ? localGitMetadata(project.canonicalRoot) : 'ancestor',
  };
}
