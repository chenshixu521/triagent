import React from 'react';
import { Box, Text } from 'ink';

import { uiText } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface HistoryScreenProps {
  readonly snapshot: TuiSnapshot;
}

export function HistoryScreen(props: HistoryScreenProps): React.ReactElement {
  const { snapshot } = props;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">{uiText(snapshot.uiLanguage, 'history.title')}</Text>
      {snapshot.taskId !== undefined ? (
        <Text>{uiText(snapshot.uiLanguage, 'history.currentTask')}: {snapshot.taskId}</Text>
      ) : (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'history.noRecent')}</Text>
      )}
      {snapshot.loading ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'history.loading')}</Text>
      ) : null}
      {snapshot.error !== undefined ? (
        <Text color="red">{uiText(snapshot.uiLanguage, 'common.error')}: {snapshot.error}</Text>
      ) : null}
      {snapshot.empty ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'history.empty')}</Text>
      ) : null}
    </Box>
  );
}
