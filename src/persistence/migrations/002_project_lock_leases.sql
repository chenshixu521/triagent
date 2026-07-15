ALTER TABLE project_locks ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE project_locks ADD COLUMN canonical_root TEXT;
ALTER TABLE project_locks ADD COLUMN comparison_key TEXT;
ALTER TABLE project_locks ADD COLUMN display_root TEXT;
ALTER TABLE project_locks ADD COLUMN path_flavor TEXT CHECK (
  path_flavor IS NULL OR path_flavor IN ('windows', 'posix')
);
ALTER TABLE project_locks ADD COLUMN owner_instance_id TEXT;
ALTER TABLE project_locks ADD COLUMN heartbeat_at TEXT;
ALTER TABLE project_locks ADD COLUMN updated_at TEXT;

UPDATE project_locks
SET canonical_root = path,
    comparison_key = lower(replace(path, '/', '\')),
    display_root = path,
    path_flavor = 'windows',
    owner_instance_id = owner_token,
    heartbeat_at = acquired_at,
    updated_at = acquired_at
WHERE canonical_root IS NULL;

CREATE INDEX project_locks_active_comparison_idx
  ON project_locks(released_at, comparison_key, lease_expires_at);

CREATE TABLE project_lock_reconciliations (
  id INTEGER PRIMARY KEY,
  lock_id TEXT NOT NULL CHECK (length(trim(lock_id)) > 0),
  task_id TEXT,
  decision TEXT NOT NULL CHECK (decision = 'release'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
  lock_snapshot_json TEXT NOT NULL CHECK (json_valid(lock_snapshot_json)),
  reconciled_at TEXT NOT NULL
) STRICT;

CREATE INDEX project_lock_reconciliations_lock_idx
  ON project_lock_reconciliations(lock_id, reconciled_at);
