import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

import {
  inspectInputReparsePoints,
  type ReparsePointEvidence,
  type ReparsePointProbe,
} from './reparse-points.js';

export type ProjectPathFlavor = 'windows' | 'posix';

export interface CanonicalProjectPath {
  readonly displayPath: string;
  readonly absolutePath: string;
  readonly realPath: string;
  readonly canonicalRoot: string;
  readonly comparisonKey: string;
  readonly pathFlavor: ProjectPathFlavor;
  readonly traversedReparsePoint: boolean;
  readonly reparsePoints: readonly ReparsePointEvidence[];
}

export class UnsupportedWindowsNamespace extends Error {
  public override readonly name = 'UnsupportedWindowsNamespace';

  public constructor(input: string) {
    super(`UnsupportedWindowsNamespace: unsupported Windows device namespace: ${input}`);
  }
}

function stripWindowsNamespace(input: string): string {
  const normalized = input.replaceAll('/', '\\');
  const lower = normalized.toLocaleLowerCase('en-US');
  if (lower.startsWith('\\\\.\\') || lower.startsWith('\\??\\')) {
    throw new UnsupportedWindowsNamespace(input);
  }
  if (!lower.startsWith('\\\\?\\')) return normalized;

  const namespacedPath = normalized.slice(4);
  if (/^[A-Za-z]:\\(?:.*)?$/.test(namespacedPath)) {
    return namespacedPath;
  }
  const uncMatch = /^UNC\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/i.exec(
    namespacedPath,
  );
  if (uncMatch !== null) {
    const remainder = uncMatch[3];
    return `\\\\${uncMatch[1]}\\${uncMatch[2]}${remainder === undefined ? '' : `\\${remainder}`}`;
  }
  throw new UnsupportedWindowsNamespace(input);
}

function trimTrailingSeparators(input: string, flavor: ProjectPathFlavor): string {
  const implementation = flavor === 'windows' ? path.win32 : path.posix;
  const parsed = implementation.parse(input);
  let result = input;
  while (
    result.length > parsed.root.length &&
    (result.endsWith('/') || result.endsWith('\\'))
  ) {
    result = result.slice(0, -1);
  }
  return result;
}

function readablePath(input: string): string {
  if (process.platform !== 'win32') return trimTrailingSeparators(input, 'posix');
  return trimTrailingSeparators(stripWindowsNamespace(input), 'windows');
}

export function windowsPathComparisonKey(input: string): string {
  const withoutNamespace = stripWindowsNamespace(input);
  const normalized = trimTrailingSeparators(
    path.win32.normalize(withoutNamespace.replaceAll('/', '\\')),
    'windows',
  );
  return normalized.toLocaleLowerCase('en-US');
}

function posixPathComparisonKey(input: string): string {
  return trimTrailingSeparators(path.posix.normalize(input), 'posix');
}

export function canonicalizeProjectPath(
  inputPath: string,
  options: {
    readonly cwd?: string;
    readonly reparseProbe?: ReparsePointProbe;
  } = {},
): CanonicalProjectPath {
  if (inputPath.trim().length === 0) {
    throw new Error('project path must not be empty');
  }

  const cwd = options.cwd ?? process.cwd();
  const pathFlavor: ProjectPathFlavor =
    process.platform === 'win32' ? 'windows' : 'posix';
  const inputForResolution =
    pathFlavor === 'windows' ? stripWindowsNamespace(inputPath) : inputPath;
  const absolutePath = readablePath(path.resolve(cwd, inputForResolution));
  const reparsePoints = inspectInputReparsePoints(absolutePath, {
    probe: options.reparseProbe,
  }).map((evidence) => ({
    ...evidence,
    inputPath: readablePath(evidence.inputPath),
    targetPath: readablePath(evidence.targetPath),
    reportedTargets: evidence.reportedTargets.map(readablePath),
  }));

  let realPath: string;
  try {
    realPath = readablePath(realpathSync.native(absolutePath));
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      throw new Error(`project path does not exist: ${inputPath}`, { cause: error });
    }
    throw error;
  }
  if (!lstatSync(realPath).isDirectory()) {
    throw new Error(`project path is not a directory: ${inputPath}`);
  }

  return {
    displayPath: inputPath,
    absolutePath,
    realPath,
    canonicalRoot: realPath,
    comparisonKey:
      pathFlavor === 'windows'
        ? windowsPathComparisonKey(realPath)
        : posixPathComparisonKey(realPath),
    pathFlavor,
    traversedReparsePoint: reparsePoints.length > 0,
    reparsePoints,
  };
}

function comparisonKey(
  input: string,
  flavor: ProjectPathFlavor,
): string {
  return flavor === 'windows'
    ? windowsPathComparisonKey(input)
    : posixPathComparisonKey(input);
}

function isSameOrChild(
  parent: string,
  candidate: string,
  flavor: ProjectPathFlavor,
): boolean {
  const implementation = flavor === 'windows' ? path.win32 : path.posix;
  const relativePath = implementation.relative(parent, candidate);
  return (
    relativePath.length === 0 ||
    (!implementation.isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${implementation.sep}`))
  );
}

export function areProjectRootsOverlapping(
  leftRoot: string,
  rightRoot: string,
  flavor: ProjectPathFlavor = process.platform === 'win32' ? 'windows' : 'posix',
): boolean {
  const left = comparisonKey(leftRoot, flavor);
  const right = comparisonKey(rightRoot, flavor);
  return isSameOrChild(left, right, flavor) || isSameOrChild(right, left, flavor);
}
