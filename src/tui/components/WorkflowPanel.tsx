import React from 'react';
import { Box, Text } from 'ink';

import { uiText } from '../i18n.js';
import {
  formatAgentKind,
  type TuiSnapshot,
} from '../store.js';

export interface WorkflowPanelProps {
  readonly snapshot: TuiSnapshot;
}

function currentRoleLabel(snapshot: TuiSnapshot): string | undefined {
  if (snapshot.activeRole !== undefined) return snapshot.activeRole;
  switch (snapshot.workflowState) {
    case 'planning':
    case 'master_validation':
      return 'master';
    case 'implementing':
      return 'implementer';
    case 'reviewing':
      return 'reviewer';
    default:
      return undefined;
  }
}

function adapterForRole(snapshot: TuiSnapshot): string | undefined {
  if (snapshot.activeAdapter !== undefined) {
    return snapshot.activeAdapter;
  }
  const role = currentRoleLabel(snapshot);
  if (role === undefined || snapshot.roles === undefined) return undefined;
  if (role === 'master') return formatAgentKind(snapshot.roles.master);
  if (role === 'implementer') return formatAgentKind(snapshot.roles.implementer);
  return formatAgentKind(snapshot.roles.reviewer);
}

/**
 * Left detail panel — design docs/design/work-status-v2.html:
 * 工作流 / 结果摘要 with state, process, rework, current role, adapter, scope.
 */
export function WorkflowPanel(props: WorkflowPanelProps): React.ReactElement {
  const { snapshot } = props;
  const language = snapshot.uiLanguage;
  const done =
    snapshot.workflowState === 'completed'
    || snapshot.workflowState === 'cancelled'
    || snapshot.workflowState === 'failed';
  const role = currentRoleLabel(snapshot);
  const adapter = adapterForRole(snapshot);
  const scope =
    snapshot.executionScopeLabel
    ?? (role === 'implementer' && snapshot.roles?.implementer === 'grok'
      ? uiText(language, 'workflow.scopeCandidate')
      : uiText(language, 'workflow.scopeProject'));

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {done
          ? uiText(language, 'workflow.resultTitle')
          : uiText(language, 'workflow.title')}
      </Text>
      <Text dimColor>
        {uiText(language, 'common.state')}: {snapshot.workflowState}
      </Text>
      <Text dimColor>
        {uiText(language, 'common.process')}:{' '}
        {uiText(
          language,
          snapshot.processRunning ? 'common.running' : 'common.stopped',
        )}
      </Text>
      <Text dimColor>
        {uiText(language, 'common.rework')} {snapshot.reworkCount}/
        {snapshot.maxReworks}
      </Text>
      {done ? (
        <Text color="green">{uiText(language, 'workflow.validationPassed')}</Text>
      ) : null}
      {role !== undefined ? (
        <Text dimColor>
          {uiText(language, 'workflow.currentRole')}: {role}
        </Text>
      ) : null}
      {adapter !== undefined ? (
        <Text dimColor>
          {uiText(language, 'workflow.adapter')}: {adapter}
        </Text>
      ) : null}
      {!done ? (
        <Text dimColor>
          {uiText(language, 'workflow.scope')}: {scope}
        </Text>
      ) : null}
      {snapshot.pauseAfterAttempt ? (
        <Text>{uiText(language, 'workflow.pauseAfter')}</Text>
      ) : null}
      {snapshot.elapsedLabel !== undefined ? (
        <Text dimColor>
          {uiText(language, 'common.elapsed')}: {snapshot.elapsedLabel}
        </Text>
      ) : null}
    </Box>
  );
}
