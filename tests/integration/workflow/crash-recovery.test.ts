import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BudgetController } from '../../../src/budget/budget-controller.js';
import type { RunAttempt } from '../../../src/domain/attempt.js';
import {
  asAttemptId,
  asBaselineId,
  asTaskId,
} from '../../../src/domain/ids.js';
import {
  type AgentLaunchPreparer,
} from '../../../src/workflow/command-runner.js';
import {
  reconcileStartup,
  type ReconciliationActionEvidence,
  type ReconciliationBaselineEvidence,
  type ReconciliationEvidencePort,
  type ReconciliationLockEvidence,
  type ReconciliationMessageEvidence,
  type ReconciliationProcessEvidence,
  type StartupReconciliationEvidence,
} from '../../../src/workflow/reconciler.js';
import { TaskOrchestrator } from '../../../src/workflow/task-orchestrator.js';
import {
  agentResult,
  createWorkflowFixture,
  deterministicIds,
  successfulProcess,
  waitForStarts,
  type WorkflowFixture,
} from './workflow-test-fixture.js';

const fixtures: WorkflowFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.cleanup();
  }
});

function createPlanningOrchestrator(
  fixture: WorkflowFixture,
  taskIdValue: string,
  options: {
    readonly budget?: BudgetController;
    readonly launchPreparer?: AgentLaunchPreparer;
  } = {},
): TaskOrchestrator {
  const taskId = asTaskId(taskIdValue);
  const orchestrator = new TaskOrchestrator({
    database: fixture.database,
    taskDefinition: {
      taskId,
      requirementVersion: 1,
      roles: { master: 'codex', implementer: 'claude', reviewer: 'grok' },
    },
    projectId: `project-${taskIdValue}`,
    projectRoot: fixture.repository,
    requirements: 'Produce a structured plan and wait for explicit approval.',
    tracker: fixture.tracker,
    adapters: fixture.adapters,
    log: fixture.log,
    ownerInstanceId: `instance-${taskIdValue}`,
    requiresPlanApproval: true,
    idFactory: deterministicIds(),
    now: () => new Date(fixture.clock.now()),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.launchPreparer === undefined
      ? {}
      : { launchPreparer: options.launchPreparer }),
  });
  orchestrator.initialize();
  return orchestrator;
}

describe('project identity reuse', () => {
  it('initializes a second task on the same canonical root with the persisted project ID', async () => {
    const fixture = await createWorkflowFixture('project-identity-reuse', []);
    fixtures.push(fixture);

    const first = createPlanningOrchestrator(fixture, 'project-reuse-first');
    const second = createPlanningOrchestrator(fixture, 'project-reuse-second');

    expect(first.currentTask().projectId).toBe('project-project-reuse-first');
    expect(second.currentTask().projectId).toBe('project-project-reuse-first');
    expect(
      fixture.database.connection
        .prepare('SELECT id, root_path AS rootPath FROM projects')
        .all(),
    ).toEqual([
      {
        id: 'project-project-reuse-first',
        rootPath: fixture.repository,
      },
    ]);
  });
});

describe('pre-attempt environment failure cleanup', () => {
  it('releases the project lock with the environment-check attempt identity', async () => {
    const fixture = await createWorkflowFixture('environment-failure-release', []);
    fixtures.push(fixture);
    vi.spyOn(fixture.adapters.master, 'checkAvailability').mockResolvedValue({
      status: 'unavailable',
      reason: 'unsupported claude version: 2.1.209',
    });
    const orchestrator = createPlanningOrchestrator(
      fixture,
      'task-environment-failure-release',
    );

    await expect(orchestrator.start()).resolves.toMatchObject({
      state: 'awaiting_user',
      awaitingReason: 'master adapter unavailable: unsupported claude version: 2.1.209',
      allowedAwaitingActions: ['retry_environment', 'cancel'],
    });

    const actions = fixture.database.connection
      .prepare(
        `SELECT action_type AS actionType, status, result_json AS resultJson
         FROM pending_actions WHERE task_id = ? ORDER BY created_at, rowid`,
      )
      .all('task-environment-failure-release') as unknown as readonly {
        readonly actionType: string;
        readonly status: string;
        readonly resultJson: string | null;
      }[];
    const environment = actions.find((action) => action.actionType === 'environment-check');
    const release = actions.find((action) => action.actionType === 'release-project-lock');
    expect(environment?.status).toBe('completed');
    expect(release?.status).toBe('completed');
    expect(JSON.parse(release!.resultJson!)).toMatchObject({
      attemptId: JSON.parse(environment!.resultJson!).attemptId,
    });
    expect(
      fixture.database.connection
        .prepare(
          'SELECT COUNT(*) AS count FROM project_locks WHERE task_id = ? AND released_at IS NULL',
        )
        .get('task-environment-failure-release'),
    ).toEqual({ count: 0 });
  });
});

describe('structured result repair', () => {
  it('routes both the primary stage and its format repair through launch preparation', async () => {
    const fixture = await createWorkflowFixture('repair-launch-gate', [
      successfulProcess('attempt-1', 7991, { status: 'completed' }),
      successfulProcess(
        'attempt-2',
        7992,
        agentResult('Repaired through the launch gate', 'approve_plan'),
      ),
    ]);
    fixtures.push(fixture);
    const calls: Array<{
      readonly phase: 'prepare' | 'authorize';
      readonly attemptId: string;
      readonly prompt: string;
    }> = [];
    const budget = {
      canLaunch: () => true,
      reserveCall: (input: {
        readonly attemptId: ReturnType<typeof asAttemptId>;
        readonly idempotencyKey: string;
      }) => ({
        reservationId: `reservation-${input.attemptId}`,
        attemptId: input.attemptId,
        status: 'reserved' as const,
        idempotencyKey: input.idempotencyKey,
      }),
      releaseReservation: () => undefined,
      markLaunched: () => undefined,
      beginActiveInterval: () => undefined,
      armAttemptWatch: () => undefined,
      endActiveInterval: () => undefined,
      recordProcessCrash: () => undefined,
    } as unknown as BudgetController;
    const launchPreparer: AgentLaunchPreparer = {
      async prepareBeforeBudget(input) {
        calls.push({
          phase: 'prepare',
          attemptId: input.request.attemptId,
          prompt: input.request.prompt,
        });
        return { guardDecisionId: `guard-${input.request.attemptId}` };
      },
      async authorizeAfterBudget(input) {
        calls.push({
          phase: 'authorize',
          attemptId: input.request.attemptId,
          prompt: input.request.prompt,
        });
        return input.request;
      },
    };
    const orchestrator = createPlanningOrchestrator(
      fixture,
      'task-repair-launch-gate',
      { budget, launchPreparer },
    );

    const running = orchestrator.start();
    await waitForStarts(fixture.supervisor, 1, running);
    fixture.clock.advanceBy(1);
    await waitForStarts(fixture.supervisor, 2, running);
    fixture.clock.advanceBy(1);
    await expect(running).resolves.toMatchObject({ state: 'awaiting_plan_approval' });

    expect(calls).toEqual([
      {
        phase: 'prepare',
        attemptId: 'attempt-1',
        prompt: expect.not.stringMatching(/format repair/i),
      },
      {
        phase: 'authorize',
        attemptId: 'attempt-1',
        prompt: expect.not.stringMatching(/format repair/i),
      },
      {
        phase: 'prepare',
        attemptId: 'attempt-2',
        prompt: expect.stringMatching(/format repair/i),
      },
      {
        phase: 'authorize',
        attemptId: 'attempt-2',
        prompt: expect.stringMatching(/format repair/i),
      },
    ]);
  }, 30_000);

  it('uses one distinct format-repair attempt and preserves primary plus repair evidence', async () => {
    const fixture = await createWorkflowFixture('repair-success', [
      successfulProcess('attempt-1', 8001, { status: 'completed' }),
      successfulProcess(
        'attempt-2',
        8002,
        agentResult('Repaired plan result', 'approve_plan'),
      ),
    ]);
    fixtures.push(fixture);
    const orchestrator = createPlanningOrchestrator(fixture, 'task-repair-success');

    const running = orchestrator.start();
    await waitForStarts(fixture.supervisor, 1, running);
    fixture.clock.advanceBy(1);
    await waitForStarts(fixture.supervisor, 2, running);
    fixture.clock.advanceBy(1);
    await expect(running).resolves.toMatchObject({ state: 'awaiting_plan_approval' });

    expect(fixture.supervisor.calls.filter((call) => call.type === 'start')).toHaveLength(2);
    expect(
      fixture.database.connection
        .prepare(
          `SELECT id, status, role, baseline_id AS baselineId
           FROM run_attempts ORDER BY started_at, id`,
        )
        .all(),
    ).toEqual([
      { id: 'attempt-1', status: 'completed', role: 'master', baselineId: 'baseline-1' },
      { id: 'attempt-2', status: 'completed', role: 'master', baselineId: 'baseline-2' },
    ]);

    const repair = fixture.database.connection
      .prepare(
        `SELECT payload_json AS payloadJson, result_json AS resultJson
         FROM pending_actions WHERE action_type = 'format-repair'`,
      )
      .get() as { readonly payloadJson: string; readonly resultJson: string };
    expect(JSON.parse(repair.payloadJson)).toMatchObject({
      attemptId: 'attempt-2',
      originalAttemptId: 'attempt-1',
      message: expect.stringMatching(/format repair/i),
      replayPolicy: 'never-auto-replay',
    });
    expect(JSON.parse(repair.resultJson)).toMatchObject({
      attemptId: 'attempt-2',
      commandRecord: { attemptId: 'attempt-2', pid: 8002 },
      logReferences: expect.arrayContaining([
        expect.objectContaining({ attemptId: 'attempt-2' }),
      ]),
    });

    const stage = fixture.database.connection
      .prepare(
        `SELECT result_json AS resultJson FROM pending_actions
         WHERE action_type = 'stage-result'`,
      )
      .get() as { readonly resultJson: string };
    expect(JSON.parse(stage.resultJson)).toMatchObject({
      attemptId: 'attempt-1',
      parsedResult: { summary: 'Repaired plan result' },
      repairEvidence: {
        attemptId: 'attempt-2',
        originalAttemptId: 'attempt-1',
      },
      derivedEvidence: {
        actionReferences: expect.arrayContaining([
          expect.objectContaining({ attemptId: 'attempt-1' }),
          expect.objectContaining({ attemptId: 'attempt-2' }),
        ]),
      },
    });
  }, 30_000);

  it('persists the second parse failure and awaits the user without a third adapter call', async () => {
    const fixture = await createWorkflowFixture('repair-failure', [
      successfulProcess('attempt-1', 8101, { status: 'completed' }),
      successfulProcess('attempt-2', 8102, { still: 'invalid' }),
    ]);
    fixtures.push(fixture);
    const taskId = asTaskId('task-repair-failure');
    const orchestrator = createPlanningOrchestrator(fixture, taskId);

    const running = orchestrator.start();
    await waitForStarts(fixture.supervisor, 1, running);
    fixture.clock.advanceBy(1);
    await waitForStarts(fixture.supervisor, 2, running);
    fixture.clock.advanceBy(1);
    await expect(running).resolves.toMatchObject({
      state: 'awaiting_user',
      awaitingReason: expect.stringMatching(/schema validation|parse/i),
      resumeTargetState: 'planning',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(fixture.supervisor.calls.filter((call) => call.type === 'start')).toHaveLength(2);

    const transitions = fixture.database.connection
      .prepare(
        `SELECT event_type AS eventType, to_state AS toState
         FROM workflow_transitions WHERE task_id = ? ORDER BY workflow_version`,
      )
      .all(taskId);
    expect(transitions).toEqual([
      { eventType: 'START', toState: 'checking_environment' },
      { eventType: 'ENVIRONMENT_READY', toState: 'planning' },
      { eventType: 'RESULT_PARSE_FAILED', toState: 'awaiting_user' },
    ]);

    const failedStage = fixture.database.connection
      .prepare(
        `SELECT status, error_text AS errorText, result_json AS resultJson
         FROM pending_actions WHERE action_type = 'stage-result'`,
      )
      .get() as {
        readonly status: string;
        readonly errorText: string;
        readonly resultJson: string;
      };
    expect(failedStage.status).toBe('failed');
    expect(failedStage.errorText).toMatch(/second.*parse|schema validation/i);
    expect(JSON.parse(failedStage.resultJson)).toMatchObject({
      attemptId: 'attempt-1',
      repairAttemptId: 'attempt-2',
      firstFailure: expect.any(String),
      secondFailure: expect.any(String),
    });
  }, 30_000);
});

const recoveryTaskId = asTaskId('task-crash-recovery');
const recoveryAttemptId = asAttemptId('attempt-crash-recovery');
const recoveryBaselineId = asBaselineId('baseline-crash-recovery');
const recoveryObservedAt = '2026-07-12T12:00:00.000Z';

class FakeReconciliationEvidencePort implements ReconciliationEvidencePort {
  public readonly reads: string[] = [];

  public constructor(
    private readonly evidence: StartupReconciliationEvidence,
  ) {}

  public async readStartupEvidence(
    taskId: typeof recoveryTaskId,
  ): Promise<StartupReconciliationEvidence> {
    this.reads.push(taskId);
    return this.evidence;
  }
}

function completedRecoveryAttempt(): RunAttempt {
  return {
    status: 'completed',
    attemptId: recoveryAttemptId,
    baselineId: recoveryBaselineId,
    requirementVersion: 1,
    role: 'master',
    pid: 9201,
    processStartedAt: '2026-07-12T11:58:00.000Z',
    startedAt: '2026-07-12T11:57:59.000Z',
    endedAt: '2026-07-12T11:59:00.000Z',
    exitReason: 'completed',
  };
}

function activeRecoveryAttempt(): RunAttempt {
  const completed = completedRecoveryAttempt();
  if (completed.status !== 'completed') throw new Error('invalid test attempt');
  return {
    status: 'active',
    attemptId: completed.attemptId,
    baselineId: completed.baselineId,
    requirementVersion: completed.requirementVersion,
    role: completed.role,
    pid: completed.pid,
    processStartedAt: completed.processStartedAt,
    startedAt: completed.startedAt,
  };
}

function validLock(): ReconciliationLockEvidence {
  return {
    status: 'present',
    ownerInstanceId: 'instance-crash-recovery',
    leaseExpiresAt: '2026-07-12T12:05:00.000Z',
  };
}

function validBaseline(): ReconciliationBaselineEvidence {
  return {
    status: 'complete',
    taskId: recoveryTaskId,
    attemptId: recoveryAttemptId,
    baselineId: recoveryBaselineId,
  };
}

function noProcessCheck(): ReconciliationProcessEvidence {
  return { identity: 'not_applicable', terminalState: 'not_applicable' };
}

function recoveryEvidence(
  overrides: Partial<StartupReconciliationEvidence> = {},
): StartupReconciliationEvidence {
  return {
    taskId: recoveryTaskId,
    ownerInstanceId: 'instance-crash-recovery',
    observedAt: recoveryObservedAt,
    resumeTargetState: 'planning',
    actions: [],
    lastAttempt: completedRecoveryAttempt(),
    process: noProcessCheck(),
    lock: validLock(),
    baseline: validBaseline(),
    messages: [],
    ...overrides,
  };
}

async function reconcileEvidence(
  overrides: Partial<StartupReconciliationEvidence>,
) {
  const port = new FakeReconciliationEvidencePort(recoveryEvidence(overrides));
  const decision = await reconcileStartup(port, recoveryTaskId);
  return { decision, port };
}

function actionIntent(
  replayPolicy: ReconciliationActionEvidence['replayPolicy'],
): ReconciliationActionEvidence {
  return {
    actionId: 'action-agent-run',
    type: 'agent-run',
    idempotencyKey: 'agent-run:attempt-crash-recovery',
    replayPolicy,
    status: 'intent',
    safeToFeedForward: false,
    resultConsumed: false,
  };
}

function messageEvidence(
  state: ReconciliationMessageEvidence['state'],
): ReconciliationMessageEvidence {
  return {
    messageId: `message-${state}`,
    attemptId: recoveryAttemptId,
    state,
  };
}

describe('startup crash reconciliation', () => {
  it.each([
    ['never-auto-replay', 'blocked'],
    ['idempotent', 'retry_idempotent'],
  ] as const)(
    'handles an intent with an unknown external result under %s policy as %s',
    async (replayPolicy, expectedKind) => {
      const process: ReconciliationProcessEvidence = {
        identity: 'matched',
        terminalState: 'exited',
        pid: 9201,
        processStartedAt: '2026-07-12T11:58:00.000Z',
      };

      const { decision, port } = await reconcileEvidence({
        actions: [actionIntent(replayPolicy)],
        lastAttempt: activeRecoveryAttempt(),
        process,
      });

      expect(port.reads).toEqual([recoveryTaskId]);
      expect(decision).toMatchObject({
        kind: expectedKind,
        automaticExternalExecution: false,
      });
      if (replayPolicy === 'never-auto-replay') {
        expect(decision).toMatchObject({
          kind: 'blocked',
          targetState: 'interrupted_needs_inspection',
          reasonCode: 'unknown_non_idempotent_result',
          operatorActions: expect.arrayContaining(['inspect', 'cancel']),
        });
      } else {
        expect(decision).toMatchObject({
          kind: 'retry_idempotent',
          actionId: 'action-agent-run',
          idempotencyMarker: 'agent-run:attempt-crash-recovery',
        });
      }
    },
  );

  it('feeds a durable stage result forward with one deterministic consumption marker', async () => {
    const workflowEvent = {
      type: 'PLAN_READY',
      attemptId: recoveryAttemptId,
      baselineId: recoveryBaselineId,
    };
    const action: ReconciliationActionEvidence = {
      actionId: 'action-stage-result',
      type: 'stage-result',
      idempotencyKey: 'stage-result:attempt-crash-recovery',
      replayPolicy: 'idempotent',
      status: 'completed',
      result: { workflowEvent, derivedEvidence: { logReferences: [] } },
      safeToFeedForward: true,
      resultConsumed: false,
    };
    const evidence = recoveryEvidence({ actions: [action] });
    const port = new FakeReconciliationEvidencePort(evidence);

    const first = await reconcileStartup(port, recoveryTaskId);
    const second = await reconcileStartup(port, recoveryTaskId);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: 'feed_forward',
      actionId: 'action-stage-result',
      workflowEvent,
      idempotencyMarker:
        'reconcile:task-crash-recovery:stage-result:attempt-crash-recovery:consume',
      automaticExternalExecution: false,
    });
  });

  it.each([
    ['missing lock', { lock: { status: 'missing', diagnostic: 'row absent' } }, 'project_lock_missing'],
    ['conflicting lock', { lock: { status: 'conflicting', diagnostic: 'overlapping project' } }, 'project_lock_conflicting'],
    ['foreign lock owner', { lock: { ...validLock(), ownerInstanceId: 'another-instance' } }, 'project_lock_owner_mismatch'],
    ['stale lock', { lock: { ...validLock(), leaseExpiresAt: '2026-07-12T11:59:59.000Z' } }, 'project_lock_stale'],
    ['missing baseline', { baseline: { status: 'missing', diagnostic: 'manifest absent' } }, 'baseline_missing'],
    ['incomplete baseline', { baseline: { status: 'incomplete', diagnostic: 'complete marker absent' } }, 'baseline_incomplete'],
    ['mismatched baseline identity', {
      baseline: { ...validBaseline(), baselineId: asBaselineId('different-baseline') },
    }, 'baseline_identity_mismatch'],
  ] as const)(
    'fails closed for %s',
    async (_label, overrides, reasonCode) => {
      const { decision } = await reconcileEvidence(
        overrides as Partial<StartupReconciliationEvidence>,
      );

      expect(decision).toMatchObject({
        kind: 'blocked',
        targetState: 'awaiting_user',
        reasonCode,
        automaticExternalExecution: false,
        operatorActions: expect.arrayContaining(['inspect', 'cancel']),
      });
    },
  );

  it('prioritizes an expired lease over owner mismatch and offers only cancel before any attempt', async () => {
    const { decision } = await reconcileEvidence({
      lastAttempt: undefined,
      process: noProcessCheck(),
      lock: {
        status: 'present',
        ownerInstanceId: 'instance-before-restart',
        leaseExpiresAt: '2026-07-12T11:59:59.000Z',
      },
      baseline: {
        status: 'missing',
        diagnostic: 'task has no durable run attempt baseline',
      },
    });

    expect(decision).toMatchObject({
      kind: 'blocked',
      reasonCode: 'project_lock_stale',
      operatorActions: ['cancel'],
    });
  });

  it('treats missing lock and baseline as expected for an idle pre-attempt awaiting task', async () => {
    const { decision } = await reconcileEvidence({
      lastAttempt: undefined,
      process: noProcessCheck(),
      lock: { status: 'missing', diagnostic: 'row absent after environment failure' },
      baseline: {
        status: 'missing',
        diagnostic: 'task has no durable run attempt baseline',
      },
    });

    expect(decision).toMatchObject({
      kind: 'noop',
      automaticExternalExecution: false,
    });
  });

  it('blocks an active attempt whose process identity cannot be verified before considering replay', async () => {
    const { decision } = await reconcileEvidence({
      actions: [actionIntent('idempotent')],
      lastAttempt: activeRecoveryAttempt(),
      process: {
        identity: 'unverifiable',
        terminalState: 'unknown',
        diagnostic: 'PID was reused and creation time is unavailable',
      },
    });

    expect(decision).toMatchObject({
      kind: 'blocked',
      targetState: 'interrupted_needs_inspection',
      reasonCode: 'process_identity_unverifiable',
      automaticExternalExecution: false,
      operatorActions: expect.arrayContaining(['inspect', 'cancel']),
    });
  });

  it.each([
    ['queued', 'noop', 'keep_queued'],
    ['delivered', 'blocked', 'do_not_resend'],
    ['acknowledged', 'blocked', 'do_not_resend'],
    ['applied', 'noop', 'already_applied'],
    ['failed', 'blocked', 'do_not_resend'],
  ] as const)(
    'reconciles a %s message as %s without a silent resend',
    async (state, expectedKind, disposition) => {
      const message = messageEvidence(state);
      const { decision } = await reconcileEvidence({ messages: [message] });

      expect(decision).toMatchObject({
        kind: expectedKind,
        automaticExternalExecution: false,
        messageDirectives: [
          {
            messageId: message.messageId,
            disposition,
          },
        ],
      });
      if (state === 'delivered' || state === 'acknowledged' || state === 'failed') {
        expect(decision).toMatchObject({
          targetState: 'awaiting_user',
          reasonCode: 'message_delivery_ambiguous',
        });
      }
    },
  );
});
