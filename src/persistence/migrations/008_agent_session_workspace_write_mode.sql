-- Allow agent_sessions.mode = workspace_write for isolated Grok implementer.
-- SQLite cannot alter column CHECK constraints; rebuild the table.

CREATE TABLE agent_sessions_008 (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('master', 'implementer', 'reviewer')),
  agent_kind TEXT NOT NULL CHECK (agent_kind IN ('codex', 'claude', 'grok')),
  conversation_id TEXT,
  started_at TEXT NOT NULL,
  last_used_at TEXT,
  ended_at TEXT,
  attempt_id TEXT
    CHECK (attempt_id IS NULL OR length(trim(attempt_id)) > 0),
  adapter_version TEXT
    CHECK (adapter_version IS NULL OR length(trim(adapter_version)) > 0),
  adapter_platform TEXT
    CHECK (adapter_platform IS NULL OR length(trim(adapter_platform)) > 0),
  mode TEXT
    CHECK (
      mode IS NULL
      OR mode IN (
        'project_write',
        'workspace_write',
        'read_only',
        'patch_mode',
        'auto_allowed',
        'disabled'
      )
    ),
  permission_profile_hash TEXT
    CHECK (
      permission_profile_hash IS NULL
      OR length(trim(permission_profile_hash)) > 0
    ),
  guard_decision_id TEXT
    CHECK (guard_decision_id IS NULL OR length(trim(guard_decision_id)) > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed_persisted', 'unresumable')),
  exit_reason TEXT
    CHECK (
      exit_reason IS NULL
      OR exit_reason IN (
        'completed',
        'failed',
        'cancelled',
        'interrupted',
        'timed_out',
        'killed_unpersisted'
      )
    ),
  last_attempt_id TEXT
    CHECK (last_attempt_id IS NULL OR length(trim(last_attempt_id)) > 0),
  resumable INTEGER NOT NULL DEFAULT 0
    CHECK (resumable IN (0, 1))
) STRICT;

INSERT INTO agent_sessions_008 (
  id, task_id, role, agent_kind, conversation_id, started_at, last_used_at, ended_at,
  attempt_id, adapter_version, adapter_platform, mode, permission_profile_hash,
  guard_decision_id, status, exit_reason, last_attempt_id, resumable
)
SELECT
  id, task_id, role, agent_kind, conversation_id, started_at, last_used_at, ended_at,
  attempt_id, adapter_version, adapter_platform, mode, permission_profile_hash,
  guard_decision_id, status, exit_reason, last_attempt_id, resumable
FROM agent_sessions;

DROP TABLE agent_sessions;
ALTER TABLE agent_sessions_008 RENAME TO agent_sessions;

CREATE INDEX agent_sessions_task_idx ON agent_sessions(task_id, role, ended_at);
CREATE INDEX agent_sessions_resume_idx
  ON agent_sessions(task_id, agent_kind, conversation_id, resumable, status);
