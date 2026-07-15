import React, { useMemo, useState } from 'react';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../../src/tui/App.js';
import {
  createInitialTuiSnapshot,
  createTuiStore,
  type ApplicationControllerPort,
  type TuiIntent,
  type TuiSnapshot,
  type TuiStore,
} from '../../../src/tui/store.js';

function frameText(frame: string | undefined): string {
  return stripAnsi(frame ?? '');
}

async function flushUi(ms = 0): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Ink buffers lone Esc briefly to disambiguate CSI sequences. */
async function flushEscape(): Promise<void> {
  await flushUi(50);
}

function baseSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return createInitialTuiSnapshot({
    screen: 'run',
    workflowState: 'implementing',
    taskId: 'task-18',
    roles: {
      master: 'codex',
      implementer: 'claude',
      reviewer: 'grok',
    },
    processRunning: true,
    pauseAfterAttempt: false,
    reworkCount: 0,
    maxReworks: 3,
    canApprove: false,
    canRework: true,
    activeLogTab: 'implementer',
    activeNarrowPanel: 'log',
    logs: {
      master: ['m1'],
      implementer: ['i1'],
      reviewer: ['r1'],
      system: ['s1'],
    },
    columns: 120,
    rows: 40,
    ...overrides,
  });
}

function Harness(props: {
  readonly initial: TuiSnapshot;
  readonly controller?: ApplicationControllerPort;
  readonly onIntent?: (intent: TuiIntent) => void;
  readonly onAuthorizedExit?: () => void;
  readonly storeRef?: { current: TuiStore | null };
}): React.ReactElement {
  const store = useMemo(
    () =>
      createTuiStore({
        initial: props.initial,
        controller: props.controller,
        onIntent: props.onIntent,
      }),
    [props.initial, props.controller, props.onIntent],
  );
  if (props.storeRef) {
    props.storeRef.current = store;
  }
  const [snapshot, setSnapshot] = useState(store.getSnapshot());

  return (
    <App
      snapshot={snapshot}
      store={store}
      onSnapshotChange={setSnapshot}
      onAuthorizedExit={props.onAuthorizedExit}
      disableWindowSizeSync
    />
  );
}

describe('Task 19 blockers', () => {
  describe('1) real P/M/Q actions', () => {
    it('dispatches REQUEST_PAUSE_AFTER_RUN only after pause menu confirmation', async () => {
      const intents: TuiIntent[] = [];
      const { stdin, lastFrame, unmount } = render(
        <Harness
          initial={baseSnapshot()}
          onIntent={(intent) => {
            intents.push(intent);
          }}
        />,
      );

      stdin.write('p');
      await flushUi();
      expect(intents.map((i) => i.type)).toContain('OPEN_PAUSE_MENU');
      expect(intents.map((i) => i.type)).not.toContain('REQUEST_PAUSE_AFTER_RUN');
      expect(frameText(lastFrame())).toMatch(/pause/i);
      expect(frameText(lastFrame())).toMatch(/confirm|Enter|Y/i);

      stdin.write('\r');
      await flushUi();
      expect(intents.map((i) => i.type)).toContain('REQUEST_PAUSE_AFTER_RUN');
      unmount();
    });

    it('cancels pause menu without dispatching REQUEST_PAUSE_AFTER_RUN', async () => {
      const intents: TuiIntent[] = [];
      const { stdin, lastFrame, unmount } = render(
        <Harness
          initial={baseSnapshot()}
          onIntent={(intent) => {
            intents.push(intent);
          }}
        />,
      );

      stdin.write('p');
      await flushUi();
      expect(frameText(lastFrame())).toMatch(/Pause after current run/i);
      stdin.write('\x1b'); // Esc (Ink flushes after short CSI wait)
      await flushEscape();
      expect(intents.map((i) => i.type)).toContain('DISMISS_MODAL');
      expect(intents.map((i) => i.type)).not.toContain('REQUEST_PAUSE_AFTER_RUN');
      expect(frameText(lastFrame())).not.toMatch(/Enter\/Y confirm · Esc cancel/i);
      unmount();
    });

    it('captures message entry, submits QUEUE_MESSAGE, Esc cancels, enforces max length', async () => {
      const intents: TuiIntent[] = [];
      const { stdin, lastFrame, unmount } = render(
        <Harness
          initial={baseSnapshot({
            maxMessageLength: 8,
            redactorSecrets: ['sekret-token-xyz'],
          })}
          onIntent={(intent) => {
            intents.push(intent);
          }}
        />,
      );

      stdin.write('m');
      await flushUi();
      expect(intents.map((i) => i.type)).toContain('OPEN_MESSAGE_ENTRY');
      expect(frameText(lastFrame())).toMatch(/message entry|Message entry/i);

      for (const ch of 'hello') {
        stdin.write(ch);
        await flushUi();
      }
      // Over max length — ignored beyond 8
      for (const ch of 'WORLD') {
        stdin.write(ch);
        await flushUi();
      }
      expect(frameText(lastFrame())).toMatch(/helloWOR/i);
      expect(frameText(lastFrame())).not.toMatch(/helloWORLD/i);

      stdin.write('\r');
      await flushUi();
      const queued = intents.find((i) => i.type === 'QUEUE_MESSAGE');
      expect(queued).toEqual({ type: 'QUEUE_MESSAGE', text: 'helloWOR' });
      unmount();
    });

    it('does not put raw secrets into status/log surfaces during message entry', async () => {
      const intents: TuiIntent[] = [];
      const { stdin, lastFrame, unmount } = render(
        <Harness
          initial={baseSnapshot({
            maxMessageLength: 64,
            redactorSecrets: ['super-secret-token-value'],
          })}
          onIntent={(intent) => {
            intents.push(intent);
          }}
        />,
      );

      stdin.write('m');
      await flushUi();
      for (const ch of 'super-secret-token-value') {
        stdin.write(ch);
        await flushUi();
      }
      const text = frameText(lastFrame());
      expect(text).not.toContain('super-secret-token-value');
      expect(text).toMatch(/\[REDACTED\]/i);
      unmount();
    });

    it('Q cancel confirmation dispatches REQUEST_CANCEL_OR_INTERRUPT not REQUEST_EXIT', async () => {
      const intents: TuiIntent[] = [];
      const controller: ApplicationControllerPort = {
        dispatch: async () => ({
          kind: 'exit_gate',
          gate: { allowed: false, reason: 'exit blocked: cleanup incomplete' },
        }),
      };
      const { stdin, unmount } = render(
        <Harness
          initial={baseSnapshot()}
          controller={controller}
          onIntent={(intent) => {
            intents.push(intent);
          }}
        />,
      );

      stdin.write('q');
      await flushUi();
      expect(intents.map((i) => i.type)).toContain('OPEN_CANCEL_CONFIRM');
      stdin.write('\r');
      await flushUi();
      expect(intents.map((i) => i.type)).toContain('REQUEST_CANCEL_OR_INTERRUPT');
      expect(intents.map((i) => i.type)).not.toContain('REQUEST_EXIT');
      unmount();
    });
  });

  describe('2) Ink exit lifecycle', () => {
    it('calls Ink exit only on authorized exit edge, not on mount with allowed gate', async () => {
      const authorizedExit = vi.fn();
      const processExit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);

      // Mount with exitGate already allowed must NOT exit.
      const mounted = render(
        <Harness
          initial={baseSnapshot({
            exitGate: { allowed: true },
            exitAuthorized: false,
            processRunning: false,
          })}
          onAuthorizedExit={authorizedExit}
        />,
      );
      await flushUi();
      expect(authorizedExit).not.toHaveBeenCalled();
      mounted.unmount();

      const requestGate = vi.fn(async () => ({
        allowed: true as const,
        reason: 'cleanup complete',
      }));
      const controller: ApplicationControllerPort = {
        dispatch: async (intent) => {
          if (
            intent.type === 'CONFIRM_TERMINATION' ||
            intent.type === 'REQUEST_EXIT'
          ) {
            return { kind: 'exit_gate', gate: await requestGate() };
          }
          return { kind: 'accepted' };
        },
      };

      const { stdin, unmount } = render(
        <Harness
          initial={baseSnapshot({
            modal: 'termination_confirm',
            focusOwner: 'modal',
            ctrlCStage: 'termination_confirm',
            processRunning: false,
            exitAuthorized: false,
          })}
          controller={controller}
          onAuthorizedExit={authorizedExit}
        />,
      );

      stdin.write('\r');
      await flushUi();
      expect(requestGate).toHaveBeenCalled();
      expect(authorizedExit).toHaveBeenCalledTimes(1);
      expect(processExit).not.toHaveBeenCalled();
      unmount();
      processExit.mockRestore();
    });

    it('blocked cleanup keeps app mounted and renders reason without exit', async () => {
      const authorizedExit = vi.fn();
      const controller: ApplicationControllerPort = {
        dispatch: async () => ({
          kind: 'exit_gate',
          gate: {
            allowed: false,
            reason: 'exit blocked: cleanup incomplete while workflow is cleanup_failed',
          },
        }),
      };
      const { stdin, lastFrame, unmount } = render(
        <Harness
          initial={baseSnapshot({
            modal: 'termination_confirm',
            focusOwner: 'modal',
            ctrlCStage: 'termination_confirm',
            workflowState: 'cleanup_failed',
            processRunning: false,
          })}
          controller={controller}
          onAuthorizedExit={authorizedExit}
        />,
      );

      stdin.write('\r');
      await flushUi();
      expect(authorizedExit).not.toHaveBeenCalled();
      const text = frameText(lastFrame());
      expect(text).toMatch(/exit blocked/i);
      expect(text).toMatch(/cleanup/i);
      // Still rendering screen content => mounted
      expect(text).toMatch(/Screen:\s*run|Task task-18|implementing/i);
      unmount();
    });
  });

  describe('3) deterministic narrow single panel', () => {
    it('narrow mode renders exactly one major panel', () => {
      const logOnly = baseSnapshot({
        columns: 60,
        rows: 24,
        activeNarrowPanel: 'log',
      });
      const { lastFrame: logFrame, unmount: u1 } = render(
        <App snapshot={logOnly} disableWindowSizeSync />,
      );
      const logText = frameText(logFrame());
      expect(logText).toMatch(/Activity|工作动态/i);
      // Workflow detail panel title is absent when activity is active.
      // Compact stepper chrome may still list short stage names.
      expect(logText).not.toMatch(/Current role|当前角色|状态:\s*implementing/i);
      u1();

      const wfOnly = baseSnapshot({
        columns: 60,
        rows: 10,
        activeNarrowPanel: 'workflow',
      });
      const { lastFrame: wfFrame, unmount: u2 } = render(
        <App snapshot={wfOnly} disableWindowSizeSync />,
      );
      const wfText = frameText(wfFrame());
      expect(wfText).toMatch(/Workflow|工作流/i);
      expect(wfText).toMatch(/implementing|running|运行中/i);
      expect(wfText).not.toMatch(/Activity|工作动态/i);
      u2();
    });

    it('narrow Tab cycles panels and log tabs deterministically including low rows', async () => {
      const intents: TuiIntent[] = [];
      const storeRef: { current: TuiStore | null } = { current: null };
      const { stdin, lastFrame, unmount } = render(
        <Harness
          initial={baseSnapshot({
            columns: 50,
            rows: 8,
            activeNarrowPanel: 'workflow',
            activeLogTab: 'master',
          })}
          onIntent={(intent) => {
            intents.push(intent);
          }}
          storeRef={storeRef}
        />,
      );

      // workflow -> activity (design: primary work-status feed)
      stdin.write('\t');
      await flushUi(20);
      let text = frameText(lastFrame());
      expect(storeRef.current!.getSnapshot().activeNarrowPanel).toBe('log');
      expect(text).toMatch(/Activity|工作动态/i);
      expect(text).not.toMatch(/Current role|当前角色/i);

      // cycle log tabs (state advances; UI stays on activity feed)
      stdin.write('\t');
      await flushUi();
      expect(storeRef.current!.getSnapshot().activeLogTab).toBe('implementer');

      stdin.write('\t');
      await flushUi();
      expect(storeRef.current!.getSnapshot().activeLogTab).toBe('reviewer');

      stdin.write('\t');
      await flushUi();
      text = frameText(lastFrame());
      expect(text).toMatch(/Activity|工作动态/i);
      expect(storeRef.current!.getSnapshot().activeLogTab).toBe('system');

      // wrap back to workflow
      stdin.write('\t');
      await flushUi();
      text = frameText(lastFrame());
      expect(storeRef.current!.getSnapshot().activeNarrowPanel).toBe('workflow');
      expect(text).toMatch(/\bWorkflow\b/);
      unmount();
    });
  });

  describe('4) global modal at App shell', () => {
    it.each(['health', 'project', 'diff'] as const)(
      'shows modal on %s screen when focus is modal/text_entry',
      async (screen) => {
        const { lastFrame, unmount } = render(
          <Harness
            initial={baseSnapshot({
              screen,
              modal: 'pause_menu',
              focusOwner: 'modal',
            })}
          />,
        );
        await flushUi();
        const text = frameText(lastFrame());
        expect(text).toMatch(/Pause after current run/i);
        expect(text).toMatch(/Health|Choose a project|Diff/i);
        unmount();
      },
    );

    it('never has modal/text_entry focus without a visible modal', async () => {
      const storeRef: { current: TuiStore | null } = { current: null };
      const { lastFrame, unmount } = render(
        <Harness
          initial={baseSnapshot({
            screen: 'health',
            modal: 'message_entry',
            focusOwner: 'text_entry',
            messageDraft: 'hi',
          })}
          storeRef={storeRef}
        />,
      );
      await flushUi();
      const snap = storeRef.current!.getSnapshot();
      expect(snap.focusOwner === 'modal' || snap.focusOwner === 'text_entry').toBe(
        true,
      );
      expect(snap.modal).not.toBe('none');
      expect(frameText(lastFrame())).toMatch(/Message to the active workflow/i);
      unmount();
    });
  });

  describe('5) one authoritative snapshot', () => {
    it('replaceSnapshot freezes and preserves UI-only state when requested', () => {
      const store = createTuiStore({
        initial: baseSnapshot({
          modal: 'pause_menu',
          focusOwner: 'modal',
          activeNarrowPanel: 'workflow',
          messageDraft: 'draft',
          canApprove: false,
          processRunning: true,
        }),
      });
      const next = store.replaceSnapshot(
        {
          canApprove: true,
          processRunning: false,
          workflowState: 'awaiting_plan_approval',
        },
        { preserveUiState: true },
      );
      expect(next.canApprove).toBe(true);
      expect(next.processRunning).toBe(false);
      expect(next.workflowState).toBe('awaiting_plan_approval');
      expect(next.modal).toBe('pause_menu');
      expect(next.focusOwner).toBe('modal');
      expect(next.activeNarrowPanel).toBe('workflow');
      expect(next.messageDraft).toBe('draft');
      expect(Object.isFrozen(next)).toBe(true);
      expect(Object.isFrozen(next.logs)).toBe(true);
    });

    it('parent snapshot rerender updates store; key dispatch follows new legality', async () => {
      const intents: TuiIntent[] = [];
      function Parent(): React.ReactElement {
        const store = useMemo(
          () =>
            createTuiStore({
              initial: baseSnapshot({
                canApprove: false,
                processRunning: true,
                screen: 'plan_approval',
                workflowState: 'awaiting_plan_approval',
              }),
              onIntent: (intent) => {
                intents.push(intent);
              },
            }),
          [],
        );
        const [external, setExternal] = useState(store.getSnapshot());
        const [tick, setTick] = useState(0);

        // After first paint, push domain update through props.snapshot
        React.useEffect(() => {
          if (tick === 0) {
            setTick(1);
            setExternal(
              createInitialTuiSnapshot({
                ...external,
                canApprove: true,
                processRunning: false,
              }),
            );
          }
        }, [tick, external]);

        return (
          <App
            snapshot={external}
            store={store}
            disableWindowSizeSync
            onSnapshotChange={() => {
              /* store is authoritative */
            }}
          />
        );
      }

      const { stdin, lastFrame, unmount } = render(<Parent />);
      await flushUi();
      await flushUi();

      // Approve should now be legal after parent update
      stdin.write('a');
      await flushUi();
      expect(intents.map((i) => i.type)).toContain('APPROVE');

      // processRunning false should be reflected and not overwritten by stale dispatch
      expect(frameText(lastFrame())).toMatch(/process:\s*stopped/i);
      unmount();
    });
  });

  describe('6) Ctrl+C distinct press with cooldown', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('held/repeated Ctrl+C inside cooldown does not advance to termination', async () => {
      const intents: TuiIntent[] = [];
      const { stdin, lastFrame, unmount } = render(
        <Harness
          initial={baseSnapshot()}
          onIntent={(intent) => {
            intents.push(intent);
          }}
        />,
      );

      stdin.write('\x03');
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(intents.map((i) => i.type)).toContain('OPEN_CONTROL_MENU');

      // spam inside cooldown
      stdin.write('\x03');
      stdin.write('\x03');
      stdin.write('\x03');
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      expect(
        intents.filter((i) => i.type === 'OPEN_TERMINATION_CONFIRM').length,
      ).toBe(0);

      // after quiet gap, deliberate second press advances
      await vi.advanceTimersByTimeAsync(500);
      stdin.write('\x03');
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(intents.map((i) => i.type)).toContain('OPEN_TERMINATION_CONFIRM');

      // further spam ignored
      stdin.write('\x03');
      stdin.write('\x03');
      await vi.advanceTimersByTimeAsync(100);
      expect(
        intents.filter((i) => i.type === 'OPEN_TERMINATION_CONFIRM').length,
      ).toBe(1);
      expect(frameText(lastFrame())).toMatch(/termination|confirm/i);
      unmount();
    });

    it('continuous held Ctrl+C beyond cooldown stays on control menu until quiet gap', async () => {
      const intents: TuiIntent[] = [];
      const { stdin, lastFrame, unmount } = render(
        <Harness
          initial={baseSnapshot()}
          onIntent={(intent) => {
            intents.push(intent);
          }}
        />,
      );

      // First press opens control menu.
      stdin.write('\x03');
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(intents.map((i) => i.type)).toContain('OPEN_CONTROL_MENU');
      expect(
        intents.filter((i) => i.type === 'OPEN_TERMINATION_CONFIRM').length,
      ).toBe(0);

      // Continuous hold: emit Ctrl+C every 100ms for >1s (beyond 500ms cooldown).
      // Every event must refresh the quiet-gap clock so no stage advance occurs.
      for (let i = 0; i < 12; i += 1) {
        await vi.advanceTimersByTimeAsync(100);
        stdin.write('\x03');
        await Promise.resolve();
      }

      expect(
        intents.filter((i) => i.type === 'OPEN_TERMINATION_CONFIRM').length,
      ).toBe(0);
      expect(intents.filter((i) => i.type === 'OPEN_CONTROL_MENU').length).toBe(1);
      const heldFrame = frameText(lastFrame());
      expect(heldFrame).toMatch(/Control menu/i);
      expect(heldFrame).not.toMatch(/Termination confirmation/);

      // Quiet gap with no Ctrl+C events, then a deliberate new press advances.
      await vi.advanceTimersByTimeAsync(500);
      stdin.write('\x03');
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(intents.map((i) => i.type)).toContain('OPEN_TERMINATION_CONFIRM');
      expect(
        intents.filter((i) => i.type === 'OPEN_TERMINATION_CONFIRM').length,
      ).toBe(1);
      expect(frameText(lastFrame())).toMatch(/termination|confirm/i);
      unmount();
    });

    it('non-Ctrl key rearms Ctrl+C after control menu without waiting full cooldown', async () => {
      const intents: TuiIntent[] = [];
      const { stdin, unmount } = render(
        <Harness
          initial={baseSnapshot()}
          onIntent={(intent) => {
            intents.push(intent);
          }}
        />,
      );

      stdin.write('\x03');
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      // non-ctrl key clears the Ctrl+C event stream (key-release equivalent)
      stdin.write('x');
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      stdin.write('\x03');
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(intents.map((i) => i.type)).toContain('OPEN_TERMINATION_CONFIRM');
      unmount();
    });
  });
});
