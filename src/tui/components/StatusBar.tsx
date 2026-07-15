import React from 'react';
import { Box, Text } from 'ink';

import { uiText, type UiTextKey } from '../i18n.js';
import { recoveryActionHint } from '../recovery-actions.js';
import type { TuiSnapshot } from '../store.js';

export interface StatusBarProps {
  readonly snapshot: TuiSnapshot;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const { snapshot } = props;
  const terminalWorkflow =
    snapshot.workflowState === 'completed'
    || snapshot.workflowState === 'cancelled'
    || snapshot.workflowState === 'failed';

  let shortcuts: string;
  if (snapshot.screen === 'recovery') {
    const allowed = recoveryActionHint(
      snapshot.uiLanguage,
      snapshot.recoveryAllowedActions,
    );
    const extra =
      snapshot.recoveryAllowedActions.length > 0
        ? ` · [M] ${snapshot.uiLanguage === 'zh-CN' ? '上下文' : 'context'} · [Q] ${snapshot.uiLanguage === 'zh-CN' ? '退出' : 'exit'}`
        : ` · [Q] ${snapshot.uiLanguage === 'zh-CN' ? '退出' : 'exit'}`;
    shortcuts = `${allowed}${extra}`;
  } else {
    const shortcutKey: UiTextKey = snapshot.screen === 'project'
      ? 'status.projectShortcuts'
      : snapshot.screen === 'new_task'
        ? 'status.startShortcuts'
        : snapshot.screen === 'plan_approval'
          ? 'status.approvalShortcuts'
          : snapshot.screen === 'review' || terminalWorkflow
            ? 'status.reviewShortcuts'
            : snapshot.screen === 'run'
              ? 'status.runShortcuts'
              : 'status.defaultShortcuts';
    shortcuts = uiText(snapshot.uiLanguage, shortcutKey);
  }

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
      <Text dimColor>{shortcuts}</Text>
    </Box>
  );
}
