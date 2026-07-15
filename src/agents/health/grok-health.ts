import {
  lookupCompatibility,
  type CompatibilityRecord,
} from '../compatibility-matrix.js';
import type { CompatibilityResolverPort } from '../compatibility-resolver.js';
import type { CommandProbe, CommandProbeEvidence } from './command-probe.js';

export const GROK_CLI_NAME = 'grok' as const;

export type GrokAuthStatus =
  | 'authenticated'
  | 'logged_out'
  | 'unknown'
  | 'error';

export type GrokHealthStatus =
  | 'available'
  | 'missing'
  | 'logged_out'
  | 'timeout'
  | 'malformed'
  | 'unsupported_version'
  | 'error';

export interface GrokVersionParseResult {
  readonly ok: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export interface GrokAuthParseResult {
  readonly auth: GrokAuthStatus;
  readonly reason?: string;
  readonly requiresReadinessProbe: boolean;
}

export interface GrokHealthReport {
  readonly kind: 'grok';
  readonly cliName: typeof GROK_CLI_NAME;
  readonly status: GrokHealthStatus;
  readonly version?: string;
  readonly auth: GrokAuthStatus;
  /**
   * When true, task start must run an explicit lightweight readiness probe
   * before Worker `start_run` (auth cannot be proven without a model call).
   */
  readonly requiresReadinessProbe: boolean;
  readonly reason?: string;
  readonly evidence: readonly CommandProbeEvidence[];
  readonly compatibility?: CompatibilityRecord;
  readonly platform: NodeJS.Platform;
}

const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

export function parseGrokVersion(stdout: string): GrokVersionParseResult {
  const text = stdout.trim();
  if (text.length === 0) {
    return { ok: false, reason: 'empty grok version output' };
  }
  const match = text.match(VERSION_PATTERN);
  if (match === null || match[1] === undefined) {
    return { ok: false, reason: 'malformed grok version output' };
  }
  return { ok: true, version: match[1] };
}

/**
 * Grok inspect output is informational only. Authentication cannot be proven
 * without a model call, so healthy inspect JSON yields `auth=unknown` and
 * requires an explicit readiness probe later.
 */
export function parseGrokInspectAuth(stdout: string): GrokAuthParseResult {
  const text = stdout.trim();
  if (text.length === 0) {
    return {
      auth: 'error',
      reason: 'empty grok inspect output',
      requiresReadinessProbe: true,
    };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        auth: 'error',
        reason: 'malformed grok inspect JSON (expected object)',
        requiresReadinessProbe: true,
      };
    }
    // Never treat inspect fields as proof of login — that would require a model call.
    return {
      auth: 'unknown',
      requiresReadinessProbe: true,
    };
  } catch {
    return {
      auth: 'error',
      reason: 'malformed grok inspect JSON',
      requiresReadinessProbe: true,
    };
  }
}

/**
 * No-write Grok health probe:
 * - `<executable> --version`
 * - `<executable> inspect --json`
 * Never calls a model. Auth is unknown unless proven later by readiness probe.
 * `executable` is a single argv executable path (no shell).
 */
export async function checkGrokHealth(
  probe: CommandProbe,
  options: {
    readonly executable?: string;
    readonly compatibilityResolver?: CompatibilityResolverPort;
  } = {},
): Promise<GrokHealthReport> {
  const platform = process.platform;
  const evidence: CommandProbeEvidence[] = [];
  const executable =
    typeof options.executable === 'string' && options.executable.trim().length > 0
      ? options.executable.trim()
      : GROK_CLI_NAME;

  const versionResult = await probe.runArgv(executable, ['--version']);
  evidence.push(versionResult.evidence);

  if (versionResult.timedOut) {
    return {
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'timeout',
      auth: 'unknown',
      requiresReadinessProbe: true,
      reason: versionResult.error ?? 'grok --version timed out',
      evidence,
      platform,
    };
  }

  const versionSpawnClass = classifySpawnFailure(versionResult);
  if (versionSpawnClass === 'missing') {
    return {
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'missing',
      auth: 'unknown',
      requiresReadinessProbe: true,
      reason: probe.sanitizeError(
        versionResult.error ?? (versionResult.stderr || 'grok not found'),
      ),
      evidence,
      platform,
    };
  }
  if (versionSpawnClass === 'error') {
    return {
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'error',
      auth: 'unknown',
      requiresReadinessProbe: true,
      reason: probe.sanitizeError(
        versionResult.error
          ?? (versionResult.stderr || 'grok version probe failed'),
      ),
      evidence,
      platform,
    };
  }

  if (!versionResult.ok || versionResult.exitCode !== 0) {
    const parsedFailed = parseGrokVersion(versionResult.stdout);
    return {
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'error',
      ...(parsedFailed.ok && parsedFailed.version !== undefined
        ? { version: parsedFailed.version }
        : {}),
      auth: 'unknown',
      requiresReadinessProbe: true,
      reason: probe.sanitizeError(
        versionResult.error
          ?? (versionResult.stderr
            || `grok --version exited ${String(versionResult.exitCode)}`),
      ),
      evidence,
      platform,
    };
  }

  const parsedVersion = parseGrokVersion(versionResult.stdout);
  if (!parsedVersion.ok || parsedVersion.version === undefined) {
    return {
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'malformed',
      auth: 'unknown',
      requiresReadinessProbe: true,
      reason: parsedVersion.reason ?? 'malformed grok version',
      evidence,
      platform,
    };
  }

  const version = parsedVersion.version;
  const inspectResult = await probe.runArgv(executable, [
    'inspect',
    '--json',
  ]);
  evidence.push(inspectResult.evidence);

  if (inspectResult.timedOut) {
    return {
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'timeout',
      version,
      auth: 'unknown',
      requiresReadinessProbe: true,
      reason: inspectResult.error ?? 'grok inspect --json timed out',
      evidence,
      platform,
    };
  }

  const inspectSpawnClass = classifySpawnFailure(inspectResult);
  if (inspectSpawnClass === 'missing') {
    return {
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'missing',
      version,
      auth: 'unknown',
      requiresReadinessProbe: true,
      reason: probe.sanitizeError(
        inspectResult.error ?? (inspectResult.stderr || 'grok not found'),
      ),
      evidence,
      platform,
    };
  }
  if (inspectSpawnClass === 'error') {
    return {
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'error',
      version,
      auth: 'error',
      requiresReadinessProbe: true,
      reason: probe.sanitizeError(
        inspectResult.error
          ?? (inspectResult.stderr || 'grok inspect probe failed'),
      ),
      evidence,
      platform,
    };
  }

  // Nonzero inspect cannot yield auth=unknown ready/available record.
  if (!inspectResult.ok || inspectResult.exitCode !== 0) {
    if (lookupCompatibility({
      cliName: GROK_CLI_NAME,
      version,
      platform,
    }) === undefined) {
      return {
        kind: 'grok',
        cliName: GROK_CLI_NAME,
        status: 'unsupported_version',
        version,
        auth: 'error',
        requiresReadinessProbe: true,
        reason: `unsupported grok version: ${version}`,
        evidence,
        platform,
      };
    }
    return {
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'error',
      version,
      auth: 'error',
      requiresReadinessProbe: true,
      reason: probe.sanitizeError(
        inspectResult.error
          ?? (inspectResult.stderr
            || `grok inspect --json exited ${String(inspectResult.exitCode)}`),
      ),
      evidence,
      platform,
    };
  }

  const authParsed = parseGrokInspectAuth(inspectResult.stdout);

  let compatibility = lookupCompatibility({
    cliName: GROK_CLI_NAME,
    version,
    platform,
  });
  let compatibilityFailureReason: string | undefined;
  if (
    compatibility === undefined
    && authParsed.auth !== 'error'
    && options.compatibilityResolver !== undefined
  ) {
    const resolved = await options.compatibilityResolver.resolve({
      key: {
        cliName: GROK_CLI_NAME,
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
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'unsupported_version',
      version,
      auth: authParsed.auth,
      requiresReadinessProbe: true,
      reason: compatibilityFailureReason ?? `unsupported grok version: ${version}`,
      evidence,
      platform,
    };
  }

  if (authParsed.auth === 'error') {
    return {
      kind: 'grok',
      cliName: GROK_CLI_NAME,
      status: 'error',
      version,
      auth: 'error',
      requiresReadinessProbe: true,
      reason: authParsed.reason ?? 'grok inspect failed',
      evidence,
      platform,
    };
  }

  // Installed + supported + inspect JSON ok (exit 0), but auth remains unknown.
  return {
    kind: 'grok',
    cliName: GROK_CLI_NAME,
    status: 'available',
    version,
    auth: 'unknown',
    requiresReadinessProbe: true,
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
