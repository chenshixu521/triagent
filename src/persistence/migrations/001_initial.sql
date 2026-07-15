CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  root_path TEXT NOT NULL UNIQUE CHECK (length(trim(root_path)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'checking_environment', 'planning', 'awaiting_plan_approval',
    'implementing', 'reviewing', 'master_validation', 'rework_requested',
    'paused_after_run', 'interrupting', 'interrupted_needs_inspection',
    'cleanup_failed', 'awaiting_user', 'completed', 'cancelled', 'failed'
  )),
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  workflow_snapshot TEXT NOT NULL CHECK (json_valid(workflow_snapshot)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX tasks_project_status_idx ON tasks(project_id, status);

CREATE TABLE requirement_versions (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  requirements TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, version)
) STRICT;

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('master', 'implementer', 'reviewer')),
  agent_kind TEXT NOT NULL CHECK (agent_kind IN ('codex', 'claude', 'grok')),
  conversation_id TEXT,
  started_at TEXT NOT NULL,
  last_used_at TEXT,
  ended_at TEXT
) STRICT;

CREATE INDEX agent_sessions_task_idx ON agent_sessions(task_id, role, ended_at);

CREATE TABLE run_attempts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'completed')),
  role TEXT CHECK (role IS NULL OR role IN ('master', 'implementer', 'reviewer')),
  pid INTEGER CHECK (pid IS NULL OR pid > 0),
  process_started_at TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN (
    'completed', 'failed', 'cancelled', 'interrupted', 'timed_out'
  )),
  baseline_id TEXT NOT NULL CHECK (length(trim(baseline_id)) > 0),
  requirement_version INTEGER NOT NULL CHECK (requirement_version > 0),
  conversation_id TEXT,
  CHECK (
    (status = 'pending' AND role IS NULL AND pid IS NULL AND process_started_at IS NULL AND ended_at IS NULL AND exit_reason IS NULL AND conversation_id IS NULL)
    OR
    (status = 'active' AND role IS NOT NULL AND pid IS NOT NULL AND process_started_at IS NOT NULL AND ended_at IS NULL AND exit_reason IS NULL)
    OR
    (status = 'completed' AND role IS NOT NULL AND pid IS NOT NULL AND process_started_at IS NOT NULL AND ended_at IS NOT NULL AND exit_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX run_attempts_task_status_idx ON run_attempts(task_id, status, started_at);

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  action_type TEXT NOT NULL CHECK (length(trim(action_type)) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('intent', 'completed', 'failed')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'intent' AND completed_at IS NULL AND error_text IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND error_text IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND error_text IS NOT NULL)
  )
) STRICT;

CREATE INDEX pending_actions_status_idx ON pending_actions(status, created_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX events_task_idx ON events(task_id, id);

CREATE TABLE log_index (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES run_attempts(id) ON DELETE SET NULL,
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
  file_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX log_index_attempt_idx ON log_index(attempt_id, id);

CREATE TABLE workflow_transitions (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX workflow_transitions_task_version_idx
  ON workflow_transitions(task_id, workflow_version);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES run_attempts(id) ON DELETE SET NULL,
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('reviewer', 'master')),
  verdict TEXT NOT NULL CHECK (verdict IN ('approved', 'rejected', 'invalid', 'failed')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX reviews_task_idx ON reviews(task_id, created_at);

CREATE TABLE file_baselines (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
  manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json)),
  error_text TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX file_baselines_task_status_idx ON file_baselines(task_id, status);

CREATE TABLE file_changes (
  id INTEGER PRIMARY KEY,
  baseline_id TEXT NOT NULL REFERENCES file_baselines(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (length(path) > 0),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('added', 'modified', 'deleted')),
  before_hash TEXT,
  after_hash TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json))
) STRICT;

CREATE UNIQUE INDEX file_changes_baseline_path_idx ON file_changes(baseline_id, path);

CREATE TABLE user_messages (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_text TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
) STRICT;

CREATE INDEX user_messages_task_status_idx ON user_messages(task_id, status, created_at);

CREATE TABLE project_locks (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (length(trim(path)) > 0),
  owner_token TEXT NOT NULL CHECK (length(trim(owner_token)) > 0),
  acquired_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  released_at TEXT
) STRICT;

CREATE INDEX project_locks_active_idx ON project_locks(project_id, released_at, lease_expires_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY CHECK (length(trim(key)) > 0),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
) STRICT;
