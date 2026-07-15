import React from 'react';
import { Box, Text } from 'ink';

import type { WorkflowState } from '../../workflow/states.js';
import { uiText, type UiTextKey } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface WorkflowStepperProps {
  readonly snapshot: TuiSnapshot;
}

/** Short labels matching design: 环境 → 规划 → 审批 → 实施 → 审查 → 终检 → 完成 */
const STEPS: readonly { readonly state: WorkflowState; readonly label: UiTextKey }[] = [
  { state: 'checking_environment', label: 'workflow.stepEnv' },
  { state: 'planning', label: 'workflow.stepPlan' },
  { state: 'awaiting_plan_approval', label: 'workflow.stepApproval' },
  { state: 'implementing', label: 'workflow.stepImplement' },
  { state: 'reviewing', label: 'workflow.stepReview' },
  { state: 'master_validation', label: 'workflow.stepValidate' },
  { state: 'completed', label: 'workflow.stepDone' },
];

function stepGlyph(
  stepState: WorkflowState,
  current: WorkflowState,
): { readonly glyph: string; readonly color?: string } {
  const order = STEPS.map((step) => step.state);
  const currentIndex = order.indexOf(current);
  const stepIndex = order.indexOf(stepState);

  if (current === 'failed' || current === 'cancelled') {
    return { glyph: '×', color: 'red' };
  }
  if (current === stepState) {
    return { glyph: '●', color: 'yellow' };
  }
  if (currentIndex > stepIndex && stepIndex >= 0) {
    return { glyph: '✓', color: 'green' };
  }
  // Treat non-linear control states as not advancing the strip.
  if (
    current === 'rework_requested'
    || current === 'paused_after_run'
    || current === 'interrupting'
    || current === 'interrupted_needs_inspection'
    || current === 'cleanup_failed'
    || current === 'awaiting_user'
  ) {
    return { glyph: '○', color: 'gray' };
  }
  return { glyph: '○', color: 'gray' };
}

/**
 * Compact horizontal workflow strip — design work-status-v2.html stepper.
 */
export function WorkflowStepper(props: WorkflowStepperProps): React.ReactElement {
  const { snapshot } = props;
  const language = snapshot.uiLanguage;

  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1} paddingX={1}>
      {STEPS.map((step, index) => {
        const { glyph, color } = stepGlyph(step.state, snapshot.workflowState);
        return (
          <Text key={step.state} color={color}>
            {glyph} {uiText(language, step.label)}
            {index < STEPS.length - 1 ? ' →' : ''}
          </Text>
        );
      })}
    </Box>
  );
}
