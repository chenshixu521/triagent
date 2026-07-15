import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  requireVerifiedCompatibility,
} from '../../../src/agents/compatibility-matrix.js';
import { HealthEvidenceRepository } from '../../../src/agents/health/health-evidence-repository.js';
import { BudgetRepository } from '../../../src/budget/budget-repository.js';
import {
  asAttemptId,
  asBaselineId,
  asTaskId,
} from '../../../src/domain/ids.js';
import { GuardDecisionRepository } from '../../../src/guard/guard-decision-repository.js';
import { ProjectGuard } from '../../../src/guard/project-guard.js';
import { JsonlLog } from '../../../src/logging/jsonl-log.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import {
  AgentWorkerManager,
  WorkerStartPrerequisitesError,
} from '../../../src/workers/agent-worker-manager.js';
import type { WorkflowSnapshot } from '../../../src/workflow/states.js';
import {
  seedVerifiedWorkerStartGate,
} from '../../fakes/worker-start-gate.js';

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];
const managers: AgentWorkerManager[] = [];
const logs: JsonlLog[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-worker-gate-'));
  temporaryDirectories.push(directory);
  return directory;
}

function requireReadWrite(opened: OpenedDatabase): ReadWriteDatabase {
  expect(opened.mode).toBe('read-write');
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return opened;
}

function openTestDatabase(directory: string): ReadWriteDatabase {
  const opened = openDatabase(join(directory, 'triagent.sqlite'));
  openedDatabases.push(opened);
  return requireReadWrite(opened);
}

function seedImplementingTask(
  database: ReadWriteDatabase,
  taskIdValue: string,
  attemptIdValue: string,
  baselineIdValue: string,
): {
  readonly taskId: ReturnType<typeof asTaskId>;
  readonly attemptId: ReturnType<typeof asAttemptId>;
  readonly baselineId: ReturnType<typeof asBaselineId>;
} {
  const taskId = asTaskId(taskIdValue);
  const attemptId = asAttemptId(attemptIdValue);
  const baselineId = asBaselineId(baselineIdValue);
  const repositories = createPersistenceRepositories(database);
  repositories.tasks.createProject({
    projectId: `project-${taskIdValue}`,
    rootPath: `D:\\${taskIdValue}`,
  });
  const snapshot: WorkflowSnapshot = {
    state: 'implementing',
    taskId,
    requirementVersion: 1,
    reworkCount: 0,
    maxReworks: 3,
    pauseAfterAttempt: false,
    activeAttemptId: attemptId,
    activeAttemptBaselineId: baselineId,
    activeAttemptRole: 'implementer',
  };
  repositories.tasks.create({
    taskId,
    projectId: `project-${taskIdValue}`,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
    status: 'implementing',
  });
  return { taskId, attemptId, baselineId };
}

async function openManager(
  directory: string,
  database: ReadWriteDatabase,
  taskId: ReturnType<typeof asTaskId>,
) {
  const log = await JsonlLog.open({
    directory: join(directory, 'logs'),
    fileName: 'gate.jsonl',
    database: database.connection,
  });
  logs.push(log);
  const manager = new AgentWorkerManager({
    database: database.connection,
    log,
    taskId,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 5_000,
  });
  managers.push(manager);
  return { database, log, manager };
}

afterEach(async () => {
  for (const manager of managers.splice(0).reverse()) {
    await manager.close().catch(() => undefined);
  }
  for (const log of logs.splice(0).reverse()) {
    await log.close().catch(() => undefined);
  }
  for (const opened of openedDatabases.splice(0).reverse()) {
    opened.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Worker start prerequisites gate (Task 13 — real stores)', () => {
  it('fails closed with zero Worker launch when startGate is missing', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-missing',
      'attempt-gate-missing',
      'baseline-gate-missing',
    );
    const { manager } = await openManager(directory, database, taskId);

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'must not launch',
        baselineId,
        requirementVersion: 1,
        // @ts-expect-error intentional missing gate for fail-closed test
        startGate: undefined,
      }),
    ).rejects.toThrow(/startGate|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('rejects caller-claimed capabilityRecord / budgetCanLaunch / auth booleans', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-legacy',
      'attempt-gate-legacy',
      'baseline-gate-legacy',
    );
    const { manager } = await openManager(directory, database, taskId);
    const record = requireVerifiedCompatibility({
      cliName: 'codex',
      version: '0.144.1',
      platform: process.platform,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'forged booleans',
        baselineId,
        requirementVersion: 1,
        startGate: {
          // @ts-expect-error intentional legacy shape
          capabilityRecord: record,
          projectGuardDecisionId: 'forged-guard',
          projectGuardMode: 'workspace-write',
          budgetCanLaunch: true,
          reservedBudgetId: 'forged-budget',
          authStatus: 'authenticated',
          requiresReadinessProbe: false,
          readinessProbeCompleted: true,
        },
      }),
    ).rejects.toThrow(/identifiers only|caller-claimed|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when capability key mismatches agentKind', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-cap',
      'attempt-gate-cap',
      'baseline-gate-cap',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'claude', // mismatches codex capability key
        projectRoot: directory,
        prompt: 'mismatch',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toBeInstanceOf(WorkerStartPrerequisitesError);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed on forged guard decision id (not in store)', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-forged-guard',
      'attempt-gate-forged-guard',
      'baseline-gate-forged-guard',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'forged guard',
        baselineId,
        requirementVersion: 1,
        startGate: {
          ...seeded.startGate,
          projectGuardDecisionId: '00000000-0000-4000-8000-000000000099',
        },
      }),
    ).rejects.toThrow(/project_guard|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when guard decision is bound to another attempt', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-other-attempt',
      'attempt-gate-other-a',
      'baseline-gate-other',
    );
    const otherAttempt = asAttemptId('attempt-gate-other-b');
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId: otherAttempt,
      agentKind: 'codex',
      projectRoot: directory,
    });

    await expect(
      manager.startRun({
        attemptId, // different from guard's attempt
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'other attempt',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/attempt_mismatch|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when budget reservation is forged / missing', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-budget-miss',
      'attempt-gate-budget-miss',
      'baseline-gate-budget-miss',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'forged budget',
        baselineId,
        requirementVersion: 1,
        startGate: {
          ...seeded.startGate,
          reservedBudgetId: '00000000-0000-4000-8000-000000000088',
        },
      }),
    ).rejects.toThrow(/reserved_budget|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when reservation is bound to another attempt', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-budget-other',
      'attempt-gate-budget-other',
      'baseline-gate-budget-other',
    );
    const { manager } = await openManager(directory, database, taskId);
    const otherAttempt = asAttemptId('attempt-budget-other-2');

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
      bindReservationToOtherAttempt: otherAttempt,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'budget other attempt',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/attempt_mismatch|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when reservation was already launched/consumed (reused)', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-reused',
      'attempt-gate-reused',
      'baseline-gate-reused',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
      reservationStatus: 'launched',
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'reused reservation',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/budget_can_launch|reserved_budget|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when guard decision is expired', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-expired',
      'attempt-gate-expired',
      'baseline-gate-expired',
    );
    const { manager } = await openManager(directory, database, taskId);

    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
      decisionTtlMs: 1_000,
      now: () => createdAt,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'expired',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
        // Far past decision expiry.
        startGateNowMs: createdAt.getTime() + 60_000,
      }),
    ).rejects.toThrow(/expired|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when readiness probe required but incomplete (Grok)', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-readiness',
      'attempt-gate-readiness',
      'baseline-gate-readiness',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'grok',
      projectRoot: directory,
      readinessSucceeded: false,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'grok',
        projectRoot: directory,
        prompt: 'grok needs readiness',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/readiness_probe|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when ProjectGuard mode is not auto_allowed', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-unproven',
      'attempt-gate-unproven',
      'baseline-gate-unproven',
    );
    const { manager } = await openManager(directory, database, taskId);

    // Unproven capabilities → requires_confirmation / disabled, not auto_allowed.
    const guard = new ProjectGuard({ projectRoot: directory });
    const decision = guard.evaluateAdapterStart({
      attemptId,
      role: 'implementer',
      capabilities: {
        fixedSessionId: false,
        resume: false,
        structuredOutput: false,
        streamJson: false,
        realTimeInput: false,
        nativeSandbox: false,
        nativePermissionRules: false,
        budgetLimit: false,
        turnLimit: false,
        timeLimit: false,
        nonGitProjects: false,
        writeModes: [],
      },
      adapter: { kind: 'codex', version: '0.0.0-unproven' },
    });
    expect(decision.mode).not.toBe('auto_allowed');
    new GuardDecisionRepository(database.connection).put(decision, { taskId });

    const budget = new BudgetRepository(database.connection);
    const nowIso = new Date().toISOString();
    budget.ensureTaskState(
      taskId,
      {
        totalActiveRuntimeMs: 60_000,
        perAttemptTimeoutMs: 30_000,
        maxExternalCalls: 5,
      },
      nowIso,
    );
    const reservation = budget.insertReservation({
      taskId,
      attemptId,
      idempotencyKey: `unproven:${taskId}:${attemptId}`,
      guardDecisionId: decision.id,
      reservedAt: nowIso,
    });
    const capabilityKey = requireVerifiedCompatibility({
      cliName: 'codex',
      version: '0.144.1',
      platform: process.platform,
    }).key;
    const health = new HealthEvidenceRepository(database.connection).putAuth({
      capabilityKey,
      taskId,
      attemptId,
      authStatus: 'authenticated',
      probedAt: nowIso,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'unproven guard',
        baselineId,
        requirementVersion: 1,
        startGate: {
          capabilityKey,
          projectGuardDecisionId: decision.id,
          reservedBudgetId: reservation.reservationId,
          healthEvidenceId: health.evidenceId,
        },
      }),
    ).rejects.toThrow(/project_guard|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when guard decision is bound to another task', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-other-task',
      'attempt-gate-other-task',
      'baseline-gate-other-task',
    );
    const otherTask = asTaskId('task-gate-other-task-B');
    seedImplementingTask(
      database,
      'task-gate-other-task-B',
      'attempt-gate-other-task-B',
      'baseline-gate-other-task-B',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
      bindGuardToOtherTaskId: otherTask,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'other task guard',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/project_guard|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when guard adapter version mismatches capabilityKey', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-adapter-mm',
      'attempt-gate-adapter-mm',
      'baseline-gate-adapter-mm',
    );
    const { manager } = await openManager(directory, database, taskId);

    // Seed a valid codex gate, then swap capabilityKey to a different verified version.
    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      version: '0.144.1',
      projectRoot: directory,
    });
    // Only one codex version is verified — forge a key that won't match adapter.version
    // by using a claude capability key while keeping codex agentKind is already covered;
    // here we keep agentKind codex but point capabilityKey at a non-matching synthetic key.
    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'adapter version mismatch',
        baselineId,
        requirementVersion: 1,
        startGate: {
          ...seeded.startGate,
          capabilityKey: {
            cliName: 'codex',
            version: '9.9.9-not-in-matrix',
            platform: process.platform,
          },
        },
      }),
    ).rejects.toThrow(/verified_capability|capability_mismatch|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when reservation.guardDecisionId is null', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-null-guard',
      'attempt-gate-null-guard',
      'baseline-gate-null-guard',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
      nullGuardDecisionIdOnReservation: true,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'null guard on reservation',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/project_guard|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when reservation.guardDecisionId is a different guard id', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-wrong-guard',
      'attempt-gate-wrong-guard',
      'baseline-gate-wrong-guard',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
      bindReservationToOtherGuardId: '00000000-0000-4000-8000-000000000077',
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'wrong guard on reservation',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/project_guard|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed on forged health evidence id (Codex auth)', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-forged-health',
      'attempt-gate-forged-health',
      'baseline-gate-forged-health',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
      forgeHealthId: '00000000-0000-4000-8000-000000000066',
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'forged health',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/authenticated|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when Codex persisted authStatus is unknown (not authenticated)', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-codex-auth-unknown',
      'attempt-gate-codex-auth-unknown',
      'baseline-gate-codex-auth-unknown',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
      authStatus: 'unknown',
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'codex unknown auth must not start',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/authenticated|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when Claude persisted authStatus is unknown (not authenticated)', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-claude-auth-unknown',
      'attempt-gate-claude-auth-unknown',
      'baseline-gate-claude-auth-unknown',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'claude',
      projectRoot: directory,
      authStatus: 'unknown',
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'claude',
        projectRoot: directory,
        prompt: 'claude unknown auth must not start',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/authenticated|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('accepts Codex when persisted authStatus is exactly authenticated', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-codex-auth-ok',
      'attempt-gate-codex-auth-ok',
      'baseline-gate-codex-auth-ok',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
      authStatus: 'authenticated',
    });

    const snap = await manager.startRun({
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'codex authenticated ok',
      baselineId,
      requirementVersion: 1,
      pid: 55_011,
      fakePlans: [
        {
          pid: 55_011,
          timeline: [
            { afterMs: 1, event: { type: 'started', pid: 55_011 } },
            {
              afterMs: 50,
              event: {
                type: 'exited',
                pid: 55_011,
                exitCode: 0,
                signal: null,
                reason: 'exited',
              },
            },
          ],
        },
      ],
      startGate: seeded.startGate,
    });

    expect(snap.state).toBe('running');
    expect(snap.startGate?.authStatus).toBe('authenticated');
    expect(manager.snapshot()?.state).toBe('running');
  }, 20_000);

  it('accepts Grok with authStatus unknown only when valid readiness evidence is present', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-grok-unknown-ready-ok',
      'attempt-gate-grok-unknown-ready-ok',
      'baseline-gate-grok-unknown-ready-ok',
    );
    const { manager } = await openManager(directory, database, taskId);

    // Static Grok matrix keeps readOnly=false (help ≠ enforcement). Simulate a
    // loaded disposable-project enforcement proof for ProjectGuard only so the
    // readiness/auth gate path is reachable. Default matrix remains disabled.
    const elevatedGrokCapabilities = Object.freeze({
      fixedSessionId: true,
      resume: true,
      structuredOutput: false,
      streamJson: true,
      realTimeInput: false,
      nativeSandbox: false,
      nativePermissionRules: true,
      budgetLimit: false,
      turnLimit: true,
      timeLimit: false,
      nonGitProjects: true,
      writeModes: Object.freeze(['read-only'] as const),
    });
    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'grok',
      role: 'reviewer',
      projectRoot: directory,
      readinessSucceeded: true,
      capabilitiesOverride: elevatedGrokCapabilities,
    });

    const snap = await manager.startRun({
      attemptId,
      role: 'reviewer',
      agentKind: 'grok',
      projectRoot: directory,
      prompt: 'grok unknown+readiness ok',
      baselineId,
      requirementVersion: 1,
      pid: 55_012,
      fakePlans: [
        {
          pid: 55_012,
          timeline: [
            { afterMs: 1, event: { type: 'started', pid: 55_012 } },
            {
              afterMs: 50,
              event: {
                type: 'exited',
                pid: 55_012,
                exitCode: 0,
                signal: null,
                reason: 'exited',
              },
            },
          ],
        },
      ],
      startGate: seeded.startGate,
    });

    expect(snap.state).toBe('running');
    expect(snap.startGate?.authStatus).toBe('unknown');
    expect(snap.startGate?.readinessProbeCompleted).toBe(true);
    expect(manager.snapshot()?.state).toBe('running');
  }, 20_000);

  it('fails closed when Grok has authStatus unknown but readiness evidence is missing', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-grok-unknown-no-ready',
      'attempt-gate-grok-unknown-no-ready',
      'baseline-gate-grok-unknown-no-ready',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'grok',
      projectRoot: directory,
      skipReadiness: true,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'grok',
        projectRoot: directory,
        prompt: 'grok unknown without readiness must not start',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/readiness_probe|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed on forged readiness evidence id (Grok)', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-forged-ready',
      'attempt-gate-forged-ready',
      'baseline-gate-forged-ready',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'grok',
      projectRoot: directory,
      forgeReadinessId: '00000000-0000-4000-8000-000000000055',
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'grok',
        projectRoot: directory,
        prompt: 'forged readiness',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/readiness_probe|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when Grok caller tries to bypass readiness via legacy booleans', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-grok-bypass',
      'attempt-gate-grok-bypass',
      'baseline-gate-grok-bypass',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'grok',
      projectRoot: directory,
      skipReadiness: true,
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'grok',
        projectRoot: directory,
        prompt: 'grok bypass attempt',
        baselineId,
        requirementVersion: 1,
        startGate: {
          ...seeded.startGate,
          // Caller cannot claim readiness/auth — these fields are rejected at the gate.
          requiresReadinessProbe: false,
          readinessProbeCompleted: true,
          authStatus: 'authenticated',
        } as typeof seeded.startGate & {
          requiresReadinessProbe: boolean;
          readinessProbeCompleted: boolean;
          authStatus: string;
        },
      }),
    ).rejects.toThrow(/identifiers only|caller-claimed|readiness|denied|authenticated/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when readiness evidence is bound to another task', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-ready-task',
      'attempt-gate-ready-task',
      'baseline-gate-ready-task',
    );
    const other = seedImplementingTask(
      database,
      'task-gate-ready-task-B',
      'attempt-gate-ready-task-B',
      'baseline-gate-ready-task-B',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'grok',
      projectRoot: directory,
      skipReadiness: true,
    });
    const readiness = new HealthEvidenceRepository(database.connection).putReadiness({
      capabilityKey: seeded.capabilityKey,
      taskId: other.taskId,
      attemptId: other.attemptId,
      readinessSucceeded: true,
      probedAt: new Date().toISOString(),
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'grok',
        projectRoot: directory,
        prompt: 'readiness other task',
        baselineId,
        requirementVersion: 1,
        startGate: {
          ...seeded.startGate,
          readinessEvidenceId: readiness.evidenceId,
        },
      }),
    ).rejects.toThrow(/readiness_probe|attempt_mismatch|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when health evidence capabilityKey version mismatches', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-health-ver',
      'attempt-gate-health-ver',
      'baseline-gate-health-ver',
    );
    const { manager } = await openManager(directory, database, taskId);

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
      skipAuth: true,
    });
    // Persist auth evidence with a mismatched version string.
    const health = new HealthEvidenceRepository(database.connection).putAuth({
      capabilityKey: {
        cliName: 'codex',
        version: '0.0.1-wrong',
        platform: process.platform,
      },
      taskId,
      attemptId,
      authStatus: 'authenticated',
      probedAt: new Date().toISOString(),
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'health version mismatch',
        baselineId,
        requirementVersion: 1,
        startGate: {
          ...seeded.startGate,
          healthEvidenceId: health.evidenceId,
        },
      }),
    ).rejects.toThrow(/capability_mismatch|authenticated|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('fails closed when readiness evidence is expired', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-ready-exp',
      'attempt-gate-ready-exp',
      'baseline-gate-ready-exp',
    );
    const { manager } = await openManager(directory, database, taskId);
    const createdAt = new Date('2026-01-01T00:00:00.000Z');

    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'grok',
      projectRoot: directory,
      now: () => createdAt,
      readinessExpiresAt: new Date(createdAt.getTime() + 1_000).toISOString(),
    });

    await expect(
      manager.startRun({
        attemptId,
        role: 'implementer',
        agentKind: 'grok',
        projectRoot: directory,
        prompt: 'expired readiness',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
        startGateNowMs: createdAt.getTime() + 60_000,
      }),
    ).rejects.toThrow(/expired|readiness_probe|prerequisite|denied/i);

    expect(manager.snapshot()).toBeUndefined();
  });

  it('exposes taskId on GuardDecisionRepository.getStored', () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId } = seedImplementingTask(
      database,
      'task-gate-stored',
      'attempt-gate-stored',
      'baseline-gate-stored',
    );
    const record = requireVerifiedCompatibility({
      cliName: 'codex',
      version: '0.144.1',
      platform: process.platform,
    });
    const decision = new ProjectGuard({ projectRoot: directory }).evaluateAdapterStart({
      attemptId,
      role: 'implementer',
      capabilities: record.capabilities,
      adapter: { kind: 'codex', version: '0.144.1' },
    });
    const repo = new GuardDecisionRepository(database.connection);
    repo.put(decision, { taskId });
    const stored = repo.getStored(decision.id);
    expect(stored?.taskId).toBe(taskId);
    expect(stored?.decision.id).toBe(decision.id);
  });

  it('persists verified gate references on successful startRun using real stores', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-gate-ok',
      'attempt-gate-ok',
      'baseline-gate-ok',
    );
    const { manager, log } = await openManager(directory, database, taskId);

    const record = requireVerifiedCompatibility({
      cliName: 'codex',
      version: '0.144.1',
      platform: process.platform,
    });
    const seeded = seedVerifiedWorkerStartGate(database.connection, {
      taskId,
      attemptId,
      agentKind: 'codex',
      projectRoot: directory,
    });

    const snap = await manager.startRun({
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'ok',
      baselineId,
      requirementVersion: 1,
      pid: 55_001,
      fakePlans: [
        {
          pid: 55_001,
          timeline: [
            { afterMs: 1, event: { type: 'started', pid: 55_001 } },
            {
              afterMs: 50,
              event: {
                type: 'exited',
                pid: 55_001,
                exitCode: 0,
                signal: null,
                reason: 'exited',
              },
            },
          ],
        },
      ],
      startGate: seeded.startGate,
    });

    expect(snap.state).toBe('running');
    expect(snap.startGate).toBeDefined();
    expect(snap.startGate?.capabilityKey).toEqual(record.key);
    expect(snap.startGate?.projectGuardDecisionId).toBe(seeded.guardDecision.id);
    expect(snap.startGate?.projectGuardMode).toBe('auto_allowed');
    expect(snap.startGate?.reservedBudgetId).toBe(seeded.reservedBudgetId);
    expect(snap.startGate?.budgetCanLaunch).toBe(true);

    // Reservation must be consumed (launched) so reuse fails.
    const budget = new BudgetRepository(database.connection);
    const reservation = budget.getReservation(seeded.reservedBudgetId);
    expect(reservation?.status).toBe('launched');

    // Second start with same reservation id must fail closed.
    await expect(
      manager.startRun({
        attemptId: asAttemptId('attempt-gate-ok-reuse'),
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'reuse',
        baselineId,
        requirementVersion: 1,
        startGate: seeded.startGate,
      }),
    ).rejects.toThrow(/budget|prerequisite|denied|reuse|used/i);

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const logText = readFileSync(log.path, 'utf8');
    expect(logText).toContain('worker_start_run');
    expect(logText).toContain(seeded.guardDecision.id);
    expect(logText).toContain(seeded.reservedBudgetId);
    expect(logText).toContain('0.144.1');
  }, 20_000);
});
