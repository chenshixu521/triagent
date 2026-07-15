import type { AgentAdapter } from './agent-adapter.js';
import type { AttemptId, ConversationId } from '../domain/ids.js';

/**
 * Optional session lifecycle surface implemented by Claude/Grok adapters.
 * Not on the core AgentAdapter interface so Codex can omit it.
 */
export interface SessionLifecycleAdapter {
  readonly markAttemptPersisted?: (input: {
    readonly attemptId: AttemptId;
    readonly conversationId: ConversationId;
    readonly exitReason?: 'completed' | 'interrupted';
    readonly endedAt?: string;
  }) => void;
  readonly markAttemptUnresumable?: (input: {
    readonly attemptId: AttemptId;
    readonly conversationId?: ConversationId;
    readonly reason:
      | 'killed_unpersisted'
      | 'failed'
      | 'interrupted'
      | 'timed_out'
      | 'cancelled';
    readonly endedAt?: string;
  }) => void;
}

export function asSessionLifecycle(
  adapter: AgentAdapter,
): SessionLifecycleAdapter {
  return adapter as AgentAdapter & SessionLifecycleAdapter;
}

/**
 * After a run settles, persist or invalidate session evidence for resume.
 * Best-effort: never throws into the run pipeline.
 */
export function settleSessionAfterRun(input: {
  readonly adapter: AgentAdapter;
  readonly attemptId: AttemptId;
  readonly status: 'succeeded' | 'failed' | 'timed_out' | 'stopped';
  readonly conversationId?: ConversationId;
  readonly endedAt?: string;
}): 'persisted' | 'unresumable' | 'skipped' {
  const life = asSessionLifecycle(input.adapter);
  const endedAt = input.endedAt ?? new Date().toISOString();

  try {
    if (
      (input.status === 'succeeded' || input.status === 'stopped')
      && input.conversationId !== undefined
      && life.markAttemptPersisted !== undefined
    ) {
      life.markAttemptPersisted({
        attemptId: input.attemptId,
        conversationId: input.conversationId,
        endedAt,
        exitReason: input.status === 'stopped' ? 'interrupted' : 'completed',
      });
      return 'persisted';
    }

    if (
      (input.status === 'failed' || input.status === 'timed_out')
      && life.markAttemptUnresumable !== undefined
    ) {
      life.markAttemptUnresumable({
        attemptId: input.attemptId,
        ...(input.conversationId === undefined
          ? {}
          : { conversationId: input.conversationId }),
        reason: input.status === 'timed_out' ? 'timed_out' : 'failed',
        endedAt,
      });
      return 'unresumable';
    }
  } catch {
    return 'skipped';
  }
  return 'skipped';
}
