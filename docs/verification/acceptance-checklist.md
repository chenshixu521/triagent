# TriAgent Task 23 Acceptance Checklist

Date: 2026-07-15 (Asia/Shanghai)

Status: automated/offline acceptance previously passed. **Isolated real-AI closed loop (Task 12) passed on 2026-07-15** with Claude master / Grok isolated implementer / Codex reviewer → promote. Evidence: `D:\tmp\triagent-isolated-grok-e2e-1784098761755-44168` (`passed: true`, `postApplyVerified: true`, zero active locks).

## Execution boundary

- Node.js: `v24.18.0` (minimum supported major verified).
- Platform: Windows x64.
- Offline matrix historically ran with `TRIAGENT_REAL_AI_TESTS` unset.
- **Task 12 real-AI exception (authorized):** process-only `TRIAGENT_REAL_AI_TESTS=1` for harness `D:\tmp\triagent-isolated-grok-e2e-smoke.mjs` (not persisted to settings).
- Roles for Task 12: Claude=master, Grok=isolated implementer, Codex=reviewer; PatchApplier sole canonical writer on promote.
- Windows ACL, CIM, npm-cache, and Job Object tests require execution outside the restricted filesystem sandbox.

## Static and automated matrix

| Command | Exit | Evidence |
| --- | ---: | --- |
| `node --version` | 0 | `v24.18.0` |
| `npm.cmd run typecheck` | 0 | TypeScript `tsc --noEmit` passed. |
| Prior standalone `npm.cmd test` compatibility baseline | 0 | 74 test files passed, 1 skipped; 841 tests passed, 6 skipped (847 total). |
| `npm.cmd test -- tests/unit/tui/start-screen.test.tsx` | 0 | 5/5 passed: full frame, right-top pixel TriFox, gold theme, large prompt, 60x24 Chinese layout, and localized help. |
| `npm.cmd test -- tests/unit/tui` | 0 | 7 files and 55/55 TUI tests passed after isolating start-only role labels. |
| `npm.cmd run prepack` verification phases | 1 | Packaging stress 6/6, full suite 839 passed/9 skipped (848 total), and typecheck passed. The final build phase alone hit a transient Windows `EBUSY` while deleting an old SHA-256 artifact. |
| `npm.cmd run build` retry | 0 | With normal file attributes/ACLs and no TriAgent build process holding the file, the immediate targeted retry passed: native ProcessHost, embedded trust, 903.87 KB Node bundle, migrations, and secure native copy. |
| `npm.cmd test -- tests/unit/scripts/packaging-security.test.ts tests/e2e/package-install.test.ts` | 0 | Post-install regression: 2 files and 10 tests passed; packaged migrations and global install were verified. |
| `npm.cmd pack --ignore-scripts --json` | 0 | Final rebuilt package contained exactly 15 allowlisted entries, including all 6 runtime SQLite migrations. |
| Global installed-bundle smoke | 0 | Local/global CLI SHA-256 matched; `triagent --help` passed; injected no-AI startup from `D:\tmp` reached `new_task`, selected `D:\tmp`, resolved `zh-CN`, and kept ProcessHost stopped. |

Vitest is capped at four file workers on this 32-logical-CPU host. Restricted-sandbox runs may produce false failures through npm cache, Windows ACL/CIM/Job/process permissions. For the start-screen fidelity rebuild, the prepack full-suite phase completed in 102.02 seconds with 839 passing and 9 skipped tests; its build-only `EBUSY` was resolved by one targeted build retry, without repeating the full suite.

## Fake complete workflow E2E

Test: `tests/e2e/fake-full-workflow.test.ts`

- Task ID: `task-fake-full-workflow`.
- Calls: 7 total — master 3, implementer 2, reviewer 2.
- Final state: `completed`; `reworkCount = 1`.
- Transition sequence:

```text
draft
-> checking_environment
-> planning
-> awaiting_plan_approval
-> implementing
-> reviewing
-> master_validation
-> rework_requested
-> implementing
-> reviewing
-> master_validation
-> completed
```

- Event sequence: `START`, `ENVIRONMENT_READY`, `PLAN_READY`, `PLAN_APPROVED`, `IMPLEMENTATION_COMPLETED`, `REVIEW_COMPLETED`, `MASTER_REJECTED`, `REWORK_CONTEXT_PERSISTED`, `IMPLEMENTATION_COMPLETED`, `REVIEW_COMPLETED`, `MASTER_APPROVED`.
- Seeded defect evidence: reviewer attempt `attempt-3` persisted `calculate subtracts instead of adding`.
- Defect content SHA-256 (`attempt-2` / SQLite `file_changes.after_hash`): `83fdab6a48428a920197d05ee2216c9f67647e73dbea4214770f63a9c919b38a`.
- Fixed content SHA-256 (`attempt-5` / SQLite `file_changes.after_hash`): `19d8919f7bc51093e34a0f88e095115acc7c495fe7cfe8647d1cb210a321528f`.
- Final Git diff contains `return left + right;`.
- SQLite: exactly 7 run attempts; zero non-completed pending actions; project lock has a non-null `released_at`.
- JSONL: every line SHA-256 was recomputed; every SQLite `log_index` checksum matched the corresponding JSONL sequence.
- Process cleanup: `FakeProcessSupervisor.activeAttemptIds()` returned an empty list.

## Crash, reconcile, and cleanup E2E

- Task ID: `task-fake-crash-reconcile`.
- Root fake PID: `11001`; descendant fake PID: `11002`.
- While the process was still running, a second SQLite connection plus a new tracker/journal simulated application restart. Two reconciliation reads returned the same `process_still_running` blocked decision, performed no automatic execution, and issued zero force-stop calls.
- Cooperative stop was ignored; forced tree stop ran exactly once.
- Positive tree verification ended with zero active fake attempts.
- Project rescan ran exactly once; repeating interruption did not re-force or re-scan.
- After cleanup, another fresh SQLite connection and `WorkflowRecoveryJournal` returned the same blocked reconciliation decision twice with `automaticExternalExecution = false`; no duplicate external side effect occurred.
- Inspected partial content SHA-256: `9982863f8b4c8d87a6216b99ebc798e4878031e1a76ad039c8a6bbcce428a3ea`.
- Continue branch emitted exactly one `StartImplementation` effect.
- Cancel branch emitted exactly one `ReleaseProjectLock` effect.

## Final safety-gate coverage

All listed automated gates were included in the passing full suite:

- ProjectGuard path escape, arbitrary shell, dependency install, and capability downgrade fail-closed behavior.
- Persisted runtime/call budget enforcement across restart.
- Independent Worker crash isolation.
- Windows Job Object descendant cleanup and identity verification.
- Reviewer/master read-only behavior for enabled adapter profiles.
- Dirty Git baseline preservation.
- Crash reconcile without duplicate side effects.
- Corrupted SQLite diagnostic mode with side effects disabled.
- Three-rework product limit.
- Global tarball install and `triagent --help` startup without AI/native side effects.
- Dynamic CLI upgrade policy: strict version ranges, fixed help-only probe manifests, runtime record invariants, executable-identity/contract/TTL cache invalidation, and fail-closed unknown versions.
- Grok dynamic records remain enforcement-conservative (`readOnly=false`, `projectWrite=false`, `nativePermissionRules=false`, `writeModes=[]`).
- Approved start-screen fidelity: complete outer frame, gold `#d6a756` brand/prompt, wide-screen right-top 32x10 three-tail TriFox, full-width Project section, large prompt, bottom roles/shortcuts, and non-overflowing 60x24 Chinese layout.

## Task 12 real isolated Grok e2e (2026-07-15)

Harness: `D:\tmp\triagent-isolated-grok-e2e-smoke.mjs`  
Evidence root: `D:\tmp\triagent-isolated-grok-e2e-1784098761755-44168`

| Check | Result |
| --- | --- |
| `passed` / `exitCode` | `true` / `0` |
| `workflowState` | `completed` |
| Roles exercised | master, implementer, reviewer |
| Reviews | Codex approved; Claude master approved |
| Promote | `promoted`, `postApplyVerified: true` |
| Canonical files | `README.md` + `triagent-smoke.txt` only |
| Smoke content | `TriAgent isolated Grok smoke completed.` |
| Active locks | none |
| Rework count | 0 |

Key product fixes proven on this path: isolated workspace write for Grok, candidate change-set finalize, immutable review against candidate, `inspectionRoot` for master/review, real PatchApplier promotion with post-apply hash equality.

## Package evidence

- Package: `triagent-orchestrator@0.1.0`.
- Filename: `triagent-orchestrator-0.1.0.tgz`.
- Packed size: `33,420,440` bytes; unpacked size: `76,384,548` bytes.
- Tarball SHA-1: `58777f2642a8598c360a5ec24dfbb59ba61a1609`.
- Integrity: `sha512-uh79NDpKxmm5wmvhEBe3vvvm0F7g23qCn7ouSjFBSjk6n39BHlzulSf0dPju/SYNyJL18AMCk0mDd40GFFFIBg==`.
- Local and globally installed `dist/cli.js` SHA-256: `FBE8DD5767F5AA94E9C462B6451CC3B9FECF356FC1B613C7B8292168BC44E9CD`.
- Native helper: `73,525,322` bytes, SHA-256 `82f5c98216959e30517c58ccd79f5b06dd8958bd5db41708aa48c4454abe6ec4`, PE machine `0x8664`.
- Exact package entries:

```text
README.md
dist/cli.js
dist/cli.js.map
dist/migrations/001_initial.sql
dist/migrations/002_project_lock_leases.sql
dist/migrations/003_guard_active_lock_deletes.sql
dist/migrations/004_log_index_integrity.sql
dist/migrations/005_budget_runtime_and_calls.sql
dist/migrations/006_agent_session_resume_evidence.sql
dist/native/win-x64/checksum-metadata.json
dist/native/win-x64/triagent-process-host.exe
dist/native/win-x64/triagent-process-host.sha256
package.json
schemas/agent-patch-result.schema.json
schemas/agent-result.schema.json
```

## Pending real acceptance

The opt-in smoke harness uses the real `CodexAdapter` / `ClaudeAdapter`, a trusted packaged ProcessHost, static or runtime-probed compatibility records, and store-backed one-time launch authorizations. It fails instead of skipping when the enabled CLI, auth state, helper, or verified command contract is unavailable.

| Check | Status | Reason |
| --- | --- | --- |
| Opt-in Codex read-only smoke | NOT RUN | Awaiting explicit quota-consuming-call approval. |
| Opt-in Claude safe read-only smoke | NOT RUN | Awaiting explicit quota-consuming-call approval. |
| Grok real smoke | NOT RUN | Explicitly excluded by the user's current instruction; no Grok invocation. |
| Disposable real closed loop | NOT RUN | Must wait until the authorized real smoke tests pass. |

Known degradations: the native helper is not Authenticode-signed; dynamic compatibility is limited to the declared major ranges and current fixed command templates; the installed Grok 0.2.101 live help probe was not rerun in this acceptance because the user explicitly prohibited Grok invocation; orchestration guardrails are best-effort rather than a hostile-code security boundary; the package is large because the ProcessHost is self-contained.
