import React from 'react';
import { Box, Text } from 'ink';

import { uiText, type UiTextKey } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface StatusBarProps {
  readonly snapshot: TuiSnapshot;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const { snapshot } = props;
  const shortcutKey: UiTextKey = snapshot.screen === 'project'
    ? 'status.projectShortcuts'
    : snapshot.screen === 'recovery'
      ? 'status.recoveryShortcuts'
      : snapshot.screen === 'plan_approval'
        ? 'status.approvalShortcuts'
        : snapshot.screen === 'review'
          ? 'status.reviewShortcuts'
          : snapshot.screen === 'run'
            ? 'status.runShortcuts'
            : 'status.defaultShortcuts';

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {snapshot.exitGate !== undefined && !snapshot.exitGate.allowed ? (
        <Text color="red">
          {uiText(snapshot.uiLanguage, 'status.exitBlocked')}:{' '}
          {snapshot.exitGate.reason
            ?? uiText(snapshot.uiLanguage, 'status.cleanupIncomplete')}
        </Text>
      ) : null}
      {snapshot.statusMessage !== undefined ? (
        <Text dimColor>{snapshot.statusMessage}</Text>
      ) : null}
      <Text dimColor>{uiText(snapshot.uiLanguage, shortcutKey)}</Text>
    </Box>
  );
}
