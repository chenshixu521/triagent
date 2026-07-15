import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { asTaskId } from '../../../src/domain/ids.js';
import { TaskOrchestrator } from '../../../src/workflow/task-orchestrator.js';
import {
  SCENARIO_PATHS,
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

describe('TaskOrchestrator rework limit', () => {
  it('allows the initial implementation plus three reworks, then persists issues and awaits the user without another call', async () => {
    const rejected = (round: number) =>
      agentResult(`Master rejection ${String(round)}`, 'rework', {
        status: 'needs_rework',
        verification: {
          passed: false,
          details: `round ${String(round)} still fails acceptance`,
        },
        issues: [{
          severity: 'major',
          message: `unresolved issue ${String(round)}`,
          file: 'src/feature.txt',
          line: round,
        }],
      });
    const plans = [
      successfulProcess('attempt-1', 7001, agentResult('Plan', 'approve_plan')),
      successfulProcess('attempt-2', 7002, agentResult('Initial implementation', 'review')),
      successfulProcess('attempt-3', 7003, agentResult('Review 1', 'master_validation')),
      successfulProcess('attempt-4', 7004, rejected(1)),
      successfulProcess('attempt-5', 7005, agentResult('Rework 1', 'review')),
      successfulProcess('attempt-6', 7006, agentResult('Review 2', 'master_validation')),
      successfulProcess('attempt-7', 7007, rejected(2)),
      successfulProcess('attempt-8', 7008, agentResult('Rework 2', 'review')),
      successfulProcess('attempt-9', 7009, agentResult('Review 3', 'master_validation')),
      successfulProcess('attempt-10', 7010, rejected(3)),
      successfulProcess('attempt-11', 7011, agentResult('Rework 3', 'review')),
      successfulProcess('attempt-12', 7012, agentResult('Review 4', 'master_validation')),
      successfulProcess('attempt-13', 7013, rejected(4)),
    ];
    const fixture = await createWorkflowFixture('rework', plans);
    fixtures.push(fixture);
    const taskId = asTaskId('task-rework');
    const orchestrator = new TaskOrchestrator({
      database: fixture.database,
      taskDefinition: {
        taskId,
        requirementVersion: 1,
        roles: { master: 'codex', implementer: 'claude', reviewer: 'grok' },
      },
      projectId: 'project-rework',
      projectRoot: fixture.repository,
      requirements: 'Implement until master validation passes or the rework limit is reached.',
      tracker: fixture.tracker,
      adapters: fixture.adapters,
      log: fixture.log,
      ownerInstanceId: 'instance-rework',
      requiresPlanApproval: true,
      idFactory: deterministicIds(),
      now: () => new Date(fixture.clock.now()),
    });
    orchestrator.initialize();

    const starting = orchestrator.start();
    await waitForStarts(fixture.supervisor, 1, starting);
    fixture.clock.advanceBy(1);
    await expect(starting).resolves.toMatchObject({ state: 'awaiting_plan_approval' });

    const running = orchestrator.approvePlan();
    let implementationRound = 0;
    for (let expectedStarts = 2; expectedStarts <= 13; expectedStarts += 1) {
      await waitForStarts(fixture.supervisor, expectedStarts, running);
      const starts = fixture.supervisor.calls.filter((call) => call.type === 'start');
      const current = starts[expectedStarts - 1];
      if (
        current?.type === 'start'
        && current.request.args.includes(SCENARIO_PATHS.implementer)
      ) {
        implementationRound += 1;
        const round = implementationRound;
        fixture.clock.schedule(1, () => {
          const source = join(fixture.repository, 'src');
          mkdirSync(source, { recursive: true });
          writeFileSync(
            join(source, 'feature.txt'),
            `implementation round ${String(round)}\n`,
            'utf8',
          );
        });
      }
      fixture.clock.advanceBy(1);
    }
    await expect(running).resolves.toMatchObject({
      state: 'awaiting_user',
      reworkCount: 3,
      awaitingReason: expect.stringMatching(/rework limit/i),
    });

    const starts = fixture.supervisor.calls.filter((call) => call.type === 'start');
    expect(starts).toHaveLength(13);
    expect(
      starts.filter(
        (call) => call.type === 'start'
          && call.request.args.includes(SCENARIO_PATHS.implementer),
      ),
    ).toHaveLength(4);
    expect(
      starts.filter(
        (call) => call.type === 'start'
          && call.request.args.includes(SCENARIO_PATHS.reviewer),
      ),
    ).toHaveLength(4);
    expect(
      starts.filter(
        (call) => call.type === 'start'
          && call.request.args.includes(SCENARIO_PATHS.master),
      ),
    ).toHaveLength(5);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(fixture.supervisor.calls.filter((call) => call.type === 'start')).toHaveLength(13);

    const transitions = fixture.database.connection
      .prepare(
        `SELECT to_state AS toState, event_type AS eventType
         FROM workflow_transitions WHERE task_id = ? ORDER BY workflow_version`,
      )
      .all(taskId) as unknown as Array<{
        readonly toState: string;
        readonly eventType: string;
      }>;
    expect(transitions.map((row) => row.toState)).toEqual([
      'checking_environment',
      'planning',
      'awaiting_plan_approval',
      'implementing',
      'reviewing',
      'master_validation',
      'rework_requested',
      'implementing',
      'reviewing',
      'master_validation',
      'rework_requested',
      'implementing',
      'reviewing',
      'master_validation',
      'rework_requested',
      'implementing',
      'reviewing',
      'master_validation',
      'awaiting_user',
    ]);
    expect(
      transitions.filter((row) => row.eventType === 'REWORK_CONTEXT_PERSISTED'),
    ).toHaveLength(3);

    expect(
      fixture.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM pending_actions
           WHERE task_id = ? AND action_type = 'persist-rework-request' AND status = 'completed'`,
        )
        .get(taskId),
    ).toEqual({ count: 3 });
    expect(
      fixture.database.connection
        .prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE task_id = ?')
        .get(taskId),
    ).toEqual({ count: 13 });

    const lastMasterReview = fixture.database.connection
      .prepare(
        `SELECT payload_json AS payloadJson FROM reviews
         WHERE task_id = ? AND reviewer_role = 'master'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(taskId) as { readonly payloadJson: string };
    expect(JSON.parse(lastMasterReview.payloadJson)).toMatchObject({
      attemptId: 'attempt-13',
      result: {
        issues: [expect.objectContaining({ message: 'unresolved issue 4' })],
      },
      workflowEvent: { type: 'MASTER_REJECTED', attemptId: 'attempt-13' },
    });
  }, 60_000);
});
