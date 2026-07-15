import { Buffer } from 'node:buffer';

import stripAnsi from 'strip-ansi';

import type { RunExitReason } from '../domain/attempt.js';
import {
  serializeJsonValue,
  type JsonValue,
} from '../persistence/json-value.js';
import { Redactor } from './redact.js';

const TRUNCATION_MARKER = '[truncated]';

export interface SanitizeTerminalOptions {
  readonly maxLineCharacters?: number;
  readonly maxChunkCharacters?: number;
}

export interface SanitizedTerminal {
  readonly text: string;
  readonly truncated: boolean;
}

function positiveLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function truncateWithMarker(input: string, limit: number): string {
  if (input.length <= limit) return input;
  if (limit <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, limit);
  }
  return `${input.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function removeResidualTerminalControls(input: string): string {
  return input
    // OSC (title, hyperlink, clipboard, and other operating-system commands).
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/gu, '')
    .replace(/\u009d[\s\S]*?(?:\u0007|\u009c|\u001b\\|$)/gu, '')
    // DCS, SOS, PM, and APC strings, terminated by ST or the end of the chunk.
    .replace(/\u001b[P^_X][\s\S]*?(?:\u001b\\|$)/gu, '')
    .replace(/[\u0090\u0098\u009e\u009f][\s\S]*?(?:\u009c|\u001b\\|$)/gu, '')
    // CSI and short ESC sequences that strip-ansi did not recognize.
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b[ -/]*[@-Z\\-_]/gu, '')
    .replace(/\r\n?/gu, '\n')
    // Preserve horizontal tab and newline; remove all remaining C0/C1 controls.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
}

export function sanitizeTerminal(
  input: string,
  options: SanitizeTerminalOptions = {},
): SanitizedTerminal {
  const maxLineCharacters = positiveLimit(
    options.maxLineCharacters ?? 16 * 1024,
    'maxLineCharacters',
  );
  const maxChunkCharacters = positiveLimit(
    options.maxChunkCharacters ?? 64 * 1024,
    'maxChunkCharacters',
  );
  const stripped = removeResidualTerminalControls(stripAnsi(input));
  let truncated = false;
  const boundedLines = stripped.split('\n').map((line) => {
    if (line.length <= maxLineCharacters) return line;
    truncated = true;
    return truncateWithMarker(line, maxLineCharacters);
  });
  let text = boundedLines.join('\n');
  if (text.length > maxChunkCharacters) {
    truncated = true;
    text = truncateWithMarker(text, maxChunkCharacters);
  }
  return { text, truncated };
}

export interface SafeDisplayJson extends SanitizedTerminal {
  readonly redactionApplied: boolean;
}

export function safeDisplayJson(
  input: unknown,
  redactor: Redactor,
  options: SanitizeTerminalOptions = {},
): SafeDisplayJson {
  const redacted = redactor.redact(input);
  let nestedTruncated = false;
  const sanitizeValue = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') {
      const sanitized = sanitizeTerminal(value, options);
      nestedTruncated ||= sanitized.truncated;
      return sanitized.text;
    }
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sanitizeValue);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry)]),
    );
  };
  const sanitized = sanitizeTerminal(serializeJsonValue(sanitizeValue(redacted.value)), options);
  return {
    text: sanitized.text,
    truncated: nestedTruncated || sanitized.truncated,
    redactionApplied: redacted.redactionApplied,
  };
}

export type DisplayPriority = 'low' | 'normal' | 'high';

export interface DisplayEvent {
  readonly eventType: string;
  readonly text: string;
  readonly priority: DisplayPriority;
  readonly truncated?: boolean;
}

export interface EmittedDisplayEvent {
  readonly eventType: string;
  readonly text: string;
  readonly priority: DisplayPriority;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface TerminalDisplayRateLimiterOptions {
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly windowMs: number;
  readonly clock?: () => number;
}

type RunExitDisplayEventType = `run_${RunExitReason}`;
type WorkerProtocolTerminalOrErrorEventType = 'run_exited' | 'worker_failed';
type ProcessHostTerminalOrErrorEventType =
  | 'exited'
  | 'tree_clean'
  | 'cleanup_failed'
  | 'start_failed';

export type NonDroppableDisplayEventType =
  | 'error'
  | 'fatal'
  | RunExitDisplayEventType
  | 'run_succeeded'
  | WorkerProtocolTerminalOrErrorEventType
  | ProcessHostTerminalOrErrorEventType;

export const NON_DROPPABLE_DISPLAY_EVENT_TYPES = [
  'cleanup_failed',
  'error',
  'exited',
  'fatal',
  'run_cancelled',
  'run_completed',
  'run_exited',
  'run_failed',
  'run_interrupted',
  'run_succeeded',
  'run_timed_out',
  'start_failed',
  'tree_clean',
  'worker_failed',
] as const satisfies readonly NonDroppableDisplayEventType[];

type AssertNever<Value extends never> = Value;
type _AllNonDroppableEventsCovered = AssertNever<
  Exclude<
    NonDroppableDisplayEventType,
    (typeof NON_DROPPABLE_DISPLAY_EVENT_TYPES)[number]
  >
>;

const nonDroppableDisplayEventTypes = new Set<string>(
  NON_DROPPABLE_DISPLAY_EVENT_TYPES,
);

function isTerminalOrErrorEvent(eventType: string): boolean {
  return nonDroppableDisplayEventTypes.has(eventType);
}

export class TerminalDisplayRateLimiter {
  private readonly clock: () => number;
  private windowStartedAt: number;
  private emittedEvents = 0;
  private emittedBytes = 0;
  private droppedEvents = 0;
  private droppedBytes = 0;

  public constructor(private readonly options: TerminalDisplayRateLimiterOptions) {
    for (const [field, value] of [
      ['maxEvents', options.maxEvents],
      ['maxBytes', options.maxBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative integer`);
      }
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new Error('windowMs must be a positive integer');
    }
    this.clock = options.clock ?? Date.now;
    this.windowStartedAt = this.clock();
  }

  public accept(event: DisplayEvent): readonly EmittedDisplayEvent[] {
    const output = this.rollWindow(this.clock());
    const emitted = event.truncated === true
      ? {
          eventType: 'truncated',
          text: event.text,
          priority: event.priority,
          metadata: { originalEventType: event.eventType, truncated: true },
        } satisfies EmittedDisplayEvent
      : {
          eventType: event.eventType,
          text: event.text,
          priority: event.priority,
        } satisfies EmittedDisplayEvent;

    const bytes = Buffer.byteLength(event.text, 'utf8');
    if (event.priority !== 'low' || isTerminalOrErrorEvent(event.eventType)) {
      output.push(...this.takeSummary(), emitted);
      return output;
    }
    if (
      this.emittedEvents + 1 > this.options.maxEvents ||
      this.emittedBytes + bytes > this.options.maxBytes
    ) {
      this.droppedEvents += 1;
      this.droppedBytes += bytes;
      return output;
    }
    this.emittedEvents += 1;
    this.emittedBytes += bytes;
    output.push(emitted);
    return output;
  }

  public flush(): readonly EmittedDisplayEvent[] {
    return this.takeSummary();
  }

  private rollWindow(now: number): EmittedDisplayEvent[] {
    if (now - this.windowStartedAt < this.options.windowMs) return [];
    const summary = this.takeSummary();
    this.windowStartedAt = now;
    this.emittedEvents = 0;
    this.emittedBytes = 0;
    return summary;
  }

  private takeSummary(): EmittedDisplayEvent[] {
    if (this.droppedEvents === 0) return [];
    const droppedEvents = this.droppedEvents;
    const droppedBytes = this.droppedBytes;
    this.droppedEvents = 0;
    this.droppedBytes = 0;
    return [{
      eventType: 'rate_limited',
      text: `[rate limited: ${droppedEvents} events, ${droppedBytes} bytes omitted]`,
      priority: 'high',
      metadata: { droppedEvents, droppedBytes, truncated: true },
    }];
  }
}
