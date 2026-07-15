import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  composeApplication,
  type ApplicationComposition,
  type ComposeFactories,
} from '../../../src/app/app-context.js';
import type {
  TaskRuntimeInput,
  TaskRuntimePort,
} from '../../../src/app/task-session-controller.js';
import { asTaskId } from '../../../src/domain/ids.js';
import type { RoleAssignment } from '../../../src/domain/task.js';
import type { PersistedTask } from '../../../src/persistence/task-repository.js';
import type { WorkflowSnapshot, WorkflowState } from '../../../src/workflow/states.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';

const temporaryDirectories: string[] = [];
const compositions: ApplicationComposition[] = [];

const DEFAULT_ROLES: RoleAssignment = {
  master: 'codex',
  implementer: 'claude',
  reviewer: 'grok',
};

const ROLE_PERMUTATIONS: readonly RoleAssignment[] = [
  { master: 'codex', implementer: 'claude', reviewer: 'grok' },
  { master: 'codex', implementer: 'grok', reviewer: 'claude' },
  { master: 'claude', implementer: 'codex', reviewer: 'grok' },
  { master: 'claude', implementer: 'grok', reviewer: 'codex' },
  { master: 'grok', implementer: 'codex', reviewer: 'claude' },
  { master: 'grok', implementer: 'claude', reviewer: 'codex' },
] as const;

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createFakeRuntime() {
  const taskId = asTaskId('task-command-flow');
  let task = persistedTask(taskId, 'draft', 1);
  let initializeCalls = 0;
  let startCalls = 0;
  let approveCalls = 0;
  let disposeCalls = 0;

  const port: TaskRuntimePort = {
    initialize(): void {
      initializeCalls += 1;
    },
    currentTask(): PersistedTask {
      return task;
    },
    async start(): Promise<WorkflowSnapshot> {
      startCalls += 1;
      task = persistedTask(taskId, 'awaiting_plan_approval', task.workflowVersion + 1);
      return task.workflowSnapshot;
    },
    async approvePlan(): Promise<WorkflowSnapshot> {
      approveCalls += 1;
      task = persistedTask(taskId, 'completed', task.workflowVersion + 1);
      return task.workflowSnapshot;
    },
    async dispose(): Promise<void> {
      disposeCalls += 1;
    },
  };

  return {
    port,
    setState(state: WorkflowState): void {
      task = persistedTask(taskId, state, task.workflowVersion + 1);
    },
    counts(): Readonly<{
      initialize: number;
      start: number;
      approve: number;
      dispose: number;
    }> {
      return {
        initialize: initializeCalls,
        start: startCalls,
        approve: approveCalls,
        dispose: disposeCalls,
      };
    },
  };
}

function persistedTask(
  taskId: ReturnType<typeof asTaskId>,
  state: WorkflowState,
  workflowVersion: number,
): PersistedTask {
  const base = createInitialWorkflow(taskId);
  const workflowSnapshot = {
    ...base,
    state,
  } as WorkflowSnapshot;
  return {
    taskId,
    projectId: 'project-command-flow',
    workflowSnapshot,
    workflowVersion,
    status: state,
  };
}

async function composeHarness() {
  const appRoot = temporaryDirectory('triagent-task-controller-app-');
  const projectRoot = temporaryDirectory('triagent-task-controller-project-');
  const runtime = createFakeRuntime();
  const factoryInputs: TaskRuntimeInput[] = [];
  const factories = {
    createTaskRuntime: async (input: TaskRuntimeInput): Promise<TaskRuntimePort> => {
      factoryInputs.push(input);
      return runtime.port;
    },
  } satisfies ComposeFactories;
  const composition = await composeApplication({
    appRootOverride: appRoot,
    skipHealthProbes: true,
    skipProcessHost: true,
    factories,
  });
  compositions.push(composition);
  return { composition, projectRoot, runtime, factoryInputs };
}

afterEach(() => {
  for (const composition of compositions.splice(0).reverse()) {
    composition.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('application task command flow', () => {
  it('rejects task creation until a project is selected', async () => {
    const { composition, factoryInputs } = await composeHarness();

    const result = await composition.dispatch({
      type: 'CREATE_TASK',
      requirements: 'Implement the requested behavior.',
      roles: DEFAULT_ROLES,
      requiresPlanApproval: true,
    });

    expect(result).toMatchObject({ kind: 'rejected' });
    if (result.kind === 'rejected') {
      expect(result.reason).toMatch(/select.*project|project.*selected/i);
    }
    expect(factoryInputs).toHaveLength(0);
  });

  it('canonicalizes the selected path and detects the project kind before runtime creation', async () => {
    const { composition, projectRoot, factoryInputs } = await composeHarness();

    const selected = await composition.dispatch({
      type: 'SELECT_PROJECT',
      projectPath: join(projectRoot, '.'),
    });
    expect(selected).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        screen: 'new_task',
        projectPath: realpathSync.native(projectRoot),
      },
    });

    await composition.dispatch({
      type: 'CREATE_TASK',
      requirements: 'Implement the requested behavior.',
      roles: DEFAULT_ROLES,
      requiresPlanApproval: true,
    });

    expect(factoryInputs).toHaveLength(1);
    expect(factoryInputs[0]?.project.canonicalRoot).toBe(realpathSync.native(projectRoot));
    expect(factoryInputs[0]?.projectKind).toMatchObject({
      kind: 'directory',
      projectRoot: realpathSync.native(projectRoot),
    });
  });

  it('rejects empty requirements without creating a runtime', async () => {
    const { composition, projectRoot, factoryInputs } = await composeHarness();
    await composition.dispatch({ type: 'SELECT_PROJECT', projectPath: projectRoot });

    const result = await composition.dispatch({
      type: 'CREATE_TASK',
      requirements: '   ',
      roles: DEFAULT_ROLES,
      requiresPlanApproval: true,
    });

    expect(result).toMatchObject({ kind: 'rejected' });
    if (result.kind === 'rejected') {
      expect(result.reason).toMatch(/requirements.*non.?empty|required/i);
    }
    expect(factoryInputs).toHaveLength(0);
  });

  it('rejects duplicate role assignments before creating a runtime', async () => {
    const { composition, projectRoot, factoryInputs } = await composeHarness();
    await composition.dispatch({ type: 'SELECT_PROJECT', projectPath: projectRoot });

    const result = await composition.dispatch({
      type: 'CREATE_TASK',
      requirements: 'Implement the requested behavior.',
      roles: { master: 'codex', implementer: 'codex', reviewer: 'grok' },
      requiresPlanApproval: true,
    });

    expect(result).toMatchObject({ kind: 'rejected' });
    if (result.kind === 'rejected') {
      expect(result.reason).toMatch(/distinct|duplicate|unique/i);
    }
    expect(factoryInputs).toHaveLength(0);
  });

  it.each(ROLE_PERMUTATIONS)(
    'passes a legal role permutation to the runtime unchanged: %o',
    async (roles) => {
      const { composition, projectRoot, factoryInputs } = await composeHarness();
      await composition.dispatch({ type: 'SELECT_PROJECT', projectPath: projectRoot });

      const result = await composition.dispatch({
        type: 'CREATE_TASK',
        requirements: 'Implement the requested behavior.',
        roles,
        requiresPlanApproval: true,
      });

      expect(result).toMatchObject({ kind: 'snapshot' });
      expect(factoryInputs).toHaveLength(1);
      expect(factoryInputs[0]?.roles).toEqual(roles);
    },
  );

  it('initializes and starts the runtime, then exposes awaiting plan approval', async () => {
    const { composition, projectRoot, runtime } = await composeHarness();
    await composition.dispatch({ type: 'SELECT_PROJECT', projectPath: projectRoot });

    const result = await composition.dispatch({
      type: 'CREATE_TASK',
      requirements: 'Implement the requested behavior.',
      roles: DEFAULT_ROLES,
      requiresPlanApproval: true,
    });

    expect(runtime.counts()).toMatchObject({ initialize: 1, start: 1, approve: 0 });
    expect(result).toMatchObject({
      kind: 'snapshot',
      snapshot: {
        screen: 'plan_approval',
        workflowState: 'awaiting_plan_approval',
        roles: DEFAULT_ROLES,
        canApprove: true,
      },
    });
  });

  it('rejects approval outside the legal state and rejects a repeated approval', async () => {
    const { composition, projectRoot, runtime } = await composeHarness();

    const beforeTask = await composition.dispatch({ type: 'APPROVE' });
    expect(beforeTask).toMatchObject({ kind: 'rejected' });

    await composition.dispatch({ type: 'SELECT_PROJECT', projectPath: projectRoot });
    await composition.dispatch({
      type: 'CREATE_TASK',
      requirements: 'Implement the requested behavior.',
      roles: DEFAULT_ROLES,
      requiresPlanApproval: true,
    });

    const first = await composition.dispatch({ type: 'APPROVE' });
    expect(first).toMatchObject({
      kind: 'snapshot',
      snapshot: { workflowState: 'completed', canApprove: false },
    });

    const repeated = await composition.dispatch({ type: 'APPROVE' });
    expect(repeated).toMatchObject({ kind: 'rejected' });
    expect(runtime.counts().approve).toBe(1);
  });

  it('blocks application exit while a task is active and allows it after terminal state', async () => {
    const { composition, projectRoot, runtime } = await composeHarness();
    await composition.dispatch({ type: 'SELECT_PROJECT', projectPath: projectRoot });
    await composition.dispatch({
      type: 'CREATE_TASK',
      requirements: 'Implement the requested behavior.',
      roles: DEFAULT_ROLES,
      requiresPlanApproval: true,
    });

    const blocked = await composition.dispatch({ type: 'REQUEST_EXIT' });
    expect(blocked).toMatchObject({
      kind: 'exit_gate',
      gate: { allowed: false },
    });
    expect(composition.acceptingIntents).toBe(true);

    runtime.setState('completed');
    const allowed = await composition.dispatch({ type: 'REQUEST_EXIT' });
    expect(allowed).toMatchObject({
      kind: 'exit_gate',
      gate: { allowed: true },
    });
    expect(runtime.counts().dispose).toBe(1);
  });
});
