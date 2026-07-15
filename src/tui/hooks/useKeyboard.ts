import { useCallback, useRef } from 'react';
import { useApp, useInput, type Key } from 'ink';

import {
  DEFAULT_ROLE_ASSIGNMENT,
  isNarrowLayout,
  type TuiIntent,
  type TuiStore,
} from '../store.js';
import { uiText } from '../i18n.js';
import { parseTaskEntry } from '../slash-commands.js';

/** Held/repeated Ctrl+C within this window cannot advance stages. */
export const CTRL_C_COOLDOWN_MS = 500;

export interface UseKeyboardOptions {
  readonly store: TuiStore;
  readonly onSnapshotChange?: (snapshot: ReturnType<TuiStore['getSnapshot']>) => void;
  readonly isActive?: boolean;
}

/**
 * Keyboard semantics for Task 19.
 * Never calls process.exit; exit flows go through typed intents + controller gate.
 * Always reads store.getSnapshot() — never a stale React prop closure.
 */
export function useKeyboard(options: UseKeyboardOptions): void {
  const { store, onSnapshotChange, isActive = true } = options;
  const { exit: _inkExit } = useApp();
  void _inkExit;

  const lastKeyRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  /** Serialize dispatches without dropping keys (e.g. Esc right after P). */
  const queueRef = useRef(Promise.resolve());
  /**
   * Timestamp of the most recent Ctrl+C *event* (including ignored repeats).
   * Stage advancement requires a quiet gap since this previous event — not since
   * the last accepted stage change. Held keys keep refreshing this timestamp.
   */
  const lastCtrlCEventAtRef = useRef(0);

  const publish = useCallback(
    (intent: TuiIntent): void => {
      queueRef.current = queueRef.current
        .then(async () => {
          const next = await store.dispatch(intent);
          onSnapshotChange?.(next);
        })
        .catch(() => {
          // Intent dispatch errors must not break the keyboard queue.
        });
    },
    [store, onSnapshotChange],
  );

  useInput(
    (input, key) => {
      const now = Date.now();
      const snapshot = store.getSnapshot();
      const isCtrlC = key.ctrl && (input === 'c' || input === 'C');
      const isEscape = key.escape || input === '\x1b' || input === '\u001b';
      const printableText = printableInputText(input, key);

      if (isCtrlC) {
        const previousEventAt = lastCtrlCEventAtRef.current;
        // EVERY Ctrl+C event updates the most-recent-event timestamp, including
        // ignored holds/repeats, so a continuous hold never looks like a gap.
        lastCtrlCEventAtRef.current = now;

        const isExplicitRepeat = key.eventType === 'repeat';
        const gapSincePrevious =
          previousEventAt === 0 ? Number.POSITIVE_INFINITY : now - previousEventAt;
        // Advance only after a quiet gap since the immediately previous Ctrl+C
        // event. Explicit kitty "repeat" events never advance stages.
        const mayAdvanceStage =
          !isExplicitRepeat && gapSincePrevious >= CTRL_C_COOLDOWN_MS;

        if (!mayAdvanceStage) {
          return;
        }

        if (snapshot.ctrlCStage === 'none') {
          void publish({ type: 'OPEN_CONTROL_MENU' });
          return;
        }
        if (snapshot.ctrlCStage === 'control_menu') {
          void publish({ type: 'OPEN_TERMINATION_CONFIRM' });
          return;
        }
        // Already on termination confirm: ignore further Ctrl+C spam.
        return;
      }

      // Non-Ctrl key is a key-release equivalent: clear the Ctrl+C event stream
      // so the next Ctrl+C is treated as a deliberate press (quiet gap satisfied).
      lastCtrlCEventAtRef.current = 0;

      const fingerprint = keyFingerprint(input, key, isEscape);
      if (
        !key.tab &&
        fingerprint !== 'raw:printable' &&
        lastKeyRef.current.key === fingerprint &&
        now - lastKeyRef.current.at < 120
      ) {
        return;
      }
      lastKeyRef.current = { key: fingerprint, at: now };

      // Message entry: capture printable characters, backspace, enter, esc.
      if (snapshot.focusOwner === 'text_entry' && snapshot.modal === 'message_entry') {
        if (isEscape) {
          void publish({ type: 'DISMISS_MODAL' });
          return;
        }
        if (key.return) {
          const text = snapshot.messageDraft.trim();
          if (text.length === 0) {
            void publish({
              type: 'ILLEGAL_INTENT',
              reason: 'not legal: message text must be nonempty',
            });
            return;
          }
          void publish({ type: 'QUEUE_MESSAGE', text });
          return;
        }
        if (key.backspace || key.delete) {
          void publish({ type: 'MESSAGE_BACKSPACE' });
          return;
        }
        if (printableText.length > 0) {
          void publish({ type: 'MESSAGE_INPUT', character: printableText });
        }
        return;
      }

      if (snapshot.focusOwner === 'modal') {
        if (isEscape) {
          void publish({ type: 'DISMISS_MODAL' });
          return;
        }
        if (
          snapshot.modal === 'termination_confirm' &&
          (key.return || input.toLowerCase() === 'y')
        ) {
          void publish({ type: 'CONFIRM_TERMINATION' });
          return;
        }
        if (
          snapshot.modal === 'cancel_confirm' &&
          (key.return || input.toLowerCase() === 'y')
        ) {
          void publish({ type: 'REQUEST_CANCEL_OR_INTERRUPT' });
          return;
        }
        if (
          snapshot.modal === 'pause_menu' &&
          (key.return || input.toLowerCase() === 'y')
        ) {
          void publish({ type: 'REQUEST_PAUSE_AFTER_RUN' });
          return;
        }
        return;
      }

      // Form screens own ordinary text before global single-letter shortcuts.
      if (snapshot.screen === 'project') {
        if (key.return) {
          const projectPath = snapshot.projectPathDraft.trim();
          if (projectPath.length === 0) {
            void publish({
              type: 'ILLEGAL_INTENT',
              reason: 'not legal: project path must be nonempty',
            });
            return;
          }
          void publish({ type: 'SELECT_PROJECT', projectPath });
          return;
        }
        if (key.backspace || key.delete) {
          void publish({ type: 'PROJECT_PATH_BACKSPACE' });
          return;
        }
        if (printableText.length > 0) {
          void publish({ type: 'PROJECT_PATH_INPUT', text: printableText });
        }
        return;
      }

      if (snapshot.screen === 'new_task') {
        if (isEscape) {
          void publish({ type: 'REQUEST_EXIT' });
          return;
        }
        if (key.ctrl && input.toLowerCase() === 'p') {
          void publish({ type: 'TOGGLE_PLAN_APPROVAL' });
          return;
        }
        if (key.tab) {
          void publish({ type: 'CYCLE_ROLE_ASSIGNMENT' });
          return;
        }
        if (key.return) {
          const requirements = snapshot.requirementsDraft.trim();
          if (requirements.length === 0) {
            void publish({
              type: 'ILLEGAL_INTENT',
              reason: 'not legal: task requirements must be nonempty',
            });
            return;
          }
          const parsed = parseTaskEntry(requirements, snapshot.uiLanguage);
          if (parsed.kind === 'error') {
            void publish({
              type: 'ILLEGAL_INTENT',
              reason: uiText(snapshot.uiLanguage, 'commands.unknown'),
            });
            return;
          }
          if (parsed.kind === 'command') {
            if (parsed.command === 'help') {
              void publish({ type: 'OPEN_HELP' });
            } else {
              void publish({
                type: 'SET_UI_LANGUAGE',
                language: parsed.language,
              });
            }
            return;
          }
          void publish({
            type: 'CREATE_TASK',
            requirements: parsed.requirements,
            roles: snapshot.roles ?? DEFAULT_ROLE_ASSIGNMENT,
            requiresPlanApproval: snapshot.requiresPlanApprovalDraft,
          });
          return;
        }
        if (key.backspace || key.delete) {
          void publish({ type: 'TASK_REQUIREMENTS_BACKSPACE' });
          return;
        }
        if (printableText.length > 0) {
          void publish({ type: 'TASK_REQUIREMENTS_INPUT', text: printableText });
        }
        return;
      }

      if (key.tab) {
        if (isNarrowLayout(snapshot)) {
          void publish({ type: 'CYCLE_NARROW_PANEL' });
        } else {
          void publish({ type: 'CYCLE_LOG_TAB' });
        }
        return;
      }

      const letter = input.toLowerCase();
      // Form screens (new_task/project) already returned above.
      // Q cancels while a task is in flight; Q exits on terminal/idle screens.
      const terminalWorkflow =
        snapshot.workflowState === 'completed'
        || snapshot.workflowState === 'cancelled'
        || snapshot.workflowState === 'failed';
      const shouldCancelTask =
        !terminalWorkflow
        && (
          snapshot.screen === 'run'
          || snapshot.screen === 'plan_approval'
          || snapshot.processRunning
        );

      // Esc: leave app when not canceling an in-flight task (modals handled above).
      if (isEscape) {
        if (!shouldCancelTask) {
          void publish({ type: 'REQUEST_EXIT' });
        }
        return;
      }

      if (snapshot.screen === 'recovery' && snapshot.taskId !== undefined) {
        switch (letter) {
          case 'i':
            if (snapshot.recoveryAllowedActions.includes('inspect')) {
              void publish({ type: 'RECOVERY_INSPECT', taskId: snapshot.taskId });
            }
            return;
          case 'c':
            if (snapshot.recoveryAllowedActions.includes('continue')) {
              void publish({ type: 'RECOVERY_CONTINUE', taskId: snapshot.taskId });
            }
            return;
          case 'x':
            if (snapshot.recoveryAllowedActions.includes('cancel')) {
              void publish({ type: 'RECOVERY_CANCEL', taskId: snapshot.taskId });
            }
            return;
          case 'm':
            // Allow adding context while interrupted before continue.
            void publish({ type: 'OPEN_MESSAGE_ENTRY' });
            return;
          case 'q':
            void publish({ type: 'REQUEST_EXIT' });
            return;
          default:
            break;
        }
      }
      switch (letter) {
        case 'p':
          void publish({ type: 'OPEN_PAUSE_MENU' });
          return;
        case 'm':
          void publish({ type: 'OPEN_MESSAGE_ENTRY' });
          return;
        case 'd':
          void publish({ type: 'OPEN_DIFF' });
          return;
        case 'r':
          void publish({ type: 'REQUEST_REWORK' });
          return;
        case 'a':
          void publish({ type: 'APPROVE' });
          return;
        case 'q':
          // In-flight task: cancel confirm. Terminal/idle: exit app.
          if (shouldCancelTask) {
            void publish({ type: 'OPEN_CANCEL_CONFIRM' });
          } else {
            void publish({ type: 'REQUEST_EXIT' });
          }
          return;
        default:
          return;
      }
    },
    { isActive },
  );
}

function printableInputText(input: string, key: Key): string {
  if (key.ctrl || key.meta || key.tab || key.return || key.escape) return '';
  if (key.backspace || key.delete) return '';
  return [...input]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127 && (code < 128 || code > 159);
    })
    .join('');
}

function keyFingerprint(input: string, key: Key, isEscape: boolean): string {
  // Do not include ctrlCStage — Ctrl+C uses quiet-gap event timestamps only.
  if (key.ctrl && (input === 'c' || input === 'C')) return 'ctrl+c';
  if (key.tab) return 'tab';
  if (key.return) return 'return';
  if (isEscape) return 'escape';
  if (key.backspace || key.delete) return 'backspace';
  if (printableInputText(input, key).length > 0) return 'raw:printable';
  return `raw:${input.toLowerCase()}`;
}
