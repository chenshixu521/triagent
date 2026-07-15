import {
  lookupCompatibility,
  type CompatibilityRecord,
} from '../compatibility-matrix.js';
import type { CompatibilityResolverPort } from '../compatibility-resolver.js';
import type { CommandProbe, CommandProbeEvidence } from './command-probe.js';

export const CODEX_CLI_NAME = 'codex' as const;

export type CodexAuthStatus =
  | 'authenticated'
  | 'logged_out'
  | 'unknown'
  | 'error';

export type CodexHealthStatus =
  | 'available'
  | 'missing'
  | 'logged_out'
  | 'timeout'
  | 'malformed'
  | 'unsupported_version'
  | 'error';

export interface CodexVersionParseResult {
  readonly ok: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export interface CodexAuthParseResult {
  readonly auth: CodexAuthStatus;
  readonly reason?: string;
}

export interface CodexHealthReport {
  readonly kind: 'codex';
  readonly cliName: typeof CODEX_CLI_NAME;
  readonly status: CodexHealthStatus;
  readonly version?: string;
  readonly auth: CodexAuthStatus;
  readonly requiresReadinessProbe: boolean;
  readonly reason?: string;
  readonly evidence: readonly CommandProbeEvidence[];
  readonly compatibility?: CompatibilityRecord;
  readonly platform: NodeJS.Platform;
}

const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

export function parseCodexVersion(stdout: string): CodexVersionParseResult {
  const text = stdout.trim();
  if (text.length === 0) {
    return { ok: false, reason: 'empty codex version output' };
  }
  const match = text.match(VERSION_PATTERN);
  if (match === null || match[1] === undefined) {
    return { ok: false, reason: 'malformed codex version output' };
  }
  return { ok: true, version: match[1] };
}

export function parseCodexAuthOutput(stdout: string): CodexAuthParseResult {
  const text = stdout.trim();
  if (text.length === 0) {
    return { auth: 'error', reason: 'empty codex login status output' };
  }
  const lower = text.toLowerCase();
  if (
    lower.includes('not logged in')
    || lower.includes('logged out')
    || lower.includes('unauthenticated')
  ) {
    return { auth: 'logged_out' };
  }
  if (
    lower.includes('logged in')
    || lower.includes('authenticated')
    || lower.includes('login successful')
  ) {
    return { auth: 'authenticated' };
  }
  return {
    auth: 'error',
    reason: 'unrecognized or malformed codex login status output',
  };
}

/**
 * No-write Codex health probe:
 * - `<executable> --version`
 * - `<executable> login status`
 * Never calls a model. `executable` is a single argv executable path (no shell).
 */
export async function checkCodexHealth(
  probe: CommandProbe,
  options: {
    readonly executable?: string;
    readonly compatibilityResolver?: CompatibilityResolverPort;
  } = {},
): Promise<CodexHealthReport> {
  const platform = process.platform;
  const evidence: CommandProbeEvidence[] = [];
  const executable =
    typeof options.executable === 'string' && options.executable.trim().length > 0
      ? options.executable.trim()
      : CODEX_CLI_NAME;

  const versionResult = await probe.runArgv(executable, ['--version']);
  evidence.push(versionResult.evidence);

  if (versionResult.timedOut) {
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'timeout',
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: versionResult.error ?? 'codex --version timed out',
      evidence,
      platform,
    };
  }

  // ENOENT alone is missing. EACCES/EPERM/invalid cwd/spawn errors are error.
  const versionSpawnClass = classifySpawnFailure(versionResult);
  if (versionSpawnClass === 'missing') {
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'missing',
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        versionResult.error ?? (versionResult.stderr || 'codex not found'),
      ),
      evidence,
      platform,
    };
  }
  if (versionSpawnClass === 'error') {
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'error',
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        versionResult.error
          ?? (versionResult.stderr || 'codex version probe failed'),
      ),
      evidence,
      platform,
    };
  }

  // Nonzero exit must not fail open into available — even with parseable stdout.
  if (!versionResult.ok || versionResult.exitCode !== 0) {
    const parsedFailed = parseCodexVersion(versionResult.stdout);
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'error',
      ...(parsedFailed.ok && parsedFailed.version !== undefined
        ? { version: parsedFailed.version }
        : {}),
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        versionResult.error
          ?? (versionResult.stderr
            || `codex --version exited ${String(versionResult.exitCode)}`),
      ),
      evidence,
      platform,
    };
  }

  const parsedVersion = parseCodexVersion(versionResult.stdout);
  if (!parsedVersion.ok || parsedVersion.version === undefined) {
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'malformed',
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: parsedVersion.reason ?? 'malformed codex version',
      evidence,
      platform,
    };
  }

  const version = parsedVersion.version;
  const authResult = await probe.runArgv(executable, ['login', 'status']);
  evidence.push(authResult.evidence);

  if (authResult.timedOut) {
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'timeout',
      version,
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: authResult.error ?? 'codex login status timed out',
      evidence,
      platform,
    };
  }

  const authSpawnClass = classifySpawnFailure(authResult);
  if (authSpawnClass === 'missing') {
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'missing',
      version,
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        authResult.error ?? (authResult.stderr || 'codex not found'),
      ),
      evidence,
      platform,
    };
  }
  if (authSpawnClass === 'error') {
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'error',
      version,
      auth: 'error',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        authResult.error ?? (authResult.stderr || 'codex auth probe failed'),
      ),
      evidence,
      platform,
    };
  }

  const authParsed = parseCodexAuthOutput(
    `${authResult.stdout}\n${authResult.stderr}`,
  );

  // Auth command nonzero: only logged_out may succeed as a typed status;
  // parseable "logged in" text with exit != 0 remains failed (not available).
  if (!authResult.ok || authResult.exitCode !== 0) {
    if (authParsed.auth === 'logged_out') {
      return {
        kind: 'codex',
        cliName: CODEX_CLI_NAME,
        status: 'logged_out',
        version,
        auth: 'logged_out',
        requiresReadinessProbe: false,
        reason: 'codex is not logged in',
        evidence,
        platform,
      };
    }
    if (lookupCompatibility({
      cliName: CODEX_CLI_NAME,
      version,
      platform,
    }) === undefined) {
      return {
        kind: 'codex',
        cliName: CODEX_CLI_NAME,
        status: 'unsupported_version',
        version,
        auth: authParsed.auth === 'authenticated' ? 'error' : authParsed.auth,
        requiresReadinessProbe: false,
        reason: `unsupported codex version: ${version}`,
        evidence,
        platform,
      };
    }
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'error',
      version,
      auth: 'error',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        authResult.error
          ?? authParsed.reason
          ?? (authResult.stderr
            || `codex login status exited ${String(authResult.exitCode)}`),
      ),
      evidence,
      platform,
    };
  }

  let compatibility = lookupCompatibility({
    cliName: CODEX_CLI_NAME,
    version,
    platform,
  });
  let compatibilityFailureReason: string | undefined;
  if (
    compatibility === undefined
    && authParsed.auth === 'authenticated'
    && options.compatibilityResolver !== undefined
  ) {
    const resolved = await options.compatibilityResolver.resolve({
      key: {
        cliName: CODEX_CLI_NAME,
        version,
        platform,
      },
      executable,
      probe,
    });
    evidence.push(...resolved.evidence);
    if (resolved.status === 'verified') {
      compatibility = resolved.record;
    } else {
      compatibilityFailureReason = resolved.reason;
    }
  }

  if (compatibility === undefined) {
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'unsupported_version',
      version,
      auth: authParsed.auth,
      requiresReadinessProbe: false,
      reason: compatibilityFailureReason ?? `unsupported codex version: ${version}`,
      evidence,
      platform,
    };
  }

  if (authParsed.auth === 'logged_out') {
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'logged_out',
      version,
      auth: 'logged_out',
      requiresReadinessProbe: false,
      reason: 'codex is not logged in',
      evidence,
      platform,
    };
  }

  if (authParsed.auth === 'error') {
    return {
      kind: 'codex',
      cliName: CODEX_CLI_NAME,
      status: 'error',
      version,
      auth: 'error',
      requiresReadinessProbe: false,
      reason: authParsed.reason ?? 'codex auth check failed',
      evidence,
      platform,
    };
  }

  return {
    kind: 'codex',
    cliName: CODEX_CLI_NAME,
    status: 'available',
    version,
    auth: authParsed.auth,
    requiresReadinessProbe: false,
    evidence,
    compatibility,
    platform,
  };
}

/**
 * Distinguish ENOENT (missing binary) from permission/cwd/spawn failures.
 * Only pure not-found signals map to missing; everything else is error.
 */
function classifySpawnFailure(result: {
  readonly error?: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}): 'missing' | 'error' | undefined {
  const combined = `${result.error ?? ''} ${result.stderr}`.trim();
  if (combined.length === 0) return undefined;

  // Permission / invalid cwd / access errors are never "missing".
  if (/EACCES|EPERM|EISDIR|ENOTDIR|EINVAL|EIO|EBUSY|ELOOP/i.test(combined)) {
    return 'error';
  }
  if (/permission denied|access is denied|not permitted/i.test(combined)) {
    return 'error';
  }
  if (/invalid cwd|chdir|no such file or directory.*cwd|cwd/i.test(combined)
    && !/ENOENT/i.test(combined)) {
    return 'error';
  }

  // Pure ENOENT / not found / is not recognized → missing.
  if (
    /\bENOENT\b/i.test(combined)
    || /is not recognized as an internal or external command/i.test(combined)
    || /command not found/i.test(combined)
    || /not found/i.test(combined)
  ) {
    // "spawn X ENOENT" is missing; "spawn X EACCES" already handled above.
    if (/EACCES|EPERM/i.test(combined)) return 'error';
    return 'missing';
  }

  // Generic spawn failures without ENOENT are unavailable/error.
  if (/spawn\s+\S+/i.test(combined) || /^spawn /i.test(combined)) {
    return 'error';
  }

  return undefined;
}
