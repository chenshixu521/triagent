import type { AgentAdapter, AgentEvent, AgentRequest, AgentRunResult } from '../agents/agent-adapter.js';
import { settleSessionAfterRun } from '../agents/session-lifecycle.js';
import type { BudgetController } from '../budget/budget-controller.js';
import type { AttemptId, ConversationId, TaskId } from '../domain/ids.js';
import type { RunExitReason } from '../domain/attempt.js';
import type { AgentKind, AgentRole } from '../domain/task.js';
import { JsonlLog } from '../logging/jsonl-log.js';
import type { ReadWriteDatabase } from '../persistence/database.js';
import { ActionRepository, type PendingAction } from '../persistence/action-repository.js';
import { AttemptRepository } from '../persistence/attempt-repository.js';

export interface LogEvidenceReference {
  readonly attemptId: AttemptId;
  readonly filePath: string;
  readonly sequence: number;
  readonly offset: number;
  readonly checksum: string;
}

export interface CommandEvidenceRecord {
  readonly actionId: string;
  readonly attemptId: AttemptId;
  readonly adapter: AgentAdapter['kind'];
  readonly pid: number;
  readonly processStartedAt: string;
  readonly endedAt: string;
  readonly status: AgentRunResult['status'];
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface PersistedAgentRun {
  readonly actionId: string;
  readonly attemptId: AttemptId;
  readonly runResult: AgentRunResult;
  readonly commandRecord: CommandEvidenceRecord;
  readonly logReferences: readonly LogEvidenceReference[];
}

export interface CommandRunnerAgentEventContext {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly role: AgentRole;
  readonly adapterKind: AgentKind;
  readonly event: AgentEvent;
}

export interface CommandRunnerHooks {
  readonly afterIntentPersisted?: (
    action: PendingAction,
  ) => void | Promise<void>;
  readonly afterResultPersisted?: (
    result: PersistedAgentRun,
  ) => void | Promise<void>;
  /** Live UI / activity feed: one call per agent event (after durable log append). */
  readonly onAgentEvent?: (
    context: CommandRunnerAgentEventContext,
  ) => void | Promise<void>;
  /** Fired after launch chooses start vs resume (implementer session continue). */
  readonly onLaunchMode?: (info: {
    readonly taskId: TaskId;
    readonly role: AgentRole;
    readonly mode: 'start' | 'resume' | 'resume_fallback_start';
    readonly conversationId?: ConversationId;
    readonly detail?: string;
  }) => void | Promise<void>;
}

export interface RunPreparedAgentInput {
  readonly actionId: string;
  readonly taskId: TaskId;
  readonly adapter: AgentAdapter;
  readonly request: AgentRequest;
  /** Optional ProjectGuard decision attached to the reserved budget call. */
  readonly guardDecisionId?: string;
  /**
   * When set, launch via adapter.resume instead of start (implementer session
   * continue / rework). Authorization still runs before launch.
   */
  readonly resumeConversationId?: ConversationId;
}

export interface AgentLaunchPreparation {
  /** Persisted ProjectGuard decision that must be bound to the budget row. */
  readonly guardDecisionId: string;
}

export interface AgentLaunchPreparer {
  /**
   * Probe capabilities and persist the ProjectGuard decision before any budget
   * reservation exists.
   */
  prepareBeforeBudget(input: {
    readonly actionId: string;
    readonly taskId: TaskId;
    readonly adapter: AgentAdapter;
    readonly request: AgentRequest;
  }): Promise<AgentLaunchPreparation>;

  /**
   * Validate the exact guard-bound reservation and return the fully authorized
   * Adapter request. Implementations may consume the reservation while issuing
   * a one-time launch authorization; BudgetController.markLaunched is
   * intentionally idempotent for that case.
   */
  authorizeAfterBudget(input: {
    readonly actionId: string;
    readonly taskId: TaskId;
    readonly adapter: AgentAdapter;
    readonly request: AgentRequest;
    readonly preparation: AgentLaunchPreparation;
    readonly reservedBudgetId: string;
  }): Promise<AgentRequest>;
}

interface StartedEvidence {
  readonly pid: number;
  readonly occurredAt: string;
}

interface ExitedEvidence {
  readonly occurredAt: string;
}

function completionReason(status: AgentRunResult['status']): RunExitReason {
  switch (status) {
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed_out';
    case 'stopped':
      return 'interrupted';
  }
}

function streamFor(event: AgentEvent): 'stdout' | 'stderr' | 'system' {
  if (event.type === 'stderr') return 'stderr';
  if (event.type === 'output' || event.type === 'result' || event.type === 'parse_error') {
    return 'stdout';
  }
  return 'system';
}

export class CommandRunner {
  readonly #actions: ActionRepository;
  readonly #attempts: AttemptRepository;
  readonly #log: JsonlLog;
  readonly #hooks: CommandRunnerHooks;
  readonly #budget: BudgetController | undefined;
  readonly #launchPreparer: AgentLaunchPreparer | undefined;

  public constructor(options: {
    readonly database: ReadWriteDatabase;
    readonly log: JsonlLog;
    readonly hooks?: CommandRunnerHooks;
    /** Optional Task 10 budget gate. When set, reserve before launch. */
    readonly budget?: BudgetController;
    /** Optional two-phase Task 13 launch gate for real Adapters. */
    readonly launchPreparer?: AgentLaunchPreparer;
  }) {
    this.#actions = new ActionRepository(options.database.connection);
    this.#attempts = new AttemptRepository(options.database.connection);
    this.#log = options.log;
    this.#hooks = options.hooks ?? {};
    this.#budget = options.budget;
    this.#launchPreparer = options.launchPreparer;
  }

  public async runPreparedAgent(
    input: RunPreparedAgentInput,
  ): Promise<PersistedAgentRun> {
    const intent = this.#actions.get(input.actionId);
    if (intent === undefined || intent.status !== 'intent') {
      throw new Error(`agent action intent is not pending: ${input.actionId}`);
    }
    if (intent.taskId !== input.taskId) {
      throw new Error(`agent action intent belongs to another task: ${input.actionId}`);
    }

    await this.#hooks.afterIntentPersisted?.(intent);

    if (this.#launchPreparer !== undefined && this.#budget === undefined) {
      const reason = 'safe launch preparation requires a budget controller';
      this.#actions.markFailed(input.actionId, { error: reason });
      throw new Error(reason);
    }

    let launchPreparation: AgentLaunchPreparation | undefined;
    if (this.#launchPreparer !== undefined) {
      try {
        launchPreparation = await this.#launchPreparer.prepareBeforeBudget({
          actionId: input.actionId,
          taskId: input.taskId,
          adapter: input.adapter,
          request: input.request,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#actions.markFailed(input.actionId, { error: reason });
        throw error;
      }
    }

    let reservationId: string | undefined;
    if (this.#budget !== undefined) {
      if (!this.#budget.canLaunch()) {
        const reason = 'budget exhausted: refusing Adapter launch';
        this.#actions.markFailed(input.actionId, { error: reason });
        throw new Error(reason);
      }
      try {
        const reservation = this.#budget.reserveCall({
          attemptId: input.request.attemptId,
          idempotencyKey: `${input.taskId}:agent-run:${input.actionId}`,
          ...((launchPreparation?.guardDecisionId ?? input.guardDecisionId) === undefined
            ? {}
            : {
                guardDecisionId:
                  launchPreparation?.guardDecisionId ?? input.guardDecisionId,
              }),
        });
        reservationId = reservation.reservationId;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#actions.markFailed(input.actionId, { error: reason });
        throw error;
      }
    }

    let launchRequest = input.request;
    if (this.#launchPreparer !== undefined) {
      if (launchPreparation === undefined || reservationId === undefined) {
        const reason = 'safe launch preparation did not produce a reserved launch';
        this.#actions.markFailed(input.actionId, { error: reason });
        throw new Error(reason);
      }
      try {
        launchRequest = await this.#launchPreparer.authorizeAfterBudget({
          actionId: input.actionId,
          taskId: input.taskId,
          adapter: input.adapter,
          request: input.request,
          preparation: launchPreparation,
          reservedBudgetId: reservationId,
        });
        if (
          launchRequest.attemptId !== input.request.attemptId
          || launchRequest.baselineId !== input.request.baselineId
          || launchRequest.requirementVersion !== input.request.requirementVersion
          || launchRequest.role !== input.request.role
          || launchRequest.projectRoot !== input.request.projectRoot
        ) {
          throw new Error('authorized launch request changed immutable run identity');
        }
      } catch (error) {
        try {
          this.#budget?.releaseReservation(reservationId);
        } catch {
          // Authorization may have consumed the reservation before failing.
        }
        const reason = error instanceof Error ? error.message : String(error);
        this.#actions.markFailed(input.actionId, { error: reason });
        throw error;
      }
    }

    let handle;
    try {
      if (input.resumeConversationId !== undefined) {
        try {
          handle = await input.adapter.resume(
            input.resumeConversationId,
            launchRequest,
          );
          await this.#hooks.onLaunchMode?.({
            taskId: input.taskId,
            role: input.request.role,
            mode: 'resume',
            conversationId: input.resumeConversationId,
          });
        } catch (resumeError) {
          // Fail open to a fresh start when store evidence / CLI rejects resume.
          const message =
            resumeError instanceof Error
              ? resumeError.message
              : String(resumeError);
          await this.#log.append({
            taskId: input.taskId,
            attemptId: input.request.attemptId,
            stream: 'system',
            eventType: 'resume_fallback_start',
            payload: {
              resumeConversationId: String(input.resumeConversationId),
              reason: message,
            },
          });
          handle = await input.adapter.start(launchRequest);
          await this.#hooks.onLaunchMode?.({
            taskId: input.taskId,
            role: input.request.role,
            mode: 'resume_fallback_start',
            conversationId: input.resumeConversationId,
            detail: message,
          });
        }
      } else {
        handle = await input.adapter.start(launchRequest);
        await this.#hooks.onLaunchMode?.({
          taskId: input.taskId,
          role: input.request.role,
          mode: 'start',
        });
      }
    } catch (error) {
      if (reservationId !== undefined && this.#budget !== undefined) {
        try {
          this.#budget.releaseReservation(reservationId);
        } catch {
          // Launch never occurred; release is best-effort for bookkeeping.
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.#actions.markFailed(input.actionId, { error: reason });
      throw error;
    }

    // Launch occurred: consume the reservation even if the process later crashes.
    if (reservationId !== undefined && this.#budget !== undefined) {
      this.#budget.markLaunched(reservationId);
    }

    let started: StartedEvidence | undefined;
    let exited: ExitedEvidence | undefined;
    const logReferences: LogEvidenceReference[] = [];
    const collectEvents = (async () => {
      for await (const event of handle.events()) {
        if (event.attemptId !== input.request.attemptId) {
          throw new Error('adapter event attemptId did not match the prepared action');
        }
        if (event.type === 'process_started') {
          if (started !== undefined) {
            throw new Error('agent emitted duplicate process_started evidence');
          }
          started = { pid: event.pid, occurredAt: event.occurredAt };
          this.#attempts.markActive(input.request.attemptId, {
            role: input.request.role,
            pid: event.pid,
            processStartedAt: event.occurredAt,
          });
          if (this.#budget !== undefined) {
            this.#budget.beginActiveInterval(input.request.attemptId);
            this.#budget.armAttemptWatch(input.request.attemptId);
          }
        }
        if (event.type === 'process_exited') {
          exited = { occurredAt: event.occurredAt };
          if (this.#budget !== undefined) {
            this.#budget.endActiveInterval(input.request.attemptId);
          }
        }
        const appended = await this.#log.append({
          taskId: input.taskId,
          attemptId: input.request.attemptId,
          stream: streamFor(event),
          eventType: event.type,
          payload: event,
        });
        logReferences.push({
          attemptId: input.request.attemptId,
          filePath: this.#log.path,
          sequence: appended.sequence,
          offset: appended.offset,
          checksum: appended.checksum,
        });
        if (this.#hooks.onAgentEvent !== undefined) {
          await this.#hooks.onAgentEvent({
            taskId: input.taskId,
            attemptId: input.request.attemptId,
            role: input.request.role,
            adapterKind: input.adapter.kind,
            event,
          });
        }
      }
    })();

    let runResult: AgentRunResult;
    try {
      [runResult] = await Promise.all([handle.wait(), collectEvents]);
      if (runResult.attemptId !== input.request.attemptId) {
        throw new Error('adapter result attemptId did not match the prepared action');
      }
      if (started === undefined || exited === undefined) {
        throw new Error('agent run is missing process identity or exit evidence');
      }
      this.#attempts.markCompleted(input.request.attemptId, {
        endedAt: exited.occurredAt,
        exitReason: completionReason(runResult.status),
      });
      // Persist conversation id for session-id resume (implementer MVP).
      settleSessionAfterRun({
        adapter: input.adapter,
        attemptId: input.request.attemptId,
        status: runResult.status,
        ...(runResult.conversationId === undefined
          ? {}
          : { conversationId: runResult.conversationId }),
        endedAt: exited.occurredAt,
      });
      if (
        reservationId !== undefined
        && this.#budget !== undefined
        && (runResult.status === 'failed' || runResult.status === 'timed_out')
      ) {
        this.#budget.recordProcessCrash(reservationId, {
          exitCode: runResult.exitCode,
          reason: runResult.error ?? `agent run ${runResult.status}`,
        });
      }
    } catch (error) {
      if (reservationId !== undefined && this.#budget !== undefined) {
        try {
          this.#budget.recordProcessCrash(reservationId, {
            exitCode: null,
            reason: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Reservation may already be consumed; do not mask the original error.
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.#actions.markFailed(input.actionId, { error: reason });
      throw error;
    }

    const commandRecord: CommandEvidenceRecord = {
      actionId: input.actionId,
      attemptId: input.request.attemptId,
      adapter: input.adapter.kind,
      pid: started.pid,
      processStartedAt: started.occurredAt,
      endedAt: exited.occurredAt,
      status: runResult.status,
      exitCode: runResult.exitCode,
      signal: runResult.signal,
    };
    const persisted: PersistedAgentRun = {
      actionId: input.actionId,
      attemptId: input.request.attemptId,
      runResult,
      commandRecord,
      logReferences,
    };
    this.#actions.markCompleted(input.actionId, {
      result: persisted,
    });
    await this.#hooks.afterResultPersisted?.(persisted);
    return persisted;
  }
}
