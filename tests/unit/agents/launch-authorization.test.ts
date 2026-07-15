import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LaunchAuthorizationRepository,
  type LaunchAuthorizationIntent,
  type LaunchAuthorizationRecord,
} from '../../../src/agents/launch-authorization-repository.js';
import type { CompatibilityKey } from '../../../src/agents/compatibility-matrix.js';
import {
  asAttemptId,
  asTaskId,
} from '../../../src/domain/ids.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import { CodexAdapter } from '../../../src/agents/codex/codex-adapter.js';
import type { CodexRunRequest } from '../../../src/agents/codex/codex-adapter.js';
import { requireVerifiedCompatibility } from '../../../src/agents/compatibility-matrix.js';
import { asBaselineId, asConversationId } from '../../../src/domain/ids.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';
import { resolve } from 'node:path';
import { WorkerStartGateVerifier } from '../../../src/workers/worker-start-gate-verifier.js';
import { seedVerifiedWorkerStartGate } from '../../fakes/worker-start-gate.js';
import type { WorkflowSnapshot } from '../../../src/workflow/states.js';

const SCHEMA = resolve('schemas/agent-result.schema.json');
const PROJECT = 'D:\\temporary project\\launch-auth';

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-launch-auth-'));
  temporaryDirectories.push(directory);
  return directory;
}

function requireReadWrite(opened: OpenedDatabase): ReadWriteDatabase {
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return opened;
}

function openTestDatabase(): ReadWriteDatabase {
  const directory = temporaryDirectory();
  const opened = openDatabase(join(directory, 'triagent.sqlite'));
  openedDatabases.push(opened);
  return requireReadWrite(opened);
}

function codexKey(): CompatibilityKey {
  return {
    cliName: 'codex',
    version: '0.144.1',
    platform: process.platform,
  };
}

function baseIntent(
  overrides: Partial<LaunchAuthorizationIntent> = {},
): LaunchAuthorizationIntent {
  return {
    taskId: asTaskId('task-launch-auth-1'),
    attemptId: asAttemptId('attempt-launch-auth-1'),
    adapterKind: 'codex',
    adapterVersion: '0.144.1',
    adapterPlatform: process.platform,
    role: 'implementer',
    mode: 'project_write',
    guardDecisionId: 'guard-decision-1',
    budgetReservationId: 'budget-reservation-1',
    schemaPath: SCHEMA,
    nonGit: false,
    ...overrides,
  };
}

function plan(pid: number) {
  return {
    pid,
    timeline: [
      { afterMs: 0, event: { type: 'started' as const, pid } },
      {
        afterMs: 1,
        event: {
          type: 'exited' as const,
          pid,
          exitCode: 0,
          signal: null,
          reason: 'exited' as const,
        },
      },
    ],
  };
}

function activeAuthorizationWindow(): {
  readonly nowIso: string;
  readonly expiresAt: string;
} {
  const nowMs = Date.now();
  return {
    nowIso: new Date(nowMs - 60_000).toISOString(),
    expiresAt: new Date(nowMs + 60 * 60_000).toISOString(),
  };
}

afterEach(() => {
  while (openedDatabases.length > 0) {
    const db = openedDatabases.pop();
    db?.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('LaunchAuthorizationRepository (opaque store-backed one-time auth)', () => {
  it('issues a random immutable authorization id with status=issued', () => {
    const db = openTestDatabase();
    const repo = new LaunchAuthorizationRepository(db.connection);
    const now = '2026-07-13T10:00:00.000Z';
    const expiresAt = '2026-07-13T10:05:00.000Z';
    const issued = repo.issue(baseIntent(), { nowIso: now, expiresAt });

    expect(issued.authorizationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(issued.status).toBe('issued');
    expect(issued.taskId).toBe('task-launch-auth-1');
    expect(issued.attemptId).toBe('attempt-launch-auth-1');
    expect(issued.adapterKind).toBe('codex');
    expect(issued.adapterVersion).toBe('0.144.1');
    expect(issued.role).toBe('implementer');
    expect(issued.mode).toBe('project_write');
    expect(issued.guardDecisionId).toBe('guard-decision-1');
    expect(issued.budgetReservationId).toBe('budget-reservation-1');
    expect(issued.schemaPath).toBe(SCHEMA);
    expect(issued.nonGit).toBe(false);
    expect(issued.expiresAt).toBe(expiresAt);
    expect(issued.createdAt).toBe(now);

    const loaded = repo.get(issued.authorizationId);
    expect(loaded).toEqual(issued);
  });

  it('consumeAndVerify succeeds once then fails on reuse (atomic one-time)', () => {
    const db = openTestDatabase();
    const repo = new LaunchAuthorizationRepository(db.connection);
    const intent = baseIntent();
    const issued = repo.issue(intent, {
      nowIso: '2026-07-13T10:00:00.000Z',
      expiresAt: '2026-07-13T11:00:00.000Z',
    });

    const first = repo.consumeAndVerify(issued.authorizationId, intent, {
      nowMs: Date.parse('2026-07-13T10:30:00.000Z'),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.record.status).toBe('consumed');
    expect(first.record.consumedAt).toBeDefined();

    const second = repo.consumeAndVerify(issued.authorizationId, intent, {
      nowMs: Date.parse('2026-07-13T10:31:00.000Z'),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toMatch(/reused|consumed|already/i);
  });

  it('rejects missing, forged, mismatched, and expired authorizations', () => {
    const db = openTestDatabase();
    const repo = new LaunchAuthorizationRepository(db.connection);
    const intent = baseIntent();
    const issued = repo.issue(intent, {
      nowIso: '2026-07-13T10:00:00.000Z',
      expiresAt: '2026-07-13T10:05:00.000Z',
    });

    const missing = repo.consumeAndVerify('forged-missing-id', intent, {
      nowMs: Date.parse('2026-07-13T10:01:00.000Z'),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toMatch(/missing|not found|unknown/i);
    }

    const mismatched = repo.consumeAndVerify(issued.authorizationId, {
      ...intent,
      budgetReservationId: 'wrong-budget',
    }, {
      nowMs: Date.parse('2026-07-13T10:01:00.000Z'),
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.reason).toMatch(/mismatch|intent/i);
    }
    // Failed mismatch must not consume (still issued).
    expect(repo.get(issued.authorizationId)?.status).toBe('issued');

    const expired = repo.consumeAndVerify(issued.authorizationId, intent, {
      nowMs: Date.parse('2026-07-13T10:06:00.000Z'),
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.reason).toMatch(/expired/i);
    }
  });

  it('does not accept a forgeable plain WorkerStartGateRecord object as authorization', async () => {
    const clock = new FakeClock('2026-07-13T12:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [plan(9101)]);
    const db = openTestDatabase();
    const launchAuth = new LaunchAuthorizationRepository(db.connection);
    const adapter = new CodexAdapter({
      supervisor,
      launchAuthorization: launchAuth,
    });
    const capabilityKey = codexKey();
    const request = {
      attemptId: asAttemptId('attempt-forge-1'),
      baselineId: asBaselineId('baseline-forge-1'),
      requirementVersion: 1,
      role: 'implementer' as const,
      projectRoot: PROJECT,
      prompt: 'prompt-must-not-start',
      capabilityKey,
      capabilityRecord: requireVerifiedCompatibility(capabilityKey),
      projectGuardDecisionId: 'guard-decision-1',
      reservedBudgetId: 'budget-reservation-1',
      mode: 'project_write' as const,
      nonGit: false,
      schemaPath: SCHEMA,
      // Forgeable plain object — must be rejected; only opaque id is accepted.
      startGate: Object.freeze({
        capabilityKey: Object.freeze({ ...capabilityKey }),
        projectGuardDecisionId: 'guard-decision-1',
        projectGuardMode: 'project_write',
        projectGuardAttemptId: 'attempt-forge-1',
        reservedBudgetId: 'budget-reservation-1',
        budgetCanLaunch: true as const,
        authStatus: 'authenticated' as const,
        requiresReadinessProbe: false,
        readinessProbeCompleted: false,
      }),
    } as unknown as CodexRunRequest;

    await expect(adapter.start(request)).rejects.toThrow(
      /launchAuthorizationId|authorization|start.?gate/i,
    );
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(0);
  });

  it('CodexAdapter consumes opaque authorization id before ProcessSupervisor.start', async () => {
    const clock = new FakeClock('2026-07-13T12:05:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [plan(9102)]);
    const db = openTestDatabase();
    const launchAuth = new LaunchAuthorizationRepository(db.connection);
    const capabilityKey = codexKey();
    const attemptId = asAttemptId('attempt-auth-ok-1');
    const intent = baseIntent({
      attemptId,
      schemaPath: SCHEMA,
    });
    const issued = launchAuth.issue(intent, activeAuthorizationWindow());

    const adapter = new CodexAdapter({
      supervisor,
      launchAuthorization: launchAuth,
    });
    const request: CodexRunRequest = {
      attemptId,
      taskId: intent.taskId,
      baselineId: asBaselineId('baseline-auth-ok-1'),
      requirementVersion: 1,
      role: 'implementer',
      projectRoot: PROJECT,
      prompt: 'SECRET_PROMPT_TOKEN_auth',
      capabilityKey,
      capabilityRecord: requireVerifiedCompatibility(capabilityKey),
      projectGuardDecisionId: intent.guardDecisionId,
      reservedBudgetId: intent.budgetReservationId,
      mode: 'project_write',
      nonGit: false,
      schemaPath: SCHEMA,
      launchAuthorizationId: issued.authorizationId,
    };

    const handle = await adapter.start(request);
    const start = supervisor.calls.find((c) => c.type === 'start');
    expect(start?.type).toBe('start');
    if (start?.type !== 'start') return;
    expect(start.request.stdin).toEqual({
      encoding: 'utf8',
      data: 'SECRET_PROMPT_TOKEN_auth',
      closeAfterWrite: true,
    });
    expect(start.request.args.join('\0')).not.toContain('SECRET_PROMPT_TOKEN_auth');
    expect(launchAuth.get(issued.authorizationId)?.status).toBe('consumed');
    clock.advanceBy(5);
    await handle.wait();
  });

  it('resume requires a fresh authorization and consumes it (not reuse)', async () => {
    const clock = new FakeClock('2026-07-13T12:10:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [plan(9201), plan(9202)]);
    const db = openTestDatabase();
    const launchAuth = new LaunchAuthorizationRepository(db.connection);
    const capabilityKey = codexKey();
    const adapter = new CodexAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      fixedCapabilities: requireVerifiedCompatibility(capabilityKey).capabilities,
    });

    const startIntent = baseIntent({
      attemptId: asAttemptId('attempt-auth-resume-1'),
    });
    const authorizationWindow = activeAuthorizationWindow();
    const startAuth = launchAuth.issue(startIntent, authorizationWindow);
    await adapter.start({
      attemptId: startIntent.attemptId,
      taskId: startIntent.taskId,
      baselineId: asBaselineId('baseline-auth-resume'),
      requirementVersion: 1,
      role: 'implementer',
      projectRoot: PROJECT,
      prompt: 'start-prompt',
      capabilityKey,
      capabilityRecord: requireVerifiedCompatibility(capabilityKey),
      projectGuardDecisionId: startIntent.guardDecisionId,
      reservedBudgetId: startIntent.budgetReservationId,
      mode: 'project_write',
      nonGit: false,
      schemaPath: SCHEMA,
      launchAuthorizationId: startAuth.authorizationId,
    });

    // Reusing start authorization id on resume must fail with zero additional start.
    await expect(
      adapter.resume(asConversationId('conversation-1'), {
        attemptId: asAttemptId('attempt-auth-resume-2'),
        taskId: startIntent.taskId,
        baselineId: asBaselineId('baseline-auth-resume'),
        requirementVersion: 1,
        role: 'implementer',
        projectRoot: PROJECT,
        prompt: 'resume-prompt',
        capabilityKey,
        capabilityRecord: requireVerifiedCompatibility(capabilityKey),
        projectGuardDecisionId: startIntent.guardDecisionId,
        reservedBudgetId: startIntent.budgetReservationId,
        mode: 'project_write',
        nonGit: false,
        schemaPath: SCHEMA,
        launchAuthorizationId: startAuth.authorizationId,
      }),
    ).rejects.toThrow(/reused|consumed|authorization|launch/i);
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(1);

    const resumeIntent = baseIntent({
      attemptId: asAttemptId('attempt-auth-resume-2'),
    });
    const resumeAuth = launchAuth.issue(resumeIntent, authorizationWindow);
    await adapter.resume(asConversationId('conversation-1'), {
      attemptId: resumeIntent.attemptId,
      taskId: resumeIntent.taskId,
      baselineId: asBaselineId('baseline-auth-resume'),
      requirementVersion: 1,
      role: 'implementer',
      projectRoot: PROJECT,
      prompt: 'resume-prompt',
      capabilityKey,
      capabilityRecord: requireVerifiedCompatibility(capabilityKey),
      projectGuardDecisionId: resumeIntent.guardDecisionId,
      reservedBudgetId: resumeIntent.budgetReservationId,
      mode: 'project_write',
      nonGit: false,
      schemaPath: SCHEMA,
      launchAuthorizationId: resumeAuth.authorizationId,
    });
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(2);
    expect(launchAuth.get(resumeAuth.authorizationId)?.status).toBe('consumed');
  });

  it('WorkerStartGateVerifier issues store-backed authorization only after full evidence validate+consume', () => {
    const db = openTestDatabase();
    const taskId = asTaskId('task-verifier-auth-1');
    const attemptId = asAttemptId('attempt-verifier-auth-1');
    // PathPolicy requires a real directory for projectRoot.
    const projectRoot = temporaryDirectory();
    // GuardDecision FK requires a real task row.
    const repositories = createPersistenceRepositories(db);
    repositories.tasks.createProject({
      projectId: 'project-verifier-auth-1',
      rootPath: projectRoot,
    });
    const snapshot: WorkflowSnapshot = {
      state: 'implementing',
      taskId,
      requirementVersion: 1,
      reworkCount: 0,
      maxReworks: 3,
      pauseAfterAttempt: false,
      activeAttemptId: attemptId,
      activeAttemptBaselineId: asBaselineId('baseline-verifier-auth-1'),
      activeAttemptRole: 'implementer',
    };
    repositories.tasks.create({
      taskId,
      projectId: 'project-verifier-auth-1',
      workflowSnapshot: snapshot,
      workflowVersion: 1,
      status: 'implementing',
    });

    const seeded = seedVerifiedWorkerStartGate(db.connection, {
      taskId,
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot,
    });

    const verifier = new WorkerStartGateVerifier(db.connection);
    const result = verifier.authorizeForLaunch({
      taskId,
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      refs: seeded.startGate,
      nonGit: false,
      schemaPath: SCHEMA,
      mode: 'project_write',
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.launchAuthorizationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const authRepo = new LaunchAuthorizationRepository(db.connection);
    const record = authRepo.get(result.launchAuthorizationId) as LaunchAuthorizationRecord;
    expect(record.status).toBe('issued');
    expect(record.taskId).toBe(taskId);
    expect(record.attemptId).toBe(attemptId);
    expect(record.guardDecisionId).toBe(seeded.guardDecision.id);
    expect(record.budgetReservationId).toBe(seeded.reservedBudgetId);
    expect(record.adapterKind).toBe('codex');
    expect(record.adapterVersion).toBe('0.144.1');
    expect(record.role).toBe('implementer');
    expect(record.mode).toBe('project_write');
    expect(record.nonGit).toBe(false);
    expect(record.schemaPath).toBe(SCHEMA);

    // Budget reservation must already be consumed (reserved → launched).
    // A second authorize for the same reservation fails closed.
    const second = verifier.authorizeForLaunch({
      taskId,
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      refs: seeded.startGate,
      nonGit: false,
      schemaPath: SCHEMA,
      mode: 'project_write',
    });
    expect(second.allowed).toBe(false);
  });

  it('forged authorization id yields zero ProcessSupervisor start', async () => {
    const clock = new FakeClock('2026-07-13T12:20:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [plan(9301)]);
    const db = openTestDatabase();
    const launchAuth = new LaunchAuthorizationRepository(db.connection);
    const adapter = new CodexAdapter({
      supervisor,
      launchAuthorization: launchAuth,
    });
    const capabilityKey = codexKey();

    await expect(
      adapter.start({
        attemptId: asAttemptId('attempt-forged-id'),
        baselineId: asBaselineId('baseline-forged-id'),
        requirementVersion: 1,
        role: 'implementer',
        projectRoot: PROJECT,
        prompt: 'nope',
        capabilityKey,
        capabilityRecord: requireVerifiedCompatibility(capabilityKey),
        projectGuardDecisionId: 'guard-decision-1',
        reservedBudgetId: 'budget-reservation-1',
        mode: 'project_write',
        nonGit: false,
        schemaPath: SCHEMA,
        launchAuthorizationId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow(/authorization|missing|not found|unknown/i);
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(0);
  });
});
