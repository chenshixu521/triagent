import { describe, expect, it, vi } from 'vitest';

import {
  createTaskSessionController,
  type TaskRuntimePort,
} from '../../../src/app/task-session-controller.js';
import { asTaskId } from '../../../src/domain/ids.js';
import type { PersistedTask } from '../../../src/persistence/task-repository.js';
import type { TuiSnapshot } from '../../../src/tui/store.js';
import type { WorkflowSnapshot, WorkflowState } from '../../../src/workflow/states.js';

function makeTask(state: WorkflowState, taskId = 'task-progress-1'): PersistedTask {
  const id = asTaskId(taskId);
  const snapshot = {
    taskId: id,
    requirementVersion: 1,
    reworkCount: 0,
    maxReworks: 3 as const,
    pauseAfterAttempt: false,
    state,
  } as WorkflowSnapshot;
  return {
    taskId: id,
    projectId: 'project-1',
    status: state,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
  };
}

describe('TaskSessionController live progress', () => {
  it('returns immediately to work-status screen and pushes stage updates while start runs', async () => {
    let state: WorkflowState = 'draft';
    let resolveStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });

    const runtime: TaskRuntimePort = {
      initialize() {
        /* no-op */
      },
      currentTask() {
        return makeTask(state);
      },
      async start() {
        state = 'checking_environment';
        await new Promise((r) => setTimeout(r, 30));
        state = 'planning';
        await startGate;
        state = 'awaiting_plan_approval';
        return makeTask(state).workflowSnapshot;
      },
      async approvePlan() {
        throw new Error('not used');
      },
      async dispose() {
        /* no-op */
      },
    };

    const progress: Partial<TuiSnapshot>[] = [];
    const controller = createTaskSessionController({
      ownerInstanceId: 'instance-1',
      progressPollMs: 20,
      createRuntime: async () => runtime,
      onProgress: (partial) => {
        progress.push(partial);
      },
    });

    const select = await controller.dispatch({
      type: 'SELECT_PROJECT',
      projectPath: process.cwd(),
    });
    expect(select?.kind).toBe('snapshot');

    const create = await controller.dispatch({
      type: 'CREATE_TASK',
      requirements: 'add a hello world endpoint',
      roles: { master: 'claude', implementer: 'grok', reviewer: 'codex' },
      requiresPlanApproval: true,
    });

    expect(create?.kind).toBe('snapshot');
    if (create?.kind !== 'snapshot') throw new Error('expected snapshot');
    expect(create.snapshot.screen).toBe('run');
    expect(create.snapshot.loading).toBe(true);
    expect(create.snapshot.logs?.system?.length).toBeGreaterThan(0);

    // Allow poll loop to observe planning before we release start().
    await new Promise((r) => setTimeout(r, 80));
    expect(progress.some((p) => p.workflowState === 'planning')).toBe(true);

    resolveStart();
    await vi.waitFor(() => {
      expect(
        progress.some((p) => p.workflowState === 'awaiting_plan_approval'),
      ).toBe(true);
    });

    const last = progress[progress.length - 1]!;
    expect(last.screen).toBe('plan_approval');
    expect(last.loading).toBe(false);
    expect(last.canApprove).toBe(true);

    await controller.dispose();
  });
});
