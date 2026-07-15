import React from 'react';
import { Box, Text } from 'ink';

import type { WorkflowState } from '../../workflow/states.js';
import { uiText, type UiTextKey } from '../i18n.js';
import {
  formatAgentKind,
  type TuiSnapshot,
} from '../store.js';

export interface WorkflowPanelProps {
  readonly snapshot: TuiSnapshot;
}

const STEPS: readonly { readonly state: WorkflowState; readonly label: UiTextKey }[] = [
  { state: 'checking_environment', label: 'workflow.environment' },
  { state: 'planning', label: 'workflow.plan' },
  { state: 'awaiting_plan_approval', label: 'workflow.planApproval' },
  { state: 'implementing', label: 'workflow.implement' },
  { state: 'reviewing', label: 'workflow.review' },
  { state: 'master_validation', label: 'workflow.validate' },
  { state: 'completed', label: 'workflow.completed' },
];

function stepMarker(
  stepState: WorkflowState,
  current: WorkflowState,
): string {
  const order = STEPS.map((step) => step.state);
  const currentIndex = order.indexOf(current);
  const stepIndex = order.indexOf(stepState);
  if (current === stepState) return '●';
  if (currentIndex > stepIndex && stepIndex >= 0) return '✓';
  if (
    current === 'rework_requested' ||
    current === 'paused_after_run' ||
    current === 'interrupting' ||
    current === 'interrupted_needs_inspection' ||
    current === 'cleanup_failed' ||
    current === 'awaiting_user'
  ) {
    // Non-linear control states: mark only exact matches as active.
    return current === stepState ? '●' : '○';
  }
  return '○';
}

export function WorkflowPanel(props: WorkflowPanelProps): React.ReactElement {
  const { snapshot } = props;
  const roles = snapshot.roles;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{uiText(snapshot.uiLanguage, 'workflow.title')}</Text>
      {snapshot.taskId !== undefined ? (
        <Text>{uiText(snapshot.uiLanguage, 'common.task')}: {snapshot.taskId}</Text>
      ) : null}
      {snapshot.projectPath !== undefined ? (
        <Text>{uiText(snapshot.uiLanguage, 'common.project')}: {snapshot.projectPath}</Text>
      ) : null}
      {roles !== undefined ? (
        <Text>
          {uiText(snapshot.uiLanguage, 'common.roles')}: {' '}
          {uiText(snapshot.uiLanguage, 'start.master')}={formatAgentKind(roles.master)}{' '}
          {uiText(snapshot.uiLanguage, 'start.implementer')}={formatAgentKind(roles.implementer)}{' '}
          {uiText(snapshot.uiLanguage, 'start.reviewer')}={formatAgentKind(roles.reviewer)}
        </Text>
      ) : (
        <Text dimColor>
          {uiText(snapshot.uiLanguage, 'common.roles')}: {' '}
          {uiText(snapshot.uiLanguage, 'common.unassigned')}
        </Text>
      )}
      <Text>{uiText(snapshot.uiLanguage, 'common.state')}: {snapshot.workflowState}</Text>
      <Text>
        {uiText(snapshot.uiLanguage, 'common.process')}: {' '}
        {uiText(
          snapshot.uiLanguage,
          snapshot.processRunning ? 'common.running' : 'common.stopped',
        )}
      </Text>
      {snapshot.pauseAfterAttempt ? (
        <Text>{uiText(snapshot.uiLanguage, 'workflow.pauseAfter')}</Text>
      ) : null}
      <Text>
        {uiText(snapshot.uiLanguage, 'common.rework')} {snapshot.reworkCount}/
        {snapshot.maxReworks}
      </Text>
      {STEPS.map((step) => (
        <Text key={step.state}>
          {stepMarker(step.state, snapshot.workflowState)}{' '}
          {uiText(snapshot.uiLanguage, step.label)}
        </Text>
      ))}
      {snapshot.elapsedLabel !== undefined ? (
        <Text>{uiText(snapshot.uiLanguage, 'common.elapsed')}: {snapshot.elapsedLabel}</Text>
      ) : null}
    </Box>
  );
}
