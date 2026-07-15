import type { AgentEvent } from '../agent-adapter.js';
import {
  asConversationId,
  type AttemptId,
  type ConversationId,
} from '../../domain/ids.js';
import { Redactor } from '../../logging/redact.js';
import { sanitizeTerminal } from '../../logging/sanitize-terminal.js';
import { assertJsonValue, type JsonValue } from '../../persistence/json-value.js';
import {
  parseAgentResultForMode,
  type AgentResultSchemaMode,
} from '../../protocol/result-parser.js';

const PARSE_ERROR_MAX = 256;
const RAW_MAX = 512;

/** Shared redactor for unknown/raw/parse_error exposure paths. */
const DEFAULT_REDACTOR = new Redactor();

function boundText(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 12))}[truncated]`;
}

/**
 * Run Redactor then terminal sanitizer before exposing any unknown/raw/
 * parse_error payload. Secret-bearing JSON/lines must not appear in
 * AgentEvent serialized form / messages / causes.
 */
export function redactAndSanitizeText(
  input: string,
  max: number = RAW_MAX,
  redactor: Redactor = DEFAULT_REDACTOR,
): string {
  let redactedText = input;
  try {
    const redacted = redactor.redact(input);
    if (typeof redacted.value === 'string') {
      redactedText = redacted.value;
    }
  } catch {
    // Non-JSON-string edge: apply pattern redaction via object wrapper.
    try {
      const wrapped = redactor.redact({ text: input });
      const value = wrapped.value;
      if (
        value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof (value as { text?: unknown }).text === 'string'
      ) {
        redactedText = (value as { text: string }).text;
      }
    } catch {
      // fall through to sanitize only
    }
  }
  const sanitized = sanitizeTerminal(redactedText, {
    maxLineCharacters: max,
    maxChunkCharacters: max,
  }).text;
  // Defense-in-depth pattern pass for common secret shapes.
  const patternRedacted = sanitized
    .replace(
      /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\bsk-(?:live|test|proj)?-[A-Za-z0-9_-]{8,}/gi,
      '[REDACTED]',
    )
    .replace(
      /((?:authorization|api[_-]?key|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    );
  return boundText(patternRedacted, max);
}

/**
 * Sanitize a string for parse_error.error / parse_error.raw:
 * Redactor + strip controls + common secret patterns + bound length.
 * Never leak full raw secrets or stack traces into error messages.
 */
export function sanitizeParseFragment(
  input: string,
  max: number = RAW_MAX,
): string {
  return redactAndSanitizeText(input, max);
}

function parseError(
  attemptId: AttemptId,
  raw: string,
  error: string,
): Extract<AgentEvent, { type: 'parse_error' }> {
  return Object.freeze({
    type: 'parse_error',
    attemptId,
    raw: sanitizeParseFragment(raw, RAW_MAX),
    error: boundText(sanitizeParseFragment(error, PARSE_ERROR_MAX), PARSE_ERROR_MAX),
  });
}

function asOutput(
  attemptId: AttemptId,
  text: string,
): Extract<AgentEvent, { type: 'output' }> {
  return Object.freeze({
    type: 'output',
    attemptId,
    text: redactAndSanitizeText(text, 64 * 1024),
  });
}

function extractTextFromCodexItem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  if (typeof item.text === 'string' && item.text.length > 0) return item.text;
  if (typeof item.content === 'string' && item.content.length > 0) {
    return item.content;
  }
  if (typeof item.message === 'string' && item.message.length > 0) {
    return item.message;
  }
  return undefined;
}

function extractConversationId(
  value: Record<string, unknown>,
): ConversationId | undefined {
  const candidates = [
    value.conversationId,
    value.conversation_id,
    value.thread_id,
    value.session_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      try {
        return asConversationId(candidate);
      } catch {
        // ignore invalid branded id
      }
    }
  }
  return undefined;
}

function extractResultOutput(
  value: Record<string, unknown>,
): unknown {
  if ('output' in value) return value.output;
  if ('result' in value) return value.result;
  if ('final' in value) return value.final;
  // Some Codex JSONL variants nest under response / structured_output.
  if (
    value.response !== null
    && typeof value.response === 'object'
    && !Array.isArray(value.response)
  ) {
    const response = value.response as Record<string, unknown>;
    if ('output' in response) return response.output;
  }
  return undefined;
}

/** Accumulator for freeform Codex streams without --output-schema. */
export interface CodexEventStreamState {
  textParts: string[];
  sawStructuredResult: boolean;
}

export interface ParseCodexEventOptions {
  /** Schema mode for structured result events (patch_mode uses patch schema). */
  readonly resultMode?: AgentResultSchemaMode;
  readonly redactor?: Redactor;
  readonly streamState?: CodexEventStreamState;
  /**
   * When true, turn.completed without structured payload may synthesize a
   * completed AgentResult from freeform agent_message text (custom providers).
   */
  readonly synthesizeCompletedOnEnd?: boolean;
}

/**
 * Parse one finished Codex JSONL line into a normalized AgentEvent.
 * All events are attributed to the provided attemptId (never trust spoofed ids).
 * Unknown event types are retained as redacted raw records.
 * Invalid JSON becomes bounded parse_error with no secret leak.
 */
export function parseCodexEventLine(
  line: string,
  attemptId: AttemptId,
  options: ParseCodexEventOptions = {},
): AgentEvent | null {
  const trimmed = line.replace(/^\uFEFF/, '').trimEnd();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return parseError(attemptId, trimmed, 'invalid JSONL line');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parseError(attemptId, trimmed, 'JSONL value is not an object');
  }

  const value = parsed as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : undefined;
  const resultMode = options.resultMode ?? 'default';
  const streamState = options.streamState;

  // Explicit structured result events (Task 8 schema integration).
  if (
    type === 'result'
    || type === 'agent_result'
    || type === 'final_result'
    || (type === 'turn.completed' && value.output !== undefined)
  ) {
    const event = parseStructuredResult(value, attemptId, trimmed, resultMode);
    if (event.type === 'result' && streamState !== undefined) {
      streamState.sawStructuredResult = true;
    }
    return event;
  }

  // Codex item stream → human-readable output; freeform JSON AgentResult recovery.
  if (type === 'item.completed' || type === 'item.updated') {
    const item = value.item;
    const text = extractTextFromCodexItem(item);
    if (text !== undefined) {
      if (streamState !== undefined) streamState.textParts.push(text);
      const freeform = tryParseAgentResultFromText(text, resultMode);
      if (freeform !== undefined) {
        if (streamState !== undefined) streamState.sawStructuredResult = true;
        return Object.freeze({
          type: 'result' as const,
          attemptId,
          output: freeform as unknown as JsonValue,
        });
      }
      return asOutput(attemptId, text);
    }
    // Retain unknown item shapes as redacted raw records.
    return asOutput(attemptId, safeJson(value, options.redactor));
  }

  if (type === 'message' || type === 'agent_message') {
    const text = extractTextFromCodexItem(value)
      ?? (typeof value.text === 'string' ? value.text : undefined);
    if (text !== undefined) {
      if (streamState !== undefined) streamState.textParts.push(text);
      const freeform = tryParseAgentResultFromText(text, resultMode);
      if (freeform !== undefined) {
        if (streamState !== undefined) streamState.sawStructuredResult = true;
        return Object.freeze({
          type: 'result' as const,
          attemptId,
          output: freeform as unknown as JsonValue,
        });
      }
      return asOutput(attemptId, text);
    }
  }

  // Freeform turn end: recover accumulated AgentResult or synthesize for custom providers.
  if (type === 'turn.completed') {
    if (streamState !== undefined && !streamState.sawStructuredResult) {
      const fromText = tryParseAgentResultFromText(
        streamState.textParts.join('\n'),
        resultMode,
      );
      if (fromText !== undefined) {
        streamState.sawStructuredResult = true;
        return Object.freeze({
          type: 'result' as const,
          attemptId,
          output: fromText as unknown as JsonValue,
        });
      }
      if (options.synthesizeCompletedOnEnd === true) {
        streamState.sawStructuredResult = true;
        const summary =
          streamState.textParts.join(' ').replace(/\s+/g, ' ').trim() ||
          'Codex freeform turn completed without structured AgentResult JSON';
        return Object.freeze({
          type: 'result' as const,
          attemptId,
          output: {
            status: 'completed',
            summary: summary.slice(0, 400),
            changedFiles: [],
            commandsRun: [],
            verification: {
              passed: true,
              details:
                'Synthesized from freeform Codex stream (custom provider omitted --output-schema)',
            },
            issues: [],
            nextAction:
              resultMode === 'read_only' || resultMode === 'auto_allowed'
                ? 'master_validation'
                : 'review',
          } as unknown as JsonValue,
        });
      }
    }
    return asOutput(attemptId, safeJson(value, options.redactor));
  }

  // Known lifecycle events retained as raw output (not dropped).
  if (
    type === 'thread.started'
    || type === 'turn.started'
    || type === 'thread.completed'
    || type === 'session.created'
  ) {
    return asOutput(attemptId, safeJson(value, options.redactor));
  }

  // Unknown / future events: retain safely as redacted raw records.
  return asOutput(attemptId, safeJson(value, options.redactor));
}

function tryParseAgentResultFromText(
  text: string,
  resultMode: AgentResultSchemaMode,
): unknown | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  const brace = trimmed.lastIndexOf('{');
  if (brace >= 0) {
    const slice = trimmed.slice(brace);
    const end = slice.lastIndexOf('}');
    if (end > 0) candidates.push(slice.slice(0, end + 1));
  }
  candidates.push(trimmed);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const outcome = parseAgentResultForMode(parsed, resultMode);
      if (outcome.success) return outcome.result;
    } catch {
      // next candidate
    }
  }
  return undefined;
}

function parseStructuredResult(
  value: Record<string, unknown>,
  attemptId: AttemptId,
  rawLine: string,
  resultMode: AgentResultSchemaMode,
): AgentEvent {
  const output = extractResultOutput(value);
  if (output === undefined) {
    // turn.completed without structured output is a lifecycle raw record.
    if (value.type === 'turn.completed') {
      return asOutput(attemptId, safeJson(value));
    }
    return parseError(attemptId, rawLine, 'result event missing output payload');
  }

  let jsonOutput: JsonValue;
  try {
    assertJsonValue(output);
    jsonOutput = output;
  } catch {
    return parseError(
      attemptId,
      rawLine,
      'result output is not a JSON-compatible value',
    );
  }

  const schemaOutcome = parseAgentResultForMode(jsonOutput, resultMode);
  if (!schemaOutcome.success) {
    return parseError(
      attemptId,
      rawLine,
      `result schema mismatch: ${schemaOutcome.reason}`,
    );
  }

  const conversationId = extractConversationId(value);
  return Object.freeze({
    type: 'result' as const,
    attemptId,
    ...(conversationId === undefined ? {} : { conversationId }),
    // Preserve agent claims verbatim (Task 8: claims, not derived evidence).
    output: schemaOutcome.result as unknown as JsonValue,
  });
}

function safeJson(value: unknown, redactor: Redactor = DEFAULT_REDACTOR): string {
  try {
    // Redact JSON structure first (sensitive keys + secret values), then
    // sanitize terminal controls and bound length.
    let jsonText: string;
    try {
      const redacted = redactor.redact(value as JsonValue);
      jsonText = JSON.stringify(redacted.value);
    } catch {
      jsonText = JSON.stringify(value);
    }
    return redactAndSanitizeText(jsonText, 64 * 1024, redactor);
  } catch {
    return '[unserializable-event]';
  }
}

/**
 * Parse a multi-line JSONL blob (recorded fixtures) into AgentEvents.
 * Empty lines are skipped; each non-empty line is independent.
 */
export function parseCodexJsonl(
  text: string,
  attemptId: AttemptId,
  options: ParseCodexEventOptions = {},
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const event = parseCodexEventLine(line, attemptId, options);
    if (event !== null) events.push(event);
  }
  return Object.freeze(events);
}
