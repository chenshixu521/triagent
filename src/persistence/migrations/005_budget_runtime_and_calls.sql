CREATE TABLE budget_task_state (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  total_active_runtime_ms INTEGER NOT NULL DEFAULT 0
    CHECK (total_active_runtime_ms >= 0),
  total_active_runtime_limit_ms INTEGER NOT NULL CHECK (total_active_runtime_limit_ms > 0),
  per_attempt_timeout_ms INTEGER NOT NULL CHECK (per_attempt_timeout_ms > 0),
  max_external_calls INTEGER NOT NULL CHECK (max_external_calls > 0),
  exhausted_reason TEXT CHECK (
    exhausted_reason IS NULL
    OR exhausted_reason IN (
      'total_runtime',
      'per_attempt_timeout',
      'external_call_count',
      'ambiguous_restart'
    )
  ),
  non_billable_state TEXT CHECK (
    non_billable_state IS NULL
    OR non_billable_state IN ('paused_after_run', 'awaiting_user')
  ),
  non_billable_entered_at TEXT,
  fail_closed INTEGER NOT NULL DEFAULT 0 CHECK (fail_closed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (non_billable_state IS NULL AND non_billable_entered_at IS NULL)
    OR (non_billable_state IS NOT NULL AND non_billable_entered_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE budget_active_intervals (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK (length(trim(attempt_id)) > 0),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CHECK (
    (ended_at IS NULL AND duration_ms IS NULL)
    OR (ended_at IS NOT NULL AND duration_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX budget_active_intervals_task_open_idx
  ON budget_active_intervals(task_id, ended_at, started_at);

CREATE INDEX budget_active_intervals_attempt_idx
  ON budget_active_intervals(attempt_id, started_at);

CREATE TABLE budget_call_reservations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK (length(trim(attempt_id)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  guard_decision_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'reserved', 'launched', 'released', 'consumed'
  )),
  reserved_at TEXT NOT NULL,
  launched_at TEXT,
  released_at TEXT,
  consumed_at TEXT,
  crash_reason TEXT,
  CHECK (
    (status = 'reserved' AND launched_at IS NULL AND released_at IS NULL AND consumed_at IS NULL)
    OR (status = 'launched' AND launched_at IS NOT NULL AND released_at IS NULL AND consumed_at IS NULL)
    OR (status = 'released' AND launched_at IS NULL AND released_at IS NOT NULL AND consumed_at IS NULL)
    OR (status = 'consumed' AND launched_at IS NOT NULL AND released_at IS NULL AND consumed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX budget_call_reservations_task_status_idx
  ON budget_call_reservations(task_id, status, reserved_at);
