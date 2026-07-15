import type {
  AgentEvent,
  AgentMessage,
  AgentMessageState,
  AgentRunResult,
} from './agent-adapter.js';
import type { AgentCapabilities } from './agent-capabilities.js';
import type { AttemptId, ConversationId } from '../domain/ids.js';
import type {
  ProcessSupervisorEvent,
  ProcessSupervisorPort,
  ProcessWaitResult,
} from '../process/process-supervisor-port.js';

export interface ExecutionHandle {
  readonly attemptId: AttemptId;
  events(): AsyncIterable<AgentEvent>;
  sendMessage(content: string): Promise<AgentMessage>;
  requestStop(): Promise<void>;
  forceKillTree(): Promise<void>;
  wait(): Promise<AgentRunResult>;
}

interface EventWaiter {
  readonly resolve: () => void;
}

class AgentEventFeed {
  readonly #events: AgentEvent[] = [];
  readonly #waiters = new Set<EventWaiter>();
  #closed = false;

  public publish(event: AgentEvent): void {
    if (this.#closed) return;
    this.#events.push(Object.freeze(event));
    this.#wake();
  }

  public close(): void {
    this.#closed = true;
    this.#wake();
  }

  public async *iterate(): AsyncIterableIterator<AgentEvent> {
    let index = 0;
    for (;;) {
      while (index < this.#events.length) {
        yield this.#events[index] as AgentEvent;
        index += 1;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#waiters.add({ resolve });
      });
    }
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }
}

export interface SupervisedExecutionHandleOptions {
  readonly attemptId: AttemptId;
  readonly conversationId?: ConversationId;
  readonly timeoutMs?: number;
  readonly capabilities: AgentCapabilities;
  readonly supervisor: ProcessSupervisorPort;
  readonly parseEvent: (line: string) => AgentEvent | null;
  readonly deliverMessage?: (message: AgentMessage) => Promise<void>;
}

export class SupervisedExecutionHandle implements ExecutionHandle {
  readonly #feed = new AgentEventFeed();
  readonly #messages: AgentMessage[] = [];
  readonly #conversationId?: ConversationId;
  readonly #timeoutMs?: number;
  readonly #capabilities: AgentCapabilities;
  readonly #supervisor: ProcessSupervisorPort;
  readonly #parseEvent: (line: string) => AgentEvent | null;
  readonly #deliverMessage?: (message: AgentMessage) => Promise<void>;
  readonly #unsubscribe: () => void;
  #stdoutBuffer = '';
  #stderr = '';
  #nextMessageSequence = 1;
  #structuredResult?: Extract<AgentEvent, { type: 'result' }>;
  #waitPromise?: Promise<AgentRunResult>;

  public readonly attemptId: AttemptId;

  public constructor(options: SupervisedExecutionHandleOptions) {
    this.attemptId = options.attemptId;
    this.#conversationId = options.conversationId;
    this.#timeoutMs = options.timeoutMs;
    this.#capabilities = options.capabilities;
    this.#supervisor = options.supervisor;
    this.#parseEvent = options.parseEvent;
    this.#deliverMessage = options.deliverMessage;
    this.#unsubscribe = options.supervisor.subscribe(
      options.attemptId,
      (event) => this.#acceptProcessEvent(event),
    );
  }

  public events(): AsyncIterable<AgentEvent> {
    return this.#feed.iterate();
  }

  public async sendMessage(content: string): Promise<AgentMessage> {
    const message = Object.freeze({
      attemptId: this.attemptId,
      sequence: this.#nextMessageSequence,
      content,
      state: 'queued' as const,
    });
    this.#nextMessageSequence += 1;
    this.#messages.push(message);
    this.#feed.publish({
      type: 'message_state',
      attemptId: this.attemptId,
      message,
    });
    if (!this.#capabilities.realTimeInput || this.#deliverMessage === undefined) {
      return message;
    }
    try {
      await this.#deliverMessage(message);
      return this.#transitionMessage(message.sequence, 'delivered');
    } catch (error) {
      return this.#transitionMessage(
        message.sequence,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  public async requestStop(): Promise<void> {
    await this.#supervisor.requestGracefulStop(this.attemptId);
  }

  public async forceKillTree(): Promise<void> {
    await this.#supervisor.forceStopTree(this.attemptId);
  }

  public wait(): Promise<AgentRunResult> {
    this.#waitPromise ??= this.#waitForResult();
    return this.#waitPromise;
  }

  async #waitForResult(): Promise<AgentRunResult> {
    const exit = await this.#supervisor.wait(this.attemptId);
    const status = this.#runStatus(exit);
    const conversationId = this.#conversationId
      ?? this.#structuredResult?.conversationId;
    const output = this.#structuredResult?.output;
    return Object.freeze({
      attemptId: this.attemptId,
      ...(conversationId === undefined ? {} : { conversationId }),
      status,
      exitCode: exit.exitCode,
      signal: exit.signal,
      ...(output === undefined ? {} : { output }),
      ...(status === 'failed' || status === 'timed_out'
        ? { error: this.#failureError(exit, status) }
        : {}),
      messages: Object.freeze([...this.#messages]),
    });
  }

  #runStatus(exit: ProcessWaitResult): AgentRunResult['status'] {
    if (exit.reason === 'timed_out') return 'timed_out';
    if (exit.reason === 'graceful_stop' || exit.reason === 'force_stop') {
      return 'stopped';
    }
    return exit.exitCode === 0 && this.#structuredResult !== undefined
      ? 'succeeded'
      : 'failed';
  }

  #failureError(
    exit: ProcessWaitResult,
    status: Extract<AgentRunResult['status'], 'failed' | 'timed_out'>,
  ): string {
    if (status === 'timed_out') {
      return this.#timeoutMs === undefined
        ? 'agent process timed out'
        : `agent process timed out after ${String(this.#timeoutMs)} ms`;
    }
    const stderr = this.#stderr.trim();
    if (exit.exitCode !== null && exit.exitCode !== 0) {
      return `agent process exited with code ${String(exit.exitCode)}${
        stderr.length === 0 ? '' : `: ${stderr}`
      }`;
    }
    return 'agent process ended without a structured result';
  }

  #acceptProcessEvent(event: ProcessSupervisorEvent): void {
    switch (event.type) {
      case 'started':
        this.#feed.publish({
          type: 'process_started',
          attemptId: this.attemptId,
          pid: event.pid,
          occurredAt: event.occurredAt,
        });
        return;
      case 'stdout':
        this.#acceptStdout(event.chunk);
        return;
      case 'stderr':
        this.#stderr += event.chunk;
        this.#feed.publish({
          type: 'stderr',
          attemptId: this.attemptId,
          chunk: event.chunk,
          occurredAt: event.occurredAt,
        });
        return;
      case 'descendant_started':
        this.#feed.publish({
          type: 'descendant_started',
          attemptId: this.attemptId,
          pid: event.pid,
          parentPid: event.parentPid,
          occurredAt: event.occurredAt,
        });
        return;
      case 'cleanup_succeeded':
        this.#feed.publish({
          type: 'cleanup_succeeded',
          attemptId: this.attemptId,
          operation: event.operation,
          occurredAt: event.occurredAt,
        });
        return;
      case 'cleanup_failed':
        this.#feed.publish({
          type: 'cleanup_failed',
          attemptId: this.attemptId,
          operation: event.operation,
          occurredAt: event.occurredAt,
          error: event.error,
        });
        return;
      case 'exited':
        this.#flushStdout();
        this.#feed.publish({
          type: 'process_exited',
          attemptId: this.attemptId,
          pid: event.pid,
          exitCode: event.exitCode,
          signal: event.signal ?? null,
          reason: event.reason,
          occurredAt: event.occurredAt,
        });
        this.#unsubscribe();
        this.#feed.close();
        return;
    }
  }

  #acceptStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      this.#acceptLine(line);
    }
  }

  #flushStdout(): void {
    const line = this.#stdoutBuffer.replace(/\r$/, '');
    this.#stdoutBuffer = '';
    if (line.length > 0) this.#acceptLine(line);
  }

  #acceptLine(line: string): void {
    if (line.length === 0) return;
    const event = this.#parseEvent(line);
    if (event === null || event.attemptId !== this.attemptId) {
      this.#feed.publish({
        type: 'parse_error',
        attemptId: this.attemptId,
        raw: line,
        error: 'invalid or unsupported fake CLI event',
      });
      return;
    }
    if (
      event.type === 'result'
      && this.#conversationId !== undefined
      && event.conversationId !== undefined
      && event.conversationId !== this.#conversationId
    ) {
      this.#feed.publish({
        type: 'parse_error',
        attemptId: this.attemptId,
        raw: line,
        error: 'resumed result conversationId did not match the requested conversation',
      });
      return;
    }
    if (event.type === 'result') this.#structuredResult = event;
    if (event.type === 'message_state') {
      const current = this.#messages[event.message.sequence - 1];
      if (
        current === undefined
        || current.content !== event.message.content
        || current.attemptId !== event.message.attemptId
      ) {
        this.#feed.publish({
          type: 'parse_error',
          attemptId: this.attemptId,
          raw: line,
          error: 'invalid or unsupported fake CLI event',
        });
        return;
      }
      try {
        this.#transitionMessage(
          current.sequence,
          event.message.state,
          event.message.error,
        );
      } catch (error) {
        this.#feed.publish({
          type: 'parse_error',
          attemptId: this.attemptId,
          raw: line,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    this.#feed.publish(event);
  }

  #transitionMessage(
    sequence: number,
    state: AgentMessageState,
    error?: string,
  ): AgentMessage {
    const index = sequence - 1;
    const current = this.#messages[index];
    if (current === undefined || !this.#canTransitionMessage(current.state, state)) {
      throw new Error(
        `invalid message state transition for sequence ${String(sequence)}: ${
          current?.state ?? 'missing'
        } -> ${state}`,
      );
    }
    const message = Object.freeze({
      attemptId: this.attemptId,
      sequence,
      content: current.content,
      state,
      ...(error === undefined ? {} : { error }),
    });
    this.#messages[index] = message;
    this.#feed.publish({
      type: 'message_state',
      attemptId: this.attemptId,
      message,
    });
    return message;
  }

  #canTransitionMessage(
    from: AgentMessageState,
    to: AgentMessageState,
  ): boolean {
    if (from === 'queued') return to === 'delivered' || to === 'failed';
    if (from === 'delivered') {
      return to === 'acknowledged' || to === 'applied' || to === 'failed';
    }
    if (from === 'acknowledged') return to === 'applied' || to === 'failed';
    return false;
  }
}
