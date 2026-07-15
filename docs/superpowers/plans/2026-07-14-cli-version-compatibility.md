# TriAgent CLI Dynamic Version Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user explicitly required inline execution without subagents; no Git commits are permitted.

**Goal:** Let TriAgent safely recognize compatible Codex, Claude, and Grok upgrades through no-model capability probes and a machine-local expiring cache instead of exact-version string gates.

**Architecture:** Keep the static compatibility matrix as the baseline trust anchor, add a runtime registry plus a resolver that validates version ranges and declarative help-command manifests, and persist only bounded probe receipts tied to executable identity and contract hash. Health checks may invoke the resolver on a matrix miss; all downstream launch gates continue to use `lookupCompatibility()` and existing capability-bit validation.

**Tech Stack:** Node.js 24+, TypeScript 7, Vitest 4, existing `CommandProbe`/ProcessSupervisor, JSON app-data cache.

**Approved spec:** `docs/superpowers/specs/2026-07-14-cli-version-compatibility-design.md`

**Repository constraints:** Do not use subagents, Grok, real-AI tests, or Git commit/reset/checkout/clean. Use `apply_patch`; every production behavior change starts with a failing test.

---

## Planned file map

```text
src/agents/compatibility-matrix.ts                 Static matrix plus validated runtime registry
src/agents/compatibility-probe-manifests.ts        Version ranges, fixed help probes, contract hashes, conservative record derivation
src/agents/compatibility-cache.ts                  Executable identity and bounded atomic probe-receipt cache
src/agents/compatibility-resolver.ts               Static/cache/probe resolution orchestration
src/agents/health/{codex,claude,grok}-health.ts    Resolver seam and matrix-based support decision
src/config/app-paths.ts                            Dedicated compatibility cache path
src/app/app-context.ts                             Shared resolver during startup capability probes
src/agents/{codex,claude,grok}/*-command.ts        Remove duplicate exact-version constants/checks only
tests/unit/agents/compatibility-resolver.test.ts   Range, manifest, registry, cache, invalidation, corruption tests
tests/integration/agents/health.test.ts             Unknown-version resolver RED/GREEN and fail-closed coverage
tests/integration/app/startup-reconcile.test.ts     AppPaths/cache-path and startup resolver wiring
tests/unit/agents/{codex,claude,grok}-command.test.ts Dynamic-record builder coverage; no real CLI calls
```

## Task 1: Build the runtime registry, manifests, resolver, and cache

**Files:**
- Create: `tests/unit/agents/compatibility-resolver.test.ts`
- Create: `src/agents/compatibility-probe-manifests.ts`
- Create: `src/agents/compatibility-cache.ts`
- Create: `src/agents/compatibility-resolver.ts`
- Modify: `src/agents/compatibility-matrix.ts`

- [x] Write tests for version acceptance (`grok 0.2.101`, newer Codex/Claude), downgrade/next-major/prerelease rejection, probe success, missing token, timeout, and nonzero exit.
- [x] Run `npm.cmd test -- tests/unit/agents/compatibility-resolver.test.ts` and confirm RED because the resolver modules do not exist.
- [x] Implement strict version parsing, immutable manifests, stable contract hashes, conservative baseline-record cloning, and a validated runtime registry.
- [x] Add fake identity-provider tests for cache hit, TTL expiry, malformed JSON, executable identity mismatch, contract mismatch, bounded entries, and no leftover `.tmp` files.
- [x] Run the same test file and keep it GREEN; run `npm.cmd run typecheck`.

## Task 2: Integrate dynamic resolution into startup health probes

**Files:**
- Modify: `tests/integration/agents/health.test.ts`
- Modify: `tests/integration/app/startup-reconcile.test.ts`
- Modify: `src/agents/health/codex-health.ts`
- Modify: `src/agents/health/claude-health.ts`
- Modify: `src/agents/health/grok-health.ts`
- Modify: `src/config/app-paths.ts`
- Modify: `src/app/app-context.ts`

- [x] Add RED tests showing an unknown in-range version remains `unsupported_version` without a resolver but becomes `available` with a resolver-produced record; missing flags remain unsupported and Grok auth/readiness stays conservative.
- [x] Add RED AppPaths/startup tests for `cliCompatibilityCachePath` and one shared resolver/cache path passed to all three probes.
- [x] Replace fixed supported-version arrays with matrix/resolver lookup after existing version/auth/inspect checks. Append resolver probe evidence without weakening missing/timeout/malformed/auth handling.
- [x] Create the resolver once in `runProductionCapabilityProbes()` using the resolved app-data cache path; keep `--skip-health-probes` fail-closed for unknown versions.
- [x] Run `npm.cmd test -- tests/integration/agents/health.test.ts tests/integration/app/startup-reconcile.test.ts` and `npm.cmd run typecheck`.

## Task 3: Remove duplicate builder version locks and eliminate host-version tests

**Files:**
- Modify: `tests/unit/agents/codex-command.test.ts`
- Modify: `tests/unit/agents/claude-command.test.ts`
- Modify: `tests/unit/agents/grok-command.test.ts`
- Modify: `src/agents/codex/codex-command.ts`
- Modify: `src/agents/claude/claude-command.ts`
- Modify: `src/agents/grok/grok-command.ts`

- [x] Add RED tests passing newer-version records with exact key/platform and required capabilities; verify builders still reject a missing required capability.
- [x] Replace the Grok tests that execute local `grok --version` / `grok --help` with environment-independent manifest and dynamic-record tests.
- [x] Remove only the hard-coded exact-version comparisons and stale exact-version error text/comments; retain record/key/platform/capability/permission checks.
- [x] Run the three command test files plus health/resolver tests and `npm.cmd run typecheck`.

## Task 4: Offline verification, packaging, and installed smoke

**Files:**
- Modify: `README.md` if the user-visible behavior needs a short compatibility/cache note.
- Modify: root `task_plan.md`, `findings.md`, `progress.md` outside the worktree for persistent tracking.

- [x] Run `npm.cmd test` and record exact counts.
- [x] Run `npm.cmd run typecheck` and `npm.cmd run build`.
- [x] Run standard `npm.cmd run prepack`; it must not invoke real model calls and must no longer fail because the installed Grok patch version changed.
- [x] Pack from the just-verified build, inspect the allowlist, and cover-install the global command.
- [x] Smoke `triagent --help` and a startup with health probes skipped or injected/no-model behavior only. Do not start a real AI task.
- [x] Update planning/verification evidence and report any remaining explicit limitation.
