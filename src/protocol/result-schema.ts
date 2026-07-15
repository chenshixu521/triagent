import { z } from 'zod';

type JsonCompatibleValue =
  | null
  | string
  | boolean
  | number
  | readonly JsonCompatibleValue[]
  | { readonly [key: string]: JsonCompatibleValue };

const INVALID_JSON_VALUE = Symbol('invalid-agent-result-json-value');

export const AGENT_RESULT_NON_JSON_ERROR =
  'agent result input is not a JSON-compatible value';

function cloneJsonCompatibleValue(
  value: unknown,
  ancestors: Set<object>,
): JsonCompatibleValue | typeof INVALID_JSON_VALUE {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? value
      : INVALID_JSON_VALUE;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return INVALID_JSON_VALUE;
  }

  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (
    (array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)
  ) {
    return INVALID_JSON_VALUE;
  }

  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lengthDescriptor === undefined
        || !('value' in lengthDescriptor)
        || typeof lengthDescriptor.value !== 'number'
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
      ) {
        return INVALID_JSON_VALUE;
      }
      const length = lengthDescriptor.value;
      const entries = new Map<number, JsonCompatibleValue>();
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key)) {
          return INVALID_JSON_VALUE;
        }
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
          return INVALID_JSON_VALUE;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !('value' in descriptor)
        ) {
          return INVALID_JSON_VALUE;
        }
        const cloned = cloneJsonCompatibleValue(descriptor.value, ancestors);
        if (cloned === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
        entries.set(index, cloned);
      }
      if (entries.size !== length) return INVALID_JSON_VALUE;
      return Array.from({ length }, (_unused, index) => entries.get(index)!);
    }

    const cloned: Record<string, JsonCompatibleValue> = Object.create(null) as
      Record<string, JsonCompatibleValue>;
    for (const key of keys) {
      if (typeof key !== 'string') return INVALID_JSON_VALUE;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
      ) {
        return INVALID_JSON_VALUE;
      }
      const clonedValue = cloneJsonCompatibleValue(descriptor.value, ancestors);
      if (clonedValue === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
      Object.defineProperty(cloned, key, {
        value: clonedValue,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeJsonCompatibleValue(
  value: unknown,
): JsonCompatibleValue | typeof INVALID_JSON_VALUE {
  try {
    return cloneJsonCompatibleValue(value, new Set<object>());
  } catch {
    return INVALID_JSON_VALUE;
  }
}

const JsonCompatibleValueSchema = z.preprocess(
  normalizeJsonCompatibleValue,
  z.custom<JsonCompatibleValue>(
    (value) => value !== INVALID_JSON_VALUE,
    { message: AGENT_RESULT_NON_JSON_ERROR },
  ),
);

const NonBlankStringSchema = z.string().min(1).regex(/\S/u);

export const AGENT_RESULT_STATUSES = [
  'completed',
  'needs_rework',
  'failed',
] as const;

export const AGENT_NEXT_ACTIONS = [
  'approve_plan',
  'implement',
  'review',
  'master_validation',
  'rework',
  'complete',
  'await_user',
] as const;

const AgentIssueContractSchema = z.strictObject({
  severity: z.enum(['critical', 'major', 'minor']),
  message: NonBlankStringSchema,
  file: NonBlankStringSchema.optional(),
  line: z.number().int().positive().optional(),
});

export const AgentIssueSchema = JsonCompatibleValueSchema.pipe(
  AgentIssueContractSchema,
);

const AgentResultContractSchema = z.strictObject({
  status: z.enum(AGENT_RESULT_STATUSES),
  summary: NonBlankStringSchema,
  changedFiles: z.array(NonBlankStringSchema),
  commandsRun: z.array(NonBlankStringSchema),
  verification: z.strictObject({
    passed: z.boolean(),
    details: NonBlankStringSchema,
  }),
  issues: z.array(AgentIssueContractSchema),
  nextAction: z.enum(AGENT_NEXT_ACTIONS),
});

export const AgentResultSchema = JsonCompatibleValueSchema.pipe(
  AgentResultContractSchema,
);

/**
 * Patch-mode structured result: implementer returns a unified diff and
 * requested verification commands. PatchApplier is the sole writer after
 * Task 9 validation/baseline checks. No project-write claims.
 */
const AgentPatchResultContractSchema = z.strictObject({
  status: z.enum(AGENT_RESULT_STATUSES),
  summary: NonBlankStringSchema,
  changedFiles: z.array(NonBlankStringSchema),
  commandsRun: z.array(NonBlankStringSchema),
  verification: z.strictObject({
    passed: z.boolean(),
    details: NonBlankStringSchema,
  }),
  issues: z.array(AgentIssueContractSchema),
  nextAction: z.enum(AGENT_NEXT_ACTIONS),
  unifiedDiff: NonBlankStringSchema,
  requestedCommands: z.array(NonBlankStringSchema),
});

/**
 * Accept either `unifiedDiff` or `patch` as the diff field, normalize to
 * `unifiedDiff`, and reject any other extra keys (strict).
 */
function normalizePatchResultInput(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.unifiedDiff === 'string'
    && record.unifiedDiff.length > 0
  ) {
    if ('patch' in record) {
      // Both present: keep unifiedDiff only (strict schema rejects extra).
      const { patch: _drop, ...rest } = record;
      return rest;
    }
    return record;
  }
  if (typeof record.patch === 'string' && record.patch.length > 0) {
    const { patch, ...rest } = record;
    return { ...rest, unifiedDiff: patch };
  }
  return record;
}

export type AgentIssue = z.infer<typeof AgentIssueSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type AgentPatchResult = z.infer<typeof AgentPatchResultContractSchema>;

/**
 * Patch-mode parse helper: JSON-compatible check, normalize patch→unifiedDiff,
 * then strict contract (no unsafe extra fields).
 */
export function parseAgentPatchResultValue(
  value: unknown,
):
  | { readonly success: true; readonly result: AgentPatchResult }
  | { readonly success: false; readonly nonJson: boolean } {
  const jsonCompatible = normalizeJsonCompatibleValue(value);
  if (jsonCompatible === INVALID_JSON_VALUE) {
    return { success: false, nonJson: true };
  }
  const normalized = normalizePatchResultInput(jsonCompatible);
  const parsed = AgentPatchResultContractSchema.safeParse(normalized);
  if (!parsed.success) {
    return { success: false, nonJson: false };
  }
  return { success: true, result: parsed.data };
}

/** Zod-compatible wrapper for tests that prefer schema.safeParse. */
export const AgentPatchResultSchema = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: AgentPatchResult }
    | {
      success: false;
      error: { issues: readonly { message: string }[] };
    } {
    const outcome = parseAgentPatchResultValue(value);
    if (outcome.success) {
      return { success: true, data: outcome.result };
    }
    return {
      success: false,
      error: {
        issues: [
          {
            message: outcome.nonJson
              ? AGENT_RESULT_NON_JSON_ERROR
              : 'final result does not match the agent patch result schema',
          },
        ],
      },
    };
  },
};
