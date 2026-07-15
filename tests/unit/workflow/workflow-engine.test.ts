import { describe, expect, it } from 'vitest';

import { unknownAgentCapabilities } from '../../../src/agents/agent-capabilities.js';
import {
  asAttemptId,
  asBaselineId,
  asConversationId,
  asTaskId,
} from '../../../src/domain/ids.js';
import { createRoleAssignment } from '../../../src/domain/task.js';
import {
  activateRunAttempt,
  completeRunAttempt,
  createPendingRunAttempt,
  type ConversationSession,
} from '../../../src/domain/attempt.js';
import {
  validateWorkflowSnapshot,
  type WorkflowSnapshot,
  type WorkflowState,
} from '../../../src/workflow/states.js';
import type { WorkflowEvent } from '../../../src/workflow/transitions.js';
import {
  createInitialWorkflow,
  transition,
} from '../../../src/workflow/workflow-engine.js';

const taskId = asTaskId('task-1');
const attemptId = asAttemptId('attempt-1');
const nextAttemptId = asAttemptId('attempt-2');
const planningAttemptId = asAttemptId('planning-attempt');
const implementationAttemptId = asAttemptId('implementation-attempt');
const reviewAttemptId = asAttemptId('review-attempt');
const masterAttemptId = asAttemptId('master-attempt');
const baselineId = asBaselineId('baseline-1');
const planningBaselineId = asBaselineId('planning-baseline');
const implementationBaselineId = asBaselineId('implementation-baseline');
const reviewBaselineId = asBaselineId('review-baseline');
const masterBaselineId = asBaselineId('master-baseline');

function snapshot(
  state: WorkflowState,
  overrides: Partial<WorkflowSnapshot> = {},
): WorkflowSnapshot {
  const role =
    state === 'planning' || state === 'master_validation'
      ? 'master'
      : state === 'reviewing'
        ? 'reviewer'
        : 'implementer';
  const activeDefaults =
    overrides.activeAttemptId === undefined
      ? {}
      : {
          activeAttemptBaselineId: baselineId,
          activeAttemptRole: role,
        };
  const reworkDefaults =
    state === 'rework_requested'
      ? {
          reworkRequest: {
            status: 'pending' as const,
            reason: 'test rework request',
            nextReworkNumber: (overrides.reworkCount ?? 0) + 1,
          },
        }
      : {};

  return {
    ...createInitialWorkflow(taskId),
    state,
    ...activeDefaults,
    ...reworkDefaults,
    ...overrides,
  } as WorkflowSnapshot;
}

function normalExternalStates() {
  const checking = transition(createInitialWorkflow(taskId), { type: 'START' });
  const planning = transition(
    checking,
    {
      type: 'ENVIRONMENT_READY',
      attemptId: planningAttemptId,
      baselineId: planningBaselineId,
    } as WorkflowEvent,
  );
  const implementing = transition(
    planning,
    {
      type: 'PLAN_READY',
      requiresApproval: false,
      attemptId: planningAttemptId,
      implementationAttemptId,
      implementationBaselineId,
    } as WorkflowEvent,
  );
  const reviewing = transition(
    implementing,
    {
      type: 'IMPLEMENTATION_COMPLETED',
      attemptId: implementationAttemptId,
      reviewAttemptId,
      reviewBaselineId,
    } as WorkflowEvent,
  );
  const masterValidation = transition(
    reviewing,
    {
      type: 'REVIEW_COMPLETED',
      attemptId: reviewAttemptId,
      masterAttemptId,
      masterBaselineId,
    } as WorkflowEvent,
  );

  return { planning, implementing, reviewing, masterValidation };
}

describe('domain boundaries', () => {
  it('requires three distinct agents for the master, implementer, and reviewer roles', () => {
    expect(
      createRoleAssignment({
        master: 'codex',
        implementer: 'claude',
        reviewer: 'grok',
      }),
    ).toEqual({ master: 'codex', implementer: 'claude', reviewer: 'grok' });

    expect(() =>
      createRoleAssignment({
        master: 'codex',
        implementer: 'codex',
        reviewer: 'grok',
      }),
    ).toThrow(/distinct/i);
  });

  it('keeps pending, active, and completed run attempt lifecycle data distinct', () => {
    const conversation: ConversationSession = {
      conversationId: asConversationId('conversation-1'),
      adapter: 'claude',
      capabilities: unknownAgentCapabilities(),
      startedAt: '2026-07-12T00:00:00.000Z',
    };
    const pending = createPendingRunAttempt({
      attemptId,
      startedAt: '2026-07-12T00:00:00.000Z',
      baselineId,
      requirementVersion: 1,
    });

    expect(pending.status).toBe('pending');
    expect(pending).not.toHaveProperty('pid');
    expect(pending).not.toHaveProperty('role');

    const forgedPending = createPendingRunAttempt({
      attemptId,
      startedAt: '2026-07-12T00:00:00.000Z',
      baselineId,
      requirementVersion: 1,
      pid: 9999,
      role: 'master',
    } as Parameters<typeof createPendingRunAttempt>[0]);

    expect(forgedPending).not.toHaveProperty('pid');
    expect(forgedPending).not.toHaveProperty('role');

    const active = activateRunAttempt(pending, {
      role: 'implementer',
      pid: 4242,
      processStartedAt: '2026-07-12T00:00:01.000Z',
      conversationId: conversation.conversationId,
    });

    expect(active).toMatchObject({
      status: 'active',
      role: 'implementer',
      pid: 4242,
      processStartedAt: '2026-07-12T00:00:01.000Z',
    });

    const completed = completeRunAttempt(active, {
      endedAt: '2026-07-12T00:01:00.000Z',
      exitReason: 'completed',
    });

    expect(conversation).not.toHaveProperty('pid');
    expect(completed).toMatchObject({
      status: 'completed',
      role: 'implementer',
      pid: 4242,
      endedAt: '2026-07-12T00:01:00.000Z',
      exitReason: 'completed',
    });
  });

  it('does not let activation or completion payloads overwrite attempt identity', () => {
    const pending = createPendingRunAttempt({
      attemptId,
      startedAt: '2026-07-12T00:00:00.000Z',
      baselineId,
      requirementVersion: 1,
    });
    const activationPayload = {
      role: 'reviewer' as const,
      pid: 4242,
      processStartedAt: '2026-07-12T00:00:01.000Z',
      attemptId: asAttemptId('forged-attempt'),
      baselineId: asBaselineId('forged-baseline'),
      startedAt: 'forged-start',
    };
    const active = activateRunAttempt(pending, activationPayload);

    expect(active).toMatchObject({
      attemptId,
      baselineId,
      startedAt: '2026-07-12T00:00:00.000Z',
      pid: 4242,
      role: 'reviewer',
    });

    const completionPayload = {
      endedAt: '2026-07-12T00:01:00.000Z',
      exitReason: 'completed' as const,
      attemptId: asAttemptId('forged-completed-attempt'),
      baselineId: asBaselineId('forged-completed-baseline'),
      startedAt: 'forged-completed-start',
      pid: 9999,
      role: 'master' as const,
    };
    const completed = completeRunAttempt(active, completionPayload);

    expect(completed).toMatchObject({
      attemptId,
      baselineId,
      startedAt: '2026-07-12T00:00:00.000Z',
      pid: 4242,
      role: 'reviewer',
    });
  });

  it('trims branded IDs and rejects empty or whitespace-only values', () => {
    expect(asTaskId('  task-trimmed  ')).toBe('task-trimmed');
    expect(asAttemptId('\t attempt-trimmed \n')).toBe('attempt-trimmed');
    expect(() => asTaskId('   ')).toThrow(/non-empty/i);
    expect(() => asAttemptId('\t')).toThrow(/non-empty/i);
    expect(() => asConversationId('')).toThrow(/non-empty/i);
    expect(() => asBaselineId('\r\n')).toThrow(/non-empty/i);
  });
});

describe('workflow transition', () => {
  it('starts with a project lock request and an environment check command', () => {
    const result = transition(createInitialWorkflow(taskId), { type: 'START' });

    expect(result.kind).toBe('transitioned');
    expect(result.state).toBe('checking_environment');
    expect(result.effects.map((effect) => effect.type)).toEqual([
      'AcquireProjectLock',
      'RunEnvironmentCheck',
      'PersistTransition',
    ]);
  });

  it('moves from a successful environment check to planning and waits on failure', () => {
    const ready = transition(snapshot('checking_environment'), {
      type: 'ENVIRONMENT_READY',
      attemptId: planningAttemptId,
      baselineId: planningBaselineId,
    });
    const failed = transition(snapshot('checking_environment'), {
      type: 'ENVIRONMENT_FAILED',
      reason: 'Claude CLI is unavailable',
    });

    expect(ready.state).toBe('planning');
    expect(ready.effects.map((effect) => effect.type)).toContain('StartPlanning');
    expect(failed.state).toBe('awaiting_user');
    expect(failed.awaitingReason).toBe('Claude CLI is unavailable');
    expect(failed.effects.map((effect) => effect.type)).toEqual([
      'ReleaseProjectLock',
      'PersistTransition',
    ]);
  });

  it('starts implementation after an approved plan', () => {
    const result = transition(snapshot('awaiting_plan_approval'), {
      type: 'PLAN_APPROVED',
      attemptId,
      baselineId,
    });

    expect(result.kind).toBe('transitioned');
    expect(result.state).toBe('implementing');
    expect(result.activeAttemptId).toBe(attemptId);
    expect(result.effects.map((effect) => effect.type)).toEqual([
      'CreateAttemptBaseline',
      'PrepareImplementationWorkspace',
      'StartImplementation',
      'PersistTransition',
    ]);
  });

  it('increments the requirement version when the user requests plan revision', () => {
    const result = transition(
      snapshot('awaiting_plan_approval', { requirementVersion: 2 }),
      {
        type: 'PLAN_REVISION_REQUESTED',
        attemptId: planningAttemptId,
        baselineId: planningBaselineId,
      },
    );

    expect(result.state).toBe('planning');
    expect(result.requirementVersion).toBe(3);
    expect(result.effects.map((effect) => effect.type)).toContain('StartPlanning');
  });

  it('records a pause request without stopping the active attempt', () => {
    const result = transition(
      snapshot('implementing', { activeAttemptId: attemptId }),
      { type: 'PAUSE_AFTER_ATTEMPT_REQUESTED' },
    );

    expect(result.state).toBe('implementing');
    expect(result.pauseAfterAttempt).toBe(true);
    expect(result.activeAttemptId).toBe(attemptId);
  });

  it('resumes at the completed attempt successor instead of repeating implementation', () => {
    const paused = transition(
      snapshot('implementing', {
        activeAttemptId: attemptId,
        pauseAfterAttempt: true,
      }),
      {
        type: 'IMPLEMENTATION_COMPLETED',
        attemptId,
        reviewAttemptId,
        reviewBaselineId,
      },
    );

    expect(paused.state).toBe('paused_after_run');
    expect(paused.resumeTargetState).toBe('reviewing');
    expect(paused.pauseAfterAttempt).toBe(false);
    expect(paused.activeAttemptId).toBeUndefined();

    const resumed = transition(paused, { type: 'RESUME' });
    expect(resumed.state).toBe('reviewing');
    expect(resumed.state).not.toBe('implementing');
    expect(resumed.effects.map((effect) => effect.type)).toContain('StartReview');
  });

  it('pauses after planning before entering plan approval', () => {
    const paused = transition(
      snapshot('planning', {
        activeAttemptId: attemptId,
        pauseAfterAttempt: true,
      }),
      {
        type: 'PLAN_READY',
        requiresApproval: true,
        attemptId,
      },
    );

    expect(paused.state).toBe('paused_after_run');
    expect(paused.resumeTargetState).toBe('awaiting_plan_approval');
    expect(paused.pauseAfterAttempt).toBe(false);
    expect(paused.effects.map((effect) => effect.type)).toEqual([
      'PersistTransition',
    ]);

    const resumed = transition(paused, { type: 'RESUME' });
    expect(resumed.state).toBe('awaiting_plan_approval');
    expect(resumed.pauseAfterAttempt).toBe(false);
  });

  it('defers the implementation baseline and start until planning is resumed', () => {
    const paused = transition(
      snapshot('planning', {
        activeAttemptId: attemptId,
        pauseAfterAttempt: true,
      }),
      {
        type: 'PLAN_READY',
        requiresApproval: false,
        attemptId,
        implementationAttemptId: nextAttemptId,
        implementationBaselineId: baselineId,
      },
    );

    expect(paused.state).toBe('paused_after_run');
    expect(paused.resumeTargetState).toBe('implementing');
    expect(paused.activeAttemptId).toBeUndefined();
    expect(paused.effects.map((effect) => effect.type)).toEqual([
      'PersistTransition',
    ]);

    const resumed = transition(paused, { type: 'RESUME' });
    expect(resumed.state).toBe('implementing');
    expect(resumed.activeAttemptId).toBe(nextAttemptId);
    expect(resumed.pauseAfterAttempt).toBe(false);
    expect(resumed.effects.map((effect) => effect.type)).toEqual([
      'CreateAttemptBaseline',
      'PrepareImplementationWorkspace',
      'StartImplementation',
      'PersistTransition',
    ]);
  });

  it('moves a completed valid review into master validation', () => {
    const result = transition(
      snapshot('reviewing', { activeAttemptId: reviewAttemptId }),
      {
        type: 'REVIEW_COMPLETED',
        attemptId: reviewAttemptId,
        masterAttemptId,
        masterBaselineId,
      },
    );

    expect(result.state).toBe('master_validation');
    expect(result.effects.map((effect) => effect.type)).toContain(
      'StartMasterValidation',
    );
  });

  it('pauses after review and resumes at master validation', () => {
    const paused = transition(
      snapshot('reviewing', {
        activeAttemptId: reviewAttemptId,
        pauseAfterAttempt: true,
      }),
      {
        type: 'REVIEW_COMPLETED',
        attemptId: reviewAttemptId,
        masterAttemptId,
        masterBaselineId,
      },
    );

    expect(paused.state).toBe('paused_after_run');
    expect(paused.resumeTargetState).toBe('master_validation');
    expect(paused.pauseAfterAttempt).toBe(false);
    expect(paused.effects.map((effect) => effect.type)).toEqual([
      'PersistTransition',
    ]);

    const resumed = transition(paused, { type: 'RESUME' });
    expect(resumed.state).toBe('master_validation');
    expect(resumed.activeAttemptId).toBe(masterAttemptId);
    expect(resumed.effects.map((effect) => effect.type)).toEqual([
      'CreateAttemptBaseline',
      'StartMasterValidation',
      'PersistTransition',
    ]);
  });

  it('invalidates a review into an explicit awaiting-user state', () => {
    const result = transition(snapshot('reviewing', { activeAttemptId: reviewAttemptId }), {
      type: 'REVIEW_INVALIDATED',
      attemptId: reviewAttemptId,
      reason: 'baseline changed during review',
    });

    expect(result.state).toBe('awaiting_user');
    expect(result.awaitingReason).toBe('baseline changed during review');
  });

  it.each([0, 1, 2])(
    'requests another rework when %i reworks have already run',
    (reworkCount) => {
      const result = transition(
        snapshot('master_validation', {
          activeAttemptId: masterAttemptId,
          reworkCount,
        }),
        {
          type: 'MASTER_REJECTED',
          attemptId: masterAttemptId,
          reason: 'acceptance failed',
        },
      );

      expect(result.state).toBe('rework_requested');
      expect(result.reworkCount).toBe(reworkCount);
      expect(result.effects.map((effect) => effect.type)).toContain(
        'PersistReworkRequest',
      );
    },
  );

  it('allows the initial implementation plus at most three additional rework attempts', () => {
    const result = transition(
      snapshot('rework_requested', { reworkCount: 2 }),
      {
        type: 'REWORK_CONTEXT_PERSISTED',
        attemptId: nextAttemptId,
        baselineId,
      },
    );

    expect(result.state).toBe('implementing');
    expect(result.reworkCount).toBe(3);
    expect(result.activeAttemptId).toBe(nextAttemptId);
  });

  it('sends a fourth rework request to the user instead of starting another attempt', () => {
    const result = transition(
      snapshot('master_validation', {
        activeAttemptId: masterAttemptId,
        reworkCount: 3,
      }),
      {
        type: 'MASTER_REJECTED',
        attemptId: masterAttemptId,
        reason: 'still incomplete',
      },
    );

    expect(result.state).toBe('awaiting_user');
    expect(result.reworkCount).toBe(3);
    expect(result.awaitingReason).toMatch(/rework limit/i);
  });

  it('pauses a master rejection before entering rework_requested', () => {
    const paused = transition(
      snapshot('master_validation', {
        activeAttemptId: masterAttemptId,
        reworkCount: 1,
        pauseAfterAttempt: true,
      }),
      {
        type: 'MASTER_REJECTED',
        attemptId: masterAttemptId,
        reason: 'acceptance failed',
      },
    );

    expect(paused.state).toBe('paused_after_run');
    expect(paused.resumeTargetState).toBe('rework_requested');
    expect(paused.pauseAfterAttempt).toBe(false);
    expect(paused.effects.map((effect) => effect.type)).toEqual([
      'PersistTransition',
    ]);
    expect(paused.effects.map((effect) => effect.type)).not.toContain(
      'PersistReworkRequest',
    );

    const premature = transition(paused, {
      type: 'REWORK_CONTEXT_PERSISTED',
      attemptId: nextAttemptId,
      baselineId,
    });
    expect(premature.kind).toBe('illegal-transition');

    const resumed = transition(paused, { type: 'RESUME' });
    expect(resumed.state).toBe('rework_requested');
    expect(resumed.pauseAfterAttempt).toBe(false);
    expect(resumed.effects.map((effect) => effect.type)).toEqual([
      'PersistReworkRequest',
      'PersistTransition',
    ]);

    const implementing = transition(resumed, {
      type: 'REWORK_CONTEXT_PERSISTED',
      attemptId: nextAttemptId,
      baselineId,
    });
    expect(implementing.state).toBe('implementing');
    expect(implementing.effects.map((effect) => effect.type)).toEqual([
      'CreateAttemptBaseline',
      'PrepareImplementationWorkspace',
      'StartImplementation',
      'PersistTransition',
    ]);
  });

  it('pauses a master rejection at the rework limit before awaiting the user', () => {
    const paused = transition(
      snapshot('master_validation', {
        activeAttemptId: masterAttemptId,
        reworkCount: 3,
        pauseAfterAttempt: true,
      }),
      {
        type: 'MASTER_REJECTED',
        attemptId: masterAttemptId,
        reason: 'still incomplete',
      },
    );

    expect(paused.state).toBe('paused_after_run');
    expect(paused.resumeTargetState).toBe('awaiting_user');
    expect(paused.pauseAfterAttempt).toBe(false);
    expect(paused.awaitingReason).toMatch(/rework limit/i);

    const resumed = transition(paused, { type: 'RESUME' });
    expect(resumed.state).toBe('awaiting_user');
    expect(resumed.pauseAfterAttempt).toBe(false);
    expect(resumed.awaitingReason).toMatch(/rework limit/i);
  });

  it('preserves awaiting-user metadata when a paused workflow resumes', () => {
    const paused = snapshot('paused_after_run', {
      resumeTargetState: 'awaiting_user',
      awaitingReason: 'environment still unavailable',
      allowedAwaitingActions: ['retry_environment', 'cancel'],
    });

    expect(validateWorkflowSnapshot(paused)).toEqual({ valid: true });

    const resumed = transition(paused, { type: 'RESUME' });
    expect(resumed.state).toBe('awaiting_user');
    expect(resumed.awaitingReason).toBe('environment still unavailable');
    expect(resumed.allowedAwaitingActions).toEqual([
      'retry_environment',
      'cancel',
    ]);
    expect(validateWorkflowSnapshot(resumed)).toEqual({ valid: true });

    const retried = transition(resumed, {
      type: 'AWAITING_USER_RETRY_ENVIRONMENT',
    });
    expect(retried.state).toBe('checking_environment');
    expect(retried.effects.map((effect) => effect.type)).toEqual([
      'AcquireProjectLock',
      'RunEnvironmentCheck',
      'PersistTransition',
    ]);
  });

  it('pauses master approval before completing and releasing the project lock', () => {
    const direct = transition(normalExternalStates().masterValidation, {
      type: 'MASTER_APPROVED',
      attemptId: masterAttemptId,
    });
    expect(direct.state).toBe('completed');
    expect(direct.effects.map((effect) => effect.type)).toContain(
      'ReleaseProjectLock',
    );

    const pauseRequested = transition(normalExternalStates().masterValidation, {
      type: 'PAUSE_AFTER_ATTEMPT_REQUESTED',
    });
    const result = transition(
      pauseRequested,
      { type: 'MASTER_APPROVED', attemptId: masterAttemptId },
    );

    expect(result.state).toBe('paused_after_run');
    expect(result.resumeTargetState).toBe('completed');
    expect(result.pauseAfterAttempt).toBe(false);
    expect(result.activeAttemptId).toBeUndefined();
    expect(result.effects.map((effect) => effect.type)).toEqual([
      'PersistTransition',
    ]);

    const resumed = transition(result, { type: 'RESUME' });
    expect(resumed.state).toBe('completed');
    expect(resumed.effects.map((effect) => effect.type)).toEqual([
      'ReleaseProjectLock',
      'PersistTransition',
    ]);
  });

  it('creates reachable active attempts for planning, review, and master validation', () => {
    const states = normalExternalStates();

    expect(states.planning).toMatchObject({
      state: 'planning',
      activeAttemptId: planningAttemptId,
    });
    expect(states.planning.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'StartPlanning',
          attemptId: planningAttemptId,
          role: 'master',
        }),
      ]),
    );
    expect(states.implementing).toMatchObject({
      state: 'implementing',
      activeAttemptId: implementationAttemptId,
    });
    expect(states.reviewing).toMatchObject({
      state: 'reviewing',
      activeAttemptId: reviewAttemptId,
    });
    expect(states.reviewing.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'StartReview',
          attemptId: reviewAttemptId,
          role: 'reviewer',
        }),
      ]),
    );
    expect(states.masterValidation).toMatchObject({
      state: 'master_validation',
      activeAttemptId: masterAttemptId,
    });
    expect(states.masterValidation.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'StartMasterValidation',
          attemptId: masterAttemptId,
          role: 'master',
        }),
      ]),
    );
  });

  it('rejects completion events whose attemptId does not match the active agent run', () => {
    const states = normalExternalStates();

    const wrongPlanning = transition(
      states.planning,
      {
        type: 'PLAN_READY',
        requiresApproval: true,
        attemptId: asAttemptId('wrong-planning'),
      } as WorkflowEvent,
    );
    const wrongReview = transition(
      states.reviewing,
      {
        type: 'REVIEW_COMPLETED',
        attemptId: asAttemptId('wrong-review'),
        masterAttemptId,
        masterBaselineId,
      } as WorkflowEvent,
    );
    const wrongMaster = transition(
      states.masterValidation,
      {
        type: 'MASTER_APPROVED',
        attemptId: asAttemptId('wrong-master'),
      } as WorkflowEvent,
    );

    expect(wrongPlanning.kind).toBe('illegal-transition');
    expect(wrongPlanning.state).toBe('planning');
    expect(wrongReview.kind).toBe('illegal-transition');
    expect(wrongReview.state).toBe('reviewing');
    expect(wrongMaster.kind).toBe('illegal-transition');
    expect(wrongMaster.state).toBe('master_validation');
  });

  it.each([
    [
      'reviewing',
      () => normalExternalStates().reviewing,
      {
        type: 'REVIEW_FAILED',
        attemptId: asAttemptId('wrong-review-failure'),
        reason: 'review process crashed',
      },
    ],
    [
      'master_validation',
      () => normalExternalStates().masterValidation,
      {
        type: 'MASTER_FAILED',
        attemptId: asAttemptId('wrong-master-failure'),
        reason: 'master process crashed',
      },
    ],
  ] as const)(
    'rejects a failed %s event for the wrong attemptId',
    (state, makeCurrent, failedEvent) => {
      const result = transition(makeCurrent(), failedEvent as WorkflowEvent);

      expect(result.kind).toBe('illegal-transition');
      expect(result.state).toBe(state);
    },
  );

  it.each([
    [
      'reviewing',
      () => normalExternalStates().reviewing,
      {
        type: 'REVIEW_FAILED',
        attemptId: reviewAttemptId,
        reason: 'review process crashed',
      },
      reviewAttemptId,
      'reviewer',
      'StartReview',
    ],
    [
      'master_validation',
      () => normalExternalStates().masterValidation,
      {
        type: 'MASTER_FAILED',
        attemptId: masterAttemptId,
        reason: 'master process crashed',
      },
      masterAttemptId,
      'master',
      'StartMasterValidation',
    ],
  ] as const)(
    'recovers a failed %s run with a new role-correct attempt or safe cancellation',
    (
      resumeTarget,
      makeCurrent,
      failedEvent,
      failedAttemptId,
      role,
      startEffect,
    ) => {
      const failed = transition(makeCurrent(), failedEvent as WorkflowEvent);

      expect(failed.state).toBe('awaiting_user');
      expect(failed.activeAttemptId).toBeUndefined();
      expect(failed.awaitingReason).toBe(failedEvent.reason);
      expect(failed.allowedAwaitingActions).toEqual(['continue', 'cancel']);
      expect(failed.resumeTargetState).toBe(resumeTarget);

      const continued = transition(failed, {
        type: 'AWAITING_USER_CONTINUE',
        attemptId: nextAttemptId,
        baselineId,
      });

      expect(continued.state).toBe(resumeTarget);
      expect(continued.activeAttemptId).toBe(nextAttemptId);
      expect(continued.activeAttemptId).not.toBe(failedAttemptId);
      expect(continued.effects.map((effect) => effect.type)).toEqual([
        'CreateAttemptBaseline',
        startEffect,
        'PersistTransition',
      ]);
      expect(continued.effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: startEffect,
            attemptId: nextAttemptId,
            role,
          }),
        ]),
      );

      const cancelled = transition(failed, { type: 'AWAITING_USER_CANCEL' });
      expect(cancelled.state).toBe('cancelled');
      expect(cancelled.effects.map((effect) => effect.type)).toEqual([
        'ReleaseProjectLock',
        'PersistTransition',
      ]);
    },
  );

  it.each([
    ['planning', () => normalExternalStates().planning],
    ['reviewing', () => normalExternalStates().reviewing],
    ['master_validation', () => normalExternalStates().masterValidation],
  ] as const)(
    'routes cancel and interrupt through cleanup during an active %s run',
    (_state, makeCurrent) => {
      const cancelled = transition(makeCurrent(), { type: 'CANCEL' });
      const interrupted = transition(makeCurrent(), { type: 'INTERRUPT' });

      expect(cancelled.state).toBe('interrupting');
      expect(cancelled.stopIntent).toBe('cancel');
      expect(interrupted.state).toBe('interrupting');
      expect(interrupted.stopIntent).toBe('interrupt');
    },
  );

  it('interrupts an active run before cancelling the task', () => {
    const result = transition(
      snapshot('implementing', { activeAttemptId: attemptId }),
      { type: 'CANCEL' },
    );

    expect(result.state).toBe('interrupting');
    expect(result.stopIntent).toBe('cancel');
    expect(result.effects.map((effect) => effect.type)).toContain(
      'BeginProcessCleanup',
    );
  });

  it('cancels immediately when no attempt is active', () => {
    const result = transition(snapshot('awaiting_plan_approval'), {
      type: 'CANCEL',
    });

    expect(result.state).toBe('cancelled');
    expect(result.effects.map((effect) => effect.type)).toContain(
      'ReleaseProjectLock',
    );
  });

  it('distinguishes clean cancellation from an interrupt that needs inspection', () => {
    const cancelled = transition(
      snapshot('interrupting', {
        activeAttemptId: attemptId,
        stopIntent: 'cancel',
      }),
      { type: 'PROCESS_TREE_CLEAN' },
    );
    const interrupted = transition(
      snapshot('interrupting', {
        activeAttemptId: attemptId,
        stopIntent: 'interrupt',
      }),
      { type: 'PROCESS_TREE_CLEAN' },
    );

    expect(cancelled.state).toBe('cancelled');
    expect(interrupted.state).toBe('interrupted_needs_inspection');
    expect(interrupted.activeAttemptId).toBeUndefined();
  });

  it('enters cleanup_failed when the process tree cannot be confirmed clean', () => {
    const result = transition(
      snapshot('interrupting', {
        activeAttemptId: attemptId,
        stopIntent: 'interrupt',
      }),
      { type: 'PROCESS_CLEANUP_FAILED', reason: 'descendant still running' },
    );

    expect(result.state).toBe('cleanup_failed');
    expect(result.awaitingReason).toBe('descendant still running');
  });

  it('provides safe inspection continue, view, and cancel paths', () => {
    const interrupted = snapshot('interrupted_needs_inspection', {
      resumeTargetState: 'reviewing',
    });
    const continued = transition(interrupted, {
      type: 'INSPECTION_CONTINUE',
      attemptId: nextAttemptId,
      baselineId,
    });
    const viewed = transition(interrupted, { type: 'INSPECTION_VIEW' });
    const cancelled = transition(interrupted, { type: 'INSPECTION_CANCEL' });

    expect(continued.state).toBe('reviewing');
    expect(continued.activeAttemptId).toBe(nextAttemptId);
    expect(continued.effects.map((effect) => effect.type)).toEqual([
      'CreateAttemptBaseline',
      'StartReview',
      'PersistTransition',
    ]);
    expect(viewed.state).toBe('awaiting_user');
    expect(viewed.awaitingReason).toMatch(/inspection/i);
    expect(cancelled.state).toBe('cancelled');
  });

  it('provides safe awaiting-user retry, continue, and cancel paths', () => {
    const waiting = snapshot('awaiting_user', {
      awaitingReason: 'environment unavailable',
      allowedAwaitingActions: ['retry_environment', 'continue', 'cancel'],
      resumeTargetState: 'reviewing',
    });
    const retried = transition(waiting, {
      type: 'AWAITING_USER_RETRY_ENVIRONMENT',
    });
    const continued = transition(waiting, {
      type: 'AWAITING_USER_CONTINUE',
      attemptId: nextAttemptId,
      baselineId,
    });
    const cancelled = transition(waiting, { type: 'AWAITING_USER_CANCEL' });

    expect(retried.state).toBe('checking_environment');
    expect(continued.state).toBe('reviewing');
    expect(continued.effects.map((effect) => effect.type)).toEqual([
      'CreateAttemptBaseline',
      'StartReview',
      'PersistTransition',
    ]);
    expect(cancelled.state).toBe('cancelled');
  });

  it('does not let an environment failure continue into an arbitrary execution state', () => {
    const failed = transition(snapshot('checking_environment'), {
      type: 'ENVIRONMENT_FAILED',
      reason: 'CLI unavailable',
    });
    const injected = transition(
      failed,
      {
        type: 'AWAITING_USER_CONTINUE',
        targetState: 'implementing',
        attemptId: nextAttemptId,
        baselineId,
      } as WorkflowEvent,
    );

    expect(injected.kind).toBe('illegal-transition');
    expect(injected.state).toBe('awaiting_user');
    expect(injected.effects).toEqual([]);
  });

  it('uses the persisted inspection resume target instead of an event-supplied target', () => {
    const interrupted = snapshot('interrupted_needs_inspection', {
      resumeTargetState: 'reviewing',
    });
    const injected = transition(
      interrupted,
      {
        type: 'INSPECTION_CONTINUE',
        targetState: 'master_validation',
        attemptId: nextAttemptId,
        baselineId,
      } as WorkflowEvent,
    );

    expect(injected.state).toBe('reviewing');
    expect(injected.state).not.toBe('master_validation');
  });

  it('preserves the inspection resume target through cleanup failure and retry', () => {
    const interrupting = transition(
      snapshot('reviewing', { activeAttemptId: attemptId }),
      { type: 'INTERRUPT' },
    );
    const cleanupFailed = transition(interrupting, {
      type: 'PROCESS_CLEANUP_FAILED',
      reason: 'descendant still running',
    });
    const retrying = transition(cleanupFailed, { type: 'RETRY_CLEANUP' });
    const interrupted = transition(retrying, { type: 'PROCESS_TREE_CLEAN' });
    const continued = transition(interrupted, {
      type: 'INSPECTION_CONTINUE',
      attemptId: nextAttemptId,
      baselineId,
    });

    expect(continued.state).toBe('reviewing');
  });

  it.each([
    snapshot('interrupted_needs_inspection', {
      resumeTargetState: 'implementing',
    }),
    snapshot('awaiting_user', {
      resumeTargetState: 'implementing',
      allowedAwaitingActions: ['continue'],
      awaitingReason: 'implementation retry requested',
    }),
  ])(
    'creates exactly one baseline before resuming implementation from $state',
    (current) => {
      const event = {
        type:
          current.state === 'awaiting_user'
            ? 'AWAITING_USER_CONTINUE'
            : 'INSPECTION_CONTINUE',
        attemptId: nextAttemptId,
        baselineId,
      } as const;
      const result = transition(current, event);

      expect(result.state).toBe('implementing');
      expect(result.effects.map((effect) => effect.type)).toEqual([
        'CreateAttemptBaseline',
      'PrepareImplementationWorkspace',
      'StartImplementation',
        'PersistTransition',
      ]);
    },
  );

  it.each(['completed', 'cancelled', 'failed'] as const)(
    'keeps terminal state %s terminal and rejects ordinary events',
    (state) => {
      const result = transition(snapshot(state), { type: 'START' });

      expect(result.kind).toBe('illegal-transition');
      expect(result.state).toBe(state);
      expect(result.effects).toEqual([]);
    },
  );

  it('rejects an event that is illegal for the current non-terminal state', () => {
    const result = transition(snapshot('draft'), {
      type: 'PLAN_APPROVED',
      attemptId,
      baselineId,
    });

    expect(result.kind).toBe('illegal-transition');
    if (result.kind !== 'illegal-transition') {
      throw new Error('expected an illegal transition');
    }
    expect(result.state).toBe('draft');
    expect(result.reason).toMatch(/PLAN_APPROVED.*draft/i);
  });

  it.each([
    [
      'planning without an active attempt',
      {
        ...createInitialWorkflow(taskId),
        state: 'planning',
      },
      { type: 'CANCEL' },
    ],
    [
      'paused workflow without a resume target',
      {
        ...createInitialWorkflow(taskId),
        state: 'paused_after_run',
      },
      { type: 'RESUME' },
    ],
    [
      'paused awaiting-user workflow without awaiting metadata',
      {
        ...createInitialWorkflow(taskId),
        state: 'paused_after_run',
        resumeTargetState: 'awaiting_user',
      },
      { type: 'RESUME' },
    ],
    [
      'paused inspection workflow without a safe inspection target',
      {
        ...createInitialWorkflow(taskId),
        state: 'paused_after_run',
        resumeTargetState: 'interrupted_needs_inspection',
      },
      { type: 'RESUME' },
    ],
    [
      'interrupting workflow without cleanup identity',
      {
        ...createInitialWorkflow(taskId),
        state: 'interrupting',
      },
      { type: 'PROCESS_TREE_CLEAN' },
    ],
    [
      'awaiting-user workflow without recovery metadata',
      {
        ...createInitialWorkflow(taskId),
        state: 'awaiting_user',
      },
      { type: 'AWAITING_USER_CANCEL' },
    ],
    [
      'terminal workflow retaining an active attempt',
      {
        ...createInitialWorkflow(taskId),
        state: 'completed',
        activeAttemptId: attemptId,
      },
      { type: 'START' },
    ],
    [
      'rework request without persisted reason context',
      {
        ...createInitialWorkflow(taskId),
        state: 'rework_requested',
      },
      {
        type: 'REWORK_CONTEXT_PERSISTED',
        attemptId: nextAttemptId,
        baselineId,
      },
    ],
  ] as const)(
    'rejects an invalid snapshot: %s',
    (_label, corrupted, event) => {
      const result = transition(
        corrupted as WorkflowSnapshot,
        event as WorkflowEvent,
      );

      expect(result.kind).toBe('invalid-snapshot');
      if (result.kind !== 'invalid-snapshot') {
        throw new Error('expected invalid snapshot result');
      }
      expect(result.state).toBe(corrupted.state);
      expect(result.effects).toEqual([]);
      expect(result.reason).toMatch(/invalid workflow snapshot/i);
    },
  );
});
