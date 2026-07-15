import type { AgentCapabilities } from './agent-capabilities.js';
import type { ExecutionHandle } from './execution-handle.js';
import type {
  AttemptId,
  BaselineId,
  ConversationId,
} from '../domain/ids.js';
import type {
  AgentKind,
  AgentRole,
  RequirementVersion,
} from '../domain/task.js';
import type { ExecutionScope } from '../guard/adapter-permission-profile.js';
import type { JsonValue } from '../persistence/json-value.js';

export type AgentHealth =
  | {
      readonly status: 'available';
      readonly version?: string;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
    };

export interface AgentRequest {
  readonly attemptId: AttemptId;
  readonly baselineId: BaselineId;
  readonly requirementVersion: RequirementVersion;
  readonly role: AgentRole;
  /**
   * Canonical project root for live_project launches, or the guarded identity
   * root held by SafeAgentLaunchCoordinator. For isolated_implementation the
   * writable root is `executionRoot` / workspace authorization — never grant
   * live projectWrite from this field alone.
   */
  readonly projectRoot: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
  /** Defaults to live_project when omitted. */
  readonly executionScope?: ExecutionScope;
  /**
   * Opaque single-use workspace authorization id issued after materialization.
   * Required for isolated_implementation Grok implementer launches.
   */
  readonly workspaceAuthorizationId?: string;
  /** Expected source baseline manifest hash bound into workspace authorization. */
  readonly sourceManifestHash?: string;
  /**
   * Candidate workspace root for isolated_implementation. Must match the
   * persisted workspace record and live under app-owned implementation-workspaces.
   */
  readonly executionRoot?: string;
  /**
   * Optional read-only inspection root for reviewer/master when validating an
   * isolated candidate. Adapters should use this as cwd / tool scope instead of
   * the still-unchanged canonical projectRoot. Never grants write authority.
   */
  readonly inspectionRoot?: string;
}

export type AgentMessageState =
  | 'queued'
  | 'delivered'
  | 'acknowledged'
  | 'applied'
  | 'failed';

export interface AgentMessage {
  readonly attemptId: AttemptId;
  readonly sequence: number;
  readonly content: string;
  readonly state: AgentMessageState;
  readonly error?: string;
}

export type AgentEvent =
  | {
      readonly type: 'process_started';
      readonly attemptId: AttemptId;
      readonly pid: number;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'output';
      readonly attemptId: AttemptId;
      readonly text: string;
    }
  | {
      readonly type: 'result';
      readonly attemptId: AttemptId;
      readonly conversationId?: ConversationId;
      readonly output: JsonValue;
    }
  | {
      readonly type: 'parse_error';
      readonly attemptId: AttemptId;
      readonly raw: string;
      readonly error: string;
    }
  | {
      readonly type: 'stderr';
      readonly attemptId: AttemptId;
      readonly chunk: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'descendant_started';
      readonly attemptId: AttemptId;
      readonly pid: number;
      readonly parentPid: number;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'cleanup_succeeded';
      readonly attemptId: AttemptId;
      readonly operation: 'graceful_stop' | 'force_stop_tree';
      readonly occurredAt: string;
    }
  | {
      readonly type: 'cleanup_failed';
      readonly attemptId: AttemptId;
      readonly operation: 'graceful_stop' | 'force_stop_tree';
      readonly occurredAt: string;
      readonly error: string;
    }
  | {
      readonly type: 'process_exited';
      readonly attemptId: AttemptId;
      readonly pid: number;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly reason: 'exited' | 'timed_out' | 'graceful_stop' | 'force_stop';
      readonly occurredAt: string;
    }
  | {
      readonly type: 'message_state';
      readonly attemptId: AttemptId;
      readonly message: AgentMessage;
    };

export type AgentRunStatus =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'stopped';

export interface AgentRunResult {
  readonly attemptId: AttemptId;
  readonly conversationId?: ConversationId;
  readonly status: AgentRunStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly messages: readonly AgentMessage[];
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  checkAvailability(): Promise<AgentHealth>;
  discoverCapabilities(): Promise<AgentCapabilities>;
  start(request: AgentRequest): Promise<ExecutionHandle>;
  resume(
    conversationId: ConversationId,
    request: AgentRequest,
  ): Promise<ExecutionHandle>;
  parseEvent(line: string): AgentEvent | null;
}

export class UnsupportedResumeError extends Error {
  public override readonly name = 'UnsupportedResumeError';

  public constructor(kind: AgentKind) {
    super(`resume is unsupported for ${kind} because it was not verified`);
  }
}
