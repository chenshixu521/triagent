import React from 'react';
import { Box, Text } from 'ink';

import { uiText } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface SettingsScreenProps {
  readonly snapshot: TuiSnapshot;
  readonly settingsSummary?: {
    readonly codexCliPath?: string;
    readonly claudeCliPath?: string;
    readonly grokCliPath?: string;
    readonly totalRunningBudgetMinutes?: number;
    readonly perAttemptTimeoutMs?: number;
    readonly maxExternalCalls?: number;
    readonly reworkLimit?: number;
    readonly logRetentionDays?: number;
    readonly realAiTestsOptIn?: boolean;
  };
}

/**
 * Settings screen. Displays non-secret configuration only.
 * Screens must not import database/SQL/adapter/process implementations.
 * CLI path changes require capability re-probe before use (AppContext).
 */
export function SettingsScreen(props: SettingsScreenProps): React.ReactElement {
  const { snapshot, settingsSummary } = props;
  const summary = settingsSummary ?? {};

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">{uiText(snapshot.uiLanguage, 'settings.title')}</Text>
      {snapshot.statusMessage !== undefined ? (
        <Text>{snapshot.statusMessage}</Text>
      ) : (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'settings.description')}</Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text>
          Codex CLI: {summary.codexCliPath ?? 'codex'}
        </Text>
        <Text>
          Claude CLI: {summary.claudeCliPath ?? 'claude'}
        </Text>
        <Text>
          Grok CLI: {summary.grokCliPath ?? 'grok'}
        </Text>
        <Text>
          {uiText(snapshot.uiLanguage, 'settings.totalBudget')}:{' '}
          {summary.totalRunningBudgetMinutes ?? 60}
        </Text>
        <Text>
          {uiText(snapshot.uiLanguage, 'settings.attemptTimeout')}:{' '}
          {summary.perAttemptTimeoutMs ?? 15 * 60 * 1000}
        </Text>
        <Text>
          {uiText(snapshot.uiLanguage, 'settings.maxCalls')}: {summary.maxExternalCalls ?? 30}
        </Text>
        <Text>{uiText(snapshot.uiLanguage, 'settings.reworkLimit')}: {summary.reworkLimit ?? 3}</Text>
        <Text>
          {uiText(snapshot.uiLanguage, 'settings.retention')}: {summary.logRetentionDays ?? 30}
        </Text>
        <Text>
          {uiText(snapshot.uiLanguage, 'settings.realAi')}:{' '}
          {summary.realAiTestsOptIn === true ? 'true' : 'false'}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{uiText(snapshot.uiLanguage, 'settings.envWarning')}</Text>
      </Box>
    </Box>
  );
}
