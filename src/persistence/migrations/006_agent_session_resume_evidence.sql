-- Extend agent_sessions with resume evidence required by Claude (and future)
-- adapters: last attempt, status, capability/profile/guard context.
-- Existing rows remain non-resumable until a completed_persisted turn is recorded.

ALTER TABLE agent_sessions ADD COLUMN attempt_id TEXT
  CHECK (attempt_id IS NULL OR length(trim(attempt_id)) > 0);

ALTER TABLE agent_sessions ADD COLUMN adapter_version TEXT
  CHECK (adapter_version IS NULL OR length(trim(adapter_version)) > 0);

ALTER TABLE agent_sessions ADD COLUMN adapter_platform TEXT
  CHECK (adapter_platform IS NULL OR length(trim(adapter_platform)) > 0);

ALTER TABLE agent_sessions ADD COLUMN mode TEXT
  CHECK (
    mode IS NULL
    OR mode IN ('project_write', 'read_only', 'patch_mode', 'auto_allowed', 'disabled')
  );

ALTER TABLE agent_sessions ADD COLUMN permission_profile_hash TEXT
  CHECK (
    permission_profile_hash IS NULL
    OR length(trim(permission_profile_hash)) > 0
  );

ALTER TABLE agent_sessions ADD COLUMN guard_decision_id TEXT
  CHECK (guard_decision_id IS NULL OR length(trim(guard_decision_id)) > 0);

ALTER TABLE agent_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'completed_persisted', 'unresumable'));

ALTER TABLE agent_sessions ADD COLUMN exit_reason TEXT
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
  );

ALTER TABLE agent_sessions ADD COLUMN last_attempt_id TEXT
  CHECK (last_attempt_id IS NULL OR length(trim(last_attempt_id)) > 0);

ALTER TABLE agent_sessions ADD COLUMN resumable INTEGER NOT NULL DEFAULT 0
  CHECK (resumable IN (0, 1));

CREATE INDEX agent_sessions_resume_idx
  ON agent_sessions(task_id, agent_kind, conversation_id, resumable, status);
