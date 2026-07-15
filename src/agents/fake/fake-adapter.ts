import {
  unknownAgentCapabilities,
  type AgentCapabilities,
} from '../agent-capabilities.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentHealth,
  AgentRequest,
} from '../agent-adapter.js';
import { UnsupportedResumeError } from '../agent-adapter.js';
import {
  SupervisedExecutionHandle,
  type ExecutionHandle,
} from '../execution-handle.js';
import {
  asAttemptId,
  asConversationId,
  type ConversationId,
} from '../../domain/ids.js';
import type { AgentKind } from '../../domain/task.js';
import { assertJsonValue } from '../../persistence/json-value.js';
import type { ProcessSupervisorPort } from '../../process/process-supervisor-port.js';

export interface FakeAdapterOptions {
  readonly kind: AgentKind;
  readonly supervisor: ProcessSupervisorPort;
  readonly cliPath: string;
  readonly scenarioPath: string;
  readonly tempBasePath: string;
  readonly capabilities?: AgentCapabilities;
  readonly health?: AgentHealth;
  readonly messageDelivery?: {
    readonly outcome: 'delivered' | 'failed';
    readonly error?: string;
  };
}

export class FakeAdapter implements AgentAdapter {
  readonly #supervisor: ProcessSupervisorPort;
  readonly #cliPath: string;
  readonly #scenarioPath: string;
  readonly #tempBasePath: string;
  readonly #capabilities: AgentCapabilities;
  readonly #health: AgentHealth;
  readonly #messageDelivery: NonNullable<FakeAdapterOptions['messageDelivery']>;
  readonly #usedAttemptIds = new Set<string>();

  public readonly kind: AgentKind;

  public constructor(options: FakeAdapterOptions) {
    this.kind = options.kind;
    this.#supervisor = options.supervisor;
    this.#cliPath = options.cliPath;
    this.#scenarioPath = options.scenarioPath;
    this.#tempBasePath = options.tempBasePath;
    const capabilities = options.capabilities ?? unknownAgentCapabilities();
    this.#capabilities = Object.freeze({
      ...capabilities,
      writeModes: Object.freeze([...capabilities.writeModes]),
    });
    this.#health = Object.freeze({
      ...(options.health ?? {
        status: 'available' as const,
        version: 'fake-cli',
      }),
    });
    this.#messageDelivery = options.messageDelivery ?? { outcome: 'delivered' };
  }

  public async checkAvailability(): Promise<AgentHealth> {
    return this.#health;
  }

  public async discoverCapabilities(): Promise<AgentCapabilities> {
    return this.#capabilities;
  }

  public async start(request: AgentRequest): Promise<ExecutionHandle> {
    return this.#start(request);
  }

  public async resume(
    conversationId: ConversationId,
    request: AgentRequest,
  ): Promise<ExecutionHandle> {
    if (!this.#capabilities.resume) {
      throw new UnsupportedResumeError(this.kind);
    }
    return this.#start(request, conversationId);
  }

  public parseEvent(line: string): AgentEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const value = parsed as Record<string, unknown>;
    if (typeof value.attemptId !== 'string') return null;

    let attemptId;
    try {
      attemptId = asAttemptId(value.attemptId);
    } catch {
      return null;
    }
    if (value.type === 'output' && typeof value.text === 'string') {
      return { type: 'output', attemptId, text: value.text };
    }
    if (value.type === 'message_state') {
      const message = value.message;
      if (
        message === null
        || typeof message !== 'object'
        || Array.isArray(message)
      ) {
        return null;
      }
      const fields = message as Record<string, unknown>;
      if (
        typeof fields.attemptId !== 'string'
        || fields.attemptId !== attemptId
        || !Number.isSafeInteger(fields.sequence)
        || (fields.sequence as number) <= 0
        || typeof fields.content !== 'string'
        || ![
          'queued',
          'delivered',
          'acknowledged',
          'applied',
          'failed',
        ].includes(fields.state as string)
        || (fields.error !== undefined && typeof fields.error !== 'string')
      ) {
        return null;
      }
      return {
        type: 'message_state',
        attemptId,
        message: {
          attemptId,
          sequence: fields.sequence as number,
          content: fields.content,
          state: fields.state as
            | 'queued'
            | 'delivered'
            | 'acknowledged'
            | 'applied'
            | 'failed',
          ...(fields.error === undefined ? {} : { error: fields.error }),
        },
      };
    }
    if (value.type !== 'result') return null;

    try {
      assertJsonValue(value.output);
      const conversationId = value.conversationId === undefined
        ? undefined
        : typeof value.conversationId === 'string'
          ? asConversationId(value.conversationId)
          : null;
      if (conversationId === null) return null;
      return {
        type: 'result',
        attemptId,
        ...(conversationId === undefined ? {} : { conversationId }),
        output: value.output,
      };
    } catch {
      return null;
    }
  }

  async #start(
    request: AgentRequest,
    conversationId?: ConversationId,
  ): Promise<ExecutionHandle> {
    if (this.#usedAttemptIds.has(request.attemptId)) {
      throw new Error(
        `attempt already used; resume requires a distinct attempt: ${request.attemptId}`,
      );
    }
    this.#usedAttemptIds.add(request.attemptId);
    const handle = new SupervisedExecutionHandle({
      attemptId: request.attemptId,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
      capabilities: this.#capabilities,
      supervisor: this.#supervisor,
      parseEvent: (line) => this.parseEvent(line),
      ...(this.#capabilities.realTimeInput
        ? {
            deliverMessage: async () => {
              if (this.#messageDelivery.outcome === 'failed') {
                throw new Error(
                  this.#messageDelivery.error ?? 'fake input delivery failed',
                );
              }
            },
          }
        : {}),
    });
    try {
      await this.#supervisor.start({
        attemptId: request.attemptId,
        executable: process.execPath,
        args: [
          this.#cliPath,
          this.#scenarioPath,
          '--attempt-id',
          request.attemptId,
          '--project-root',
          request.projectRoot,
          '--temp-base',
          this.#tempBasePath,
          ...(conversationId === undefined
            ? []
            : ['--conversation-id', conversationId]),
        ],
        cwd: request.projectRoot,
        ...(request.timeoutMs === undefined
          ? {}
          : { timeoutMs: request.timeoutMs }),
      });
    } catch (error) {
      this.#usedAttemptIds.delete(request.attemptId);
      throw error;
    }
    return handle;
  }
}
