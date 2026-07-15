import { afterEach, describe, expect, it } from 'vitest';

import { asTaskId } from '../../../src/domain/ids.js';
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

describe('BeginProcessCleanup effect', () => {
  it('requestInterrupt stops the tree and lands on interrupted_needs_inspection', async () => {
    const fixture = await createWorkflowFixture('process-cleanup-interrupt', [
      {
        pid: 44001,
        timeline: [
          { afterMs: 1, event: { type: 'started', pid: 44001 } },
          // No exit — process stays live until interrupt cleanup.
        ],
        gracefulStop: { afterMs: 1, outcome: 'succeeded', exitCode: null },
        forceStop: { afterMs: 1, outcome: 'succeeded', exitCode: 1 },
      },
    ]);
    fixtures.push(fixture);

    const taskId = asTaskId('task-process-cleanup-1');
    const orchestrator = new TaskOrchestrator({
      database: fixture.database,
      taskDefinition: {
        taskId,
        requirementVersion: 1,
        roles: { master: 'codex', implementer: 'claude', reviewer: 'grok' },
      },
      projectId: 'project-process-cleanup-1',
      projectRoot: fixture.repository,
      requirements: 'Plan a feature while we interrupt mid-run.',
      tracker: fixture.tracker,
      adapters: fixture.adapters,
      log: fixture.log,
      ownerInstanceId: 'instance-process-cleanup-1',
      requiresPlanApproval: true,
      idFactory: deterministicIds(),
      now: () => new Date(fixture.clock.now()),
      processSupervisor: fixture.supervisor,
      cleanupGracePeriodMs: 2,
      advanceCleanupClock: (ms) => fixture.clock.advanceBy(ms),
      verifyProcessTreeGone: (attemptId) => {
        const live = fixture.supervisor.activeProcessIds(attemptId);
        return live.length === 0
          ? { clean: true }
          : { clean: false, reason: `pids still live: ${live.join(',')}` };
      },
    });
    orchestrator.initialize();

    const starting = orchestrator.start();
    await waitForStarts(fixture.supervisor, 1);
    // Start process_started event without completing the agent run.
    fixture.clock.advanceBy(1);

    // Give orchestrator a moment to enter planning with active attempt.
    await new Promise((r) => setTimeout(r, 20));
    expect(orchestrator.currentTask().status).toBe('planning');
    expect(orchestrator.currentTask().workflowSnapshot.activeAttemptId).toBeDefined();

    const interrupted = await orchestrator.requestInterrupt();
    expect(interrupted.state).toBe('interrupted_needs_inspection');
    expect(interrupted.resumeTargetState).toBe('planning');
    expect(fixture.supervisor.activeAttemptIds()).toEqual([]);

    const cleanupActions = fixture.database.connection
      .prepare(
        `SELECT action_type AS actionType, status
         FROM pending_actions
         WHERE task_id = ? AND action_type = 'process-cleanup'`,
      )
      .all(taskId) as unknown as ReadonlyArray<{
      readonly actionType: string;
      readonly status: string;
    }>;
    expect(cleanupActions.length).toBeGreaterThanOrEqual(1);
    expect(cleanupActions.every((row) => row.status === 'completed')).toBe(true);

    // Original start should settle (process killed); do not leave hang.
    await starting.catch(() => undefined);
  }, 20_000);

  it('continues same task after interrupt via continueAfterOperatorHold', async () => {
    // attempt-1 = first planning (interrupted); attempt-2 = re-plan after continue
    const fixture = await createWorkflowFixture('process-cleanup-continue', [
      {
        pid: 44011,
        timeline: [{ afterMs: 1, event: { type: 'started', pid: 44011 } }],
        gracefulStop: { afterMs: 1, outcome: 'succeeded', exitCode: null },
        forceStop: { afterMs: 1, outcome: 'succeeded', exitCode: 1 },
      },
      successfulProcess(
        'attempt-2',
        44012,
        agentResult('Plan ready after continue', 'approve_plan'),
      ),
    ]);
    fixtures.push(fixture);

    const taskId = asTaskId('task-process-cleanup-continue');
    const orchestrator = new TaskOrchestrator({
      database: fixture.database,
      taskDefinition: {
        taskId,
        requirementVersion: 1,
        roles: { master: 'codex', implementer: 'claude', reviewer: 'grok' },
      },
      projectId: 'project-process-cleanup-continue',
      projectRoot: fixture.repository,
      requirements: 'Interrupt then continue same task.',
      tracker: fixture.tracker,
      adapters: fixture.adapters,
      log: fixture.log,
      ownerInstanceId: 'instance-process-cleanup-continue',
      requiresPlanApproval: true,
      idFactory: deterministicIds(),
      now: () => new Date(fixture.clock.now()),
      processSupervisor: fixture.supervisor,
      cleanupGracePeriodMs: 2,
      advanceCleanupClock: (ms) => fixture.clock.advanceBy(ms),
      verifyProcessTreeGone: (attemptId) => {
        const live = fixture.supervisor.activeProcessIds(attemptId);
        return live.length === 0
          ? { clean: true }
          : { clean: false, reason: `pids still live: ${live.join(',')}` };
      },
    });
    orchestrator.initialize();

    const starting = orchestrator.start();
    await waitForStarts(fixture.supervisor, 1);
    fixture.clock.advanceBy(1);
    await new Promise((r) => setTimeout(r, 20));

    await orchestrator.requestInterrupt();
    expect(orchestrator.currentTask().status).toBe('interrupted_needs_inspection');
    expect(orchestrator.currentTask().taskId).toBe(taskId);
    await starting.catch(() => undefined);

    const continued = orchestrator.continueAfterOperatorHold();
    await waitForStarts(fixture.supervisor, 2);
    // Drive second planning process timeline to completion.
    fixture.clock.advanceBy(10);
    await expect(continued).resolves.toMatchObject({
      state: 'awaiting_plan_approval',
    });
    expect(orchestrator.currentTask().taskId).toBe(taskId);
  }, 20_000);
});
