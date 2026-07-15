import { describe, expect, it, vi } from 'vitest';

import {
  createTaskSessionController,
  type TaskRuntimePort,
} from '../../../src/app/task-session-controller.js';
import { asTaskId } from '../../../src/domain/ids.js';
import type { PersistedTask } from '../../../src/persistence/task-repository.js';
import type { TuiSnapshot } from '../../../src/tui/store.js';
import type { WorkflowSnapshot, WorkflowState } from '../../../src/workflow/states.js';

function makeTask(state: WorkflowState, taskId = 'task-hold-1'): PersistedTask {
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

describe('TaskSessionController interrupt + context', () => {
  it('interrupts with Q path, keeps context, continues with messages injected', async () => {
    let state: WorkflowState = 'draft';
    let resolveStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const contextOnRuntime: string[] = [];
    let stopCalls = 0;
    let startCount = 0;

    const makeRuntime = (): TaskRuntimePort => ({
      initialize() {
        /* no-op */
      },
      currentTask() {
        return makeTask(state);
      },
      async start() {
        startCount += 1;
        state = 'planning';
        await startGate;
        state = 'awaiting_plan_approval';
        return makeTask(state).workflowSnapshot;
      },
      async approvePlan() {
        state = 'implementing';
        return makeTask(state).workflowSnapshot;
      },
      async dispose() {
        /* no-op */
      },
      async requestStopActiveAttempt() {
        stopCalls += 1;
        state = 'planning';
      },
      queueContextMessage(text: string) {
        contextOnRuntime.push(text);
      },
      peekContextMessages() {
        return contextOnRuntime;
      },
    });

    const progress: Partial<TuiSnapshot>[] = [];
    const controller = createTaskSessionController({
      ownerInstanceId: 'instance-hold',
      progressPollMs: 20,
      createRuntime: async () => makeRuntime(),
      onProgress: (partial) => {
        progress.push(partial);
      },
    });

    await controller.dispatch({
      type: 'SELECT_PROJECT',
      projectPath: process.cwd(),
    });
    await controller.dispatch({
      type: 'CREATE_TASK',
      requirements: 'build a hello endpoint',
      roles: { master: 'claude', implementer: 'grok', reviewer: 'codex' },
      requiresPlanApproval: true,
    });

    await new Promise((r) => setTimeout(r, 40));

    const interrupted = await controller.dispatch({
      type: 'REQUEST_CANCEL_OR_INTERRUPT',
    });
    expect(interrupted?.kind).toBe('snapshot');
    if (interrupted?.kind !== 'snapshot') throw new Error('expected snapshot');
    expect(interrupted.snapshot.screen).toBe('recovery');
    expect(interrupted.snapshot.recoveryAllowedActions).toEqual(
      expect.arrayContaining(['continue', 'cancel', 'inspect']),
    );
    expect(stopCalls).toBeGreaterThanOrEqual(1);

    const queued = await controller.dispatch({
      type: 'QUEUE_MESSAGE',
      text: '改用 TypeScript，并加单元测试',
    });
    expect(queued?.kind).toBe('snapshot');
    expect(contextOnRuntime).toContain('改用 TypeScript，并加单元测试');

    // Release original start so it does not hang the process.
    resolveStart();

    const continued = await controller.dispatch({
      type: 'RECOVERY_CONTINUE',
      taskId: 'task-hold-1',
    });
    expect(continued?.kind).toBe('snapshot');
    if (continued?.kind !== 'snapshot') throw new Error('expected continue snapshot');
    // Continue either resumes run UI or recreates drive.
    expect(
      continued.snapshot.screen === 'run'
      || continued.snapshot.screen === 'plan_approval'
      || continued.snapshot.statusMessage?.includes('继续'),
    ).toBe(true);

    await controller.dispose();
  });

  it('cancel after interrupt disposes and lands on cancelled review', async () => {
    let state: WorkflowState = 'planning';
    const runtime: TaskRuntimePort = {
      initialize() {
        /* no-op */
      },
      currentTask() {
        return makeTask(state);
      },
      async start() {
        state = 'planning';
        await new Promise(() => {
          /* hang until interrupt supersedes */
        });
        return makeTask(state).workflowSnapshot;
      },
      async approvePlan() {
        throw new Error('not used');
      },
      async dispose() {
        /* no-op */
      },
      async requestStopActiveAttempt() {
        /* no-op */
      },
      queueContextMessage() {
        /* no-op */
      },
    };

    const controller = createTaskSessionController({
      ownerInstanceId: 'instance-cancel',
      createRuntime: async () => runtime,
    });
    await controller.dispatch({
      type: 'SELECT_PROJECT',
      projectPath: process.cwd(),
    });
    void controller.dispatch({
      type: 'CREATE_TASK',
      requirements: 'task',
      roles: { master: 'claude', implementer: 'grok', reviewer: 'codex' },
      requiresPlanApproval: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    await controller.dispatch({ type: 'REQUEST_CANCEL_OR_INTERRUPT' });
    const cancelled = await controller.dispatch({
      type: 'RECOVERY_CANCEL',
      taskId: 'task-hold-1',
    });
    expect(cancelled?.kind).toBe('snapshot');
    if (cancelled?.kind !== 'snapshot') throw new Error('expected snapshot');
    expect(cancelled.snapshot.screen).toBe('review');
    expect(cancelled.snapshot.workflowState).toBe('cancelled');
    await controller.dispose();
  });
});
