import { describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '../../../src/agents/agent-adapter.js';
import { settleSessionAfterRun } from '../../../src/agents/session-lifecycle.js';
import { asAttemptId, asConversationId } from '../../../src/domain/ids.js';

function fakeAdapter(methods: {
  markAttemptPersisted?: ReturnType<typeof vi.fn>;
  markAttemptUnresumable?: ReturnType<typeof vi.fn>;
}): AgentAdapter {
  return {
    kind: 'grok',
    checkAvailability: async () => ({ status: 'available', version: '1' }),
    discoverCapabilities: async () =>
      ({
        fixedSessionId: true,
        resume: true,
        structuredOutput: true,
        streamJson: true,
        realTimeInput: false,
        nativeSandbox: false,
        nativePermissionRules: false,
        budgetLimit: false,
        turnLimit: false,
        timeLimit: false,
        nonGitProjects: true,
        writeModes: ['workspace-write'],
      }) as never,
    start: async () => {
      throw new Error('not used');
    },
    resume: async () => {
      throw new Error('not used');
    },
    parseEvent: () => null,
    ...methods,
  } as AgentAdapter;
}

describe('settleSessionAfterRun', () => {
  it('persists conversation on succeeded and stopped (interrupted)', () => {
    const markAttemptPersisted = vi.fn();
    const adapter = fakeAdapter({ markAttemptPersisted });
    const attemptId = asAttemptId('a1');
    const conversationId = asConversationId('c1');

    expect(
      settleSessionAfterRun({
        adapter,
        attemptId,
        status: 'succeeded',
        conversationId,
      }),
    ).toBe('persisted');
    expect(markAttemptPersisted).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId,
        conversationId,
        exitReason: 'completed',
      }),
    );

    markAttemptPersisted.mockClear();
    expect(
      settleSessionAfterRun({
        adapter,
        attemptId,
        status: 'stopped',
        conversationId,
      }),
    ).toBe('persisted');
    expect(markAttemptPersisted).toHaveBeenCalledWith(
      expect.objectContaining({ exitReason: 'interrupted' }),
    );
  });

  it('marks unresumable on failed', () => {
    const markAttemptUnresumable = vi.fn();
    const adapter = fakeAdapter({ markAttemptUnresumable });
    expect(
      settleSessionAfterRun({
        adapter,
        attemptId: asAttemptId('a2'),
        status: 'failed',
      }),
    ).toBe('unresumable');
    expect(markAttemptUnresumable).toHaveBeenCalled();
  });
});
