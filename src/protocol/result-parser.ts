import {
  AGENT_RESULT_NON_JSON_ERROR,
  AgentResultSchema,
  parseAgentPatchResultValue,
  type AgentPatchResult,
  type AgentResult,
} from './result-schema.js';

export type AgentResultParseFailureCode =
  | 'invalid_json'
  | 'non_json_value'
  | 'schema_mismatch';

export interface AgentResultOutcomeFailure {
  readonly success: false;
  readonly code?: AgentResultParseFailureCode;
  readonly reason: string;
}

export interface AgentResultParseFailure extends AgentResultOutcomeFailure {
  readonly code: AgentResultParseFailureCode;
}

export interface AgentResultParseSuccess {
  readonly success: true;
  readonly result: AgentResult | AgentPatchResult;
}

/** Result schema mode: default Task8 schema vs patch-mode extended schema. */
export type AgentResultSchemaMode =
  | 'default'
  | 'project_write'
  | 'read_only'
  | 'patch_mode'
  | 'auto_allowed'
  | 'disabled';

/** Compatibility outcome for orchestration paths that also model run failures. */
export type AgentResultParseOutcome =
  | AgentResultParseSuccess
  | AgentResultOutcomeFailure;

/** Exact outcome returned by parseAgentResult for one format-repair decision. */
export type ParsedAgentResultOutcome =
  | AgentResultParseSuccess
  | AgentResultParseFailure;

const FAILURES = {
  invalid_json: {
    success: false,
    code: 'invalid_json',
    reason: 'final result is not valid JSON',
  },
  non_json_value: {
    success: false,
    code: 'non_json_value',
    reason: 'final result must be a JSON-compatible value',
  },
  schema_mismatch: {
    success: false,
    code: 'schema_mismatch',
    reason: 'final result does not match the agent result schema',
  },
} as const satisfies Record<AgentResultParseFailureCode, AgentResultParseFailure>;

type DecodeOutcome =
  | { readonly success: true; readonly value: unknown }
  | AgentResultParseFailure;

function decode(value: unknown): DecodeOutcome {
  if (typeof value !== 'string') return { success: true, value };
  try {
    return { success: true, value: JSON.parse(value) as unknown };
  } catch {
    return FAILURES.invalid_json;
  }
}

/**
 * Parses only the final structured result. The caller remains responsible for
 * preserving the raw attempt payload in the existing JSONL/evidence pipeline.
 * Result fields are agent claims; this function does not derive file, command,
 * or verification evidence from them.
 */
export function parseAgentResult(value: unknown): ParsedAgentResultOutcome {
  return parseAgentResultForMode(value, 'default');
}

/**
 * Parse structured agent result with a mode-conditioned schema.
 * `patch_mode` requires unifiedDiff/patch + requestedCommands and rejects
 * unsafe extra fields. Other modes use the strict default Task 8 schema
 * (no unifiedDiff extras).
 */
export function parseAgentResultForMode(
  value: unknown,
  mode: AgentResultSchemaMode = 'default',
): ParsedAgentResultOutcome {
  const decoded = decode(value);
  if (!decoded.success) return decoded;

  if (mode === 'patch_mode') {
    const parsed = parseAgentPatchResultValue(decoded.value);
    if (parsed.success) {
      return { success: true, result: parsed.result };
    }
    return parsed.nonJson ? FAILURES.non_json_value : FAILURES.schema_mismatch;
  }

  const parsed = AgentResultSchema.safeParse(decoded.value);
  if (parsed.success) {
    return { success: true, result: parsed.data };
  }
  return parsed.error.issues.some(
    (issue) => issue.message === AGENT_RESULT_NON_JSON_ERROR,
  )
    ? FAILURES.non_json_value
    : FAILURES.schema_mismatch;
}
