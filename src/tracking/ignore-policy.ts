/**
 * Explicit ignore policy for non-Git project snapshots and file watching.
 *
 * Distinctions:
 * - `skip`: do not discover / do not track (VCS internals, app storage, snapshot traps).
 * - `metadata-only-directory`: skip walking children; directory itself is not a file entry.
 * - `track`: ordinary project path; never silently ignored.
 */

export type IgnoreAction = 'track' | 'skip';

export type IgnoreReason =
  | 'node_modules'
  | 'vcs-internal'
  | 'app-storage'
  | 'temp-cache'
  | 'build-output'
  | 'snapshot-destination'
  | 'none';

export interface IgnoreDecision {
  readonly action: IgnoreAction;
  readonly reason: IgnoreReason;
  /** When true, the matching path segment prunes recursive descent. */
  readonly prune: boolean;
}

const SKIP_DIR_NAMES = new Map<string, IgnoreReason>([
  ['node_modules', 'node_modules'],
  ['.git', 'vcs-internal'],
  ['.hg', 'vcs-internal'],
  ['.svn', 'vcs-internal'],
  ['.bzr', 'vcs-internal'],
  ['.triagent', 'app-storage'],
  ['.triagent-snapshots', 'snapshot-destination'],
  ['.cache', 'temp-cache'],
  ['.tmp', 'temp-cache'],
  ['.temp', 'temp-cache'],
  ['tmp', 'temp-cache'],
  ['temp', 'temp-cache'],
  ['__pycache__', 'temp-cache'],
  ['.pytest_cache', 'temp-cache'],
  ['.mypy_cache', 'temp-cache'],
  ['.turbo', 'temp-cache'],
  ['.next', 'build-output'],
  ['.nuxt', 'build-output'],
  ['.output', 'build-output'],
  ['dist', 'build-output'],
  ['build', 'build-output'],
  ['out', 'build-output'],
  ['coverage', 'build-output'],
  ['.nyc_output', 'build-output'],
]);

function requireSafeRelativePath(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('relative path must be a string');
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized !== value.replaceAll('\\', '/') ||
    value.includes('\0') ||
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    // Accept callers that already used forward slashes; still reject unsafe forms.
    if (
      normalized.length === 0 ||
      normalized.includes('\0') ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
    ) {
      throw new Error(`unsafe relative path: ${JSON.stringify(value)}`);
    }
  }
  // Always evaluate on POSIX-style relative form.
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe relative path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

/**
 * Evaluate a project-relative path (POSIX separators) against the ignore policy.
 */
export function evaluateIgnorePath(relativePath: string): IgnoreDecision {
  const normalized = requireSafeRelativePath(relativePath.replaceAll('\\', '/'));
  const parts = normalized.split('/');
  for (const part of parts) {
    const reason = SKIP_DIR_NAMES.get(part);
    if (reason !== undefined) {
      return { action: 'skip', reason, prune: true };
    }
    // Case-insensitive match for common Windows tooling folders.
    const lower = part.toLocaleLowerCase('en-US');
    if (lower !== part) {
      const caseReason = SKIP_DIR_NAMES.get(lower);
      if (caseReason !== undefined) {
        return { action: 'skip', reason: caseReason, prune: true };
      }
    }
  }
  return { action: 'track', reason: 'none', prune: false };
}

/**
 * Whether a single directory name (not a full path) should prune recursion.
 */
export function shouldPruneDirectoryName(name: string): IgnoreDecision {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`unsafe directory name: ${JSON.stringify(name)}`);
  }
  const reason = SKIP_DIR_NAMES.get(name) ?? SKIP_DIR_NAMES.get(name.toLocaleLowerCase('en-US'));
  if (reason !== undefined) {
    return { action: 'skip', reason, prune: true };
  }
  return { action: 'track', reason: 'none', prune: false };
}

export function isIgnoredRelativePath(relativePath: string): boolean {
  return evaluateIgnorePath(relativePath).action === 'skip';
}
