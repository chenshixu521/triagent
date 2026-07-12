# TriAgent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-first terminal application that orchestrates Codex CLI, Claude Code, and Grok CLI through a plan -> implement -> independent review -> master validation -> rework workflow.

**Architecture:** A TypeScript/Node.js Ink TUI owns the workflow state machine, SQLite persistence, project baselines, and three CLI adapters. Every external run is supervised by a separate Worker and a Windows `.NET ProcessHost` that owns a Job Object, while JSONL logs and intent/result records make crashes reconcilable.

**Tech Stack:** Node.js 24+, TypeScript 7, Ink 7, React 19, Chokidar 5, Zod 4, Vitest 4, `node:sqlite`, tsup 8, .NET 10 self-contained Windows process host.

**Approved spec:** `docs/superpowers/specs/2026-07-12-triagent-design.md`

**Plan review:** APPROVED after three independent review passes.

**Repository note:** The project directory is not currently a Git repository. Project rules prohibit unsolicited commits, so this plan intentionally contains no commit steps. Do not initialize Git or commit unless the user explicitly asks.

---

## Delivery sequence

1. Core types, state machine, SQLite recovery, project locks, Git baseline, fake adapters.
2. ProjectGuard、预算控制、独立 Agent Worker 与 Windows Job Object supervision。
3. Three real CLI adapters with version-gated command builders.
4. Read-only review, master validation, rework, messages, pause and interruption.
5. Non-Git snapshots, recovery UI, application composition, packaging and Windows E2E verification.

Each phase must remain runnable and testable. Do not enable a real CLI capability until its adapter probe and contract test pass.

## Planned file map

```text
package.json                         Package metadata, scripts, global bin
tsconfig.json                        NodeNext TypeScript configuration
tsup.config.ts                       ESM build and CLI shebang
vitest.config.ts                     Unit/integration test configuration
src/cli/main.tsx                     Global `triagent` entry point
src/app/app-context.ts               Application dependency composition
src/domain/                          IDs, task, role, attempt and event types
src/workflow/                        State machine, engine and orchestration
src/persistence/                     SQLite connection, migrations, repositories
src/project/                         Canonical paths, project locks and health
src/guard/                           ProjectGuard, approval policy and command classification
src/tracking/                        Git/non-Git baselines, hashes, watcher, diff
src/process/                         ProcessHost client and execution handles
src/workers/                         Independent Agent Worker and typed IPC
src/budget/                          Persisted runtime and call budgets
src/agents/                          Adapter contracts and three implementations
src/protocol/                        Prompts, schemas and structured result parsing
src/review/                          Reviewer and master validation pipeline
src/logging/                         JSONL store, ANSI filtering and redaction
src/tui/                             Ink screens, components, keyboard and store
native/TriAgent.ProcessHost/         Windows Job Object helper
schemas/                             Agent final-output JSON schemas
tests/unit/                          Fast deterministic tests
tests/integration/                   SQLite, process, filesystem and workflow tests
tests/fixtures/fake-cli/             Controllable fake AI CLI
tests/e2e/                           Pack/install/TUI and optional real CLI tests
```

## Phase 1: Core workflow with fake adapters

### Task 1: Scaffold the Node package and executable

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `src/cli/main.tsx`
- Create: `tests/unit/cli/package.test.ts`

- [ ] **Step 1: Write the package contract test**

```ts
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

describe('package contract', () => {
  it('registers the triagent global command', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.name).toBe('triagent-orchestrator');
    expect(pkg.bin).toEqual({triagent: './dist/cli.js'});
    expect(pkg.engines.node).toBe('>=24.0.0');
  });
});
```

- [ ] **Step 2: Create `package.json` with pinned current majors**

Use package name `triagent-orchestrator`; the npm name `triagent` is already occupied by an unrelated Kubernetes package.

```json
{
  "name": "triagent-orchestrator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {"triagent": "./dist/cli.js"},
  "engines": {"node": ">=24.0.0"},
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/cli.js",
    "dev": "tsx src/cli/main.tsx"
  },
  "dependencies": {
    "chokidar": "^5.0.0",
    "ink": "^7.1.0",
    "react": "^19.2.7",
    "strip-ansi": "^7.2.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/react": "^19.2.17",
    "fast-check": "^4.9.0",
    "ink-testing-library": "^4.0.0",
    "tsx": "^4.20.0",
    "tsup": "^8.5.1",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm.cmd install`

Expected: lockfile created and install exits `0`.

- [ ] **Step 4: Configure ESM TypeScript and tsup**

Set `module` and `moduleResolution` to `NodeNext`, enable strict mode, JSX `react-jsx`, and include `src`, `tests`, and config files. Configure tsup to emit `dist/cli.js` with a `#!/usr/bin/env node` banner.

- [ ] **Step 5: Add a minimal Ink entry point**

```tsx
import React from 'react';
import {render, Text} from 'ink';

export function App() {
  return <Text>TriAgent bootstrap</Text>;
}

render(<App />, {alternateScreen: true});
```

- [ ] **Step 6: Verify the scaffold**

Run: `npm.cmd test -- tests/unit/cli/package.test.ts`

Expected: PASS.

Run: `npm.cmd run typecheck`

Expected: exit `0`.

Run: `npm.cmd run build`

Expected: `dist/cli.js` exists and starts with a shebang.

### Task 2: Define domain types and a total state machine

**Files:**
- Create: `src/domain/ids.ts`
- Create: `src/domain/task.ts`
- Create: `src/domain/attempt.ts`
- Create: `src/workflow/states.ts`
- Create: `src/workflow/transitions.ts`
- Create: `src/workflow/workflow-engine.ts`
- Create: `tests/unit/workflow/workflow-engine.test.ts`
- Create: `tests/unit/workflow/workflow-properties.test.ts`

- [ ] **Step 1: Write failing transition tests**

Cover at minimum:

- approved plan -> `implementing`;
- implementation complete with pause flag -> `paused_after_run` and `resumeTargetState='reviewing'`;
- resume -> `reviewing`, never repeated implementation;
- failed master validation -> `rework_requested` until 3 reworks;
- fourth rework request -> `awaiting_user`;
- cancel with active run -> `interrupting`;
- cleanup failure -> `cleanup_failed`;
- terminal states reject all ordinary events.

```ts
it('resumes at the completed attempt successor', () => {
  const paused = transition(implementing({pauseAfterAttempt: true}), {
    type: 'IMPLEMENTATION_COMPLETED',
    attemptId: 'attempt-1'
  });
  expect(paused.state).toBe('paused_after_run');
  expect(paused.resumeTargetState).toBe('reviewing');
  expect(transition(paused, {type: 'RESUME'}).state).toBe('reviewing');
});
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `npm.cmd test -- tests/unit/workflow`

Expected: FAIL because transition functions do not exist.

- [ ] **Step 3: Implement branded IDs and immutable state types**

Define `TaskId`, `AttemptId`, `ConversationId`, `BaselineId`, `RequirementVersion`, role assignment, stop intent, pending action, and workflow context. Do not store OS PID in a conversation object.

- [ ] **Step 4: Implement an exhaustive transition function**

Use a discriminated union for events and an `assertNever` default. The reducer must be pure; side effects are returned as commands such as `AcquireProjectLock`, `StartAttempt`, `PersistTransition`, or `ReleaseProjectLock`.

- [ ] **Step 5: Add property tests for terminal and illegal transitions**

Use `fast-check` to verify terminal states never leave their state and rework count never exceeds 3 automatically.

- [ ] **Step 6: Verify**

Run: `npm.cmd test -- tests/unit/workflow`

Expected: PASS.

### Task 3: Create SQLite schema, transactions, and intent/result recovery

**Files:**
- Create: `src/persistence/database.ts`
- Create: `src/persistence/migrator.ts`
- Create: `src/persistence/migrations/001_initial.sql`
- Create: `src/persistence/transaction.ts`
- Create: `src/persistence/task-repository.ts`
- Create: `src/persistence/attempt-repository.ts`
- Create: `src/persistence/action-repository.ts`
- Create: `src/persistence/lock-repository.ts`
- Create: `src/persistence/database-diagnostics.ts`
- Create: `tests/integration/persistence/database.test.ts`
- Create: `tests/integration/persistence/reconcile-windows.test.ts`
- Create: `tests/integration/persistence/corrupt-database.test.ts`

- [ ] **Step 1: Write failing schema tests**

Assert that a new database enables foreign keys, WAL mode, a busy timeout, and creates the approved tables: `projects`, `tasks`, `requirement_versions`, `agent_sessions`, `run_attempts`, `pending_actions`, `events`, `log_index`, `workflow_transitions`, `reviews`, `file_baselines`, `file_changes`, `user_messages`, `project_locks`, `settings`, and `schema_migrations`.

- [ ] **Step 2: Implement `DatabaseSync` initialization**

```ts
const db = new DatabaseSync(path, {
  enableForeignKeyConstraints: true,
  timeout: 5000,
  defensive: true
});
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
```

Wrap multi-statement writes in explicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` helpers.

- [ ] **Step 3: Implement append-only migrations**

Hash every migration and reject a changed migration that was previously applied. Tests must create, reopen, and migrate a temporary file database.

- [ ] **Step 4: Implement intent/result writes**

Before an external side effect, insert `pending_actions(status='intent')` in the same transaction as the state transition. After execution, update it to `completed` or `failed` with an idempotency key and result payload.

- [ ] **Step 5: Write crash-window tests**

Test these persisted states independently:

- intent exists, process never started;
- process identity persisted, no result;
- file baseline complete, attempt result absent;
- user message queued but not delivered;
- incomplete snapshot manifest.

- [ ] **Step 6: Implement fail-closed database diagnostics**

On open, run `PRAGMA quick_check`. If the database is truncated, malformed, or fails integrity checks, enter read-only diagnostic mode. In this mode all repositories reject side-effect intents, Agent Workers and ProcessHost cannot start, and the UI may only display diagnostics/exportable metadata.

- [ ] **Step 7: Test corrupted database startup**

Create truncated and random-byte database fixtures. Assert startup reports `database_corrupt`, opens no writable connection, acquires no project lock, and launches no Adapter or ProcessHost.

- [ ] **Step 8: Verify**

Run: `npm.cmd test -- tests/integration/persistence/database.test.ts tests/integration/persistence/reconcile-windows.test.ts tests/integration/persistence/corrupt-database.test.ts`

Expected: PASS and no temporary database handles remain open.

### Task 4: Canonicalize project paths and implement the single-task lock

**Files:**
- Create: `src/project/canonical-path.ts`
- Create: `src/project/project-kind.ts`
- Create: `src/project/project-lock-service.ts`
- Create: `src/project/reparse-points.ts`
- Create: `tests/unit/project/canonical-path.test.ts`
- Create: `tests/integration/project/project-lock.test.ts`

- [ ] **Step 1: Write Windows path tests**

Cover spaces, Chinese names, drive-letter case, trailing separators, `..`, long paths, UNC paths, symlinks, junctions, and parent/child overlap.

- [ ] **Step 2: Implement canonicalization**

Resolve the absolute real path, normalize Windows case comparison, identify reparse points, and preserve the display path separately. Do not follow project-internal reparse points during snapshots.

- [ ] **Step 3: Implement overlap detection**

`D:\repo` conflicts with `D:\repo\packages\a`; `D:\repo-a` does not conflict with `D:\repo`.

- [ ] **Step 4: Implement SQLite-backed leases**

Acquire with task ID, canonical root, process instance ID, heartbeat, and expiry. Recovery must not delete a stale lock until reconcile proves no owned run remains.

- [ ] **Step 5: Verify**

Run: `npm.cmd test -- tests/unit/project tests/integration/project`

Expected: PASS.

### Task 5: Track Git baselines and task-window diffs

**Files:**
- Create: `src/tracking/hash.ts`
- Create: `src/tracking/git-client.ts`
- Create: `src/tracking/baseline-manifest.ts`
- Create: `src/tracking/git-baseline-service.ts`
- Create: `src/tracking/diff-service.ts`
- Create: `tests/integration/tracking/git-baseline.test.ts`
- Create: `tests/fixtures/repos/README.md`

- [ ] **Step 1: Write tests using temporary Git repositories**

Create cases for clean repos, pre-existing staged/unstaged changes, untracked files, binary files, rename, deletion, and a second attempt baseline.

- [ ] **Step 2: Implement a read-only Git client**

Only expose commands required for inspection: `rev-parse`, `status --porcelain=v2 -z`, `diff --binary`, `ls-files`, and `check-ignore`. Reject reset, checkout, clean, commit, add, merge, rebase, and push in this module.

- [ ] **Step 3: Implement completed manifests**

Write file metadata and content-addressed blobs to a temporary directory, fsync, then atomically rename and mark the manifest complete. Incomplete manifests must be ignored by recovery.

- [ ] **Step 4: Compute task-window and per-attempt diffs**

Compare `HEAD`, task-start content, attempt-start content, and current content. Label output `task-window changes`, not `Agent changes`.

- [ ] **Step 5: Verify**

Run: `npm.cmd test -- tests/integration/tracking/git-baseline.test.ts`

Expected: PASS; original dirty changes remain untouched.

### Task 6: Build JSONL logging, sanitization, and redaction

**Files:**
- Create: `src/logging/jsonl-log.ts`
- Create: `src/logging/log-index-repository.ts`
- Create: `src/logging/sanitize-terminal.ts`
- Create: `src/logging/redact.ts`
- Create: `tests/unit/logging/sanitize-terminal.test.ts`
- Create: `tests/integration/logging/jsonl-log.test.ts`

- [ ] **Step 1: Write failing ANSI/OSC tests**

Include window-title OSC, hyperlink OSC, clipboard OSC 52, cursor movement, embedded NUL, a 2 MB line, and excessive output rate.

- [ ] **Step 2: Implement safe display text**

Use `strip-ansi` as the first layer, explicitly remove remaining C0/C1 controls except newline/tab, cap display line length, and emit truncation/rate-limit events.

- [ ] **Step 3: Implement best-effort redaction**

Redact configured environment values and common token patterns before disk write and again before display. Preserve a boolean `redactionApplied`; do not claim complete secret detection.

- [ ] **Step 4: Make JSONL the only raw log source**

Write monotonically increasing sequence numbers. SQLite stores path, offset, sequence, length, and checksum only.

- [ ] **Step 5: Verify**

Run: `npm.cmd test -- tests/unit/logging tests/integration/logging`

Expected: PASS.

### Task 7: Define Adapter contracts and a controllable fake CLI

**Files:**
- Create: `src/agents/agent-adapter.ts`
- Create: `src/agents/agent-capabilities.ts`
- Create: `src/agents/execution-handle.ts`
- Create: `src/agents/fake/fake-adapter.ts`
- Create: `src/process/process-supervisor-port.ts`
- Create: `tests/fakes/fake-process-supervisor.ts`
- Create: `tests/fixtures/fake-cli/index.mjs`
- Create: `tests/fixtures/fake-cli/scenarios.ts`
- Create: `tests/unit/agents/fake-adapter.test.ts`

- [ ] **Step 1: Write contract tests**

The fake adapter must simulate: successful structured output, invalid JSON, partial lines, timeout, crash, delayed child process, writes to project files, queued message support, unsupported resume, and resume success.

- [ ] **Step 2: Implement separate conversation and run objects**

```ts
type ConversationSession = {
  conversationId: string;
  adapter: AgentKind;
  capabilities: AgentCapabilities;
};

type RunAttempt = {
  attemptId: string;
  conversationId?: string;
  pid?: number;
  startedAt: string;
  baselineId: string;
  requirementVersion: number;
};
```

- [ ] **Step 3: Implement the fake CLI protocol**

Read a scenario JSON file and emit newline-delimited events. All integration tests must use this fixture before touching real AI CLIs.

- [ ] **Step 4: Define the stable process supervision port**

`ProcessSupervisorPort` exposes `start`, `requestGracefulStop`, `forceStopTree`, `wait`, and event subscription using domain types only. Add a deterministic fake that records calls, advances with a fake clock, emits cleanup success/failure, and never launches an OS process. Budget, Worker, and workflow tasks depend on this port until Task 12 provides the Windows implementation.

- [ ] **Step 5: Verify**

Run: `npm.cmd test -- tests/unit/agents/fake-adapter.test.ts`

Expected: PASS.

### Task 8: Orchestrate the full fake plan/implement/review/rework workflow

**Files:**
- Create: `src/workflow/command-runner.ts`
- Create: `src/workflow/task-orchestrator.ts`
- Create: `src/workflow/reconciler.ts`
- Create: `src/protocol/result-schema.ts`
- Create: `src/protocol/result-parser.ts`
- Create: `schemas/agent-result.schema.json`
- Create: `tests/integration/workflow/happy-path.test.ts`
- Create: `tests/integration/workflow/rework.test.ts`
- Create: `tests/integration/workflow/crash-recovery.test.ts`

- [ ] **Step 1: Write the happy-path integration test**

Given fake master/implementer/reviewer adapters, assert the exact persisted transition sequence from `draft` to `completed`, including plan approval and evidence references.

- [ ] **Step 2: Write rework tests**

Assert initial implementation plus 3 rework attempts are allowed; the next failure enters `awaiting_user`.

- [ ] **Step 3: Implement Zod result parsing**

Validate final output, but derive changed files and command evidence independently. One format-repair call is allowed; a second parse failure enters `awaiting_user`.

- [ ] **Step 4: Implement command execution from pure state-machine effects**

Persist intent, execute via adapter, persist result, then feed a new event into the reducer. Never execute an effect directly inside the pure transition function.

- [ ] **Step 5: Implement startup reconcile**

Inspect pending actions, last run attempt, lock lease, baseline manifest, and message delivery state. Do not automatically repeat unknown non-idempotent work.

- [ ] **Step 6: Verify Phase 1**

Run: `npm.cmd test`

Expected: all fake-adapter workflow, persistence, lock, baseline, and logging tests PASS.

## Phase 2: Safety gates, Worker isolation, and Windows process supervision

### Task 9: Implement ProjectGuard and approval policy

**Files:**
- Create: `src/guard/project-guard.ts`
- Create: `src/guard/approval-policy.ts`
- Create: `src/guard/command-classifier.ts`
- Create: `src/guard/path-policy.ts`
- Create: `src/guard/adapter-permission-profile.ts`
- Create: `src/guard/patch-validator.ts`
- Create: `src/guard/patch-applier.ts`
- Create: `tests/unit/guard/path-policy.test.ts`
- Create: `tests/unit/guard/command-classifier.test.ts`
- Create: `tests/integration/guard/project-guard.test.ts`
- Create: `tests/integration/guard/patch-applier.test.ts`

- [ ] **Step 1: Write failing path-escape tests**

Cover absolute paths outside the project, `..`, alternate drive letters, UNC, device paths, symlink/junction escape, case changes, project-internal reparse points, and a command whose declared cwd is inside but whose argument targets outside.

- [ ] **Step 2: Write failing command-policy tests**

Classify operations as:

- `auto_allowed`: direct project file edits and a small allowlist of proven read-only/verification commands;
- `requires_confirmation`: arbitrary PowerShell/cmd, dependency installation, package lifecycle scripts, networked commands, generated scripts, and unknown commands;
- `denied`: explicit outside-project writes, destructive Git commands, privilege escalation, or Adapter capability downgrade.

- [ ] **Step 3: Implement canonical path checks**

Resolve every path-bearing request through the Task 4 canonicalizer. Reparse points that resolve outside the project are denied. Unknown path provenance is never `auto_allowed`.

- [ ] **Step 4: Implement role-specific Adapter permission profiles**

- Implementer: project-write only when the exact Adapter/version has a verified enforceable profile.
- Reviewer/master: read-only tools or immutable review bundle.
- If an Adapter cannot objectively constrain file writes, run the implementer in read-only `patch mode`: it returns a unified diff, ProjectGuard validates every path/hunk against the attempt baseline, and TriAgent applies the patch itself.
- If an Adapter cannot expose pre-command approval events, remove Shell/Bash tools in automatic mode. The Agent returns requested commands as structured data; TriAgent classifies and runs only allowlisted commands, while other commands require TUI confirmation.
- If neither direct-write nor read-only patch mode can be proven, disable that Adapter for the implementer role.

- [ ] **Step 5: Integrate ProjectGuard before all side effects**

The orchestrator must obtain a `GuardDecision` before starting an Adapter, delivering a tool/command request, applying a generated patch/file operation, or running verification. Persist the decision and user confirmation with the pending action. Patch application must reject absolute paths, traversal, binary patch formats not explicitly supported, baseline mismatches, reparse-point targets, and edits outside the canonical root.

- [ ] **Step 6: Verify**

Run: `npm.cmd test -- tests/unit/guard tests/integration/guard`

Expected: every unknown/escaping operation fails closed and no fake process is launched.

### Task 10: Implement persisted runtime and call budgets

**Files:**
- Create: `src/budget/budget-controller.ts`
- Create: `src/budget/budget-clock.ts`
- Create: `src/budget/budget-repository.ts`
- Create: `tests/unit/budget/budget-controller.test.ts`
- Create: `tests/integration/budget/budget-recovery.test.ts`

- [ ] **Step 1: Write fake-clock tests**

Cover total active runtime, per-attempt timeout, maximum external call count, paused time exclusion, `awaiting_user` time exclusion, restart continuation, and budget exhaustion during a run.

- [ ] **Step 2: Implement persisted counters**

Store active-run intervals and external call reservations in SQLite. Reserve a call before launch; release only if launch never occurred. A process start consumes the call even if it crashes.

- [ ] **Step 3: Integrate timeout cleanup**

On per-attempt or total-budget exhaustion, persist stop intent and call `ProcessSupervisorPort`. Task 10 tests use the deterministic fake and assert the correct cleanup intent/order; Task 12 later proves the same port against a real Job Object. Never start a new Adapter call after budget exhaustion.

- [ ] **Step 4: Verify**

Run: `npm.cmd test -- tests/unit/budget tests/integration/budget`

Expected: PASS with deterministic fake time and restart behavior.

### Task 11: Run every Adapter inside an independent Node Worker

**Files:**
- Create: `src/workers/worker-protocol.ts`
- Create: `src/workers/agent-worker.ts`
- Create: `src/workers/agent-worker-manager.ts`
- Create: `src/workers/worker-heartbeat.ts`
- Create: `tests/integration/workers/worker-isolation.test.ts`
- Create: `tests/fixtures/workers/crashing-parser.mjs`

- [ ] **Step 1: Write a worker-crash test**

Crash the parser Worker while the TUI/application process and SQLite writer remain alive. Assert the run attempt is marked failed, raw output is retained, and the task moves to a recoverable state.

- [ ] **Step 2: Define typed IPC**

Messages include `start_run`, `stop_run`, `deliver_message`, `event`, `heartbeat`, `run_exited`, and `worker_failed`. Validate every IPC message with Zod and enforce maximum message size.

- [ ] **Step 3: Isolate parsing and output pressure**

The Worker owns Adapter parsing and `ProcessSupervisorPort` communication. Task 11 injects the deterministic fake; Task 12 binds the same port to ProcessHost. The main process receives normalized, rate-limited events. Backpressure must drop/display-truncate low-priority partial output without dropping terminal/run-state events.

- [ ] **Step 4: Implement heartbeat and replacement**

Persist Worker failure; never silently restart an active non-idempotent run. A fresh Worker may be created only after reconcile chooses a safe next action.

- [ ] **Step 5: Verify**

Run: `npm.cmd test -- tests/integration/workers/worker-isolation.test.ts`

Expected: the main application remains alive after parser/Worker failure.

### Task 12: Prove and implement Windows Job Object supervision

**Files:**
- Create: `native/TriAgent.ProcessHost/TriAgent.ProcessHost.csproj`
- Create: `native/TriAgent.ProcessHost/Program.cs`
- Create: `native/TriAgent.ProcessHost/WindowsJob.cs`
- Create: `native/TriAgent.ProcessHost/Protocol.cs`
- Create: `src/process/process-host-client.ts`
- Create: `src/process/process-supervisor.ts`
- Create: `tests/fixtures/process-tree/parent.mjs`
- Create: `tests/fixtures/process-tree/child.mjs`
- Create: `tests/integration/process/windows-job-object.test.ts`
- Create: `tests/integration/process/budget-worker-processhost.test.ts`

- [ ] **Step 1: Write a failing descendant cleanup test**

The fixture spawns a child and grandchild that remain alive. Start it through ProcessHost, request force stop, then verify all recorded PIDs are gone. Also crash ProcessHost, close its stdin unexpectedly, and run ProcessHost while its own parent is already in a Windows Job. Every case must either prove target-tree cleanup or fail closed before starting the target.

- [ ] **Step 2: Implement the ProcessHost protocol**

Use JSONL over stdin/stdout:

```json
{"type":"start","attemptId":"...","command":"...","args":[],"cwd":"...","env":{}}
{"type":"stop","mode":"graceful","graceMs":5000}
{"type":"stop","mode":"force"}
```

Events include `started`, `stdout`, `stderr`, `exited`, `tree_clean`, and `cleanup_failed`.

- [ ] **Step 3: Create the target suspended and assign it before execution**

ProcessHost must not join the target Job. It owns the Job's only lifetime handle, and that Job handle must be non-inheritable. Set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, call Win32 `CreateProcessW` with `CREATE_SUSPENDED`, assign the target process handle with `AssignProcessToJobObject`, then call `ResumeThread`.

Use `STARTUPINFOEX` plus `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` so the target inherits only its intended stdin/stdout/stderr handles. The Job handle, control handles, and unrelated ProcessHost handles must not be inheritable. If create, assign, handle-list setup, or resume fails, terminate the suspended process and emit `start_failed`; never run it outside the Job.

If ProcessHost itself is already inside a parent Job, test nested-job behavior on supported Windows versions. An unsupported or denied assignment must disable real execution rather than fall back to an unmanaged child.

- [ ] **Step 4: Relay output safely**

Use redirected stdout/stderr and base64 or escaped JSON payloads so arbitrary CLI output cannot corrupt the control protocol. Because ProcessHost is outside the target Job, it remains alive to wait for the Job to become empty and emit `tree_clean` or `cleanup_failed`.

When ProcessHost itself crashes, the Node Worker detects helper exit, uses the persisted PID/start-time identities only to verify cleanup, and enters `cleanup_failed` if any target remains or identity cannot be proven. It must not kill an unverified reused PID.

- [ ] **Step 5: Publish a self-contained helper**

Run:

```powershell
dotnet publish native\TriAgent.ProcessHost\TriAgent.ProcessHost.csproj `
  -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true
```

Copy the executable during `npm run build:native` to `dist/native/win-x64/triagent-process-host.exe`.

- [ ] **Step 6: Enforce the technical gate**

Run: `npm.cmd test -- tests/integration/process/windows-job-object.test.ts tests/integration/process/budget-worker-processhost.test.ts`

Expected: PASS with helper, child, and grandchild confirmed exited; helper crash triggers cleanup because no target inherited the Job handle; BudgetController -> Worker -> real ProcessHost uses the same supervision port and cleans the full tree.

If this test cannot be made reliable, stop implementation and report that the approved forced-termination requirement is blocked. Do not substitute `taskkill` and claim completion.

### Task 13: Implement CLI capability probes

**Files:**
- Create: `src/agents/health/command-probe.ts`
- Create: `src/agents/health/codex-health.ts`
- Create: `src/agents/health/claude-health.ts`
- Create: `src/agents/health/grok-health.ts`
- Create: `src/agents/compatibility-matrix.ts`
- Create: `tests/integration/agents/health.test.ts`

- [ ] **Step 1: Write fixture-driven health parser tests**

Test installed, missing, logged out, timed out, malformed output, unsupported version, and current known versions:

- Codex CLI `0.144.1`;
- Claude Code `2.1.206`;
- Grok CLI `0.2.93`.

- [ ] **Step 2: Implement no-write probes**

- Codex: `codex --version`, `codex login status`.
- Claude: `claude --version`, `claude auth status`.
- Grok: `grok --version`, `grok inspect --json`; if authentication cannot be proven without a model call, report `auth=unknown` and require an explicit lightweight readiness probe before task start.

- [ ] **Step 3: Build a capability matrix**

Record support for JSONL, output schema, session ID, resume, real-time input, read-only mode, project-write mode, max budget/turns, and non-Git operation. Unknown means disabled.

The matrix key is exact CLI name + parsed version + platform. Command builders accept a verified capability record; they may not infer flags from product name alone. ProjectGuard and BudgetController must approve the run before a Worker can receive `start_run`.

- [ ] **Step 4: Verify**

Run: `npm.cmd test -- tests/integration/agents/health.test.ts`

Expected: PASS without modifying the current project.

### Task 14: Implement the Codex adapter

**Files:**
- Create: `src/agents/codex/codex-command.ts`
- Create: `src/agents/codex/codex-events.ts`
- Create: `src/agents/codex/codex-adapter.ts`
- Create: `tests/unit/agents/codex-command.test.ts`
- Create: `tests/integration/agents/codex-parser.test.ts`

- [ ] **Step 1: Write exact command-builder tests**

For the verified Codex `0.144.1` contract, the implementation command must include:

```text
codex exec -C <project> -s workspace-write -a never --json --output-schema <schema> -
```

For non-Git projects add `--skip-git-repo-check`. Reviewer/master commands use `-s read-only -a never`. Never add `--dangerously-bypass-approvals-and-sandbox`.

If the exact version lacks any required capability, return `AdapterDisabled` instead of generating an approximate command. Every generated command must include the ProjectGuard decision ID and reserved budget attempt in its persisted run intent.

When ProjectGuard selects read-only patch mode, use `-s read-only`, require the patch in structured output, and let `PatchApplier` perform the only write.

- [ ] **Step 2: Write recorded JSONL parser tests**

Use sanitized fixtures; do not call the real model in unit tests. Parser output must map to normalized `AgentEvent` values and retain unknown events as raw records.

- [ ] **Step 3: Implement start and resume**

Resume must reapply cwd, sandbox, approval, schema, non-Git, and budget constraints. For the verified contract build it with global options before `exec resume`:

```text
codex -C <project> -s <workspace-write|read-only> -a never exec resume <conversation-id> --json --output-schema <schema> -
```

Add `--skip-git-repo-check` for non-Git projects where supported. Do not use `--ephemeral` when resumability is required. Tests must compare start and resume permission profiles and fail if resume is weaker.

- [ ] **Step 4: Add an opt-in live smoke test**

Guard with `TRIAGENT_REAL_AI_TESTS=1`. The prompt must request a no-write structured response in a temporary directory.

- [ ] **Step 5: Verify**

Run: `npm.cmd test -- tests/unit/agents/codex-command.test.ts tests/integration/agents/codex-parser.test.ts`

Expected: PASS without an API call.

### Task 15: Implement the Claude adapter

**Files:**
- Create: `src/agents/claude/claude-command.ts`
- Create: `src/agents/claude/claude-events.ts`
- Create: `src/agents/claude/claude-adapter.ts`
- Create: `tests/unit/agents/claude-command.test.ts`
- Create: `tests/integration/agents/claude-parser.test.ts`

- [ ] **Step 1: Write command-builder tests**

Only for an exact Claude version whose capability probe has passed, implementation uses non-interactive streaming output, a fixed UUID, structured schema, and the adapter-verified permission profile:

```text
claude -p --output-format stream-json --session-id <uuid> --json-schema <schema> --permission-mode auto <prompt>
```

Reviewer/master must not receive Edit/Write/Bash tools. Start with `--tools Read,Glob,Grep` and verify actual tool names against `claude --help`/runtime capability tests before enabling. If the read-only contract cannot be proven, run review against an immutable review bundle instead of the live project.

Project-write automatic mode remains disabled if ProjectGuard cannot prove the allowed tool profile. In that case use file-only tools with explicit per-task opt-in or require TUI confirmation for the affected operation.

Preferred fallback is read-only patch mode with `Read,Glob,Grep` only; Claude returns a unified diff and requested verification commands instead of editing or invoking Bash.

- [ ] **Step 2: Test event parsing and partial lines**

Support `--include-partial-messages` only after rate-limit and log-volume tests pass; it is not required for the first real adapter milestone.

- [ ] **Step 3: Implement resume**

Use `claude -p --resume <conversation-id> ...` only through the versioned command builder. Reattach `--output-format`, schema, permission mode, allowed/disallowed tools, budget, project directory context, and ProjectGuard profile. If a killed turn was not persisted, create a new conversation and inject persisted context rather than pretending resume succeeded. Tests must prove start/resume permission equivalence.

- [ ] **Step 4: Add opt-in live smoke test and verify**

Run parser/command tests by default; run real call only with `TRIAGENT_REAL_AI_TESTS=1`.

### Task 16: Implement the Grok adapter

**Files:**
- Create: `src/agents/grok/grok-command.ts`
- Create: `src/agents/grok/grok-events.ts`
- Create: `src/agents/grok/grok-adapter.ts`
- Create: `tests/unit/agents/grok-command.test.ts`
- Create: `tests/integration/agents/grok-parser.test.ts`

- [ ] **Step 1: Write command-builder tests**

For an exact Grok version whose capability probe passes, the implementation command baseline is:

```text
grok --cwd <project> --single <prompt> --output-format streaming-json --session-id <uuid> --permission-mode auto
```

Use `--max-turns` for adapter-observable limits. Do not enable `--always-approve` until compatibility tests prove the project guardrails; never equate it with an OS sandbox.

If `streaming-json`, session IDs, permission mode, tool filtering, or max-turns are unknown for the exact version, disable that feature rather than emitting the baseline command.

Preferred fallback is read-only patch mode with write and shell tools removed; Grok returns a unified diff and requested verification commands for ProjectGuard mediation.

- [ ] **Step 2: Prove a read-only review mode**

Test `--permission-mode plan` and tool allow/deny flags against a disposable project. The test must fail if any file hash changes. If no reliable read-only mode exists, supply an immutable review bundle and no project write access.

- [ ] **Step 3: Implement resume and parser**

Use the versioned builder for `grok --cwd <project> --resume <conversation-id> --single <prompt> --output-format streaming-json`, reattaching permission mode, tool allow/deny rules, `--max-turns`, sandbox profile, and ProjectGuard decision. Preserve unknown JSON events. Tests must fail if resume drops any security or budget argument.

- [ ] **Step 4: Add opt-in live smoke test and verify**

Default tests use fixtures; real AI tests require `TRIAGENT_REAL_AI_TESTS=1`.

## Phase 3: Review, rework, controls, and recovery

### Task 17: Build prompt bundles and read-only review evidence

**Files:**
- Create: `src/protocol/prompt-builder.ts`
- Create: `src/protocol/review-bundle.ts`
- Create: `src/review/reviewer-runner.ts`
- Create: `src/review/master-validator.ts`
- Create: `tests/unit/protocol/prompt-builder.test.ts`
- Create: `tests/integration/review/read-only-review.test.ts`

- [ ] **Step 1: Write prompt snapshot tests**

Every prompt includes role, original requirement, requirement version, approved plan, acceptance criteria, canonical project root, allowed/forbidden actions, attempt number, prior findings, and final schema.

- [ ] **Step 2: Build immutable review bundles**

Bundle the requirement, plan, task-start baseline ID, attempt baseline ID, fixed diff, relevant file content hashes, command evidence, and verification logs. Hash the bundle and attach the hash to the review record.

- [ ] **Step 3: Enforce reviewer/master read-only behavior**

Capture a hash baseline before review and recompute afterward. Any write invalidates the review. Commands that generate caches or build output run separately in a controlled verification copy.

- [ ] **Step 4: Require evidence for master approval**

Master cannot return `approved` unless file diff, command exit codes, review result, and current baseline hash are present and consistent.

- [ ] **Step 5: Verify**

Run: `npm.cmd test -- tests/unit/protocol tests/integration/review`

Expected: PASS, including a malicious fake reviewer attempting a write.

### Task 18: Implement rework, queued messages, pause-after-run, and interruption

**Files:**
- Create: `src/workflow/rework-service.ts`
- Create: `src/workflow/message-queue.ts`
- Create: `src/workflow/pause-controller.ts`
- Create: `src/workflow/interruption-service.ts`
- Create: `tests/integration/workflow/messages.test.ts`
- Create: `tests/integration/workflow/pause-interrupt.test.ts`

- [ ] **Step 1: Write message lifecycle tests**

Verify `queued -> delivered -> acknowledged -> applied` and failure states. Unsupported real-time input stays queued until a safe point.

- [ ] **Step 2: Implement requirement versioning**

A message that changes scope, plan, or acceptance criteria creates a new requirement version, returns to planning, and invalidates old reviews.

- [ ] **Step 3: Implement pause-after-run**

Persist the completed attempt's normal successor as `resume_target_state`. The TUI must continue to show that the current process is running until it actually exits.

- [ ] **Step 4: Implement interruption cleanup**

Persist stop intent, request cooperative stop, wait grace period, force-close the Job, verify tree cleanup, rescan files, then enter `interrupted_needs_inspection`. Cleanup failure blocks TUI exit.

- [ ] **Step 5: Verify**

Run: `npm.cmd test -- tests/integration/workflow/messages.test.ts tests/integration/workflow/pause-interrupt.test.ts`

Expected: PASS.

## Phase 4: TUI and non-Git projects

### Task 19: Implement the Ink application shell and task screens

**Files:**
- Create: `src/tui/App.tsx`
- Create: `src/tui/store.ts`
- Create: `src/tui/screens/HealthScreen.tsx`
- Create: `src/tui/screens/ProjectScreen.tsx`
- Create: `src/tui/screens/NewTaskScreen.tsx`
- Create: `src/tui/screens/PlanApprovalScreen.tsx`
- Create: `src/tui/screens/RunScreen.tsx`
- Create: `src/tui/screens/DiffScreen.tsx`
- Create: `src/tui/screens/ReviewScreen.tsx`
- Create: `src/tui/screens/HistoryScreen.tsx`
- Create: `src/tui/components/WorkflowPanel.tsx`
- Create: `src/tui/components/LogPanel.tsx`
- Create: `src/tui/components/StatusBar.tsx`
- Create: `src/tui/hooks/useKeyboard.ts`
- Create: `tests/unit/tui/run-screen.test.tsx`
- Create: `tests/unit/tui/keyboard.test.tsx`

- [ ] **Step 1: Write Ink rendering tests**

Use `ink-testing-library` and `lastFrame()` to verify role labels, workflow status, running-process indicator, retry count, and narrow-terminal single-panel mode.

- [ ] **Step 2: Implement full-screen rendering**

Use Ink `render(..., {alternateScreen: true})`, `useInput`, `useWindowSize`, and `useApp`. Never call `process.exit()` directly from a key handler while a run is active.

- [ ] **Step 3: Implement keyboard semantics**

- `P`: pause-after-run menu.
- `M`: queue a message.
- `D`: diff screen.
- `Tab`: Agent log tab.
- `R`: manual rework where legal.
- `A`: approve only where legal.
- `Q`: cancel confirmation.
- `Ctrl+C`: first opens control menu; second opens termination confirmation, never bypasses cleanup.

- [ ] **Step 4: Wire screens to application services**

UI components dispatch typed intents; they do not execute CLI commands or SQL directly.

- [ ] **Step 5: Verify**

Run: `npm.cmd test -- tests/unit/tui`

Expected: PASS.

### Task 20: Add non-Git snapshots and Chokidar monitoring

**Files:**
- Create: `src/tracking/non-git-baseline-service.ts`
- Create: `src/tracking/file-watcher.ts`
- Create: `src/tracking/ignore-policy.ts`
- Create: `tests/integration/tracking/non-git-baseline.test.ts`
- Create: `tests/integration/tracking/file-watcher.test.ts`

- [ ] **Step 1: Write snapshot tests**

Cover normal files, large files, binary content, rename, deletion, `node_modules`, build output, reparse points, and a file changing during snapshot creation.

- [ ] **Step 2: Implement Chokidar 5 watcher**

Use ESM import, `followSymlinks: false`, `atomic: true`, `awaitWriteFinish`, and await `watcher.close()`. Treat events as UI hints only.

- [ ] **Step 3: Implement snapshot completeness**

Save metadata even when content is excluded. If a file changes while its baseline is being captured, retry or mark the baseline invalid; never silently accept a torn snapshot.

- [ ] **Step 4: Detect only safe-window changes**

During an active attempt, all writes remain unattributed task-window changes. After the attempt baseline is fixed, a new change invalidates review and enters `awaiting_user`.

- [ ] **Step 5: Verify**

Run: `npm.cmd test -- tests/integration/tracking/non-git-baseline.test.ts tests/integration/tracking/file-watcher.test.ts`

Expected: PASS.

### Task 21: Compose the application, history, recovery, and settings

**Files:**
- Modify: `src/cli/main.tsx`
- Create: `src/app/app-context.ts`
- Create: `src/app/lifecycle-coordinator.ts`
- Create: `src/app/startup-reconcile.ts`
- Create: `src/tui/screens/RecoveryScreen.tsx`
- Create: `src/tui/screens/SettingsScreen.tsx`
- Create: `src/config/app-paths.ts`
- Create: `src/config/settings.ts`
- Create: `tests/integration/app/startup-reconcile.test.ts`
- Create: `tests/integration/app/application-lifecycle.test.ts`
- Create: `tests/unit/tui/recovery-screen.test.tsx`

- [ ] **Step 1: Write startup and shutdown integration tests**

Assert the entry composition order: resolve app paths -> open/diagnose database -> construct repositories -> ProjectGuard -> BudgetController -> ProcessHost/Worker managers -> capability probes -> startup reconcile -> Ink render. On shutdown, stop accepting intents, reconcile active runs, clean all Job Objects, flush JSONL, close Workers/watchers/database, then exit.

The corrupted-database case must render diagnostic mode and prove that no Worker, Adapter, project lock, or ProcessHost starts.

- [ ] **Step 2: Implement `%LOCALAPPDATA%\TriAgent` paths**

Store the database, JSONL logs, snapshots, and native helper diagnostics outside projects. Do not store credentials.

- [ ] **Step 3: Implement `AppContext` and lifecycle coordinator**

`AppContext` owns constructed services and exposes typed application commands. `src/cli/main.tsx` parses `--help`/diagnostic options, builds the context, runs startup reconcile, renders the TUI, and delegates all exit requests to `LifecycleCoordinator`. No screen imports database or Adapter implementations directly.

- [ ] **Step 4: Implement startup reconcile UI**

Show each incomplete task and the evidence found: pending action, process identity, lock, baseline, messages, and allowed next actions. Never auto-resume an unknown non-idempotent attempt.

- [ ] **Step 5: Implement settings**

Include CLI paths, total running budget (default 60 minutes), per-attempt timeout, maximum external calls, 3 rework limit, log retention, and real-AI-test opt-in.

- [ ] **Step 6: Verify**

Run: `npm.cmd test -- tests/integration/app/startup-reconcile.test.ts tests/integration/app/application-lifecycle.test.ts tests/unit/tui/recovery-screen.test.tsx`

Expected: PASS.

## Phase 5: Packaging and full verification

### Task 22: Package the native helper and global CLI

**Files:**
- Modify: `package.json`
- Modify: `tsup.config.ts`
- Create: `scripts/build-native.ps1`
- Create: `scripts/copy-native.mjs`
- Create: `tests/e2e/package-install.test.ts`
- Create: `README.md`

- [ ] **Step 1: Add build scripts**

```json
{
  "scripts": {
    "build:native": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-native.ps1",
    "build:node": "tsup",
    "build": "npm run build:native && npm run build:node && node scripts/copy-native.mjs",
    "prepack": "npm run test && npm run typecheck && npm run build"
  },
  "files": ["dist", "schemas", "README.md"]
}
```

- [ ] **Step 2: Add runtime helper discovery**

Resolve `dist/native/win-x64/triagent-process-host.exe`; verify checksum and executable presence before enabling real runs.

- [ ] **Step 3: Test npm packaging**

Run: `npm.cmd pack`

Expected: tarball contains `dist/cli.js`, schemas, README, and the Windows helper, but not tests, source logs, or local databases.

- [ ] **Step 4: Test global install from the tarball**

In an isolated temporary npm prefix:

```powershell
npm.cmd install -g .\triagent-orchestrator-0.1.0.tgz --prefix <temp-prefix>
& <temp-prefix>\triagent.cmd --help
```

Expected: command opens help/health mode and exits `0` without starting an AI call.

- [ ] **Step 5: Write user documentation**

Document prerequisites, existing CLI login requirement, best-effort guardrails, no-detach rule, Git/non-Git behavior, role selection, recovery, log location, and opt-in real AI tests.

### Task 23: Run the full acceptance suite

**Files:**
- Create: `tests/e2e/fake-full-workflow.test.ts`
- Create: `tests/e2e/real-cli-smoke.test.ts`
- Create: `docs/verification/acceptance-checklist.md`

- [ ] **Step 1: Run static and automated checks**

Run this acceptance matrix on Node 24.x, which is the minimum supported major and matches `@types/node` 24:

Run:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd pack --dry-run
```

Expected: all commands exit `0` on Node 24.x. A newer Node run may be added, but cannot replace the Node 24 minimum-version run.

- [ ] **Step 2: Run fake full workflow E2E**

Exercise project selection, role selection, plan approval, implementation, reviewer rejection, one rework, master approval, logs, diff, SQLite history, and clean exit.

- [ ] **Step 3: Run crash and process cleanup E2E**

Kill the TUI during a fake run, restart, reconcile, clean the Job Object process tree, inspect changes, and cancel or continue without duplicate side effects.

- [ ] **Step 4: Run opt-in real CLI smoke tests**

Only after explicit user approval because these calls can consume account/API quota:

```powershell
$env:TRIAGENT_REAL_AI_TESTS='1'
npm.cmd test -- tests/e2e/real-cli-smoke.test.ts
```

Use a disposable temporary Git repository. Each real Agent receives a no-network, no-write or tightly bounded test task first. Do not run against the TriAgent source repository.

- [ ] **Step 5: Perform the real closed-loop acceptance task**

After smoke tests pass, run one disposable project through:

```text
master plan
-> implementer change
-> reviewer finds seeded defect
-> implementer rework
-> reviewer pass
-> master pass
```

Record CLI versions, exact commands, task IDs, exit codes, diff hashes, test results, process-tree cleanup evidence, and known capability degradations in `docs/verification/acceptance-checklist.md`.

- [ ] **Step 6: Final verification rule**

Do not claim the product complete if any of these remain unverified:

- ProjectGuard fail-closed behavior for path escapes, arbitrary shell, dependency installs, and capability downgrade;
- persisted runtime/call budget enforcement across restart;
- independent Worker crash isolation;
- Windows Job Object descendant cleanup;
- reviewer/master read-only behavior for all enabled adapters;
- dirty Git baseline preservation;
- crash reconcile without duplicate side effects;
- corrupted SQLite diagnostic mode with all side effects disabled;
- 3-rework limit;
- global `triagent` installation and startup.

---

## Implementation checkpoints

- After Task 8: fake end-to-end workflow works with no real AI calls.
- After Task 11: ProjectGuard, budgets, and Worker isolation pass before any real AI call.
- After Task 12: Windows process cleanup safety gate passes.
- After Task 16: three real adapters pass version-gated offline contract tests.
- After Task 18: review/rework/control loop works with fake adapters.
- After Task 21: complete TUI, history, Git and non-Git behavior works through the real application entry point.
- After Task 23: packaged application passes the approved acceptance criteria.

## Documentation references to consult during implementation

- Ink 7: `render(..., {alternateScreen: true})`, `useInput`, `useWindowSize`, `useApp`, and `ink-testing-library`.
- Node.js 24 `node:sqlite`: `DatabaseSync`, prepared statements, defensive mode, WAL and explicit transactions.
- Chokidar 5: ESM API, `followSymlinks: false`, `awaitWriteFinish`, `ready`, and awaited `close()`.
- Current local CLI help must remain the source of truth for Codex, Claude, and Grok command flags; compatibility tests must fail closed when versions drift.
