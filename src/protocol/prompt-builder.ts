import type { AgentRole } from '../domain/task.js';
import { Redactor } from '../logging/redact.js';
import type { JsonValue } from '../persistence/json-value.js';
import { stableJson } from '../tracking/hash.js';
import type { AgentIssue } from './result-schema.js';

const AGENT_ROLES = new Set<AgentRole>(['master', 'implementer', 'reviewer']);

export const PROMPT_ENVELOPE_BEGIN = '===TRIAGENT_PROMPT_ENVELOPE_BEGIN===';
export const PROMPT_ENVELOPE_END = '===TRIAGENT_PROMPT_ENVELOPE_END===';

export interface PromptFinding {
  readonly severity: AgentIssue['severity'];
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

export interface PromptBuildInput {
  readonly role: AgentRole;
  readonly originalRequirement: string;
  readonly requirementVersion: number;
  readonly approvedPlan: string;
  readonly acceptanceCriteria: readonly string[];
  readonly canonicalProjectRoot: string;
  readonly allowedActions: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly attemptNumber: number;
  readonly priorFindings: readonly PromptFinding[];
  readonly finalResponseSchema: Readonly<Record<string, unknown>>;
  /** Optional secrets for Redactor (CLI delivery). */
  readonly secrets?: readonly string[];
}

export interface BuiltAgentPrompt {
  readonly role: AgentRole;
  readonly originalRequirement: string;
  readonly requirementVersion: number;
  readonly approvedPlan: string;
  readonly acceptanceCriteria: readonly string[];
  readonly canonicalProjectRoot: string;
  readonly allowedActions: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly attemptNumber: number;
  readonly priorFindings: readonly PromptFinding[];
  readonly finalResponseSchema: Readonly<Record<string, unknown>>;
  /** Redacted canonical JSON envelope for CLI delivery. */
  readonly text: string;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireStringList(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean } = {},
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value.map((entry, index) =>
    requireNonEmptyString(entry, `${label}[${index}]`),
  );
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezeDeep(entry);
  }
  return Object.freeze(value);
}

function cloneJsonCompatible(
  value: unknown,
  ancestors: Set<object> = new Set(),
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error('final response schema contains non-JSON number');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error('final response schema is not JSON-compatible');
  }
  if (ancestors.has(value)) {
    throw new Error('final response schema contains a cycle');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => cloneJsonCompatible(entry, ancestors));
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = cloneJsonCompatible(entry, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeFindings(value: unknown): readonly PromptFinding[] {
  if (!Array.isArray(value)) {
    throw new Error('prior findings must be an array');
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`prior findings[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const severity = record.severity;
    if (
      severity !== 'critical' &&
      severity !== 'major' &&
      severity !== 'minor'
    ) {
      throw new Error(`prior findings[${index}].severity is invalid`);
    }
    const finding: PromptFinding = {
      severity,
      message: requireNonEmptyString(
        record.message,
        `prior findings[${index}].message`,
      ),
      ...(record.file === undefined
        ? {}
        : {
            file: requireNonEmptyString(
              record.file,
              `prior findings[${index}].file`,
            ),
          }),
      ...(record.line === undefined
        ? {}
        : {
            line: requirePositiveInteger(
              record.line,
              `prior findings[${index}].line`,
            ),
          }),
    };
    return Object.freeze(finding);
  });
}

function redactString(value: string, redactor: Redactor): string {
  const result = redactor.redact(value);
  return typeof result.value === 'string' ? result.value : value;
}

function redactFindings(
  findings: readonly PromptFinding[],
  redactor: Redactor,
): readonly PromptFinding[] {
  return Object.freeze(
    findings.map((finding) =>
      Object.freeze({
        severity: finding.severity,
        message: redactString(finding.message, redactor),
        ...(finding.file === undefined
          ? {}
          : { file: redactString(finding.file, redactor) }),
        ...(finding.line === undefined ? {} : { line: finding.line }),
      }),
    ),
  );
}

/**
 * Deterministic, clearly delimited canonical JSON envelope for CLI delivery.
 * Untrusted requirement/plan text cannot escape structural boundaries because
 * the body is a single stableJson object between fixed delimiters.
 */
function renderText(envelope: Readonly<Record<string, unknown>>): string {
  const body = stableJson(envelope);
  return `${PROMPT_ENVELOPE_BEGIN}\n${body}\n${PROMPT_ENVELOPE_END}`;
}

/**
 * Build a role-bound agent prompt with every required orchestration field.
 * Untrusted text is redacted before CLI delivery; typed fields stay consistent.
 */
export function buildAgentPrompt(input: PromptBuildInput): BuiltAgentPrompt {
  if (!AGENT_ROLES.has(input.role)) {
    throw new Error('role must be master, implementer, or reviewer');
  }
  const originalRequirement = requireNonEmptyString(
    input.originalRequirement,
    'original requirement',
  );
  const requirementVersion = requirePositiveInteger(
    input.requirementVersion,
    'requirement version',
  );
  const approvedPlan = requireNonEmptyString(input.approvedPlan, 'approved plan');
  const acceptanceCriteria = requireStringList(
    input.acceptanceCriteria,
    'acceptance criteria',
  );
  const canonicalProjectRoot = requireNonEmptyString(
    input.canonicalProjectRoot,
    'canonical project root',
  );
  const allowedActions = requireStringList(input.allowedActions, 'allowed actions');
  const forbiddenActions = requireStringList(
    input.forbiddenActions,
    'forbidden actions',
  );
  const attemptNumber = requirePositiveInteger(
    input.attemptNumber,
    'attempt number',
  );
  const priorFindings = normalizeFindings(input.priorFindings);
  if (
    input.finalResponseSchema === null ||
    typeof input.finalResponseSchema !== 'object' ||
    Array.isArray(input.finalResponseSchema)
  ) {
    throw new Error('final response schema must be an object');
  }
  const finalResponseSchema = freezeDeep(
    cloneJsonCompatible(input.finalResponseSchema) as Record<string, unknown>,
  );

  const redactor = new Redactor({ secrets: input.secrets ?? [] });
  const redactedRequirement = redactString(originalRequirement, redactor);
  const redactedPlan = redactString(approvedPlan, redactor);
  const redactedCriteria = Object.freeze(
    acceptanceCriteria.map((item) => redactString(item, redactor)),
  );
  const redactedFindings = redactFindings(priorFindings, redactor);
  const redactedRoot = redactString(canonicalProjectRoot, redactor);
  const redactedAllowed = Object.freeze(
    allowedActions.map((item) => redactString(item, redactor)),
  );
  const redactedForbidden = Object.freeze(
    forbiddenActions.map((item) => redactString(item, redactor)),
  );

  const envelope = {
    role: input.role,
    originalRequirement: redactedRequirement,
    requirementVersion,
    approvedPlan: redactedPlan,
    acceptanceCriteria: redactedCriteria,
    canonicalProjectRoot: redactedRoot,
    allowedActions: redactedAllowed,
    forbiddenActions: redactedForbidden,
    attemptNumber,
    priorFindings: redactedFindings,
    // COMPLETE schema object, not only an identifier.
    finalResponseSchema,
  };

  const prompt: BuiltAgentPrompt = freezeDeep({
    ...envelope,
    text: renderText(envelope),
  });
  return prompt;
}

/** Deterministic snapshot serialization for prompt regression tests. */
export function serializePromptSnapshot(prompt: BuiltAgentPrompt): string {
  return stableJson(prompt);
}
