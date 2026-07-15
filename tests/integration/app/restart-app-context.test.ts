import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentAdapter,
  AgentRequest,
  AgentRunResult,
} from '../../../src/agents/agent-adapter.js';
import { requireVerifiedCompatibility } from '../../../src/agents/compatibility-matrix.js';
import type { ExecutionHandle } from '../../../src/agents/execution-handle.js';
import {
  composeApplication,
  type ApplicationComposition,
  type ComposeFactories,
} from '../../../src/app/app-context.js';
import {
  asAttemptId,
  asBaselineId,
  asTaskId,
} from '../../../src/domain/ids.js';
import type { AgentKind } from '../../../src/domain/task.js';
import { TaskRepository } from '../../../src/persistence/task-repository.js';
import type { ProcessSupervisorPort } from '../../../src/process/process-supervisor-port.js';
import { canonicalizeProjectPath } from '../../../src/project/canonical-path.js';
import { ProjectLockService } from '../../../src/project/project-lock-service.js';
import { GitBaselineService } from '../../../src/tracking/git-baseline-service.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';
import {
  createWorkflowFixture,
  type WorkflowFixture,
} from '../workflow/workflow-test-fixture.js';

const fixtures: WorkflowFixture[] = [];
const compositions: ApplicationComposition[] = [];

afterEach(async () => {
  for (const composition of compositions.splice(0).reverse()) {
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

function seedTrackedFile(repository: string): void {
  const path = join(repository, 'src', 'counter.ts');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'export const counter = 0;\n', 'utf8');
  git(repository, 'add', 'src/counter.ts');
  git(repository, 'commit', '-m', 'seed recovery file');
}

function failingCompatibleAdapter(input: {
  readonly kind: AgentKind;
  readonly version: string;
  readonly requests: AgentRequest[];
}): AgentAdapter {
  const capabilities = requireVerifiedCompatibility({
    cliName: input.kind,
    version: input.version,
    platform: process.platform,
  }).capabilities;
  return {
    kind: input.kind,
    async checkAvailability() {
      return { status: 'available', version: input.version };
    },
    async discoverCapabilities() {
      return capabilities;
    },
    async start(request) {
      input.requests.push(request);
      const result: AgentRunResult = {
        attemptId: request.attemptId,
        status: 'failed',
        exitCode: 1,
        signal: null,
        error: 'intentional fake recovery stop',
        messages: [],
      };
      const handle: ExecutionHandle = {
        attemptId: request.attemptId,
        async *events() {
          yield {
            type: 'process_started' as const,
            attemptId: request.attemptId,
            pid: 43_101,
            occurredAt: '2026-07-13T06:05:00.001Z',
          };
          yield {
            type: 'process_exited' as const,
            attemptId: request.attemptId,
            pid: 43_101,
            exitCode: 1,
            signal: null,
            reason: 'exited' as const,
            occurredAt: '2026-07-13T06:05:00.002Z',
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
      return handle;
    },
    async resume() {
      throw new Error('not used');
    },
    parseEvent() {
      return null;
    },
  };
}

describe('restart recovery through a new AppContext', () => {
  it('uses a new owner, persists inspect/continue, and never duplicates effect execution', async () => {
    const fixture = await createWorkflowFixture('restart-app-context', []);
    fixtures.push(fixture);
    seedTrackedFile(fixture.repository);
    const appRoot = join(fixture.root, 'app-data');
    const ownerA = 'app-owner-before-crash';
    const ownerB = 'app-owner-after-restart';
    const taskId = asTaskId('task-app-restart');
    const attemptId = asAttemptId('attempt-app-before-restart');
    const taskBaselineId = asBaselineId('baseline-app-task');
    const attemptBaselineId = asBaselineId('baseline-app-attempt');
    const startedAt = '2026-07-13T06:00:00.000Z';

    const first = await composeApplication({
      appRootOverride: appRoot,
      ownerInstanceId: ownerA,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(first);
    if (first.database.mode !== 'read-write') {
      throw new Error(first.database.diagnostics.error);
    }
    const tasks = new TaskRepository(first.database.connection);
    tasks.createProject({
      projectId: 'project-app-restart',
      rootPath: fixture.repository,
    });
    tasks.create({
      taskId,
      projectId: 'project-app-restart',
      workflowSnapshot: {
        ...createInitialWorkflow(taskId),
        state: 'interrupted_needs_inspection',
        resumeTargetState: 'implementing',
      },
      workflowVersion: 3,
      status: 'interrupted_needs_inspection',
    });
    first.database.connection
      .prepare(
        `INSERT INTO requirement_versions(task_id, version, requirements, created_at)
         VALUES (?, 1, ?, ?)`,
      )
      .run(
        taskId,
        JSON.stringify({
          requirements: 'recover the counter edit',
          roles: {
            master: 'claude',
            implementer: 'codex',
            reviewer: 'grok',
          },
          planVersion: 1,
          approved: true,
        }),
        startedAt,
      );
    const tracker = new GitBaselineService({
      projectRoot: fixture.repository,
      snapshotStore: first.paths.snapshotsDirectory,
    });
    tracker.captureTaskBaseline({
      taskId,
      baselineId: taskBaselineId,
      createdAt: new Date(startedAt),
    });
    const attemptBaseline = tracker.captureAttemptBaseline({
      taskId,
      baselineId: attemptBaselineId,
      attemptId,
      attemptNumber: 1,
      parentTaskBaselineId: taskBaselineId,
      createdAt: new Date(startedAt),
    });
    first.database.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, role, status, baseline_id, requirement_version,
           started_at, pid, process_started_at
         ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, 13001, ?)`,
      )
      .run(attemptId, taskId, attemptBaselineId, startedAt, startedAt);
    first.database.connection
      .prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
      )
      .run(
        attemptBaselineId,
        taskId,
        attemptId,
        JSON.stringify(attemptBaseline),
        startedAt,
        startedAt,
      );
    const locks = new ProjectLockService(first.database, {
      lockIdFactory: () => 'lock-app-before-restart',
    });
    expect(locks.acquire(
      taskId,
      canonicalizeProjectPath(fixture.repository),
      ownerA,
      new Date(startedAt),
      10 * 60_000,
    ).status).toBe('acquired');
    writeFileSync(
      join(fixture.repository, 'src', 'counter.ts'),
      'export const counter = 1; // edit survived crash\n',
      'utf8',
    );

    // Abrupt TUI/AppContext loss: close only the DB, without lifecycle cleanup.
    first.close();
    compositions.splice(compositions.indexOf(first), 1);

    const recoveryRequests: AgentRequest[] = [];
    const recoveryClock = new FakeClock('2026-07-13T06:05:00.000Z');
    const recoverySupervisor = new FakeProcessSupervisor(recoveryClock, []);
    const factories = {
      inspectRecoveryProcess: async () => ({
        identity: 'matched' as const,
        terminalState: 'exited' as const,
        pid: 13_001,
        processStartedAt: startedAt,
      }),
      createTaskAdapters(input: {
        readonly supervisor: ProcessSupervisorPort;
        readonly projectRoot: string;
      }): Readonly<Record<AgentKind, AgentAdapter>> {
        void input.supervisor;
        void input.projectRoot;
        return {
          codex: failingCompatibleAdapter({
            kind: 'codex',
            version: '0.144.1',
            requests: recoveryRequests,
          }),
          claude: failingCompatibleAdapter({
            kind: 'claude',
            version: '2.1.206',
            requests: recoveryRequests,
          }),
          grok: failingCompatibleAdapter({
            kind: 'grok',
            version: '0.2.93',
            requests: recoveryRequests,
          }),
        };
      },
    } satisfies ComposeFactories;
    const restarted = await composeApplication({
      appRootOverride: appRoot,
      ownerInstanceId: ownerB,
      skipHealthProbes: true,
      skipProcessHost: true,
      supervisor: recoverySupervisor,
      factories,
      now: () => new Date('2026-07-13T06:05:00.000Z'),
    });
    compositions.push(restarted);
    expect(restarted.ownerInstanceId).toBe(ownerB);
    expect(restarted.snapshot()).toMatchObject({
      screen: 'recovery',
      taskId,
      workflowState: 'interrupted_needs_inspection',
    });

    const inspected = await restarted.dispatch({
      type: 'RECOVERY_INSPECT',
      taskId,
    });
    expect(inspected).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        screen: 'recovery',
        workflowState: 'awaiting_user',
      },
    });

    const continued = await restarted.dispatch({
      type: 'RECOVERY_CONTINUE',
      taskId,
    });
    const continueDiagnostic = restarted.database.mode === 'read-write'
      ? {
          continued,
          task: restarted.database.connection
            .prepare(
              `SELECT status, workflow_version AS workflowVersion,
                      workflow_snapshot AS workflowSnapshot
               FROM tasks WHERE id = ?`,
            )
            .get(taskId),
          actions: restarted.database.connection
            .prepare(
              `SELECT action_type AS actionType, status, error_text AS errorText
               FROM pending_actions WHERE task_id = ? ORDER BY created_at, id`,
            )
            .all(taskId),
        }
      : { continued };
    expect(continued, JSON.stringify(continueDiagnostic)).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        screen: 'recovery',
        workflowState: 'interrupted_needs_inspection',
      },
    });
    expect(recoveryRequests).toHaveLength(1);
    expect(recoveryRequests[0] as AgentRequest & Record<string, unknown>).toMatchObject({
      role: 'implementer',
      nonGit: false,
      launchAuthorizationId: expect.any(String),
    });
    const recoveryActions = restarted.database.mode === 'read-write'
      ? restarted.database.connection
          .prepare(
            `SELECT action_type AS actionType, status
             FROM pending_actions
             WHERE task_id = ?
               AND action_type IN ('create-attempt-baseline', 'agent-run')`,
          )
          .all(taskId)
      : [];
    expect(recoveryActions).toHaveLength(2);
    expect(recoveryActions).toEqual(expect.arrayContaining([
      { actionType: 'create-attempt-baseline', status: 'completed' },
      { actionType: 'agent-run', status: 'completed' },
    ]));

    const repeated = await restarted.dispatch({
      type: 'RECOVERY_CONTINUE',
      taskId,
    });
    expect(repeated).toMatchObject({ kind: 'snapshot' });
    expect(recoveryRequests).toHaveLength(1);
    expect(
      restarted.database.mode === 'read-write'
        ? restarted.database.connection
            .prepare(
              `SELECT owner_instance_id AS ownerInstanceId
               FROM project_locks WHERE task_id = ? AND released_at IS NULL`,
            )
            .get(taskId)
        : undefined,
    ).toEqual({ ownerInstanceId: ownerB });
  }, 60_000);
});
