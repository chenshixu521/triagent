import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearRuntimeCompatibilityForTests,
  lookupCompatibility,
  type CompatibilityCliName,
  type CompatibilityKey,
} from '../../../src/agents/compatibility-matrix.js';
import {
  getCompatibilityProbeManifest,
  isVersionEligibleForDynamicProbe,
} from '../../../src/agents/compatibility-probe-manifests.js';
import {
  CompatibilityResolver,
  DEFAULT_COMPATIBILITY_CACHE_TTL_MS,
  type CompatibilityProbePort,
} from '../../../src/agents/compatibility-resolver.js';
import type {
  ExecutableIdentity,
  ExecutableIdentityProvider,
} from '../../../src/agents/compatibility-cache.js';
import type { CommandProbeResult } from '../../../src/agents/health/command-probe.js';
import { asAttemptId } from '../../../src/domain/ids.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-compatibility-'));
  temporaryDirectories.push(directory);
  return directory;
}

function key(
  cliName: CompatibilityCliName,
  version: string,
): CompatibilityKey {
  return { cliName, version, platform: process.platform };
}

function identity(
  configuredExecutable = 'grok',
  sha256 = 'a'.repeat(64),
): ExecutableIdentity {
  return {
    configuredExecutable,
    resolvedPath: `C:\\tools\\${configuredExecutable}.cmd`,
    size: 1_024,
    mtimeMs: 1_720_000_000_000,
    sha256,
  };
}

function identityProvider(value: ExecutableIdentity): ExecutableIdentityProvider {
  return async () => value;
}

function result(input: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly error?: string;
}): CommandProbeResult {
  const exitCode = input.exitCode ?? 0;
  const timedOut = input.timedOut ?? false;
  return {
    ok: exitCode === 0 && !timedOut && input.error === undefined,
    exitCode,
    timedOut,
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    ...(input.error === undefined ? {} : { error: input.error }),
    evidence: {
      attemptId: asAttemptId(`compatibility-${input.args.join('-') || 'root'}`),
      executable: input.executable,
      args: [...input.args],
      cwd: 'C:\\temp\\triagent-probe',
      durationMs: 1,
    },
  };
}

function successfulProbe(cliName: CompatibilityCliName): CompatibilityProbePort & {
  readonly calls: readonly (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  const manifest = getCompatibilityProbeManifest(cliName);
  return {
    calls,
    async runArgv(executable, args) {
      calls.push([...args]);
      const contract = manifest.probes.find((entry) => (
        entry.args.length === args.length
        && entry.args.every((value, index) => value === args[index])
      ));
      if (contract === undefined) {
        return result({
          executable,
          args,
          exitCode: 2,
          stderr: 'unexpected probe command',
        });
      }
      return result({
        executable,
        args,
        stdout: contract.requiredTokens.join('\n'),
      });
    },
  };
}

afterEach(() => {
  clearRuntimeCompatibilityForTests();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('dynamic CLI compatibility policy', () => {
  it('accepts newer stable versions inside the declared major range only', () => {
    expect(isVersionEligibleForDynamicProbe('codex', '0.145.0')).toBe(true);
    expect(isVersionEligibleForDynamicProbe('claude', '2.2.0')).toBe(true);
    expect(isVersionEligibleForDynamicProbe('grok', '0.2.101')).toBe(true);

    expect(isVersionEligibleForDynamicProbe('codex', '0.144.0')).toBe(false);
    expect(isVersionEligibleForDynamicProbe('claude', '2.1.205')).toBe(false);
    expect(isVersionEligibleForDynamicProbe('grok', '0.2.92')).toBe(false);
    expect(isVersionEligibleForDynamicProbe('codex', '1.0.0')).toBe(false);
    expect(isVersionEligibleForDynamicProbe('claude', '3.0.0')).toBe(false);
    expect(isVersionEligibleForDynamicProbe('grok', '1.0.0')).toBe(false);
    expect(isVersionEligibleForDynamicProbe('grok', '0.2.101-beta.1')).toBe(false);
    expect(isVersionEligibleForDynamicProbe('grok', 'latest')).toBe(false);
  });

  it('uses fixed help-only manifests and never model/prompt commands', () => {
    const codex = getCompatibilityProbeManifest('codex');
    const claude = getCompatibilityProbeManifest('claude');
    const grok = getCompatibilityProbeManifest('grok');

    expect(codex.probes.map((probe) => probe.args)).toEqual([
      ['--help'],
      ['exec', '--help'],
      ['exec', 'resume', '--help'],
    ]);
    expect(claude.probes.map((probe) => probe.args)).toEqual([['--help']]);
    expect(claude.probes[0]?.requiredTokens).toContain('--verbose');
    expect(grok.probes.map((probe) => probe.args)).toEqual([
      ['--help'],
      ['inspect', '--help'],
    ]);
    expect(
      [...codex.probes, ...claude.probes, ...grok.probes]
        .flatMap((probe) => probe.args)
        .join(' '),
    ).not.toMatch(/\b(prompt|single|-p)\b/i);
  });
});

describe('CompatibilityResolver', () => {
  it('accepts the current Codex global approval flag without requiring it in exec help', async () => {
    const root = temporaryDirectory();
    const cachePath = join(root, 'cli-compatibility-cache.json');
    const calls: (readonly string[])[] = [];
    const probe: CompatibilityProbePort = {
      async runArgv(executable, args) {
        calls.push([...args]);
        const command = args.join(' ');
        if (command === '--help') {
          return result({
            executable,
            args,
            stdout: '--ask-for-approval\nnever',
          });
        }
        if (command === 'exec --help') {
          return result({
            executable,
            args,
            stdout: [
              '--json',
              '--output-schema',
              '--sandbox',
              'never',
              '--skip-git-repo-check',
              'read-only',
              'workspace-write',
            ].join('\n'),
          });
        }
        if (command === 'exec resume --help') {
          return result({ executable, args, stdout: 'resume' });
        }
        return result({ executable, args, exitCode: 2, stderr: 'unexpected probe' });
      },
    };
    const resolver = new CompatibilityResolver({
      cachePath,
      now: () => 1_720_000_000_000,
      identityProvider: identityProvider(identity('codex')),
    });

    const resolved = await resolver.resolve({
      key: key('codex', '0.144.4'),
      executable: 'codex',
      probe,
    });

    expect(resolved.status).toBe('verified');
    if (resolved.status !== 'verified') expect.fail(resolved.reason);
    expect(calls).toEqual([
      ['--help'],
      ['exec', '--help'],
      ['exec', 'resume', '--help'],
    ]);
  });

  it('probes a compatible Grok upgrade, registers a conservative record, and caches only a receipt', async () => {
    const root = temporaryDirectory();
    const cachePath = join(root, 'cli-compatibility-cache.json');
    const probe = successfulProbe('grok');
    const resolver = new CompatibilityResolver({
      cachePath,
      now: () => 1_720_000_000_000,
      identityProvider: identityProvider(identity('grok')),
    });
    const compatibilityKey = key('grok', '0.2.101');

    const resolved = await resolver.resolve({
      key: compatibilityKey,
      executable: 'grok',
      probe,
    });

    expect(resolved.status).toBe('verified');
    if (resolved.status !== 'verified') {
      expect.fail(resolved.reason);
    }
    expect(resolved.source).toBe('probe');
    expect(resolved.record?.key).toEqual(compatibilityKey);
    expect(resolved.record?.readOnly).toBe(false);
    expect(resolved.record?.projectWrite).toBe(false);
    expect(resolved.record?.capabilities.nativePermissionRules).toBe(false);
    expect(resolved.record?.capabilities.writeModes).toEqual([]);
    expect(lookupCompatibility(compatibilityKey)).toBe(resolved.record);
    expect(probe.calls).toEqual([
      ['--help'],
      ['inspect', '--help'],
    ]);

    const cacheText = readFileSync(cachePath, 'utf8');
    expect(cacheText).toContain('0.2.101');
    expect(cacheText).not.toContain('capabilities');
    expect(cacheText).not.toContain('projectWrite');
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('uses a valid cache receipt without rerunning help probes', async () => {
    const root = temporaryDirectory();
    const cachePath = join(root, 'cli-compatibility-cache.json');
    const compatibilityKey = key('grok', '0.2.101');
    const first = new CompatibilityResolver({
      cachePath,
      now: () => 1_720_000_000_000,
      identityProvider: identityProvider(identity('grok')),
    });
    await first.resolve({
      key: compatibilityKey,
      executable: 'grok',
      probe: successfulProbe('grok'),
    });
    clearRuntimeCompatibilityForTests();

    const neverProbe: CompatibilityProbePort = {
      async runArgv() {
        throw new Error('cache hit must not run a command');
      },
    };
    const second = new CompatibilityResolver({
      cachePath,
      now: () => 1_720_000_000_001,
      identityProvider: identityProvider(identity('grok')),
    });
    const resolved = await second.resolve({
      key: compatibilityKey,
      executable: 'grok',
      probe: neverProbe,
    });

    expect(resolved.status).toBe('verified');
    if (resolved.status !== 'verified') {
      expect.fail(resolved.reason);
    }
    expect(resolved.source).toBe('cache');
  });

  it.each([
    ['expired receipt', 'expired'],
    ['binary identity mismatch', 'identity'],
    ['probe contract mismatch', 'contract'],
    ['malformed cache', 'malformed'],
  ] as const)('reprobes after %s', async (_label, mode) => {
    const root = temporaryDirectory();
    const cachePath = join(root, 'cli-compatibility-cache.json');
    const compatibilityKey = key('grok', '0.2.101');
    const startedAt = 1_720_000_000_000;
    const first = new CompatibilityResolver({
      cachePath,
      now: () => startedAt,
      identityProvider: identityProvider(identity('grok')),
    });
    await first.resolve({
      key: compatibilityKey,
      executable: 'grok',
      probe: successfulProbe('grok'),
    });
    clearRuntimeCompatibilityForTests();

    if (mode === 'contract') {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as {
        entries: Array<{ probeContractHash: string }>;
      };
      parsed.entries[0]!.probeContractHash = '0'.repeat(64);
      writeFileSync(cachePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    } else if (mode === 'malformed') {
      writeFileSync(cachePath, '{not-json', 'utf8');
    }

    const probe = successfulProbe('grok');
    const nextIdentity = mode === 'identity'
      ? identity('grok', 'b'.repeat(64))
      : identity('grok');
    const now = mode === 'expired'
      ? startedAt + DEFAULT_COMPATIBILITY_CACHE_TTL_MS + 1
      : startedAt + 1;
    const second = new CompatibilityResolver({
      cachePath,
      now: () => now,
      identityProvider: identityProvider(nextIdentity),
    });
    const resolved = await second.resolve({
      key: compatibilityKey,
      executable: 'grok',
      probe,
    });

    expect(resolved.status).toBe('verified');
    if (resolved.status !== 'verified') {
      expect.fail(resolved.reason);
    }
    expect(resolved.source).toBe('probe');
    expect(probe.calls.length).toBeGreaterThan(0);
  });

  it.each([
    ['missing required flag', 'missing'],
    ['probe timeout', 'timeout'],
    ['nonzero probe exit', 'nonzero'],
  ] as const)('fails closed on %s and does not cache the version', async (_label, mode) => {
    const root = temporaryDirectory();
    const cachePath = join(root, 'cli-compatibility-cache.json');
    const manifest = getCompatibilityProbeManifest('grok');
    let call = 0;
    const probe: CompatibilityProbePort = {
      async runArgv(executable, args) {
        call += 1;
        const contract = manifest.probes[call - 1]!;
        if (mode === 'timeout') {
          return result({ executable, args, timedOut: true, exitCode: null });
        }
        if (mode === 'nonzero') {
          return result({ executable, args, exitCode: 2, stderr: 'bad flag' });
        }
        return result({
          executable,
          args,
          stdout: contract.requiredTokens.slice(1).join('\n'),
        });
      },
    };
    const resolver = new CompatibilityResolver({
      cachePath,
      now: () => 1_720_000_000_000,
      identityProvider: identityProvider(identity('grok')),
    });
    const compatibilityKey = key('grok', '0.2.101');

    const resolved = await resolver.resolve({
      key: compatibilityKey,
      executable: 'grok',
      probe,
    });

    expect(resolved.status).toBe('unsupported');
    if (resolved.status !== 'unsupported') {
      expect.fail(`expected unsupported, got ${resolved.source}`);
    }
    expect(resolved.reason).toMatch(/probe|missing|required|timeout|exit/i);
    expect(lookupCompatibility(compatibilityKey)).toBeUndefined();
    expect(existsSync(cachePath)).toBe(false);
  });
});
