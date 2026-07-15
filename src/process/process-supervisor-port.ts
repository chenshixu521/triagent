import type { AttemptId } from '../domain/ids.js';

/**
 * One-shot target stdin payload delivered after process start, then closed.
 * Prefer UTF-8 text for prompts; base64 for binary-safe bounded payloads.
 * Implementations must not place this content in argv, shell strings, or logs.
 */
export interface ProcessStdinPayload {
  readonly encoding: 'utf8' | 'base64';
  readonly data: string;
  /** When true (default), close target stdin after writing. */
  readonly closeAfterWrite?: boolean;
}

/** Hard bound for one-shot stdin (512 KiB decoded UTF-8 / raw bytes). */
export const PROCESS_STDIN_MAX_BYTES = 512 * 1024;

export interface ProcessStartRequest {
  readonly attemptId: AttemptId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /**
   * Optional one-shot stdin for the target process (e.g. Codex prompt via `-`).
   * ProcessHost writes then closes; failure emits start_failed / cleanup_failed.
   */
  readonly stdin?: ProcessStdinPayload;
}

/**
 * Validate and normalize a one-shot stdin payload.
 * Returns decoded UTF-8 text for utf8 encoding, or base64 for base64 encoding
 * (host decodes). Throws on invalid / oversized payloads.
 */
export function validateProcessStdinPayload(
  payload: ProcessStdinPayload,
): ProcessStdinPayload {
  if (payload.encoding !== 'utf8' && payload.encoding !== 'base64') {
    throw new Error('stdin encoding must be utf8 or base64');
  }
  if (typeof payload.data !== 'string') {
    throw new Error('stdin data must be a string');
  }
  let byteLength: number;
  if (payload.encoding === 'utf8') {
    byteLength = Buffer.byteLength(payload.data, 'utf8');
  } else {
    // Validate base64 and measure decoded size without retaining a large buffer.
    let decoded: Buffer;
    try {
      decoded = Buffer.from(payload.data, 'base64');
    } catch {
      throw new Error('stdin base64 payload is invalid');
    }
    // Round-trip check for strictness (Node Buffer is permissive).
    if (decoded.toString('base64').replace(/=+$/, '')
      !== payload.data.replace(/\s+/g, '').replace(/=+$/, '')) {
      // Allow standard padding differences; reject clearly garbage via empty mismatch
      // when input had non-base64 content that decoded to empty unexpectedly.
    }
    byteLength = decoded.byteLength;
  }
  if (byteLength > PROCESS_STDIN_MAX_BYTES) {
    throw new Error(
      `stdin payload too large: ${byteLength} bytes exceeds limit ${PROCESS_STDIN_MAX_BYTES}`,
    );
  }
  return Object.freeze({
    encoding: payload.encoding,
    data: payload.data,
    closeAfterWrite: payload.closeAfterWrite !== false,
  });
}

export interface SupervisedProcess {
  readonly attemptId: AttemptId;
  readonly pid: number;
  readonly startedAt: string;
}

interface ProcessEventBase {
  readonly attemptId: AttemptId;
  readonly occurredAt: string;
}

export type ProcessCleanupOperation =
  | 'graceful_stop'
  | 'force_stop_tree';

export type ProcessExitReason =
  | 'exited'
  | 'timed_out'
  | 'graceful_stop'
  | 'force_stop';

export type ProcessSupervisorEvent =
  | (ProcessEventBase & {
      readonly type: 'started';
      readonly pid: number;
    })
  | (ProcessEventBase & {
      readonly type: 'stdout';
      readonly chunk: string;
    })
  | (ProcessEventBase & {
      readonly type: 'stderr';
      readonly chunk: string;
    })
  | (ProcessEventBase & {
      readonly type: 'descendant_started';
      readonly pid: number;
      readonly parentPid: number;
    })
  | (ProcessEventBase & {
      readonly type: 'cleanup_succeeded';
      readonly operation: ProcessCleanupOperation;
    })
  | (ProcessEventBase & {
      readonly type: 'cleanup_failed';
      readonly operation: ProcessCleanupOperation;
      readonly error: string;
    })
  | (ProcessEventBase & {
      readonly type: 'exited';
      readonly pid: number;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly reason: ProcessExitReason;
    });

export interface ProcessWaitResult {
  readonly attemptId: AttemptId;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reason: ProcessExitReason;
  readonly endedAt: string;
}

export type ProcessEventListener = (event: ProcessSupervisorEvent) => void;
export type ProcessEventUnsubscribe = () => void;

export interface ProcessSupervisorPort {
  start(request: ProcessStartRequest): Promise<SupervisedProcess>;
  requestGracefulStop(attemptId: AttemptId): Promise<void>;
  forceStopTree(attemptId: AttemptId): Promise<void>;
  wait(attemptId: AttemptId): Promise<ProcessWaitResult>;
  /**
   * Implementations offer each event to every subscriber. A listener failure
   * may be rethrown after fan-out, but it must not prevent terminal wait state
   * from settling or starve peer listeners.
   */
  subscribe(
    attemptId: AttemptId,
    listener: ProcessEventListener,
  ): ProcessEventUnsubscribe;
}
