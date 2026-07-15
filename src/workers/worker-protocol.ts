import { z } from 'zod';

import type { AgentEvent, AgentMessage } from '../agents/agent-adapter.js';
import {
  asAttemptId,
  asConversationId,
  type AttemptId,
  type ConversationId,
} from '../domain/ids.js';
import { AGENT_KINDS, AGENT_ROLES, type AgentKind, type AgentRole } from '../domain/task.js';
import { Redactor } from '../logging/redact.js';
import { assertJsonValue, type JsonValue } from '../persistence/json-value.js';

/** Hard cap on serialized IPC message size before parse/dispatch (bytes). */
export const MAX_WORKER_IPC_MESSAGE_BYTES = 256 * 1024;

/** Soft cap for display/event payload text after redaction. */
export const MAX_WORKER_EVENT_TEXT_CHARS = 16 * 1024;

const NonBlankStringSchema = z.string().min(1).regex(/\S/u);

const AttemptIdSchema = NonBlankStringSchema.transform((value) => asAttemptId(value));
const ConversationIdSchema = NonBlankStringSchema.transform((value) =>
  asConversationId(value),
);

const AgentKindSchema = z.enum(AGENT_KINDS);
const AgentRoleSchema = z.enum(AGENT_ROLES);

const JsonValueSchema = z.custom<JsonValue>((value) => {
  try {
    assertJsonValue(value);
    return true;
  } catch {
    return false;
  }
}, { message: 'value must be JSON-compatible' });

const MessageStateSchema = z.enum([
  'queued',
  'delivered',
  'acknowledged',
  'applied',
  'failed',
]);

const AgentMessageSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  sequence: z.number().int().positive(),
  content: NonBlankStringSchema,
  state: MessageStateSchema,
  error: z.string().optional(),
});

const ProcessExitReasonSchema = z.enum([
  'exited',
  'timed_out',
  'graceful_stop',
  'force_stop',
]);

const CleanupOperationSchema = z.enum(['graceful_stop', 'force_stop_tree']);

/**
 * Main -> Worker control messages.
 * Secrets must never be required fields; env is optional and redacted on bounce errors.
 */
export const StartRunMessageSchema = z.strictObject({
  type: z.literal('start_run'),
  attemptId: AttemptIdSchema,
  taskId: NonBlankStringSchema,
  role: AgentRoleSchema,
  agentKind: AgentKindSchema,
  projectRoot: NonBlankStringSchema,
  prompt: NonBlankStringSchema,
  baselineId: NonBlankStringSchema,
  requirementVersion: z.number().int().positive(),
  timeoutMs: z.number().int().positive().optional(),
  conversationId: NonBlankStringSchema.optional(),
  executable: NonBlankStringSchema,
  args: z.array(z.string()),
  environment: z.record(z.string(), z.string()).optional(),
  /**
   * Supervisor binding:
   * - `fake`: deterministic in-thread fake (Task 11)
   * - `inject`: reserved test injection seam
   * - `process_host`: real Windows ProcessHost Job Object supervision (Task 12)
   */
  supervisorMode: z.enum(['fake', 'inject', 'process_host']).default('fake'),
  /** Absolute path to triagent-process-host.exe when supervisorMode is process_host. */
  processHostPath: NonBlankStringSchema.optional(),
  crashOnParse: z.boolean().optional(),
  /** When true, the worker loads the crashing parser fixture. */
  useCrashingParser: z.boolean().optional(),
  /**
   * Opaque one-time launch authorization id issued by WorkerStartGateVerifier.
   * Workers that use real adapters must pass only this id (never gate records).
   */
  launchAuthorizationId: NonBlankStringSchema.optional(),
});

export const StopRunMessageSchema = z.strictObject({
  type: z.literal('stop_run'),
  attemptId: AttemptIdSchema,
  mode: z.enum(['graceful', 'force']),
  graceMs: z.number().int().nonnegative().optional(),
});

export const DeliverMessageMessageSchema = z.strictObject({
  type: z.literal('deliver_message'),
  attemptId: AttemptIdSchema,
  sequence: z.number().int().positive(),
  content: NonBlankStringSchema,
});

export const MainToWorkerMessageSchema = z.discriminatedUnion('type', [
  StartRunMessageSchema,
  StopRunMessageSchema,
  DeliverMessageMessageSchema,
]);

export type StartRunMessage = z.infer<typeof StartRunMessageSchema>;
export type StopRunMessage = z.infer<typeof StopRunMessageSchema>;
export type DeliverMessageMessage = z.infer<typeof DeliverMessageMessageSchema>;
export type MainToWorkerMessage = z.infer<typeof MainToWorkerMessageSchema>;

const AgentEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('process_started'),
    attemptId: AttemptIdSchema,
    pid: z.number().int().positive(),
    occurredAt: NonBlankStringSchema,
  }),
  z.strictObject({
    type: z.literal('output'),
    attemptId: AttemptIdSchema,
    text: z.string(),
  }),
  z.strictObject({
    type: z.literal('result'),
    attemptId: AttemptIdSchema,
    conversationId: ConversationIdSchema.optional(),
    output: JsonValueSchema,
  }),
  z.strictObject({
    type: z.literal('parse_error'),
    attemptId: AttemptIdSchema,
    raw: z.string(),
    error: NonBlankStringSchema,
  }),
  z.strictObject({
    type: z.literal('stderr'),
    attemptId: AttemptIdSchema,
    chunk: z.string(),
    occurredAt: NonBlankStringSchema,
  }),
  z.strictObject({
    type: z.literal('descendant_started'),
    attemptId: AttemptIdSchema,
    pid: z.number().int().positive(),
    parentPid: z.number().int().positive(),
    occurredAt: NonBlankStringSchema,
  }),
  z.strictObject({
    type: z.literal('cleanup_succeeded'),
    attemptId: AttemptIdSchema,
    operation: CleanupOperationSchema,
    occurredAt: NonBlankStringSchema,
  }),
  z.strictObject({
    type: z.literal('cleanup_failed'),
    attemptId: AttemptIdSchema,
    operation: CleanupOperationSchema,
    occurredAt: NonBlankStringSchema,
    error: NonBlankStringSchema,
  }),
  z.strictObject({
    type: z.literal('process_exited'),
    attemptId: AttemptIdSchema,
    pid: z.number().int().positive(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    reason: ProcessExitReasonSchema,
    occurredAt: NonBlankStringSchema,
  }),
  z.strictObject({
    type: z.literal('message_state'),
    attemptId: AttemptIdSchema,
    message: AgentMessageSchema,
  }),
]);

export const WorkerEventMessageSchema = z.strictObject({
  type: z.literal('event'),
  attemptId: AttemptIdSchema,
  event: AgentEventSchema,
  displayPriority: z.enum(['low', 'normal', 'high']).default('normal'),
});

export const HeartbeatMessageSchema = z.strictObject({
  type: z.literal('heartbeat'),
  workerId: NonBlankStringSchema,
  attemptId: AttemptIdSchema.optional(),
  sequence: z.number().int().nonnegative(),
  sentAt: NonBlankStringSchema,
});

export const RunExitedMessageSchema = z.strictObject({
  type: z.literal('run_exited'),
  attemptId: AttemptIdSchema,
  status: z.enum(['succeeded', 'failed', 'timed_out', 'stopped']),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().optional(),
  endedAt: NonBlankStringSchema,
});

export const WorkerFailedMessageSchema = z.strictObject({
  type: z.literal('worker_failed'),
  workerId: NonBlankStringSchema,
  attemptId: AttemptIdSchema.optional(),
  reasonCode: z.enum([
    'crash',
    'heartbeat_timeout',
    'protocol_violation',
    'oversized_message',
    'unhandled_error',
  ]),
  message: NonBlankStringSchema,
  occurredAt: NonBlankStringSchema,
  fatal: z.boolean(),
});

/**
 * Raw process output evidence emitted BEFORE Adapter parsing so a parser crash
 * cannot erase the crash-triggering chunk from durable main-process logs.
 */
export const RawOutputMessageSchema = z.strictObject({
  type: z.literal('raw_output'),
  attemptId: AttemptIdSchema,
  stream: z.enum(['stdout', 'stderr']),
  chunk: z.string(),
  occurredAt: NonBlankStringSchema,
});

export const WorkerToMainMessageSchema = z.discriminatedUnion('type', [
  WorkerEventMessageSchema,
  HeartbeatMessageSchema,
  RunExitedMessageSchema,
  WorkerFailedMessageSchema,
  RawOutputMessageSchema,
]);

export type WorkerEventMessage = z.infer<typeof WorkerEventMessageSchema>;
export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;
export type RunExitedMessage = z.infer<typeof RunExitedMessageSchema>;
export type WorkerFailedMessage = z.infer<typeof WorkerFailedMessageSchema>;
export type RawOutputMessage = z.infer<typeof RawOutputMessageSchema>;
export type WorkerToMainMessage = z.infer<typeof WorkerToMainMessageSchema>;

export type WorkerIpcMessage = MainToWorkerMessage | WorkerToMainMessage;

export type WorkerIpcParseResult =
  | { readonly ok: true; readonly message: WorkerIpcMessage }
  | {
      readonly ok: false;
      readonly reasonCode: 'oversized_message' | 'invalid_json' | 'schema_violation';
      readonly message: string;
    };

const defaultRedactor = new Redactor();

/**
 * Safely serialize for size measurement. JSON.stringify returns `undefined`
 * for undefined / symbols / functions (and throws on cycles) — never pass that
 * through to Buffer.byteLength.
 */
function trySerializeForSize(
  value: unknown,
): { readonly ok: true; readonly serialized: string }
  | { readonly ok: false; readonly reason: 'invalid_json' } {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (typeof serialized !== 'string') {
    return { ok: false, reason: 'invalid_json' };
  }
  return { ok: true, serialized };
}

function measureSerializedBytes(value: unknown): number {
  const result = trySerializeForSize(value);
  if (!result.ok) {
    throw new WorkerProtocolError(
      'invalid_json',
      'IPC message is not JSON-serializable',
    );
  }
  return Buffer.byteLength(result.serialized, 'utf8');
}

function boundedParseFailureMessage(message: string): string {
  if (message.length <= 512) return message;
  return `${message.slice(0, 500)}[truncated]`;
}

/**
 * Measure and validate before dispatch. Rejects oversized / hostile payloads
 * without throwing raw TypeError and without echoing secrets from the body.
 */
export function parseWorkerIpcMessage(
  raw: unknown,
  direction: 'main_to_worker' | 'worker_to_main',
  options: {
    readonly maxBytes?: number;
    readonly redactor?: Redactor;
  } = {},
): WorkerIpcParseResult {
  try {
    const maxBytes = options.maxBytes ?? MAX_WORKER_IPC_MESSAGE_BYTES;
    const redactor = options.redactor ?? defaultRedactor;

    if (typeof raw === 'string') {
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
        return {
          ok: false,
          reasonCode: 'oversized_message',
          message: boundedParseFailureMessage(
            `IPC message exceeds maximum size of ${String(maxBytes)} bytes`,
          ),
        };
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return {
          ok: false,
          reasonCode: 'invalid_json',
          message: boundedParseFailureMessage('IPC message is not valid JSON'),
        };
      }
      return parseWorkerIpcValue(value, direction, maxBytes, redactor);
    }

    const serialized = trySerializeForSize(raw);
    if (!serialized.ok) {
      return {
        ok: false,
        reasonCode: 'invalid_json',
        message: boundedParseFailureMessage(
          'IPC message is not JSON-serializable',
        ),
      };
    }
    if (Buffer.byteLength(serialized.serialized, 'utf8') > maxBytes) {
      return {
        ok: false,
        reasonCode: 'oversized_message',
        message: boundedParseFailureMessage(
          `IPC message exceeds maximum size of ${String(maxBytes)} bytes`,
        ),
      };
    }
    return parseWorkerIpcValue(raw, direction, maxBytes, redactor);
  } catch (error) {
    return {
      ok: false,
      reasonCode: 'invalid_json',
      message: boundedParseFailureMessage(
        `IPC parse failure: ${redactBoundedError(error)}`,
      ),
    };
  }
}

function parseWorkerIpcValue(
  value: unknown,
  direction: 'main_to_worker' | 'worker_to_main',
  maxBytes: number,
  redactor: Redactor,
): WorkerIpcParseResult {
  void maxBytes;
  const schema = direction === 'main_to_worker'
    ? MainToWorkerMessageSchema
    : WorkerToMainMessageSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    let safeDetail: unknown = { issues: parsed.error.issues.length };
    try {
      safeDetail = redactor.redact({
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      }).value;
    } catch {
      // Keep a minimal secret-safe summary.
    }
    return {
      ok: false,
      reasonCode: 'schema_violation',
      message: boundedParseFailureMessage(
        `IPC schema violation: ${JSON.stringify(safeDetail)}`,
      ),
    };
  }
  return { ok: true, message: parsed.data as WorkerIpcMessage };
}

export function assertWorkerIpcMessageSize(
  value: unknown,
  maxBytes: number = MAX_WORKER_IPC_MESSAGE_BYTES,
): void {
  const serialized = trySerializeForSize(value);
  if (!serialized.ok) {
    throw new WorkerProtocolError(
      'invalid_json',
      'IPC message is not JSON-serializable',
    );
  }
  const bytes = Buffer.byteLength(serialized.serialized, 'utf8');
  if (bytes > maxBytes) {
    throw new WorkerProtocolError(
      'oversized_message',
      `IPC message exceeds maximum size of ${String(maxBytes)} bytes`,
    );
  }
}

export function encodeWorkerIpcMessage(
  message: WorkerIpcMessage,
  maxBytes: number = MAX_WORKER_IPC_MESSAGE_BYTES,
): WorkerIpcMessage {
  assertWorkerIpcMessageSize(message, maxBytes);
  return message;
}

export function displayPriorityForAgentEvent(
  event: AgentEvent,
): 'low' | 'normal' | 'high' {
  switch (event.type) {
    case 'output':
    case 'stderr':
      return 'low';
    case 'process_started':
    case 'descendant_started':
    case 'message_state':
      return 'normal';
    case 'result':
    case 'parse_error':
    case 'cleanup_succeeded':
    case 'cleanup_failed':
    case 'process_exited':
      return 'high';
  }
}

export function isTerminalOrRunStateEvent(event: AgentEvent): boolean {
  return (
    event.type === 'result'
    || event.type === 'parse_error'
    || event.type === 'process_exited'
    || event.type === 'cleanup_failed'
    || event.type === 'cleanup_succeeded'
    || event.type === 'process_started'
  );
}

export function redactBoundedError(
  error: unknown,
  redactor: Redactor = defaultRedactor,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactor.redact(raw).value;
  const text = typeof redacted === 'string' ? redacted : 'error';
  if (text.length <= 512) return text;
  return `${text.slice(0, 500)}[truncated]`;
}

export function truncateDisplayText(
  text: string,
  maxChars: number = MAX_WORKER_EVENT_TEXT_CHARS,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 11))}[truncated]`,
    truncated: true,
  };
}

export class WorkerProtocolError extends Error {
  public override readonly name = 'WorkerProtocolError';

  public constructor(
    public readonly reasonCode:
      | 'oversized_message'
      | 'invalid_json'
      | 'schema_violation'
      | 'stale_attempt',
    message: string,
  ) {
    super(message);
  }
}

export type { AgentKind, AgentRole, AttemptId, AgentMessage, ConversationId };
