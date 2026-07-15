import React from 'react';
import { Box, Text } from 'ink';

import { ActivityFeed } from '../components/ActivityFeed.js';
import { StatusBar } from '../components/StatusBar.js';
import { WorkflowPanel } from '../components/WorkflowPanel.js';
import { WorkflowStepper } from '../components/WorkflowStepper.js';
import { uiText } from '../i18n.js';
import {
  formatAgentKind,
  isNarrowLayout,
  type TuiSnapshot,
} from '../store.js';

export interface RunScreenProps {
  readonly snapshot: TuiSnapshot;
}

/**
 * Work-status screen — strictly follows docs/design/work-status-v2.html:
 * header · roles · stepper · left workflow meta · right activity feed · footer shortcuts
 */
export function RunScreen(props: RunScreenProps): React.ReactElement {
  const { snapshot } = props;
  const narrow = isNarrowLayout(snapshot);
  const roles = snapshot.roles;
  const working = snapshot.loading || snapshot.processRunning;
  const done =
    snapshot.workflowState === 'completed'
    || snapshot.workflowState === 'cancelled'
    || snapshot.workflowState === 'failed';

  return (
    <Box flexDirection="column" width="100%">
      <Box paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          TRIAGENT
          {snapshot.taskId !== undefined
            ? ` · ${uiText(snapshot.uiLanguage, 'common.task')} ${snapshot.taskId}`
            : ''}
          {snapshot.elapsedLabel !== undefined
            ? ` · ${snapshot.elapsedLabel}`
            : ''}
          {working ? (
            <Text color="yellow">
              {' '}· ● {uiText(snapshot.uiLanguage, 'activity.working')}
            </Text>
          ) : done ? (
            <Text color="green">
              {' '}· ✓ {uiText(snapshot.uiLanguage, 'workflow.completed')}
            </Text>
          ) : null}
        </Text>
        {roles !== undefined ? (
          <Text dimColor>
            {uiText(snapshot.uiLanguage, 'start.master')}={formatAgentKind(roles.master)}
            {' · '}
            {uiText(snapshot.uiLanguage, 'start.implementer')}={formatAgentKind(roles.implementer)}
            {' · '}
            {uiText(snapshot.uiLanguage, 'start.reviewer')}={formatAgentKind(roles.reviewer)}
          </Text>
        ) : null}
      </Box>

      <WorkflowStepper snapshot={snapshot} />

      {snapshot.error !== undefined ? (
        <Box paddingX={1}>
          <Text color="red">
            {uiText(snapshot.uiLanguage, 'common.error')}: {snapshot.error}
          </Text>
        </Box>
      ) : null}

      {narrow ? (
        <Box flexDirection="column">
          {snapshot.activeNarrowPanel === 'workflow' ? (
            <WorkflowPanel snapshot={snapshot} />
          ) : (
            <ActivityFeed snapshot={snapshot} />
          )}
        </Box>
      ) : (
        <Box flexDirection="row" gap={1}>
          <Box width="34%">
            <WorkflowPanel snapshot={snapshot} />
          </Box>
          <Box width="66%">
            <ActivityFeed snapshot={snapshot} />
          </Box>
        </Box>
      )}
      <StatusBar snapshot={snapshot} />
    </Box>
  );
}
