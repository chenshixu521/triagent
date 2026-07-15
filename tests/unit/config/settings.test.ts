import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  validateSettings,
} from '../../../src/config/settings.js';

const temporaryRoots: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'triagent-settings-unit-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('UI language settings', () => {
  it('defaults missing uiLanguage to auto for backward compatibility', () => {
    const validated = validateSettings({});
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.error);

    expect(validated.settings.uiLanguage).toBe('auto');
    expect(DEFAULT_SETTINGS.uiLanguage).toBe('auto');
  });

  it.each(['auto', 'zh-CN', 'en'] as const)(
    'accepts supported uiLanguage value %s',
    (uiLanguage) => {
      const validated = validateSettings({
        ...DEFAULT_SETTINGS,
        uiLanguage,
      });
      expect(validated.ok).toBe(true);
      if (!validated.ok) throw new Error(validated.error);
      expect(validated.settings.uiLanguage).toBe(uiLanguage);
    },
  );

  it('rejects unsupported uiLanguage values', () => {
    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        uiLanguage: 'fr',
      }).ok,
    ).toBe(false);
  });

  it('loads an old settings file without uiLanguage as auto', () => {
    const root = temporaryDirectory();
    const settingsPath = join(root, 'settings.json');
    const legacySettings = {
      codexCliPath: 'codex',
      claudeCliPath: 'claude',
      grokCliPath: 'grok',
      totalRunningBudgetMinutes: 60,
      perAttemptTimeoutMs: 15 * 60 * 1000,
      maxExternalCalls: 30,
      reworkLimit: 3,
      logRetentionDays: 30,
      realAiTestsOptIn: false,
    };
    writeFileSync(settingsPath, JSON.stringify(legacySettings), 'utf8');

    expect(loadSettings(settingsPath).uiLanguage).toBe('auto');
  });

  it('persists and reloads an explicit language', () => {
    const root = temporaryDirectory();
    const settingsPath = join(root, 'settings.json');
    const validated = validateSettings({
      ...DEFAULT_SETTINGS,
      uiLanguage: 'en',
    });
    if (!validated.ok) throw new Error(validated.error);

    saveSettings(settingsPath, validated.settings);

    expect(loadSettings(settingsPath).uiLanguage).toBe('en');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({
      uiLanguage: 'en',
    });
  });
});
