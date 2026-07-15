type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type TaskId = Brand<string, 'TaskId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type BaselineId = Brand<string, 'BaselineId'>;

function asNonEmptyId<Name extends string>(
  value: string,
  name: Name,
): Brand<string, Name> {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return normalized as Brand<string, Name>;
}

export function asTaskId(value: string): TaskId {
  return asNonEmptyId(value, 'TaskId');
}

export function asAttemptId(value: string): AttemptId {
  return asNonEmptyId(value, 'AttemptId');
}

export function asConversationId(value: string): ConversationId {
  return asNonEmptyId(value, 'ConversationId');
}

export function asBaselineId(value: string): BaselineId {
  return asNonEmptyId(value, 'BaselineId');
}
