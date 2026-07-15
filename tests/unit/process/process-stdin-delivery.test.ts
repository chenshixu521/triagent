import { describe, expect, it } from 'vitest';

import { asAttemptId } from '../../../src/domain/ids.js';
import type { ProcessStartRequest } from '../../../src/process/process-supervisor-port.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';

const attemptId = asAttemptId('attempt-stdin-1');

function baseRequest(
  overrides: Partial<ProcessStartRequest> = {},
): ProcessStartRequest {
  return {
    attemptId,
    executable: 'node.exe',
    args: ['echo.mjs'],
    cwd: 'D:\\temporary project',
    ...overrides,
  };
}

describe('ProcessStartRequest stdin payload (one-shot)', () => {
  it('records bounded UTF-8 stdin payload on FakeProcessSupervisor start', async () => {
    const clock = new FakeClock('2026-07-12T04:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 9101,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 9101 } },
        {
          afterMs: 1,
          event: {
            type: 'exited',
            pid: 9101,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);

    const prompt = 'Exact UTF-8 prompt 中文 ✓ — deliver once then close';
    await supervisor.start(
      baseRequest({
        stdin: {
          encoding: 'utf8',
          data: prompt,
          closeAfterWrite: true,
        },
      }),
    );

    const start = supervisor.calls.find((call) => call.type === 'start');
    expect(start?.type).toBe('start');
    if (start?.type !== 'start') return;
    expect(start.request.stdin).toEqual({
      encoding: 'utf8',
      data: prompt,
      closeAfterWrite: true,
    });
    // Prompt must never be smuggled into argv.
    expect(start.request.args.join('\0')).not.toContain(prompt);
  });

  it('rejects oversized stdin payloads fail-closed (no start)', async () => {
    const clock = new FakeClock('2026-07-12T04:05:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 9102,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 9102 } },
      ],
    }]);

    const tooLarge = 'x'.repeat(512 * 1024 + 1);
    await expect(
      supervisor.start(
        baseRequest({
          stdin: {
            encoding: 'utf8',
            data: tooLarge,
            closeAfterWrite: true,
          },
        }),
      ),
    ).rejects.toThrow(/stdin|too large|bound|limit/i);

    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(0);
  });

  it('accepts base64-encoded one-shot payload and records bytes length', async () => {
    const clock = new FakeClock('2026-07-12T04:10:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 9103,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 9103 } },
        {
          afterMs: 1,
          event: {
            type: 'exited',
            pid: 9103,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);

    const text = 'base64-prompt-payload';
    const data = Buffer.from(text, 'utf8').toString('base64');
    await supervisor.start(
      baseRequest({
        stdin: {
          encoding: 'base64',
          data,
          closeAfterWrite: true,
        },
      }),
    );

    const start = supervisor.calls.find((call) => call.type === 'start');
    expect(start?.type).toBe('start');
    if (start?.type !== 'start') return;
    expect(start.request.stdin?.encoding).toBe('base64');
    expect(start.request.stdin?.data).toBe(data);
    expect(start.request.stdin?.closeAfterWrite).toBe(true);
  });
});
