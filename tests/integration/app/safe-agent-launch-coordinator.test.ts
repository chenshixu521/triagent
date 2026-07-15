import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, AgentRequest } from '../../../src/agents/agent-adapter.js';
import {
  clearRuntimeCompatibilityForTests,
  registerRuntimeCompatibility,
  requireVerifiedCompatibility,
} from '../../../src/agents/compatibility-matrix.js';
import { deriveProbedCompatibilityRecord } from '../../../src/agents/compatibility-probe-manifests.js';
import { HealthEvidenceRepository } from '../../../src/agents/health/health-evidence-repository.js';
import { LaunchAuthorizationRepository } from '../../../src/agents/launch-authorization-repository.js';
import { BudgetClock } from '../../../src/budget/budget-clock.js';
import { BudgetController } from '../../../src/budget/budget-controller.js';
import { BudgetRepository } from '../../../src/budget/budget-repository.js';
import { createPendingRunAttempt } from '../../../src/domain/attempt.js';
import {
  asAttemptId,
  asBaselineId,
  asTaskId,
} from '../../../src/domain/ids.js';
import { GuardDecisionRepository } from '../../../src/guard/guard-decision-repository.js';
import { ActionRepository } from '../../../src/persistence/action-repository.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import { SafeAgentLaunchCoordinator } from '../../../src/app/safe-agent-launch-coordinator.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';
import { ImplementationWorkspaceRepository } from '../../../src/workspace/implementation-workspace-repository.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-safe-launch-'));
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

function createFixture(): {
  readonly database: ReadWriteDatabase;
  readonly budget: BudgetController;
  readonly projectRoot: string;
  readonly taskId: ReturnType<typeof asTaskId>;
  readonly attemptId: ReturnType<typeof asAttemptId>;
  readonly baselineId: ReturnType<typeof asBaselineId>;
} {
  const root = temporaryDirectory();
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  const opened = openDatabase(join(root, 'triagent.sqlite'));
  openedDatabases.push(opened);
  const database = requireReadWrite(opened);
  const repositories = createPersistenceRepositories(database);
  const taskId = asTaskId('task-safe-coordinator');
  const attemptId = asAttemptId('attempt-safe-coordinator');
  const baselineId = asBaselineId('baseline-safe-coordinator');
  repositories.tasks.createProject({
    projectId: 'project-safe-coordinator',
    rootPath: projectRoot,
  });
  repositories.tasks.create({
    taskId,
    projectId: 'project-safe-coordinator',
    workflowSnapshot: createInitialWorkflow(taskId),
    workflowVersion: 1,
    status: 'draft',
  });
  repositories.attempts.create(
    taskId,
    createPendingRunAttempt({
      attemptId,
      baselineId,
      requirementVersion: 1,
      startedAt: '2026-07-13T01:00:00.000Z',
    }),
  );
  const clock = new FakeClock('2026-07-13T01:00:00.000Z');
  const supervisor = new FakeProcessSupervisor(clock, []);
  const budget = new BudgetController({
    database: database.connection,
    clock: new BudgetClock(clock),
    supervisor,
    taskId,
    limits: {
      totalActiveRuntimeMs: 60_000,
      perAttemptTimeoutMs: 30_000,
      maxExternalCalls: 5,
    },
  });
  return { database, budget, projectRoot, taskId, attemptId, baselineId };
}

function requestFor(
  fixture: ReturnType<typeof createFixture>,
  role: AgentRequest['role'],
): AgentRequest {
  return {
    attemptId: fixture.attemptId,
    baselineId: fixture.baselineId,
    requirementVersion: 1,
    role,
    projectRoot: fixture.projectRoot,
    prompt: 'perform the assigned stage',
  };
}

function adapterFor(
  kind: 'codex' | 'claude' | 'grok',
  version: string,
  order: string[] = [],
): AgentAdapter {
  const key = { cliName: kind, version, platform: process.platform } as const;
  const compatibility = kind === 'grok' && version !== '0.2.93'
    ? deriveProbedCompatibilityRecord(key)
    : requireVerifiedCompatibility(key);
  if (kind === 'grok' && version !== '0.2.93') {
    registerRuntimeCompatibility(compatibility);
  }
  return {
    kind,
    async checkAvailability() {
      order.push('health');
      return { status: 'available', version };
    },
    async discoverCapabilities() {
      order.push('capabilities');
      return compatibility.capabilities;
    },
    async start() {
      throw new Error('not used');
    },
    async resume() {
      throw new Error('not used');
    },
    parseEvent() {
      return null;
    },
  };
}

function ensureBaselineRow(
  database: ReadWriteDatabase,
  fixture: ReturnType<typeof createFixture>,
  attemptId: string = String(fixture.attemptId),
): void {
  const now = '2026-07-13T01:00:00.000Z';
  database.connection.prepare(
    `INSERT OR IGNORE INTO file_baselines(
       id, task_id, attempt_id, status, manifest_json, error_text, created_at, completed_at
     ) VALUES (?, ?, ?, 'complete', ?, NULL, ?, ?)`,
  ).run(
    String(fixture.baselineId),
    String(fixture.taskId),
    attemptId,
    JSON.stringify({ schemaVersion: 1, files: [] }),
    now,
    now,
  );
}

function seedReadyWorkspace(
  database: ReadWriteDatabase,
  fixture: ReturnType<typeof createFixture>,
  options: {
    readonly workspaceRoot: string;
    readonly authorizationId: string;
    readonly workspaceId?: string;
    readonly attemptId?: string;
    readonly sourceManifestHash?: string;
    readonly expiresAt?: string;
    readonly status?: 'preparing' | 'ready' | 'running' | 'abandoned';
  },
): string {
  const sourceManifestHash = options.sourceManifestHash ?? 'a'.repeat(64);
  const attemptId = options.attemptId ?? String(fixture.attemptId);
  const workspaceId = options.workspaceId ?? 'workspace-isolated-1';
  ensureBaselineRow(database, fixture, attemptId);
  const repository = new ImplementationWorkspaceRepository(database.connection);
  repository.create({
    workspaceId,
    taskId: String(fixture.taskId),
    attemptId,
    canonicalProjectRoot: fixture.projectRoot,
    workspaceRoot: options.workspaceRoot,
    sourceBaselineId: String(fixture.baselineId),
    sourceManifestHash,
    authorizationId: options.authorizationId,
    authorizationExpiresAt: options.expiresAt ?? '2026-07-13T02:00:00.000Z',
    nowIso: '2026-07-13T01:00:00.000Z',
  });
  if ((options.status ?? 'ready') === 'ready') {
    repository.transition({
      workspaceId,
      expectedStatus: 'preparing',
      status: 'ready',
      nowIso: '2026-07-13T01:00:01.000Z',
    });
  }
  return sourceManifestHash;
}

afterEach(() => {
  clearRuntimeCompatibilityForTests();
  for (const opened of openedDatabases.splice(0).reverse()) {
    opened.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SafeAgentLaunchCoordinator', () => {
  it.each([
    ['codex', '0.144.4', 'implementer', 'project_write'],
    ['claude', '2.1.209', 'master', 'read_only'],
  ] as const)(
    'passes a verified dynamic %s record into ProjectGuard for %s',
    async (kind, version, role, expectedProfileMode) => {
      const fixture = createFixture();
      const key = { cliName: kind, version, platform: process.platform } as const;
      registerRuntimeCompatibility(deriveProbedCompatibilityRecord(key));
      const adapter = adapterFor(kind, version);
      const coordinator = new SafeAgentLaunchCoordinator({
        database: fixture.database,
        projectRoot: fixture.projectRoot,
        schemaPath: resolve('schemas/agent-result.schema.json'),
        nonGit: false,
        now: () => new Date('2026-07-13T01:00:00.000Z'),
      });

      const preparation = await coordinator.prepareBeforeBudget({
        actionId: `action-dynamic-${kind}`,
        taskId: fixture.taskId,
        adapter,
        request: requestFor(fixture, role),
      });

      const guard = new GuardDecisionRepository(
        fixture.database.connection,
      ).getStored(preparation.guardDecisionId);
      expect(guard).toMatchObject({
        decision: {
          mode: 'auto_allowed',
          scope: { profileMode: expectedProfileMode },
          capabilityEvidence: {
            adapter: { kind, version },
            verified: true,
          },
        },
      });
    },
  );

  it('persists exact capability, auth, ProjectGuard, and budget bindings before issuing a one-time Adapter request', async () => {
    const fixture = createFixture();
    const order: string[] = [];
    const adapter = adapterFor('codex', '0.144.1', order);
    const schemaPath = resolve('schemas/agent-result.schema.json');
    const coordinator = new SafeAgentLaunchCoordinator({
      database: fixture.database,
      projectRoot: fixture.projectRoot,
      schemaPath,
      nonGit: false,
      now: () => new Date('2026-07-13T01:00:00.000Z'),
    });
    const request = requestFor(fixture, 'implementer');

    const preparation = await coordinator.prepareBeforeBudget({
      actionId: 'action-safe-coordinator',
      taskId: fixture.taskId,
      adapter,
      request,
    });

    expect(order).toEqual(['health', 'capabilities']);
    const guard = new GuardDecisionRepository(
      fixture.database.connection,
    ).getStored(preparation.guardDecisionId);
    expect(guard).toMatchObject({
      taskId: fixture.taskId,
      decision: {
        mode: 'auto_allowed',
        attemptId: fixture.attemptId,
        role: 'implementer',
        scope: {
          kind: 'adapter_start',
          profileMode: 'project_write',
        },
      },
    });
    const health = new HealthEvidenceRepository(
      fixture.database.connection,
    ).get(preparation.healthEvidenceId);
    expect(health).toMatchObject({
      kind: 'auth',
      status: 'valid',
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      authStatus: 'authenticated',
      capabilityKey: {
        cliName: 'codex',
        version: '0.144.1',
        platform: process.platform,
      },
    });

    const reservation = fixture.budget.reserveCall({
      attemptId: fixture.attemptId,
      idempotencyKey: `${fixture.taskId}:agent-run:action-safe-coordinator`,
      guardDecisionId: preparation.guardDecisionId,
    });
    const authorized = await coordinator.authorizeAfterBudget({
      actionId: 'action-safe-coordinator',
      taskId: fixture.taskId,
      adapter,
      request,
      preparation,
      reservedBudgetId: reservation.reservationId,
    });
    const extended = authorized as AgentRequest & Record<string, unknown>;

    expect(extended).toMatchObject({
      taskId: fixture.taskId,
      capabilityKey: {
        cliName: 'codex',
        version: '0.144.1',
        platform: process.platform,
      },
      projectGuardDecisionId: preparation.guardDecisionId,
      reservedBudgetId: reservation.reservationId,
      mode: 'project_write',
      nonGit: false,
      schemaPath,
    });
    expect(extended.launchAuthorizationId).toEqual(expect.any(String));
    expect(
      new BudgetRepository(fixture.database.connection).getReservation(
        reservation.reservationId,
      ),
    ).toMatchObject({ status: 'launched' });
    expect(
      new LaunchAuthorizationRepository(fixture.database.connection).get(
        extended.launchAuthorizationId as string,
      ),
    ).toMatchObject({
      status: 'issued',
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      adapterKind: 'codex',
      role: 'implementer',
      mode: 'project_write',
      guardDecisionId: preparation.guardDecisionId,
      budgetReservationId: reservation.reservationId,
      schemaPath,
      nonGit: false,
    });
  });

  it('persists but refuses a non-auto ProjectGuard profile before any budget reservation', async () => {
    const fixture = createFixture();
    const adapter = adapterFor('claude', '2.1.206');
    const coordinator = new SafeAgentLaunchCoordinator({
      database: fixture.database,
      projectRoot: fixture.projectRoot,
      now: () => new Date('2026-07-13T01:00:00.000Z'),
    });

    await expect(
      coordinator.prepareBeforeBudget({
        actionId: 'action-claude-implementer',
        taskId: fixture.taskId,
        adapter,
        request: requestFor(fixture, 'implementer'),
      }),
    ).rejects.toThrow(/patch_mode|confirmation|auto-allowed/i);

    const guardActions = new ActionRepository(fixture.database.connection)
      .listPending()
      .filter((action) => action.type === 'guard_decision');
    expect(guardActions).toHaveLength(1);
    expect(guardActions[0]?.payload).toMatchObject({
      mode: 'patch_mode',
      role: 'implementer',
      userConfirmationRequired: true,
    });
    expect(
      new BudgetRepository(fixture.database.connection).listReservations(
        fixture.taskId,
      ),
    ).toHaveLength(0);
  });

  it('keeps Grok implementer disabled for live_project scope', async () => {
    const fixture = createFixture();
    const adapter = adapterFor('grok', '0.2.101');
    const coordinator = new SafeAgentLaunchCoordinator({
      database: fixture.database,
      projectRoot: fixture.projectRoot,
      now: () => new Date('2026-07-13T01:00:00.000Z'),
    });

    await expect(
      coordinator.prepareBeforeBudget({
        actionId: 'action-grok-live',
        taskId: fixture.taskId,
        adapter,
        request: requestFor(fixture, 'implementer'),
      }),
    ).rejects.toThrow(/disabled|neither direct-write|auto-allowed/i);
  });

  it('grants candidate workspace-write for validated isolated_implementation authorization', async () => {
    const fixture = createFixture();
    const adapter = adapterFor('grok', '0.2.101');
    const workspaceRoot = join(fixture.projectRoot, '..', 'candidate-workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    const authorizationId = 'workspace-auth-isolated-ok';
    const sourceManifestHash = seedReadyWorkspace(fixture.database, fixture, {
      workspaceRoot,
      authorizationId,
    });
    const coordinator = new SafeAgentLaunchCoordinator({
      database: fixture.database,
      projectRoot: fixture.projectRoot,
      schemaPath: resolve('schemas/agent-result.schema.json'),
      now: () => new Date('2026-07-13T01:00:00.000Z'),
    });

    const preparation = await coordinator.prepareBeforeBudget({
      actionId: 'action-grok-isolated',
      taskId: fixture.taskId,
      adapter,
      request: {
        ...requestFor(fixture, 'implementer'),
        executionScope: 'isolated_implementation',
        workspaceAuthorizationId: authorizationId,
        sourceManifestHash,
        executionRoot: workspaceRoot,
      },
    });

    expect(preparation.mode).toBe('workspace_write');
    expect(preparation.executionScope).toBe('isolated_implementation');
    expect(preparation.executionRoot).toBe(resolve(workspaceRoot));
    const guard = new GuardDecisionRepository(fixture.database.connection)
      .getStored(preparation.guardDecisionId);
    expect(guard).toMatchObject({
      decision: {
        mode: 'auto_allowed',
        scope: {
          profileMode: 'workspace_write',
          executionScope: 'isolated_implementation',
        },
      },
    });

    const reservation = fixture.budget.reserveCall({
      attemptId: fixture.attemptId,
      idempotencyKey: `${fixture.taskId}:agent-run:action-grok-isolated`,
      guardDecisionId: preparation.guardDecisionId,
    });
    const authorized = await coordinator.authorizeAfterBudget({
      actionId: 'action-grok-isolated',
      taskId: fixture.taskId,
      adapter,
      request: {
        ...requestFor(fixture, 'implementer'),
        executionScope: 'isolated_implementation',
        workspaceAuthorizationId: authorizationId,
        sourceManifestHash,
        executionRoot: workspaceRoot,
      },
      preparation,
      reservedBudgetId: reservation.reservationId,
    });
    expect(authorized).toMatchObject({
      mode: 'workspace_write',
      executionScope: 'isolated_implementation',
      executionRoot: resolve(workspaceRoot),
      workspaceAuthorizationId: authorizationId,
    });

    // Single-use: second authorize must fail on consumed workspace authorization.
    const reservation2 = fixture.budget.reserveCall({
      attemptId: fixture.attemptId,
      idempotencyKey: `${fixture.taskId}:agent-run:action-grok-isolated-2`,
      guardDecisionId: preparation.guardDecisionId,
    });
    await expect(
      coordinator.authorizeAfterBudget({
        actionId: 'action-grok-isolated-2',
        taskId: fixture.taskId,
        adapter,
        request: {
          ...requestFor(fixture, 'implementer'),
          executionScope: 'isolated_implementation',
          workspaceAuthorizationId: authorizationId,
          sourceManifestHash,
          executionRoot: workspaceRoot,
        },
        preparation,
        reservedBudgetId: reservation2.reservationId,
      }),
    ).rejects.toThrow(/consumed|reused|authorization/i);
  });

  it('rejects cross-task, expired, and original/candidate root confusion for isolated launches', async () => {
    const fixture = createFixture();
    const adapter = adapterFor('grok', '0.2.101');
    const workspaceRoot = join(fixture.projectRoot, '..', 'candidate-workspace-2');
    mkdirSync(workspaceRoot, { recursive: true });
    const authorizationId = 'workspace-auth-isolated-bad';
    const sourceManifestHash = seedReadyWorkspace(fixture.database, fixture, {
      workspaceRoot,
      authorizationId,
    });
    const coordinator = new SafeAgentLaunchCoordinator({
      database: fixture.database,
      projectRoot: fixture.projectRoot,
      now: () => new Date('2026-07-13T01:00:00.000Z'),
    });

    await expect(
      coordinator.prepareBeforeBudget({
        actionId: 'action-root-confusion',
        taskId: fixture.taskId,
        adapter,
        request: {
          ...requestFor(fixture, 'implementer'),
          executionScope: 'isolated_implementation',
          workspaceAuthorizationId: authorizationId,
          sourceManifestHash,
          // Confuses candidate into projectRoot.
          projectRoot: workspaceRoot,
          executionRoot: workspaceRoot,
        },
      }),
    ).rejects.toThrow(/root confusion|does not match the guarded project/i);

    await expect(
      coordinator.prepareBeforeBudget({
        actionId: 'action-same-roots',
        taskId: fixture.taskId,
        adapter,
        request: {
          ...requestFor(fixture, 'implementer'),
          executionScope: 'isolated_implementation',
          workspaceAuthorizationId: authorizationId,
          sourceManifestHash,
          executionRoot: fixture.projectRoot,
        },
      }),
    ).rejects.toThrow(/root confusion/i);

    await expect(
      coordinator.prepareBeforeBudget({
        actionId: 'action-cross-task',
        taskId: fixture.taskId,
        adapter,
        request: {
          ...requestFor(fixture, 'implementer'),
          attemptId: asAttemptId('attempt-other'),
          executionScope: 'isolated_implementation',
          workspaceAuthorizationId: authorizationId,
          sourceManifestHash,
          executionRoot: workspaceRoot,
        },
      }),
    ).rejects.toThrow(/not ready|authorization/i);

    await expect(
      coordinator.prepareBeforeBudget({
        actionId: 'action-wrong-manifest',
        taskId: fixture.taskId,
        adapter,
        request: {
          ...requestFor(fixture, 'implementer'),
          executionScope: 'isolated_implementation',
          workspaceAuthorizationId: authorizationId,
          sourceManifestHash: 'b'.repeat(64),
          executionRoot: workspaceRoot,
        },
      }),
    ).rejects.toThrow(/not ready|authorization/i);

    // Expired authorization.
    const expiredRoot = join(fixture.projectRoot, '..', 'candidate-expired');
    mkdirSync(expiredRoot, { recursive: true });
    const expiredAuth = 'workspace-auth-expired';
    const repositories = createPersistenceRepositories(fixture.database);
    repositories.attempts.create(
      fixture.taskId,
      createPendingRunAttempt({
        attemptId: asAttemptId('attempt-expired'),
        baselineId: fixture.baselineId,
        requirementVersion: 1,
        startedAt: '2026-07-13T01:00:00.000Z',
      }),
    );
    seedReadyWorkspace(fixture.database, fixture, {
      workspaceId: 'workspace-expired',
      attemptId: 'attempt-expired',
      workspaceRoot: expiredRoot,
      authorizationId: expiredAuth,
      sourceManifestHash,
      expiresAt: '2026-07-13T00:30:00.000Z',
    });
    await expect(
      coordinator.prepareBeforeBudget({
        actionId: 'action-expired',
        taskId: fixture.taskId,
        adapter,
        request: {
          ...requestFor(fixture, 'implementer'),
          attemptId: asAttemptId('attempt-expired'),
          executionScope: 'isolated_implementation',
          workspaceAuthorizationId: expiredAuth,
          sourceManifestHash,
          executionRoot: expiredRoot,
        },
      }),
    ).rejects.toThrow(/not ready|authorization|expired/i);
  });
});
