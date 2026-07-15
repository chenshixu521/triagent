import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { NonGitBaselineService } from '../../../src/tracking/non-git-baseline-service.js';
import {
  TaskOrchestrator,
  type OrchestratorIdKind,
} from '../../../src/workflow/task-orchestrator.js';
import {
  FakeClock,
  FakeProcessSupervisor,
  type FakeProcessPlan,
} from '../../fakes/fake-process-supervisor.js';

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];
const openedLogs: JsonlLog[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-isolated-grok-wf-'));
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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (failure !== undefined) throw failure;
    const starts = supervisor.calls.filter((call) => call.type === 'start');
    if (starts.length >= expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${String(expected)} fake starts`);
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix = ''): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = prefix.length === 0 ? name : `${prefix}/${name}`;
      try {
        walk(abs, rel);
      } catch {
        out.push(rel.replaceAll('\\', '/'));
      }
    }
  };
  walk(root);
  return out.sort();
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

describe('Isolated Grok implementation workflow routing', () => {
  it('routes Claude plan -> Grok candidate implement -> Codex review -> Claude validate -> promote effects', async () => {
    const root = temporaryDirectory();
    const projectRoot = join(root, 'canonical-project');
    const snapshots = join(root, 'snapshots');
    const logs = join(root, 'logs');
    const workspaces = join(root, 'implementation-workspaces');
    mkdirSync(projectRoot);
    mkdirSync(snapshots);
    mkdirSync(logs);
    mkdirSync(workspaces);
    writeFileSync(join(projectRoot, 'README.md'), '# canonical\n', 'utf8');
    const canonicalBefore = listFilesRecursive(projectRoot);

    const opened = openDatabase(join(root, 'triagent.sqlite'));
    openedDatabases.push(opened);
    const database = requireReadWrite(opened);
    const log = await JsonlLog.open({
      directory: logs,
      fileName: 'isolated-grok.jsonl',
      database: database.connection,
      projectRoot,
    });
    openedLogs.push(log);

    const taskId = asTaskId('task-isolated-grok');
    const taskDefinition: TaskDefinition = {
      taskId,
      requirementVersion: 1,
      roles: {
        master: 'claude',
        implementer: 'grok',
        reviewer: 'codex',
      },
    };

    const clock = new FakeClock('2026-07-15T04:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      successfulProcess(
        'attempt-1',
        7101,
        result('Plan only; no file writes', 'implement'),
      ),
      successfulProcess(
        'attempt-2',
        7102,
        result('Candidate implementation complete', 'review', {
          changedFiles: ['triagent-smoke.txt'],
        }),
      ),
      successfulProcess(
        'attempt-3',
        7103,
        result('Codex approved candidate diff', 'master_validation'),
      ),
      successfulProcess(
        'attempt-4',
        7104,
        result('Claude master validation on candidate', 'complete'),
      ),
    ]);

    const adapters = {
      master: new FakeAdapter({
        kind: 'claude',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\master.json',
        tempBasePath: root,
      }),
      implementer: new FakeAdapter({
        kind: 'grok',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\implementer.json',
        tempBasePath: root,
      }),
      reviewer: new FakeAdapter({
        kind: 'codex',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\reviewer.json',
        tempBasePath: root,
      }),
    };

    const orchestrator = new TaskOrchestrator({
      database,
      taskDefinition,
      projectId: 'project-isolated-grok',
      projectRoot,
      requirements: 'Create triagent-smoke.txt with fixed content in the project root only.',
      tracker: new NonGitBaselineService({
        projectRoot,
        snapshotStore: snapshots,
      }),
      adapters,
      log,
      ownerInstanceId: 'instance-isolated-grok',
      requiresPlanApproval: false,
      implementationWorkspacesDirectory: workspaces,
      idFactory: deterministicIds(),
      now: () => new Date(clock.now()),
    });
    orchestrator.initialize();

    const running = orchestrator.start();
    // Drive four agent stages: plan, implement, review, master.
    for (let stage = 1; stage <= 4; stage += 1) {
      await waitForStarts(supervisor, stage, running);
      clock.advanceBy(1);
    }
    const final = await running;
    expect(final.state).toBe('completed');

    // Canonical tree must be unchanged through the routed stages (promotion
    // effect marks workspace promoted without live PatchApplier in this fake path).
    expect(listFilesRecursive(projectRoot)).toEqual(canonicalBefore);
    expect(readFileSync(join(projectRoot, 'README.md'), 'utf8')).toBe('# canonical\n');

    const completedTypes = database.connection
      .prepare(
        `SELECT action_type AS actionType FROM pending_actions
         WHERE task_id = ? AND status = 'completed'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(taskId) as Array<{ readonly actionType: string }>;
    const types = completedTypes.map((row) => row.actionType);
    expect(types).toEqual(
      expect.arrayContaining([
        'prepare-implementation-workspace',
        'finalize-candidate-change-set',
        'promote-candidate-workspace',
        'agent-run',
        'release-project-lock',
      ]),
    );

    const prepare = database.connection
      .prepare(
        `SELECT result_json AS resultJson FROM pending_actions
         WHERE task_id = ? AND action_type = 'prepare-implementation-workspace'
           AND status = 'completed'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as { readonly resultJson: string };
    const prepareResult = JSON.parse(prepare.resultJson) as {
      readonly workspaceRoot: string;
      readonly authorizationId: string;
      readonly skipped?: boolean;
    };
    expect(prepareResult.skipped).not.toBe(true);
    expect(prepareResult.workspaceRoot).toContain('implementation-workspaces');
    expect(existsSync(prepareResult.workspaceRoot)).toBe(true);
    // Candidate is under app-owned workspaces, not the canonical project.
    expect(prepareResult.workspaceRoot.startsWith(workspaces)).toBe(true);

    const promote = database.connection
      .prepare(
        `SELECT result_json AS resultJson FROM pending_actions
         WHERE task_id = ? AND action_type = 'promote-candidate-workspace'
           AND status = 'completed'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as { readonly resultJson: string };
    expect(JSON.parse(promote.resultJson)).toMatchObject({
      status: 'promoted',
    });

    // Adapter roles must match assignment (no silent substitution).
    expect(adapters.master.kind).toBe('claude');
    expect(adapters.implementer.kind).toBe('grok');
    expect(adapters.reviewer.kind).toBe('codex');
  }, 30_000);

  it('routes Codex rework back to Grok on the same candidate with a fresh authorization', async () => {
    const root = temporaryDirectory();
    const projectRoot = join(root, 'canonical-project');
    const snapshots = join(root, 'snapshots');
    const logs = join(root, 'logs');
    const workspaces = join(root, 'implementation-workspaces');
    mkdirSync(projectRoot);
    mkdirSync(snapshots);
    mkdirSync(logs);
    mkdirSync(workspaces);
    writeFileSync(join(projectRoot, 'README.md'), '# canonical\n', 'utf8');

    const opened = openDatabase(join(root, 'triagent.sqlite'));
    openedDatabases.push(opened);
    const database = requireReadWrite(opened);
    const log = await JsonlLog.open({
      directory: logs,
      fileName: 'isolated-rework.jsonl',
      database: database.connection,
      projectRoot,
    });
    openedLogs.push(log);

    const taskId = asTaskId('task-isolated-rework');
    const clock = new FakeClock('2026-07-15T06:00:00.000Z');
    // plan -> implement -> review(rework) -> implement again -> review(approve) -> master
    const supervisor = new FakeProcessSupervisor(clock, [
      successfulProcess('attempt-1', 8101, result('Plan', 'implement')),
      successfulProcess('attempt-2', 8102, result('First impl', 'review')),
      successfulProcess(
        'attempt-3',
        8103,
        result('Need rework', 'rework', {
          status: 'needs_rework',
          verification: { passed: false, details: 'missing tests' },
          issues: [{ severity: 'major', message: 'Add tests' }],
        }),
      ),
      successfulProcess('attempt-4', 8104, result('Rework impl', 'review')),
      successfulProcess(
        'attempt-5',
        8105,
        result('Approve after rework', 'master_validation'),
      ),
      successfulProcess(
        'attempt-6',
        8106,
        result('Master ok', 'complete'),
      ),
    ]);

    const adapters = {
      master: new FakeAdapter({
        kind: 'claude',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\master.json',
        tempBasePath: root,
      }),
      implementer: new FakeAdapter({
        kind: 'grok',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\implementer.json',
        tempBasePath: root,
      }),
      reviewer: new FakeAdapter({
        kind: 'codex',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\reviewer.json',
        tempBasePath: root,
      }),
    };

    const orchestrator = new TaskOrchestrator({
      database,
      taskDefinition: {
        taskId,
        requirementVersion: 1,
        roles: { master: 'claude', implementer: 'grok', reviewer: 'codex' },
      },
      projectId: 'project-isolated-rework',
      projectRoot,
      requirements: 'Create a smoke file.',
      tracker: new NonGitBaselineService({ projectRoot, snapshotStore: snapshots }),
      adapters,
      log,
      ownerInstanceId: 'instance-rework',
      requiresPlanApproval: false,
      implementationWorkspacesDirectory: workspaces,
      idFactory: deterministicIds(),
      now: () => new Date(clock.now()),
    });
    orchestrator.initialize();

    const running = orchestrator.start();
    for (let stage = 1; stage <= 6; stage += 1) {
      await waitForStarts(supervisor, stage, running);
      clock.advanceBy(1);
    }
    const final = await running;
    expect(final.state).toBe('completed');

    const prepareRows = database.connection
      .prepare(
        `SELECT result_json AS resultJson FROM pending_actions
         WHERE task_id = ? AND action_type = 'prepare-implementation-workspace'
           AND status = 'completed'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(taskId) as Array<{ readonly resultJson: string }>;
    expect(prepareRows.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(prepareRows[0]!.resultJson) as {
      readonly workspaceRoot: string;
      readonly authorizationId: string;
      readonly reused?: boolean;
    };
    const second = JSON.parse(prepareRows[1]!.resultJson) as {
      readonly workspaceRoot: string;
      readonly authorizationId: string;
      readonly reused?: boolean;
    };
    expect(first.reused).not.toBe(true);
    expect(second.reused).toBe(true);
    expect(second.workspaceRoot).toBe(first.workspaceRoot);
    expect(second.authorizationId).not.toBe(first.authorizationId);

    const finalize = database.connection
      .prepare(
        `SELECT result_json AS resultJson FROM pending_actions
         WHERE task_id = ? AND action_type = 'finalize-candidate-change-set'
           AND status = 'completed'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as { readonly resultJson: string };
    expect(JSON.parse(finalize.resultJson)).toMatchObject({
      reviewBundleHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  }, 45_000);

  it('interrupts mid-implement, continues same task, reuses candidate workspace with fresh authorization', async () => {
    const root = temporaryDirectory();
    const projectRoot = join(root, 'canonical-project');
    const snapshots = join(root, 'snapshots');
    const logs = join(root, 'logs');
    const workspaces = join(root, 'implementation-workspaces');
    mkdirSync(projectRoot);
    mkdirSync(snapshots);
    mkdirSync(logs);
    mkdirSync(workspaces);
    writeFileSync(join(projectRoot, 'README.md'), '# canonical\n', 'utf8');

    const opened = openDatabase(join(root, 'triagent.sqlite'));
    openedDatabases.push(opened);
    const database = requireReadWrite(opened);
    const log = await JsonlLog.open({
      directory: logs,
      fileName: 'isolated-interrupt-continue.jsonl',
      database: database.connection,
      projectRoot,
    });
    openedLogs.push(log);

    const taskId = asTaskId('task-isolated-interrupt-continue');
    const clock = new FakeClock('2026-07-15T07:00:00.000Z');
    // plan(attempt-1) -> implement hang(attempt-2) interrupt
    // -> continue implement(attempt-3) -> review(attempt-4) -> master(attempt-5)
    const supervisor = new FakeProcessSupervisor(clock, [
      successfulProcess('attempt-1', 9101, result('Plan', 'implement')),
      {
        pid: 9102,
        timeline: [{ afterMs: 1, event: { type: 'started', pid: 9102 } }],
        gracefulStop: { afterMs: 1, outcome: 'succeeded', exitCode: null },
        forceStop: { afterMs: 1, outcome: 'succeeded', exitCode: 1 },
      },
      successfulProcess('attempt-3', 9103, result('Impl after continue', 'review')),
      successfulProcess('attempt-4', 9104, result('Codex approve', 'master_validation')),
      successfulProcess('attempt-5', 9105, result('Master ok', 'complete')),
    ]);

    const adapters = {
      master: new FakeAdapter({
        kind: 'claude',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\master.json',
        tempBasePath: root,
      }),
      implementer: new FakeAdapter({
        kind: 'grok',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\implementer.json',
        tempBasePath: root,
      }),
      reviewer: new FakeAdapter({
        kind: 'codex',
        supervisor,
        cliPath: 'D:\\fixtures\\fake-cli.mjs',
        scenarioPath: 'D:\\fixtures\\reviewer.json',
        tempBasePath: root,
      }),
    };

    const orchestrator = new TaskOrchestrator({
      database,
      taskDefinition: {
        taskId,
        requirementVersion: 1,
        roles: { master: 'claude', implementer: 'grok', reviewer: 'codex' },
      },
      projectId: 'project-isolated-interrupt-continue',
      projectRoot,
      requirements: 'Create a smoke file in candidate workspace.',
      tracker: new NonGitBaselineService({ projectRoot, snapshotStore: snapshots }),
      adapters,
      log,
      ownerInstanceId: 'instance-interrupt-continue',
      requiresPlanApproval: false,
      implementationWorkspacesDirectory: workspaces,
      idFactory: deterministicIds(),
      now: () => new Date(clock.now()),
      processSupervisor: supervisor,
      cleanupGracePeriodMs: 2,
      advanceCleanupClock: (ms) => clock.advanceBy(ms),
      verifyProcessTreeGone: (attemptId) => {
        const live = supervisor.activeProcessIds(attemptId);
        return live.length === 0
          ? { clean: true }
          : { clean: false, reason: `pids still live: ${live.join(',')}` };
      },
    });
    orchestrator.initialize();

    const running = orchestrator.start();
    // Plan completes.
    await waitForStarts(supervisor, 1, running);
    clock.advanceBy(3);
    // First implement starts and hangs.
    await waitForStarts(supervisor, 2, running);
    clock.advanceBy(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(orchestrator.currentTask().status).toBe('implementing');

    const firstPrepare = database.connection
      .prepare(
        `SELECT result_json AS resultJson FROM pending_actions
         WHERE task_id = ? AND action_type = 'prepare-implementation-workspace'
           AND status = 'completed'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(taskId) as { readonly resultJson: string } | undefined;
    expect(firstPrepare).toBeDefined();
    const firstPrep = JSON.parse(firstPrepare!.resultJson) as {
      readonly workspaceRoot: string;
      readonly authorizationId: string;
      readonly reused?: boolean;
    };
    expect(firstPrep.reused).not.toBe(true);
    expect(existsSync(firstPrep.workspaceRoot)).toBe(true);

    await orchestrator.requestInterrupt();
    expect(orchestrator.currentTask().status).toBe('interrupted_needs_inspection');
    expect(orchestrator.currentTask().workflowSnapshot.resumeTargetState).toBe(
      'implementing',
    );
    expect(orchestrator.currentTask().taskId).toBe(taskId);

    // Continue same task: re-prepare should reuse candidate + rebind auth.
    const continued = orchestrator.continueAfterOperatorHold();
    await waitForStarts(supervisor, 3, continued);
    clock.advanceBy(3);
    await waitForStarts(supervisor, 4, continued);
    clock.advanceBy(3);
    await waitForStarts(supervisor, 5, continued);
    clock.advanceBy(3);

    await expect(continued).resolves.toMatchObject({ state: 'completed' });
    await running.catch(() => undefined);

    const prepareRows = database.connection
      .prepare(
        `SELECT result_json AS resultJson FROM pending_actions
         WHERE task_id = ? AND action_type = 'prepare-implementation-workspace'
           AND status = 'completed'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(taskId) as unknown as Array<{ readonly resultJson: string }>;
    expect(prepareRows.length).toBeGreaterThanOrEqual(2);
    const secondPrep = JSON.parse(prepareRows[1]!.resultJson) as {
      readonly workspaceRoot: string;
      readonly authorizationId: string;
      readonly reused?: boolean;
      readonly attemptId?: string;
    };
    expect(secondPrep.reused).toBe(true);
    expect(secondPrep.workspaceRoot).toBe(firstPrep.workspaceRoot);
    expect(secondPrep.authorizationId).not.toBe(firstPrep.authorizationId);
    expect(secondPrep.attemptId).toBe('attempt-3');

    const workspaceRow = database.connection
      .prepare(
        `SELECT attempt_id AS attemptId, authorization_id AS authorizationId, status
         FROM implementation_workspaces
         WHERE task_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as unknown as {
      readonly attemptId: string;
      readonly authorizationId: string;
      readonly status: string;
    };
    // After promote, status is promoted; attempt was rebound for continue.
    expect(workspaceRow.authorizationId).toBe(secondPrep.authorizationId);
    expect(['promoted', 'ready', 'under_review', 'candidate_ready', 'approved']).toContain(
      workspaceRow.status,
    );
  }, 60_000);

  it('fails environment when the requested Grok implementer adapter is unavailable (no substitution)', async () => {
    const root = temporaryDirectory();
    const projectRoot = join(root, 'project');
    const snapshots = join(root, 'snapshots');
    const logs = join(root, 'logs');
    mkdirSync(projectRoot);
    mkdirSync(snapshots);
    mkdirSync(logs);
    writeFileSync(join(projectRoot, 'README.md'), '# x\n', 'utf8');

    const opened = openDatabase(join(root, 'triagent.sqlite'));
    openedDatabases.push(opened);
    const database = requireReadWrite(opened);
    const log = await JsonlLog.open({
      directory: logs,
      fileName: 'no-sub.jsonl',
      database: database.connection,
      projectRoot,
    });
    openedLogs.push(log);

    const clock = new FakeClock('2026-07-15T05:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const taskId = asTaskId('task-no-sub');
    const unavailableGrok = {
      kind: 'grok' as const,
      async checkAvailability() {
        return { status: 'unavailable' as const, reason: 'not installed' };
      },
      async discoverCapabilities() {
        // Environment check probes all adapters; unavailability is decided by health.
        return {
          fixedSessionId: true,
          resume: true,
          structuredOutput: false,
          streamJson: true,
          realTimeInput: false,
          nativeSandbox: false,
          nativePermissionRules: false,
          budgetLimit: false,
          turnLimit: true,
          timeLimit: false,
          nonGitProjects: true,
          writeModes: [],
        };
      },
      async start() {
        throw new Error('start must not run when implementer is unavailable');
      },
      async resume() {
        throw new Error('resume must not run when implementer is unavailable');
      },
      parseEvent() {
        return null;
      },
    };

    const orchestrator = new TaskOrchestrator({
      database,
      taskDefinition: {
        taskId,
        requirementVersion: 1,
        roles: { master: 'claude', implementer: 'grok', reviewer: 'codex' },
      },
      projectId: 'project-no-sub',
      projectRoot,
      requirements: 'should not run',
      tracker: new NonGitBaselineService({ projectRoot, snapshotStore: snapshots }),
      adapters: {
        master: new FakeAdapter({
          kind: 'claude',
          supervisor,
          cliPath: 'D:\\fixtures\\fake-cli.mjs',
          scenarioPath: 'D:\\fixtures\\master.json',
          tempBasePath: root,
        }),
        implementer: unavailableGrok,
        reviewer: new FakeAdapter({
          kind: 'codex',
          supervisor,
          cliPath: 'D:\\fixtures\\fake-cli.mjs',
          scenarioPath: 'D:\\fixtures\\reviewer.json',
          tempBasePath: root,
        }),
      },
      log,
      ownerInstanceId: 'instance-no-sub',
      requiresPlanApproval: false,
      implementationWorkspacesDirectory: join(root, 'workspaces'),
      idFactory: deterministicIds(),
      now: () => new Date(clock.now()),
    });
    orchestrator.initialize();
    const snapshot = await orchestrator.start();
    expect(snapshot.state).toBe('awaiting_user');
    expect(snapshot.awaitingReason).toMatch(/implementer adapter unavailable/i);
    expect(supervisor.calls.filter((call) => call.type === 'start')).toHaveLength(0);
  }, 15_000);
});
