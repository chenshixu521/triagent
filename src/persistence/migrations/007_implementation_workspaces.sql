CREATE TABLE implementation_workspaces (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  canonical_project_root TEXT NOT NULL,
  workspace_root TEXT NOT NULL UNIQUE,
  source_baseline_id TEXT NOT NULL REFERENCES file_baselines(id),
  source_manifest_hash TEXT NOT NULL CHECK(length(source_manifest_hash) = 64),
  candidate_manifest_hash TEXT CHECK(
    candidate_manifest_hash IS NULL OR length(candidate_manifest_hash) = 64
  ),
  change_set_hash TEXT CHECK(change_set_hash IS NULL OR length(change_set_hash) = 64),
  status TEXT NOT NULL CHECK(status IN (
    'preparing',
    'ready',
    'running',
    'candidate_ready',
    'under_review',
    'approved',
    'validating',
    'promoting',
    'promoted',
    'rejected',
    'abandoned',
    'recovery_required'
  )),
  authorization_id TEXT NOT NULL UNIQUE,
  authorization_expires_at TEXT NOT NULL,
  authorization_consumed_at TEXT,
  retained_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, attempt_id)
) STRICT;

CREATE INDEX idx_implementation_workspaces_task_status
  ON implementation_workspaces(task_id, status);

CREATE INDEX idx_implementation_workspaces_retention
  ON implementation_workspaces(status, retained_until);
