import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeAdapter,
  type ClaudeRunRequest,
} from '../../src/agents/claude/claude-adapter.js';
import {
  CodexAdapter,
  type CodexRunRequest,
} from '../../src/agents/codex/codex-adapter.js';
import { checkClaudeHealth } from '../../src/agents/health/claude-health.js';
import { checkCodexHealth } from '../../src/agents/health/codex-health.js';
import { CommandProbe } from '../../src/agents/health/command-probe.js';
import { LaunchAuthorizationRepository } from '../../src/agents/launch-authorization-repository.js';
import {
  asAttemptId,
  asBaselineId,
  asTaskId,
} from '../../src/domain/ids.js';
import {
  openDatabase,
  type OpenedDatabase,
} from '../../src/persistence/database.js';
import { ProcessSupervisor } from '../../src/process/process-supervisor.js';

const REAL_AI_ENABLED = process.env.TRIAGENT_REAL_AI_TESTS === '1';
const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];
const supervisors: ProcessSupervisor[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0).reverse()) {
    await supervisor.dispose().catch(() => undefined);
  }
  for (const opened of openedDatabases.splice(0).reverse()) {
    opened.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createSupervisor(): ProcessSupervisor {
  const supervisor = new ProcessSupervisor();
  supervisors.push(supervisor);
  return supervisor;
}

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function disposableRepository(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `triagent-real-smoke-${name}-`));
  temporaryDirectories.push(root);
  const repository = join(root, 'project');
  mkdirSync(repository);
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.email', 'triagent@example.invalid');
  git(repository, 'config', 'user.name', 'TriAgent Real Smoke');
  git(repository, 'config', 'core.autocrlf', 'false');
  writeFileSync(
    join(repository, 'README.md'),
    '# Disposable TriAgent smoke repository\n\nMarker: SAFE_READ_ONLY_FIXTURE\n',
    'utf8',
  );
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '-m', 'smoke fixture');
  return repository;
}

function openLaunchAuthorizations(repository: string): LaunchAuthorizationRepository {
  const opened = openDatabase(join(repository, '..', 'triagent-real-smoke.sqlite'));
  openedDatabases.push(opened);
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return new LaunchAuthorizationRepository(opened.connection);
}

function issueLaunchAuthorization(
  repository: LaunchAuthorizationRepository,
  adapterKind: 'codex' | 'claude',
  request: CodexRunRequest | ClaudeRunRequest,
): string {
  const nowMs = Date.now();
  return repository.issue(
    {
      taskId: request.taskId ?? asTaskId(`real-smoke-${adapterKind}`),
      attemptId: request.attemptId,
      adapterKind,
      adapterVersion: request.capabilityKey.version,
      adapterPlatform: request.capabilityKey.platform,
      role: request.role,
      mode: request.mode,
      guardDecisionId: request.projectGuardDecisionId,
      budgetReservationId: request.reservedBudgetId,
      schemaPath: request.schemaPath ?? resolve('schemas', 'agent-result.schema.json'),
      nonGit: request.nonGit,
    },
    {
      nowIso: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 5 * 60_000).toISOString(),
    },
  ).authorizationId;
}

function readOnlyPrompt(agentName: string): string {
  return [
    `This is an explicitly authorized ${agentName} real CLI smoke test.`,
    'Do not modify files. Do not run shell commands. Do not use the network.',
    'Read README.md only and return a result matching the supplied JSON schema.',
    'Use status=completed, nextAction=complete, changedFiles=[], commandsRun=[], issues=[].',
    'Set verification.passed=true and include TRIAGENT_REAL_SMOKE_OK in summary.',
  ].join('\n');
}

describe.skipIf(!REAL_AI_ENABLED)('opt-in real CLI smoke (quota consuming)', () => {
  it('runs Codex in the verified read-only profile inside a disposable Git repository', async () => {
    const repository = disposableRepository('codex');
    const supervisor = createSupervisor();
    expect(supervisor.isNativeHelperTrusted(), supervisor.nativeHelperDiagnostic())
      .toBe(true);
    const probe = new CommandProbe({
      cwd: repository,
      supervisor,
      timeoutMs: 10_000,
    });
    const health = await checkCodexHealth(probe);
    expect(health, health.reason).toMatchObject({
      status: 'available',
      auth: 'authenticated',
      compatibility: { verified: true },
    });
    if (health.compatibility === undefined) {
      throw new Error(health.reason ?? 'Codex has no verified compatibility record');
    }

    const attemptId = asAttemptId('real-smoke-codex');
    const taskId = asTaskId('task-real-smoke-codex');
    const launchAuthorizations = openLaunchAuthorizations(repository);
    const requestBase: CodexRunRequest = {
      attemptId,
      taskId,
      baselineId: asBaselineId('baseline-real-smoke-codex'),
      requirementVersion: 1,
      prompt: readOnlyPrompt('Codex'),
      timeoutMs: 90_000,
      capabilityKey: health.compatibility.key,
      capabilityRecord: health.compatibility,
      projectRoot: repository,
      role: 'master',
      mode: 'read_only',
      nonGit: false,
      schemaPath: resolve('schemas', 'agent-result.schema.json'),
      projectGuardDecisionId: 'real-smoke-codex-read-only',
      reservedBudgetId: 'real-smoke-codex-budget',
    };
    const launchAuthorizationId = issueLaunchAuthorization(
      launchAuthorizations,
      'codex',
      requestBase,
    );
    const adapter = new CodexAdapter({
      supervisor,
      launchAuthorization: launchAuthorizations,
      fixedHealth: health,
    });

    const before = git(repository, 'status', '--porcelain=v1');
    const handle = await adapter.start({
      ...requestBase,
      launchAuthorizationId,
    });
    const run = await handle.wait();
    expect(adapter.lastRunIntent).toMatchObject({
      sandbox: 'read-only',
      approval: 'never',
    });
    expect(launchAuthorizations.get(launchAuthorizationId)?.status).toBe('consumed');
    expect(run).toMatchObject({ status: 'succeeded', exitCode: 0, signal: null });
    expect(JSON.stringify(run.output)).toContain('TRIAGENT_REAL_SMOKE_OK');
    expect(git(repository, 'status', '--porcelain=v1')).toBe(before);
  }, 120_000);

  it('runs Claude in the verified safe read-only profile inside a disposable Git repository', async () => {
    const repository = disposableRepository('claude');
    const supervisor = createSupervisor();
    expect(supervisor.isNativeHelperTrusted(), supervisor.nativeHelperDiagnostic())
      .toBe(true);
    const probe = new CommandProbe({
      cwd: repository,
      supervisor,
      timeoutMs: 10_000,
    });
    const health = await checkClaudeHealth(probe);
    expect(health, health.reason).toMatchObject({
      status: 'available',
      auth: 'authenticated',
      compatibility: { verified: true },
    });
    if (health.compatibility === undefined) {
      throw new Error(health.reason ?? 'Claude has no verified compatibility record');
    }

    const attemptId = asAttemptId('real-smoke-claude');
    const taskId = asTaskId('task-real-smoke-claude');
    const launchAuthorizations = openLaunchAuthorizations(repository);
    const requestBase: ClaudeRunRequest = {
      attemptId,
      taskId,
      baselineId: asBaselineId('baseline-real-smoke-claude'),
      requirementVersion: 1,
      prompt: readOnlyPrompt('Claude'),
      timeoutMs: 90_000,
      capabilityKey: health.compatibility.key,
      capabilityRecord: health.compatibility,
      projectRoot: repository,
      role: 'master',
      mode: 'read_only',
      nonGit: false,
      schemaPath: resolve('schemas', 'agent-result.schema.json'),
      projectGuardDecisionId: 'real-smoke-claude-read-only',
      reservedBudgetId: 'real-smoke-claude-budget',
      sessionId: '00000000-0000-4000-8000-000000000023',
    };
    const launchAuthorizationId = issueLaunchAuthorization(
      launchAuthorizations,
      'claude',
      requestBase,
    );
    const adapter = new ClaudeAdapter({
      supervisor,
      launchAuthorization: launchAuthorizations,
      fixedHealth: health,
    });

    const before = git(repository, 'status', '--porcelain=v1');
    const handle = await adapter.start({
      ...requestBase,
      launchAuthorizationId,
    });
    const run = await handle.wait();
    expect(adapter.lastRunIntent).toMatchObject({
      permissionMode: 'plan',
      safeMode: true,
      promptDelivery: 'stdin',
    });
    expect(launchAuthorizations.get(launchAuthorizationId)?.status).toBe('consumed');
    expect(run).toMatchObject({ status: 'succeeded', exitCode: 0, signal: null });
    expect(JSON.stringify(run.output)).toContain('TRIAGENT_REAL_SMOKE_OK');
    expect(git(repository, 'status', '--porcelain=v1')).toBe(before);
  }, 120_000);
});
