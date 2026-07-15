CREATE TRIGGER guard_active_project_lock_before_task_delete
BEFORE DELETE ON tasks
WHEN EXISTS (
  SELECT 1
  FROM project_locks
  WHERE task_id = OLD.id AND released_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete task with active project lock');
END;

CREATE TRIGGER guard_active_project_lock_before_project_delete
BEFORE DELETE ON projects
WHEN EXISTS (
  SELECT 1
  FROM project_locks
  WHERE project_id = OLD.id AND released_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete project with active project lock');
END;
