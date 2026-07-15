import {
  createHash,
} from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertCompatibilityRecordInvariants,
  clearRuntimeCompatibilityForTests,
  listVerifiedCompatibility,
  lookupCompatibility,
  registerRuntimeCompatibility,
  requireVerifiedCompatibility,
  workerStartPrerequisites,
  type CompatibilityKey,
} from '../../../src/agents/compatibility-matrix.js';
import {
  deriveProbedCompatibilityRecord,
} from '../../../src/agents/compatibility-probe-manifests.js';
import type {
  CompatibilityResolverPort,
} from '../../../src/agents/compatibility-resolver.js';
import { ClaudeAdapter } from '../../../src/agents/claude/claude-adapter.js';
import { CodexAdapter } from '../../../src/agents/codex/codex-adapter.js';
import { GrokAdapter } from '../../../src/agents/grok/grok-adapter.js';
import {
  checkClaudeHealth,
  parseClaudeAuthOutput,
  parseClaudeVersion,
} from '../../../src/agents/health/claude-health.js';
import {
  checkCodexHealth,
  parseCodexAuthOutput,
  parseCodexVersion,
} from '../../../src/agents/health/codex-health.js';
import {
  CommandProbe,
  DEFAULT_COMMAND_PROBE_TERMINATION_GRACE_MS,
  createSupervisorCommandProbeRunner,
  type CommandProbeRequest,
  type CommandProbeResult,
  type CommandProbeRunner,
} from '../../../src/agents/health/command-probe.js';
import {
  checkGrokHealth,
  parseGrokInspectAuth,
  parseGrokVersion,
} from '../../../src/agents/health/grok-health.js';
import { asAttemptId } from '../../../src/domain/ids.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';
import { fileURLToPath } from 'node:url';

const temporaryDirectories: string[] = [];
const projectRoot = resolve(process.cwd());
const projectRootSnapshot = captureDirectorySnapshot(projectRoot);

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-health-'));
  temporaryDirectories.push(directory);
  return directory;
}

interface FileSnapshotMeta {
  readonly mtimeMs: number;
  readonly size: number;
  readonly contentHash: string;
}

function fileContentHash(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return '';
  }
}

function captureDirectorySnapshot(root: string): Map<string, FileSnapshotMeta> {
  const snapshot = new Map<string, FileSnapshotMeta>();
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry === 'node_modules'
        || entry === 'dist'
        || entry === '.git'
        || entry === '.serena'
      ) {
        continue;
      }
      const full = join(directory, entry);
      let status;
      try {
        status = statSync(full);
      } catch {
        continue;
      }
      if (status.isDirectory()) {
        walk(full);
      } else if (status.isFile()) {
        snapshot.set(full, {
          mtimeMs: status.mtimeMs,
          size: status.size,
          contentHash: fileContentHash(full),
        });
      }
    }
  };
  walk(root);
  return snapshot;
}

function isExplicitTestOwnedTempOutsideProject(path: string): boolean {
  const resolved = resolve(path);
  // Only explicit test-owned temp dirs outside the project are excluded.
  if (resolved.startsWith(projectRoot)) return false;
  const lower = resolved.toLowerCase();
  return lower.includes('triagent-health-')
    || lower.includes(`${join('tmp', 'triagent-').toLowerCase()}`)
    || lower.includes('appdata\\local\\temp\\triagent-')
    || lower.includes('/tmp/triagent-');
}

function assertNoProjectMutation(before: Map<string, FileSnapshotMeta>): void {
  const after = captureDirectorySnapshot(projectRoot);

  // Deleted or renamed away from project tree must fail.
  for (const [path, meta] of before) {
    const next = after.get(path);
    if (next === undefined) {
      expect.fail(
        `project file deleted/renamed during health probes: ${relative(projectRoot, path)}`,
      );
    }
    expect(
      {
        path,
        size: next!.size,
        contentHash: next!.contentHash,
      },
      `project file content/metadata mutated during health probes: ${relative(projectRoot, path)}`,
    ).toEqual({
      path,
      size: meta.size,
      contentHash: meta.contentHash,
    });
  }

  // Newly created files under the project must fail (except nothing — probes use temp cwd).
  for (const path of after.keys()) {
    if (before.has(path)) continue;
    if (isExplicitTestOwnedTempOutsideProject(path)) continue;
    expect.fail(
      `project file created during health probes: ${relative(projectRoot, path)}`,
    );
  }
}

interface FixtureResponse {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
  readonly spawnError?: string;
  readonly delayMs?: number;
  readonly pid?: number;
}

function fixtureKey(executable: string, args: readonly string[]): string {
  return `${executable}\0${args.join('\0')}`;
}

function createFixtureRunner(
  responses: ReadonlyMap<string, FixtureResponse>,
): CommandProbeRunner & { readonly calls: CommandProbeRequest[] } {
  const calls: CommandProbeRequest[] = [];
  return {
    calls,
    async run(request: CommandProbeRequest): Promise<CommandProbeResult> {
      calls.push(request);
      const key = fixtureKey(request.executable, request.args);
      const fixture = responses.get(key);
      if (fixture === undefined) {
        return {
          ok: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          error: `no fixture for ${request.executable} ${request.args.join(' ')}`,
          evidence: {
            attemptId: request.attemptId,
            executable: request.executable,
            args: [...request.args],
            cwd: request.cwd,
            durationMs: 0,
          },
        };
      }
      if (fixture.delayMs !== undefined && fixture.delayMs > 0) {
        await new Promise<void>((resolvePromise) => {
          setTimeout(resolvePromise, fixture.delayMs);
        });
      }
      if (fixture.spawnError !== undefined) {
        return {
          ok: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          error: fixture.spawnError,
          evidence: {
            attemptId: request.attemptId,
            executable: request.executable,
            args: [...request.args],
            cwd: request.cwd,
            durationMs: fixture.delayMs ?? 0,
          },
        };
      }
      if (fixture.timedOut === true) {
        return {
          ok: false,
          exitCode: null,
          timedOut: true,
          stdout: fixture.stdout ?? '',
          stderr: fixture.stderr ?? '',
          error: 'command probe timed out',
          evidence: {
            attemptId: request.attemptId,
            executable: request.executable,
            args: [...request.args],
            cwd: request.cwd,
            durationMs: request.timeoutMs,
            ...(fixture.pid === undefined ? {} : { pid: fixture.pid }),
          },
        };
      }
      const exitCode = fixture.exitCode ?? 0;
      const stdout = fixture.stdout ?? '';
      const stderr = fixture.stderr ?? '';
      return {
        ok: exitCode === 0,
        exitCode,
        timedOut: false,
        stdout,
        stderr,
        evidence: {
          attemptId: request.attemptId,
          executable: request.executable,
          args: [...request.args],
          cwd: request.cwd,
          durationMs: fixture.delayMs ?? 1,
          ...(fixture.pid === undefined ? {} : { pid: fixture.pid }),
        },
      };
    },
  };
}

function mapFor(entries: ReadonlyArray<readonly [string, readonly string[], FixtureResponse]>): Map<string, FixtureResponse> {
  return new Map(
    entries.map(([executable, args, response]) => [
      fixtureKey(executable, args),
      response,
    ]),
  );
}

afterEach(() => {
  clearRuntimeCompatibilityForTests();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
  assertNoProjectMutation(projectRootSnapshot);
});

describe('version parsers (fixture-driven)', () => {
  it('parses current known Codex / Claude / Grok versions', () => {
    expect(parseCodexVersion('codex-cli 0.144.1\n')).toEqual({
      ok: true,
      version: '0.144.1',
    });
    expect(parseCodexVersion('0.144.1')).toEqual({
      ok: true,
      version: '0.144.1',
    });
    expect(parseClaudeVersion('2.1.206 (Claude Code)')).toEqual({
      ok: true,
      version: '2.1.206',
    });
    expect(parseClaudeVersion('claude 2.1.206')).toEqual({
      ok: true,
      version: '2.1.206',
    });
    expect(parseGrokVersion('0.2.93\n')).toEqual({
      ok: true,
      version: '0.2.93',
    });
    expect(parseGrokVersion('grok 0.2.93')).toEqual({
      ok: true,
      version: '0.2.93',
    });
  });

  it('rejects malformed version output', () => {
    expect(parseCodexVersion('not a version').ok).toBe(false);
    expect(parseClaudeVersion('').ok).toBe(false);
    expect(parseGrokVersion('version unknown').ok).toBe(false);
  });
});

describe('auth parsers (fixture-driven)', () => {
  it('parses Codex login status', () => {
    expect(parseCodexAuthOutput('Logged in using ChatGPT\n')).toEqual({
      auth: 'authenticated',
    });
    expect(parseCodexAuthOutput('Not logged in\n')).toEqual({
      auth: 'logged_out',
    });
    expect(parseCodexAuthOutput('gibberish')).toEqual({
      auth: 'error',
      reason: expect.stringMatching(/malformed|unrecognized/i),
    });
  });

  it('parses Claude auth status', () => {
    expect(parseClaudeAuthOutput('Logged in as user@example.com\n')).toEqual({
      auth: 'authenticated',
    });
    expect(
      parseClaudeAuthOutput(JSON.stringify({
        loggedIn: true,
        authMethod: 'oauth_token',
        apiProvider: 'firstParty',
      })),
    ).toEqual({ auth: 'authenticated' });
    expect(parseClaudeAuthOutput(JSON.stringify({ loggedIn: false }))).toEqual({
      auth: 'logged_out',
    });
    expect(parseClaudeAuthOutput('Not logged in\n')).toEqual({
      auth: 'logged_out',
    });
    expect(parseClaudeAuthOutput('???')).toEqual({
      auth: 'error',
      reason: expect.stringMatching(/malformed|unrecognized/i),
    });
  });

  it('reports Grok auth as unknown when inspect cannot prove login without a model call', () => {
    expect(
      parseGrokInspectAuth(JSON.stringify({ version: '0.2.93', tools: [] })),
    ).toEqual({
      auth: 'unknown',
      requiresReadinessProbe: true,
    });
    expect(parseGrokInspectAuth('not-json')).toEqual({
      auth: 'error',
      reason: expect.stringMatching(/malformed|json/i),
      requiresReadinessProbe: true,
    });
  });
});

describe('CLI health probes (fixture-driven)', () => {
  it('reports installed + authenticated current versions', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex-cli 0.144.1\n', pid: 1001 }],
        ['codex', ['login', 'status'], { stdout: 'Logged in using ChatGPT\n', pid: 1002 }],
        ['claude', ['--version'], { stdout: '2.1.206 (Claude Code)\n', pid: 2001 }],
        ['claude', ['auth', 'status'], { stdout: 'Logged in as user@example.com\n', pid: 2002 }],
        ['grok', ['--version'], { stdout: '0.2.93\n', pid: 3001 }],
        [
          'grok',
          ['inspect', '--json'],
          { stdout: `${JSON.stringify({ version: '0.2.93' })}\n`, pid: 3002 },
        ],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd, timeoutMs: 2_000 });

    const codex = await checkCodexHealth(probe);
    const claude = await checkClaudeHealth(probe);
    const grok = await checkGrokHealth(probe);

    expect(codex).toMatchObject({
      kind: 'codex',
      cliName: 'codex',
      status: 'available',
      version: '0.144.1',
      auth: 'authenticated',
      requiresReadinessProbe: false,
    });
    expect(claude).toMatchObject({
      kind: 'claude',
      cliName: 'claude',
      status: 'available',
      version: '2.1.206',
      auth: 'authenticated',
      requiresReadinessProbe: false,
    });
    expect(grok).toMatchObject({
      kind: 'grok',
      cliName: 'grok',
      status: 'available',
      version: '0.2.93',
      auth: 'unknown',
      requiresReadinessProbe: true,
    });

    expect(runner.calls.map((call) => [call.executable, ...call.args])).toEqual([
      ['codex', '--version'],
      ['codex', 'login', 'status'],
      ['claude', '--version'],
      ['claude', 'auth', 'status'],
      ['grok', '--version'],
      ['grok', 'inspect', '--json'],
    ]);
    for (const call of runner.calls) {
      expect(call.shell).toBe(false);
      expect(call.cwd).toBe(cwd);
    }
  });

  it('reports missing CLI when spawn fails with ENOENT', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { spawnError: "spawn codex ENOENT" }],
        ['claude', ['--version'], { spawnError: "spawn claude ENOENT" }],
        ['grok', ['--version'], { spawnError: "spawn grok ENOENT" }],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });

    expect(await checkCodexHealth(probe)).toMatchObject({
      status: 'missing',
      auth: 'unknown',
      reason: expect.stringMatching(/ENOENT|not found|missing/i),
    });
    expect(await checkClaudeHealth(probe)).toMatchObject({ status: 'missing' });
    expect(await checkGrokHealth(probe)).toMatchObject({ status: 'missing' });
  });

  it('reports logged_out without calling a model', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex-cli 0.144.1\n' }],
        ['codex', ['login', 'status'], { stdout: 'Not logged in\n', exitCode: 1 }],
        ['claude', ['--version'], { stdout: '2.1.206 (Claude Code)\n' }],
        ['claude', ['auth', 'status'], { stdout: 'Not logged in\n', exitCode: 1 }],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });

    expect(await checkCodexHealth(probe)).toMatchObject({
      status: 'logged_out',
      version: '0.144.1',
      auth: 'logged_out',
    });
    expect(await checkClaudeHealth(probe)).toMatchObject({
      status: 'logged_out',
      version: '2.1.206',
      auth: 'logged_out',
    });
  });

  it('reports timeout for hung version probes', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { timedOut: true, stdout: 'partial' }],
        ['claude', ['--version'], { timedOut: true }],
        ['grok', ['--version'], { timedOut: true }],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd, timeoutMs: 50 });

    expect(await checkCodexHealth(probe)).toMatchObject({
      status: 'timeout',
      auth: 'unknown',
    });
    expect(await checkClaudeHealth(probe)).toMatchObject({ status: 'timeout' });
    expect(await checkGrokHealth(probe)).toMatchObject({ status: 'timeout' });
  });

  it('reports malformed version output', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex is ready\n' }],
        ['claude', ['--version'], { stdout: 'latest\n' }],
        ['grok', ['--version'], { stdout: 'dev-build\n' }],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });

    expect(await checkCodexHealth(probe)).toMatchObject({ status: 'malformed' });
    expect(await checkClaudeHealth(probe)).toMatchObject({ status: 'malformed' });
    expect(await checkGrokHealth(probe)).toMatchObject({ status: 'malformed' });
  });

  it('reports unsupported version even when auth succeeds', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex-cli 0.100.0\n' }],
        ['codex', ['login', 'status'], { stdout: 'Logged in using ChatGPT\n' }],
        ['claude', ['--version'], { stdout: '1.0.0 (Claude Code)\n' }],
        ['claude', ['auth', 'status'], { stdout: 'Logged in as user@example.com\n' }],
        ['grok', ['--version'], { stdout: '0.1.0\n' }],
        [
          'grok',
          ['inspect', '--json'],
          { stdout: `${JSON.stringify({ version: '0.1.0' })}\n` },
        ],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });

    expect(await checkCodexHealth(probe)).toMatchObject({
      status: 'unsupported_version',
      version: '0.100.0',
      auth: 'authenticated',
    });
    expect(await checkClaudeHealth(probe)).toMatchObject({
      status: 'unsupported_version',
      version: '1.0.0',
    });
    expect(await checkGrokHealth(probe)).toMatchObject({
      status: 'unsupported_version',
      version: '0.1.0',
      auth: 'unknown',
      requiresReadinessProbe: true,
    });
  });

  it('accepts in-range upgraded versions only through an injected resolver', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex-cli 0.145.0\n' }],
        ['codex', ['login', 'status'], { stdout: 'Logged in using ChatGPT\n' }],
        ['claude', ['--version'], { stdout: '2.2.0 (Claude Code)\n' }],
        ['claude', ['auth', 'status'], { stdout: 'Logged in as user@example.com\n' }],
        ['grok', ['--version'], { stdout: '0.2.101\n' }],
        [
          'grok',
          ['inspect', '--json'],
          { stdout: `${JSON.stringify({ version: '0.2.101' })}\n` },
        ],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });
    const resolverCalls: CompatibilityKey[] = [];
    const resolver: CompatibilityResolverPort = {
      async resolve(request) {
        resolverCalls.push(request.key);
        const record = registerRuntimeCompatibility(
          deriveProbedCompatibilityRecord(request.key),
        );
        return {
          status: 'verified',
          source: 'probe',
          record,
          evidence: [
            {
              attemptId: asAttemptId(`dynamic-${request.key.cliName}`),
              executable: request.executable,
              args: ['--help'],
              cwd,
              durationMs: 1,
            },
          ],
        };
      },
    };

    const codex = await checkCodexHealth(probe, {
      compatibilityResolver: resolver,
    });
    const claude = await checkClaudeHealth(probe, {
      compatibilityResolver: resolver,
    });
    const grok = await checkGrokHealth(probe, {
      compatibilityResolver: resolver,
    });

    expect(codex).toMatchObject({
      status: 'available',
      version: '0.145.0',
      auth: 'authenticated',
      compatibility: { key: { version: '0.145.0' } },
    });
    expect(claude).toMatchObject({
      status: 'available',
      version: '2.2.0',
      auth: 'authenticated',
      compatibility: {
        key: { version: '2.2.0' },
        projectWrite: false,
      },
    });
    expect(grok).toMatchObject({
      status: 'available',
      version: '0.2.101',
      auth: 'unknown',
      requiresReadinessProbe: true,
      compatibility: {
        key: { version: '0.2.101' },
        readOnly: false,
        projectWrite: false,
        capabilities: {
          nativePermissionRules: false,
          writeModes: [],
        },
      },
    });
    expect(codex.evidence.at(-1)?.attemptId).toBe('dynamic-codex');
    expect(claude.evidence.at(-1)?.attemptId).toBe('dynamic-claude');
    expect(grok.evidence.at(-1)?.attemptId).toBe('dynamic-grok');
    expect(resolverCalls.map((entry) => `${entry.cliName}@${entry.version}`)).toEqual([
      'codex@0.145.0',
      'claude@2.2.0',
      'grok@0.2.101',
    ]);
  });

  it('keeps an in-range unknown version unsupported when no resolver is supplied', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['grok', ['--version'], { stdout: '0.2.101\n' }],
        [
          'grok',
          ['inspect', '--json'],
          { stdout: `${JSON.stringify({ version: '0.2.101' })}\n` },
        ],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });

    expect(await checkGrokHealth(probe)).toMatchObject({
      status: 'unsupported_version',
      version: '0.2.101',
      auth: 'unknown',
      requiresReadinessProbe: true,
    });
  });

  it('records attempt evidence and sanitizes sensitive error text', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        [
          'codex',
          ['--version'],
          {
            spawnError:
              'spawn failed Authorization: Bearer sk-secret-token-value api_key=supersecretvalue',
          },
        ],
      ]),
    );
    const probe = new CommandProbe({
      runner,
      cwd,
      createAttemptId: () => asAttemptId('probe-attempt-1'),
    });

    const report = await checkCodexHealth(probe);
    expect(report.evidence.length).toBeGreaterThan(0);
    expect(report.evidence[0]?.attemptId).toBe('probe-attempt-1');
    expect(report.reason ?? '').not.toMatch(/sk-secret-token-value|supersecretvalue/);
    expect(report.reason ?? '').toMatch(/REDACTED|Bearer|Authorization/i);
  });

  it('never issues write-oriented argv during health probes', async () => {
    const cwd = temporaryDirectory();
    const marker = join(cwd, 'should-not-exist.txt');
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex-cli 0.144.1\n' }],
        ['codex', ['login', 'status'], { stdout: 'Logged in using ChatGPT\n' }],
        ['claude', ['--version'], { stdout: '2.1.206 (Claude Code)\n' }],
        ['claude', ['auth', 'status'], { stdout: 'Logged in as user@example.com\n' }],
        ['grok', ['--version'], { stdout: '0.2.93\n' }],
        [
          'grok',
          ['inspect', '--json'],
          { stdout: `${JSON.stringify({ version: '0.2.93' })}\n` },
        ],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });
    await checkCodexHealth(probe);
    await checkClaudeHealth(probe);
    await checkGrokHealth(probe);

    const forbidden = [
      'exec',
      'chat',
      'run',
      '-p',
      '--print',
      'write',
      'edit',
      'apply',
    ];
    for (const call of runner.calls) {
      for (const arg of call.args) {
        expect(forbidden).not.toContain(arg.toLowerCase());
      }
      // Structural argv only — never a shell string.
      expect(Array.isArray(call.args)).toBe(true);
      expect(call.shell).toBe(false);
    }
    writeFileSync(join(cwd, 'fixture-only.txt'), 'ok', 'utf8');
    expect(() => statSync(marker)).toThrow();
  });
});

describe('Adapter health executable routing', () => {
  it.each([
    {
      kind: 'codex' as const,
      versionArgs: ['--version'] as const,
      versionOutput: 'codex-cli 0.144.1\n',
      authArgs: ['login', 'status'] as const,
      authOutput: 'Logged in\n',
    },
    {
      kind: 'claude' as const,
      versionArgs: ['--version'] as const,
      versionOutput: '2.1.206 (Claude Code)\n',
      authArgs: ['auth', 'status'] as const,
      authOutput: 'Authenticated\n',
    },
    {
      kind: 'grok' as const,
      versionArgs: ['--version'] as const,
      versionOutput: 'grok version 0.2.93\n',
      authArgs: ['inspect', '--json'] as const,
      authOutput: '{"status":"ok"}\n',
    },
  ])('uses the configured $kind executable for every health command', async (entry) => {
    const cwd = temporaryDirectory();
    const executable = join(cwd, `${entry.kind}-custom.exe`);
    const runner = createFixtureRunner(
      new Map([
        [
          fixtureKey(executable, entry.versionArgs),
          { exitCode: 0, stdout: entry.versionOutput },
        ],
        [
          fixtureKey(executable, entry.authArgs),
          { exitCode: 0, stdout: entry.authOutput },
        ],
      ]),
    );
    const probe = new CommandProbe({ cwd, runner });
    const supervisor = new FakeProcessSupervisor(
      new FakeClock('2026-07-13T02:00:00.000Z'),
      [],
    );
    const adapter =
      entry.kind === 'codex'
        ? new CodexAdapter({ supervisor, healthProbe: probe, executable })
        : entry.kind === 'claude'
          ? new ClaudeAdapter({ supervisor, healthProbe: probe, executable })
          : new GrokAdapter({ supervisor, healthProbe: probe, executable });

    await expect(adapter.checkAvailability()).resolves.toMatchObject({
      status: 'available',
    });
    expect(runner.calls.map((call) => call.executable)).toEqual([
      executable,
      executable,
    ]);
  });
});

describe('CommandProbe production supervision (no taskkill, Job Object port)', () => {
  it('production source never contains taskkill or detached PID kill fallback', () => {
    const sourcePath = fileURLToPath(
      new URL('../../../src/agents/health/command-probe.ts', import.meta.url),
    );
    const source = readFileSync(sourcePath, 'utf8');
    // Strip block/line comments so documentation cannot hide an executable path.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(codeOnly).not.toMatch(/taskkill/i);
    expect(codeOnly).not.toMatch(/spawn\(\s*['"]taskkill['"]/i);
    expect(source).not.toMatch(/forceKillProbeChild/);
    expect(source).not.toMatch(/createSpawnCommandProbeRunner/);
    // No child_process import — production path is supervisor-only.
    expect(codeOnly).not.toMatch(/from\s+['"]node:child_process['"]/);
    expect(codeOnly).not.toMatch(/\bspawn\s*\(/);
  });

  it('refuses construction without ProcessSupervisorPort or injected test runner', () => {
    const directory = temporaryDirectory();
    expect(() => new CommandProbe({ cwd: directory })).toThrow(
      /supervisor|ProcessSupervisorPort|runner/i,
    );
  });

  it('runs probes through ProcessSupervisorPort with structural argv', async () => {
    const directory = temporaryDirectory();
    const clock = new FakeClock('2026-07-13T00:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 71_001,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 71_001 } },
          { afterMs: 5, event: { type: 'stdout', chunk: 'fixture-cli vvvvvvvv\n' } },
          {
            afterMs: 10,
            event: {
              type: 'exited',
              pid: 71_001,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
    ]);
    const probe = new CommandProbe({
      cwd: directory,
      timeoutMs: 5_000,
      maxOutputBytes: 64,
      supervisor,
    });

    const runPromise = probe.run({
      attemptId: asAttemptId('supervisor-probe-1'),
      executable: process.execPath,
      args: ['--version'],
      cwd: directory,
      timeoutMs: 5_000,
      shell: false,
    });
    clock.advanceBy(50);
    const result = await runPromise;

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toMatch(/fixture-cli/);
    expect(result.evidence.executable).toBe(process.execPath);
    expect(result.evidence.pid).toBe(71_001);
    expect(supervisor.calls.some((call) => call.type === 'start')).toBe(true);
    expect(
      supervisor.calls.some(
        (call) => call.type === 'force_stop_tree' || call.type === 'request_graceful_stop',
      ),
    ).toBe(false);
  });

  it('on timeout: graceful then force tree; returns timedOut only after cleanup success', async () => {
    const directory = temporaryDirectory();
    const clock = new FakeClock('2026-07-13T00:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 71_002,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 71_002 } },
          // Never natural-exits; cleanup plans own termination.
        ],
        // Graceful fails so we must escalate to force (proves both calls).
        gracefulStop: {
          afterMs: 5,
          outcome: 'failed',
          error: 'ignored SIGTERM',
        },
        forceStop: {
          afterMs: 5,
          outcome: 'succeeded',
          exitCode: null,
        },
      },
    ]);
    const timeoutMs = 40;
    const terminationGraceMs = 40;
    const runner = createSupervisorCommandProbeRunner(supervisor, {
      terminationGraceMs,
    });
    const boundProbe = new CommandProbe({
      cwd: directory,
      timeoutMs,
      runner,
    });

    const runPromise = boundProbe.run({
      attemptId: asAttemptId('supervisor-timeout-1'),
      executable: 'hang-cli',
      args: ['--version'],
      timeoutMs,
      shell: false,
    });

    // Real timers drive stop escalation; FakeClock drives supervisor events.
    const pump = async (ms: number): Promise<void> => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        clock.advanceBy(5);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      clock.advanceBy(50);
    };
    await pump(timeoutMs + terminationGraceMs + 80);
    const result = await runPromise;

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error ?? '').toMatch(/timed out/i);
    const callTypes = supervisor.calls.map((call) => call.type);
    expect(callTypes).toContain('request_graceful_stop');
    expect(callTypes).toContain('force_stop_tree');
    const gracefulIdx = callTypes.indexOf('request_graceful_stop');
    const forceIdx = callTypes.indexOf('force_stop_tree');
    expect(gracefulIdx).toBeGreaterThanOrEqual(0);
    expect(forceIdx).toBeGreaterThan(gracefulIdx);
  }, 15_000);

  it('fails closed with cleanup_failed when force tree cleanup fails (no timedOut success)', async () => {
    const directory = temporaryDirectory();
    const clock = new FakeClock('2026-07-13T00:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 71_003,
        timeline: [{ afterMs: 0, event: { type: 'started', pid: 71_003 } }],
        gracefulStop: {
          afterMs: 5,
          outcome: 'failed',
          error: 'graceful ignored',
        },
        forceStop: {
          afterMs: 5,
          outcome: 'failed',
          error: 'job cleanup failed',
        },
      },
    ]);
    const timeoutMs = 30;
    const terminationGraceMs = 30;
    const runner = createSupervisorCommandProbeRunner(supervisor, {
      terminationGraceMs,
    });
    const probe = new CommandProbe({
      cwd: directory,
      timeoutMs,
      runner,
    });

    const runPromise = probe.run({
      attemptId: asAttemptId('supervisor-cleanup-fail-1'),
      executable: 'hang-cli',
      args: ['--version'],
      timeoutMs,
      shell: false,
    });
    const end = Date.now() + timeoutMs + terminationGraceMs * 2 + 200;
    while (Date.now() < end) {
      clock.advanceBy(5);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    clock.advanceBy(100);
    const result = await runPromise;

    expect(result.ok).toBe(false);
    // Must not claim clean timeout when cleanup failed.
    expect(result.error ?? '').toMatch(/cleanup_failed|cleanup failed/i);
    expect(result.timedOut).toBe(false);
  }, 15_000);

  it('injected test-only fixture runner never raw-kills PIDs (no taskkill path)', async () => {
    const directory = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex-cli 0.144.1\n', pid: 99_001 }],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd: directory });
    const result = await probe.run({
      attemptId: asAttemptId('fixture-only-1'),
      executable: 'codex',
      args: ['--version'],
    });
    expect(result.ok).toBe(true);
    // Fixture runner is pure in-memory — no OS process / taskkill.
    expect(result.evidence.pid).toBe(99_001);
  });
});

describe('nonzero exit and spawn misclassification (fail closed)', () => {
  it('does not treat parseable version stdout as available when exit != 0', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex-cli 0.144.1\n', exitCode: 2 }],
        ['claude', ['--version'], { stdout: '2.1.206 (Claude Code)\n', exitCode: 1 }],
        ['grok', ['--version'], { stdout: '0.2.93\n', exitCode: 3 }],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });

    expect(await checkCodexHealth(probe)).toMatchObject({
      status: 'error',
      version: '0.144.1',
    });
    expect(await checkClaudeHealth(probe)).toMatchObject({
      status: 'error',
      version: '2.1.206',
    });
    expect(await checkGrokHealth(probe)).toMatchObject({
      status: 'error',
      version: '0.2.93',
    });
  });

  it('classifies only ENOENT as missing; EACCES/EPERM/invalid cwd are error', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { spawnError: 'spawn codex EACCES' }],
        ['claude', ['--version'], { spawnError: 'spawn claude EPERM' }],
        ['grok', ['--version'], { spawnError: 'spawn grok EINVAL invalid cwd' }],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });

    expect(await checkCodexHealth(probe)).toMatchObject({ status: 'error' });
    expect(await checkClaudeHealth(probe)).toMatchObject({ status: 'error' });
    expect(await checkGrokHealth(probe)).toMatchObject({ status: 'error' });

    const enoent = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { spawnError: 'spawn codex ENOENT' }],
      ]),
    );
    expect(
      await checkCodexHealth(new CommandProbe({ runner: enoent, cwd })),
    ).toMatchObject({ status: 'missing' });
  });

  it('does not yield available/auth-unknown ready when grok inspect exits nonzero', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['grok', ['--version'], { stdout: '0.2.93\n' }],
        [
          'grok',
          ['inspect', '--json'],
          {
            stdout: `${JSON.stringify({ version: '0.2.93' })}\n`,
            exitCode: 1,
          },
        ],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });
    const report = await checkGrokHealth(probe);
    expect(report.status).toBe('error');
    expect(report.auth).toBe('error');
    expect(report.status).not.toBe('available');
  });

  it('treats codex/claude auth nonzero with parseable logged-in text as error not available', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex-cli 0.144.1\n' }],
        [
          'codex',
          ['login', 'status'],
          { stdout: 'Logged in using ChatGPT\n', exitCode: 2 },
        ],
        ['claude', ['--version'], { stdout: '2.1.206 (Claude Code)\n' }],
        [
          'claude',
          ['auth', 'status'],
          { stdout: 'Logged in as user@example.com\n', exitCode: 2 },
        ],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });
    expect(await checkCodexHealth(probe)).toMatchObject({
      status: 'error',
      auth: 'error',
    });
    expect(await checkClaudeHealth(probe)).toMatchObject({
      status: 'error',
      auth: 'error',
    });
  });
});

describe('compatibility matrix', () => {
  const platform = process.platform;

  it('keys records by exact CLI name + parsed version + platform', () => {
    const codexKey: CompatibilityKey = {
      cliName: 'codex',
      version: '0.144.1',
      platform,
    };
    const claudeKey: CompatibilityKey = {
      cliName: 'claude',
      version: '2.1.206',
      platform,
    };
    const grokKey: CompatibilityKey = {
      cliName: 'grok',
      version: '0.2.93',
      platform,
    };

    const codex = requireVerifiedCompatibility(codexKey);
    const claude = requireVerifiedCompatibility(claudeKey);
    const grok = requireVerifiedCompatibility(grokKey);

    expect(codex.key).toEqual(codexKey);
    expect(claude.key).toEqual(claudeKey);
    expect(grok.key).toEqual(grokKey);

    expect(codex.jsonl).toBe(true);
    expect(codex.outputSchema).toBe(true);
    expect(codex.resume).toBe(true);
    expect(codex.readOnly).toBe(true);
    expect(codex.projectWrite).toBe(true);
    expect(codex.nonGit).toBe(true);

    expect(claude.jsonl).toBe(true);
    expect(claude.outputSchema).toBe(true);
    expect(claude.fixedSessionId).toBe(true);
    expect(claude.resume).toBe(true);
    expect(claude.readOnly).toBe(true);
    // Claude 2.1.206 has no proven project-scoped write sandbox.
    expect(claude.projectWrite).toBe(false);
    expect(claude.capabilities.writeModes).toEqual(['read-only']);
    expect(claude.capabilities.writeModes).not.toContain('workspace-write');

    expect(grok.maxTurns).toBe(true);
    expect(grok.projectWrite).toBe(false);
    // Help proves syntax only — enforcement unproven without loaded live proof.
    expect(grok.readOnly).toBe(false);
  });

  it('disables unknown CLI/version pairs (never infer from product name alone)', () => {
    expect(
      lookupCompatibility({
        cliName: 'codex',
        version: '9.9.9',
        platform,
      }),
    ).toBeUndefined();
    expect(
      lookupCompatibility({
        // Product marketing names must never match exact CLI name keys.
        cliName: 'openai' as CompatibilityKey['cliName'],
        version: '0.144.1',
        platform,
      }),
    ).toBeUndefined();
    expect(() =>
      requireVerifiedCompatibility({
        cliName: 'codex',
        version: '9.9.9',
        platform,
      }),
    ).toThrow(/unverified|unknown|disabled/i);
  });

  it('maps verified records to AgentCapabilities without optimistic flags', () => {
    const record = requireVerifiedCompatibility({
      cliName: 'codex',
      version: '0.144.1',
      platform,
    });
    expect(record.capabilities.streamJson).toBe(true);
    expect(record.capabilities.structuredOutput).toBe(true);
    expect(record.capabilities.resume).toBe(true);
    expect(record.capabilities.writeModes).toEqual(
      expect.arrayContaining(['read-only', 'workspace-write']),
    );
    // Unknown realtime input must stay disabled.
    expect(record.realTimeInput).toBe(false);
    expect(record.capabilities.realTimeInput).toBe(false);
  });

  it('enables only Grok 0.2.93 capabilities proven by exact local help (Task16)', () => {
    const grok = requireVerifiedCompatibility({
      cliName: 'grok',
      version: '0.2.93',
      platform,
    });
    // Proven offline (syntax only): streaming-json, session-id, resume, max-turns.
    expect(grok.jsonl).toBe(true);
    expect(grok.capabilities.streamJson).toBe(true);
    expect(grok.fixedSessionId).toBe(true);
    expect(grok.resume).toBe(true);
    expect(grok.maxTurns).toBe(true);
    expect(grok.capabilities.turnLimit).toBe(true);
    // Help flags prove syntax only — NOT enforcement. Default matrix stays disabled.
    expect(grok.capabilities.nativePermissionRules).toBe(false);
    expect(grok.readOnly).toBe(false);
    expect(grok.capabilities.writeModes).toEqual([]);
    // Still disabled until exact offline/live proof exists.
    expect(grok.outputSchema).toBe(false);
    expect(grok.capabilities.structuredOutput).toBe(false);
    expect(grok.realTimeInput).toBe(false);
    expect(grok.projectWrite).toBe(false);
    expect(grok.capabilities.nativeSandbox).toBe(false);
    expect(grok.capabilities.writeModes).not.toContain('workspace-write');
    expect(grok.capabilities.writeModes).not.toContain('read-only');
  });

  it('enforces matrix/AgentCapabilities invariants for every verified record', () => {
    const records = listVerifiedCompatibility();
    expect(records.length).toBeGreaterThan(0);
    for (const entry of records) {
      expect(() => assertCompatibilityRecordInvariants(entry)).not.toThrow();
      // Unknown disabled: if matrix flag is false, capability mirror is false.
      if (!entry.outputSchema) {
        expect(entry.capabilities.structuredOutput).toBe(false);
      }
      if (!entry.jsonl) {
        expect(entry.capabilities.streamJson).toBe(false);
      }
      if (!entry.resume) {
        expect(entry.capabilities.resume).toBe(false);
      }
      if (!entry.realTimeInput) {
        expect(entry.capabilities.realTimeInput).toBe(false);
      }
      if (!entry.fixedSessionId) {
        expect(entry.capabilities.fixedSessionId).toBe(false);
      }
    }
  });

  it('represents ProjectGuard + BudgetController prerequisites before Worker start_run', () => {
    const record = requireVerifiedCompatibility({
      cliName: 'codex',
      version: '0.144.1',
      platform,
    });

    const missingGuard = workerStartPrerequisites({
      capabilityRecord: record,
      projectGuardDecisionId: undefined,
      projectGuardMode: 'workspace-write',
      budgetCanLaunch: true,
      reservedBudgetId: 'budget-1',
      authStatus: 'authenticated',
      requiresReadinessProbe: false,
      readinessProbeCompleted: false,
    });
    expect(missingGuard.allowed).toBe(false);
    expect(missingGuard.missing).toEqual(
      expect.arrayContaining(['project_guard_decision']),
    );

    const budgetBlocked = workerStartPrerequisites({
      capabilityRecord: record,
      projectGuardDecisionId: 'guard-decision-1',
      projectGuardMode: 'workspace-write',
      budgetCanLaunch: false,
      reservedBudgetId: 'budget-1',
      authStatus: 'authenticated',
      requiresReadinessProbe: false,
      readinessProbeCompleted: false,
    });
    expect(budgetBlocked.allowed).toBe(false);
    expect(budgetBlocked.missing).toEqual(
      expect.arrayContaining(['budget_can_launch']),
    );

    const grokAuthPending = workerStartPrerequisites({
      capabilityRecord: requireVerifiedCompatibility({
        cliName: 'grok',
        version: '0.2.93',
        platform,
      }),
      projectGuardDecisionId: 'guard-decision-2',
      projectGuardMode: 'read-only',
      budgetCanLaunch: true,
      reservedBudgetId: 'budget-2',
      authStatus: 'unknown',
      requiresReadinessProbe: true,
      readinessProbeCompleted: false,
    });
    expect(grokAuthPending.allowed).toBe(false);
    expect(grokAuthPending.missing).toEqual(
      expect.arrayContaining(['readiness_probe']),
    );

    const expired = workerStartPrerequisites({
      capabilityRecord: record,
      projectGuardDecisionId: 'guard-decision-exp',
      projectGuardMode: 'workspace-write',
      budgetCanLaunch: true,
      reservedBudgetId: 'budget-exp',
      authStatus: 'authenticated',
      requiresReadinessProbe: false,
      readinessProbeCompleted: false,
      expiresAtMs: 1_000,
      nowMs: 2_000,
    });
    expect(expired.allowed).toBe(false);
    expect(expired.missing).toEqual(
      expect.arrayContaining(['expired_prerequisite']),
    );

    const mismatched = workerStartPrerequisites({
      capabilityRecord: record,
      expectedCliName: 'claude',
      projectGuardDecisionId: 'guard-decision-mm',
      projectGuardMode: 'workspace-write',
      budgetCanLaunch: true,
      reservedBudgetId: 'budget-mm',
      authStatus: 'authenticated',
      requiresReadinessProbe: false,
      readinessProbeCompleted: false,
    });
    expect(mismatched.allowed).toBe(false);
    expect(mismatched.missing).toEqual(
      expect.arrayContaining(['capability_mismatch']),
    );

    const ready = workerStartPrerequisites({
      capabilityRecord: record,
      projectGuardDecisionId: 'guard-decision-3',
      projectGuardMode: 'workspace-write',
      budgetCanLaunch: true,
      reservedBudgetId: 'budget-3',
      authStatus: 'authenticated',
      requiresReadinessProbe: false,
      readinessProbeCompleted: false,
    });
    expect(ready.allowed).toBe(true);
    if (ready.allowed) {
      expect(ready.projectGuardDecisionId).toBe('guard-decision-3');
      expect(ready.projectGuardMode).toBe('workspace-write');
      expect(ready.budgetCanLaunch).toBe(true);
      expect(ready.capabilityKey).toEqual(record.key);
      expect(ready.reservedBudgetId).toBe('budget-3');
      expect(ready.gate.projectGuardDecisionId).toBe('guard-decision-3');
      expect(ready.gate.reservedBudgetId).toBe('budget-3');
    }
  });

  it('attaches verified compatibility on successful current-version health checks', async () => {
    const cwd = temporaryDirectory();
    mkdirSync(join(cwd, 'nested'), { recursive: true });
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex-cli 0.144.1\n' }],
        ['codex', ['login', 'status'], { stdout: 'Logged in using ChatGPT\n' }],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });
    const report = await checkCodexHealth(probe);
    expect(report.status).toBe('available');
    expect(report.compatibility?.key).toEqual({
      cliName: 'codex',
      version: '0.144.1',
      platform: process.platform,
    });
    expect(report.compatibility?.verified).toBe(true);
  });
});

describe('health probe path isolation', () => {
  it('uses temp/fixture cwd and never writes into the current project root', async () => {
    const cwd = temporaryDirectory();
    const runner = createFixtureRunner(
      mapFor([
        ['codex', ['--version'], { stdout: 'codex-cli 0.144.1\n' }],
        ['codex', ['login', 'status'], { stdout: 'Logged in using ChatGPT\n' }],
      ]),
    );
    const probe = new CommandProbe({ runner, cwd });
    await checkCodexHealth(probe);
    expect(resolve(runner.calls[0]!.cwd)).toBe(resolve(cwd));
    expect(resolve(cwd).startsWith(projectRoot)).toBe(false);
    // Temp fixture may create files; project tree must remain unchanged.
    expect(existsSync(join(projectRoot, 'should-not-exist-from-probe.txt'))).toBe(
      false,
    );
  });
});
