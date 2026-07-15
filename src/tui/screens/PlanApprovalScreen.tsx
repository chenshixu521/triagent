import React from 'react';
import { Box, Text } from 'ink';

import { uiText } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface PlanApprovalScreenProps {
  readonly snapshot: TuiSnapshot;
}

export function PlanApprovalScreen(
  props: PlanApprovalScreenProps,
): React.ReactElement {
  const { snapshot } = props;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">{uiText(snapshot.uiLanguage, 'approval.title')}</Text>
      <Text dimColor>{uiText(snapshot.uiLanguage, 'common.state')}: {snapshot.workflowState}</Text>
      <Text>
        {uiText(snapshot.uiLanguage, 'common.process')}: {' '}
        {uiText(
          snapshot.uiLanguage,
          snapshot.processRunning ? 'common.running' : 'common.stopped',
        )}
      </Text>
      <Text>
        {uiText(snapshot.uiLanguage, 'approval.approve')}: {' '}
        {snapshot.canApprove
          ? `${uiText(snapshot.uiLanguage, 'common.available')} (A)`
          : uiText(snapshot.uiLanguage, 'common.notLegal')}
      </Text>
      {snapshot.loading ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'approval.loading')}</Text>
      ) : null}
      {snapshot.error !== undefined ? (
        <Text color="red">{uiText(snapshot.uiLanguage, 'common.error')}: {snapshot.error}</Text>
      ) : null}
      {snapshot.empty ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'approval.empty')}</Text>
      ) : null}
    </Box>
  );
}
