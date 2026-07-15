import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FakeAdapter } from '../../../src/agents/fake/fake-adapter.js';
import { asTaskId } from '../../../src/domain/ids.js';
import type { TaskDefinition } from '../../../src/domain/task.js';
import { JsonlLog } from '../../../src/logging/jsonl-log.js';
import {
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import type { AgentResult } from '../../../src/protocol/result-schema.js';
import { GitBaselineService } from '../../../src/tracking/git-baseline-service.js';
import { reconcileStartup } from '../../../src/workflow/reconciler.js';
import {
  TaskOrchestrator,
  type OrchestratorIdKind,
} from '../../../src/workflow/task-orchestrator.js';
import { WorkflowRecoveryJournal } from '../../../src/workflow/workflow-journal.js';
import {
  FakeClock,
  FakeProcessSupervisor,
  type FakeProcessPlan,
} from '../../fakes/fake-process-supervisor.js';

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];
const openedLogs: JsonlLog[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-workflow-'));
  temporaryDirectories.push(directory);
  return directory;
}

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function createProject(): {
  readonly root: string;
  readonly repository: string;
  readonly snapshots: string;
  readonly logs: string;
} {
  const root = temporaryDirectory();
  const repository = join(root, 'project');
  const snapshots = join(root, 'snapshots');
  const logs = join(root, 'logs');
  mkdirSync(repository);
  mkdirSync(snapshots);
  mkdirSync(logs);
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.email', 'triagent@example.invalid');
  git(repository, 'config', 'user.name', 'TriAgent Test');
  git(repository, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repository, 'README.md'), '# fixture\n', 'utf8');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'fixture');
  return { root, repository, snapshots, logs };
}

function requireReadWrite(opened: OpenedDatabase): ReadWriteDatabase {
  expect(opened.mode).toBe('read-write');
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return opened;
}

function result(
  summary: string,
  nextAction: AgentResult['nextAction'],
  overrides: Partial<AgentResult> = {},
): AgentResult {
  return {
    status: 'completed',
    summary,
    changedFiles: [],
    commandsRun: [],
    verification: { passed: true, details: 'fake evidence only' },
    issues: [],
    nextAction,
    ...overrides,
  };
}

function successfulProcess(
  attemptId: string,
  pid: number,
  output: AgentResult,
): FakeProcessPlan {
  return {
    pid,
    timeline: [
      { afterMs: 1, event: { type: 'started', pid } },
      {
        afterMs: 1,
        event: {
          type: 'stdout',
          chunk: `${JSON.stringify({
            type: 'result',
            attemptId,
            output,
          })}\n`,
        },
      },
      {
        afterMs: 1,
        event: {
          type: 'exited',
          pid,
          exitCode: 0,
          signal: null,
          reason: 'exited',
        },
      },
    ],
  };
}

function deterministicIds(): (kind: OrchestratorIdKind) => string {
  const counters = new Map<OrchestratorIdKind, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}-${String(next)}`;
  };
}

async function waitForStarts(
  supervisor: FakeProcessSupervisor,
  expected: number,
  activeRun?: Promise<unknown>,
): Promise<void> {
  let failure: unknown;
  void activeRun?.catch((error: unknown) => {
    failure = error;
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (failure !== undefined) throw failure;
    const starts = supervisor.calls.filter((call) => call.type === 'start');
    if (starts.length >= expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${String(expected)} fake starts`);
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

describe('TaskOrchestrator happy path', () => {
  it('persists the exact approved plan -> implement -> review -> master sequence with derived evidence', async () => {
    const project = createProject();
    const opened = openDatabase(join(project.root, 'triagent.sqlite'));
    openedDatabases.push(opened);
    const database = requireReadWrite(opened);
    const log = await JsonlLog.open({
      directory: project.logs,
      fileName: 'task-happy.jsonl',
      database: database.connection,
      projectRoot: project.repository,
    });
    openedLogs.push(log);
    const taskId = asTaskId('task-happy');
    const taskDefinition: TaskDefinition = {
      taskId,
      requirementVersion: 1,
      roles: {
        master: 'codex',
        implementer: 'claude',
        reviewer: 'grok',
      },
    };
    const clock = new FakeClock('2026-07-12T03:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      successfulProcess(
        'attempt-1',
        6101,
        result('Plan version 1', 'approve_plan'),
      ),
      successfulProcess(
        'attempt-2',
        6102,
        result('Implementation complete', 'review', {
          changedFiles: ['agent-claimed.txt'],
          commandsRun: ['agent-claimed-command --success'],
        }),
      ),
      successfulProcess(
        'attempt-3',
        6103,
        result('Independent review passed', 'master_validation'),
      ),
      successfulProcess(
        'attempt-4',
        6104,
        result('Master accepted derived evidence', 'complete'),
      ),
    ]);
    const adapters = {
      master: new FakeAdapter({
        kind: 'codex',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\master.json',
        tempBasePath: project.root,
      }),
      implementer: new FakeAdapter({
        kind: 'claude',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\implementer.json',
        tempBasePath: project.root,
      }),
      reviewer: new FakeAdapter({
        kind: 'grok',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\reviewer.json',
        tempBasePath: project.root,
      }),
    };
    const orchestrator = new TaskOrchestrator({
      database,
      taskDefinition,
      projectId: 'project-happy',
      projectRoot: project.repository,
      requirements: 'Implement the approved fake feature.',
      tracker: new GitBaselineService({
        projectRoot: project.repository,
        snapshotStore: project.snapshots,
      }),
      adapters,
      log,
      ownerInstanceId: 'instance-happy',
      requiresPlanApproval: true,
      idFactory: deterministicIds(),
      now: () => new Date(clock.now()),
    });
    orchestrator.initialize();

    const starting = orchestrator.start();
    await waitForStarts(supervisor, 1);
    clock.advanceBy(1);
    await expect(starting).resolves.toMatchObject({
      state: 'awaiting_plan_approval',
    });

    const planBeforeApproval = database.connection
      .prepare(
        'SELECT version, requirements FROM requirement_versions WHERE task_id = ?',
      )
      .get(taskId) as { readonly version: number; readonly requirements: string };
    expect(JSON.parse(planBeforeApproval.requirements)).toMatchObject({
      planVersion: 1,
      approved: false,
      planAttemptId: 'attempt-1',
      evidenceReferences: expect.arrayContaining([
        expect.objectContaining({ attemptId: 'attempt-1' }),
      ]),
    });

    clock.schedule(1, () => {
      const sourceDirectory = join(project.repository, 'src');
      mkdirSync(sourceDirectory, { recursive: true });
      writeFileSync(join(sourceDirectory, 'feature.txt'), 'implemented\n', 'utf8');
    });
    const approving = orchestrator.approvePlan();
    for (let expectedStarts = 2; expectedStarts <= 4; expectedStarts += 1) {
      try {
        await waitForStarts(supervisor, expectedStarts, approving);
      } catch (error) {
        const diagnostic = {
          task: database.connection
            .prepare('SELECT status, workflow_version AS workflowVersion FROM tasks WHERE id = ?')
            .get(taskId),
          actions: database.connection
            .prepare(
              `SELECT action_type AS actionType, status, error_text AS errorText
               FROM pending_actions WHERE task_id = ? ORDER BY created_at, id`,
            )
            .all(taskId),
          attempts: database.connection
            .prepare(
              `SELECT id, status, role, exit_reason AS exitReason
               FROM run_attempts WHERE task_id = ? ORDER BY started_at, id`,
            )
            .all(taskId),
          logs: database.connection
            .prepare(
              `SELECT attempt_id AS attemptId, event_type AS eventType, sequence
               FROM log_index WHERE task_id = ? ORDER BY sequence`,
            )
            .all(taskId),
          supervisorCalls: supervisor.calls,
        };
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}`,
          { cause: error },
        );
      }
      clock.advanceBy(1);
    }
    await expect(approving).resolves.toMatchObject({ state: 'completed' });

    const transitionRows = database.connection
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
      transitionRows[0]?.fromState,
      ...transitionRows.map((row) => row.toState),
    ]).toEqual([
      'draft',
      'checking_environment',
      'planning',
      'awaiting_plan_approval',
      'implementing',
      'reviewing',
      'master_validation',
      'completed',
    ]);
    expect(transitionRows.map((row) => row.eventType)).toEqual([
      'START',
      'ENVIRONMENT_READY',
      'PLAN_READY',
      'PLAN_APPROVED',
      'IMPLEMENTATION_COMPLETED',
      'REVIEW_COMPLETED',
      'MASTER_APPROVED',
    ]);
    expect(
      (
        database.connection
          .prepare(
            `SELECT json_extract(events.payload_json, '$.attemptId') AS attemptId
             FROM events
             JOIN pending_actions
               ON pending_actions.id = json_extract(events.payload_json, '$.actionId')
             WHERE events.task_id = ?
               AND events.event_type = 'ACTION_RESULT_CONSUMED'
               AND pending_actions.action_type = 'stage-result'
             ORDER BY events.id`,
          )
          .all(taskId) as unknown as Array<{ readonly attemptId: string }>
      ).map((row) => row.attemptId),
    ).toEqual(['attempt-1', 'attempt-2', 'attempt-3', 'attempt-4']);

    const approvedPlan = database.connection
      .prepare(
        'SELECT version, requirements FROM requirement_versions WHERE task_id = ?',
      )
      .get(taskId) as { readonly version: number; readonly requirements: string };
    expect(JSON.parse(approvedPlan.requirements)).toMatchObject({
      planVersion: 1,
      approved: true,
      planAttemptId: 'attempt-1',
      approval: {
        attemptId: 'attempt-2',
        approvedAt: expect.any(String),
      },
    });

    const implementationEvidence = database.connection
      .prepare(
        `SELECT result_json AS resultJson FROM pending_actions
         WHERE task_id = ? AND action_type = 'stage-result'
           AND json_extract(payload_json, '$.attemptId') = 'attempt-2'`,
      )
      .get(taskId) as { readonly resultJson: string };
    expect(JSON.parse(implementationEvidence.resultJson)).toMatchObject({
      attemptId: 'attempt-2',
      parsedResult: {
        changedFiles: ['agent-claimed.txt'],
        commandsRun: ['agent-claimed-command --success'],
      },
      derivedEvidence: {
        changeSetId: expect.any(String),
        baselineId: 'baseline-2',
        changedFiles: ['src/feature.txt'],
        commandRecords: [
          expect.objectContaining({
            attemptId: 'attempt-2',
            pid: 6102,
            exitCode: 0,
          }),
        ],
        logReferences: expect.arrayContaining([
          expect.objectContaining({
            attemptId: 'attempt-2',
            sequence: expect.any(Number),
            checksum: expect.any(String),
          }),
        ]),
      },
      diagnostics: {
        changedFilesMismatch: true,
        commandsMismatch: true,
      },
    });

    expect(
      database.connection
        .prepare('SELECT released_at AS releasedAt FROM project_locks WHERE task_id = ?')
        .get(taskId),
    ).toMatchObject({ releasedAt: expect.any(String) });
    expect(
      database.connection
        .prepare(
          `SELECT action_type AS actionType FROM pending_actions
           WHERE task_id = ? AND status = 'completed'
             AND json_extract(result_json, '$.attemptId') IS NULL`,
        )
        .all(taskId),
    ).toEqual([]);
  }, 30_000);

  it('leaves a non-idempotent agent intent pending when the process crashes before the external call', async () => {
    const project = createProject();
    const opened = openDatabase(join(project.root, 'triagent.sqlite'));
    openedDatabases.push(opened);
    const database = requireReadWrite(opened);
    const log = await JsonlLog.open({
      directory: project.logs,
      fileName: 'task-intent-crash.jsonl',
      database: database.connection,
      projectRoot: project.repository,
    });
    openedLogs.push(log);
    const taskId = asTaskId('task-intent-crash');
    const clock = new FakeClock('2026-07-12T03:10:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const adapter = (kind: 'codex' | 'claude' | 'grok', scenarioPath: string) =>
      new FakeAdapter({
        kind,
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath,
        tempBasePath: project.root,
      });
    const orchestrator = new TaskOrchestrator({
      database,
      taskDefinition: {
        taskId,
        requirementVersion: 1,
        roles: { master: 'codex', implementer: 'claude', reviewer: 'grok' },
      },
      projectId: 'project-intent-crash',
      projectRoot: project.repository,
      requirements: 'Persist the planning intent before any external call.',
      tracker: new GitBaselineService({
        projectRoot: project.repository,
        snapshotStore: project.snapshots,
      }),
      adapters: {
        master: adapter('codex', 'D:\\fixtures\\master.json'),
        implementer: adapter('claude', 'D:\\fixtures\\implementer.json'),
        reviewer: adapter('grok', 'D:\\fixtures\\reviewer.json'),
      },
      log,
      ownerInstanceId: 'instance-intent-crash',
      idFactory: deterministicIds(),
      now: () => new Date(clock.now()),
      hooks: {
        commandRunner: {
          afterIntentPersisted(action) {
            if (action.type === 'agent-run') {
              throw new Error('simulated crash after intent persistence');
            }
          },
        },
      },
    });
    orchestrator.initialize();

    await expect(orchestrator.start()).rejects.toThrow(
      /simulated crash after intent persistence/i,
    );
    expect(supervisor.calls.filter((call) => call.type === 'start')).toHaveLength(0);
    expect(
      database.connection
        .prepare('SELECT status FROM tasks WHERE id = ?')
        .get(taskId),
    ).toEqual({ status: 'planning' });
    expect(
      database.connection
        .prepare(
          `SELECT status FROM pending_actions
           WHERE task_id = ? AND action_type = 'agent-run'`,
        )
        .get(taskId),
    ).toEqual({ status: 'intent' });
    expect(
      database.connection
        .prepare(
          `SELECT event_type AS eventType FROM workflow_transitions
           WHERE task_id = ? ORDER BY workflow_version`,
        )
        .all(taskId),
    ).toEqual([
      { eventType: 'START' },
      { eventType: 'ENVIRONMENT_READY' },
    ]);
    const journal = new WorkflowRecoveryJournal({
      database,
      tracker: new GitBaselineService({
        projectRoot: project.repository,
        snapshotStore: project.snapshots,
      }),
      ownerInstanceId: 'instance-intent-crash',
      observedAt: () => new Date(clock.now()),
      idFactory: deterministicIds(),
    });
    const evidence = await journal.readStartupEvidence(taskId);
    expect(
      evidence.actions.find((action) => action.type === 'agent-run'),
    ).toMatchObject({
      status: 'intent',
      replayPolicy: 'never-auto-replay',
      safeToFeedForward: false,
      resultConsumed: false,
    });
    await expect(reconcileStartup(journal, taskId)).resolves.toMatchObject({
      kind: 'blocked',
      targetState: 'interrupted_needs_inspection',
      automaticExternalExecution: false,
    });
  }, 30_000);

  it('leaves a completed external result unconsumed when the process crashes before the reducer event', async () => {
    const project = createProject();
    const opened = openDatabase(join(project.root, 'triagent.sqlite'));
    openedDatabases.push(opened);
    const database = requireReadWrite(opened);
    const log = await JsonlLog.open({
      directory: project.logs,
      fileName: 'task-result-crash.jsonl',
      database: database.connection,
      projectRoot: project.repository,
    });
    openedLogs.push(log);
    const taskId = asTaskId('task-result-crash');
    const clock = new FakeClock('2026-07-12T03:20:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      successfulProcess(
        'attempt-1',
        6201,
        result('Persisted plan before reducer crash', 'approve_plan'),
      ),
    ]);
    const adapter = (kind: 'codex' | 'claude' | 'grok', scenarioPath: string) =>
      new FakeAdapter({
        kind,
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath,
        tempBasePath: project.root,
      });
    const orchestrator = new TaskOrchestrator({
      database,
      taskDefinition: {
        taskId,
        requirementVersion: 1,
        roles: { master: 'codex', implementer: 'claude', reviewer: 'grok' },
      },
      projectId: 'project-result-crash',
      projectRoot: project.repository,
      requirements: 'Persist the external result before feeding the reducer.',
      tracker: new GitBaselineService({
        projectRoot: project.repository,
        snapshotStore: project.snapshots,
      }),
      adapters: {
        master: adapter('codex', 'D:\\fixtures\\master.json'),
        implementer: adapter('claude', 'D:\\fixtures\\implementer.json'),
        reviewer: adapter('grok', 'D:\\fixtures\\reviewer.json'),
      },
      log,
      ownerInstanceId: 'instance-result-crash',
      idFactory: deterministicIds(),
      now: () => new Date(clock.now()),
      hooks: {
        commandRunner: {
          afterResultPersisted() {
            throw new Error('simulated crash after external result persistence');
          },
        },
      },
    });
    orchestrator.initialize();

    const running = orchestrator.start();
    await waitForStarts(supervisor, 1, running);
    clock.advanceBy(1);
    await expect(running).rejects.toThrow(
      /simulated crash after external result persistence/i,
    );
    expect(
      database.connection
        .prepare('SELECT status FROM tasks WHERE id = ?')
        .get(taskId),
    ).toEqual({ status: 'planning' });
    expect(
      database.connection
        .prepare(
          `SELECT status, result_json IS NOT NULL AS hasResult
           FROM pending_actions WHERE task_id = ? AND action_type = 'agent-run'`,
        )
        .get(taskId),
    ).toEqual({ status: 'completed', hasResult: 1 });
    expect(
      database.connection
        .prepare(
          `SELECT event_type AS eventType FROM workflow_transitions
           WHERE task_id = ? ORDER BY workflow_version`,
        )
        .all(taskId),
    ).toEqual([
      { eventType: 'START' },
      { eventType: 'ENVIRONMENT_READY' },
    ]);
  }, 30_000);

  it('feeds a durable stage result forward exactly once without starting another adapter', async () => {
    const project = createProject();
    const opened = openDatabase(join(project.root, 'triagent.sqlite'));
    openedDatabases.push(opened);
    const database = requireReadWrite(opened);
    const log = await JsonlLog.open({
      directory: project.logs,
      fileName: 'task-feed-forward.jsonl',
      database: database.connection,
      projectRoot: project.repository,
    });
    openedLogs.push(log);
    const taskId = asTaskId('task-feed-forward');
    const clock = new FakeClock('2026-07-12T03:30:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      successfulProcess(
        'attempt-1',
        6301,
        result('Durable plan ready for recovery', 'approve_plan'),
      ),
    ]);
    const adapter = (kind: 'codex' | 'claude' | 'grok', scenarioPath: string) =>
      new FakeAdapter({
        kind,
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath,
        tempBasePath: project.root,
      });
    const tracker = new GitBaselineService({
      projectRoot: project.repository,
      snapshotStore: project.snapshots,
    });
    const orchestrator = new TaskOrchestrator({
      database,
      taskDefinition: {
        taskId,
        requirementVersion: 1,
        roles: { master: 'codex', implementer: 'claude', reviewer: 'grok' },
      },
      projectId: 'project-feed-forward',
      projectRoot: project.repository,
      requirements: 'Recover a durable plan result exactly once.',
      tracker,
      adapters: {
        master: adapter('codex', 'D:\\fixtures\\master.json'),
        implementer: adapter('claude', 'D:\\fixtures\\implementer.json'),
        reviewer: adapter('grok', 'D:\\fixtures\\reviewer.json'),
      },
      log,
      ownerInstanceId: 'instance-feed-forward',
      idFactory: deterministicIds(),
      now: () => new Date(clock.now()),
      hooks: {
        afterReadyEventPersisted() {
          throw new Error('simulated crash before reducer feed-forward');
        },
      },
    });
    orchestrator.initialize();

    const running = orchestrator.start();
    await waitForStarts(supervisor, 1, running);
    clock.advanceBy(1);
    await expect(running).rejects.toThrow(/crash before reducer feed-forward/i);
    expect(
      database.connection
        .prepare('SELECT status FROM tasks WHERE id = ?')
        .get(taskId),
    ).toEqual({ status: 'planning' });

    const journal = new WorkflowRecoveryJournal({
      database,
      tracker,
      ownerInstanceId: 'instance-feed-forward',
      observedAt: () => new Date(clock.now()),
      idFactory: deterministicIds(),
    });
    const decision = await reconcileStartup(journal, taskId);
    expect(decision).toMatchObject({
      kind: 'feed_forward',
      workflowEvent: { type: 'PLAN_READY', attemptId: 'attempt-1' },
      automaticExternalExecution: false,
    });
    if (decision.kind !== 'feed_forward') {
      throw new Error(`expected feed_forward, received ${decision.kind}`);
    }

    await expect(journal.applyFeedForward(decision)).resolves.toMatchObject({
      status: 'applied',
      workflowSnapshot: { state: 'awaiting_plan_approval' },
    });
    await expect(journal.applyFeedForward(decision)).resolves.toMatchObject({
      status: 'already_applied',
      workflowSnapshot: { state: 'awaiting_plan_approval' },
    });
    expect(supervisor.calls.filter((call) => call.type === 'start')).toHaveLength(1);
    expect(
      database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM workflow_transitions
           WHERE task_id = ? AND event_type = 'PLAN_READY'`,
        )
        .get(taskId),
    ).toEqual({ count: 1 });
    expect(
      database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM events
           WHERE task_id = ? AND event_type = 'ACTION_RESULT_CONSUMED'
             AND json_extract(payload_json, '$.actionId') = ?`,
        )
        .get(taskId, decision.actionId),
    ).toEqual({ count: 1 });
  }, 30_000);
});
