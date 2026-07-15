import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

import {
  UnsupportedWindowsNamespace,
  windowsPathComparisonKey,
} from '../project/canonical-path.js';
import {
  inspectInputReparsePoints,
  type ReparsePointEvidence,
} from '../project/reparse-points.js';

/** Windows reserved DOS device names (per path component). */
const WINDOWS_DOS_DEVICE =
  /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type ProjectPathFlavor = 'windows' | 'posix';

export interface PathEvidence {
  readonly projectRoot: string;
  readonly absolutePath: string;
  readonly realPath: string | null;
  readonly comparisonKey: string | null;
  readonly reparsePoints: readonly ReparsePointEvidence[];
  readonly notes: readonly string[];
}

export type PathEvaluation =
  | {
      readonly allowed: true;
      readonly insideProject: true;
      readonly relativePath: string;
      readonly absolutePath: string;
      readonly realPath: string;
      readonly traversedReparsePoint: boolean;
      readonly evidence: PathEvidence;
    }
  | {
      readonly allowed: false;
      readonly insideProject: boolean;
      readonly failClosed: true;
      readonly reason: string;
      readonly absolutePath?: string;
      readonly realPath?: string | null;
      readonly traversedReparsePoint?: boolean;
      readonly evidence: PathEvidence;
    };

export interface CommandPathEvaluation {
  readonly cwd: PathEvaluation;
  readonly arguments: readonly PathEvaluation[];
  readonly allInsideProject: boolean;
  readonly failClosed: boolean;
}

export interface PathEvaluateOptions {
  readonly provenanceUnknown?: boolean;
  readonly hardLinkRisk?: boolean;
  readonly finalTargetUnprovable?: boolean;
  readonly mustExist?: boolean;
}

function pathFlavor(): ProjectPathFlavor {
  return process.platform === 'win32' ? 'windows' : 'posix';
}

function implementation(flavor: ProjectPathFlavor) {
  return flavor === 'windows' ? path.win32 : path.posix;
}

function comparisonKey(input: string, flavor: ProjectPathFlavor): string {
  return flavor === 'windows'
    ? windowsPathComparisonKey(input)
    : path.posix.normalize(input);
}

function stripTrailingSeparators(input: string, flavor: ProjectPathFlavor): string {
  const impl = implementation(flavor);
  const parsed = impl.parse(input);
  let result = input;
  while (
    result.length > parsed.root.length &&
    (result.endsWith('/') || result.endsWith('\\'))
  ) {
    result = result.slice(0, -1);
  }
  return result;
}

function isSameOrChild(
  parent: string,
  candidate: string,
  flavor: ProjectPathFlavor,
): boolean {
  const impl = implementation(flavor);
  const relativePath = impl.relative(parent, candidate);
  return (
    relativePath.length === 0 ||
    (!impl.isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${impl.sep}`))
  );
}

function looksLikeWindowsAds(candidate: string): boolean {
  // Alternate Data Stream: file.ext:stream — not a drive letter prefix.
  if (!candidate.includes(':')) return false;
  if (/^[A-Za-z]:[\\/]/.test(candidate)) {
    // Drive-letter absolute path may still contain ADS after the path.
    const withoutDrive = candidate.slice(2);
    return /:[^\\/]+$/.test(withoutDrive) || withoutDrive.includes(':');
  }
  return /:[^\\/]+$/.test(candidate) || /\\[^\\/]+:[^\\/]+/.test(candidate);
}

function looksLikeDeviceNamespace(candidate: string): boolean {
  const normalized = candidate.replaceAll('/', '\\');
  const lower = normalized.toLocaleLowerCase('en-US');
  return (
    lower.startsWith('\\\\.\\') ||
    lower.startsWith('\\??\\') ||
    lower.startsWith('\\\\?\\globalroot\\') ||
    lower.startsWith('\\\\?\\volume{') ||
    lower.includes('\\device\\')
  );
}

function stripTrailingDotsAndSpaces(component: string): string {
  let value = component;
  while (value.endsWith('.') || value.endsWith(' ')) {
    value = value.slice(0, -1);
  }
  return value;
}

/**
 * Reject reserved Windows DOS device names in any path component, including
 * extension / trailing-dot / trailing-space / case variants (NUL, CON, COM1, …).
 */
function containsWindowsDosDeviceComponent(candidate: string): boolean {
  const normalized = candidate.replaceAll('/', '\\');
  // Skip drive-letter prefix for absolute paths (C:).
  const withoutDrive = /^[A-Za-z]:/.test(normalized)
    ? normalized.slice(2)
    : normalized;
  const parts = withoutDrive.split('\\').filter((part) => part.length > 0);
  for (const part of parts) {
    // Drop ADS suffix if present for component check.
    const beforeColon = part.includes(':') ? part.slice(0, part.indexOf(':')) : part;
    const cleaned = stripTrailingDotsAndSpaces(beforeColon);
    if (cleaned.length === 0) continue;
    if (WINDOWS_DOS_DEVICE.test(cleaned)) return true;
  }
  return false;
}

function hardLinkRiskOnExistingTarget(absolutePath: string): {
  readonly risk: boolean;
  readonly nlink: number | null;
  readonly reason: string | null;
} {
  try {
    if (!existsSync(absolutePath)) {
      return { risk: false, nlink: null, reason: null };
    }
    const stats = lstatSync(absolutePath);
    if (!stats.isFile()) {
      return { risk: false, nlink: stats.nlink, reason: null };
    }
    // Multi-link / hard-link provenance is unprovable for project containment:
    // an inside name may share an inode with an outside path.
    if (stats.nlink > 1) {
      return {
        risk: true,
        nlink: stats.nlink,
        reason:
          'hard-link / multi-link provenance on final target fails closed (nlink>1)',
      };
    }
    return { risk: false, nlink: stats.nlink, reason: null };
  } catch (error) {
    return {
      risk: true,
      nlink: null,
      reason: `final-target hard-link inspection failed closed: ${String(error)}`,
    };
  }
}

function emptyEvidence(projectRoot: string, notes: readonly string[] = []): PathEvidence {
  return {
    projectRoot,
    absolutePath: '',
    realPath: null,
    comparisonKey: null,
    reparsePoints: [],
    notes,
  };
}

export class PathPolicy {
  readonly #projectRoot: string;
  readonly #projectKey: string;
  readonly #flavor: ProjectPathFlavor;
  readonly #reparseCache = new Map<string, readonly ReparsePointEvidence[]>();

  public constructor(options: { readonly projectRoot: string }) {
    if (options.projectRoot.trim().length === 0) {
      throw new Error('projectRoot must not be empty');
    }
    this.#flavor = pathFlavor();
    const absolute = stripTrailingSeparators(
      path.resolve(options.projectRoot),
      this.#flavor,
    );
    if (!existsSync(absolute) || !lstatSync(absolute).isDirectory()) {
      throw new Error(`projectRoot is not an existing directory: ${options.projectRoot}`);
    }
    let realRoot: string;
    try {
      realRoot = stripTrailingSeparators(realpathSync.native(absolute), this.#flavor);
    } catch (error) {
      throw new Error(`projectRoot cannot be resolved: ${options.projectRoot}`, {
        cause: error,
      });
    }
    this.#projectRoot = realRoot;
    this.#projectKey = comparisonKey(realRoot, this.#flavor);
  }

  public get projectRoot(): string {
    return this.#projectRoot;
  }

  public evaluatePath(
    candidate: string,
    options: PathEvaluateOptions = {},
  ): PathEvaluation {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason: 'path candidate is empty or invalid',
        evidence: emptyEvidence(this.#projectRoot, ['empty-candidate']),
      };
    }

    if (options.provenanceUnknown) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason: 'unknown path provenance fails closed',
        evidence: emptyEvidence(this.#projectRoot, ['provenance-unknown']),
      };
    }

    if (options.hardLinkRisk || options.finalTargetUnprovable) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason:
          'hard-link or final-target risk is unprovable; path evaluation fails closed',
        evidence: emptyEvidence(this.#projectRoot, [
          options.hardLinkRisk ? 'hard-link-risk' : 'final-target-unprovable',
        ]),
      };
    }

    if (looksLikeDeviceNamespace(candidate)) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason: 'device or unsupported namespace path is denied',
        evidence: emptyEvidence(this.#projectRoot, ['device-namespace']),
      };
    }

    if (this.#flavor === 'windows' && containsWindowsDosDeviceComponent(candidate)) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason: 'Windows DOS device name is reserved and unsupported',
        evidence: emptyEvidence(this.#projectRoot, ['dos-device']),
      };
    }

    if (this.#flavor === 'windows' && looksLikeWindowsAds(candidate)) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason: 'alternate data stream (ADS) or device-style path is unsupported',
        evidence: emptyEvidence(this.#projectRoot, ['ads-or-device']),
      };
    }

    let absolutePath: string;
    try {
      if (this.#flavor === 'windows') {
        // Trigger UnsupportedWindowsNamespace for \\?\ device forms via comparison key.
        try {
          windowsPathComparisonKey(candidate);
        } catch (error) {
          if (error instanceof UnsupportedWindowsNamespace) {
            return {
              allowed: false,
              insideProject: false,
              failClosed: true,
              reason: `unsupported Windows device namespace: ${candidate}`,
              evidence: emptyEvidence(this.#projectRoot, ['unsupported-namespace']),
            };
          }
          throw error;
        }
      }
      absolutePath = stripTrailingSeparators(
        path.resolve(this.#projectRoot, candidate),
        this.#flavor,
      );
    } catch (error) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason: `path resolution failed: ${String(error)}`,
        evidence: emptyEvidence(this.#projectRoot, ['resolve-failed']),
      };
    }

    // Reject absolute candidates that are not under the project before realpath.
    const absoluteKey = comparisonKey(absolutePath, this.#flavor);
    if (
      path.isAbsolute(candidate) &&
      !isSameOrChild(this.#projectKey, absoluteKey, this.#flavor)
    ) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason: 'absolute path is outside the project root',
        absolutePath,
        realPath: null,
        evidence: {
          projectRoot: this.#projectRoot,
          absolutePath,
          realPath: null,
          comparisonKey: absoluteKey,
          reparsePoints: [],
          notes: ['absolute-outside'],
        },
      };
    }

    // Lexical parent escape before filesystem resolution.
    const impl = implementation(this.#flavor);
    const lexicalRelative = impl.relative(this.#projectRoot, absolutePath);
    if (
      impl.isAbsolute(lexicalRelative) ||
      lexicalRelative === '..' ||
      lexicalRelative.startsWith(`..${impl.sep}`)
    ) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason: 'path escapes the project root via traversal',
        absolutePath,
        realPath: null,
        evidence: {
          projectRoot: this.#projectRoot,
          absolutePath,
          realPath: null,
          comparisonKey: absoluteKey,
          reparsePoints: [],
          notes: ['lexical-escape'],
        },
      };
    }

    let reparsePoints: readonly ReparsePointEvidence[] = [];
    let realPath: string | null = null;
    const notes: string[] = [];

    const exists = existsSync(absolutePath);
    if (!exists) {
      // For create operations, require every existing ancestor to stay inside the project.
      let cursor = absolutePath;
      while (
        cursor.length > 0 &&
        comparisonKey(cursor, this.#flavor) !== this.#projectKey &&
        !existsSync(cursor)
      ) {
        const parent = stripTrailingSeparators(path.dirname(cursor), this.#flavor);
        if (parent === cursor) break;
        cursor = parent;
      }
      if (existsSync(cursor)) {
        const inspected = this.#inspectReparse(cursor, notes);
        reparsePoints = inspected;
        try {
          realPath = stripTrailingSeparators(
            path.resolve(
              realpathSync.native(cursor),
              path.relative(cursor, absolutePath),
            ),
            this.#flavor,
          );
        } catch {
          realPath = absolutePath;
          notes.push('ancestor-realpath-fallback');
        }
      } else {
        realPath = absolutePath;
      }
    } else {
      reparsePoints = this.#inspectReparse(absolutePath, notes);
      try {
        realPath = stripTrailingSeparators(
          realpathSync.native(absolutePath),
          this.#flavor,
        );
      } catch (error) {
        return {
          allowed: false,
          insideProject: false,
          failClosed: true,
          reason: `realpath failed closed: ${String(error)}`,
          absolutePath,
          evidence: {
            projectRoot: this.#projectRoot,
            absolutePath,
            realPath: null,
            comparisonKey: absoluteKey,
            reparsePoints,
            notes: [...notes, 'realpath-failed'],
          },
        };
      }
    }

    const finalPath = realPath ?? absolutePath;
    const finalKey = comparisonKey(finalPath, this.#flavor);
    const inside = isSameOrChild(this.#projectKey, finalKey, this.#flavor);
    const traversedReparsePoint = reparsePoints.length > 0;

    if (!inside) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason: traversedReparsePoint
          ? 'symlink/junction/reparse target resolves outside the project'
          : 'path resolves outside the project root',
        absolutePath,
        realPath,
        traversedReparsePoint,
        evidence: {
          projectRoot: this.#projectRoot,
          absolutePath,
          realPath,
          comparisonKey: finalKey,
          reparsePoints,
          notes: [...notes, 'outside-final-target'],
        },
      };
    }

    // Inspect the existing final target itself for multi-link / hard-link provenance.
    // Do not auto-allow an inside path that may share an inode with an outside file.
    const inspectTargets = new Set<string>([absolutePath, finalPath]);
    for (const target of inspectTargets) {
      const hardLink = hardLinkRiskOnExistingTarget(target);
      if (hardLink.risk) {
        return {
          allowed: false,
          insideProject: true,
          failClosed: true,
          reason:
            hardLink.reason ??
            'hard-link or multi-link provenance fails closed on final target',
          absolutePath,
          realPath,
          traversedReparsePoint,
          evidence: {
            projectRoot: this.#projectRoot,
            absolutePath,
            realPath,
            comparisonKey: finalKey,
            reparsePoints,
            notes: [
              ...notes,
              'hard-link-risk',
              hardLink.nlink === null ? 'nlink-unknown' : `nlink=${hardLink.nlink}`,
            ],
          },
        };
      }
    }

    // Any reparse on the path must also resolve inside the project (already checked via realpath).
    for (const evidence of reparsePoints) {
      const targetKey = comparisonKey(evidence.targetPath, this.#flavor);
      if (!isSameOrChild(this.#projectKey, targetKey, this.#flavor)) {
        return {
          allowed: false,
          insideProject: false,
          failClosed: true,
          reason: 'reparse-point target escapes the project root',
          absolutePath,
          realPath,
          traversedReparsePoint: true,
          evidence: {
            projectRoot: this.#projectRoot,
            absolutePath,
            realPath,
            comparisonKey: finalKey,
            reparsePoints,
            notes: [...notes, 'reparse-target-outside'],
          },
        };
      }
    }

    const relativePath = implementation(this.#flavor)
      .relative(this.#projectRoot, finalPath)
      .split(implementation(this.#flavor).sep)
      .join('/');

    if (
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath) ||
      relativePath.includes('\0')
    ) {
      return {
        allowed: false,
        insideProject: false,
        failClosed: true,
        reason: 'computed relative path is unsafe',
        absolutePath,
        realPath,
        traversedReparsePoint,
        evidence: {
          projectRoot: this.#projectRoot,
          absolutePath,
          realPath,
          comparisonKey: finalKey,
          reparsePoints,
          notes: [...notes, 'unsafe-relative'],
        },
      };
    }

    return {
      allowed: true,
      insideProject: true,
      relativePath: relativePath.length === 0 ? '.' : relativePath,
      absolutePath,
      realPath: finalPath,
      traversedReparsePoint,
      evidence: {
        projectRoot: this.#projectRoot,
        absolutePath,
        realPath: finalPath,
        comparisonKey: finalKey,
        reparsePoints,
        notes,
      },
    };
  }

  public evaluateCommandPaths(input: {
    readonly cwd: string;
    readonly pathArguments?: readonly string[];
  }): CommandPathEvaluation {
    const cwd = this.evaluatePath(input.cwd);
    const pathArguments = input.pathArguments ?? [];
    const argumentsEvaluated = pathArguments.map((entry) => this.evaluatePath(entry));
    const allInsideProject =
      cwd.allowed && argumentsEvaluated.every((entry) => entry.allowed);
    return {
      cwd,
      arguments: argumentsEvaluated,
      allInsideProject,
      failClosed: !allInsideProject,
    };
  }

  /**
   * Prefer a fast lstat/readlink walk. Escalate to the full Windows reparse probe only when
   * a reparse/symlink is observed or realpath diverges. Cache by comparison key.
   * Outside targets still fail closed via realpath containment checks.
   */
  #inspectReparse(absolutePath: string, notes: string[]): readonly ReparsePointEvidence[] {
    const key = comparisonKey(absolutePath, this.#flavor);
    const cached = this.#reparseCache.get(key);
    if (cached !== undefined) return cached;

    // Project root itself was already proven at construction; no reparse walk needed.
    if (key === this.#projectKey) {
      this.#reparseCache.set(key, []);
      return [];
    }

    const fast = this.#fallbackReparseEvidence(absolutePath);
    if (fast.length === 0) {
      // No symlink ancestors visible via lstat. Still check realpath divergence.
      try {
        const real = stripTrailingSeparators(
          realpathSync.native(absolutePath),
          this.#flavor,
        );
        if (comparisonKey(real, this.#flavor) === key) {
          this.#reparseCache.set(key, []);
          return [];
        }
      } catch {
        // missing path components handled by caller
        this.#reparseCache.set(key, []);
        return [];
      }
    }

    let evidence = fast;
    if (process.platform === 'win32') {
      try {
        evidence = inspectInputReparsePoints(absolutePath);
      } catch {
        notes.push('reparse-probe-fallback');
        evidence = fast;
      }
    }
    this.#reparseCache.set(key, evidence);
    return evidence;
  }

  #fallbackReparseEvidence(absolutePath: string): readonly ReparsePointEvidence[] {
    const evidence: ReparsePointEvidence[] = [];
    const root = path.parse(absolutePath).root;
    const parts = path
      .relative(root, absolutePath)
      .split(path.sep)
      .filter((part) => part.length > 0);
    let current = root;
    for (const part of parts) {
      current = path.resolve(current, part);
      try {
        const stats = lstatSync(current);
        if (!stats.isSymbolicLink()) continue;
        let targetPath = current;
        try {
          targetPath = realpathSync.native(current);
        } catch {
          // keep current
        }
        let linkTarget: string | null = null;
        try {
          linkTarget = readlinkSync(current);
        } catch {
          linkTarget = null;
        }
        evidence.push({
          inputPath: current,
          targetPath,
          linkTarget,
          reportedTargets: linkTarget === null ? [] : [linkTarget],
          attributes: ['SymbolicLink'],
          linkType: 'SymbolicLink',
          kind:
            process.platform === 'win32'
              ? 'junction-or-directory-symbolic-link'
              : 'symbolic-link',
        });
      } catch {
        break;
      }
    }
    return evidence;
  }
}
