import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';

/**
 * Application settings: CLI paths and bounded resource limits.
 * No credentials, tokens, or secrets are accepted or persisted.
 */

export type UiLanguagePreference = 'auto' | 'zh-CN' | 'en';

export interface AppSettings {
  readonly codexCliPath: string;
  readonly claudeCliPath: string;
  readonly grokCliPath: string;
  /** Total active running budget in minutes (default 60). */
  readonly totalRunningBudgetMinutes: number;
  /** Per-attempt timeout in milliseconds. */
  readonly perAttemptTimeoutMs: number;
  /** Maximum external Agent calls per task. */
  readonly maxExternalCalls: number;
  /** Automatic rework limit (domain hard max 3). */
  readonly reworkLimit: number;
  /** Log retention days. */
  readonly logRetentionDays: number;
  /**
   * Real-AI test opt-in. Default false. Environment may enable at runtime
   * but must never be silently persisted as true.
   */
  readonly realAiTestsOptIn: boolean;
  /** UI language preference; auto follows the operating-system locale. */
  readonly uiLanguage: UiLanguagePreference;
}

export const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  codexCliPath: 'codex',
  claudeCliPath: 'claude',
  grokCliPath: 'grok',
  totalRunningBudgetMinutes: 60,
  perAttemptTimeoutMs: 15 * 60 * 1000,
  maxExternalCalls: 30,
  reworkLimit: 3,
  logRetentionDays: 30,
  realAiTestsOptIn: false,
  uiLanguage: 'auto',
});

const KNOWN_KEYS = new Set<keyof AppSettings>([
  'codexCliPath',
  'claudeCliPath',
  'grokCliPath',
  'totalRunningBudgetMinutes',
  'perAttemptTimeoutMs',
  'maxExternalCalls',
  'reworkLimit',
  'logRetentionDays',
  'realAiTestsOptIn',
  'uiLanguage',
]);

export type SettingsValidationResult =
  | { readonly ok: true; readonly settings: AppSettings }
  | { readonly ok: false; readonly error: string };

export interface SettingsBundle {
  /** Exactly what is (or would be) on disk — never elevated by env. */
  readonly persisted: AppSettings;
  /** Process-effective settings including runtime-only env overrides. */
  readonly effective: AppSettings;
  /** Keys elevated only for this process (e.g. realAiTestsOptIn). */
  readonly runtimeOnlyOverrides: readonly (keyof AppSettings)[];
}

function isFiniteBoundedInteger(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && Number.isSafeInteger(value)
    && value >= min
    && value <= max
  );
}

function isNonEmptyPathString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 1024;
}

function assertNoCredentialsKey(key: string): string | undefined {
  if (
    /token|secret|password|credential|api[_-]?key|authorization/i.test(key)
  ) {
    return `settings must not contain credential key: ${key}`;
  }
  return undefined;
}

function environmentOptInEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const flag = environment.TRIAGENT_REAL_AI_TESTS;
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/**
 * Validate settings fail-closed: unknown keys, non-finite numbers, empty paths,
 * or credential-shaped keys are rejected.
 */
export function validateSettings(
  input: unknown,
): SettingsValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'settings must be a JSON object' };
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const credentialError = assertNoCredentialsKey(key);
    if (credentialError !== undefined) {
      return { ok: false, error: credentialError };
    }
    if (!KNOWN_KEYS.has(key as keyof AppSettings)) {
      return { ok: false, error: `unknown settings key: ${key}` };
    }
  }

  const codexCliPath = record.codexCliPath ?? DEFAULT_SETTINGS.codexCliPath;
  const claudeCliPath = record.claudeCliPath ?? DEFAULT_SETTINGS.claudeCliPath;
  const grokCliPath = record.grokCliPath ?? DEFAULT_SETTINGS.grokCliPath;
  if (!isNonEmptyPathString(codexCliPath)) {
    return { ok: false, error: 'codexCliPath must be a non-empty path string' };
  }
  if (!isNonEmptyPathString(claudeCliPath)) {
    return { ok: false, error: 'claudeCliPath must be a non-empty path string' };
  }
  if (!isNonEmptyPathString(grokCliPath)) {
    return { ok: false, error: 'grokCliPath must be a non-empty path string' };
  }
  for (const [label, pathValue] of [
    ['codexCliPath', codexCliPath],
    ['claudeCliPath', claudeCliPath],
    ['grokCliPath', grokCliPath],
  ] as const) {
    if (pathValue.includes('\0') || /[<>"|?*]/.test(pathValue)) {
      return { ok: false, error: `${label} contains invalid path characters` };
    }
    if (isAbsolute(pathValue) && pathValue.split(/[/\\]/).includes('..')) {
      return { ok: false, error: `${label} must not contain path traversal` };
    }
    void normalize(pathValue);
  }

  const totalRunningBudgetMinutes =
    record.totalRunningBudgetMinutes ?? DEFAULT_SETTINGS.totalRunningBudgetMinutes;
  if (!isFiniteBoundedInteger(totalRunningBudgetMinutes, 1, 24 * 60)) {
    return {
      ok: false,
      error: 'totalRunningBudgetMinutes must be a finite integer in [1, 1440]',
    };
  }

  const perAttemptTimeoutMs =
    record.perAttemptTimeoutMs ?? DEFAULT_SETTINGS.perAttemptTimeoutMs;
  if (!isFiniteBoundedInteger(perAttemptTimeoutMs, 1_000, 24 * 60 * 60 * 1000)) {
    return {
      ok: false,
      error: 'perAttemptTimeoutMs must be a finite integer in [1000, 86400000]',
    };
  }

  const maxExternalCalls =
    record.maxExternalCalls ?? DEFAULT_SETTINGS.maxExternalCalls;
  if (!isFiniteBoundedInteger(maxExternalCalls, 1, 10_000)) {
    return {
      ok: false,
      error: 'maxExternalCalls must be a finite integer in [1, 10000]',
    };
  }

  const reworkLimit = record.reworkLimit ?? DEFAULT_SETTINGS.reworkLimit;
  if (!isFiniteBoundedInteger(reworkLimit, 0, 3)) {
    return {
      ok: false,
      error: 'reworkLimit must be a finite integer in [0, 3]',
    };
  }

  const logRetentionDays =
    record.logRetentionDays ?? DEFAULT_SETTINGS.logRetentionDays;
  if (!isFiniteBoundedInteger(logRetentionDays, 1, 3650)) {
    return {
      ok: false,
      error: 'logRetentionDays must be a finite integer in [1, 3650]',
    };
  }

  const realAiTestsOptIn =
    record.realAiTestsOptIn ?? DEFAULT_SETTINGS.realAiTestsOptIn;
  if (typeof realAiTestsOptIn !== 'boolean') {
    return { ok: false, error: 'realAiTestsOptIn must be a boolean' };
  }

  const uiLanguage = record.uiLanguage ?? DEFAULT_SETTINGS.uiLanguage;
  if (uiLanguage !== 'auto' && uiLanguage !== 'zh-CN' && uiLanguage !== 'en') {
    return { ok: false, error: 'uiLanguage must be auto, zh-CN, or en' };
  }

  return {
    ok: true,
    settings: Object.freeze({
      codexCliPath: codexCliPath.trim(),
      claudeCliPath: claudeCliPath.trim(),
      grokCliPath: grokCliPath.trim(),
      totalRunningBudgetMinutes,
      perAttemptTimeoutMs,
      maxExternalCalls,
      reworkLimit,
      logRetentionDays,
      realAiTestsOptIn,
      uiLanguage,
    }),
  };
}

export interface LoadSettingsOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /**
   * @deprecated Prefer {@link loadSettingsBundle}. When true, returns effective
   * settings with env opt-in applied — never write this object to disk.
   */
  readonly applyEnvironmentOptIn?: boolean;
}

function readPersistedSettings(settingsPath: string): AppSettings {
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`settings file is malformed JSON: ${settingsPath}`);
    }
    const validated = validateSettings(parsed);
    if (!validated.ok) {
      throw new Error(`settings validation failed: ${validated.error}`);
    }
    return validated.settings;
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === 'ENOENT') {
      return DEFAULT_SETTINGS;
    }
    throw error;
  }
}

/**
 * Load persisted disk settings and effective runtime settings separately.
 * TRIAGENT_REAL_AI_TESTS may elevate effective.realAiTestsOptIn only.
 */
export function loadSettingsBundle(
  settingsPath: string,
  options: LoadSettingsOptions = {},
): SettingsBundle {
  const persisted = readPersistedSettings(settingsPath);
  const environment = options.environment ?? process.env;
  const runtimeOnlyOverrides: (keyof AppSettings)[] = [];
  let effective: AppSettings = persisted;
  if (environmentOptInEnabled(environment) && !persisted.realAiTestsOptIn) {
    effective = Object.freeze({
      ...persisted,
      realAiTestsOptIn: true,
    });
    runtimeOnlyOverrides.push('realAiTestsOptIn');
  }
  return Object.freeze({
    persisted,
    effective,
    runtimeOnlyOverrides: Object.freeze([...runtimeOnlyOverrides]),
  });
}

/**
 * Load settings from disk. By default returns persisted settings only.
 * With applyEnvironmentOptIn, returns effective runtime settings (do not persist).
 */
export function loadSettings(
  settingsPath: string,
  options: LoadSettingsOptions = {},
): AppSettings {
  const bundle = loadSettingsBundle(settingsPath, options);
  if (options.applyEnvironmentOptIn === true) {
    return bundle.effective;
  }
  return bundle.persisted;
}

/**
 * Atomically persist settings. Always writes the validated persisted state —
 * never copy environment-elevated realAiTestsOptIn unless the user explicitly
 * opted in through settings UI/command (persisted.realAiTestsOptIn true).
 */
export function saveSettings(settingsPath: string, settings: AppSettings): void {
  const validated = validateSettings(settings);
  if (!validated.ok) {
    throw new Error(`refusing to persist invalid settings: ${validated.error}`);
  }
  const payload = JSON.stringify(validated.settings, null, 2);
  const directory = dirname(settingsPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, payload, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryPath, settingsPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort temp cleanup.
    }
    throw error;
  }
}

export function settingsToBudgetLimits(settings: AppSettings): {
  readonly totalActiveRuntimeMs: number;
  readonly perAttemptTimeoutMs: number;
  readonly maxExternalCalls: number;
} {
  return {
    totalActiveRuntimeMs: settings.totalRunningBudgetMinutes * 60 * 1000,
    perAttemptTimeoutMs: settings.perAttemptTimeoutMs,
    maxExternalCalls: settings.maxExternalCalls,
  };
}
