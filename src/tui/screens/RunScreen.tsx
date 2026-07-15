import React from 'react';
import { Box, Text } from 'ink';

import { LogPanel } from '../components/LogPanel.js';
import { StatusBar } from '../components/StatusBar.js';
import { WorkflowPanel } from '../components/WorkflowPanel.js';
import { uiText } from '../i18n.js';
import { isNarrowLayout, type TuiSnapshot } from '../store.js';

export interface RunScreenProps {
  readonly snapshot: TuiSnapshot;
}

export function RunScreen(props: RunScreenProps): React.ReactElement {
  const { snapshot } = props;
  const narrow = isNarrowLayout(snapshot);

  return (
    <Box flexDirection="column" width="100%">
      <Box paddingX={1}>
        <Text bold color="cyan">
          TRIAGENT
          {snapshot.taskId !== undefined
            ? ` · ${uiText(snapshot.uiLanguage, 'common.task')} ${snapshot.taskId}`
            : ''}
          {snapshot.elapsedLabel !== undefined
            ? ` · ${snapshot.elapsedLabel}`
            : ''}
        </Text>
      </Box>
      {snapshot.error !== undefined ? (
        <Text color="red">
          {uiText(snapshot.uiLanguage, 'common.error')}: {snapshot.error}
        </Text>
      ) : null}
      {narrow ? (
        <Box flexDirection="column">
          {snapshot.activeNarrowPanel === 'workflow' ? (
            <WorkflowPanel snapshot={snapshot} />
          ) : (
            <LogPanel snapshot={snapshot} />
          )}
        </Box>
      ) : (
        <Box flexDirection="row" gap={1}>
          <Box width="40%">
            <WorkflowPanel snapshot={snapshot} />
          </Box>
          <Box width="60%">
            <LogPanel snapshot={snapshot} />
          </Box>
        </Box>
      )}
      <StatusBar snapshot={snapshot} />
    </Box>
  );
}
