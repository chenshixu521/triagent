import { describe, expect, it } from 'vitest';

import * as taskOrchestrator from '../../../src/workflow/task-orchestrator.js';

type StagePromptBuilder = (input: {
  readonly stage: 'planning' | 'implementation' | 'review' | 'master_validation';
  readonly role: 'master' | 'implementer' | 'reviewer';
  readonly attemptId: string;
  readonly requirementVersion: number;
  readonly projectRoot: string;
  readonly requirements: string;
}) => string;

describe('stage prompt contract', () => {
  it('instructs a read-only master to plan rather than attempt the implementation', () => {
    const builder = (
      taskOrchestrator as typeof taskOrchestrator & {
        buildStagePrompt?: StagePromptBuilder;
      }
    ).buildStagePrompt;

    expect(builder).toBeTypeOf('function');
    const prompt = builder?.({
      stage: 'planning',
      role: 'master',
      attemptId: 'attempt-planning-contract',
      requirementVersion: 1,
      projectRoot: 'D:\\tmp\\project',
      requirements: 'Create triagent-smoke.txt with the fixed content.',
    }) ?? '';

    expect(prompt).toContain('Stage: planning');
    expect(prompt).toContain('Do not modify project files');
    expect(prompt).toContain('status "completed"');
    expect(prompt).toContain('nextAction "implement"');
    expect(prompt).toContain('Create triagent-smoke.txt with the fixed content.');
  });
});
