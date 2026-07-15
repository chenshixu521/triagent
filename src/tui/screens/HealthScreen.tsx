import React from 'react';
import { Box, Text } from 'ink';

import { uiText } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface HealthScreenProps {
  readonly snapshot: TuiSnapshot;
}

export function HealthScreen(props: HealthScreenProps): React.ReactElement {
  const { snapshot } = props;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">{uiText(snapshot.uiLanguage, 'health.title')}</Text>
      <Text dimColor>{uiText(snapshot.uiLanguage, 'common.state')}: {snapshot.workflowState}</Text>
      {snapshot.loading ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'health.loading')}</Text>
      ) : null}
      {snapshot.error !== undefined ? (
        <Text color="red">{uiText(snapshot.uiLanguage, 'common.error')}: {snapshot.error}</Text>
      ) : (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'health.description')}</Text>
      )}
      <Text dimColor>{uiText(snapshot.uiLanguage, 'health.isolation')}</Text>
    </Box>
  );
}
