import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  resolve,
  sep,
} from 'node:path';

/**
 * Canonical durable application data paths.
 * Production root: %LOCALAPPDATA%\TriAgent (Windows) or
 * $XDG_DATA_HOME/TriAgent / ~/.local/share/TriAgent (other platforms).
 * Never falls back to cwd or a project directory for durable app data.
 */

export interface AppPaths {
  readonly root: string;
  readonly databasePath: string;
  readonly logsDirectory: string;
  readonly snapshotsDirectory: string;
  readonly implementationWorkspacesDirectory: string;
  readonly nativeDiagnosticsDirectory: string;
  readonly settingsPath: string;
  readonly cliCompatibilityCachePath: string;
}

export interface ResolveAppPathsOptions {
  /**
   * Explicit absolute app-data root for tests. Rejected when it contains
   * traversal segments, is empty, or points through a reparse/symlink chain
   * that cannot be trusted. Never use project cwd as a silent fallback.
   */
  readonly appRootOverride?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly createDirectories?: boolean;
}

const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'lpt1',
  'lpt2',
  'lpt3',
]);

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function containsTraversalSegment(input: string): boolean {
  const normalized = input.replaceAll('/', sep);
  const segments = normalized.split(sep);
  return segments.some((segment) => segment === '..');
}

function pathComparisonKey(input: string): string {
  return process.platform === 'win32'
    ? input.replaceAll('/', '\\').toLocaleLowerCase('en-US')
    : input;
}

function isReparseOrSymlink(path: string): boolean {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return true;
    // Windows: junction/reparse often report as directory with reparse bit;
    // lstat isSymbolicLink covers junctions created as dir symlinks.
    return false;
  } catch {
    return false;
  }
}

function assertNotReparse(path: string, label: string): void {
  if (!existsSync(path)) return;
  if (isReparseOrSymlink(path)) {
    throw new Error(
      `untrusted ${label}: reparse/symlink/junction path rejected: ${path}`,
    );
  }
  try {
    const real = realpathSync.native(path);
    if (pathComparisonKey(real) !== pathComparisonKey(resolve(path))) {
      // Allow only when realpath equals the path we intend to use.
      // Mismatch indicates intermediate reparse redirection.
      const realResolved = resolve(real);
      if (pathComparisonKey(realResolved) !== pathComparisonKey(resolve(path))) {
        throw new Error(
          `untrusted ${label}: reparse point target mismatch: ${path}`,
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && /reparse|symlink|junction|untrusted/i.test(error.message)) {
      throw error;
    }
  }
}

function assertWindowsAbsoluteDataPath(input: string, label: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must be a nonempty path`);
  }
  if (
    containsTraversalSegment(trimmed)
    || trimmed.includes('..')
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed)
  ) {
    throw new Error(`${label} must not contain path traversal`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  // Reject device namespaces and UNC for LOCALAPPDATA durability.
  if (
    /^\\\\[.?]\\/i.test(trimmed)
    || /^\\\\\?/i.test(trimmed)
    || /^\/\//.test(trimmed)
  ) {
    throw new Error(`${label} must not use device or UNC namespace paths`);
  }
  if (process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    if (!/^[A-Za-z]:[\\/]/.test(trimmed)) {
      throw new Error(`${label} must be a drive-letter absolute path`);
    }
  }
  const normalized = resolve(normalize(trimmed));
  const leaf = parse(normalized).base;
  if (WINDOWS_RESERVED_NAMES.has(leaf.toLocaleLowerCase('en-US'))) {
    throw new Error(`${label} uses a reserved device name: ${leaf}`);
  }
  return normalized;
}

/**
 * Validate every existing ancestor is not a reparse/symlink before creation.
 */
function assertSafeAncestorChain(target: string): void {
  const absolute = resolve(target);
  const parts: string[] = [];
  let current = absolute;
  for (;;) {
    parts.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Walk from root toward leaf.
  for (const part of parts.reverse()) {
    if (!existsSync(part)) continue;
    assertNotReparse(part, 'ancestor path');
  }
}

function assertContained(parent: string, child: string, label: string): void {
  const parentKey = pathComparisonKey(resolve(parent));
  const childKey = pathComparisonKey(resolve(child));
  if (childKey === parentKey) return;
  const prefix = parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`;
  if (!childKey.startsWith(prefix)) {
    throw new Error(
      `untrusted ${label}: path escapes durable root containment`,
    );
  }
}

function ensureTrustedDirectory(path: string, root: string): void {
  assertSafeAncestorChain(path);
  mkdirSync(path, { recursive: true });
  assertNotReparse(path, 'created directory');
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch (error) {
    throw new Error(`failed to resolve canonical path for ${path}`, {
      cause: error,
    });
  }
  assertContained(root, real, 'created directory');
  // Identity: after mkdir, re-validate path is still not a reparse swap.
  assertNotReparse(real, 'canonical directory');
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o700);
    } catch {
      // Best-effort restrictive permissions where supported.
    }
  }
}

function assertTrustedRootCandidate(candidate: string, label: string): string {
  const resolved = assertWindowsAbsoluteDataPath(candidate, label);
  // Refuse cwd as durable app data.
  const cwd = resolve(process.cwd());
  if (pathComparisonKey(resolved) === pathComparisonKey(cwd)) {
    throw new Error(
      `untrusted ${label}: cwd must not be used as durable app data root`,
    );
  }
  if (existsSync(resolved)) {
    assertNotReparse(resolved, label);
    const stats = lstatSync(resolved);
    if (!stats.isDirectory()) {
      throw new Error(`untrusted ${label}: path is not a directory: ${resolved}`);
    }
    try {
      const real = realpathSync.native(resolved);
      if (pathComparisonKey(real) !== pathComparisonKey(resolved)) {
        throw new Error(
          `untrusted ${label}: reparse/junction target mismatch: ${resolved}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error
        && /reparse|symlink|junction|untrusted/i.test(error.message)
      ) {
        throw error;
      }
    }
  } else {
    assertSafeAncestorChain(resolved);
  }
  return resolved;
}

function defaultAppRoot(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (process.platform === 'win32') {
    const localAppData = environmentValue(environment, 'LOCALAPPDATA');
    if (localAppData === undefined) {
      throw new Error(
        'LOCALAPPDATA is not set; cannot resolve %LOCALAPPDATA%\\TriAgent durable app root',
      );
    }
    const validated = assertTrustedRootCandidate(localAppData, 'LOCALAPPDATA');
    return join(validated, 'TriAgent');
  }
  // Non-Windows: still validate absolute data home; never cwd.
  const xdg = environmentValue(environment, 'XDG_DATA_HOME');
  if (xdg !== undefined) {
    if (!isAbsolute(xdg) || containsTraversalSegment(xdg) || xdg.includes('..')) {
      throw new Error('XDG_DATA_HOME must be a trusted absolute path');
    }
    return join(resolve(xdg), 'TriAgent');
  }
  return join(homedir(), '.local', 'share', 'TriAgent');
}

/**
 * Resolve durable TriAgent application paths.
 * Credentials/tokens must never be stored under these paths by design.
 */
export function resolveAppPaths(
  options: ResolveAppPathsOptions = {},
): AppPaths {
  const environment = options.environment ?? process.env;
  const envOverride = environmentValue(environment, 'TRIAGENT_APP_ROOT');
  const rawOverride = options.appRootOverride ?? envOverride;

  let root: string;
  if (rawOverride !== undefined) {
    root = assertTrustedRootCandidate(rawOverride, 'app root override');
  } else {
    root = resolve(defaultAppRoot(environment));
    if (containsTraversalSegment(root) || root.includes('..')) {
      throw new Error('resolved app root contains traversal segments');
    }
    // Re-validate computed TriAgent root (may not exist yet).
    root = assertTrustedRootCandidate(root, 'app root');
  }

  const paths: AppPaths = Object.freeze({
    root,
    databasePath: join(root, 'triagent.db'),
    logsDirectory: join(root, 'logs'),
    snapshotsDirectory: join(root, 'snapshots'),
    implementationWorkspacesDirectory: join(root, 'implementation-workspaces'),
    nativeDiagnosticsDirectory: join(root, 'native-diagnostics'),
    settingsPath: join(root, 'settings.json'),
    cliCompatibilityCachePath: join(root, 'cli-compatibility-cache.json'),
  });

  if (options.createDirectories !== false) {
    ensureTrustedDirectory(paths.root, paths.root);
    ensureTrustedDirectory(paths.logsDirectory, paths.root);
    ensureTrustedDirectory(paths.snapshotsDirectory, paths.root);
    ensureTrustedDirectory(paths.implementationWorkspacesDirectory, paths.root);
    ensureTrustedDirectory(paths.nativeDiagnosticsDirectory, paths.root);
    // Post-create canonical identity checks for root + children.
    for (const directory of [
      paths.root,
      paths.logsDirectory,
      paths.snapshotsDirectory,
      paths.implementationWorkspacesDirectory,
      paths.nativeDiagnosticsDirectory,
    ]) {
      const real = realpathSync.native(directory);
      assertContained(paths.root, real, 'app data directory');
      assertNotReparse(real, 'app data directory');
    }
  }

  return paths;
}
