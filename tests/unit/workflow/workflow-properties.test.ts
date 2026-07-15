import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  asAttemptId,
  asBaselineId,
  asTaskId,
} from '../../../src/domain/ids.js';
import type { WorkflowSnapshot } from '../../../src/workflow/states.js';
import {
  validateWorkflowSnapshot,
  WORKFLOW_STATES,
} from '../../../src/workflow/states.js';
import type { WorkflowEvent } from '../../../src/workflow/transitions.js';
import { WORKFLOW_EVENT_TYPES } from '../../../src/workflow/transitions.js';
import {
  createInitialWorkflow,
  transition,
} from '../../../src/workflow/workflow-engine.js';

const taskId = asTaskId('property-task');
const attemptId = asAttemptId('property-attempt');
const baselineId = asBaselineId('property-baseline');

const eventSamples = [
  { type: 'START' },
  { type: 'ENVIRONMENT_READY', attemptId, baselineId },
  { type: 'ENVIRONMENT_FAILED', reason: 'unavailable' },
  {
    type: 'PLAN_READY',
    requiresApproval: true,
    attemptId,
  },
  { type: 'PLAN_FAILED', attemptId, reason: 'planning failed' },
  { type: 'PLAN_APPROVED', attemptId, baselineId },
  { type: 'PLAN_REVISION_REQUESTED', attemptId, baselineId },
  {
    type: 'IMPLEMENTATION_COMPLETED',
    attemptId,
    reviewAttemptId: attemptId,
    reviewBaselineId: baselineId,
  },
  { type: 'IMPLEMENTATION_FAILED', attemptId, reason: 'process failed' },
  {
    type: 'REVIEW_COMPLETED',
    attemptId,
    masterAttemptId: attemptId,
    masterBaselineId: baselineId,
  },
  { type: 'REVIEW_INVALIDATED', attemptId, reason: 'baseline changed' },
  { type: 'REVIEW_FAILED', attemptId, reason: 'review process failed' },
  { type: 'MASTER_APPROVED', attemptId },
  { type: 'MASTER_REJECTED', attemptId, reason: 'acceptance failed' },
  { type: 'MASTER_FAILED', attemptId, reason: 'master process failed' },
  { type: 'RESULT_PARSE_FAILED', attemptId, reason: 'second parse failed' },
  { type: 'REWORK_CONTEXT_PERSISTED', attemptId, baselineId },
  { type: 'PAUSE_AFTER_ATTEMPT_REQUESTED' },
  { type: 'RESUME' },
  { type: 'CANCEL' },
  { type: 'INTERRUPT' },
  { type: 'PROCESS_TREE_CLEAN' },
  { type: 'PROCESS_CLEANUP_FAILED', reason: 'cleanup failed' },
  { type: 'RETRY_CLEANUP' },
  {
    type: 'INSPECTION_CONTINUE',
    attemptId,
    baselineId,
  },
  { type: 'INSPECTION_VIEW' },
  { type: 'INSPECTION_CANCEL' },
  { type: 'AWAITING_USER_RETRY_ENVIRONMENT' },
  {
    type: 'AWAITING_USER_CONTINUE',
    attemptId,
    baselineId,
  },
  { type: 'AWAITING_USER_CANCEL' },
  { type: 'FATAL_ERROR', reason: 'persistence unavailable' },
] as const satisfies readonly WorkflowEvent[];

const eventArbitrary = fc.constantFrom(...eventSamples);

function arbitrarySnapshot(): fc.Arbitrary<WorkflowSnapshot> {
  return fc
    .record({
      state: fc.constantFrom(...WORKFLOW_STATES),
      requirementVersion: fc.integer({ min: 1, max: 20 }),
      reworkCount: fc.integer({ min: 0, max: 3 }),
      pauseAfterAttempt: fc.boolean(),
      hasActiveAttempt: fc.boolean(),
    })
    .map(
      ({
        state,
        requirementVersion,
        reworkCount,
        pauseAfterAttempt,
        hasActiveAttempt,
      }) =>
        ({
          ...createInitialWorkflow(taskId),
          state,
          requirementVersion,
          reworkCount,
          pauseAfterAttempt,
          activeAttemptId: hasActiveAttempt ? attemptId : undefined,
        }) as WorkflowSnapshot,
    );
}

describe('workflow transition properties', () => {
  it('contains a sample for every declared workflow event', () => {
    expect(new Set(eventSamples.map((event) => event.type))).toEqual(
      new Set(WORKFLOW_EVENT_TYPES),
    );
  });

  it('never moves a terminal state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('completed', 'cancelled', 'failed'),
        eventArbitrary,
        (state, event) => {
          const terminal = {
            ...createInitialWorkflow(taskId),
            state,
          } as WorkflowSnapshot;
          const result = transition(terminal, event);

          expect(result.kind).toBe('illegal-transition');
          expect(result.state).toBe(state);
        },
      ),
    );
  });

  it('never raises the automatic rework count above three', () => {
    fc.assert(
      fc.property(
        arbitrarySnapshot(),
        fc.array(eventArbitrary, { maxLength: 100 }),
        (initial, events) => {
          const final = events.reduce<WorkflowSnapshot>(
            (current, event) => transition(current, event),
            initial,
          );

          expect(final.reworkCount).toBeLessThanOrEqual(3);
        },
      ),
    );
  });

  it('handles every declared event from every state without an unhandled exception', () => {
    fc.assert(
      fc.property(arbitrarySnapshot(), eventArbitrary, (current, event) => {
        expect(() => transition(current, event)).not.toThrow();
      }),
    );
  });

  it('never returns a transitioned result with an invalid snapshot', () => {
    fc.assert(
      fc.property(arbitrarySnapshot(), eventArbitrary, (current, event) => {
        const result = transition(current, event);

        if (result.kind === 'transitioned') {
          expect(validateWorkflowSnapshot(result)).toEqual({ valid: true });
        }
      }),
    );
  });

  it('keeps random legal event sequences reachable from draft', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 40 }), (choices) => {
        let current: WorkflowSnapshot = createInitialWorkflow(taskId);

        choices.forEach((choice, index) => {
          const nextAttemptId = asAttemptId(`reachable-attempt-${index}`);
          const nextBaselineId = asBaselineId(`reachable-baseline-${index}`);
          let event: WorkflowEvent | undefined;

          switch (current.state) {
            case 'draft':
              event = { type: 'START' };
              break;
            case 'checking_environment':
              event = choice
                ? {
                    type: 'ENVIRONMENT_READY',
                    attemptId: nextAttemptId,
                    baselineId: nextBaselineId,
                  }
                : { type: 'ENVIRONMENT_FAILED', reason: 'generated failure' };
              break;
            case 'planning':
              event = choice
                ? {
                    type: 'PLAN_READY',
                    requiresApproval: true,
                    attemptId: current.activeAttemptId!,
                  }
                : {
                    type: 'PLAN_READY',
                    requiresApproval: false,
                    attemptId: current.activeAttemptId!,
                    implementationAttemptId: nextAttemptId,
                    implementationBaselineId: nextBaselineId,
                  };
              break;
            case 'awaiting_plan_approval':
              event = {
                type: 'PLAN_APPROVED',
                attemptId: nextAttemptId,
                baselineId: nextBaselineId,
              };
              break;
            case 'implementing':
              event = {
                type: 'IMPLEMENTATION_COMPLETED',
                attemptId: current.activeAttemptId!,
                reviewAttemptId: nextAttemptId,
                reviewBaselineId: nextBaselineId,
              };
              break;
            case 'reviewing':
              event = choice
                ? {
                    type: 'REVIEW_COMPLETED',
                    attemptId: current.activeAttemptId!,
                    masterAttemptId: nextAttemptId,
                    masterBaselineId: nextBaselineId,
                  }
                : {
                    type: 'REVIEW_FAILED',
                    attemptId: current.activeAttemptId!,
                    reason: 'generated review failure',
                  };
              break;
            case 'master_validation':
              event = choice
                ? {
                    type: 'MASTER_APPROVED',
                    attemptId: current.activeAttemptId!,
                  }
                : {
                    type: 'MASTER_REJECTED',
                    attemptId: current.activeAttemptId!,
                    reason: 'generated rework request',
                  };
              break;
            case 'rework_requested':
              event = {
                type: 'REWORK_CONTEXT_PERSISTED',
                attemptId: nextAttemptId,
                baselineId: nextBaselineId,
              };
              break;
            case 'awaiting_user':
              event = { type: 'AWAITING_USER_CANCEL' };
              break;
            case 'paused_after_run':
              event = { type: 'RESUME' };
              break;
            case 'completed':
            case 'cancelled':
            case 'failed':
            case 'interrupting':
            case 'interrupted_needs_inspection':
            case 'cleanup_failed':
              break;
          }

          if (event !== undefined) {
            const result = transition(current, event);
            expect(result.kind).toBe('transitioned');
            current = result;
            expect(validateWorkflowSnapshot(current)).toEqual({ valid: true });
          }
        });
      }),
    );
  });
});
