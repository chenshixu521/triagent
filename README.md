# TriAgent Orchestrator

Windows-first terminal orchestrator that coordinates three collaborating coding agents (planner / implementer / reviewer roles) through a supervised workflow. Durable state lives outside your project tree; every real agent process is supervised by a native Windows Job Object helper.

This is **best-effort** orchestration with explicit guardrails and limits. It does **not** promise a perfect sandbox, code signing of the helper, perfect security isolation, or complete protection against a malicious or compromised CLI.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Windows x64** | Primary supported platform for the packaged native helper. |
| **Node.js ≥ 24** | Matches `engines.node` and `@types/node` 24. Use `npm.cmd` on Windows. |
| **.NET 10 SDK** | Required only to **build** the native ProcessHost from source (`net10.0`). Install from [dotnet.microsoft.com/download](https://dotnet.microsoft.com/download). Build scripts **will not** download SDKs or toolchains automatically. |
| **PowerShell** | Used by `build:native` (`scripts/build-native.ps1`). |
| **Agent CLIs** | Existing vendor CLIs must already be installed and **logged in / authenticated** by you. TriAgent does **not** store credentials, API tokens, or login cookies. |

## Install (global, from a packed tarball)

```powershell
npm.cmd run build
npm.cmd pack --ignore-scripts
npm.cmd install -g .\triagent-orchestrator-0.1.0.tgz
triagent --help
```

The packed tarball is large (~70–100+ MB) because it includes a **self-contained** win-x64 ProcessHost helper. That size is expected.

Local development:

```powershell
npm.cmd install
npm.cmd run build
node dist/cli.js --help
```

### Build scripts

| Script | Behavior |
| --- | --- |
| `npm.cmd run build:native` | Fresh publish of ProcessHost to a unique staging dir, validate PE x64, atomically promote to stable publish path. Fails if the exact new exe is missing (never silently reuses a stale prebuilt). |
| `npm.cmd run build:trust` | Computes helper SHA-256 / length / PE machine and writes `src/process/generated-native-helper-trust.ts` (deterministic constants only). |
| `npm.cmd run build:node` | Bundles the CLI with tsup (`dist/cli.js` + source map), embedding trust constants and copying runtime SQLite migrations into `dist/migrations/`. |
| `npm.cmd run build:copy-native` | Locked secure copy into `dist/native/win-x64/` with backup-swap atomic replace; verifies against embedded trust. |
| `npm.cmd run build` | Orchestrated under an interprocess lock: native → trust → node → copy. |
| `npm.cmd run prepack` | Locked `test` → `typecheck` → `build`. Set `TRIAGENT_SKIP_PREPACK=1` or use `npm pack --ignore-scripts` in packaging e2e to avoid recursive prepack loops. |
| `npm.cmd run typecheck` | `tsc --noEmit`. |
| `npm.cmd test` | Vitest. |

### Packaged allowlist (`files`)

Only these paths ship:

- `dist/cli.js` (+ intended `dist/cli.js.map`)
- `dist/migrations/*.sql`
- `dist/native/win-x64/triagent-process-host.exe`
- `dist/native/win-x64/checksum-metadata.json`
- `dist/native/win-x64/triagent-process-host.sha256`
- `schemas/`
- `README.md`

Excluded: `src/`, tests, docs/plans, worktrees, logs, databases, snapshots, settings, tokens, env files, tarballs, native source/build intermediates, and all transient `.tmp` / `.bak` / dotfiles under `dist/native`.

### Helper trust and fail-closed validation

Runtime discovery resolves **only** the package-relative path:

`dist/native/win-x64/triagent-process-host.exe`

Before enabling real runs it verifies:

- package containment before/after open/stat/hash;
- regular file, **not** reparse/symlink;
- `nlink === 1` (hardlink anomaly rejected);
- SHA-256 and byte length match **embedded** trust constants compiled into `dist/cli.js` (adjacent metadata alone is not the trust anchor; swapping exe+metadata fails);
- PE machine is exactly `0x8664` (win-x64) — undefined architecture is rejected.

Missing or mismatched helpers **disable real runs fail-closed** with a diagnostic. TriAgent never searches `PATH`, cwd, project trees, or temp for a substitute helper. Production APIs do **not** accept an arbitrary helper path override (CLI/settings/env cannot select one). Tests may inject a fake helper only through an explicit test-only factory that cannot be selected by untrusted input.

Build/copy use an interprocess lock so concurrent `build` / `copy-native` / pack steps serialize and leave zero tmp/bak/lock artifacts on success.

There is **no** Authenticode / code-signing guarantee for the helper in this package.

## CLI usage

```text
triagent [options]

  --help                 Show help and exit (does not start the app)
  --diagnostic           Open in database diagnostic / recovery-oriented mode
  --app-root <path>      Override durable app data root (tests; absolute path)
  --skip-health-probes   Skip adapter capability/health probes at startup
  --skip-process-host    Do not start the native ProcessHost helper
```

Help does not compose the application, does not open the project database, and does not launch adapters, workers, or the native helper.

### Exit and process policy

- The CLI **never detaches** from the terminal session.
- Handlers return testable exit codes and set `process.exitCode`; they do **not** bypass cleanup with an early `process.exit` while Job Objects / workers may still be live.
- Shutdown is fail-closed: exit is blocked until cleanup is authorized.

## Auth and agent CLIs

TriAgent drives **existing** vendor CLIs. Complete each vendor’s own login / auth flow before real runs. TriAgent does not collect or persist API keys, OAuth tokens, or session cookies, and does not embed machine-specific absolute paths in the published package.

### CLI upgrade compatibility

At startup TriAgent reads the installed Codex, Claude, and Grok versions. Built-in baseline versions use the static compatibility matrix. A newer version inside the supported major range is accepted only after fixed, no-model `--help` / `inspect --help` probes confirm every flag used by the current command templates. Missing flags, timeouts, nonzero exits, prerelease versions, downgrades, and next-major versions remain disabled.

Successful probe receipts are cached for seven days at `%LOCALAPPDATA%\TriAgent\cli-compatibility-cache.json` (or the test `--app-root`). Receipts are bound to CLI/version/platform, launcher path and SHA-256, and the probe-contract hash; expiry or any identity/contract change forces a new probe. The cache contains no capability booleans, credentials, or prompts. TriAgent does not automatically edit itself or invent replacement flags. `--skip-health-probes` also skips dynamic-version discovery, so unknown versions remain fail-closed for that launch.

## Guardrails and limits (best-effort)

- Project path policy and patch validation try to block path escapes, arbitrary shell, and dependency installs — **best-effort**, not a security boundary against a hostile agent binary.
- Runtime and call budgets are persisted and enforced across restart.
- Reviewer / master roles are treated as read-only relative to project writes when adapters honor their profiles.
- Implementer rework is capped (including a **3-rework** product limit).
- Windows Job Objects supervise process trees for real runs; cleanup is verified with PID + start-time identity.
- Corrupted SQLite opens **diagnostic** mode: side effects disabled.

Do **not** treat TriAgent as a perfect multi-tenant sandbox or as a substitute for OS-level isolation.

## Git and non-Git projects

- **Git projects**: baselines use read-only git inspection. Dirty state is preserved; the baseline module does not reset, checkout, clean, commit, or push.
- **Non-Git projects**: file baselines and snapshots are used; reparse/symlink metadata is recorded carefully and external escapes fail closed where enforced.

## Workflow features

- Dynamic role selection among the three collaborating agents.
- Review and rework loops with structured results and master validation.
- Crash recovery / reconcile on startup.
- Settings under the durable app root (not in the project). Runtime-only overrides are not auto-persisted as credentials.

## Durable data location

On Windows, durable data defaults to `%LOCALAPPDATA%\TriAgent` (SQLite, JSONL logs, snapshots, native-helper diagnostics, settings). Never the project cwd. Override only for tests with `--app-root` / `TRIAGENT_APP_ROOT` (absolute path).

## Tests

```powershell
npm.cmd test
npm.cmd run typecheck
```

### Real AI tests (opt-in, disabled by default)

```powershell
$env:TRIAGENT_REAL_AI_TESTS = '1'
npm.cmd test -- tests/e2e/real-cli-smoke.test.ts
```

Without `TRIAGENT_REAL_AI_TESTS=1`, suites must not place live AI calls.

## License

Private package (`"private": true`) unless a license file is added later.
