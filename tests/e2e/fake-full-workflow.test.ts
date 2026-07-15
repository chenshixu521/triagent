import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  composeApplication,
  type ApplicationComposition,
  type ComposeFactories,
} from '../../src/app/app-context.js';
import {
  RestartRecoveryService,
  type RecoveryEffectIntent,
} from '../../src/app/restart-recovery-service.js';
import type {
  TaskRuntimeInput,
  TaskRuntimePort,
} from '../../src/app/task-session-controller.js';
import {
  asAttemptId,
  asBaselineId,
  asTaskId,
} from '../../src/domain/ids.js';
import { openDatabase } from '../../src/persistence/database.js';
import { TaskRepository } from '../../src/persistence/task-repository.js';
import { canonicalizeProjectPath } from '../../src/project/canonical-path.js';
import { ProjectLockService } from '../../src/project/project-lock-service.js';
import { GitBaselineService } from '../../src/tracking/git-baseline-service.js';
import { InterruptionService } from '../../src/workflow/interruption-service.js';
import { reconcileStartup } from '../../src/workflow/reconciler.js';
import { TaskOrchestrator } from '../../src/workflow/task-orchestrator.js';
import {
  createInitialWorkflow,
} from '../../src/workflow/workflow-engine.js';
import { WorkflowRecoveryJournal } from '../../src/workflow/workflow-journal.js';
import {
  SCENARIO_PATHS,
  agentResult,
  createWorkflowFixture,
  deterministicIds,
  successfulProcess,
  waitForStarts,
  type WorkflowFixture,
} from '../integration/workflow/workflow-test-fixture.js';
import { FakeProcessSupervisor } from '../fakes/fake-process-supervisor.js';

const fixtures: WorkflowFixture[] = [];
const compositions: ApplicationComposition[] = [];

afterEach(async () => {
  for (const composition of compositions.splice(0).reverse()) {
    await composition.lifecycle.shutdown({ reason: 'test_cleanup' }).catch(() => undefined);
    composition.close();
  }
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.cleanup();
  }
});

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function seedTrackedFile(
  repository: string,
  relativePath: string,
  contents: string,
): void {
  const absolutePath = join(repository, relativePath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
  git(repository, 'add', relativePath);
  git(repository, 'commit', '-m', `seed ${relativePath.replaceAll('\\', '/')}`);
}

function verifyJsonlChecksums(path: string): Map<number, string> {
  const checksums = new Map<number, string>();
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  let expectedSequence = 1;
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown> & {
      readonly sequence: number;
      readonly checksum: string;
    };
    const { checksum, ...withoutChecksum } = parsed;
    expect(parsed.sequence).toBe(expectedSequence);
    expect(checksums.has(parsed.sequence)).toBe(false);
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(checksum).toBe(
      createHash('sha256')
        .update(JSON.stringify(withoutChecksum), 'utf8')
        .digest('hex'),
    );
    checksums.set(parsed.sequence, checksum);
    expectedSequence += 1;
  }
  return checksums;
}

describe('packaged acceptance: fake complete workflow', () => {
  it('runs plan, seeded defect, rejection, one rework, independent pass, and master approval with durable evidence', async () => {
    const reviewerDefect = agentResult(
      'Reviewer found the seeded subtraction defect.',
      'master_validation',
      {
        status: 'needs_rework',
        verification: {
          passed: false,
          details: 'calculate(2, 1) returned 1 instead of 3',
        },
        issues: [{
          severity: 'major',
          message: 'calculate subtracts instead of adding',
          file: 'src/calculate.ts',
          line: 2,
        }],
      },
    );
    const masterRejects = agentResult(
      'Master confirmed the reviewer evidence and requested rework.',
      'rework',
      {
        status: 'needs_rework',
        verification: {
          passed: false,
          details: 'seeded acceptance case is still failing',
        },
        issues: [{
          severity: 'major',
          message: 'replace subtraction with addition',
          file: 'src/calculate.ts',
          line: 2,
        }],
      },
    );
    const fixture = await createWorkflowFixture('fake-full-workflow', [
      successfulProcess('attempt-1', 10_001, agentResult('Approved plan', 'approve_plan')),
      successfulProcess('attempt-2', 10_002, agentResult('Seeded implementation', 'review')),
      successfulProcess('attempt-3', 10_003, reviewerDefect),
      successfulProcess('attempt-4', 10_004, masterRejects),
      successfulProcess('attempt-5', 10_005, agentResult('Corrected implementation', 'review')),
      successfulProcess(
        'attempt-6',
        10_006,
        agentResult('Independent review passed', 'master_validation'),
      ),
      successfulProcess('attempt-7', 10_007, agentResult('Master approved', 'complete')),
    ]);
    fixtures.push(fixture);
    seedTrackedFile(
      fixture.repository,
      'src/calculate.ts',
      'export function calculate(): never {\n  throw new Error("not implemented");\n}\n',
    );

    const taskId = asTaskId('task-fake-full-workflow');
    const runtimeInputs: TaskRuntimeInput[] = [];
    let runtimeDisposeCalls = 0;
    const adaptersByKind = {
      codex: fixture.adapters.master,
      claude: fixture.adapters.implementer,
      grok: fixture.adapters.reviewer,
    } as const;
    const factories = {
      createTaskRuntime(input: TaskRuntimeInput): TaskRuntimePort {
        runtimeInputs.push(input);
        const orchestrator = new TaskOrchestrator({
          database: fixture.database,
          taskDefinition: {
            taskId,
            requirementVersion: 1,
            roles: input.roles,
          },
          projectId: 'project-fake-full-workflow',
          projectRoot: input.project.canonicalRoot,
          requirements: input.requirements,
          tracker: fixture.tracker,
          adapters: {
            master: adaptersByKind[input.roles.master],
            implementer: adaptersByKind[input.roles.implementer],
            reviewer: adaptersByKind[input.roles.reviewer],
          },
          log: fixture.log,
          ownerInstanceId: input.ownerInstanceId,
          requiresPlanApproval: input.requiresPlanApproval,
          idFactory: deterministicIds(),
          now: () => new Date(fixture.clock.now()),
        });
        return {
          initialize: () => orchestrator.initialize(),
          currentTask: () => orchestrator.currentTask(),
          start: () => orchestrator.start(),
          approvePlan: () => orchestrator.approvePlan(),
          dispose: async () => {
            runtimeDisposeCalls += 1;
          },
        };
      },
    } satisfies ComposeFactories;
    const composition = await composeApplication({
      appRootOverride: join(fixture.root, 'app'),
      skipHealthProbes: true,
      skipProcessHost: true,
      supervisor: fixture.supervisor,
      ownerInstanceId: 'instance-fake-full-workflow',
      factories,
      now: () => new Date(fixture.clock.now()),
    });
    compositions.push(composition);

    const selected = await composition.dispatch({
      type: 'SELECT_PROJECT',
      projectPath: fixture.repository,
    });
    expect(selected).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        screen: 'new_task',
        projectPath: fixture.repository,
      },
    });

    const created = await composition.dispatch({
      type: 'CREATE_TASK',
      requirements: 'Implement calculate(left, right) so it returns their sum.',
      roles: { master: 'codex', implementer: 'claude', reviewer: 'grok' },
      requiresPlanApproval: true,
    });
    // CREATE_TASK returns immediately on the work-status screen; planning drives in background.
    expect(created).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        screen: 'run',
        loading: true,
      },
    });
    expect(runtimeInputs).toHaveLength(1);
    expect(runtimeInputs[0]).toMatchObject({
      project: { canonicalRoot: fixture.repository },
      roles: { master: 'codex', implementer: 'claude', reviewer: 'grok' },
      requiresPlanApproval: true,
    });

    await waitForStarts(fixture.supervisor, 1);
    fixture.clock.advanceBy(5);
    // Wait for background start() to settle into plan approval.
    {
      const deadline = Date.now() + 15_000;
      let status = 'draft';
      while (Date.now() < deadline) {
        const row = fixture.database.connection
          .prepare(`SELECT status AS status FROM tasks WHERE id = ?`)
          .get(taskId) as { readonly status: string } | undefined;
        status = row?.status ?? 'missing';
        if (status === 'awaiting_plan_approval') break;
        fixture.clock.advanceBy(1);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toBe('awaiting_plan_approval');
    }

    let implementationRound = 0;
    const approved = await composition.dispatch({ type: 'APPROVE' });
    expect(approved).toMatchObject({
      kind: 'snapshot',
      snapshot: { loading: true },
    });
    for (let expectedStarts = 2; expectedStarts <= 7; expectedStarts += 1) {
      await waitForStarts(fixture.supervisor, expectedStarts);
      const starts = fixture.supervisor.calls.filter((call) => call.type === 'start');
      const current = starts[expectedStarts - 1];
      if (
        current?.type === 'start'
        && current.request.args.includes(SCENARIO_PATHS.implementer)
      ) {
        implementationRound += 1;
        const contents = implementationRound === 1
          ? 'export function calculate(left: number, right: number): number {\n  return left - right;\n}\n'
          : 'export function calculate(left: number, right: number): number {\n  return left + right;\n}\n';
        fixture.clock.schedule(1, () => {
          writeFileSync(join(fixture.repository, 'src', 'calculate.ts'), contents, 'utf8');
        });
      }
      fixture.clock.advanceBy(3);
    }

    // Background approve drive settles asynchronously — poll durable task status.
    {
      const deadline = Date.now() + 30_000;
      let status = 'unknown';
      let reworkCount = 0;
      while (Date.now() < deadline) {
        const row = fixture.database.connection
          .prepare(
            `SELECT status AS status, workflow_snapshot AS snapshotJson
             FROM tasks WHERE id = ?`,
          )
          .get(taskId) as
          | { readonly status: string; readonly snapshotJson: string }
          | undefined;
        status = row?.status ?? 'missing';
        if (row?.snapshotJson !== undefined) {
          try {
            const snap = JSON.parse(row.snapshotJson) as { reworkCount?: number };
            reworkCount = snap.reworkCount ?? 0;
          } catch {
            reworkCount = 0;
          }
        }
        if (status === 'completed' && reworkCount === 1) break;
        fixture.clock.advanceBy(1);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toBe('completed');
      expect(reworkCount).toBe(1);
    }

    const transitions = fixture.database.connection
      .prepare(
        `SELECT from_state AS fromState, to_state AS toState, event_type AS eventType
         FROM workflow_transitions WHERE task_id = ? ORDER BY workflow_version`,
      )
      .all(taskId) as unknown as Array<{
        readonly fromState: string;
        readonly toState: string;
        readonly eventType: string;
      }>;
    expect([
      transitions[0]?.fromState,
      ...transitions.map((row) => row.toState),
    ]).toEqual([
      'draft',
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
      'completed',
    ]);
    expect(transitions.map((row) => row.eventType)).toEqual([
      'START',
      'ENVIRONMENT_READY',
      'PLAN_READY',
      'PLAN_APPROVED',
      'IMPLEMENTATION_COMPLETED',
      'REVIEW_COMPLETED',
      'MASTER_REJECTED',
      'REWORK_CONTEXT_PERSISTED',
      'IMPLEMENTATION_COMPLETED',
      'REVIEW_COMPLETED',
      'MASTER_APPROVED',
    ]);

    const starts = fixture.supervisor.calls.filter((call) => call.type === 'start');
    expect(starts).toHaveLength(7);
    expect(starts.filter(
      (call) => call.type === 'start' && call.request.args.includes(SCENARIO_PATHS.master),
    )).toHaveLength(3);
    expect(starts.filter(
      (call) => call.type === 'start' && call.request.args.includes(SCENARIO_PATHS.implementer),
    )).toHaveLength(2);
    expect(starts.filter(
      (call) => call.type === 'start' && call.request.args.includes(SCENARIO_PATHS.reviewer),
    )).toHaveLength(2);

    expect(readFileSync(join(fixture.repository, 'src', 'calculate.ts'), 'utf8'))
      .toContain('return left + right;');
    expect(git(fixture.repository, 'diff', '--', 'src/calculate.ts')).toContain(
      'return left + right;',
    );

    const firstReviewer = fixture.database.connection
      .prepare(
        `SELECT payload_json AS payloadJson FROM reviews
         WHERE task_id = ? AND reviewer_role = 'reviewer'
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(taskId) as { readonly payloadJson: string };
    expect(JSON.parse(firstReviewer.payloadJson)).toMatchObject({
      attemptId: 'attempt-3',
      result: {
        issues: [expect.objectContaining({
          message: 'calculate subtracts instead of adding',
        })],
      },
    });

    expect(
      fixture.database.connection
        .prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE task_id = ?')
        .get(taskId),
    ).toEqual({ count: 7 });
    expect(
      fixture.database.connection
        .prepare(
          `SELECT json_extract(metadata_json, '$.attemptId') AS attemptId,
                  after_hash AS afterHash
           FROM file_changes
           WHERE path = 'src/calculate.ts'
           ORDER BY rowid`,
        )
        .all(),
    ).toEqual([
      {
        attemptId: 'attempt-2',
        afterHash: '83fdab6a48428a920197d05ee2216c9f67647e73dbea4214770f63a9c919b38a',
      },
      {
        attemptId: 'attempt-5',
        afterHash: '19d8919f7bc51093e34a0f88e095115acc7c495fe7cfe8647d1cb210a321528f',
      },
    ]);
    expect(
      fixture.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM pending_actions
           WHERE task_id = ? AND status <> 'completed'`,
        )
        .get(taskId),
    ).toEqual({ count: 0 });
    expect(
      fixture.database.connection
        .prepare(
          'SELECT released_at AS releasedAt FROM project_locks WHERE task_id = ?',
        )
        .get(taskId),
    ).toMatchObject({ releasedAt: expect.any(String) });

    const fileChecksums = verifyJsonlChecksums(fixture.log.path);
    const indexRows = fixture.database.connection
      .prepare(
        `SELECT sequence, checksum FROM log_index
         WHERE task_id = ? ORDER BY sequence`,
      )
      .all(taskId) as unknown as Array<{
        readonly sequence: number;
        readonly checksum: string;
      }>;
    expect(indexRows.length).toBeGreaterThan(0);
    expect(indexRows).toHaveLength(fileChecksums.size);
    expect(indexRows.map((row) => row.sequence)).toEqual([...fileChecksums.keys()]);
    expect(indexRows.every(
      (row) => fileChecksums.get(row.sequence) === row.checksum,
    )).toBe(true);
    expect(fixture.supervisor.activeAttemptIds()).toEqual([]);

    const exit = await composition.dispatch({ type: 'REQUEST_EXIT' });
    expect(exit).toMatchObject({ kind: 'exit_gate', gate: { allowed: true } });
    expect(runtimeDisposeCalls).toBe(1);
  }, 60_000);

  it('cleans a fake process tree, restarts under a new owner, inspects the partial diff, and continues once', async () => {
    const fixture = await createWorkflowFixture('fake-crash-reconcile', [{
      pid: 11_001,
      timeline: [
        { afterMs: 1, event: { type: 'started', pid: 11_001 } },
        {
          afterMs: 1,
          event: {
            type: 'descendant_started',
            pid: 11_002,
            parentPid: 11_001,
          },
        },
      ],
      gracefulStop: {
        afterMs: 50,
        outcome: 'failed',
        error: 'fake agent ignored cooperative stop',
      },
      forceStop: { afterMs: 2, outcome: 'succeeded', exitCode: 1 },
    }]);
    fixtures.push(fixture);
    seedTrackedFile(
      fixture.repository,
      'src/counter.ts',
      'export const counter = 0;\n',
    );

    const taskId = asTaskId('task-fake-crash-reconcile');
    const attemptId = asAttemptId('attempt-crashed-implementation');
    const taskBaselineId = asBaselineId('baseline-crash-task');
    const attemptBaselineId = asBaselineId('baseline-crash-attempt');
    const ownerInstanceId = 'instance-fake-crash-reconcile';
    const restartedOwnerInstanceId = 'instance-fake-crash-reconcile-restarted';
    const tasks = new TaskRepository(fixture.database.connection);
    tasks.createProject({
      projectId: 'project-fake-crash-reconcile',
      rootPath: fixture.repository,
    });
    tasks.create({
      taskId,
      projectId: 'project-fake-crash-reconcile',
      workflowSnapshot: {
        ...createInitialWorkflow(taskId),
        state: 'implementing',
        activeAttemptId: attemptId,
        activeAttemptBaselineId: attemptBaselineId,
        activeAttemptRole: 'implementer',
      },
      workflowVersion: 1,
      status: 'implementing',
    });
    fixture.database.connection
      .prepare(
        `INSERT INTO requirement_versions(task_id, version, requirements, created_at)
         VALUES (?, 1, ?, ?)`,
      )
      .run(
        taskId,
        JSON.stringify({ requirements: 'increment the counter safely' }),
        fixture.clock.now(),
      );

    const taskBaseline = fixture.tracker.captureTaskBaseline({
      taskId,
      baselineId: taskBaselineId,
      createdAt: new Date(fixture.clock.now()),
    });
    const attemptBaseline = fixture.tracker.captureAttemptBaseline({
      taskId,
      baselineId: attemptBaselineId,
      attemptId,
      attemptNumber: 1,
      parentTaskBaselineId: taskBaselineId,
      createdAt: new Date(fixture.clock.now()),
    });
    const started = await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });
    fixture.clock.advanceBy(1);
    expect(fixture.supervisor.activeProcessIds()).toEqual([11_001, 11_002]);
    fixture.database.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, role, status, baseline_id, requirement_version,
           started_at, pid, process_started_at
         ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, ?, ?)`,
      )
      .run(
        attemptId,
        taskId,
        attemptBaselineId,
        started.startedAt,
        started.pid,
        started.startedAt,
      );
    void taskBaseline;
    fixture.database.connection
      .prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
      )
      .run(
        attemptBaseline.baselineId,
        taskId,
        attemptId,
        JSON.stringify(attemptBaseline),
        attemptBaseline.createdAt,
        attemptBaseline.createdAt,
      );
    const lockService = new ProjectLockService(fixture.opened, {
      lockIdFactory: () => 'lock-fake-crash-reconcile',
    });
    expect(lockService.acquire(
      taskId,
      canonicalizeProjectPath(fixture.repository),
      ownerInstanceId,
      new Date(fixture.clock.now()),
      10 * 60_000,
    ).status).toBe('acquired');

    writeFileSync(
      join(fixture.repository, 'src', 'counter.ts'),
      'export const counter = 1; // partial edit before TUI crash\n',
      'utf8',
    );

    const restarted = openDatabase(join(fixture.root, 'triagent.sqlite'));
    if (restarted.mode !== 'read-write') {
      restarted.close();
      throw new Error(restarted.diagnostics.error);
    }
    try {
      const restartJournal = new WorkflowRecoveryJournal({
        database: restarted,
        tracker: new GitBaselineService({
          projectRoot: fixture.repository,
          snapshotStore: fixture.snapshots,
        }),
        ownerInstanceId: restartedOwnerInstanceId,
        observedAt: () => new Date(fixture.clock.now()),
        inspectProcess: async () => ({
          identity: 'matched' as const,
          terminalState: 'running' as const,
          pid: started.pid,
          processStartedAt: started.startedAt,
        }),
        idFactory: deterministicIds(),
      });
      const firstRestartDecision = await reconcileStartup(restartJournal, taskId);
      const repeatedRestartDecision = await reconcileStartup(restartJournal, taskId);
      expect(repeatedRestartDecision).toEqual(firstRestartDecision);
      expect(firstRestartDecision).toMatchObject({
        kind: 'blocked',
        reasonCode: 'project_lock_owner_mismatch',
        automaticExternalExecution: false,
        operatorActions: expect.arrayContaining(['inspect', 'cancel']),
      });
      expect(fixture.supervisor.activeAttemptIds()).toEqual([attemptId]);
      expect(fixture.supervisor.calls.filter(
        (call) => call.type === 'force_stop_tree',
      )).toHaveLength(0);
    } finally {
      restarted.close();
    }

    const crashTreeCleanup = fixture.supervisor.forceStopTree(attemptId);
    fixture.clock.advanceBy(2);
    await crashTreeCleanup;
    expect(fixture.supervisor.activeAttemptIds()).toEqual([]);
    expect(fixture.supervisor.activeProcessIds()).toEqual([]);

    let rescans = 0;
    let ids = 0;
    const restartedSupervisor = new FakeProcessSupervisor(fixture.clock, []);
    const interruption = new InterruptionService({
      database: fixture.database,
      supervisor: restartedSupervisor,
      tracker: fixture.tracker,
      now: () => new Date(fixture.clock.now()),
      gracePeriodMs: 10,
      idFactory: (kind) => {
        ids += 1;
        return `${kind}-crash-${String(ids)}`;
      },
      advanceClock: (milliseconds) => fixture.clock.advanceBy(milliseconds),
      verifyTreeGone: async () => fixture.supervisor.activeProcessIds().length === 0
        ? { clean: true as const }
        : { clean: false as const, reason: 'fake process tree is still active' },
      rescanProject: async () => {
        rescans += 1;
        const changed = git(fixture.repository, 'status', '--porcelain')
          .trim()
          .split(/\r?\n/)
          .filter(Boolean);
        return { ok: true as const, changeCount: changed.length };
      },
    });

    const interrupted = await interruption.interrupt(taskId);
    expect(interrupted).toMatchObject({
      status: 'interrupted_needs_inspection',
      cleanupComplete: true,
      exitAllowed: true,
    });
    expect(fixture.supervisor.activeAttemptIds()).toEqual([]);
    expect(fixture.supervisor.activeProcessIds()).toEqual([]);
    expect(restartedSupervisor.calls.filter(
      (call) => call.type === 'force_stop_tree',
    )).toHaveLength(0);
    expect(rescans).toBe(1);

    const repeatedInterrupt = await interruption.interrupt(taskId);
    expect(repeatedInterrupt).toMatchObject({ alreadyComplete: true });
    expect(fixture.supervisor.calls.filter(
      (call) => call.type === 'force_stop_tree',
    )).toHaveLength(1);
    expect(rescans).toBe(1);

    const postCleanup = openDatabase(join(fixture.root, 'triagent.sqlite'));
    if (postCleanup.mode !== 'read-write') {
      postCleanup.close();
      throw new Error(postCleanup.diagnostics.error);
    }
    try {
      const recoveryJournal = new WorkflowRecoveryJournal({
        database: postCleanup,
        tracker: new GitBaselineService({
          projectRoot: fixture.repository,
          snapshotStore: fixture.snapshots,
        }),
        ownerInstanceId: restartedOwnerInstanceId,
        observedAt: () => new Date(fixture.clock.now()),
        inspectProcess: async () => ({
          identity: 'matched' as const,
          terminalState: 'exited' as const,
          pid: started.pid,
          processStartedAt: started.startedAt,
        }),
        idFactory: deterministicIds(),
      });
      const firstDecision = await reconcileStartup(recoveryJournal, taskId);
      const secondDecision = await reconcileStartup(recoveryJournal, taskId);
      expect(secondDecision).toEqual(firstDecision);
      expect(firstDecision).toMatchObject({
        kind: 'blocked',
        automaticExternalExecution: false,
        operatorActions: expect.arrayContaining(['inspect', 'cancel']),
      });
    } finally {
      postCleanup.close();
    }
    expect(fixture.supervisor.calls.filter(
      (call) => call.type === 'force_stop_tree',
    )).toHaveLength(1);
    expect(rescans).toBe(1);

    const inspectedDiff = git(fixture.repository, 'diff', '--', 'src/counter.ts');
    expect(inspectedDiff).toContain('partial edit before TUI crash');

    const executedRecoveryEffects: RecoveryEffectIntent[][] = [];
    let recoveryIds = 0;
    const recovery = new RestartRecoveryService({
      database: fixture.database,
      tracker: fixture.tracker,
      ownerInstanceId: restartedOwnerInstanceId,
      now: () => new Date(fixture.clock.now()),
      inspectProcess: async () => ({
        identity: 'matched' as const,
        terminalState: 'exited' as const,
        pid: started.pid,
        processStartedAt: started.startedAt,
      }),
      idFactory: (kind) => {
        recoveryIds += 1;
        return `${kind}-fake-restart-${String(recoveryIds)}`;
      },
      executeEffects: async (effects) => {
        executedRecoveryEffects.push([...effects]);
      },
    });
    const inspection = await recovery.inspect(taskId);
    expect(inspection).toMatchObject({
      status: 'applied',
      workflowSnapshot: { state: 'awaiting_user' },
      evidence: { changedFiles: ['src/counter.ts'] },
    });
    expect(await recovery.inspect(taskId)).toMatchObject({
      status: 'already_applied',
    });

    const continued = await recovery.continueAfterInspection(taskId);
    expect(continued).toMatchObject({
      status: 'applied',
      workflowSnapshot: { state: 'implementing' },
      execution: 'started',
    });
    expect(executedRecoveryEffects).toHaveLength(1);
    expect(executedRecoveryEffects[0]?.map((effect) => effect.effect.type)).toEqual([
      'CreateAttemptBaseline',
      'PrepareImplementationWorkspace',
      'StartImplementation',
    ]);
    expect(await recovery.continueAfterInspection(taskId)).toMatchObject({
      status: 'already_applied',
    });
    expect(executedRecoveryEffects).toHaveLength(1);
    expect(
      fixture.database.connection
        .prepare(
          `SELECT owner_instance_id AS ownerInstanceId
           FROM project_locks WHERE task_id = ? AND released_at IS NULL`,
        )
        .get(taskId),
    ).toEqual({ ownerInstanceId: restartedOwnerInstanceId });
  }, 60_000);
});
