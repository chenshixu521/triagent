import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentAdapter,
  AgentRequest,
  AgentRunResult,
} from '../../../src/agents/agent-adapter.js';
import type { ExecutionHandle } from '../../../src/agents/execution-handle.js';
import { BudgetClock } from '../../../src/budget/budget-clock.js';
import { BudgetController } from '../../../src/budget/budget-controller.js';
import { BudgetRepository } from '../../../src/budget/budget-repository.js';
import { createPendingRunAttempt } from '../../../src/domain/attempt.js';
import {
  asAttemptId,
  asBaselineId,
  asTaskId,
} from '../../../src/domain/ids.js';
import { JsonlLog } from '../../../src/logging/jsonl-log.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import {
  CommandRunner,
  type AgentLaunchPreparer,
} from '../../../src/workflow/command-runner.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];
const openedLogs: JsonlLog[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-command-launch-'));
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

async function createFixture(): Promise<{
  readonly database: ReadWriteDatabase;
  readonly log: JsonlLog;
  readonly budget: BudgetController;
  readonly taskId: ReturnType<typeof asTaskId>;
  readonly attemptId: ReturnType<typeof asAttemptId>;
  readonly baselineId: ReturnType<typeof asBaselineId>;
  readonly actionId: string;
}> {
  const root = temporaryDirectory();
  const opened = openDatabase(join(root, 'triagent.sqlite'));
  openedDatabases.push(opened);
  const database = requireReadWrite(opened);
  const repositories = createPersistenceRepositories(database);
  const taskId = asTaskId('task-safe-launch');
  const attemptId = asAttemptId('attempt-safe-launch');
  const baselineId = asBaselineId('baseline-safe-launch');
  const actionId = 'action-safe-launch';

  repositories.tasks.createProject({
    projectId: 'project-safe-launch',
    rootPath: join(root, 'project'),
  });
  repositories.tasks.create({
    taskId,
    projectId: 'project-safe-launch',
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
      startedAt: '2026-07-13T00:00:00.000Z',
    }),
  );
  repositories.actions.recordIntent({
    actionId,
    taskId,
    idempotencyKey: `${taskId}:agent-run:${actionId}`,
    type: 'agent-run',
    payload: { attemptId, baselineId },
  });

  const log = await JsonlLog.open({
    directory: join(root, 'logs'),
    fileName: 'task.jsonl',
    database: database.connection,
  });
  openedLogs.push(log);
  const clock = new FakeClock('2026-07-13T00:00:00.000Z');
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

  return {
    database,
    log,
    budget,
    taskId,
    attemptId,
    baselineId,
    actionId,
  };
}

function completedHandle(
  request: AgentRequest,
  onStart: () => void,
): ExecutionHandle {
  const occurredAt = '2026-07-13T00:00:01.000Z';
  const result: AgentRunResult = {
    attemptId: request.attemptId,
    status: 'succeeded',
    exitCode: 0,
    signal: null,
    output: { status: 'ok' },
    messages: [],
  };
  onStart();
  return {
    attemptId: request.attemptId,
    async *events() {
      yield {
        type: 'process_started' as const,
        attemptId: request.attemptId,
        pid: 42_013,
        occurredAt,
      };
      yield {
        type: 'result' as const,
        attemptId: request.attemptId,
        output: { status: 'ok' },
      };
      yield {
        type: 'process_exited' as const,
        attemptId: request.attemptId,
        pid: 42_013,
        exitCode: 0,
        signal: null,
        reason: 'exited' as const,
        occurredAt: '2026-07-13T00:00:02.000Z',
      };
    },
    async sendMessage() {
      throw new Error('not used');
    },
    async requestStop() {},
    async forceKillTree() {},
    async wait() {
      return result;
    },
  };
}

afterEach(async () => {
  for (const log of openedLogs.splice(0).reverse()) {
    await log.close();
  }
  for (const opened of openedDatabases.splice(0).reverse()) {
    opened.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CommandRunner safe launch preparation', () => {
  it('persists a guard before budget reservation and authorizes the exact reserved request before Adapter start', async () => {
    const fixture = await createFixture();
    const reservations = new BudgetRepository(fixture.database.connection);
    const order: string[] = [];
    const guardDecisionId = 'guard-safe-launch';
    const launchAuthorizationId = 'launch-authorization-safe-launch';

    const launchPreparer: AgentLaunchPreparer = {
      async prepareBeforeBudget(input) {
        order.push('guard');
        expect(input.taskId).toBe(fixture.taskId);
        expect(input.request.attemptId).toBe(fixture.attemptId);
        expect(reservations.listReservations(fixture.taskId)).toHaveLength(0);
        return { guardDecisionId };
      },
      async authorizeAfterBudget(input) {
        order.push('authorization');
        const stored = reservations.getReservation(input.reservedBudgetId);
        expect(stored).toMatchObject({
          taskId: fixture.taskId,
          attemptId: fixture.attemptId,
          guardDecisionId,
          status: 'reserved',
        });
        fixture.budget.markLaunched(input.reservedBudgetId);
        return {
          ...input.request,
          taskId: input.taskId,
          capabilityKey: {
            cliName: 'codex',
            version: '0.144.1',
            platform: process.platform,
          },
          projectGuardDecisionId: guardDecisionId,
          reservedBudgetId: input.reservedBudgetId,
          mode: 'project_write',
          nonGit: false,
          launchAuthorizationId,
        };
      },
    };
    const adapter: AgentAdapter = {
      kind: 'codex',
      async checkAvailability() {
        return { status: 'available', version: '0.144.1' };
      },
      async discoverCapabilities() {
        throw new Error('not used');
      },
      async start(request) {
        const authorized = request as AgentRequest & Record<string, unknown>;
        order.push('adapter');
        expect(authorized.projectGuardDecisionId).toBe(guardDecisionId);
        expect(authorized.reservedBudgetId).toBe(
          reservations.listReservations(fixture.taskId)[0]?.reservationId,
        );
        expect(authorized.launchAuthorizationId).toBe(launchAuthorizationId);
        return completedHandle(request, () => undefined);
      },
      async resume() {
        throw new Error('not used');
      },
      parseEvent() {
        return null;
      },
    };
    const runner = new CommandRunner({
      database: fixture.database,
      log: fixture.log,
      budget: fixture.budget,
      launchPreparer,
    });

    await runner.runPreparedAgent({
      actionId: fixture.actionId,
      taskId: fixture.taskId,
      adapter,
      request: {
        attemptId: fixture.attemptId,
        baselineId: fixture.baselineId,
        requirementVersion: 1,
        role: 'implementer',
        projectRoot: temporaryDirectories[0]!,
        prompt: 'implement safely',
      },
    });

    expect(order).toEqual(['guard', 'authorization', 'adapter']);
    expect(reservations.listReservations(fixture.taskId)[0]).toMatchObject({
      guardDecisionId,
      status: 'launched',
    });
  });

  it('releases the reserved budget and never starts the Adapter when launch authorization fails', async () => {
    const fixture = await createFixture();
    const reservations = new BudgetRepository(fixture.database.connection);
    let adapterStarts = 0;
    const launchPreparer: AgentLaunchPreparer = {
      async prepareBeforeBudget() {
        return { guardDecisionId: 'guard-denied-launch' };
      },
      async authorizeAfterBudget() {
        throw new Error('start gate denied: authenticated');
      },
    };
    const adapter: AgentAdapter = {
      kind: 'codex',
      async checkAvailability() {
        return { status: 'available', version: '0.144.1' };
      },
      async discoverCapabilities() {
        throw new Error('not used');
      },
      async start(request) {
        adapterStarts += 1;
        return completedHandle(request, () => undefined);
      },
      async resume() {
        throw new Error('not used');
      },
      parseEvent() {
        return null;
      },
    };
    const runner = new CommandRunner({
      database: fixture.database,
      log: fixture.log,
      budget: fixture.budget,
      launchPreparer,
    });

    await expect(
      runner.runPreparedAgent({
        actionId: fixture.actionId,
        taskId: fixture.taskId,
        adapter,
        request: {
          attemptId: fixture.attemptId,
          baselineId: fixture.baselineId,
          requirementVersion: 1,
          role: 'implementer',
          projectRoot: temporaryDirectories[0]!,
          prompt: 'do not launch',
        },
      }),
    ).rejects.toThrow(/start gate denied/i);

    expect(adapterStarts).toBe(0);
    expect(reservations.listReservations(fixture.taskId)[0]).toMatchObject({
      guardDecisionId: 'guard-denied-launch',
      status: 'released',
    });
  });
});
