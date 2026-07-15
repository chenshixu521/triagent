export type FakeCliScenarioStep =
  | {
      readonly type: 'stdout' | 'stderr';
      readonly chunks: readonly string[];
      readonly delayBetweenChunksMs?: number;
    }
  | {
      readonly type: 'delay';
      readonly durationMs: number;
    }
  | {
      readonly type: 'write_file';
      readonly relativePath: string;
      readonly content: string;
    }
  | {
      readonly type: 'spawn_descendant';
      readonly delayMs: number;
      readonly markerRelativePath?: string;
      readonly markerContent?: string;
      readonly waitForExit?: boolean;
    }
  | {
      readonly type: 'exit';
      readonly code: number;
    };

export interface FakeCliScenario {
  readonly version: 1;
  readonly expectedAttemptId?: string;
  readonly expectedConversationId?: string;
  readonly steps: readonly FakeCliScenarioStep[];
}

export type FakeCliJsonValue =
  | null
  | string
  | number
  | boolean
  | readonly FakeCliJsonValue[]
  | { readonly [key: string]: FakeCliJsonValue };

export interface SuccessfulStructuredScenarioOptions {
  readonly attemptId: string;
  readonly conversationId?: string;
  readonly output: FakeCliJsonValue;
  readonly partialOutput?: {
    readonly text: string;
    readonly splitAt?: number;
  };
  readonly projectWrite?: {
    readonly relativePath: string;
    readonly content: string;
  };
  readonly delayedDescendant?: {
    readonly delayMs: number;
    readonly markerRelativePath?: string;
    readonly markerContent?: string;
    readonly waitForExit?: boolean;
  };
}

export function successfulStructuredScenario(
  options: SuccessfulStructuredScenarioOptions,
): FakeCliScenario {
  const steps: FakeCliScenarioStep[] = [];
  if (options.partialOutput !== undefined) {
    const line = JSON.stringify({
      type: 'output',
      attemptId: options.attemptId,
      text: options.partialOutput.text,
    });
    const splitAt = options.partialOutput.splitAt ?? Math.floor(line.length / 2);
    steps.push({
      type: 'stdout',
      chunks: [line.slice(0, splitAt), `${line.slice(splitAt)}\n`],
    });
  }
  if (options.projectWrite !== undefined) {
    steps.push({ type: 'write_file', ...options.projectWrite });
  }
  if (options.delayedDescendant !== undefined) {
    steps.push({ type: 'spawn_descendant', ...options.delayedDescendant });
  }
  steps.push({
    type: 'stdout',
    chunks: [`${JSON.stringify({
      type: 'result',
      attemptId: options.attemptId,
      ...(options.conversationId === undefined
        ? {}
        : { conversationId: options.conversationId }),
      output: options.output,
    })}\n`],
  });
  steps.push({ type: 'exit', code: 0 });
  return {
    version: 1,
    expectedAttemptId: options.attemptId,
    steps,
  };
}

export function invalidJsonScenario(attemptId: string): FakeCliScenario {
  return {
    version: 1,
    expectedAttemptId: attemptId,
    steps: [
      { type: 'stdout', chunks: ['{"invalid":\n'] },
      { type: 'exit', code: 0 },
    ],
  };
}

export function crashScenario(
  attemptId: string,
  exitCode = 7,
  message = 'planned fake crash',
): FakeCliScenario {
  return {
    version: 1,
    expectedAttemptId: attemptId,
    steps: [
      { type: 'stderr', chunks: [`${message}\n`] },
      { type: 'exit', code: exitCode },
    ],
  };
}

export function timeoutScenario(
  attemptId: string,
  durationMs = 30_000,
): FakeCliScenario {
  return {
    version: 1,
    expectedAttemptId: attemptId,
    steps: [
      { type: 'delay', durationMs },
      { type: 'exit', code: 0 },
    ],
  };
}

export function resumeScenario(
  attemptId: string,
  conversationId: string,
  output: FakeCliJsonValue,
): FakeCliScenario {
  return {
    version: 1,
    expectedAttemptId: attemptId,
    expectedConversationId: conversationId,
    steps: [
      {
        type: 'stdout',
        chunks: [`${JSON.stringify({
          type: 'result',
          attemptId,
          conversationId,
          output,
        })}\n`],
      },
      { type: 'exit', code: 0 },
    ],
  };
}

export function queuedMessagesScenario(
  attemptId: string,
  contents: readonly string[],
): FakeCliScenario {
  return {
    version: 1,
    expectedAttemptId: attemptId,
    steps: [
      ...contents.map((content, index): FakeCliScenarioStep => ({
        type: 'stdout',
        chunks: [`${JSON.stringify({
          type: 'message_state',
          attemptId,
          message: {
            attemptId,
            sequence: index + 1,
            content,
            state: 'queued',
          },
        })}\n`],
      })),
      {
        type: 'stdout',
        chunks: [`${JSON.stringify({
          type: 'result',
          attemptId,
          output: { queuedMessages: contents.length },
        })}\n`],
      },
      { type: 'exit', code: 0 },
    ],
  };
}
