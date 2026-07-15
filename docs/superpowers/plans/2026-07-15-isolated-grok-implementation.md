# Isolated Grok Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude planning, Grok implementation, and Codex review the working default by letting Grok edit a durable isolated candidate workspace and promoting only the reviewed candidate through PatchApplier.

**Architecture:** Materialize the task baseline into an app-owned candidate workspace, authorize Grok to write only that workspace with no shell-capable tools, persist a deterministic candidate change set, route Codex and Claude validation to immutable/read-only candidate evidence, and promote through the existing patch validation and rollback path only when the canonical project has not drifted.

**Tech Stack:** TypeScript, Node.js 24, node:sqlite, Vitest, Ink, existing BaselineTracker/DiffService/ReviewBundle/PatchApplier, Windows ProcessHost.

**Execution constraint:** Inline execution in the existing `feature/triagent-implementation` worktree. Do not commit, reset, checkout, clean, or overwrite unrelated untracked files.

---

## File map

**Create**

- `src/persistence/migrations/007_implementation_workspaces.sql` — durable workspace lifecycle and authorization data.
- `src/workspace/implementation-workspace-types.ts` — workspace records, scopes, references, and candidate change-set schema.
- `src/workspace/implementation-workspace-repository.ts` — strict SQLite persistence and state transitions.
- `src/workspace/implementation-workspace-service.ts` — baseline materialization, authorization, integrity, retention, and cleanup.
- `src/workspace/workspace-change-set.ts` — deterministic candidate scan/diff/hash and PatchApplier patch conversion.
- `src/workspace/workspace-promotion-service.ts` — global canonical drift check and PatchApplier promotion.
- `tests/integration/workspace/implementation-workspace-service.test.ts`.
- `tests/integration/workspace/workspace-change-set.test.ts`.
- `tests/integration/workspace/workspace-promotion.test.ts`.
- `tests/integration/workflow/isolated-grok-workflow.test.ts`.

**Modify**

- `src/config/app-paths.ts` — add implementation workspace root.
- `src/tui/store.ts` — requested default role assignment.
- `src/guard/adapter-permission-profile.ts`, `src/guard/project-guard.ts` — explicit execution scope.
- `src/app/safe-agent-launch-coordinator.ts` — workspace-issued authorization and guarded execution root.
- `src/agents/agent-adapter.ts` — carry execution root/scope/workspace authorization.
- `src/agents/grok/grok-command.ts`, `src/agents/grok/grok-adapter.ts` — isolated implementation command profile.
- `src/app/production-task-runtime.ts` — construct and inject workspace services.
- `src/workflow/transitions.ts`, `src/workflow/workflow-engine.ts`, `src/workflow/states.ts`, `src/workflow/task-orchestrator.ts`, `src/workflow/workflow-journal.ts` — durable prepare/candidate/review/validate/promote effects.
- `src/app/startup-reconcile.ts`, `src/app/restart-recovery-service.ts` — workspace recovery and cleanup.
- `src/protocol/review-bundle.ts`, `src/review/reviewer-runner.ts` — candidate change-set evidence and candidate-root validation.
- Existing tests under `tests/unit/tui`, `tests/unit/agents`, `tests/integration/app`, `tests/integration/guard`, `tests/integration/workflow`, and `tests/e2e`.

---

### Task 1: Make Claude/Grok/Codex the persisted default

**Files:**
- Modify: `src/tui/store.ts:175-184`
- Test: `tests/unit/tui/keyboard.test.tsx`
- Test: `tests/e2e/fake-full-workflow.test.ts`

- [x] **Step 1: Write the failing default-role tests**

Assert a fresh snapshot and the first submitted `CREATE_TASK` intent contain:

```ts
{ master: 'claude', implementer: 'grok', reviewer: 'codex' }
```

- [x] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/unit/tui/keyboard.test.tsx tests/e2e/fake-full-workflow.test.ts`

Expected: assertions receive the current Codex/Claude/Grok default.

- [x] **Step 3: Reorder the role assignment list minimally**

Move the approved assignment to index 0; retain all other selectable permutations.

- [x] **Step 4: Verify GREEN**

Run the same command; expected all selected tests pass.

---

### Task 2: Persist workspace identity and expose an app-owned root

**Files:**
- Create: `src/persistence/migrations/007_implementation_workspaces.sql`
- Create: `src/workspace/implementation-workspace-types.ts`
- Create: `src/workspace/implementation-workspace-repository.ts`
- Modify: `src/config/app-paths.ts`
- Test: `tests/integration/workspace/implementation-workspace-service.test.ts`
- Test: `tests/e2e/package-install.test.ts`

- [x] **Step 1: Write failing migration/path/repository tests**

Cover:

- `implementationWorkspacesDirectory` resolves below app root;
- migration creates `implementation_workspaces` with unique task/attempt identity;
- repository accepts only legal state transitions;
- workspace ids and authorizations cannot be reused across task/attempt;
- timestamps and hashes are validated on read.

Use a strict record shape equivalent to:

```ts
interface ImplementationWorkspaceRecord {
  workspaceId: string;
  taskId: string;
  attemptId: string;
  sourceBaselineId: string;
  sourceManifestHash: string;
  workspaceRoot: string;
  candidateManifestHash: string | null;
  changeSetHash: string | null;
  status: WorkspaceStatus;
  authorizationConsumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [x] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/integration/workspace/implementation-workspace-service.test.ts tests/e2e/package-install.test.ts`

Expected: missing module/path/migration failures.

- [x] **Step 3: Add migration, types, strict repository, and app path**

Use parameterized SQL, exact status validation, canonical absolute roots, and no project-controlled path lookup.

- [x] **Step 4: Verify GREEN**

Run the same tests; inspect migration packaging assertions.

---

### Task 3: Materialize an independent candidate from the task baseline

**Files:**
- Create/Modify: `src/workspace/implementation-workspace-service.ts`
- Modify: `src/workspace/implementation-workspace-types.ts`
- Test: `tests/integration/workspace/implementation-workspace-service.test.ts`
- Reference: `src/tracking/tracking-port.ts`, `src/tracking/baseline-manifest.ts`, `src/guard/path-policy.ts`

- [x] **Step 1: Write failing materialization tests**

Required cases:

- dirty and untracked baseline entries appear with exact bytes;
- source and destination file ids are independent and destination `nlink === 1`;
- `.git`, `.worktrees`, `node_modules`, caches, and TriAgent-owned paths are absent;
- baseline-included ignored/generated files are preserved;
- nested repository markers fail deterministically;
- secret/content-policy-protected paths are absent and cannot be recreated or changed;
- project-local TriAgent state and app-root aliases are excluded and protected;
- external/safe-internal reparse entries fail with the specified reason;
- content-excluded regular file copies only after current hash matches baseline;
- incomplete materialization cannot become `ready`;
- manifest hash and persisted workspace root are deterministic.

- [x] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/integration/workspace/implementation-workspace-service.test.ts`

Expected: service/API missing.

- [x] **Step 3: Implement minimal baseline materializer**

Materialize under `implementation-workspaces/<task>/<attempt>/project`, write exclusively, reject unsafe entries, rescan, hash, persist `ready`, and remove incomplete roots on failure.

- [x] **Step 4: Verify GREEN**

Run the same test file; expected all materialization cases pass.

---

### Task 4: Add execution scopes and single-use workspace authorization

**Files:**
- Modify: `src/guard/adapter-permission-profile.ts`
- Modify: `src/guard/project-guard.ts`
- Modify: `src/app/safe-agent-launch-coordinator.ts`
- Modify: `src/agents/agent-adapter.ts`
- Modify: `src/workspace/implementation-workspace-repository.ts`
- Test: `tests/integration/app/safe-agent-launch-coordinator.test.ts`
- Test: `tests/integration/workspace/implementation-workspace-service.test.ts`

- [ ] **Step 1: Write failing guard/authorization tests**

Assert:

- Grok implementer remains disabled for `live_project`;
- valid matching `isolated_implementation` authorization yields candidate `workspace-write`;
- cross-task, cross-attempt, wrong root, wrong manifest, expired, consumed, and terminal references fail;
- authorization consumption is atomic and single-use;
- launch request original/candidate root confusion is rejected.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/integration/app/safe-agent-launch-coordinator.test.ts tests/integration/workspace/implementation-workspace-service.test.ts`

- [ ] **Step 3: Implement scope-aware evaluation and atomic consume**

Add `ExecutionScope = 'live_project' | 'isolated_implementation' | 'immutable_review_bundle'`. Do not modify Grok's compatibility record to claim live-project write support.

- [ ] **Step 4: Verify GREEN**

Run the same command; expected all scope/identity tests pass.

---

### Task 5: Build Grok's isolated implementation command profile

**Files:**
- Modify: `src/agents/grok/grok-command.ts`
- Modify: `src/agents/grok/grok-adapter.ts`
- Modify: `src/agents/compatibility-probe-manifests.ts`
- Test: `tests/unit/agents/grok-command.test.ts`
- Test: `tests/integration/agents/grok-parser.test.ts`
- Test: `tests/integration/agents/health.test.ts`

- [ ] **Step 1: Write failing command/profile tests**

Assert the isolated profile:

- uses only the authorized candidate root for `--cwd`;
- uses `--permission-mode auto`, prompt-file delivery, streaming JSON, bounded turns;
- permits only proven `Read/Glob/Grep/Edit/Write` equivalents;
- denies shell, command, install, web, subagent, and MCP-capable tools;
- contains no canonical path, prompt text, always-approve, bypass, or arbitrary root;
- refuses the profile when required tool-deny flags are absent from dynamic probes;
- keeps existing immutable review profile unchanged.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/unit/agents/grok-command.test.ts tests/integration/agents/grok-parser.test.ts tests/integration/agents/health.test.ts`

- [ ] **Step 3: Implement the minimal isolated profile**

Add an opaque workspace reference to command input/intent/profile hashing. Use exact installed CLI tool names proven by fixtures; do not loosen forbidden flags.

- [ ] **Step 4: Verify GREEN**

Run the same command; expected all Grok command/parser/health tests pass.

---

### Task 6: Generate and persist deterministic candidate change sets

**Files:**
- Create: `src/workspace/workspace-change-set.ts`
- Modify: `src/workspace/implementation-workspace-types.ts`
- Modify: `src/workspace/implementation-workspace-repository.ts`
- Test: `tests/integration/workspace/workspace-change-set.test.ts`
- Reference: `src/tracking/diff-service.ts`, `src/tracking/hash.ts`

- [ ] **Step 1: Write failing change-set tests**

Cover add/modify/delete, rename-as-delete+add, sorted canonical JSON, stable hash, normalized diff with no absolute paths, blob identity, duplicate/case collision, binary/type/reparse/oversize rejection, and candidate manifest mismatch.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/integration/workspace/workspace-change-set.test.ts`

- [ ] **Step 3: Implement `WorkspaceCandidateChangeSet` v1**

Reuse tracker scanning and DiffService comparison; persist candidate/change-set hashes only after validation.

- [ ] **Step 4: Verify GREEN**

Run the same test file.

---

### Task 7: Route workflow stages to canonical, candidate, and bundle roots

**Files:**
- Modify: `src/workflow/transitions.ts`
- Modify: `src/workflow/workflow-engine.ts`
- Modify: `src/workflow/states.ts`
- Modify: `src/workflow/task-orchestrator.ts`
- Modify: `src/workflow/workflow-journal.ts`
- Modify: `src/app/production-task-runtime.ts`
- Test: `tests/unit/workflow/workflow-engine.test.ts`
- Test: `tests/integration/workflow/isolated-grok-workflow.test.ts`
- Test: `tests/integration/workflow/happy-path.test.ts`

- [ ] **Step 1: Write failing workflow tests**

Required sequence:

```text
environment -> Claude planning on canonical read-only
prepare workspace -> Grok implementation on candidate
candidate change-set -> Codex review on immutable bundle
Claude master validation on candidate read-only
promotion -> completed -> release lock
```

Assert original tree unchanged until promotion, effects and pending actions are durable/idempotent, and errors never skip review/validation.
Also assert the orchestrator never substitutes a different adapter when Claude, Grok, or Codex is unavailable.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/unit/workflow/workflow-engine.test.ts tests/integration/workflow/isolated-grok-workflow.test.ts tests/integration/workflow/happy-path.test.ts`

- [ ] **Step 3: Add minimal effects and routing**

Add effects/action types for prepare workspace, finalize candidate, and promote candidate. Stage prompts receive an execution root chosen by effect; Grok prompts never contain canonical root.

- [ ] **Step 4: Verify GREEN**

Run the same command.

---

### Task 8: Review, rework, and candidate master validation

**Files:**
- Modify: `src/protocol/review-bundle.ts`
- Modify: `src/review/reviewer-runner.ts`
- Modify: `src/workflow/task-orchestrator.ts`
- Modify: `src/workflow/rework-service.ts`
- Test: `tests/integration/review/read-only-review.test.ts`
- Test: `tests/integration/workflow/isolated-grok-workflow.test.ts`

- [ ] **Step 1: Write failing review/rework tests**

Cover cumulative source-to-candidate diff, Codex approve/rework/reject, one format repair, timeout/transport failure, bounded Grok rework on the same candidate with a new attempt authorization, and Claude validation on candidate with no canonical write.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/integration/review/read-only-review.test.ts tests/integration/workflow/isolated-grok-workflow.test.ts`

- [ ] **Step 3: Wire immutable candidate evidence and machine outcomes**

Reject ambiguous review results. Keep the candidate immutable during each review/validation attempt and verify hashes before/after.

- [ ] **Step 4: Verify GREEN**

Run the same tests.

---

### Task 9: Promote through PatchApplier with global drift protection

**Files:**
- Create: `src/workspace/workspace-promotion-service.ts`
- Modify: `src/workspace/workspace-change-set.ts`
- Modify: `src/guard/patch-applier.ts` only if a small public conversion seam is required
- Modify: `src/workflow/task-orchestrator.ts`
- Test: `tests/integration/workspace/workspace-promotion.test.ts`
- Test: `tests/integration/guard/patch-applier.test.ts`

- [ ] **Step 1: Write failing promotion tests**

Cover exact add/modify/delete, rename conversion, full canonical manifest drift (including unrelated paths), target collision, source deletion, active lock mismatch, multi-file rollback, reviewed/candidate hash mismatch, and post-promotion change-set equality.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/integration/workspace/workspace-promotion.test.ts tests/integration/guard/patch-applier.test.ts`

- [ ] **Step 3: Implement patch conversion and guarded promotion**

Generate PatchApplier-compatible text from source/candidate blobs, recheck full canonical manifest before `apply`, and persist promotion evidence only after exact post-apply verification.

- [ ] **Step 4: Verify GREEN**

Run the same tests.

---

### Task 10: Recovery, retention, and stale workspace prevention

**Files:**
- Modify: `src/app/startup-reconcile.ts`
- Modify: `src/app/restart-recovery-service.ts`
- Modify: `src/workspace/implementation-workspace-service.ts`
- Modify: `src/workflow/workflow-journal.ts`
- Test: `tests/integration/app/startup-reconcile.test.ts`
- Test: `tests/integration/app/restart-recovery-service.test.ts`
- Test: `tests/integration/workflow/crash-recovery.test.ts`

- [ ] **Step 1: Write failing recovery tests**

Cover every persisted workspace state, live/dead process evidence, incomplete prepare cleanup, candidate integrity reconstruction, approved-before-promotion resume, uncertain promotion no-auto-replay, explicit audited cancel, 24-hour abandoned cleanup, and no auto-delete for `recovery_required`.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/integration/app/startup-reconcile.test.ts tests/integration/app/restart-recovery-service.test.ts tests/integration/workflow/crash-recovery.test.ts`

- [ ] **Step 3: Implement fail-closed reconcile and housekeeping**

Never reuse consumed authorization or replay an uncertain promotion. Preserve evidence before cleanup.

- [ ] **Step 4: Verify GREEN**

Run the same tests.

---

### Task 11: Offline end-to-end, packaging, and installed smoke

**Files:**
- Modify: `tests/e2e/fake-full-workflow.test.ts`
- Modify: `tests/e2e/package-install.test.ts`
- Modify: `tests/unit/scripts/packaging-security.test.ts`
- Modify: `README.md`
- Modify: `docs/verification/acceptance-checklist.md`

- [ ] **Step 1: Add failing fake full-workflow and package assertions**

The fake workflow must prove candidate-only writes before review, promotion after approvals, exact role attempts, cleanup eligibility, and zero active locks. Package tests must assert migration/runtime modules ship.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- tests/e2e/fake-full-workflow.test.ts tests/e2e/package-install.test.ts tests/unit/scripts/packaging-security.test.ts`

- [ ] **Step 3: Complete wiring/docs minimally**

Document isolated implementation and best-effort boundary. Do not claim perfect sandboxing.

- [ ] **Step 4: Run targeted GREEN**

Run the same tests.

- [ ] **Step 5: Run full fresh verification**

Run in order:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run prepack
npm.cmd pack --json
```

Expected: exit 0; all non-opt-in tests pass; tarball includes migration 007 and required runtime files.

- [ ] **Step 6: Install packed artifact globally and run no-model smoke**

Use the generated tarball, verify installed/local bundle hashes, run `triagent --help`, and run installed health/app-context smoke without model prompts.

---

### Task 12: Real Claude -> Grok -> Codex acceptance

**Files:**
- Create or update: `D:\tmp\triagent-live-connection-smoke.mjs` diagnostic harness only
- Update: `docs/verification/acceptance-checklist.md`
- Update: root `progress.md`, `findings.md`, `task_plan.md`

- [ ] **Step 1: Create a fresh canonical project and fresh app-root**

Canonical project initially contains only `README.md`. Set `TRIAGENT_REAL_AI_TESTS=1` only in this process.

- [ ] **Step 2: Submit the fixed task with required roles**

Claude master plans, Grok implementer creates exactly `triagent-smoke.txt`, Codex reviews, Claude validates, and TriAgent promotes.

- [ ] **Step 3: Verify live evidence**

Require:

- workflow `completed`;
- exact target content and no extra canonical files;
- completed Claude planning and master-validation attempts;
- completed Grok candidate implementation attempt;
- approved Codex review;
- canonical project unchanged before promotion;
- reviewed change-set hash equals promoted change-set hash;
- PatchApplier evidence successful;
- active locks zero;
- workspace promoted and cleanup authorized/completed.

- [ ] **Step 4: Run installed negative acceptance fixtures without additional model calls**

Using deterministic adapters/fixtures, prove Codex rejection, canonical drift, malformed review, timeout, unsafe candidate path, and crash recovery leave the canonical project unchanged and never promote stale evidence.

- [ ] **Step 5: If live acceptance fails, return to systematic debugging**

Preserve the unique app-root/workspace as evidence, identify the exact failing boundary, add a failing automated regression, and do not claim completion.

- [ ] **Step 6: Record final results**

Update acceptance evidence and planning files with exact commands, test counts, artifact hash, installed hash, live task id, attempts, review verdict, promoted files, and lock state.
