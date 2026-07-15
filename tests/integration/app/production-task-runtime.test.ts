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
import type { AgentKind } from '../../../src/domain/task.js';
import type { ProcessSupervisorPort } from '../../../src/process/process-supervisor-port.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';

const temporaryDirectories: string[] = [];
const compositions: ApplicationComposition[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function createGitProject(): string {
  const root = temporaryDirectory('triagent-production-runtime-project-');
  const repository = join(root, 'project');
  mkdirSync(repository);
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.email', 'triagent@example.invalid');
  git(repository, 'config', 'user.name', 'TriAgent Test');
  git(repository, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repository, 'README.md'), '# production runtime fixture\n', 'utf8');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'fixture');
  return repository;
}

function createDirectoryProject(): string {
  const directory = temporaryDirectory('triagent-production-runtime-directory-');
  writeFileSync(join(directory, 'README.md'), '# non-git runtime fixture\n', 'utf8');
  return directory;
}

function recordingFakeAdapter(input: {
  readonly kind: AgentKind;
  readonly version: string;
  readonly supervisor: ProcessSupervisorPort;
  readonly tempBasePath: string;
  readonly requests: AgentRequest[];
}): AgentAdapter {
  const capabilities = requireVerifiedCompatibility({
    cliName: input.kind,
    version: input.version,
    platform: process.platform,
  }).capabilities;
  void input.supervisor;
  void input.tempBasePath;
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
      const output = {
        status: 'completed',
        summary: 'Production runtime plan',
        changedFiles: [],
        commandsRun: [],
        verification: { passed: true, details: 'fake evidence only' },
        issues: [],
        nextAction: 'approve_plan',
      };
      const result: AgentRunResult = {
        attemptId: request.attemptId,
        status: 'succeeded',
        exitCode: 0,
        signal: null,
        output,
        messages: [],
      };
      const handle: ExecutionHandle = {
        attemptId: request.attemptId,
        async *events() {
          yield {
            type: 'process_started' as const,
            attemptId: request.attemptId,
            pid: 43_001,
            occurredAt: '2026-07-13T03:00:00.001Z',
          };
          yield {
            type: 'result' as const,
            attemptId: request.attemptId,
            output,
          };
          yield {
            type: 'process_exited' as const,
            attemptId: request.attemptId,
            pid: 43_001,
            exitCode: 0,
            signal: null,
            reason: 'exited' as const,
            occurredAt: '2026-07-13T03:00:00.002Z',
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

function createRecordingFactories(input: {
  readonly supervisor: ProcessSupervisorPort;
  readonly requests: AgentRequest[];
}): {
  readonly factories: ComposeFactories;
  readonly calls: () => number;
} {
  let calls = 0;
  const factories = {
    createTaskAdapters(factoryInput: {
      readonly supervisor: ProcessSupervisorPort;
      readonly projectRoot: string;
    }): Readonly<Record<AgentKind, AgentAdapter>> {
      calls += 1;
      return {
        codex: recordingFakeAdapter({
          kind: 'codex',
          version: '0.144.1',
          supervisor: factoryInput.supervisor,
          tempBasePath: factoryInput.projectRoot,
          requests: input.requests,
        }),
        claude: recordingFakeAdapter({
          kind: 'claude',
          version: '2.1.206',
          supervisor: factoryInput.supervisor,
          tempBasePath: factoryInput.projectRoot,
          requests: input.requests,
        }),
        grok: recordingFakeAdapter({
          kind: 'grok',
          version: '0.2.93',
          supervisor: factoryInput.supervisor,
          tempBasePath: factoryInput.projectRoot,
          requests: input.requests,
        }),
      };
    },
  } as unknown as ComposeFactories;
  void input.supervisor;
  return { factories, calls: () => calls };
}

afterEach(async () => {
  for (const composition of compositions.splice(0).reverse()) {
    if (!composition.isDatabaseClosed()) {
      await composition.lifecycle.shutdown({ reason: 'test_cleanup' });
    }
    composition.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('production task runtime wiring', () => {
  it('uses the default AppContext runtime to create and safely start a Git task', async () => {
    const appRoot = temporaryDirectory('triagent-production-runtime-app-');
    const projectRoot = createGitProject();
    const clock = new FakeClock('2026-07-13T03:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const requests: AgentRequest[] = [];
    let adapterFactoryCalls = 0;
    const factories = {
      createTaskAdapters(input: {
        readonly supervisor: ProcessSupervisorPort;
        readonly projectRoot: string;
      }): Readonly<Record<AgentKind, AgentAdapter>> {
        adapterFactoryCalls += 1;
        return {
          codex: recordingFakeAdapter({
            kind: 'codex',
            version: '0.144.1',
            supervisor: input.supervisor,
            tempBasePath: input.projectRoot,
            requests,
          }),
          claude: recordingFakeAdapter({
            kind: 'claude',
            version: '2.1.206',
            supervisor: input.supervisor,
            tempBasePath: input.projectRoot,
            requests,
          }),
          grok: recordingFakeAdapter({
            kind: 'grok',
            version: '0.2.93',
            supervisor: input.supervisor,
            tempBasePath: input.projectRoot,
            requests,
          }),
        };
      },
    } as unknown as ComposeFactories;
    const composition = await composeApplication({
      appRootOverride: appRoot,
      supervisor,
      skipHealthProbes: true,
      factories,
      now: () => new Date(clock.now()),
    });
    compositions.push(composition);

    await expect(
      composition.dispatch({
        type: 'SELECT_PROJECT',
        projectPath: projectRoot,
      }),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { screen: 'new_task' },
    });

    const creating = composition.dispatch({
      type: 'CREATE_TASK',
      requirements: 'Create a safe production plan without real AI.',
      roles: {
        master: 'codex',
        implementer: 'claude',
        reviewer: 'grok',
      },
      requiresPlanApproval: true,
    });
    const created = await creating;

    const diagnostic =
      composition.database.mode === 'read-write'
        ? {
            tasks: composition.database.connection
              .prepare('SELECT id, status, workflow_version AS workflowVersion FROM tasks ORDER BY created_at, id')
              .all(),
            actions: composition.database.connection
              .prepare(
                `SELECT action_type AS actionType, status, error_text AS errorText,
                        payload_json AS payloadJson, result_json AS resultJson
                 FROM pending_actions ORDER BY created_at, id`,
              )
              .all(),
            attempts: composition.database.connection
              .prepare(
                `SELECT id, status, role, exit_reason AS exitReason
                 FROM run_attempts ORDER BY started_at, id`,
              )
              .all(),
            reservations: composition.database.connection
              .prepare(
                `SELECT task_id AS taskId, attempt_id AS attemptId,
                        guard_decision_id AS guardDecisionId, status
                 FROM budget_call_reservations ORDER BY reserved_at, id`,
              )
              .all(),
          }
        : { mode: composition.database.mode };

    expect(created, JSON.stringify(diagnostic)).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        screen: 'plan_approval',
        workflowState: 'awaiting_plan_approval',
        canApprove: true,
      },
    });
    expect(adapterFactoryCalls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0] as AgentRequest & Record<string, unknown>).toMatchObject({
      taskId: expect.any(String),
      capabilityKey: {
        cliName: 'codex',
        version: '0.144.1',
        platform: process.platform,
      },
      projectGuardDecisionId: expect.any(String),
      reservedBudgetId: expect.any(String),
      mode: 'read_only',
      nonGit: false,
      launchAuthorizationId: expect.any(String),
    });
    expect(
      composition.database.mode === 'read-write'
        ? composition.database.connection
            .prepare(
              `SELECT status, guard_decision_id AS guardDecisionId
               FROM budget_call_reservations
               WHERE task_id <> '__composition_budget__'`,
            )
            .get()
        : undefined,
    ).toMatchObject({
      status: 'launched',
      guardDecisionId: expect.any(String),
    });
  }, 30_000);

  it('uses the non-Git baseline runtime for a plain directory task', async () => {
    const appRoot = temporaryDirectory('triagent-production-runtime-non-git-app-');
    const projectRoot = createDirectoryProject();
    const clock = new FakeClock('2026-07-13T03:30:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const requests: AgentRequest[] = [];
    const recording = createRecordingFactories({ supervisor, requests });
    const composition = await composeApplication({
      appRootOverride: appRoot,
      supervisor,
      skipHealthProbes: true,
      factories: recording.factories,
      now: () => new Date(clock.now()),
    });
    compositions.push(composition);

    await expect(
      composition.dispatch({
        type: 'SELECT_PROJECT',
        projectPath: projectRoot,
      }),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: {
        screen: 'new_task',
        statusMessage: 'Project selected (directory)',
      },
    });

    const created = await composition.dispatch({
      type: 'CREATE_TASK',
      requirements: 'Create a safe plan for a plain directory without real AI.',
      roles: {
        master: 'codex',
        implementer: 'claude',
        reviewer: 'grok',
      },
      requiresPlanApproval: true,
    });

    expect(created).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        screen: 'plan_approval',
        workflowState: 'awaiting_plan_approval',
        canApprove: true,
      },
    });
    expect(recording.calls()).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0] as AgentRequest & Record<string, unknown>).toMatchObject({
      mode: 'read_only',
      nonGit: true,
      launchAuthorizationId: expect.any(String),
    });

    const storedManifests = composition.database.mode === 'read-write'
      ? composition.database.connection
          .prepare('SELECT manifest_json AS manifestJson FROM file_baselines ORDER BY created_at, id')
          .all() as unknown as readonly { readonly manifestJson: string }[]
      : [];
    expect(storedManifests.length).toBeGreaterThanOrEqual(2);
    expect(
      storedManifests.every((row) => {
        const manifest = JSON.parse(row.manifestJson) as {
          readonly project?: { readonly kind?: string };
        };
        return manifest.project?.kind === 'directory';
      }),
    ).toBe(true);
  }, 30_000);
});
