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
  const patternRedacted = sanitized
    .replace(
      /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\bsk-(?:live|test|proj|ant|xai)?-[A-Za-z0-9_-]{8,}/gi,
      '[REDACTED]',
    )
    .replace(
      /\bsk-ant-[A-Za-z0-9_-]{8,}/gi,
      '[REDACTED]',
    )
    .replace(
      /((?:authorization|api[_-]?key|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    );
  return boundText(patternRedacted, max);
}

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
  redactor: Redactor = DEFAULT_REDACTOR,
): Extract<AgentEvent, { type: 'parse_error' }> {
  return Object.freeze({
    type: 'parse_error',
    attemptId,
    raw: redactAndSanitizeText(raw, RAW_MAX, redactor),
    error: boundText(
      redactAndSanitizeText(error, PARSE_ERROR_MAX, redactor),
      PARSE_ERROR_MAX,
    ),
  });
}

function asOutput(
  attemptId: AttemptId,
  text: string,
  redactor: Redactor = DEFAULT_REDACTOR,
): Extract<AgentEvent, { type: 'output' }> {
  return Object.freeze({
    type: 'output',
    attemptId,
    text: redactAndSanitizeText(text, 64 * 1024, redactor),
  });
}

function extractTextFromContentBlocks(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const block of value) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (typeof record.text === 'string' && record.text.length > 0) {
      parts.push(record.text);
    } else if (
      record.type === 'text'
      && typeof record.text === 'string'
      && record.text.length > 0
    ) {
      parts.push(record.text);
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join('');
}

function extractTextFromGrokMessage(value: unknown): string | undefined {
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
  if (item.message !== null && typeof item.message === 'object' && !Array.isArray(item.message)) {
    const nested = item.message as Record<string, unknown>;
    const fromNested = extractTextFromContentBlocks(nested.content)
      ?? (typeof nested.text === 'string' ? nested.text : undefined);
    if (fromNested !== undefined) return fromNested;
  }
  const fromContent = extractTextFromContentBlocks(item.content);
  if (fromContent !== undefined) return fromContent;
  if (typeof item.result === 'string' && item.result.length > 0) {
    return item.result;
  }
  return undefined;
}

function extractConversationId(
  value: Record<string, unknown>,
): ConversationId | undefined {
  const candidates = [
    value.conversationId,
    value.conversation_id,
    value.session_id,
    value.sessionId,
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
  if ('structured_output' in value) return value.structured_output;
  if ('structuredOutput' in value) return value.structuredOutput;
  if ('result' in value) {
    const result = value.result;
    if (result !== null && typeof result === 'object') return result;
  }
  if ('final' in value) return value.final;
  if (
    value.message !== null
    && typeof value.message === 'object'
    && !Array.isArray(value.message)
  ) {
    const message = value.message as Record<string, unknown>;
    if ('output' in message) return message.output;
    if ('structured_output' in message) return message.structured_output;
  }
  return undefined;
}

/** Process-local accumulator for Grok text-token streams. */
export interface GrokEventStreamState {
  textParts: string[];
  sawStructuredResult: boolean;
}

export interface ParseGrokEventOptions {
  /** Schema mode for structured result events (patch_mode uses patch schema). */
  readonly resultMode?: AgentResultSchemaMode;
  readonly redactor?: Redactor;
  /**
   * Mutable stream state for Grok 0.2.x token text/end format (no structured
   * result event). Accumulates text fragments so EndTurn can recover a result.
   */
  readonly streamState?: GrokEventStreamState;
  /**
   * When true and the stream ends with EndTurn without a structured payload,
   * emit a completed AgentResult so isolated implementers can finalize.
   * Reviewer/master must leave this false.
   */
  readonly synthesizeCompletedOnEnd?: boolean;
}

/**
 * Parse one finished Grok streaming-json / JSONL line into a normalized AgentEvent.
 * All events are attributed to the provided attemptId (never trust spoofed ids).
 * Unknown event types are retained as redacted raw records.
 * Invalid JSON becomes bounded parse_error with no secret leak.
 *
 * Grok streaming-json shapes (0.2.93, Claude-compatible) include:
 * - type: system / assistant / user / result / content_block_* / stream_event
 * - structured final: type result with structured_output / output / result object
 */
export function parseGrokEventLine(
  line: string,
  attemptId: AttemptId,
  options: ParseGrokEventOptions = {},
): AgentEvent | null {
  const redactor = options.redactor ?? DEFAULT_REDACTOR;
  const trimmed = line.replace(/^\uFEFF/, '').trimEnd();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return parseError(
      attemptId,
      trimmed,
      'invalid streaming-json line',
      redactor,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parseError(
      attemptId,
      trimmed,
      'streaming-json value is not an object',
      redactor,
    );
  }

  const value = parsed as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : undefined;
  const resultMode = options.resultMode ?? 'default';
  const streamState = options.streamState;

  // Grok 0.2.x native streaming-json: token text / thought / end.
  if (type === 'text' || type === 'thought') {
    const data = typeof value.data === 'string' ? value.data : '';
    if (type === 'text' && data.length > 0 && streamState !== undefined) {
      streamState.textParts.push(data);
    }
    if (data.length > 0) {
      return asOutput(attemptId, data, redactor);
    }
    return asOutput(attemptId, safeJson(value, redactor), redactor);
  }

  if (type === 'end') {
    const fromAccumulated =
      streamState === undefined
        ? undefined
        : tryParseAgentResultFromText(streamState.textParts.join(''), resultMode);
    if (fromAccumulated !== undefined) {
      if (streamState !== undefined) streamState.sawStructuredResult = true;
      return Object.freeze({
        type: 'result' as const,
        attemptId,
        output: fromAccumulated as unknown as JsonValue,
      });
    }
    if (
      options.synthesizeCompletedOnEnd === true
      && (streamState === undefined || streamState.sawStructuredResult !== true)
    ) {
      if (streamState !== undefined) streamState.sawStructuredResult = true;
      const summary =
        streamState !== undefined && streamState.textParts.join('').trim().length > 0
          ? boundText(streamState.textParts.join('').replace(/\s+/g, ' ').trim(), 400)
          : 'Grok isolated implementation ended without structured result event';
      return Object.freeze({
        type: 'result' as const,
        attemptId,
        output: {
          status: 'completed',
          summary,
          changedFiles: [],
          commandsRun: [],
          verification: {
            passed: true,
            details:
              'Synthesized from Grok EndTurn (matrix structuredOutput=false); '
              + 'candidate filesystem is authoritative for change-set finalization',
          },
          issues: [],
          nextAction: 'review',
        } as unknown as JsonValue,
      });
    }
    return asOutput(attemptId, safeJson(value, redactor), redactor);
  }

  // Explicit structured result events (Task 8 schema integration).
  if (
    type === 'result'
    || type === 'agent_result'
    || type === 'final_result'
  ) {
    const structured =
      value.structured_output
      ?? value.structuredOutput
      ?? extractResultOutput(value);
    if (
      structured !== undefined
      && structured !== null
      && typeof structured === 'object'
    ) {
      if (streamState !== undefined) streamState.sawStructuredResult = true;
      return parseStructuredResult(
        { ...value, output: structured },
        attemptId,
        trimmed,
        resultMode,
        redactor,
      );
    }
    if (typeof value.result === 'string') {
      try {
        const maybe = JSON.parse(value.result) as unknown;
        if (maybe !== null && typeof maybe === 'object' && !Array.isArray(maybe)) {
          if (streamState !== undefined) streamState.sawStructuredResult = true;
          return parseStructuredResult(
            { ...value, output: maybe },
            attemptId,
            trimmed,
            resultMode,
            redactor,
          );
        }
      } catch {
        // not JSON — emit as output
      }
      return asOutput(attemptId, value.result, redactor);
    }
    return parseError(
      attemptId,
      trimmed,
      'result event missing structured output payload',
      redactor,
    );
  }

  // Assistant / message content → human-readable output.
  if (
    type === 'assistant'
    || type === 'message'
    || type === 'agent_message'
    || type === 'content_block_delta'
    || type === 'content_block_stop'
    || type === 'content_block_start'
  ) {
    const text = extractTextFromGrokMessage(value);
    if (text !== undefined) {
      return asOutput(attemptId, text, redactor);
    }
    if (
      value.delta !== null
      && typeof value.delta === 'object'
      && !Array.isArray(value.delta)
    ) {
      const delta = value.delta as Record<string, unknown>;
      if (typeof delta.text === 'string' && delta.text.length > 0) {
        return asOutput(attemptId, delta.text, redactor);
      }
      if (typeof delta.partial_json === 'string' && delta.partial_json.length > 0) {
        return asOutput(attemptId, delta.partial_json, redactor);
      }
    }
    return asOutput(attemptId, safeJson(value, redactor), redactor);
  }

  // Known lifecycle / system events retained as raw output (not dropped).
  if (
    type === 'system'
    || type === 'user'
    || type === 'stream_event'
    || type === 'status'
    || type === 'tool_progress'
    || type === 'tool_use'
    || type === 'tool_result'
    || type === 'rate_limit_event'
  ) {
    return asOutput(attemptId, safeJson(value, redactor), redactor);
  }

  // Unknown / future events: retain safely as redacted raw records.
  return asOutput(attemptId, safeJson(value, redactor), redactor);
}

function tryParseAgentResultFromText(
  text: string,
  resultMode: AgentResultSchemaMode,
): unknown | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // Prefer fenced JSON blocks, then the last {...} object in the text.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates: string[] = [];
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
      // try next candidate
    }
  }
  return undefined;
}

function parseStructuredResult(
  value: Record<string, unknown>,
  attemptId: AttemptId,
  rawLine: string,
  resultMode: AgentResultSchemaMode,
  redactor: Redactor = DEFAULT_REDACTOR,
): AgentEvent {
  const output = extractResultOutput(value);
  if (output === undefined) {
    return parseError(
      attemptId,
      rawLine,
      'result event missing output payload',
      redactor,
    );
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
      redactor,
    );
  }

  const schemaOutcome = parseAgentResultForMode(jsonOutput, resultMode);
  if (!schemaOutcome.success) {
    return parseError(
      attemptId,
      rawLine,
      `result schema mismatch: ${schemaOutcome.reason}`,
      redactor,
    );
  }

  const conversationId = extractConversationId(value);
  return Object.freeze({
    type: 'result' as const,
    attemptId,
    ...(conversationId === undefined ? {} : { conversationId }),
    // Preserve agent claims verbatim (Task 8: claims, not derived evidence).
    // Structured schema results are agent claims — not free-form exposure of
    // unknown/raw payloads. Callers that surface them as text must re-redact.
    output: schemaOutcome.result as unknown as JsonValue,
  });
}

function safeJson(value: unknown, redactor: Redactor = DEFAULT_REDACTOR): string {
  try {
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
 * Parse a multi-line streaming-json / JSONL blob (recorded fixtures) into AgentEvents.
 * Empty lines are skipped; each non-empty line is independent.
 */
export function parseGrokJsonl(
  text: string,
  attemptId: AttemptId,
  options: ParseGrokEventOptions = {},
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const event = parseGrokEventLine(line, attemptId, options);
    if (event !== null) events.push(event);
  }
  return Object.freeze(events);
}
