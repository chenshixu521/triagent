import { createHash } from 'node:crypto';

import {
  requireVerifiedCompatibility,
  type CompatibilityCliName,
  type CompatibilityKey,
  type CompatibilityRecord,
} from './compatibility-matrix.js';

export interface CompatibilityProbeCommand {
  readonly args: readonly string[];
  readonly requiredTokens: readonly string[];
}

export interface CompatibilityProbeManifest {
  readonly schemaVersion: 1;
  readonly cliName: CompatibilityCliName;
  readonly baselineVersion: string;
  readonly minimumVersion: string;
  readonly maximumVersionExclusive: string;
  readonly probes: readonly CompatibilityProbeCommand[];
}

interface ParsedStableVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStableVersion(value: string): ParsedStableVersion | undefined {
  const match = STABLE_VERSION_PATTERN.exec(value.trim());
  if (match === null) return undefined;
  const parts = match.slice(1).map((part) => Number(part));
  if (
    parts.length !== 3
    || parts.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    return undefined;
  }
  return {
    major: parts[0]!,
    minor: parts[1]!,
    patch: parts[2]!,
  };
}

function compareVersions(a: ParsedStableVersion, b: ParsedStableVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function freezeProbe(
  args: readonly string[],
  requiredTokens: readonly string[],
): CompatibilityProbeCommand {
  return Object.freeze({
    args: Object.freeze([...args]),
    requiredTokens: Object.freeze([...requiredTokens]),
  });
}

function manifest(
  input: Omit<CompatibilityProbeManifest, 'schemaVersion' | 'probes'> & {
    readonly probes: readonly CompatibilityProbeCommand[];
  },
): CompatibilityProbeManifest {
  return Object.freeze({
    schemaVersion: 1 as const,
    cliName: input.cliName,
    baselineVersion: input.baselineVersion,
    minimumVersion: input.minimumVersion,
    maximumVersionExclusive: input.maximumVersionExclusive,
    probes: Object.freeze([...input.probes]),
  });
}

const MANIFESTS: Readonly<Record<CompatibilityCliName, CompatibilityProbeManifest>> =
  Object.freeze({
    codex: manifest({
      cliName: 'codex',
      baselineVersion: '0.144.1',
      minimumVersion: '0.144.1',
      maximumVersionExclusive: '1.0.0',
      probes: [
        freezeProbe(['--help'], ['--ask-for-approval', 'never']),
        freezeProbe(
          ['exec', '--help'],
          [
            '--json',
            '--output-schema',
            '--sandbox',
            '--skip-git-repo-check',
            'read-only',
            'workspace-write',
          ],
        ),
        freezeProbe(['exec', 'resume', '--help'], ['resume']),
      ],
    }),
    claude: manifest({
      cliName: 'claude',
      baselineVersion: '2.1.206',
      minimumVersion: '2.1.206',
      maximumVersionExclusive: '3.0.0',
      probes: [
        freezeProbe(
          ['--help'],
          [
            '--print',
            '--safe-mode',
            '--output-format',
            'stream-json',
            '--verbose',
            '--input-format',
            'text',
            '--session-id',
            '--resume',
            '--json-schema',
            '--permission-mode',
            'auto',
            '--tools',
            '--disallowedTools',
            '--add-dir',
          ],
        ),
      ],
    }),
    grok: manifest({
      cliName: 'grok',
      baselineVersion: '0.2.93',
      minimumVersion: '0.2.93',
      maximumVersionExclusive: '1.0.0',
      probes: [
        freezeProbe(
          ['--help'],
          [
            '--cwd',
            '--prompt-file',
            '--output-format',
            'streaming-json',
            '--session-id',
            '--resume',
            '--permission-mode',
            'auto',
            'plan',
            '--tools',
            '--disallowed-tools',
            '--max-turns',
          ],
        ),
        freezeProbe(['inspect', '--help'], ['--json']),
      ],
    }),
  });

export function getCompatibilityProbeManifest(
  cliName: CompatibilityCliName,
): CompatibilityProbeManifest {
  return MANIFESTS[cliName];
}

export function compatibilityProbeContractHash(
  cliName: CompatibilityCliName,
): string {
  return createHash('sha256')
    .update(JSON.stringify(MANIFESTS[cliName]), 'utf8')
    .digest('hex');
}

export function isVersionEligibleForDynamicProbe(
  cliName: CompatibilityCliName,
  version: string,
): boolean {
  const candidate = parseStableVersion(version);
  const current = MANIFESTS[cliName];
  const minimum = parseStableVersion(current.minimumVersion);
  const maximum = parseStableVersion(current.maximumVersionExclusive);
  if (candidate === undefined || minimum === undefined || maximum === undefined) {
    return false;
  }
  return compareVersions(candidate, minimum) >= 0
    && compareVersions(candidate, maximum) < 0;
}

/**
 * Re-key the code-owned conservative baseline after the new version passed
 * every probe. Cache JSON never supplies capability booleans.
 */
export function deriveProbedCompatibilityRecord(
  key: CompatibilityKey,
): CompatibilityRecord {
  const current = MANIFESTS[key.cliName];
  const baseline = requireVerifiedCompatibility({
    cliName: key.cliName,
    version: current.baselineVersion,
    platform: key.platform,
  });
  return Object.freeze({
    ...baseline,
    key: Object.freeze({ ...key }),
    capabilities: Object.freeze({
      ...baseline.capabilities,
      writeModes: Object.freeze([...baseline.capabilities.writeModes]),
    }),
    notes: Object.freeze([
      ...baseline.notes,
      `runtime help-contract probe passed for ${key.cliName}@${key.version}`,
      `probe-contract-sha256=${compatibilityProbeContractHash(key.cliName)}`,
    ]),
  });
}
