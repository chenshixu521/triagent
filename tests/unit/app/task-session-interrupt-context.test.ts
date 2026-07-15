import { describe, expect, it } from 'vitest';

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
    let continueCalls = 0;
    let createRuntimeCalls = 0;

    const makeRuntime = (): TaskRuntimePort => ({
      initialize() {
        /* no-op */
      },
      currentTask() {
        return makeTask(state);
      },
      async start() {
        state = 'planning';
        // Stay mid-flight until interrupt supersedes this drive.
        await startGate;
        return makeTask(state).workflowSnapshot;
      },
      async approvePlan() {
        state = 'implementing';
        return makeTask(state).workflowSnapshot;
      },
      async continueAfterOperatorHold() {
        continueCalls += 1;
        // Same task: re-enter planning after operator interrupt settle.
        state = 'planning';
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
      createRuntime: async () => {
        createRuntimeCalls += 1;
        return makeRuntime();
      },
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

    // Unblock superseded start so continue can await drivePromise.
    resolveStart();

    const continued = await controller.dispatch({
      type: 'RECOVERY_CONTINUE',
      taskId: 'task-hold-1',
    });
    expect(continued?.kind).toBe('snapshot');
    if (continued?.kind !== 'snapshot') throw new Error('expected continue snapshot');
    // Same-task continue: keep task id, do not create a second runtime.
    expect(continued.snapshot.taskId).toBe('task-hold-1');
    expect(continueCalls).toBeGreaterThanOrEqual(1);
    expect(createRuntimeCalls).toBe(1);
    expect(
      continued.snapshot.screen === 'run'
      || continued.snapshot.statusMessage?.includes('同任务'),
    ).toBe(true);

    await controller.dispose();
  });

  it('same-task continue does not recreate when mid-flight after interrupt', async () => {
    let state: WorkflowState = 'implementing';
    let continueCalls = 0;
    let createRuntimeCalls = 0;
    const taskId = 'task-same-1';
    let resolveStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });

    const runtime: TaskRuntimePort = {
      initialize() {
        /* no-op */
      },
      currentTask() {
        return makeTask(state, taskId);
      },
      async start() {
        await startGate;
        return makeTask(state, taskId).workflowSnapshot;
      },
      async approvePlan() {
        throw new Error('not used');
      },
      async continueAfterOperatorHold() {
        continueCalls += 1;
        state = 'implementing';
        return makeTask(state, taskId).workflowSnapshot;
      },
      async dispose() {
        /* no-op */
      },
      async requestStopActiveAttempt() {
        // Unblock superseded drive so continue can await drivePromise.
        resolveStart();
      },
      queueContextMessage() {
        /* no-op */
      },
    };

    const controller = createTaskSessionController({
      ownerInstanceId: 'instance-same',
      progressPollMs: 20,
      createRuntime: async () => {
        createRuntimeCalls += 1;
        return runtime;
      },
    });

    await controller.dispatch({
      type: 'SELECT_PROJECT',
      projectPath: process.cwd(),
    });
    // Seed controller with active runtime without going through draft start hang.
    // CREATE_TASK would call start in background; we interrupt quickly.
    void controller.dispatch({
      type: 'CREATE_TASK',
      requirements: 'implement feature',
      roles: { master: 'claude', implementer: 'grok', reviewer: 'codex' },
      requiresPlanApproval: false,
    });
    await new Promise((r) => setTimeout(r, 30));

    await controller.dispatch({ type: 'REQUEST_CANCEL_OR_INTERRUPT' });
    await controller.dispatch({
      type: 'QUEUE_MESSAGE',
      text: '优先修复测试',
    });

    const continued = await controller.dispatch({
      type: 'RECOVERY_CONTINUE',
      taskId,
    });
    expect(continued?.kind).toBe('snapshot');
    if (continued?.kind !== 'snapshot') throw new Error('expected snapshot');
    expect(continued.snapshot.taskId).toBe(taskId);
    expect(continueCalls).toBe(1);
    expect(createRuntimeCalls).toBe(1);
    expect(continued.snapshot.statusMessage).toMatch(/同任务/);

    await controller.dispose();
  });

  it('queues context with live delivery status when runtime supports it', async () => {
    const deliveries: string[] = [];
    let resolveStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const runtime: TaskRuntimePort = {
      initialize() {},
      currentTask() {
        return makeTask('implementing', 'task-live-ctx');
      },
      async start() {
        await startGate;
        return makeTask('implementing', 'task-live-ctx').workflowSnapshot;
      },
      async approvePlan() {
        throw new Error('not used');
      },
      async dispose() {
        resolveStart();
      },
      async queueContextMessage(text: string) {
        deliveries.push(text);
        return {
          delivery: 'live' as const,
          detail: 'implementer/attempt-1',
        };
      },
    };

    const controller = createTaskSessionController({
      ownerInstanceId: 'instance-live-ctx',
      progressPollMs: 20,
      createRuntime: async () => runtime,
    });
    await controller.dispatch({
      type: 'SELECT_PROJECT',
      projectPath: process.cwd(),
    });
    void controller.dispatch({
      type: 'CREATE_TASK',
      requirements: 'live context',
      roles: { master: 'claude', implementer: 'grok', reviewer: 'codex' },
      requiresPlanApproval: false,
    });
    await new Promise((r) => setTimeout(r, 30));

    const queued = await controller.dispatch({
      type: 'QUEUE_MESSAGE',
      text: '请改用 async/await',
    });
    expect(queued?.kind).toBe('snapshot');
    if (queued?.kind !== 'snapshot') throw new Error('expected snapshot');
    expect(queued.snapshot.statusMessage).toBe('上下文已实时投递');
    expect(deliveries).toContain('请改用 async/await');
    resolveStart();
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
