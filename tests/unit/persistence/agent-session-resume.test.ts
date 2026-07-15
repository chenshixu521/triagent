import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import {
  asAttemptId,
  asConversationId,
  asTaskId,
} from '../../../src/domain/ids.js';
import { AgentSessionRepository } from '../../../src/persistence/agent-session-repository.js';

function openMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_kind TEXT NOT NULL,
      conversation_id TEXT,
      attempt_id TEXT,
      adapter_version TEXT,
      adapter_platform TEXT,
      mode TEXT,
      permission_profile_hash TEXT,
      guard_decision_id TEXT,
      status TEXT NOT NULL,
      exit_reason TEXT,
      last_attempt_id TEXT,
      resumable INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      last_used_at TEXT,
      ended_at TEXT
    );
  `);
  return db;
}

describe('AgentSessionRepository role resume lookup', () => {
  it('finds latest completed_persisted session for task+role', () => {
    const db = openMemoryDb();
    const sessions = new AgentSessionRepository(db);
    const taskId = asTaskId('task-resume-1');
    const attempt1 = asAttemptId('attempt-1');
    const attempt2 = asAttemptId('attempt-2');
    const conv = asConversationId('conv-impl-1');

    sessions.create({
      sessionId: 'sess-1',
      taskId,
      role: 'implementer',
      agentKind: 'grok',
      conversationId: conv,
      attemptId: attempt1,
      adapterVersion: '1.0.0',
      adapterPlatform: 'win32',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });
    sessions.markCompletedAndPersisted({
      sessionId: 'sess-1',
      attemptId: attempt1,
      conversationId: conv,
      endedAt: '2026-01-01T00:01:00.000Z',
      exitReason: 'completed',
    });

    // Master session must not be selected for implementer.
    sessions.create({
      sessionId: 'sess-master',
      taskId,
      role: 'master',
      agentKind: 'claude',
      conversationId: asConversationId('conv-master'),
      attemptId: attempt2,
      startedAt: '2026-01-01T00:02:00.000Z',
      status: 'active',
    });

    const found = sessions.findLatestForTaskRole({
      taskId,
      role: 'implementer',
      agentKind: 'grok',
    });
    expect(found?.conversationId).toBe(conv);
    expect(found?.resumable).toBe(true);
    expect(found?.status).toBe('completed_persisted');

    const masterFound = sessions.findLatestForTaskRole({
      taskId,
      role: 'master',
      agentKind: 'claude',
    });
    expect(masterFound?.conversationId).toBe(asConversationId('conv-master'));
  });

  it('finds reviewer and master sessions independently', () => {
    const db = openMemoryDb();
    const sessions = new AgentSessionRepository(db);
    const taskId = asTaskId('task-resume-roles');
    sessions.create({
      sessionId: 'sess-master-2',
      taskId,
      role: 'master',
      agentKind: 'claude',
      conversationId: asConversationId('conv-m2'),
      attemptId: asAttemptId('a-m'),
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });
    sessions.markCompletedAndPersisted({
      sessionId: 'sess-master-2',
      attemptId: asAttemptId('a-m'),
      conversationId: asConversationId('conv-m2'),
      endedAt: '2026-01-01T00:01:00.000Z',
      exitReason: 'completed',
    });
    sessions.create({
      sessionId: 'sess-review-2',
      taskId,
      role: 'reviewer',
      agentKind: 'codex',
      conversationId: asConversationId('conv-r2'),
      attemptId: asAttemptId('a-r'),
      startedAt: '2026-01-01T00:02:00.000Z',
      status: 'active',
    });
    sessions.markCompletedAndPersisted({
      sessionId: 'sess-review-2',
      attemptId: asAttemptId('a-r'),
      conversationId: asConversationId('conv-r2'),
      endedAt: '2026-01-01T00:03:00.000Z',
      exitReason: 'completed',
    });

    expect(
      sessions.findLatestForTaskRole({
        taskId,
        role: 'master',
        agentKind: 'claude',
      })?.conversationId,
    ).toBe(asConversationId('conv-m2'));
    expect(
      sessions.findLatestForTaskRole({
        taskId,
        role: 'reviewer',
        agentKind: 'codex',
      })?.conversationId,
    ).toBe(asConversationId('conv-r2'));
    expect(
      sessions.findLatestForTaskRole({
        taskId,
        role: 'implementer',
        agentKind: 'grok',
      }),
    ).toBeUndefined();
  });

  it('promotes interrupted active session to resumable', () => {
    const db = openMemoryDb();
    const sessions = new AgentSessionRepository(db);
    const taskId = asTaskId('task-resume-2');
    const attemptId = asAttemptId('attempt-int');
    const conv = asConversationId('conv-int');

    sessions.create({
      sessionId: 'sess-int',
      taskId,
      role: 'implementer',
      agentKind: 'grok',
      conversationId: conv,
      attemptId,
      adapterVersion: '1.0.0',
      adapterPlatform: 'win32',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });

    const promoted = sessions.promoteActiveToResumable({
      sessionId: 'sess-int',
      attemptId,
      conversationId: conv,
      endedAt: '2026-01-01T00:05:00.000Z',
      exitReason: 'interrupted',
    });
    expect(promoted.status).toBe('completed_persisted');
    expect(promoted.resumable).toBe(true);
    expect(promoted.exitReason).toBe('interrupted');

    const found = sessions.findLatestForTaskRole({
      taskId,
      role: 'implementer',
      agentKind: 'grok',
    });
    expect(found?.conversationId).toBe(conv);
  });
});
