import {
  lookupCompatibility,
  type CompatibilityRecord,
} from '../compatibility-matrix.js';
import type { CompatibilityResolverPort } from '../compatibility-resolver.js';
import type { CommandProbe, CommandProbeEvidence } from './command-probe.js';

export const CLAUDE_CLI_NAME = 'claude' as const;

export type ClaudeAuthStatus =
  | 'authenticated'
  | 'logged_out'
  | 'unknown'
  | 'error';

export type ClaudeHealthStatus =
  | 'available'
  | 'missing'
  | 'logged_out'
  | 'timeout'
  | 'malformed'
  | 'unsupported_version'
  | 'error';

export interface ClaudeVersionParseResult {
  readonly ok: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export interface ClaudeAuthParseResult {
  readonly auth: ClaudeAuthStatus;
  readonly reason?: string;
}

export interface ClaudeHealthReport {
  readonly kind: 'claude';
  readonly cliName: typeof CLAUDE_CLI_NAME;
  readonly status: ClaudeHealthStatus;
  readonly version?: string;
  readonly auth: ClaudeAuthStatus;
  readonly requiresReadinessProbe: boolean;
  readonly reason?: string;
  readonly evidence: readonly CommandProbeEvidence[];
  readonly compatibility?: CompatibilityRecord;
  readonly platform: NodeJS.Platform;
}

const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

export function parseClaudeVersion(stdout: string): ClaudeVersionParseResult {
  const text = stdout.trim();
  if (text.length === 0) {
    return { ok: false, reason: 'empty claude version output' };
  }
  const match = text.match(VERSION_PATTERN);
  if (match === null || match[1] === undefined) {
    return { ok: false, reason: 'malformed claude version output' };
  }
  return { ok: true, version: match[1] };
}

export function parseClaudeAuthOutput(stdout: string): ClaudeAuthParseResult {
  const text = stdout.trim();
  if (text.length === 0) {
    return { auth: 'error', reason: 'empty claude auth status output' };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === 'object'
      && parsed !== null
      && !Array.isArray(parsed)
      && typeof (parsed as Record<string, unknown>).loggedIn === 'boolean'
    ) {
      return {
        auth: (parsed as Record<string, unknown>).loggedIn === true
          ? 'authenticated'
          : 'logged_out',
      };
    }
  } catch {
    // Older Claude versions returned human-readable text; keep that fallback.
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
    reason: 'unrecognized or malformed claude auth status output',
  };
}

/**
 * No-write Claude health probe:
 * - `<executable> --version`
 * - `<executable> auth status`
 * Never calls a model. `executable` is a single argv executable path (no shell).
 */
export async function checkClaudeHealth(
  probe: CommandProbe,
  options: {
    readonly executable?: string;
    readonly compatibilityResolver?: CompatibilityResolverPort;
  } = {},
): Promise<ClaudeHealthReport> {
  const platform = process.platform;
  const evidence: CommandProbeEvidence[] = [];
  const executable =
    typeof options.executable === 'string' && options.executable.trim().length > 0
      ? options.executable.trim()
      : CLAUDE_CLI_NAME;

  const versionResult = await probe.runArgv(executable, ['--version']);
  evidence.push(versionResult.evidence);

  if (versionResult.timedOut) {
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'timeout',
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: versionResult.error ?? 'claude --version timed out',
      evidence,
      platform,
    };
  }

  const versionSpawnClass = classifySpawnFailure(versionResult);
  if (versionSpawnClass === 'missing') {
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'missing',
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        versionResult.error ?? (versionResult.stderr || 'claude not found'),
      ),
      evidence,
      platform,
    };
  }
  if (versionSpawnClass === 'error') {
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'error',
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        versionResult.error
          ?? (versionResult.stderr || 'claude version probe failed'),
      ),
      evidence,
      platform,
    };
  }

  if (!versionResult.ok || versionResult.exitCode !== 0) {
    const parsedFailed = parseClaudeVersion(versionResult.stdout);
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'error',
      ...(parsedFailed.ok && parsedFailed.version !== undefined
        ? { version: parsedFailed.version }
        : {}),
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        versionResult.error
          ?? (versionResult.stderr
            || `claude --version exited ${String(versionResult.exitCode)}`),
      ),
      evidence,
      platform,
    };
  }

  const parsedVersion = parseClaudeVersion(versionResult.stdout);
  if (!parsedVersion.ok || parsedVersion.version === undefined) {
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'malformed',
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: parsedVersion.reason ?? 'malformed claude version',
      evidence,
      platform,
    };
  }

  const version = parsedVersion.version;
  const authResult = await probe.runArgv(executable, ['auth', 'status']);
  evidence.push(authResult.evidence);

  if (authResult.timedOut) {
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'timeout',
      version,
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: authResult.error ?? 'claude auth status timed out',
      evidence,
      platform,
    };
  }

  const authSpawnClass = classifySpawnFailure(authResult);
  if (authSpawnClass === 'missing') {
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'missing',
      version,
      auth: 'unknown',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        authResult.error ?? (authResult.stderr || 'claude not found'),
      ),
      evidence,
      platform,
    };
  }
  if (authSpawnClass === 'error') {
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'error',
      version,
      auth: 'error',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        authResult.error ?? (authResult.stderr || 'claude auth probe failed'),
      ),
      evidence,
      platform,
    };
  }

  const authParsed = parseClaudeAuthOutput(
    `${authResult.stdout}\n${authResult.stderr}`,
  );

  if (!authResult.ok || authResult.exitCode !== 0) {
    if (authParsed.auth === 'logged_out') {
      return {
        kind: 'claude',
        cliName: CLAUDE_CLI_NAME,
        status: 'logged_out',
        version,
        auth: 'logged_out',
        requiresReadinessProbe: false,
        reason: 'claude is not logged in',
        evidence,
        platform,
      };
    }
    if (lookupCompatibility({
      cliName: CLAUDE_CLI_NAME,
      version,
      platform,
    }) === undefined) {
      return {
        kind: 'claude',
        cliName: CLAUDE_CLI_NAME,
        status: 'unsupported_version',
        version,
        auth: authParsed.auth === 'authenticated' ? 'error' : authParsed.auth,
        requiresReadinessProbe: false,
        reason: `unsupported claude version: ${version}`,
        evidence,
        platform,
      };
    }
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'error',
      version,
      auth: 'error',
      requiresReadinessProbe: false,
      reason: probe.sanitizeError(
        authResult.error
          ?? authParsed.reason
          ?? (authResult.stderr
            || `claude auth status exited ${String(authResult.exitCode)}`),
      ),
      evidence,
      platform,
    };
  }

  let compatibility = lookupCompatibility({
    cliName: CLAUDE_CLI_NAME,
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
        cliName: CLAUDE_CLI_NAME,
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
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'unsupported_version',
      version,
      auth: authParsed.auth,
      requiresReadinessProbe: false,
      reason: compatibilityFailureReason ?? `unsupported claude version: ${version}`,
      evidence,
      platform,
    };
  }

  if (authParsed.auth === 'logged_out') {
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'logged_out',
      version,
      auth: 'logged_out',
      requiresReadinessProbe: false,
      reason: 'claude is not logged in',
      evidence,
      platform,
    };
  }

  if (authParsed.auth === 'error') {
    return {
      kind: 'claude',
      cliName: CLAUDE_CLI_NAME,
      status: 'error',
      version,
      auth: 'error',
      requiresReadinessProbe: false,
      reason: authParsed.reason ?? 'claude auth check failed',
      evidence,
      platform,
    };
  }

  return {
    kind: 'claude',
    cliName: CLAUDE_CLI_NAME,
    status: 'available',
    version,
    auth: authParsed.auth,
    requiresReadinessProbe: false,
    evidence,
    compatibility,
    platform,
  };
}

function classifySpawnFailure(result: {
  readonly error?: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}): 'missing' | 'error' | undefined {
  const combined = `${result.error ?? ''} ${result.stderr}`.trim();
  if (combined.length === 0) return undefined;

  if (/EACCES|EPERM|EISDIR|ENOTDIR|EINVAL|EIO|EBUSY|ELOOP/i.test(combined)) {
    return 'error';
  }
  if (/permission denied|access is denied|not permitted/i.test(combined)) {
    return 'error';
  }
  if (
    /invalid cwd|chdir|no such file or directory.*cwd/i.test(combined)
    && !/ENOENT/i.test(combined)
  ) {
    return 'error';
  }

  if (
    /\bENOENT\b/i.test(combined)
    || /is not recognized as an internal or external command/i.test(combined)
    || /command not found/i.test(combined)
    || /not found/i.test(combined)
  ) {
    if (/EACCES|EPERM/i.test(combined)) return 'error';
    return 'missing';
  }

  if (/spawn\s+\S+/i.test(combined) || /^spawn /i.test(combined)) {
    return 'error';
  }

  return undefined;
}
