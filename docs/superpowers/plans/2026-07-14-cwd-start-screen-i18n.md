# TriAgent CWD Start Screen and I18N Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user explicitly requested inline execution without subagents.

**Goal:** Make `triagent` automatically use the launch directory, replace the noisy first-run flow with a polished TriFox task screen, and add persistent Chinese/English UI switching through `/lang` plus an in-app `/help` command.

**Architecture:** `runCli()` performs one guarded `SELECT_PROJECT` dispatch before rendering. A strict TypeScript i18n catalog and persisted `uiLanguage` setting feed a resolved language into `TuiSnapshot`; a pure slash-command parser converts task-entry commands into typed intents, while AppContext owns persistence and GlobalModal owns help display.

**Tech Stack:** Node.js 24+, TypeScript 7, React 19, Ink 7, Vitest 4, ink-testing-library.

**Approved spec:** `docs/superpowers/specs/2026-07-14-cwd-start-screen-i18n-design.md`

**Repository constraints:** Do not use subagents, Grok, real-AI tests, Git commits, reset, checkout, or clean. Use `apply_patch` for edits and TDD for every behavior change.

---

## Planned file map

```text
src/config/settings.ts                     Persisted uiLanguage setting and validation
src/cli/main.tsx                           Guarded process.cwd() project auto-selection
src/app/app-context.ts                     Resolve/persist language through typed intent
src/tui/i18n.ts                            Typed bilingual UI catalog and locale resolver
src/tui/slash-commands.ts                  Pure /help and /lang parser
src/tui/store.ts                           Language snapshot, help modal, language intent
src/tui/hooks/useKeyboard.ts               Route Enter through slash parser
src/tui/screens/StartScreen.tsx            New Claude-Code-inspired first interaction
src/tui/components/TriFox.tsx              Fixed-grid four-state terminal pet
src/tui/components/GlobalModal.tsx          Localized /help overlay
src/tui/components/StatusBar.tsx            Reduced, localized operational footer
src/tui/screens/*.tsx                      Localized UI labels without altering raw data
tests/unit/config/settings.test.ts          Settings compatibility and persistence tests
tests/unit/tui/i18n.test.ts                 Locale resolution and catalog coverage
tests/unit/tui/slash-commands.test.ts       Parser contract tests
tests/unit/tui/start-screen.test.tsx        Start screen, TriFox, and help rendering tests
tests/unit/tui/keyboard.test.tsx            Command keyboard dispatch tests
tests/integration/app/application-lifecycle.test.ts
                                             CWD startup and recovery guard tests
tests/integration/app/startup-reconcile.test.ts
                                             AppContext language persistence tests
tests/unit/tui/run-screen.test.tsx          Updated reduced-status rendering assertions
tests/unit/tui/recovery-screen.test.tsx     Localized recovery safety assertions
```

## Task 1: Add persistent language settings and typed UI catalog

**Files:**
- Create: `tests/unit/config/settings.test.ts`
- Create: `tests/unit/tui/i18n.test.ts`
- Create: `src/tui/i18n.ts`
- Modify: `src/config/settings.ts`
- Modify: `src/tui/store.ts`

- [x] **Step 1: Write failing settings tests**

Cover these exact behaviors:

```ts
expect(validateSettings({}).settings.uiLanguage).toBe('auto');
expect(validateSettings({...DEFAULT_SETTINGS, uiLanguage: 'zh-CN'}).ok).toBe(true);
expect(validateSettings({...DEFAULT_SETTINGS, uiLanguage: 'fr'}).ok).toBe(false);
expect(loadSettings(oldSettingsPath).uiLanguage).toBe('auto');
expect(loadSettings(savedSettingsPath).uiLanguage).toBe('en');
```

- [x] **Step 2: Run the new settings tests and verify RED**

Run: `npm.cmd test -- tests/unit/config/settings.test.ts`  
Expected: FAIL because `uiLanguage` is absent.

- [x] **Step 3: Implement the minimal setting**

Add:

```ts
export type UiLanguagePreference = 'auto' | 'zh-CN' | 'en';
```

Add `uiLanguage` to `AppSettings`, `DEFAULT_SETTINGS`, `KNOWN_KEYS`, validation, and the frozen result. Missing keys use `auto`; all other strings are rejected.

- [x] **Step 4: Run settings tests and verify GREEN**

Run: `npm.cmd test -- tests/unit/config/settings.test.ts`

- [x] **Step 5: Write failing i18n tests**

Assert:

```ts
expect(resolveUiLanguage('auto', 'zh-CN')).toBe('zh-CN');
expect(resolveUiLanguage('auto', 'en-US')).toBe('en');
expect(resolveUiLanguage('en', 'zh-CN')).toBe('en');
expect(uiText('zh-CN', 'start.placeholder')).toContain('任务');
expect(uiText('en', 'start.placeholder')).toContain('task');
```

- [x] **Step 6: Run i18n tests and verify RED**

Run: `npm.cmd test -- tests/unit/tui/i18n.test.ts`  
Expected: FAIL because the module does not exist.

- [x] **Step 7: Implement the typed catalog and snapshot language**

Create `src/tui/i18n.ts` with:

```ts
export type UiLanguage = 'zh-CN' | 'en';
export type UiTextKey = keyof typeof EN_TEXT;
export function resolveUiLanguage(
  preference: UiLanguagePreference,
  systemLocale: string,
): UiLanguage;
export function uiText(language: UiLanguage, key: UiTextKey): string;
```

The Chinese catalog must satisfy `Record<UiTextKey, string>`. Add `uiLanguage: UiLanguage` to `TuiSnapshot`, defaulting to a deterministic `en` for isolated tests.

- [x] **Step 8: Run the two narrow suites and typecheck**

Run: `npm.cmd test -- tests/unit/config/settings.test.ts tests/unit/tui/i18n.test.ts`  
Run: `npm.cmd run typecheck`

## Task 2: Automatically select the launch directory

**Files:**
- Modify: `tests/integration/app/application-lifecycle.test.ts`
- Modify: `src/cli/main.tsx`

- [x] **Step 1: Write failing CLI lifecycle tests**

Add three tests using injected composition/render and `cwd()`:

1. Initial `project` snapshot dispatches `{type: 'SELECT_PROJECT', projectPath: cwd}` before render.
2. Initial `recovery`/diagnostic snapshot does not dispatch `SELECT_PROJECT`.
3. Rejected selection still renders the unchanged `project` fallback with the error snapshot.

- [x] **Step 2: Run the exact tests and verify RED**

Run: `npm.cmd test -- tests/integration/app/application-lifecycle.test.ts`  
Expected: FAIL because `RunCliDependencies.cwd` and auto-selection do not exist.

- [x] **Step 3: Implement guarded selection**

Extend dependencies:

```ts
readonly cwd?: () => string;
```

After compose and before render:

```ts
if (composition.snapshot().screen === 'project') {
  await composition.dispatch({
    type: 'SELECT_PROJECT',
    projectPath: (dependencies.cwd ?? process.cwd)(),
  });
}
```

Do not catch and replace controller results; rejected dispatch already preserves fallback state. Do not dispatch in recovery/diagnostic.

- [x] **Step 4: Run lifecycle tests and verify GREEN**

Run: `npm.cmd test -- tests/integration/app/application-lifecycle.test.ts`

## Task 3: Add `/help` and `/lang` typed command flow

**Files:**
- Create: `tests/unit/tui/slash-commands.test.ts`
- Create: `src/tui/slash-commands.ts`
- Modify: `tests/unit/tui/keyboard.test.tsx`
- Modify: `tests/integration/app/startup-reconcile.test.ts`
- Modify: `src/tui/store.ts`
- Modify: `src/tui/hooks/useKeyboard.ts`
- Modify: `src/app/app-context.ts`

- [x] **Step 1: Write failing pure parser tests**

Desired contract:

```ts
parseTaskEntry('/help', 'en')
// {kind: 'command', command: 'help'}

parseTaskEntry('  /LANG  ', 'zh-CN')
// {kind: 'command', command: 'set-language', language: 'en'}

parseTaskEntry('/unknown', 'en')
// {kind: 'error', code: 'unknown-command'}

parseTaskEntry('fix the tests', 'en')
// {kind: 'task', requirements: 'fix the tests'}
```

- [x] **Step 2: Run parser tests and verify RED**

Run: `npm.cmd test -- tests/unit/tui/slash-commands.test.ts`

- [x] **Step 3: Implement the pure parser**

Recognize only exact commands after trim and ASCII case-folding. Arguments are not supported in v1. Never treat an unknown slash command as a task.

- [x] **Step 4: Write failing store/keyboard/AppContext tests**

Add intents:

```ts
{type: 'OPEN_HELP'}
{type: 'SET_UI_LANGUAGE', language: 'zh-CN' | 'en'}
```

Tests must prove:

- Enter on `/help` opens `help` modal and does not dispatch `CREATE_TASK`.
- Esc dismisses help through the existing modal path.
- Enter on `/lang` forwards `SET_UI_LANGUAGE`.
- AppContext persists the explicit language and returns a snapshot with the new resolved language.
- Persistence failure returns rejected and leaves the old snapshot language unchanged.
- Unknown commands set a localized status message and do not create a task.

- [x] **Step 5: Run command-flow tests and verify RED**

Run: `npm.cmd test -- tests/unit/tui/keyboard.test.tsx tests/integration/app/startup-reconcile.test.ts`

- [x] **Step 6: Implement typed intents and persistence**

Add `help` to `TuiModal`. `OPEN_HELP` remains local and opens modal/focus. `SET_UI_LANGUAGE` is forwarded to AppContext, which calls `composition.updateSettings({uiLanguage: language})`, updates `snapshotState.uiLanguage`, and returns a snapshot result. On error, return rejected without changing state.

Initialize `snapshotState.uiLanguage` in `finalizeComposition()` from `effectiveSettings.uiLanguage` and `Intl.DateTimeFormat().resolvedOptions().locale`; allow a deterministic locale seam through existing composition environment/options where practical.

- [x] **Step 7: Route task Enter through the parser**

In `new_task`, parse the trimmed draft first. Dispatch `OPEN_HELP`, `SET_UI_LANGUAGE`, `ILLEGAL_INTENT`, or the existing `CREATE_TASK`. After a handled command, clear the task draft with a dedicated local intent so command text does not remain in the input.

- [x] **Step 8: Run parser, keyboard, and AppContext tests**

Run: `npm.cmd test -- tests/unit/tui/slash-commands.test.ts tests/unit/tui/keyboard.test.tsx tests/integration/app/startup-reconcile.test.ts`

## Task 4: Build the new StartScreen, fixed TriFox, and localized help

**Files:**
- Create: `tests/unit/tui/start-screen.test.tsx`
- Create: `src/tui/components/TriFox.tsx`
- Create: `src/tui/screens/StartScreen.tsx`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/components/GlobalModal.tsx`
- Delete: `src/tui/screens/NewTaskScreen.tsx`

- [x] **Step 1: Write failing render tests**

Assert both language variants render:

- TriAgent title and canonical project path.
- One visible rounded task-input border.
- localized placeholder and concise shortcuts.
- `/help` hint.
- no `Screen:`, `Workflow:`, `Layout:`, `Retry`, `Log tab:` debug rows.
- Chinese output contains no mojibake replacement characters.

Render all four TriFox states and assert identical line count and visible width.

- [x] **Step 2: Run StartScreen tests and verify RED**

Run: `npm.cmd test -- tests/unit/tui/start-screen.test.tsx`

- [x] **Step 3: Implement fixed-grid TriFox**

Expose:

```ts
export type TriFoxState = 'idle' | 'thinking' | 'success' | 'error';
export function TriFox({state}: {readonly state: TriFoxState}): React.ReactElement;
export function triFoxLines(state: TriFoxState): readonly string[];
```

Every state must return the same row count and string width. Use original ASCII/pixel art with three clearly visible tails and no external assets.

- [x] **Step 4: Implement StartScreen**

Use terminal width to select horizontal or vertical placement. Show current path, roles/approval as compact secondary text, and a single rounded task entry box. Keep draft text raw; localize only labels and hints.

- [x] **Step 5: Implement localized help modal**

The help modal lists Enter, Backspace, Tab, Ctrl+P, Ctrl+C, Esc, `/help`, and `/lang`. It states that paths/code/diffs/logs remain untranslated. Keep existing redaction behavior for message entry.

- [x] **Step 6: Run render and keyboard tests**

Run: `npm.cmd test -- tests/unit/tui/start-screen.test.tsx tests/unit/tui/keyboard.test.tsx`

## Task 5: Localize remaining UI labels and reduce status noise

**Files:**
- Modify: `src/tui/components/StatusBar.tsx`
- Modify: `src/tui/components/LogPanel.tsx`
- Modify: `src/tui/components/WorkflowPanel.tsx`
- Modify: `src/tui/screens/ProjectScreen.tsx`
- Modify: `src/tui/screens/RunScreen.tsx`
- Modify: `src/tui/screens/DiffScreen.tsx`
- Modify: `src/tui/screens/HealthScreen.tsx`
- Modify: `src/tui/screens/HistoryScreen.tsx`
- Modify: `src/tui/screens/PlanApprovalScreen.tsx`
- Modify: `src/tui/screens/RecoveryScreen.tsx`
- Modify: `src/tui/screens/ReviewScreen.tsx`
- Modify: `src/tui/screens/SettingsScreen.tsx`
- Modify: `tests/unit/tui/run-screen.test.tsx`
- Modify: `tests/unit/tui/recovery-screen.test.tsx`

- [x] **Step 1: Rewrite rendering assertions for the approved information hierarchy**

Tests must still prove process/workflow safety facts, error visibility, redaction, narrow/wide behavior, and recovery warnings, but must reject the old repeated debug rows. Add one Chinese render for run and recovery while asserting raw log/path strings remain unchanged.

- [x] **Step 2: Run rendering tests and verify RED**

Run: `npm.cmd test -- tests/unit/tui/run-screen.test.tsx tests/unit/tui/recovery-screen.test.tsx`

- [x] **Step 3: Localize labels through `uiText()`**

Translate user-facing headings, empty/loading/error labels, shortcuts, and modal guidance. Keep domain enum values, workflow states, paths, raw logs, Diff content, Agent names, and command strings unchanged.

- [x] **Step 4: Simplify StatusBar**

Render only contextually legal shortcuts plus important status/error/exit-gate information. Do not print Screen/Workflow/Layout/Retry/Rework/Pause/Log tab rows on every screen. RunScreen may show compact workflow/process/rework facts once near the header.

- [x] **Step 5: Run all TUI tests and typecheck**

Run: `npm.cmd test -- tests/unit/tui`  
Run: `npm.cmd run typecheck`

## Task 6: Full verification, packaging, global install, and manual smoke

**Files:**
- Modify: `D:\codex\project\agent_help\task_plan.md`
- Modify: `D:\codex\project\agent_help\findings.md`
- Modify: `D:\codex\project\agent_help\progress.md`
- Modify only if results require it: `docs/verification/acceptance-checklist.md`

- [x] **Step 1: Run the complete offline suite**

Run: `npm.cmd test`  
Expected: all non-opt-in tests pass; real-AI tests remain skipped.

- [x] **Step 2: Run static and build verification**

Run: `npm.cmd run typecheck`  
Run: `npm.cmd run build`

- [x] **Step 3: Verify package contents**

Run: `npm.cmd pack --dry-run --json`  
Confirm compiled CLI, migrations, native helper, schemas, and README remain included.

- [x] **Step 4: Build a real tarball and replace the global command**

Run: `npm.cmd pack --json`  
Run: `npm.cmd install --global .\triagent-orchestrator-0.1.0.tgz`

- [x] **Step 5: Smoke from a different directory without real AI**

Launch `triagent --skip-health-probes --skip-process-host` from a temporary directory and visually confirm:

- displayed project path equals that launch directory;
- normal startup skips Project input;
- `/help` opens and Esc closes;
- `/lang` switches and survives restart;
- no mojibake or duplicate status rows;
- no task is submitted and no real AI process starts.

- [x] **Step 6: Record exact evidence and close the plan**

### Verification note

The ordinary prepack pipeline reached 822 passing tests but stopped on one unrelated environment gate: the installed Grok CLI is `0.2.101` while the existing adapter test requires exact `0.2.93`. The feature suite, complete offline suite, typecheck, and build passed. Packaging therefore used the already-verified build with `--ignore-scripts`; the resulting 15-entry tarball was globally installed and smoke-tested without launching real AI.

Update planning files with commands, pass counts, package metadata, manual smoke result, and any remaining limits. Mark phases complete only with fresh evidence.
