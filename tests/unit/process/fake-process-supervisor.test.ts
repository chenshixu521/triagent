import { describe, expect, it, vi } from 'vitest';

import { asAttemptId } from '../../../src/domain/ids.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';

const attemptId = asAttemptId('attempt-supervisor-1');

describe('FakeProcessSupervisor', () => {
  it('tracks root and descendant liveness until force-stop clears the whole tree', async () => {
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const attempt = asAttemptId('attempt-descendant-liveness');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 4001,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 4001 } },
        {
          afterMs: 1,
          event: {
            type: 'descendant_started',
            pid: 4002,
            parentPid: 4001,
          },
        },
      ],
      forceStop: { afterMs: 2, outcome: 'succeeded', exitCode: 1 },
    }]);

    await supervisor.start({
      attemptId: attempt,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    clock.advanceBy(1);
    expect(supervisor.activeAttemptIds()).toEqual([attempt]);
    expect(supervisor.activeProcessIds()).toEqual([4001, 4002]);

    await supervisor.forceStopTree(attempt);
    clock.advanceBy(2);
    expect(supervisor.activeAttemptIds()).toEqual([]);
    expect(supervisor.activeProcessIds()).toEqual([]);
  });

  it('emits a planned process lifecycle only when its injected clock advances', async () => {
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 4101,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 4101 } },
        { afterMs: 5, event: { type: 'stdout', chunk: 'part-1' } },
        {
          afterMs: 10,
          event: {
            type: 'descendant_started',
            pid: 4102,
            parentPid: 4101,
          },
        },
        {
          afterMs: 20,
          event: {
            type: 'exited',
            pid: 4101,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const events: unknown[] = [];
    supervisor.subscribe(attemptId, (event) => events.push(event));

    const process = await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: ['fake-cli.mjs', 'scenario.json'],
      cwd: 'D:\\temporary project',
    });
    const wait = supervisor.wait(attemptId);
    const waitSpy = vi.fn();
    void wait.then(waitSpy);

    expect(process).toEqual({
      attemptId,
      pid: 4101,
      startedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(events).toEqual([]);
    expect(waitSpy).not.toHaveBeenCalled();

    clock.advanceBy(10);
    expect(events).toEqual([
      expect.objectContaining({ type: 'started', attemptId, pid: 4101 }),
      expect.objectContaining({ type: 'stdout', attemptId, chunk: 'part-1' }),
      expect.objectContaining({
        type: 'descendant_started',
        attemptId,
        pid: 4102,
        parentPid: 4101,
      }),
    ]);
    expect(waitSpy).not.toHaveBeenCalled();

    clock.advanceBy(10);
    await wait;
    expect(waitSpy).toHaveBeenCalledWith({
      attemptId,
      pid: 4101,
      exitCode: 0,
      signal: null,
      reason: 'exited',
      endedAt: '2026-07-12T00:00:00.020Z',
    });
  });

  it('records stop ordering and emits deterministic cleanup success or failure', async () => {
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const gracefulAttempt = asAttemptId('attempt-graceful');
    const forceAttempt = asAttemptId('attempt-force');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 4201,
        timeline: [],
        gracefulStop: {
          afterMs: 5,
          outcome: 'succeeded',
          exitCode: 0,
        },
      },
      {
        pid: 4202,
        timeline: [],
        forceStop: {
          afterMs: 7,
          outcome: 'failed',
          error: 'descendant still running',
        },
      },
    ]);
    const gracefulEvents: unknown[] = [];
    const forceEvents: unknown[] = [];
    supervisor.subscribe(gracefulAttempt, (event) => gracefulEvents.push(event));
    supervisor.subscribe(forceAttempt, (event) => forceEvents.push(event));

    await supervisor.start({
      attemptId: gracefulAttempt,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    await supervisor.start({
      attemptId: forceAttempt,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    await supervisor.requestGracefulStop(gracefulAttempt);
    await supervisor.forceStopTree(forceAttempt);

    expect(supervisor.calls.map((call) => call.type)).toEqual([
      'subscribe',
      'subscribe',
      'start',
      'start',
      'request_graceful_stop',
      'force_stop_tree',
    ]);

    clock.advanceBy(7);
    expect(gracefulEvents).toContainEqual(expect.objectContaining({
      type: 'cleanup_succeeded',
      attemptId: gracefulAttempt,
      operation: 'graceful_stop',
    }));
    expect(forceEvents).toContainEqual(expect.objectContaining({
      type: 'cleanup_failed',
      attemptId: forceAttempt,
      operation: 'force_stop_tree',
      error: 'descendant still running',
    }));
  });

  it('suppresses planned and repeated-stop emissions after the first terminal exit', async () => {
    const clock = new FakeClock('2026-07-12T03:00:00.000Z');
    const terminalAttempt = asAttemptId('attempt-terminal-suppression');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 4301,
      timeline: [
        { afterMs: 10, event: { type: 'stdout', chunk: 'too late' } },
        { afterMs: 11, event: { type: 'stderr', chunk: 'too late' } },
        {
          afterMs: 12,
          event: {
            type: 'descendant_started',
            pid: 4302,
            parentPid: 4301,
          },
        },
        {
          afterMs: 20,
          event: {
            type: 'exited',
            pid: 4301,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
      forceStop: {
        afterMs: 5,
        outcome: 'succeeded',
      },
    }]);
    const observed: unknown[] = [];
    supervisor.subscribe(terminalAttempt, (event) => observed.push(event));
    await supervisor.start({
      attemptId: terminalAttempt,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });

    await supervisor.forceStopTree(terminalAttempt);
    await supervisor.forceStopTree(terminalAttempt);
    const waiting = supervisor.wait(terminalAttempt);
    clock.advanceBy(5);
    await waiting;
    await supervisor.forceStopTree(terminalAttempt);
    clock.advanceBy(30);

    expect(observed).toEqual([
      expect.objectContaining({
        type: 'cleanup_succeeded',
        attemptId: terminalAttempt,
        operation: 'force_stop_tree',
      }),
      expect.objectContaining({
        type: 'exited',
        attemptId: terminalAttempt,
        reason: 'force_stop',
      }),
    ]);
  });

  it('keeps cleanup failure non-terminal so callers can escalate to force-stop success', async () => {
    const clock = new FakeClock('2026-07-12T03:10:00.000Z');
    const attempt = asAttemptId('attempt-cleanup-escalation');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 4401,
      timeline: [],
      gracefulStop: {
        afterMs: 2,
        outcome: 'failed',
        error: 'graceful descendant remained',
      },
      forceStop: {
        afterMs: 3,
        outcome: 'succeeded',
      },
    }]);
    const observed: unknown[] = [];
    supervisor.subscribe(attempt, (event) => observed.push(event));
    await supervisor.start({
      attemptId: attempt,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });

    await supervisor.requestGracefulStop(attempt);
    clock.advanceBy(2);
    await supervisor.forceStopTree(attempt);
    const waiting = supervisor.wait(attempt);
    clock.advanceBy(3);

    await expect(waiting).resolves.toMatchObject({
      attemptId: attempt,
      reason: 'force_stop',
    });
    expect(observed.map((event) => (event as { type: string }).type)).toEqual([
      'cleanup_failed',
      'cleanup_succeeded',
      'exited',
    ]);
  });

  it('settles terminal wait and fans out exit before surfacing a listener failure', async () => {
    const clock = new FakeClock('2026-07-12T03:20:00.000Z');
    const attempt = asAttemptId('attempt-throwing-exit-listener');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 4501,
      timeline: [{
        afterMs: 10,
        event: { type: 'stdout', chunk: 'must remain suppressed' },
      }],
      forceStop: {
        afterMs: 5,
        outcome: 'succeeded',
      },
    }]);
    const healthyEvents: string[] = [];
    supervisor.subscribe(attempt, (event) => {
      if (event.type === 'exited') throw new Error('exit listener exploded');
    });
    supervisor.subscribe(attempt, (event) => healthyEvents.push(event.type));
    await supervisor.start({
      attemptId: attempt,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    await supervisor.forceStopTree(attempt);
    const waiting = supervisor.wait(attempt);
    const settlements = vi.fn();
    void waiting.then(settlements);

    expect(() => clock.advanceBy(5)).toThrow('exit listener exploded');
    await Promise.resolve();
    expect(settlements).toHaveBeenCalledTimes(1);
    await expect(waiting).resolves.toMatchObject({
      attemptId: attempt,
      reason: 'force_stop',
      endedAt: '2026-07-12T03:20:00.005Z',
    });
    expect(healthyEvents).toEqual(['cleanup_succeeded', 'exited']);

    await supervisor.forceStopTree(attempt);
    clock.advanceBy(20);
    await Promise.resolve();
    expect(settlements).toHaveBeenCalledTimes(1);
    expect(healthyEvents).toEqual(['cleanup_succeeded', 'exited']);
  });

  it('completes the terminal cleanup pair before surfacing a cleanup listener failure', async () => {
    const clock = new FakeClock('2026-07-12T03:30:00.000Z');
    const attempt = asAttemptId('attempt-throwing-cleanup-listener');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 4601,
      timeline: [],
      forceStop: {
        afterMs: 5,
        outcome: 'succeeded',
      },
    }]);
    const healthyEvents: string[] = [];
    supervisor.subscribe(attempt, (event) => {
      if (event.type === 'cleanup_succeeded') {
        throw new Error('cleanup listener exploded');
      }
    });
    supervisor.subscribe(attempt, (event) => healthyEvents.push(event.type));
    await supervisor.start({
      attemptId: attempt,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    await supervisor.forceStopTree(attempt);
    const waiting = supervisor.wait(attempt);
    const settlements = vi.fn();
    void waiting.then(settlements);

    expect(() => clock.advanceBy(5)).toThrow('cleanup listener exploded');
    await Promise.resolve();
    expect(settlements).toHaveBeenCalledTimes(1);
    await expect(waiting).resolves.toMatchObject({
      attemptId: attempt,
      reason: 'force_stop',
    });
    expect(healthyEvents).toEqual(['cleanup_succeeded', 'exited']);
  });
});
