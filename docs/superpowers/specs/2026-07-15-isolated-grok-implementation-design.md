# Isolated Grok Implementation Design

**Status:** Approved direction; implementation-ready after document review  
**Date:** 2026-07-15  
**Required default roles:** Claude = master/planning, Grok = implementer, Codex = reviewer

## Problem

TriAgent currently exposes the requested role assignment in the TUI, but a real task stops after Claude planning. Grok is denied before launch because its compatibility record intentionally has `readOnly=false`, `projectWrite=false`, and `writeModes=[]`. The Grok command builder also forces `--cwd` to an immutable review bundle and rejects the live project root.

Simply changing the default role assignment would therefore leave the product broken. Unconditionally granting Grok live-project write access would remove the fail-closed safety property. Binding write access to one exact Grok version was rejected because every upgrade would require manual re-authorization.

## Goals

- Make the default workflow Claude planning -> Grok implementation -> Codex review.
- Let Grok make real file edits without giving it direct access to the canonical project root.
- Preserve the project's current dirty and untracked state in the implementation candidate.
- Produce a deterministic, immutable diff for Codex review.
- Apply an approved candidate to the canonical project only after drift and path validation.
- Continue using capability-contract probing for compatible Grok upgrades; do not bind implementation to an exact version.
- Preserve crash recovery, project locks, audit evidence, and fail-closed behavior.
- Prove the requested role assignment with a real isolated three-agent task.

## Non-goals

- This does not create a perfect OS sandbox against a malicious Grok executable.
- This does not enable `--always-approve`, bypass permission modes, or arbitrary shell invocation.
- This does not add automatic dependency installation.
- The first implementation will reject binary changes, unsafe reparse points, external links, and unsupported file-type changes instead of applying them optimistically.
- This does not remove the ability to cycle to other role assignments in the TUI; it changes the default and makes the requested default operational.

## Architecture

### 1. Durable isolated implementation workspace

Add an `ImplementationWorkspaceService` responsible for creating and managing one candidate workspace per implementer attempt.

Workspace roots live under the durable app root:

```text
%LOCALAPPDATA%\TriAgent\implementation-workspaces\<task-id>\<attempt-id>\project
```

Test `--app-root` overrides naturally keep test workspaces isolated.

The service materializes the task-start project state from the existing baseline manifest and blob store. It must:

- use byte copies, never hard links;
- include tracked, dirty, and untracked files represented by the task baseline;
- exclude `.git`, `.worktrees`, dependency caches such as `node_modules`, and TriAgent-owned transient data;
- reject external reparse/symlink targets;
- copy safe regular files whose content was excluded from the blob store only after their current hash still matches the baseline;
- record a manifest hash after materialization;
- never expose the canonical project path in the workspace metadata passed to an agent.

The task baseline, not `.gitignore`, is the authoritative source set. Materialization semantics are:

- tracked, dirty, and untracked entries present in the baseline are materialized;
- files absent from the baseline are absent from the candidate;
- `.git`, `.worktrees`, `node_modules`, package-manager caches, and TriAgent-owned paths are always excluded;
- ignored and generated files are included when the authoritative baseline contains them; their ignored/generated label alone does not remove them;
- a nested repository marker (`.git` directory or gitfile below the canonical root) makes that nested subtree unsupported for candidate writes; materialization fails with `nested_repository_unsupported` rather than silently editing another repository;
- entries whose baseline content policy marks them secret/credential/private-key material are not materialized and are added to a protected-path set that the candidate may neither create, modify, nor delete;
- project-local TriAgent state (`.triagent`, configured app-root aliases, logs, snapshots, workspace roots, and prompt artifacts) is never materialized or promotable;
- regular text, large, and binary source files may be copied byte-for-byte after hash recheck, but binary/oversized/type-changing candidate modifications are rejected before review in the first release;
- reparse points and symlinks are not recreated in the first release; safe in-root links fail with an explicit unsupported-entry error and external links fail as path escapes;
- hard links are broken into independent byte copies and the destination must have `nlink === 1`;
- executable metadata is retained in the manifest; timestamps and inherited ACL identity are not content identity;
- the workspace receives app-owned ACLs rather than copied canonical-project ACL entries;
- deletion is explicit; a safe text rename is promoted as delete+add while review metadata may retain the detected rename relationship.

Add a durable `implementation_workspaces` record keyed by task and attempt. The record stores workspace id, task id, attempt id, canonical project identity, workspace root, source baseline id/hash, candidate baseline/hash, lifecycle status, and timestamps. The canonical path remains internal and is never added to the Grok prompt or argv.

Lifecycle states:

```text
preparing -> ready -> running -> candidate_ready -> under_review
          -> approved -> validating -> promoted
          -> rejected | abandoned | recovery_required
```

### 2. Scoped ProjectGuard decision

ProjectGuard gains an explicit execution scope:

```text
live_project
isolated_implementation
immutable_review_bundle
```

Grok remains denied for `live_project`. It may receive `workspace-write` only when all of the following are true:

- role is `implementer`;
- execution scope is `isolated_implementation`;
- the workspace reference was issued by `ImplementationWorkspaceService` for the same task and attempt;
- the workspace is under the configured app-root implementation-workspaces directory;
- source baseline, task, attempt, and workspace manifest hashes match the persisted record;
- the current Grok executable passed the existing version-range and help-contract probes;
- the command profile uses `--permission-mode auto`, bounded turns, prompt-file delivery, and the allow/deny tool profile;
- no bypass or always-approve flag is present.

The permission decision describes permission to mutate a disposable candidate, not proof that Grok can safely write the live project. No compatibility record is elevated to live `projectWrite=true`.

### 3. Grok implementation command profile

Extend the Grok adapter with a distinct `isolated_implementation` profile.

For this profile:

- `--cwd` is the issued candidate workspace root;
- `liveProjectAccess` remains false;
- the command intent carries an opaque workspace authorization id and workspace manifest hash;
- prompt artifacts remain outside both the canonical project and candidate workspace;
- the prompt refers only to the candidate path as the project root;
- allowed and denied tools are explicit and version-contract-probed;
- `--always-approve`, bypass modes, direct prompt argv, and arbitrary workspace paths remain forbidden.

The first implementation profile permits only Grok's built-in project file operations needed to inspect and edit the candidate (`Read`, `Glob`, `Grep`, `Edit`, and `Write`, using names proven by the installed CLI contract). It denies shell/command execution, package installation, web access, subagents, MCP tools, and every tool that can spawn a child process. Verification commands run later through TriAgent's supervised validation path. If the installed CLI cannot express this deny profile, Grok implementation remains disabled.

The existing immutable-review-bundle profile remains unchanged for Grok reviewer/master use. The new profile is selected only for Grok in the implementer role with a valid workspace authorization.

Compatible Grok upgrades continue to use the current dynamic probe contract. A binary is accepted by capabilities and flags rather than by exact version. Missing or changed required flags fail closed with a precise health error.

### 4. Candidate diff and immutable review

Before Grok launches, create an attempt baseline rooted at the candidate workspace. After Grok exits successfully:

- scan the candidate workspace with the existing tracking abstractions;
- compare it with the materialized source baseline using `DiffService`;
- reject unsafe paths, binary changes, external links, unsupported file types, and forbidden dependency/install changes;
- generate a normalized unified diff that contains no canonical or temporary absolute paths;
- hash the candidate tree and persist the candidate manifest/hash;
- transition the workspace to `candidate_ready`.

The persisted candidate change-set contract is:

```ts
interface WorkspaceChangeEntry {
  readonly kind: 'add' | 'modify' | 'delete';
  readonly path: string;
  readonly detectedFromPath?: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly beforeSize: number;
  readonly afterSize: number;
  readonly beforeBlobHash: string | null;
  readonly afterBlobHash: string | null;
}

interface WorkspaceCandidateChangeSet {
  readonly schema: 'triagent.workspace_change_set.v1';
  readonly taskId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly sourceBaselineId: string;
  readonly sourceManifestHash: string;
  readonly candidateManifestHash: string;
  readonly entries: readonly WorkspaceChangeEntry[];
  readonly unifiedDiff: string;
  readonly changeSetHash: string;
}
```

Paths are normalized project-relative paths and entries are sorted by path. Absolute paths are forbidden. The change-set hash covers canonical JSON plus the normalized diff. Before/after blobs come from the source baseline and candidate snapshot stores. Promotion converts entries into add/modify/delete text patch sections; detected renames become delete+add. Missing blobs, hash mismatches, binary content, unsupported types, duplicate/case-colliding paths, oversized payloads, or non-deterministic ordering reject the candidate.

Build the existing immutable `ReviewBundle` from:

- the requirement and Claude plan;
- source and candidate baseline identities;
- the normalized candidate diff;
- relevant file hashes;
- Grok command evidence and verification logs.

Codex runs read-only against the immutable review bundle. It never receives a writable canonical project root.

Codex must return the existing machine-validated AgentResult schema with one unambiguous outcome:

- `completed/approve` permits master validation;
- `completed/rework` returns bounded feedback to Grok;
- `failed`, `await_user`, or a rejected verdict never permits promotion.

Malformed output gets the existing single bounded format-repair attempt. A second malformed result, timeout, transport failure, missing review evidence, or inconclusive result transitions to review failure/recovery with no canonical write.

### 5. Rework and master validation

If Codex requests rework, Grok resumes against the same candidate workspace. A new attempt baseline is captured before every rework so attempt-level changes remain auditable, while the review bundle always contains the cumulative source-to-candidate diff.

After Codex approves, Claude performs master validation against the candidate workspace in read-only mode. The canonical project is still untouched. A failed master validation returns to bounded Grok rework.

### 6. Promotion to the canonical project

Promotion occurs only after Codex approval and Claude master validation.

The promotion service converts the trusted source-to-candidate diff into the existing textual patch contract and calls `PatchApplier`. This deliberately reuses:

- `PatchValidator` path and baseline checks;
- `PathPolicy` containment, hard-link, and reparse checks;
- PatchApplier staging, immediate pre-commit rechecks, multi-file atomic replacement, and rollback evidence.

Before promotion, the canonical project must still match the source baseline for every affected path. Any content drift, newly created target, missing source, project identity mismatch, or active lock mismatch rejects promotion without writing files.

For the first implementation, drift comparison is global: the full canonical manifest hash must still equal the source task-baseline manifest hash. Any human or external modification, including an unrelated path, blocks promotion with `promotion_blocked_original_drift`. Partial-overlap auto-merge is out of scope. The candidate is preserved so the user can restart from a fresh baseline; no patch is partially applied.

After successful promotion:

- capture the canonical post-promotion change set;
- verify it matches the reviewed candidate change set;
- persist promotion evidence;
- release the project lock;
- mark the workspace `promoted` and clean it after the retention window.

### 7. Recovery and cleanup

The workspace row and action evidence make restart decisions deterministic.

- `preparing` without a complete manifest: delete the incomplete workspace and recreate only after an explicit retry.
- `running` with live process evidence: do not replay.
- `running` without live process evidence: enter inspection/recovery; preserve the candidate.
- `candidate_ready` or `under_review`: reconstruct the immutable bundle from persisted hashes and continue review only after integrity recheck.
- `validating`: resume master validation only with matching session evidence; otherwise inspect/cancel.
- `approved` before promotion: recheck original baseline and allow promotion.
- `promoting` with uncertain commit evidence: never auto-replay; use PatchApplier evidence and filesystem hashes to choose inspect/cancel.
- cancelled/rejected tasks: release the canonical lock and mark the workspace abandoned; cleanup is audit logged.

Workspace retention is deterministic:

- successfully promoted workspaces are deleted after post-promotion hash verification and evidence persistence;
- rejected, cancelled, or abandoned workspaces are retained for 24 hours, then removed by startup housekeeping;
- `recovery_required` workspaces are never automatically deleted and require an explicit audited cancel/cleanup action;
- a workspace authorization is single-task, single-attempt, single-workspace, and single-use for transition into `running`;
- terminal, hash-mismatched, expired, or consumed references cannot be reused;
- rework creates a new attempt authorization while retaining the candidate root and capturing a fresh attempt baseline.

Failures before promotion never modify the canonical project.

## Default role behavior

Reorder `ROLE_ASSIGNMENT_ORDER` so the first/default assignment is:

```ts
{ master: 'claude', implementer: 'grok', reviewer: 'codex' }
```

The other assignments remain selectable. Task persistence continues to store the exact selected assignment.

## Security properties

- The canonical project root is not sent to Grok during implementation.
- A project-controlled path cannot select the workspace; the adapter consumes an opaque authorization issued after task/attempt validation.
- Candidate files are independent byte copies, not hard links to canonical files.
- The canonical project stays locked but unchanged until review and master validation succeed.
- All canonical writes pass through PatchApplier.
- Version upgrades are checked by capability contract and executable identity, not a permanent exact-version allowlist.
- This remains best-effort orchestration, consistent with the existing README; it is not an OS security boundary against a hostile binary.
- Grok cannot launch child processes in the approved profile because shell/command/subagent/MCP-capable tools are denied. ProcessHost still supervises the process tree and treats an unexpected descendant as a policy violation that aborts the candidate without promotion.
- No orchestration fallback may silently replace Claude, Grok, or Codex. An unavailable requested adapter fails environment validation with the requested role and adapter named explicitly.

## Testing strategy

Follow strict red-green TDD.

### Unit tests

- Default role assignment is Claude/Grok/Codex.
- Workspace paths are under app-root and opaque references cannot be forged or cross-task reused.
- Materialization preserves dirty/untracked content and never creates hard links.
- External reparse points and excluded/unsafe paths fail closed.
- Grok isolated implementation command uses candidate `--cwd`, auto permission mode, prompt-file delivery, and no canonical path or bypass flags.
- Grok remains disabled for direct live-project implementation.
- Candidate diff rejects binary/type/reparse/forbidden dependency changes.
- Promotion conversion produces a PatchApplier-compatible patch.

### Integration tests

- Claude plan -> Grok candidate edit -> Codex immutable review -> Claude validation -> promotion.
- Original project remains byte-identical before promotion.
- Original drift blocks promotion.
- Codex reject triggers bounded rework without canonical writes.
- Process failure and restart preserve candidate and expose legal recovery actions only.
- Promotion failure rolls back all canonical writes and retains evidence.
- Git dirty/untracked and non-Git source projects both materialize correctly.
- Source deletion and safe text rename (canonical delete+add) promote correctly.
- Binary, oversized, type-changing, case-colliding, hard-link, and reparse candidate changes are rejected.
- Codex approve/rework/reject, malformed output, repair failure, timeout, and transport failure reach the defined state without unauthorized promotion.
- Any canonical manifest drift, including unrelated-path drift, blocks promotion.
- Stale, consumed, cross-task, cross-attempt, and hash-mismatched workspace authorizations are rejected.
- Successful, abandoned, and recovery-required workspaces follow the defined retention rules.

### Packaging and installed tests

- Migration and workspace modules are present in the packed tarball.
- Full test suite, typecheck, build, prepack, tarball inspection, and global replacement install pass.
- Installed `triagent --help` and no-model capability smoke pass.

### Real acceptance test

Use a fresh non-Git canonical project and fresh app-root with `TRIAGENT_REAL_AI_TESTS=1` only for that process.

Task: create one fixed UTF-8 text file and modify no other canonical file.

Required evidence:

- Claude master planning attempt completed.
- Grok implementer attempt completed in a candidate workspace.
- Canonical project remained unchanged through Grok and Codex stages.
- Codex reviewer approved the immutable candidate diff.
- Claude master validation completed.
- PatchApplier promoted exactly the reviewed file.
- Final content is exact.
- No extra files exist in the canonical project.
- Workflow is `completed`.
- Active project locks are zero.
- Candidate workspace is marked promoted and cleanup is authorized.

Additional fixture-backed acceptance checks require no extra model calls: rejection leaves the canonical tree unchanged; drift prevents promotion; simulated crash/timeout leaves a recoverable candidate; deletion/rename promotion is deterministic; and default role selection persists Claude/Grok/Codex.

## Implementation constraints

- Do not use subagents for production implementation.
- Do not commit, reset, checkout, or clean the user's worktree.
- Preserve unrelated untracked files and current worktree state.
- Every production behavior change requires a failing automated test observed before implementation.
- Real model calls run only for the final explicitly authorized acceptance test.
