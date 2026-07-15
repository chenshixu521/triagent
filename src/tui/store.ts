import type { AgentKind, AgentRole, RoleAssignment } from '../domain/task.js';
import type { WorkflowState } from '../workflow/states.js';
import type { ExitGate } from '../workflow/interruption-service.js';
import { uiText, type UiLanguage } from './i18n.js';

export type TuiScreen =
  | 'health'
  | 'project'
  | 'new_task'
  | 'plan_approval'
  | 'run'
  | 'diff'
  | 'review'
  | 'history'
  | 'recovery'
  | 'settings';

export type LogTab = AgentRole | 'system';

export type NarrowPanel = 'workflow' | 'log';

export type TuiRecoveryAction = 'inspect' | 'continue' | 'cancel';

export type TuiModal =
  | 'none'
  | 'help'
  | 'control_menu'
  | 'pause_menu'
  | 'message_entry'
  | 'cancel_confirm'
  | 'termination_confirm';

export type FocusOwner = 'app' | 'modal' | 'text_entry';

export type CtrlCStage = 'none' | 'control_menu' | 'termination_confirm';

export interface RoleLabels {
  readonly master: AgentKind;
  readonly implementer: AgentKind;
  readonly reviewer: AgentKind;
}

export interface LogBuckets {
  readonly master: readonly string[];
  readonly implementer: readonly string[];
  readonly reviewer: readonly string[];
  readonly system: readonly string[];
}

export interface TuiExitGate {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface TuiSnapshot {
  readonly screen: TuiScreen;
  readonly uiLanguage: UiLanguage;
  readonly workflowState: WorkflowState;
  readonly taskId?: string;
  readonly projectPath?: string;
  readonly roles?: RoleLabels;
  readonly processRunning: boolean;
  readonly pauseAfterAttempt: boolean;
  readonly reworkCount: number;
  readonly maxReworks: number;
  readonly activeLogTab: LogTab;
  readonly activeNarrowPanel: NarrowPanel;
  readonly logs: LogBuckets;
  /**
   * Chronological work-status feed lines (design: HH:MM:SS  [tag] text).
   * Preferred over role-bucket logs for ActivityFeed rendering.
   */
  readonly activityLines: readonly string[];
  /** Design left panel: current role while a stage is active. */
  readonly activeRole?: AgentRole;
  readonly activeAdapter?: string;
  /** Design left panel: 候选工作区 / 项目目录 */
  readonly executionScopeLabel?: string;
  readonly canApprove: boolean;
  readonly canRework: boolean;
  readonly elapsedLabel?: string;
  readonly columns: number;
  readonly rows: number;
  readonly modal: TuiModal;
  readonly focusOwner: FocusOwner;
  readonly ctrlCStage: CtrlCStage;
  readonly exitGate?: TuiExitGate;
  /** True only after a controller exit_gate.allowed result for a prior exit intent. */
  readonly exitAuthorized: boolean;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly error?: string;
  readonly statusMessage?: string;
  readonly recoveryAllowedActions: readonly TuiRecoveryAction[];
  readonly projectPathDraft: string;
  readonly requirementsDraft: string;
  readonly requiresPlanApprovalDraft: boolean;
  readonly messageDraft: string;
  readonly redactorSecrets: readonly string[];
  readonly narrowThreshold: number;
  readonly maxLogLineCharacters: number;
  readonly maxLogLines: number;
  readonly maxProjectPathLength: number;
  readonly maxRequirementsLength: number;
  readonly maxMessageLength: number;
}

export type TuiIntent =
  | { readonly type: 'SELECT_PROJECT'; readonly projectPath: string }
  | {
      readonly type: 'CREATE_TASK';
      readonly requirements: string;
      readonly roles: RoleAssignment;
      readonly requiresPlanApproval: boolean;
    }
  | { readonly type: 'PROJECT_PATH_INPUT'; readonly text: string }
  | { readonly type: 'PROJECT_PATH_BACKSPACE' }
  | { readonly type: 'TASK_REQUIREMENTS_INPUT'; readonly text: string }
  | { readonly type: 'TASK_REQUIREMENTS_BACKSPACE' }
  | { readonly type: 'CYCLE_ROLE_ASSIGNMENT' }
  | { readonly type: 'TOGGLE_PLAN_APPROVAL' }
  | { readonly type: 'OPEN_HELP' }
  | { readonly type: 'SET_UI_LANGUAGE'; readonly language: UiLanguage }
  | { readonly type: 'RECOVERY_INSPECT'; readonly taskId: string }
  | { readonly type: 'RECOVERY_CONTINUE'; readonly taskId: string }
  | { readonly type: 'RECOVERY_CANCEL'; readonly taskId: string }
  | { readonly type: 'OPEN_PAUSE_MENU' }
  | { readonly type: 'REQUEST_PAUSE_AFTER_RUN' }
  | { readonly type: 'OPEN_MESSAGE_ENTRY' }
  | { readonly type: 'MESSAGE_INPUT'; readonly character: string }
  | { readonly type: 'MESSAGE_BACKSPACE' }
  | { readonly type: 'QUEUE_MESSAGE'; readonly text: string }
  | { readonly type: 'OPEN_DIFF' }
  | { readonly type: 'CYCLE_LOG_TAB' }
  | { readonly type: 'CYCLE_NARROW_PANEL' }
  | { readonly type: 'REQUEST_REWORK' }
  | { readonly type: 'APPROVE' }
  | { readonly type: 'OPEN_CANCEL_CONFIRM' }
  | { readonly type: 'REQUEST_CANCEL_OR_INTERRUPT' }
  | { readonly type: 'OPEN_CONTROL_MENU' }
  | { readonly type: 'OPEN_TERMINATION_CONFIRM' }
  | { readonly type: 'CONFIRM_TERMINATION' }
  | { readonly type: 'REQUEST_EXIT' }
  | { readonly type: 'DISMISS_MODAL' }
  | { readonly type: 'NAVIGATE'; readonly screen: TuiScreen }
  | { readonly type: 'SET_STATUS'; readonly message: string }
  | { readonly type: 'ILLEGAL_INTENT'; readonly reason: string };

export type ControllerDispatchResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'exit_gate'; readonly gate: ExitGate | TuiExitGate }
  | {
      readonly kind: 'snapshot';
      readonly snapshot: Partial<TuiSnapshot>;
      readonly preserveUiState?: boolean;
    };

/**
 * Application controller port. UI layers only dispatch typed intents through
 * this port; they never spawn processes, touch SQL, or mutate repositories.
 */
export interface ApplicationControllerPort {
  dispatch(intent: TuiIntent): Promise<ControllerDispatchResult> | ControllerDispatchResult;
}

export interface CreateTuiStoreOptions {
  readonly initial?: Partial<TuiSnapshot>;
  readonly controller?: ApplicationControllerPort;
  readonly onIntent?: (intent: TuiIntent) => void;
}

export interface ReplaceSnapshotOptions {
  /** Keep modal/focus/draft/narrow panel/ctrlC/exitAuthorized UI state. */
  readonly preserveUiState?: boolean;
}

const LOG_TAB_ORDER: readonly LogTab[] = [
  'master',
  'implementer',
  'reviewer',
  'system',
] as const;

const ROLE_ASSIGNMENT_ORDER: readonly RoleAssignment[] = Object.freeze([
  Object.freeze({ master: 'claude', implementer: 'grok', reviewer: 'codex' }),
  Object.freeze({ master: 'codex', implementer: 'claude', reviewer: 'grok' }),
  Object.freeze({ master: 'codex', implementer: 'grok', reviewer: 'claude' }),
  Object.freeze({ master: 'claude', implementer: 'codex', reviewer: 'grok' }),
  Object.freeze({ master: 'grok', implementer: 'codex', reviewer: 'claude' }),
  Object.freeze({ master: 'grok', implementer: 'claude', reviewer: 'codex' }),
]);

export const DEFAULT_ROLE_ASSIGNMENT: RoleAssignment = ROLE_ASSIGNMENT_ORDER[0]!;

const EMPTY_LOGS: LogBuckets = Object.freeze({
  master: Object.freeze([] as string[]),
  implementer: Object.freeze([] as string[]),
  reviewer: Object.freeze([] as string[]),
  system: Object.freeze([] as string[]),
});

export function createInitialTuiSnapshot(
  overrides: Partial<TuiSnapshot> = {},
): TuiSnapshot {
  const {
    logs: overrideLogs,
    activityLines: overrideActivityLines,
    redactorSecrets: overrideSecrets,
    ...rest
  } = overrides;

  // Normalize illegal focus without a modal.
  const restModal = rest.modal;
  const restFocus = rest.focusOwner;
  let modal: TuiModal = restModal ?? 'none';
  let focusOwner: FocusOwner = restFocus ?? 'app';
  if (modal === 'none' && (focusOwner === 'modal' || focusOwner === 'text_entry')) {
    focusOwner = 'app';
  }
  if (modal !== 'none' && focusOwner === 'app') {
    focusOwner = modal === 'message_entry' ? 'text_entry' : 'modal';
  }

  const {
    modal: _dropModal,
    focusOwner: _dropFocus,
    ...restWithoutFocus
  } = rest;

  const base: TuiSnapshot = {
    screen: 'run',
    uiLanguage: 'en',
    workflowState: 'draft',
    roles: DEFAULT_ROLE_ASSIGNMENT,
    processRunning: false,
    pauseAfterAttempt: false,
    reworkCount: 0,
    maxReworks: 3,
    activeLogTab: 'system',
    activeNarrowPanel: 'log',
    canApprove: false,
    canRework: false,
    columns: 120,
    rows: 40,
    ctrlCStage: 'none',
    exitAuthorized: false,
    loading: false,
    empty: false,
    projectPathDraft: '',
    requirementsDraft: '',
    requiresPlanApprovalDraft: true,
    messageDraft: '',
    recoveryAllowedActions: Object.freeze([] as TuiRecoveryAction[]),
    narrowThreshold: 80,
    maxLogLineCharacters: 80,
    maxLogLines: 40,
    maxProjectPathLength: 4_096,
    maxRequirementsLength: 20_000,
    maxMessageLength: 500,
    ...restWithoutFocus,
    modal,
    focusOwner,
    logs: freezeLogs(overrideLogs ?? EMPTY_LOGS),
    activityLines: Object.freeze([...(overrideActivityLines ?? [])]),
    redactorSecrets: Object.freeze([...(overrideSecrets ?? [])]),
  };

  return deepFreezeSnapshot(base);
}

function freezeLogs(logs: LogBuckets): LogBuckets {
  return Object.freeze({
    master: Object.freeze([...logs.master]),
    implementer: Object.freeze([...logs.implementer]),
    reviewer: Object.freeze([...logs.reviewer]),
    system: Object.freeze([...logs.system]),
  });
}

function deepFreezeSnapshot(snapshot: TuiSnapshot): TuiSnapshot {
  const frozen: TuiSnapshot = {
    ...snapshot,
    logs: freezeLogs(snapshot.logs),
    activityLines: Object.freeze([...(snapshot.activityLines ?? [])]),
    redactorSecrets: Object.freeze([...snapshot.redactorSecrets]),
    recoveryAllowedActions: Object.freeze([...snapshot.recoveryAllowedActions]),
    roles: snapshot.roles === undefined
      ? undefined
      : Object.freeze({ ...snapshot.roles }),
    exitGate: snapshot.exitGate === undefined
      ? undefined
      : Object.freeze({ ...snapshot.exitGate }),
  };
  return Object.freeze(frozen);
}

export function nextLogTab(current: LogTab): LogTab {
  const index = LOG_TAB_ORDER.indexOf(current);
  if (index < 0) return LOG_TAB_ORDER[0]!;
  return LOG_TAB_ORDER[(index + 1) % LOG_TAB_ORDER.length]!;
}

export function nextRoleAssignment(
  current: RoleLabels | undefined,
): RoleAssignment {
  const normalized = current ?? DEFAULT_ROLE_ASSIGNMENT;
  const index = ROLE_ASSIGNMENT_ORDER.findIndex(
    (candidate) =>
      candidate.master === normalized.master &&
      candidate.implementer === normalized.implementer &&
      candidate.reviewer === normalized.reviewer,
  );
  const nextIndex = index < 0 ? 0 : (index + 1) % ROLE_ASSIGNMENT_ORDER.length;
  return ROLE_ASSIGNMENT_ORDER[nextIndex]!;
}

/**
 * Narrow Tab rule:
 * - On workflow panel → switch to log (keep current log tab).
 * - On log panel → advance log tab; after last tab wrap to workflow.
 */
export function advanceNarrowFocus(snapshot: TuiSnapshot): {
  readonly activeNarrowPanel: NarrowPanel;
  readonly activeLogTab: LogTab;
} {
  if (snapshot.activeNarrowPanel === 'workflow') {
    return {
      activeNarrowPanel: 'log',
      activeLogTab: snapshot.activeLogTab,
    };
  }
  const index = LOG_TAB_ORDER.indexOf(snapshot.activeLogTab);
  if (index < 0 || index >= LOG_TAB_ORDER.length - 1) {
    return {
      activeNarrowPanel: 'workflow',
      activeLogTab: snapshot.activeLogTab,
    };
  }
  return {
    activeNarrowPanel: 'log',
    activeLogTab: LOG_TAB_ORDER[index + 1]!,
  };
}

function isFocusOwnedByModalOrEntry(snapshot: TuiSnapshot): boolean {
  return snapshot.focusOwner === 'modal' || snapshot.focusOwner === 'text_entry';
}

function clearModal(current: TuiSnapshot): TuiSnapshot {
  return {
    ...current,
    modal: 'none',
    focusOwner: 'app',
    ctrlCStage: 'none',
    messageDraft: '',
    statusMessage: undefined,
  };
}

export interface TuiStore {
  getSnapshot(): TuiSnapshot;
  subscribe(listener: (snapshot: TuiSnapshot) => void): () => void;
  dispatch(intent: TuiIntent): Promise<TuiSnapshot>;
  setWindowSize(columns: number, rows: number): TuiSnapshot;
  /**
   * Replace authoritative snapshot. Optionally preserve UI-only fields so
   * domain updates from the controller/parent do not clobber modal/draft state.
   */
  replaceSnapshot(
    next: Partial<TuiSnapshot> | TuiSnapshot,
    options?: ReplaceSnapshotOptions,
  ): TuiSnapshot;
}

export function createTuiStore(options: CreateTuiStoreOptions = {}): TuiStore {
  let snapshot = createInitialTuiSnapshot(options.initial);
  const listeners = new Set<(snapshot: TuiSnapshot) => void>();
  const lastAcceptedAt = new Map<string, number>();
  const DEBOUNCE_MS = 120;

  const publish = (next: TuiSnapshot): TuiSnapshot => {
    snapshot = deepFreezeSnapshot(next);
    for (const listener of listeners) {
      listener(snapshot);
    }
    return snapshot;
  };

  const reduceLocal = (current: TuiSnapshot, intent: TuiIntent): TuiSnapshot => {
    switch (intent.type) {
      case 'SELECT_PROJECT':
        return {
          ...current,
          projectPathDraft: intent.projectPath,
          statusMessage: 'Selecting project',
        };
      case 'CREATE_TASK': {
        // Optimistic work-status screen: do not wait for AI stages to finish.
        const submitted = intent.requirements.trim().slice(0, 120);
        const stamp = new Date();
        const hh = String(stamp.getHours()).padStart(2, '0');
        const mm = String(stamp.getMinutes()).padStart(2, '0');
        const ss = String(stamp.getSeconds()).padStart(2, '0');
        const clock = `${hh}:${mm}:${ss}`;
        const lines = [
          `${clock}  [system] 任务已提交，进入工作状态…`,
          `${clock}  [system] 需求: ${submitted}`,
        ];
        return {
          ...current,
          screen: 'run',
          workflowState: 'checking_environment',
          processRunning: true,
          loading: true,
          empty: false,
          error: undefined,
          requirementsDraft: '',
          statusMessage: uiText(current.uiLanguage, 'activity.starting'),
          activityLines: Object.freeze([...lines]),
          logs: {
            ...current.logs,
            system: Object.freeze(
              [...current.logs.system, ...lines].slice(-current.maxLogLines),
            ),
          },
        };
      }
      case 'PROJECT_PATH_INPUT': {
        if (current.screen !== 'project') return current;
        return {
          ...current,
          projectPathDraft: (current.projectPathDraft + intent.text).slice(
            0,
            current.maxProjectPathLength,
          ),
        };
      }
      case 'PROJECT_PATH_BACKSPACE':
        if (current.screen !== 'project') return current;
        return {
          ...current,
          projectPathDraft: current.projectPathDraft.slice(0, -1),
        };
      case 'TASK_REQUIREMENTS_INPUT': {
        if (current.screen !== 'new_task') return current;
        return {
          ...current,
          requirementsDraft: (current.requirementsDraft + intent.text).slice(
            0,
            current.maxRequirementsLength,
          ),
        };
      }
      case 'TASK_REQUIREMENTS_BACKSPACE':
        if (current.screen !== 'new_task') return current;
        return {
          ...current,
          requirementsDraft: current.requirementsDraft.slice(0, -1),
        };
      case 'CYCLE_ROLE_ASSIGNMENT':
        if (current.screen !== 'new_task') return current;
        return {
          ...current,
          roles: nextRoleAssignment(current.roles),
        };
      case 'TOGGLE_PLAN_APPROVAL':
        if (current.screen !== 'new_task') return current;
        return {
          ...current,
          requiresPlanApprovalDraft: !current.requiresPlanApprovalDraft,
        };
      case 'OPEN_HELP':
        return {
          ...current,
          modal: 'help',
          focusOwner: 'modal',
          requirementsDraft: '',
          statusMessage: uiText(current.uiLanguage, 'help.summary'),
        };
      case 'SET_UI_LANGUAGE':
        return {
          ...current,
          requirementsDraft: '',
          statusMessage: uiText(current.uiLanguage, 'commands.savingLanguage'),
        };
      case 'RECOVERY_INSPECT':
        return {
          ...current,
          statusMessage: 'Inspecting recovery evidence',
        };
      case 'RECOVERY_CONTINUE':
        return {
          ...current,
          statusMessage: 'Continuing recovered task',
        };
      case 'RECOVERY_CANCEL':
        return {
          ...current,
          statusMessage: 'Cancelling recovered task',
        };
      case 'OPEN_PAUSE_MENU':
        return {
          ...current,
          modal: 'pause_menu',
          focusOwner: 'modal',
          statusMessage: 'Pause menu open',
        };
      case 'REQUEST_PAUSE_AFTER_RUN':
        return {
          ...clearModal(current),
          pauseAfterAttempt: true,
          statusMessage: 'Pause after current run requested',
        };
      case 'OPEN_MESSAGE_ENTRY':
        return {
          ...current,
          modal: 'message_entry',
          focusOwner: 'text_entry',
          messageDraft: '',
          statusMessage: 'Message entry',
        };
      case 'MESSAGE_INPUT': {
        if (current.modal !== 'message_entry') return current;
        if (current.messageDraft.length >= current.maxMessageLength) {
          return current;
        }
        const nextDraft = (current.messageDraft + intent.character).slice(
          0,
          current.maxMessageLength,
        );
        return {
          ...current,
          messageDraft: nextDraft,
        };
      }
      case 'MESSAGE_BACKSPACE': {
        if (current.modal !== 'message_entry') return current;
        return {
          ...current,
          messageDraft: current.messageDraft.slice(0, -1),
        };
      }
      case 'QUEUE_MESSAGE':
        return {
          ...clearModal(current),
          statusMessage: 'Message queued',
        };
      case 'OPEN_DIFF':
        return {
          ...current,
          screen: 'diff',
          statusMessage: 'Diff screen',
        };
      case 'CYCLE_LOG_TAB':
        return {
          ...current,
          activeLogTab: nextLogTab(current.activeLogTab),
        };
      case 'CYCLE_NARROW_PANEL': {
        const advanced = advanceNarrowFocus(current);
        return {
          ...current,
          activeNarrowPanel: advanced.activeNarrowPanel,
          activeLogTab: advanced.activeLogTab,
        };
      }
      case 'REQUEST_REWORK':
        return {
          ...current,
          statusMessage: 'Rework requested',
        };
      case 'APPROVE':
        return {
          ...current,
          statusMessage: 'Approved',
        };
      case 'OPEN_CANCEL_CONFIRM':
        return {
          ...current,
          modal: 'cancel_confirm',
          focusOwner: 'modal',
          statusMessage: 'Cancel confirmation',
        };
      case 'REQUEST_CANCEL_OR_INTERRUPT':
        return {
          ...clearModal(current),
          statusMessage: 'Cancel/interrupt requested',
        };
      case 'OPEN_CONTROL_MENU':
        return {
          ...current,
          modal: 'control_menu',
          focusOwner: 'modal',
          ctrlCStage: 'control_menu',
          statusMessage: 'Control menu open',
        };
      case 'OPEN_TERMINATION_CONFIRM':
        return {
          ...current,
          modal: 'termination_confirm',
          focusOwner: 'modal',
          ctrlCStage: 'termination_confirm',
          statusMessage: 'Termination confirmation',
        };
      case 'CONFIRM_TERMINATION':
        return {
          ...clearModal(current),
          statusMessage: 'Termination confirmed',
        };
      case 'REQUEST_EXIT':
        // Safe app exit only — does not perform cancel/interrupt cleanup.
        return {
          ...clearModal(current),
          statusMessage: 'Exit requested',
        };
      case 'DISMISS_MODAL':
        return clearModal(current);
      case 'NAVIGATE':
        return {
          ...current,
          screen: intent.screen,
          statusMessage: `Screen: ${intent.screen}`,
        };
      case 'SET_STATUS':
        return {
          ...current,
          statusMessage: intent.message,
        };
      case 'ILLEGAL_INTENT':
        return {
          ...current,
          statusMessage: intent.reason,
        };
      default: {
        const _exhaustive: never = intent;
        return _exhaustive;
      }
    }
  };

  const isLegal = (
    current: TuiSnapshot,
    intent: TuiIntent,
  ): { ok: true } | { ok: false; reason: string } => {
    if (isFocusOwnedByModalOrEntry(current)) {
      const allowedWhileFocused: ReadonlySet<TuiIntent['type']> = new Set([
        'DISMISS_MODAL',
        'CONFIRM_TERMINATION',
        'REQUEST_CANCEL_OR_INTERRUPT',
        'REQUEST_PAUSE_AFTER_RUN',
        'QUEUE_MESSAGE',
        'MESSAGE_INPUT',
        'MESSAGE_BACKSPACE',
        'REQUEST_EXIT',
        'OPEN_TERMINATION_CONFIRM',
        'SET_STATUS',
        'ILLEGAL_INTENT',
      ]);
      if (
        intent.type === 'OPEN_TERMINATION_CONFIRM' &&
        current.ctrlCStage === 'control_menu'
      ) {
        return { ok: true };
      }
      if (
        intent.type === 'REQUEST_PAUSE_AFTER_RUN' &&
        current.modal !== 'pause_menu'
      ) {
        return { ok: false, reason: 'pause confirm requires pause menu' };
      }
      if (
        intent.type === 'REQUEST_CANCEL_OR_INTERRUPT' &&
        current.modal !== 'cancel_confirm'
      ) {
        return { ok: false, reason: 'cancel confirm required' };
      }
      if (
        intent.type === 'CONFIRM_TERMINATION' &&
        current.modal !== 'termination_confirm'
      ) {
        return { ok: false, reason: 'termination confirm required' };
      }
      if (
        (intent.type === 'QUEUE_MESSAGE' ||
          intent.type === 'MESSAGE_INPUT' ||
          intent.type === 'MESSAGE_BACKSPACE') &&
        current.modal !== 'message_entry'
      ) {
        return { ok: false, reason: 'message entry not active' };
      }
      if (intent.type === 'QUEUE_MESSAGE' && intent.text.trim().length === 0) {
        return { ok: false, reason: 'message text must be nonempty' };
      }
      if (!allowedWhileFocused.has(intent.type)) {
        return { ok: false, reason: 'input ignored: modal or text entry owns focus' };
      }
      return { ok: true };
    }

    if (
      (intent.type === 'PROJECT_PATH_INPUT' ||
        intent.type === 'PROJECT_PATH_BACKSPACE') &&
      current.screen !== 'project'
    ) {
      return { ok: false, reason: 'project path entry requires project screen' };
    }
    if (
      (intent.type === 'TASK_REQUIREMENTS_INPUT' ||
        intent.type === 'TASK_REQUIREMENTS_BACKSPACE' ||
        intent.type === 'CYCLE_ROLE_ASSIGNMENT' ||
        intent.type === 'TOGGLE_PLAN_APPROVAL' ||
        intent.type === 'OPEN_HELP' ||
        intent.type === 'SET_UI_LANGUAGE') &&
      current.screen !== 'new_task'
    ) {
      return { ok: false, reason: 'task entry requires new task screen' };
    }

    if (intent.type === 'REQUEST_REWORK' && !current.canRework) {
      return { ok: false, reason: 'rework not legal in current state' };
    }
    if (intent.type === 'APPROVE' && !current.canApprove) {
      return { ok: false, reason: 'approve not legal in current state' };
    }
    if (
      intent.type === 'REQUEST_PAUSE_AFTER_RUN' ||
      intent.type === 'QUEUE_MESSAGE' ||
      intent.type === 'MESSAGE_INPUT' ||
      intent.type === 'MESSAGE_BACKSPACE' ||
      intent.type === 'REQUEST_CANCEL_OR_INTERRUPT' ||
      intent.type === 'CONFIRM_TERMINATION'
    ) {
      return { ok: false, reason: 'requires open modal confirmation' };
    }
    if (
      intent.type === 'OPEN_CONTROL_MENU' &&
      current.ctrlCStage !== 'none' &&
      current.ctrlCStage !== 'control_menu'
    ) {
      return { ok: false, reason: 'control menu already advanced' };
    }
    if (
      intent.type === 'OPEN_TERMINATION_CONFIRM' &&
      current.ctrlCStage !== 'control_menu' &&
      current.ctrlCStage !== 'termination_confirm'
    ) {
      return { ok: false, reason: 'termination confirm requires prior control menu' };
    }
    return { ok: true };
  };

  const shouldDebounce = (intent: TuiIntent): boolean => {
    const debounced: ReadonlySet<TuiIntent['type']> = new Set([
      'OPEN_PAUSE_MENU',
      'OPEN_HELP',
      'OPEN_MESSAGE_ENTRY',
      'OPEN_DIFF',
      'REQUEST_REWORK',
      'APPROVE',
      'OPEN_CANCEL_CONFIRM',
      'OPEN_CONTROL_MENU',
      'OPEN_TERMINATION_CONFIRM',
      'CONFIRM_TERMINATION',
      'REQUEST_CANCEL_OR_INTERRUPT',
      'REQUEST_PAUSE_AFTER_RUN',
      'REQUEST_EXIT',
      'QUEUE_MESSAGE',
      'SELECT_PROJECT',
      'CREATE_TASK',
      'SET_UI_LANGUAGE',
      'RECOVERY_INSPECT',
      'RECOVERY_CONTINUE',
      'RECOVERY_CANCEL',
    ]);
    if (!debounced.has(intent.type)) return false;
    const now = Date.now();
    const previous = lastAcceptedAt.get(intent.type) ?? 0;
    if (now - previous < DEBOUNCE_MS) return true;
    lastAcceptedAt.set(intent.type, now);
    return false;
  };

  const mergeReplace = (
    current: TuiSnapshot,
    partial: Partial<TuiSnapshot>,
    preserveUiState: boolean,
  ): TuiSnapshot => {
    const preserved: Partial<TuiSnapshot> = preserveUiState
      ? {
          modal: current.modal,
          focusOwner: current.focusOwner,
          ctrlCStage: current.ctrlCStage,
          messageDraft: current.messageDraft,
          projectPathDraft: current.projectPathDraft,
          requirementsDraft: current.requirementsDraft,
          requiresPlanApprovalDraft: current.requiresPlanApprovalDraft,
          ...(current.screen === 'new_task' ? { roles: current.roles } : {}),
          activeNarrowPanel: current.activeNarrowPanel,
          activeLogTab: current.activeLogTab,
          exitAuthorized: current.exitAuthorized,
          statusMessage: current.statusMessage,
        }
      : {};
    return createInitialTuiSnapshot({
      ...current,
      ...partial,
      ...preserved,
      logs: partial.logs ?? current.logs,
      activityLines: partial.activityLines ?? current.activityLines,
      redactorSecrets: partial.redactorSecrets ?? current.redactorSecrets,
    });
  };

  return {
    getSnapshot(): TuiSnapshot {
      return snapshot;
    },

    subscribe(listener: (snapshot: TuiSnapshot) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setWindowSize(columns: number, rows: number): TuiSnapshot {
      return publish({ ...snapshot, columns, rows });
    },

    replaceSnapshot(
      next: Partial<TuiSnapshot> | TuiSnapshot,
      replaceOptions: ReplaceSnapshotOptions = {},
    ): TuiSnapshot {
      const preserveUiState = replaceOptions.preserveUiState === true;
      return publish(mergeReplace(snapshot, next, preserveUiState));
    },

    async dispatch(intent: TuiIntent): Promise<TuiSnapshot> {
      // Always read authoritative store state — never a stale React prop.
      const current = snapshot;

      if (shouldDebounce(intent)) {
        return current;
      }

      const legality = isLegal(current, intent);
      if (!legality.ok) {
        if (
          intent.type === 'REQUEST_REWORK' ||
          intent.type === 'APPROVE' ||
          intent.type === 'OPEN_PAUSE_MENU' ||
          intent.type === 'OPEN_DIFF' ||
          intent.type === 'OPEN_CANCEL_CONFIRM' ||
          intent.type === 'OPEN_MESSAGE_ENTRY' ||
          intent.type === 'CYCLE_LOG_TAB' ||
          intent.type === 'CYCLE_NARROW_PANEL' ||
          intent.type === 'QUEUE_MESSAGE' ||
          intent.type === 'REQUEST_PAUSE_AFTER_RUN' ||
          intent.type === 'REQUEST_CANCEL_OR_INTERRUPT' ||
          intent.type === 'PROJECT_PATH_INPUT' ||
          intent.type === 'PROJECT_PATH_BACKSPACE' ||
          intent.type === 'TASK_REQUIREMENTS_INPUT' ||
          intent.type === 'TASK_REQUIREMENTS_BACKSPACE' ||
          intent.type === 'CYCLE_ROLE_ASSIGNMENT' ||
          intent.type === 'TOGGLE_PLAN_APPROVAL' ||
          intent.type === 'OPEN_HELP' ||
          intent.type === 'SET_UI_LANGUAGE' ||
          intent.type === 'SELECT_PROJECT' ||
          intent.type === 'CREATE_TASK' ||
          intent.type === 'RECOVERY_INSPECT' ||
          intent.type === 'RECOVERY_CONTINUE' ||
          intent.type === 'RECOVERY_CANCEL'
        ) {
          return publish(
            reduceLocal(current, {
              type: 'ILLEGAL_INTENT',
              reason: `not legal: ${legality.reason}`,
            }),
          );
        }
        return current;
      }

      options.onIntent?.(intent);

      let next = reduceLocal(current, intent);

      if (options.controller !== undefined) {
        // Only forward application-facing intents to the controller.
        const forwardToController: ReadonlySet<TuiIntent['type']> = new Set([
          'REQUEST_PAUSE_AFTER_RUN',
          'QUEUE_MESSAGE',
          'REQUEST_REWORK',
          'APPROVE',
          'REQUEST_CANCEL_OR_INTERRUPT',
          'CONFIRM_TERMINATION',
          'REQUEST_EXIT',
          'OPEN_DIFF',
          'NAVIGATE',
          'SELECT_PROJECT',
          'CREATE_TASK',
          'SET_UI_LANGUAGE',
          'RECOVERY_INSPECT',
          'RECOVERY_CONTINUE',
          'RECOVERY_CANCEL',
        ]);
        if (forwardToController.has(intent.type)) {
          const result = await options.controller.dispatch(intent);
          if (result.kind === 'rejected') {
            next = {
              ...next,
              statusMessage: result.reason,
              ...(intent.type === 'CREATE_TASK' || intent.type === 'APPROVE'
                ? {
                    loading: false,
                    processRunning: false,
                    error: result.reason,
                  }
                : {}),
            };
          } else if (result.kind === 'exit_gate') {
            next = {
              ...next,
              exitGate: {
                allowed: result.gate.allowed,
                reason: result.gate.reason,
              },
              exitAuthorized: result.gate.allowed === true,
              statusMessage: result.gate.allowed
                ? 'exit allowed'
                : (result.gate.reason ?? 'exit blocked'),
            };
          } else if (result.kind === 'snapshot') {
            next = mergeReplace(
              next,
              result.snapshot,
              result.preserveUiState === true,
            );
          }
        }
      }

      return publish(next);
    },
  };
}

export function isNarrowLayout(snapshot: TuiSnapshot): boolean {
  return snapshot.columns < snapshot.narrowThreshold;
}

export function formatAgentKind(kind: AgentKind): string {
  switch (kind) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'grok':
      return 'Grok';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function formatRoleLabel(role: AgentRole): string {
  switch (role) {
    case 'master':
      return 'Master';
    case 'implementer':
      return 'Implementer';
    case 'reviewer':
      return 'Reviewer';
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}
