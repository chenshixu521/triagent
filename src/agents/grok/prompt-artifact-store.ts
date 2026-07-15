import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from 'node:path';

/** Hard bound for prompt-file content (512 KiB). */
export const PROMPT_ARTIFACT_MAX_BYTES = 512 * 1024;

/** Bounded retries when unlink hits EPERM/EACCES before fail-closed. */
export const PROMPT_ARTIFACT_CLEANUP_MAX_ATTEMPTS = 5;

export class PromptArtifactStoreError extends Error {
  public override readonly name = 'PromptArtifactStoreError';
  public readonly code = 'PromptArtifactStoreError' as const;

  public constructor(reason: string) {
    super(reason);
  }
}

/**
 * Cleanup result for sensitive prompt artifacts. Fail-closed on EPERM.
 * Kept in the store module so the pure command builder never imports OS code.
 */
export type PromptArtifactCleanupResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'sensitive_artifact_cleanup_failed';
      readonly reason: string;
      readonly pathRedacted: string;
    };

/**
 * Already-verified prompt artifact reference.
 * Pure command builders consume this and perform zero filesystem/ACL work.
 * Created only by SecurePromptArtifactStore after exclusive create + identity
 * checks (+ Windows ACL harden/read-back).
 */
export interface PromptArtifactRef {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly stagingDir: string;
  /** Bounded verified cleanup; adapter wraps run lifecycle with this. */
  readonly cleanup: () => PromptArtifactCleanupResult;
}

/** @deprecated alias — prefer PromptArtifactRef */
export type PromptArtifactCreateResult = PromptArtifactRef;

export interface CreateVerifiedPromptArtifactStoreOptions {
  /** Trusted canonical base directory outside the live project. */
  readonly baseDirectory: string;
  /** Live project root — store base and artifacts must stay outside. */
  readonly projectRoot: string;
  /**
   * When true, create the leaf base directory after verifying every existing
   * parent component has no reparse/junction escape. Default false.
   */
  readonly createBaseIfMissing?: boolean;
}

export interface CreatePromptFileOptions {
  readonly prompt: string;
  readonly projectRoot: string;
  readonly maxBytes?: number;
}

function isPermissionError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES';
}

function pathKey(input: string): string {
  const absolute = resolve(input);
  return process.platform === 'win32'
    ? absolute.replaceAll('/', '\\').toLocaleLowerCase('en-US')
    : absolute;
}

function stripTrailingSeparators(input: string): string {
  if (input.length <= 1) return input;
  let end = input.length;
  while (end > 1 && (input[end - 1] === '/' || input[end - 1] === '\\')) {
    end -= 1;
  }
  return input.slice(0, end);
}

function normalizeExistingPath(input: string): string {
  const absolute = resolve(input);
  try {
    return stripTrailingSeparators(realpathSync.native(absolute));
  } catch {
    return stripTrailingSeparators(absolute);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rootKey = pathKey(normalizeExistingPath(root));
  const candKey = pathKey(normalizeExistingPath(candidate));
  if (candKey === rootKey) return true;
  const prefix = rootKey.endsWith(sep) ? rootKey : rootKey + sep;
  return candKey.startsWith(prefix);
}

function ancestorComponents(absolutePath: string): readonly string[] {
  const root = parsePath(absolutePath).root;
  const remainder = relative(root, absolutePath);
  if (remainder.length === 0) return [stripTrailingSeparators(root)];
  const components = remainder.split(sep).filter((c) => c.length > 0);
  const paths: string[] = [stripTrailingSeparators(root)];
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    paths.push(current);
  }
  return paths;
}

function isReparseStat(stat: Stats): boolean {
  if (stat.isSymbolicLink()) return true;
  // Windows: Directory junctions often report as directories with reparse bit.
  const REPARSE_POINT = 0x400;
  // Node Stats.mode on Windows may not expose reparse; use lstat + isSymbolicLink
  // and optional bigint mode bits when present.
  const mode = Number(stat.mode);
  return (mode & REPARSE_POINT) === REPARSE_POINT;
}

/**
 * Open/verify every existing path component has no reparse/junction.
 * Rejects symlink/junction escape before trusting realpath containment.
 */
function assertNoReparseOnPath(absolutePath: string): void {
  for (const component of ancestorComponents(absolutePath)) {
    if (!existsSync(component)) continue;
    let stat: Stats;
    try {
      stat = lstatSync(component);
    } catch (error) {
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: cannot lstat path component ${component}: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
    if (stat.isSymbolicLink() || isReparseStat(stat)) {
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: reparse/junction/symlink rejected on path component: `
          + component,
      );
    }
  }
}

/** Well-known SIDs (ASCII-stable; avoids locale username encoding issues). */
const SID_SYSTEM = 'S-1-5-18';
const SID_ADMINISTRATORS = 'S-1-5-32-544';
const SID_EVERYONE = 'S-1-1-0';
const SID_USERS = 'S-1-5-32-545';
const SID_AUTHENTICATED_USERS = 'S-1-5-11';
const SID_INTERACTIVE = 'S-1-5-4';
const SID_GUEST = 'S-1-5-32-546';

const BROAD_SIDS = new Set([
  SID_EVERYONE,
  SID_USERS,
  SID_AUTHENTICATED_USERS,
  SID_INTERACTIVE,
  SID_GUEST,
]);

function trustedSystem32Binary(relativeUnderSystem32: string): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (typeof systemRoot !== 'string' || systemRoot.trim().length === 0) {
    throw new PromptArtifactStoreError(
      'PromptArtifactStore: SystemRoot is required for Windows ACL hardening',
    );
  }
  const candidate = join(systemRoot, 'System32', ...relativeUnderSystem32.split('/'));
  assertNoReparseOnPath(candidate);
  let stat: Stats;
  try {
    stat = lstatSync(candidate);
  } catch (error) {
    throw new PromptArtifactStoreError(
      `PromptArtifactStore: trusted binary missing (${relativeUnderSystem32}): `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PromptArtifactStoreError(
      `PromptArtifactStore: trusted binary is not a regular file: ${relativeUnderSystem32}`,
    );
  }
  const real = normalizeExistingPath(candidate);
  const expectedDir = normalizeExistingPath(dirname(candidate));
  if (pathKey(dirname(real)) !== pathKey(expectedDir)) {
    throw new PromptArtifactStoreError(
      `PromptArtifactStore: trusted binary realpath escaped System32: ${relativeUnderSystem32}`,
    );
  }
  return real;
}

function trustedSystem32Icacls(): string {
  return trustedSystem32Binary('icacls.exe');
}

function trustedSystem32Whoami(): string {
  return trustedSystem32Binary('whoami.exe');
}

/**
 * Resolve current user SID via trusted System32\\whoami.exe exact argv
 * (no shell strings, no PowerShell cold-start). Output is SID token only.
 */
let cachedCurrentUserSid: string | undefined;
/** Cached DOMAIN\user (or COMPUTER\user) from whoami for name-only ACL checks. */
let cachedCurrentUserName: string | undefined;
/** Cached current logon session SID (S-1-5-5-X-Y) from whoami /logonid. */
let cachedCurrentLogonSid: string | undefined;
/** Paths already hardened in-process (base directories + files). */
const hardenedPathCache = new Set<string>();

/** Logon session SIDs are exactly S-1-5-5-<auth>-<id> (two trailing RID components). */
const LOGON_SESSION_SID_RE = /^S-1-5-5-(\d+)-(\d+)$/i;

function currentWindowsUserSid(): string {
  if (cachedCurrentUserSid !== undefined) return cachedCurrentUserSid;
  const whoami = trustedSystem32Whoami();
  try {
    // whoami /user /fo csv → "User Name","SID" header + one data row.
    const raw = execFileSync(whoami, ['/user', '/fo', 'csv'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // Prefer any SID-shaped token in the output (locale-safe).
    const sidMatch = raw.match(/\bS-1-\d+(?:-\d+)+\b/);
    const sid = sidMatch?.[0];
    if (sid === undefined || !/^S-1-\d+(-\d+)+$/.test(sid)) {
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: invalid current user SID from whoami: ${
          lines.join(' | ') || raw
        }`,
      );
    }
    // Cache username from the same trusted whoami call when present (csv col 0).
    // Used by name-only ACL read-back to reject unexpected principals.
    for (const line of lines.slice(1)) {
      const fields = line.match(/"([^"]*)"/g);
      if (fields != null && fields.length >= 2) {
        const name = fields[0]?.replaceAll('"', '').trim();
        if (name !== undefined && name.length > 0 && !/^S-1-/i.test(name)) {
          cachedCurrentUserName = name;
        }
      }
    }
    cachedCurrentUserSid = sid;
    return sid;
  } catch (error) {
    if (error instanceof PromptArtifactStoreError) throw error;
    throw new PromptArtifactStoreError(
      `PromptArtifactStore: failed to resolve current user SID: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Current Windows account name (DOMAIN\\user) for name-only ACL allow-list.
 * Prefer value cached from whoami /user; fall back to bare whoami.
 */
function currentWindowsUserName(): string {
  if (cachedCurrentUserName !== undefined) return cachedCurrentUserName;
  // Ensure SID resolution runs first (also populates name when possible).
  currentWindowsUserSid();
  if (cachedCurrentUserName !== undefined) return cachedCurrentUserName;
  const whoami = trustedSystem32Whoami();
  try {
    const raw = execFileSync(whoami, [], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    if (raw.length === 0) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: empty current user name from whoami',
      );
    }
    cachedCurrentUserName = raw.split(/\r?\n/)[0]?.trim() ?? raw;
    return cachedCurrentUserName;
  } catch (error) {
    if (error instanceof PromptArtifactStoreError) throw error;
    throw new PromptArtifactStoreError(
      `PromptArtifactStore: failed to resolve current user name: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Derive the exact icacls name-only principal for a validated logon session SID.
 * S-1-5-5-X-Y → NT AUTHORITY\\LogonSessionId_X_Y (no prefix matching).
 * Exported for focused unit regression coverage.
 */
export function logonSessionPrincipalNameFromSid(logonSid: string): string {
  const match = LOGON_SESSION_SID_RE.exec(logonSid.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new PromptArtifactStoreError(
      `PromptArtifactStore: invalid logon session SID: ${logonSid}`,
    );
  }
  return `NT AUTHORITY\\LogonSessionId_${match[1]}_${match[2]}`;
}

/**
 * Resolve current logon session SID via trusted System32\\whoami.exe /logonid.
 * Fail-closed: must be exactly S-1-5-5-X-Y (never a prefix match).
 */
function currentWindowsLogonSid(): string {
  if (cachedCurrentLogonSid !== undefined) return cachedCurrentLogonSid;
  const whoami = trustedSystem32Whoami();
  try {
    const raw = execFileSync(whoami, ['/logonid'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const sidMatch = raw.match(/\bS-1-5-5-\d+-\d+\b/i);
    const sid = sidMatch?.[0];
    if (sid === undefined || !LOGON_SESSION_SID_RE.test(sid)) {
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: invalid current logon SID from whoami /logonid: ${
          raw.trim() || '(empty)'
        }`,
      );
    }
    // Normalize to canonical uppercase form used in SID allow-lists.
    const canonical = sid.toUpperCase();
    // Re-validate after case fold (regex is case-insensitive; keep exact shape).
    if (!LOGON_SESSION_SID_RE.test(canonical)) {
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: invalid current logon SID from whoami /logonid: ${sid}`,
      );
    }
    cachedCurrentLogonSid = canonical;
    return canonical;
  } catch (error) {
    if (error instanceof PromptArtifactStoreError) throw error;
    throw new PromptArtifactStoreError(
      `PromptArtifactStore: failed to resolve current logon SID: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
}

function normalizeWindowsAclPrincipalName(value: string): string {
  return value.trim().replaceAll('/', '\\').toLocaleLowerCase('en-US');
}

function windowsAclNamePrincipalsEqual(a: string, b: string): boolean {
  // Exact normalized DOMAIN\\user equality only — never bare-username fallback.
  return (
    normalizeWindowsAclPrincipalName(a) === normalizeWindowsAclPrincipalName(b)
  );
}

export interface WindowsAclNameAllowlistContext {
  readonly currentUserName: string;
  /**
   * Exact derived name for the current logon SID only
   * (NT AUTHORITY\\LogonSessionId_X_Y). No prefix matching.
   */
  readonly currentLogonSessionName?: string;
}

/**
 * Explicit normalized allowlist for name-only icacls read-back.
 * Allowed: current whoami principal, NT AUTHORITY\\SYSTEM/SYSTEM,
 * BUILTIN\\Administrators/Administrators, and (when provided) the exact
 * current logon session name only. Reject every other principal including
 * different LogonSessionId_* identities and CONTOSO\\UnexpectedUser.
 * Exported for focused unit regression coverage.
 */
export function isAllowedWindowsAclNamePrincipal(
  principal: string,
  currentUserNameOrContext: string | WindowsAclNameAllowlistContext,
  currentLogonSessionName?: string,
): boolean {
  const currentUserName =
    typeof currentUserNameOrContext === 'string'
      ? currentUserNameOrContext
      : currentUserNameOrContext.currentUserName;
  const logonName =
    typeof currentUserNameOrContext === 'string'
      ? currentLogonSessionName
      : currentUserNameOrContext.currentLogonSessionName;

  const normalized = normalizeWindowsAclPrincipalName(principal);
  if (
    normalized === 'nt authority\\system'
    || normalized === 'system'
    || normalized === 'builtin\\administrators'
    || normalized === 'administrators'
  ) {
    return true;
  }
  // Exact current logon session only — never allow by LogonSessionId_ prefix.
  if (logonName !== undefined && logonName.trim().length > 0) {
    if (normalized === normalizeWindowsAclPrincipalName(logonName)) {
      return true;
    }
  }
  // Any other LogonSessionId_* (or bare LogonSessionId_*) is rejected.
  if (
    /^(nt authority\\)?logonsessionid_\d+_\d+$/i.test(normalized)
  ) {
    return false;
  }
  return windowsAclNamePrincipalsEqual(principal, currentUserName);
}

/**
 * Read ACL via trusted icacls and extract SID tokens (*S-1-...).
 * Prefer SID form grants so locale username encoding is irrelevant.
 * Falls back to detecting broad name principals when SIDs are resolved.
 */
function readWindowsAclListing(targetPath: string): string {
  const icacls = trustedSystem32Icacls();
  try {
    return execFileSync(icacls, [targetPath], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (error) {
    throw new PromptArtifactStoreError(
      `PromptArtifactStore: Windows ACL read-back failed: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
}

function extractSidsFromIcaclsListing(listing: string): readonly string[] {
  const found = listing.match(/\*?S-1-\d+(?:-\d+)+/gi) ?? [];
  return [...new Set(found.map((s) => s.replace(/^\*/, '').toUpperCase()))];
}

/**
 * Extract principal names from an icacls listing when SIDs are not printed.
 * icacls lines look like: `  DOMAIN\user:(F)` or `  NT AUTHORITY\SYSTEM:(F)`.
 * First ACE may share a line with the target path:
 * `C:\path BUILTIN\Administrators:(F)` or `C:\path NT AUTHORITY\SYSTEM:(F)`.
 */
function extractNamePrincipalsFromIcaclsListing(
  listing: string,
): readonly string[] {
  const names: string[] = [];
  for (const rawLine of listing.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // Skip the path header line (no ACE rights suffix).
    if (!/\([^)]*\)/.test(line) && !/:\(/.test(line)) continue;
    // SID form principals are handled separately.
    if (/\*?S-1-\d+(?:-\d+)+/i.test(line)) continue;
    // Principal immediately before `:(`. Allow optional path prefix on the
    // same line; keep "NT AUTHORITY\..." as one principal (space in name).
    const match = line.match(
      /(?:^|\s)(\*?NT AUTHORITY\\[^\s:(]+|\*?[^\s:(]+(?:\\[^\s:(]+)*):\(/i,
    );
    if (match?.[1] === undefined) continue;
    const principal = match[1].trim().replace(/^\*/, '');
    if (principal.length === 0) continue;
    names.push(principal);
  }
  return names;
}

function redactPromptPath(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? 'prompt';
  return `[REDACTED_PROMPT_DIR]/${base}`;
}

export function cleanupPromptArtifact(options: {
  readonly filePath: string;
  readonly stagingDir?: string;
  readonly maxAttempts?: number;
  readonly unlinkImpl?: (path: string) => void;
  readonly rmdirImpl?: (path: string) => void;
}): PromptArtifactCleanupResult {
  const maxAttempts = options.maxAttempts ?? PROMPT_ARTIFACT_CLEANUP_MAX_ATTEMPTS;
  const unlink = options.unlinkImpl ?? unlinkSync;
  const rmdir = options.rmdirImpl ?? rmdirSync;
  const redacted = redactPromptPath(options.filePath);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      unlink(options.filePath);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        lastError = undefined;
        break;
      }
      if (!isPermissionError(error) || attempt === maxAttempts) {
        return {
          ok: false,
          code: 'sensitive_artifact_cleanup_failed',
          reason:
            `sensitive_artifact_cleanup_failed: cannot unlink prompt file `
            + `(attempt ${attempt}/${maxAttempts}): `
            + (error instanceof Error ? error.message : String(error)),
          pathRedacted: redacted,
        };
      }
    }
  }

  if (lastError !== undefined) {
    return {
      ok: false,
      code: 'sensitive_artifact_cleanup_failed',
      reason:
        'sensitive_artifact_cleanup_failed: prompt file cleanup exhausted retries',
      pathRedacted: redacted,
    };
  }

  if (options.stagingDir !== undefined) {
    try {
      rmdir(options.stagingDir);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
        if (isPermissionError(error)) {
          return {
            ok: false,
            code: 'sensitive_artifact_cleanup_failed',
            reason:
              `sensitive_artifact_cleanup_failed: cannot rmdir staging: `
              + (error instanceof Error ? error.message : String(error)),
            pathRedacted: redacted,
          };
        }
      }
    }
  }

  // Verify file is gone when path was real.
  if (existsSync(options.filePath)) {
    return {
      ok: false,
      code: 'sensitive_artifact_cleanup_failed',
      reason:
        'sensitive_artifact_cleanup_failed: prompt file still exists after unlink',
      pathRedacted: redacted,
    };
  }

  return { ok: true };
}

/**
 * Secure outside-project prompt artifact store.
 *
 * - Trusted canonical base outside project; every parent component verified
 *   (no reparse/junction escape).
 * - Random staging dir + O_EXCL file create via descriptor.
 * - Post-open identity + nlink checks; reject hardlink/reparse races.
 * - Windows: harden ACL via trusted System32\\icacls.exe then read-back verify.
 */
export class PromptArtifactStore {
  readonly #canonicalBase: string;
  readonly #projectRoot: string;

  public constructor(options: {
    readonly canonicalBase: string;
    readonly projectRoot: string;
  }) {
    this.#canonicalBase = options.canonicalBase;
    this.#projectRoot = options.projectRoot;
  }

  public get canonicalBase(): string {
    return this.#canonicalBase;
  }

  public createPromptFile(
    options: CreatePromptFileOptions,
  ): PromptArtifactRef {
    const maxBytes = options.maxBytes ?? PROMPT_ARTIFACT_MAX_BYTES;
    const prompt = options.prompt;
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: non-empty prompt required',
      );
    }
    const byteLength = Buffer.byteLength(prompt, 'utf8');
    if (byteLength > maxBytes) {
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: prompt too large (${byteLength} bytes; max ${maxBytes})`,
      );
    }

    const projectRoot = options.projectRoot.trim();
    if (projectRoot.length === 0) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: projectRoot is required',
      );
    }
    // Containment checks use the caller's projectRoot; store was bound to a
    // project at construction. Allow equivalent path forms of the same root.
    const callerKey = pathKey(normalizeExistingPath(projectRoot));
    const storeKey = pathKey(normalizeExistingPath(this.#projectRoot));
    if (callerKey !== storeKey) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: projectRoot does not match verified store project',
      );
    }

    // Re-verify base before each create (TOCTOU hardening).
    assertNoReparseOnPath(this.#canonicalBase);
    if (!existsSync(this.#canonicalBase)) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: verified base no longer exists',
      );
    }
    if (isPathInside(projectRoot, this.#canonicalBase)) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: base must remain outside projectRoot',
      );
    }

    const stagingDir = join(
      this.#canonicalBase,
      `triagent-grok-prompt-${randomUUID()}`,
    );
    // Exclusive create of staging directory: mkdir without recursive on leaf.
    try {
      mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
    } catch (error) {
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: exclusive staging dir create failed: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
    try {
      assertNoReparseOnPath(stagingDir);
    } catch (error) {
      try {
        rmdirSync(stagingDir);
      } catch {
        // best-effort
      }
      throw error;
    }

    const filePath = join(stagingDir, `prompt-${randomUUID()}.txt`);
    if (isPathInside(projectRoot, filePath) || isPathInside(projectRoot, stagingDir)) {
      try {
        rmdirSync(stagingDir);
      } catch {
        // best-effort
      }
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: prompt path must be outside projectRoot',
      );
    }

    const exclusiveFlag =
      typeof fsConstants.O_CREAT === 'number'
      && typeof fsConstants.O_EXCL === 'number'
      && typeof fsConstants.O_WRONLY === 'number'
        ? fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
        : 'wx';

    let fd: number;
    try {
      fd = openSync(filePath, exclusiveFlag as 'wx', 0o600);
    } catch (error) {
      try {
        rmdirSync(stagingDir);
      } catch {
        // best-effort
      }
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: exclusive O_EXCL create failed: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }

    try {
      // Post-open identity: regular file, nlink===1, not a reparse.
      const fdStat = fstatSync(fd);
      if (!fdStat.isFile()) {
        throw new PromptArtifactStoreError(
          'PromptArtifactStore: post-open identity is not a regular file',
        );
      }
      if (fdStat.nlink !== 1) {
        throw new PromptArtifactStoreError(
          `PromptArtifactStore: hardlink/race rejected (nlink=${fdStat.nlink})`,
        );
      }
      const pathStat = lstatSync(filePath);
      if (pathStat.isSymbolicLink() || isReparseStat(pathStat)) {
        throw new PromptArtifactStoreError(
          'PromptArtifactStore: reparse/symlink race on prompt file',
        );
      }
      if (pathStat.ino !== fdStat.ino || pathStat.dev !== fdStat.dev) {
        throw new PromptArtifactStoreError(
          'PromptArtifactStore: file identity mismatch after open (race)',
        );
      }
      if (pathStat.nlink !== 1) {
        throw new PromptArtifactStoreError(
          `PromptArtifactStore: hardlink rejected after open (nlink=${pathStat.nlink})`,
        );
      }

      writeFileSync(fd, prompt, { encoding: 'utf8' });
      if (process.platform !== 'win32') {
        try {
          fchmodSync(fd, 0o600);
        } catch {
          // best-effort on platforms without fchmod
        }
      }
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      try {
        unlinkSync(filePath);
      } catch {
        // ignore
      }
      try {
        rmdirSync(stagingDir);
      } catch {
        // ignore
      }
      if (error instanceof PromptArtifactStoreError) throw error;
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: write/identity failed: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
    try {
      closeSync(fd);
    } catch {
      // ignore
    }

    // Post-write identity / containment / ACL verification. Any failure is
    // fail-closed: attempt secure cleanup so plaintext is not left behind.
    try {
      this.assertArtifactIdentity(filePath);

      if (process.platform === 'win32') {
        // Harden the file; staging dir inherits isolation via exclusive create
        // under the already-hardened base. Assert only the secret-bearing file.
        this.hardenWindowsAcl(filePath);
        this.assertWindowsAclHardened(filePath);
      }
    } catch (error) {
      const cleanupResult = cleanupPromptArtifact({
        filePath,
        stagingDir,
      });
      if (error instanceof PromptArtifactStoreError) {
        if (cleanupResult.ok === false) {
          throw new PromptArtifactStoreError(
            `${error.message}; ${cleanupResult.reason} (${cleanupResult.pathRedacted})`,
          );
        }
        throw error;
      }
      const baseMessage =
        error instanceof Error ? error.message : String(error);
      if (cleanupResult.ok === false) {
        throw new PromptArtifactStoreError(
          `PromptArtifactStore: post-write verification failed: ${baseMessage}; `
            + `${cleanupResult.reason} (${cleanupResult.pathRedacted})`,
        );
      }
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: post-write verification failed: ${baseMessage}`,
      );
    }

    const sha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
    let cleaned = false;
    const cleanup = (): PromptArtifactCleanupResult => {
      if (cleaned) {
        return existsSync(filePath)
          ? {
              ok: false,
              code: 'sensitive_artifact_cleanup_failed',
              reason:
                'sensitive_artifact_cleanup_failed: prompt file still exists after unlink',
              pathRedacted: redactPromptPath(filePath),
            }
          : { ok: true };
      }
      cleaned = true;
      return cleanupPromptArtifact({
        filePath,
        stagingDir,
      });
    };

    // Verified ref — pure builders may only consume this shape.
    const ref: PromptArtifactRef = Object.freeze({
      path: filePath,
      sha256,
      byteLength,
      stagingDir,
      cleanup,
    });
    return ref;
  }

  public assertArtifactIdentity(filePath: string): void {
    if (!isAbsolute(filePath)) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: artifact path must be absolute',
      );
    }
    if (!isPathInside(this.#canonicalBase, dirname(filePath))
      && !isPathInside(this.#canonicalBase, filePath)) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: artifact escaped verified base',
      );
    }
    assertNoReparseOnPath(filePath);
    let stat: Stats;
    try {
      stat = lstatSync(filePath);
    } catch (error) {
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: cannot stat artifact: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: artifact is not a regular file',
      );
    }
    if (stat.nlink !== 1) {
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: hardlink identity rejected (nlink=${stat.nlink})`,
      );
    }
    if (isPathInside(this.#projectRoot, filePath)) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: artifact must stay outside projectRoot',
      );
    }
  }

  public hardenWindowsAcl(targetPath: string): void {
    if (process.platform !== 'win32') return;
    const cacheKey = pathKey(targetPath);
    if (hardenedPathCache.has(cacheKey)) {
      return;
    }
    // Trusted System32\\icacls.exe exact argv only — no shell strings, no
    // PowerShell. Disable inheritance and replace DACL with current user +
    // SYSTEM + Administrators FullControl (SID form for locale safety).
    const icacls = trustedSystem32Icacls();
    const userSid = currentWindowsUserSid();
    try {
      execFileSync(
        icacls,
        [targetPath, '/inheritance:r'],
        { encoding: 'utf8', windowsHide: true },
      );
      // Reset explicit grants to the three allowed principals only.
      execFileSync(
        icacls,
        [
          targetPath,
          '/grant:r',
          `*${userSid}:(F)`,
          `*${SID_SYSTEM}:(F)`,
          `*${SID_ADMINISTRATORS}:(F)`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      // Remove any residual non-allowed explicit ACEs by re-granting replace.
      // icacls /grant:r replaces matching principal rights; inheritance:r
      // already stripped inherited. Fail-closed read-back catches leftovers.
      hardenedPathCache.add(cacheKey);
    } catch (error) {
      hardenedPathCache.delete(cacheKey);
      throw new PromptArtifactStoreError(
        `PromptArtifactStore: Windows ACL harden failed: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  public assertWindowsAclHardened(targetPath: string): void {
    if (process.platform !== 'win32') return;
    const cacheKey = pathKey(targetPath);
    const userSid = currentWindowsUserSid().toUpperCase();
    // Required principals from harden grant (must be present).
    const requiredSids = new Set([
      userSid,
      SID_SYSTEM.toUpperCase(),
      SID_ADMINISTRATORS.toUpperCase(),
    ]);
    // Exact current logon session SID is permitted when present on read-back
    // (icacls may surface it); every other S-1-5-5-* remains rejected.
    const currentLogonSid = currentWindowsLogonSid();
    const permittedSids = new Set([
      ...requiredSids,
      currentLogonSid.toUpperCase(),
    ]);

    // Prefer SID listing via icacls (fast, trusted argv). Fail closed on
    // broad principals, unexpected SIDs, or missing required principals.
    let listing: string;
    try {
      listing = readWindowsAclListing(targetPath);
    } catch (error) {
      hardenedPathCache.delete(cacheKey);
      throw error;
    }

    if (
      /(^|[\s*])Everyone(:|\s|\()/i.test(listing)
      || /Authenticated Users/i.test(listing)
      || /BUILTIN\\Users/i.test(listing)
      || /\*S-1-1-0\b/i.test(listing)
      || /\*S-1-5-32-545\b/i.test(listing)
      || /\*S-1-5-11\b/i.test(listing)
      || /\*S-1-5-4\b/i.test(listing)
      || /\*S-1-5-32-546\b/i.test(listing)
    ) {
      hardenedPathCache.delete(cacheKey);
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: Windows ACL broad principal remains on read-back',
      );
    }

    // When icacls prints SIDs (*S-1-...), enforce exact allow-list.
    const sids = extractSidsFromIcaclsListing(listing);
    if (sids.length > 0) {
      for (const sid of sids) {
        const upper = sid.toUpperCase();
        if (BROAD_SIDS.has(upper) || BROAD_SIDS.has(sid)) {
          hardenedPathCache.delete(cacheKey);
          throw new PromptArtifactStoreError(
            `PromptArtifactStore: Windows ACL broad principal remains: ${sid}`,
          );
        }
        // Fail closed on any logon session SID that is not the exact current one.
        if (/^S-1-5-5-/i.test(sid) && upper !== currentLogonSid.toUpperCase()) {
          hardenedPathCache.delete(cacheKey);
          throw new PromptArtifactStoreError(
            `PromptArtifactStore: Windows ACL LogonSession principal remains: ${sid}`,
          );
        }
        if (!permittedSids.has(upper)) {
          hardenedPathCache.delete(cacheKey);
          throw new PromptArtifactStoreError(
            `PromptArtifactStore: Windows ACL unexpected principal remains: ${sid}`,
          );
        }
      }
      for (const required of requiredSids) {
        if (![...sids].some((s) => s.toUpperCase() === required)) {
          // icacls may print names instead of SIDs for some principals; only
          // fail when *no* SID form was present for any principal.
          // If we have SIDs but missing required, fail closed.
          hardenedPathCache.delete(cacheKey);
          throw new PromptArtifactStoreError(
            `PromptArtifactStore: Windows ACL missing required principal: ${required}`,
          );
        }
      }
    } else {
      // Name-only listing: explicit normalized allowlist only —
      // current whoami + SYSTEM + Administrators + exact current logon session.
      const currentUserName = currentWindowsUserName();
      const currentLogonSessionName =
        logonSessionPrincipalNameFromSid(currentLogonSid);
      const namePrincipals = extractNamePrincipalsFromIcaclsListing(listing);
      let hasSystem = false;
      let hasAdministrators = false;
      let hasCurrentUser = false;
      for (const principal of namePrincipals) {
        if (
          !isAllowedWindowsAclNamePrincipal(principal, {
            currentUserName,
            currentLogonSessionName,
          })
        ) {
          hardenedPathCache.delete(cacheKey);
          throw new PromptArtifactStoreError(
            `PromptArtifactStore: Windows ACL unexpected principal remains: ${principal}`,
          );
        }
        const normalized = normalizeWindowsAclPrincipalName(principal);
        if (
          normalized === 'nt authority\\system'
          || normalized === 'system'
        ) {
          hasSystem = true;
        } else if (
          normalized === 'builtin\\administrators'
          || normalized === 'administrators'
        ) {
          hasAdministrators = true;
        } else if (windowsAclNamePrincipalsEqual(principal, currentUserName)) {
          hasCurrentUser = true;
        }
        // Exact current logon session name is permitted but not required.
      }
      if (!hasSystem) {
        hardenedPathCache.delete(cacheKey);
        throw new PromptArtifactStoreError(
          'PromptArtifactStore: Windows ACL missing SYSTEM principal on read-back',
        );
      }
      if (!hasAdministrators) {
        hardenedPathCache.delete(cacheKey);
        throw new PromptArtifactStoreError(
          'PromptArtifactStore: Windows ACL missing Administrators principal on read-back',
        );
      }
      // Current user ACE should be present on hardened artifacts. Fail closed
      // when name-only listing omits it (cannot prove creator isolation).
      // The exact current logon-session principal may stand in for the user
      // ACE when icacls resolves the creator grant that way.
      const hasCurrentLogon = namePrincipals.some(
        (p) =>
          normalizeWindowsAclPrincipalName(p)
          === normalizeWindowsAclPrincipalName(currentLogonSessionName),
      );
      if (!hasCurrentUser && !hasCurrentLogon && namePrincipals.length > 0) {
        hardenedPathCache.delete(cacheKey);
        throw new PromptArtifactStoreError(
          'PromptArtifactStore: Windows ACL missing current user principal on read-back',
        );
      }
    }

    // Inheritance must be disabled (icacls shows no (I) markers for inherited).
    if (/\(I\)/i.test(listing) || /\(IO\)/i.test(listing)) {
      // (I) inherited marker — fail closed.
      hardenedPathCache.delete(cacheKey);
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: Windows ACL retains inherited ACE',
      );
    }

    hardenedPathCache.add(cacheKey);
  }
}

/**
 * Create a verified PromptArtifactStore. No insecure realpath-only fallback
 * for nonexistent children: parents are opened/verified component-wise; leaf
 * may be created only when createBaseIfMissing is true after parent checks.
 */
export function createVerifiedPromptArtifactStore(
  options: CreateVerifiedPromptArtifactStoreOptions,
): PromptArtifactStore {
  const projectRootRaw = options.projectRoot.trim();
  if (projectRootRaw.length === 0) {
    throw new PromptArtifactStoreError(
      'PromptArtifactStore: projectRoot is required',
    );
  }
  const projectRoot = normalizeExistingPath(projectRootRaw);
  assertNoReparseOnPath(projectRoot);

  const baseRaw = options.baseDirectory.trim();
  if (baseRaw.length === 0) {
    throw new PromptArtifactStoreError(
      'PromptArtifactStore: baseDirectory is required',
    );
  }
  const absoluteBase = resolve(baseRaw);

  // Never accept a base inside the project (string + canonical).
  if (isPathInside(projectRoot, absoluteBase)) {
    throw new PromptArtifactStoreError(
      'PromptArtifactStore: baseDirectory must be outside projectRoot',
    );
  }

  const createIfMissing = options.createBaseIfMissing === true;
  const exists = existsSync(absoluteBase);

  if (!exists) {
    if (!createIfMissing) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: baseDirectory does not exist '
          + '(no insecure realpath fallback for missing child)',
      );
    }
    // Verify every existing parent component, then mkdir leaf only.
    const parent = dirname(absoluteBase);
    if (!existsSync(parent)) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: parent of baseDirectory does not exist',
      );
    }
    assertNoReparseOnPath(parent);
    const realParent = normalizeExistingPath(parent);
    if (isPathInside(projectRoot, realParent)
      || isPathInside(projectRoot, absoluteBase)) {
      throw new PromptArtifactStoreError(
        'PromptArtifactStore: base parent must be outside projectRoot',
      );
    }
    try {
      mkdirSync(absoluteBase, { recursive: false, mode: 0o700 });
    } catch (error) {
      // If raced into existence as a reparse, fail closed below.
      if (!existsSync(absoluteBase)) {
        throw new PromptArtifactStoreError(
          `PromptArtifactStore: failed to create baseDirectory: `
            + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  assertNoReparseOnPath(absoluteBase);
  let baseStat: Stats;
  try {
    baseStat = lstatSync(absoluteBase);
  } catch (error) {
    throw new PromptArtifactStoreError(
      `PromptArtifactStore: cannot lstat baseDirectory: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw new PromptArtifactStoreError(
      'PromptArtifactStore: baseDirectory must be a real directory (no reparse)',
    );
  }

  const canonicalBase = normalizeExistingPath(absoluteBase);
  // Post-realpath: still reject if any component was reparse (already checked)
  // and ensure canonical base stays outside project.
  if (isPathInside(projectRoot, canonicalBase)) {
    throw new PromptArtifactStoreError(
      'PromptArtifactStore: canonical base resolved inside projectRoot',
    );
  }
  // Re-check reparse on canonical form.
  assertNoReparseOnPath(canonicalBase);

  const store = new PromptArtifactStore({
    canonicalBase,
    projectRoot,
  });
  if (process.platform === 'win32') {
    // Harden base directory ACL early (once per store construction).
    store.hardenWindowsAcl(canonicalBase);
    store.assertWindowsAclHardened(canonicalBase);
  }
  return store;
}

/**
 * Default OS tmpdir-based verified store for adapters (outside project).
 */
export function createDefaultPromptArtifactStore(
  projectRoot: string,
  baseDirectory?: string,
): PromptArtifactStore {
  const base = baseDirectory?.trim() || join(tmpdir(), 'triagent-prompt-artifacts');
  return createVerifiedPromptArtifactStore({
    baseDirectory: base,
    projectRoot,
    createBaseIfMissing: true,
  });
}
