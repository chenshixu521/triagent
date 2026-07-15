import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeAdapter } from '../../../src/agents/fake/fake-adapter.js';
import { JsonlLog } from '../../../src/logging/jsonl-log.js';
import {
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import type { AgentResult } from '../../../src/protocol/result-schema.js';
import { GitBaselineService } from '../../../src/tracking/git-baseline-service.js';
import type { OrchestratorIdKind } from '../../../src/workflow/task-orchestrator.js';
import {
  FakeClock,
  FakeProcessSupervisor,
  type FakeProcessPlan,
} from '../../fakes/fake-process-supervisor.js';

export const SCENARIO_PATHS = {
  master: 'D:\\fixtures\\master.json',
  implementer: 'D:\\fixtures\\implementer.json',
  reviewer: 'D:\\fixtures\\reviewer.json',
} as const;

export interface WorkflowFixture {
  readonly root: string;
  readonly repository: string;
  readonly snapshots: string;
  readonly logs: string;
  readonly opened: OpenedDatabase;
  readonly database: ReadWriteDatabase;
  readonly log: JsonlLog;
  readonly clock: FakeClock;
  readonly supervisor: FakeProcessSupervisor;
  readonly tracker: GitBaselineService;
  readonly adapters: {
    readonly master: FakeAdapter;
    readonly implementer: FakeAdapter;
    readonly reviewer: FakeAdapter;
  };
  cleanup(): Promise<void>;
}

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

export function agentResult(
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

export function successfulProcess(
  attemptId: string,
  pid: number,
  output: AgentResult | string | Record<string, unknown>,
): FakeProcessPlan {
  return {
    pid,
    timeline: [
      { afterMs: 1, event: { type: 'started', pid } },
      {
        afterMs: 1,
        event: {
          type: 'stdout',
          chunk: `${JSON.stringify({ type: 'result', attemptId, output })}\n`,
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

export function deterministicIds(): (kind: OrchestratorIdKind) => string {
  const counters = new Map<OrchestratorIdKind, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}-${String(next)}`;
  };
}

export async function waitForStarts(
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
    if (supervisor.calls.filter((call) => call.type === 'start').length >= expected) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${String(expected)} fake starts`);
}

export async function createWorkflowFixture(
  name: string,
  plans: readonly FakeProcessPlan[],
): Promise<WorkflowFixture> {
  const root = mkdtempSync(join(tmpdir(), `triagent-${name}-`));
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

  const opened = openDatabase(join(root, 'triagent.sqlite'));
  if (opened.mode !== 'read-write') {
    opened.close();
    rmSync(root, { recursive: true, force: true });
    throw new Error(opened.diagnostics.error);
  }
  const log = await JsonlLog.open({
    directory: logs,
    fileName: `${name}.jsonl`,
    database: opened.connection,
    projectRoot: repository,
  });
  const clock = new FakeClock('2026-07-12T04:00:00.000Z');
  const supervisor = new FakeProcessSupervisor(clock, plans);
  const adapterOptions = {
    supervisor,
    cliPath: 'D:\\fixtures\\fake-cli.mjs',
    tempBasePath: root,
  } as const;
  return {
    root,
    repository,
    snapshots,
    logs,
    opened,
    database: opened,
    log,
    clock,
    supervisor,
    tracker: new GitBaselineService({
      projectRoot: repository,
      snapshotStore: snapshots,
    }),
    adapters: {
      master: new FakeAdapter({
        ...adapterOptions,
        kind: 'codex',
        scenarioPath: SCENARIO_PATHS.master,
      }),
      implementer: new FakeAdapter({
        ...adapterOptions,
        kind: 'claude',
        scenarioPath: SCENARIO_PATHS.implementer,
      }),
      reviewer: new FakeAdapter({
        ...adapterOptions,
        kind: 'grok',
        scenarioPath: SCENARIO_PATHS.reviewer,
      }),
    },
    async cleanup(): Promise<void> {
      await log.close();
      opened.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
