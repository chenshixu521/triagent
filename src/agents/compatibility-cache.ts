import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  extname,
  isAbsolute,
  resolve,
} from 'node:path';

import type {
  CompatibilityCliName,
  CompatibilityKey,
} from './compatibility-matrix.js';
import { resolveWindowsAgentExecutable } from '../process/windows-agent-cli-resolver.js';

export const COMPATIBILITY_CACHE_SCHEMA_VERSION = 1 as const;
export const MAX_COMPATIBILITY_CACHE_BYTES = 256 * 1024;
export const MAX_COMPATIBILITY_CACHE_ENTRIES = 32;

export interface ExecutableIdentity {
  readonly configuredExecutable: string;
  readonly resolvedPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

export interface ExecutableIdentityRequest {
  readonly executable: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
}

export type ExecutableIdentityProvider = (
  request: ExecutableIdentityRequest,
) => Promise<ExecutableIdentity>;

export interface CompatibilityCacheReceipt {
  readonly cliName: CompatibilityCliName;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly executableIdentity: ExecutableIdentity;
  readonly probeContractHash: string;
  readonly verifiedAtMs: number;
  readonly expiresAtMs: number;
}

interface CompatibilityCacheDocument {
  readonly schemaVersion: typeof COMPATIBILITY_CACHE_SCHEMA_VERSION;
  readonly entries: readonly CompatibilityCacheReceipt[];
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const direct = environment[name];
  if (direct !== undefined) return direct;
  const match = Object.entries(environment).find(
    ([key]) => key.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'),
  );
  return match?.[1];
}

function executableCandidates(
  executable: string,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
  platform: NodeJS.Platform,
): readonly string[] {
  const trimmed = executable.trim();
  if (trimmed.length === 0) return [];
  const hasDirectory = isAbsolute(trimmed) || /[\\/]/.test(trimmed);
  const roots = hasDirectory
    ? ['']
    : (environmentValue(environment, 'PATH') ?? '')
      .split(delimiter)
      .map((part) => part.trim().replace(/^"|"$/g, ''))
      .filter((part) => part.length > 0);
  const extensions = platform === 'win32' && extname(trimmed).length === 0
    ? (environmentValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    : [''];
  const candidates: string[] = [];
  for (const root of roots) {
    const base = hasDirectory
      ? (isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed))
      : resolve(root, trimmed);
    for (const extension of extensions) {
      candidates.push(`${base}${extension}`);
    }
  }
  return candidates;
}

async function sha256File(path: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

export async function resolveExecutableIdentity(
  request: ExecutableIdentityRequest,
): Promise<ExecutableIdentity> {
  const environment = request.environment ?? process.env;
  const cwd = request.cwd ?? process.cwd();
  const platform = request.platform ?? process.platform;
  const agentExecutable = resolveWindowsAgentExecutable({
    executable: request.executable,
    environment,
    cwd,
    platform,
  });
  const candidates = agentExecutable === undefined
    ? executableCandidates(
      request.executable,
      environment,
      cwd,
      platform,
    )
    : [agentExecutable.resolvedPath];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync.native(candidate);
    const status = statSync(canonical);
    if (!status.isFile()) continue;
    return Object.freeze({
      configuredExecutable: request.executable.trim(),
      resolvedPath: canonical,
      size: status.size,
      mtimeMs: status.mtimeMs,
      sha256: await sha256File(canonical),
    });
  }
  throw new Error(`cannot resolve executable identity: ${request.executable}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseIdentity(value: unknown): ExecutableIdentity | undefined {
  if (!isPlainObject(value)) return undefined;
  if (
    typeof value.configuredExecutable !== 'string'
    || value.configuredExecutable.trim().length === 0
    || typeof value.resolvedPath !== 'string'
    || value.resolvedPath.trim().length === 0
    || !isFiniteNonNegative(value.size)
    || !isFiniteNonNegative(value.mtimeMs)
    || !isSha256(value.sha256)
  ) {
    return undefined;
  }
  return Object.freeze({
    configuredExecutable: value.configuredExecutable,
    resolvedPath: value.resolvedPath,
    size: value.size,
    mtimeMs: value.mtimeMs,
    sha256: value.sha256.toLocaleLowerCase('en-US'),
  });
}

function parseReceipt(value: unknown): CompatibilityCacheReceipt | undefined {
  if (!isPlainObject(value)) return undefined;
  if (
    (value.cliName !== 'codex' && value.cliName !== 'claude' && value.cliName !== 'grok')
    || typeof value.version !== 'string'
    || value.version.trim().length === 0
    || typeof value.platform !== 'string'
    || !isSha256(value.probeContractHash)
    || !isFiniteNonNegative(value.verifiedAtMs)
    || !isFiniteNonNegative(value.expiresAtMs)
    || value.expiresAtMs < value.verifiedAtMs
  ) {
    return undefined;
  }
  const executableIdentity = parseIdentity(value.executableIdentity);
  if (executableIdentity === undefined) return undefined;
  return Object.freeze({
    cliName: value.cliName,
    version: value.version,
    platform: value.platform as NodeJS.Platform,
    executableIdentity,
    probeContractHash: value.probeContractHash.toLocaleLowerCase('en-US'),
    verifiedAtMs: value.verifiedAtMs,
    expiresAtMs: value.expiresAtMs,
  });
}

export function loadCompatibilityCache(
  cachePath: string,
): readonly CompatibilityCacheReceipt[] {
  try {
    if (!existsSync(cachePath)) return Object.freeze([]);
    const status = lstatSync(cachePath);
    if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_COMPATIBILITY_CACHE_BYTES) {
      return Object.freeze([]);
    }
    const parsed: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (!isPlainObject(parsed) || parsed.schemaVersion !== COMPATIBILITY_CACHE_SCHEMA_VERSION) {
      return Object.freeze([]);
    }
    if (!Array.isArray(parsed.entries) || parsed.entries.length > MAX_COMPATIBILITY_CACHE_ENTRIES) {
      return Object.freeze([]);
    }
    const entries: CompatibilityCacheReceipt[] = [];
    for (const value of parsed.entries) {
      const receipt = parseReceipt(value);
      if (receipt === undefined) return Object.freeze([]);
      entries.push(receipt);
    }
    return Object.freeze(entries);
  } catch {
    return Object.freeze([]);
  }
}

export function executableIdentitiesEqual(
  a: ExecutableIdentity,
  b: ExecutableIdentity,
): boolean {
  const pathA = process.platform === 'win32'
    ? a.resolvedPath.toLocaleLowerCase('en-US')
    : a.resolvedPath;
  const pathB = process.platform === 'win32'
    ? b.resolvedPath.toLocaleLowerCase('en-US')
    : b.resolvedPath;
  return a.configuredExecutable === b.configuredExecutable
    && pathA === pathB
    && a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.sha256 === b.sha256;
}

export function receiptMatches(
  receipt: CompatibilityCacheReceipt,
  input: {
    readonly key: CompatibilityKey;
    readonly executableIdentity: ExecutableIdentity;
    readonly probeContractHash: string;
    readonly nowMs: number;
  },
): boolean {
  return receipt.cliName === input.key.cliName
    && receipt.version === input.key.version
    && receipt.platform === input.key.platform
    && receipt.probeContractHash === input.probeContractHash
    && receipt.verifiedAtMs <= input.nowMs
    && receipt.expiresAtMs >= input.nowMs
    && executableIdentitiesEqual(
      receipt.executableIdentity,
      input.executableIdentity,
    );
}

function boundedEntries(
  entries: readonly CompatibilityCacheReceipt[],
): readonly CompatibilityCacheReceipt[] {
  return [...entries]
    .sort((a, b) => b.verifiedAtMs - a.verifiedAtMs)
    .slice(0, MAX_COMPATIBILITY_CACHE_ENTRIES);
}

export function saveCompatibilityCache(
  cachePath: string,
  entries: readonly CompatibilityCacheReceipt[],
): void {
  const document: CompatibilityCacheDocument = {
    schemaVersion: COMPATIBILITY_CACHE_SCHEMA_VERSION,
    entries: boundedEntries(entries),
  };
  const payload = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_COMPATIBILITY_CACHE_BYTES) {
    throw new Error('compatibility cache exceeds size limit');
  }
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, payload, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, cachePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Best-effort descriptor cleanup before rethrow.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Nothing to clean or cleanup already completed.
    }
    throw error;
  }
}
