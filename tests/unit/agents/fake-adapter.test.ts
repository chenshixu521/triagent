import { describe, expect, it } from 'vitest';

import type { AgentCapabilities } from '../../../src/agents/agent-capabilities.js';
import { unknownAgentCapabilities } from '../../../src/agents/agent-capabilities.js';
import type {
  AgentEvent,
  AgentRequest,
} from '../../../src/agents/agent-adapter.js';
import { FakeAdapter } from '../../../src/agents/fake/fake-adapter.js';
import type { ExecutionHandle } from '../../../src/agents/execution-handle.js';
import {
  asAttemptId,
  asBaselineId,
  asConversationId,
} from '../../../src/domain/ids.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';

function verifiedCapabilities(
  overrides: Partial<AgentCapabilities> = {},
): AgentCapabilities {
  return Object.freeze({
    ...unknownAgentCapabilities(),
    ...overrides,
    writeModes: Object.freeze([...(overrides.writeModes ?? [])]),
  });
}

function agentRequest(attempt = 'attempt-adapter-1'): AgentRequest {
  return {
    attemptId: asAttemptId(attempt),
    baselineId: asBaselineId(`baseline-${attempt}`),
    requirementVersion: 1,
    role: 'implementer',
    projectRoot: 'D:\\temporary project\\项目',
    prompt: 'Implement the approved change.',
  };
}

async function collectEvents(
  events: AsyncIterable<AgentEvent>,
): Promise<readonly AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('agent capabilities', () => {
  it('fails closed when CLI capabilities have not been verified', () => {
    expect(unknownAgentCapabilities()).toEqual({
      fixedSessionId: false,
      resume: false,
      structuredOutput: false,
      streamJson: false,
      realTimeInput: false,
      nativeSandbox: false,
      nativePermissionRules: false,
      budgetLimit: false,
      turnLimit: false,
      timeLimit: false,
      nonGitProjects: false,
      writeModes: [],
    });
  });
});

describe('FakeAdapter', () => {
  it('snapshots discovered capabilities so later mutation cannot enable an unverified feature', async () => {
    const mutableCapabilities = {
      ...unknownAgentCapabilities(),
      writeModes: [] as AgentCapabilities['writeModes'][number][],
    };
    const adapter = new FakeAdapter({
      kind: 'codex',
      supervisor: new FakeProcessSupervisor(
        new FakeClock('2026-07-12T00:50:00.000Z'),
        [],
      ),
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\availability.json',
      tempBasePath: 'D:\\temporary project',
      capabilities: mutableCapabilities,
      health: { status: 'available', version: 'fake-cli 1.0.0' },
    });

    mutableCapabilities.resume = true;
    mutableCapabilities.writeModes.push('unrestricted');

    await expect(adapter.checkAvailability()).resolves.toEqual({
      status: 'available',
      version: 'fake-cli 1.0.0',
    });
    await expect(adapter.discoverCapabilities()).resolves.toMatchObject({
      resume: false,
      writeModes: [],
    });
  });

  it('reassembles partial stdout lines into attempt-attributed structured output', async () => {
    const request = agentRequest();
    const conversationId = asConversationId('conversation-success');
    const clock = new FakeClock('2026-07-12T01:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5101,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 5101 } },
        {
          afterMs: 1,
          event: {
            type: 'stdout',
            chunk: `${JSON.stringify({
              type: 'output',
              attemptId: request.attemptId,
              text: 'hello from the fake agent',
            })}\r`,
          },
        },
        {
          afterMs: 2,
          event: {
            type: 'stdout',
            chunk: `\n${JSON.stringify({
              type: 'result',
              attemptId: request.attemptId,
              conversationId,
              output: { summary: 'implemented' },
            }).slice(0, 40)}`,
          },
        },
        {
          afterMs: 3,
          event: {
            type: 'stdout',
            chunk: `${JSON.stringify({
              type: 'result',
              attemptId: request.attemptId,
              conversationId,
              output: { summary: 'implemented' },
            }).slice(40)}\n`,
          },
        },
        {
          afterMs: 3,
          event: {
            type: 'exited',
            pid: 5101,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const adapter = new FakeAdapter({
      kind: 'codex',
      supervisor,
      cliPath: 'D:\\fixtures\\fake cli\\index.mjs',
      scenarioPath: 'D:\\scenarios\\success scenario.json',
      tempBasePath: 'D:\\temporary project',
      capabilities: verifiedCapabilities({
        structuredOutput: true,
        streamJson: true,
        fixedSessionId: true,
      }),
    });

    const handle: ExecutionHandle = await adapter.start(request);
    const collecting = collectEvents(handle.events());
    const waiting = handle.wait();
    clock.advanceBy(3);
    const [events, result] = await Promise.all([collecting, waiting]);

    expect(events.map((event) => event.type)).toEqual([
      'process_started',
      'output',
      'result',
      'process_exited',
    ]);
    expect(events).toContainEqual({
      type: 'output',
      attemptId: request.attemptId,
      text: 'hello from the fake agent',
    });
    expect(result).toEqual({
      attemptId: request.attemptId,
      conversationId,
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      output: { summary: 'implemented' },
      messages: [],
    });
    expect(
      supervisor.calls.find((call) => call.type === 'start'),
    ).toMatchObject({
      request: {
        attemptId: request.attemptId,
        executable: process.execPath,
        cwd: request.projectRoot,
        args: [
          'D:\\fixtures\\fake cli\\index.mjs',
          'D:\\scenarios\\success scenario.json',
          '--attempt-id',
          request.attemptId,
          '--project-root',
          request.projectRoot,
          '--temp-base',
          'D:\\temporary project',
        ],
      },
    });
  });

  it('preserves invalid JSON as an attempt-attributed parse error and continues', async () => {
    const request = agentRequest('attempt-invalid-json');
    const clock = new FakeClock('2026-07-12T01:10:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5102,
      timeline: [
        {
          afterMs: 1,
          event: { type: 'stdout', chunk: '{"broken":\n' },
        },
        {
          afterMs: 2,
          event: {
            type: 'stdout',
            chunk: `${JSON.stringify({
              type: 'result',
              attemptId: request.attemptId,
              output: { recovered: true },
            })}\n`,
          },
        },
        {
          afterMs: 3,
          event: {
            type: 'exited',
            pid: 5102,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const adapter = new FakeAdapter({
      kind: 'claude',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\invalid.json',
      tempBasePath: 'D:\\temporary project',
      capabilities: verifiedCapabilities({ streamJson: true }),
    });

    const handle = await adapter.start(request);
    const collecting = collectEvents(handle.events());
    const waiting = handle.wait();
    clock.advanceBy(3);
    const [events, result] = await Promise.all([collecting, waiting]);

    expect(events).toContainEqual({
      type: 'parse_error',
      attemptId: request.attemptId,
      raw: '{"broken":',
      error: 'invalid or unsupported fake CLI event',
    });
    expect(events).toContainEqual({
      type: 'result',
      attemptId: request.attemptId,
      output: { recovered: true },
    });
    expect(result.status).toBe('succeeded');
  });

  it('reports a delayed descendant and a nonzero process crash without inventing a result', async () => {
    const request = agentRequest('attempt-crash');
    const clock = new FakeClock('2026-07-12T01:20:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5201,
      timeline: [
        {
          afterMs: 10,
          event: {
            type: 'descendant_started',
            pid: 5202,
            parentPid: 5201,
          },
        },
        {
          afterMs: 11,
          event: { type: 'stderr', chunk: 'fake crash\n' },
        },
        {
          afterMs: 12,
          event: {
            type: 'exited',
            pid: 5201,
            exitCode: 7,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const adapter = new FakeAdapter({
      kind: 'grok',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\crash.json',
      tempBasePath: 'D:\\temporary project',
    });

    const handle = await adapter.start(request);
    const collecting = collectEvents(handle.events());
    const waiting = handle.wait();
    clock.advanceBy(12);
    const [events, result] = await Promise.all([collecting, waiting]);

    expect(events).toContainEqual({
      type: 'descendant_started',
      attemptId: request.attemptId,
      pid: 5202,
      parentPid: 5201,
      occurredAt: '2026-07-12T01:20:00.010Z',
    });
    expect(events).toContainEqual({
      type: 'stderr',
      attemptId: request.attemptId,
      chunk: 'fake crash\n',
      occurredAt: '2026-07-12T01:20:00.011Z',
    });
    expect(result).toEqual({
      attemptId: request.attemptId,
      status: 'failed',
      exitCode: 7,
      signal: null,
      error: 'agent process exited with code 7: fake crash',
      messages: [],
    });
  });

  it('returns an explicit timeout result for the same attempt', async () => {
    const request = {
      ...agentRequest('attempt-timeout'),
      timeoutMs: 25,
    };
    const clock = new FakeClock('2026-07-12T01:30:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5301,
      timeline: [{
        afterMs: 25,
        event: {
          type: 'exited',
          pid: 5301,
          exitCode: null,
          signal: 'SIGTERM',
          reason: 'timed_out',
        },
      }],
    }]);
    const adapter = new FakeAdapter({
      kind: 'codex',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\timeout.json',
      tempBasePath: 'D:\\temporary project',
    });

    const handle = await adapter.start(request);
    const waiting = handle.wait();
    clock.advanceBy(25);

    await expect(waiting).resolves.toEqual({
      attemptId: request.attemptId,
      status: 'timed_out',
      exitCode: null,
      signal: 'SIGTERM',
      error: 'agent process timed out after 25 ms',
      messages: [],
    });
    expect(
      supervisor.calls.find((call) => call.type === 'start'),
    ).toMatchObject({ request: { timeoutMs: 25 } });
  });

  it('queues ordinary messages monotonically when real-time input is unverified without stopping the run', async () => {
    const request = agentRequest('attempt-queued-message');
    const clock = new FakeClock('2026-07-12T01:40:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5401,
      timeline: [
        {
          afterMs: 10,
          event: {
            type: 'stdout',
            chunk: `${JSON.stringify({
              type: 'result',
              attemptId: request.attemptId,
              output: { complete: true },
            })}\n`,
          },
        },
        {
          afterMs: 10,
          event: {
            type: 'exited',
            pid: 5401,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const adapter = new FakeAdapter({
      kind: 'claude',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\queued.json',
      tempBasePath: 'D:\\temporary project',
      capabilities: verifiedCapabilities({ realTimeInput: false }),
    });

    const handle = await adapter.start(request);
    const collecting = collectEvents(handle.events());
    const first = await handle.sendMessage('First follow-up');
    const second = await handle.sendMessage('Second follow-up');

    expect(first).toEqual({
      attemptId: request.attemptId,
      sequence: 1,
      content: 'First follow-up',
      state: 'queued',
    });
    expect(second).toEqual({
      attemptId: request.attemptId,
      sequence: 2,
      content: 'Second follow-up',
      state: 'queued',
    });
    expect(supervisor.calls.map((call) => call.type)).not.toContain(
      'request_graceful_stop',
    );
    expect(supervisor.calls.map((call) => call.type)).not.toContain(
      'force_stop_tree',
    );

    const waiting = handle.wait();
    clock.advanceBy(10);
    const [events, result] = await Promise.all([collecting, waiting]);

    expect(events.filter((event) => event.type === 'message_state')).toEqual([
      { type: 'message_state', attemptId: request.attemptId, message: first },
      { type: 'message_state', attemptId: request.attemptId, message: second },
    ]);
    expect(result.messages).toEqual([first, second]);
    expect(result.status).toBe('succeeded');
  });

  it('tracks a verified real-time message from queued through delivered, acknowledged, and applied', async () => {
    const request = agentRequest('attempt-realtime-message');
    const content = 'Use the persisted acceptance criteria.';
    const clock = new FakeClock('2026-07-12T01:50:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5501,
      timeline: [
        {
          afterMs: 5,
          event: {
            type: 'stdout',
            chunk: `${JSON.stringify({
              type: 'message_state',
              attemptId: request.attemptId,
              message: {
                attemptId: request.attemptId,
                sequence: 1,
                content,
                state: 'acknowledged',
              },
            })}\n`,
          },
        },
        {
          afterMs: 6,
          event: {
            type: 'stdout',
            chunk: `${JSON.stringify({
              type: 'message_state',
              attemptId: request.attemptId,
              message: {
                attemptId: request.attemptId,
                sequence: 1,
                content,
                state: 'applied',
              },
            })}\n`,
          },
        },
        {
          afterMs: 7,
          event: {
            type: 'stdout',
            chunk: `${JSON.stringify({
              type: 'result',
              attemptId: request.attemptId,
              output: { complete: true },
            })}\n`,
          },
        },
        {
          afterMs: 7,
          event: {
            type: 'exited',
            pid: 5501,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const adapter = new FakeAdapter({
      kind: 'codex',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\realtime.json',
      tempBasePath: 'D:\\temporary project',
      capabilities: verifiedCapabilities({ realTimeInput: true }),
    });

    const handle = await adapter.start(request);
    const collecting = collectEvents(handle.events());
    const delivered = await handle.sendMessage(content);

    expect(delivered).toMatchObject({
      attemptId: request.attemptId,
      sequence: 1,
      content,
      state: 'delivered',
    });

    const waiting = handle.wait();
    clock.advanceBy(7);
    const [events, result] = await Promise.all([collecting, waiting]);

    expect(
      events
        .filter((event) => event.type === 'message_state')
        .map((event) => event.message.state),
    ).toEqual(['queued', 'delivered', 'acknowledged', 'applied']);
    expect(result.messages).toEqual([{
      attemptId: request.attemptId,
      sequence: 1,
      content,
      state: 'applied',
    }]);
  });

  it('marks a verified real-time message failed when the fake delivery channel rejects it', async () => {
    const request = agentRequest('attempt-message-failed');
    const clock = new FakeClock('2026-07-12T02:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5601,
      timeline: [
        {
          afterMs: 2,
          event: {
            type: 'stdout',
            chunk: `${JSON.stringify({
              type: 'result',
              attemptId: request.attemptId,
              output: { complete: true },
            })}\n`,
          },
        },
        {
          afterMs: 2,
          event: {
            type: 'exited',
            pid: 5601,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const adapter = new FakeAdapter({
      kind: 'grok',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\message-failed.json',
      tempBasePath: 'D:\\temporary project',
      capabilities: verifiedCapabilities({ realTimeInput: true }),
      messageDelivery: {
        outcome: 'failed',
        error: 'fake input channel closed',
      },
    });

    const handle = await adapter.start(request);
    const collecting = collectEvents(handle.events());
    const failed = await handle.sendMessage('Late follow-up');

    expect(failed).toEqual({
      attemptId: request.attemptId,
      sequence: 1,
      content: 'Late follow-up',
      state: 'failed',
      error: 'fake input channel closed',
    });

    const waiting = handle.wait();
    clock.advanceBy(2);
    const [events, result] = await Promise.all([collecting, waiting]);
    expect(
      events
        .filter((event) => event.type === 'message_state')
        .map((event) => event.message.state),
    ).toEqual(['queued', 'failed']);
    expect(result.messages).toEqual([failed]);
  });

  it('degrades an illegal message-state line to a parse error instead of throwing', async () => {
    const request = agentRequest('attempt-invalid-message-state');
    const content = 'Message already delivered';
    const invalidLine = JSON.stringify({
      type: 'message_state',
      attemptId: request.attemptId,
      message: {
        attemptId: request.attemptId,
        sequence: 1,
        content,
        state: 'queued',
      },
    });
    const clock = new FakeClock('2026-07-12T02:05:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5651,
      timeline: [
        {
          afterMs: 1,
          event: { type: 'stdout', chunk: `${invalidLine}\n` },
        },
        {
          afterMs: 2,
          event: {
            type: 'stdout',
            chunk: `${JSON.stringify({
              type: 'result',
              attemptId: request.attemptId,
              output: { recovered: true },
            })}\n`,
          },
        },
        {
          afterMs: 2,
          event: {
            type: 'exited',
            pid: 5651,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const adapter = new FakeAdapter({
      kind: 'codex',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\invalid-message-state.json',
      tempBasePath: 'D:\\temporary project',
      capabilities: verifiedCapabilities({ realTimeInput: true }),
    });

    const handle = await adapter.start(request);
    const collecting = collectEvents(handle.events());
    await handle.sendMessage(content);
    const waiting = handle.wait();

    expect(() => clock.advanceBy(2)).not.toThrow();
    const [events, result] = await Promise.all([collecting, waiting]);
    expect(events).toContainEqual({
      type: 'parse_error',
      attemptId: request.attemptId,
      raw: invalidLine,
      error: 'invalid message state transition for sequence 1: delivered -> queued',
    });
    expect(result.status).toBe('succeeded');
  });

  it('targets graceful stop at the active attempt and exposes confirmed cleanup', async () => {
    const request = agentRequest('attempt-graceful-stop');
    const clock = new FakeClock('2026-07-12T02:10:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5701,
      timeline: [],
      gracefulStop: {
        afterMs: 5,
        outcome: 'succeeded',
        exitCode: 0,
      },
    }]);
    const adapter = new FakeAdapter({
      kind: 'codex',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\stop.json',
      tempBasePath: 'D:\\temporary project',
    });

    const handle = await adapter.start(request);
    const collecting = collectEvents(handle.events());
    await handle.requestStop();
    const waiting = handle.wait();
    clock.advanceBy(5);
    const [events, result] = await Promise.all([collecting, waiting]);

    expect(supervisor.calls).toContainEqual({
      type: 'request_graceful_stop',
      attemptId: request.attemptId,
    });
    expect(events).toContainEqual({
      type: 'cleanup_succeeded',
      attemptId: request.attemptId,
      operation: 'graceful_stop',
      occurredAt: '2026-07-12T02:10:00.005Z',
    });
    expect(result).toEqual({
      attemptId: request.attemptId,
      status: 'stopped',
      exitCode: 0,
      signal: null,
      messages: [],
    });
  });

  it('targets force-kill at the active attempt without using conversation identity', async () => {
    const request = agentRequest('attempt-force-stop');
    const clock = new FakeClock('2026-07-12T02:20:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5801,
      timeline: [],
      forceStop: {
        afterMs: 3,
        outcome: 'succeeded',
      },
    }]);
    const adapter = new FakeAdapter({
      kind: 'claude',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\force-stop.json',
      tempBasePath: 'D:\\temporary project',
    });

    const handle = await adapter.start(request);
    await handle.forceKillTree();
    const waiting = handle.wait();
    clock.advanceBy(3);

    await expect(waiting).resolves.toMatchObject({
      attemptId: request.attemptId,
      status: 'stopped',
      exitCode: null,
      signal: 'SIGKILL',
    });
    expect(supervisor.calls).toContainEqual({
      type: 'force_stop_tree',
      attemptId: request.attemptId,
    });
  });

  it('fails resume explicitly when the capability is not verified', async () => {
    const clock = new FakeClock('2026-07-12T02:30:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const adapter = new FakeAdapter({
      kind: 'grok',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\resume-unsupported.json',
      tempBasePath: 'D:\\temporary project',
      capabilities: verifiedCapabilities({ resume: false }),
    });

    await expect(
      adapter.resume(
        asConversationId('conversation-unsupported'),
        agentRequest('attempt-resume-unsupported'),
      ),
    ).rejects.toThrow(/unsupported.*resume|resume.*unsupported/i);
    expect(supervisor.calls.some((call) => call.type === 'start')).toBe(false);
  });

  it('resumes the same conversation with a distinct run attempt', async () => {
    const firstRequest = agentRequest('attempt-conversation-first');
    const resumedRequest = agentRequest('attempt-conversation-resumed');
    const conversationId = asConversationId('conversation-resumable');
    const clock = new FakeClock('2026-07-12T02:40:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 5901,
        timeline: [
          {
            afterMs: 1,
            event: {
              type: 'stdout',
              chunk: `${JSON.stringify({
                type: 'result',
                attemptId: firstRequest.attemptId,
                conversationId,
                output: { phase: 'first' },
              })}\n`,
            },
          },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 5901,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
      {
        pid: 5902,
        timeline: [
          {
            afterMs: 1,
            event: {
              type: 'stdout',
              chunk: `${JSON.stringify({
                type: 'result',
                attemptId: resumedRequest.attemptId,
                output: { phase: 'resumed' },
              })}\n`,
            },
          },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 5902,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
    ]);
    const adapter = new FakeAdapter({
      kind: 'claude',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\resume.json',
      tempBasePath: 'D:\\temporary project',
      capabilities: verifiedCapabilities({
        fixedSessionId: true,
        resume: true,
      }),
    });

    const firstHandle = await adapter.start(firstRequest);
    const firstWaiting = firstHandle.wait();
    clock.advanceBy(1);
    await expect(firstWaiting).resolves.toMatchObject({
      attemptId: firstRequest.attemptId,
      conversationId,
      status: 'succeeded',
    });

    await expect(
      adapter.resume(conversationId, firstRequest),
    ).rejects.toThrow(/attempt.*already|distinct.*attempt/i);

    const resumedHandle = await adapter.resume(conversationId, resumedRequest);
    const resumedWaiting = resumedHandle.wait();
    clock.advanceBy(1);
    await expect(resumedWaiting).resolves.toMatchObject({
      attemptId: resumedRequest.attemptId,
      conversationId,
      status: 'succeeded',
      output: { phase: 'resumed' },
    });

    const starts = supervisor.calls.filter((call) => call.type === 'start');
    expect(starts.map((call) => call.request.attemptId)).toEqual([
      firstRequest.attemptId,
      resumedRequest.attemptId,
    ]);
    expect(starts[1]).toMatchObject({
      request: {
        args: expect.arrayContaining([
          '--conversation-id',
          conversationId,
        ]),
      },
    });
  });

  it('rejects a resumed result that claims a different conversation identity', async () => {
    const request = agentRequest('attempt-conversation-mismatch');
    const conversationId = asConversationId('conversation-expected');
    const wrongConversationId = asConversationId('conversation-wrong');
    const line = JSON.stringify({
      type: 'result',
      attemptId: request.attemptId,
      conversationId: wrongConversationId,
      output: { mustNotBeAccepted: true },
    });
    const clock = new FakeClock('2026-07-12T02:50:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 5951,
      timeline: [
        { afterMs: 1, event: { type: 'stdout', chunk: `${line}\n` } },
        {
          afterMs: 1,
          event: {
            type: 'exited',
            pid: 5951,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const adapter = new FakeAdapter({
      kind: 'claude',
      supervisor,
      cliPath: 'D:\\fixture\\index.mjs',
      scenarioPath: 'D:\\fixture\\resume-mismatch.json',
      tempBasePath: 'D:\\temporary project',
      capabilities: verifiedCapabilities({ resume: true }),
    });

    const handle = await adapter.resume(conversationId, request);
    const collecting = collectEvents(handle.events());
    const waiting = handle.wait();
    clock.advanceBy(1);
    const [events, result] = await Promise.all([collecting, waiting]);

    expect(events).toContainEqual({
      type: 'parse_error',
      attemptId: request.attemptId,
      raw: line,
      error: 'resumed result conversationId did not match the requested conversation',
    });
    expect(events.some((event) => event.type === 'result')).toBe(false);
    expect(result).toMatchObject({
      attemptId: request.attemptId,
      conversationId,
      status: 'failed',
    });
  });
});
