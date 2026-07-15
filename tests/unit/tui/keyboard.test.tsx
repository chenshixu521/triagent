import React, { useMemo, useState } from 'react';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../../src/tui/App.js';
import {
  createInitialTuiSnapshot,
  createTuiStore,
  type ApplicationControllerPort,
  type TuiIntent,
  type TuiSnapshot,
} from '../../../src/tui/store.js';

function frameText(frame: string | undefined): string {
  return stripAnsi(frame ?? '');
}

async function flushUi(): Promise<void> {
  // Drain microtasks then macrotask so Ink/React commit after async dispatch.
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
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
  const [snapshot, setSnapshot] = useState(store.getSnapshot());

  return (
    <App
      snapshot={snapshot}
      store={store}
      onSnapshotChange={setSnapshot}
      disableWindowSizeSync
    />
  );
}

async function pressAndCollect(
  initial: TuiSnapshot,
  key: string,
): Promise<readonly TuiIntent[]> {
  const intents: TuiIntent[] = [];
  const { stdin, unmount } = render(
    <Harness
      initial={initial}
      onIntent={(intent) => {
        intents.push(intent);
      }}
    />,
  );
  stdin.write(key);
  await flushUi();
  unmount();
  return intents;
}

// Async Ink input cases exceed the default 5s only under full-suite parallel load.
describe('TUI keyboard semantics', { timeout: 15_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults new tasks to Claude planning, Grok implementation, and Codex review', () => {
    expect(createInitialTuiSnapshot().roles).toEqual({
      master: 'claude',
      implementer: 'grok',
      reviewer: 'codex',
    });
  });

  it('captures, edits, and submits a project path before global shortcuts', async () => {
    const intents: TuiIntent[] = [];
    const initial = baseSnapshot({
      screen: 'project',
      workflowState: 'draft',
      processRunning: false,
      projectPath: undefined,
    });
    const { stdin, lastFrame, unmount } = render(
      <Harness
        initial={initial}
        onIntent={(intent) => {
          intents.push(intent);
        }}
      />,
    );

    for (const character of '  D:\\code\\repox') {
      stdin.write(character);
      await flushUi();
    }
    stdin.write('\x7f');
    await flushUi();

    expect(frameText(lastFrame())).toContain('D:\\code\\repo');

    stdin.write('\r');
    await flushUi();

    expect(intents).toContainEqual({
      type: 'SELECT_PROJECT',
      projectPath: 'D:\\code\\repo',
    });
    expect(intents.map((intent) => intent.type)).not.toContain('OPEN_DIFF');
    expect(intents.map((intent) => intent.type)).not.toContain('OPEN_PAUSE_MENU');
    unmount();
  });

  it('captures, edits, and submits task requirements before global shortcuts', async () => {
    const intents: TuiIntent[] = [];
    const initial = baseSnapshot({
      screen: 'new_task',
      workflowState: 'draft',
      processRunning: false,
      roles: {
        master: 'claude',
        implementer: 'grok',
        reviewer: 'codex',
      },
    });
    const { stdin, lastFrame, unmount } = render(
      <Harness
        initial={initial}
        onIntent={(intent) => {
          intents.push(intent);
        }}
      />,
    );

    for (const character of '  Implement p, d, and qx') {
      stdin.write(character);
      await flushUi();
    }
    stdin.write('\x7f');
    await flushUi();

    expect(frameText(lastFrame())).toContain('Implement p, d, and q');

    stdin.write('\r');
    await flushUi();

    expect(intents).toContainEqual({
      type: 'CREATE_TASK',
      requirements: 'Implement p, d, and q',
      roles: {
        master: 'claude',
        implementer: 'grok',
        reviewer: 'codex',
      },
      requiresPlanApproval: true,
    });
    expect(intents.map((intent) => intent.type)).not.toContain('OPEN_PAUSE_MENU');
    expect(intents.map((intent) => intent.type)).not.toContain('OPEN_DIFF');
    expect(intents.map((intent) => intent.type)).not.toContain('OPEN_CANCEL_CONFIRM');
    unmount();
  });

  it('opens /help as a modal without creating a task and Esc dismisses it', async () => {
    const intents: TuiIntent[] = [];
    const initial = baseSnapshot({
      screen: 'new_task',
      workflowState: 'draft',
      processRunning: false,
      projectPath: 'D:\\projects\\demo',
    });
    const { stdin, lastFrame, unmount } = render(
      <Harness
        initial={initial}
        onIntent={(intent) => {
          intents.push(intent);
        }}
      />,
    );

    for (const character of '/help') {
      stdin.write(character);
      await flushUi();
    }
    stdin.write('\r');
    await flushUi();

    expect(intents.map((intent) => intent.type)).toContain('OPEN_HELP');
    expect(intents.map((intent) => intent.type)).not.toContain('CREATE_TASK');
    expect(frameText(lastFrame())).toMatch(/available commands|\/help|操作说明/i);

    stdin.write('\x1b');
    // Ink waits briefly to distinguish a lone Esc from the start of an escape sequence.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    await flushUi();
    expect(intents.map((intent) => intent.type)).toContain('DISMISS_MODAL');
    unmount();
  });

  it('dispatches /lang as a persisted language intent instead of a task', async () => {
    const intents: TuiIntent[] = [];
    const controller: ApplicationControllerPort = {
      dispatch: async (intent) => {
        if (intent.type === 'SET_UI_LANGUAGE') {
          return {
            kind: 'snapshot',
            snapshot: { uiLanguage: intent.language },
          };
        }
        return { kind: 'accepted' };
      },
    };
    const initial = baseSnapshot({
      screen: 'new_task',
      workflowState: 'draft',
      processRunning: false,
      uiLanguage: 'en',
    });
    const { stdin, unmount } = render(
      <Harness
        initial={initial}
        controller={controller}
        onIntent={(intent) => {
          intents.push(intent);
        }}
      />,
    );

    for (const character of '/lang') {
      stdin.write(character);
      await flushUi();
    }
    stdin.write('\r');
    await flushUi();

    expect(intents).toContainEqual({
      type: 'SET_UI_LANGUAGE',
      language: 'zh-CN',
    });
    expect(intents.map((intent) => intent.type)).not.toContain('CREATE_TASK');
    unmount();
  });

  it('rejects an unknown slash command without creating a task', async () => {
    const intents: TuiIntent[] = [];
    const initial = baseSnapshot({
      screen: 'new_task',
      workflowState: 'draft',
      processRunning: false,
      uiLanguage: 'en',
    });
    const { stdin, lastFrame, unmount } = render(
      <Harness
        initial={initial}
        onIntent={(intent) => {
          intents.push(intent);
        }}
      />,
    );

    for (const character of '/unknown') {
      stdin.write(character);
      await flushUi();
    }
    stdin.write('\r');
    await flushUi();

    expect(intents.map((intent) => intent.type)).not.toContain('CREATE_TASK');
    expect(frameText(lastFrame())).toMatch(/unknown command|\/help/i);
    unmount();
  });

  it('cycles all six role assignments and toggles plan approval on the task form', async () => {
    const intents: TuiIntent[] = [];
    const initial = baseSnapshot({
      screen: 'new_task',
      workflowState: 'draft',
      processRunning: false,
      roles: {
        master: 'claude',
        implementer: 'grok',
        reviewer: 'codex',
      },
    });
    const { stdin, lastFrame, unmount } = render(
      <Harness
        initial={initial}
        onIntent={(intent) => {
          intents.push(intent);
        }}
      />,
    );
    const expectedAssignments = [
      ['CODEX', 'CLAUDE', 'GROK'],
      ['CODEX', 'GROK', 'CLAUDE'],
      ['CLAUDE', 'CODEX', 'GROK'],
      ['GROK', 'CODEX', 'CLAUDE'],
      ['GROK', 'CLAUDE', 'CODEX'],
      ['CLAUDE', 'GROK', 'CODEX'],
    ] as const;

    for (const [index, [master, implementer, reviewer]] of expectedAssignments.entries()) {
      stdin.write('\t');
      await flushUi();
      expect(
        intents.filter((intent) => intent.type === 'CYCLE_ROLE_ASSIGNMENT'),
      ).toHaveLength(index + 1);
      const text = frameText(lastFrame());
      expect(text).toMatch(new RegExp(`Master\\s+${master}`, 'i'));
      expect(text).toMatch(new RegExp(`Implement\\s+${implementer}`, 'i'));
      expect(text).toMatch(new RegExp(`Review\\s+${reviewer}`, 'i'));
    }

    expect(frameText(lastFrame())).toMatch(
      /Ctrl\+P plan approval\s*·\s*required/i,
    );
    stdin.write('\x10');
    await flushUi();
    expect(frameText(lastFrame())).toMatch(
      /Ctrl\+P plan approval\s*·\s*automatic/i,
    );
    unmount();
  });

  it('maps P/M/D/Tab/R/A/Q with case-insensitive letter keys', async () => {
    const legalBase = baseSnapshot({
      canRework: true,
      canApprove: true,
      workflowState: 'awaiting_plan_approval',
      screen: 'plan_approval',
      processRunning: false,
      modal: 'none',
      focusOwner: 'app',
    });

    const p = await pressAndCollect(legalBase, 'p');
    const P = await pressAndCollect(legalBase, 'P');
    const m = await pressAndCollect(legalBase, 'm');
    const d = await pressAndCollect(legalBase, 'd');
    const tab = await pressAndCollect(legalBase, '\t');
    const r = await pressAndCollect(legalBase, 'r');
    const a = await pressAndCollect(legalBase, 'a');
    const q = await pressAndCollect(legalBase, 'q');

    expect(p.map((intent) => intent.type)).toContain('OPEN_PAUSE_MENU');
    expect(P.map((intent) => intent.type)).toContain('OPEN_PAUSE_MENU');
    expect(m.map((intent) => intent.type)).toContain('OPEN_MESSAGE_ENTRY');
    expect(d.map((intent) => intent.type)).toContain('OPEN_DIFF');
    expect(tab.map((intent) => intent.type)).toContain('CYCLE_LOG_TAB');
    expect(r.map((intent) => intent.type)).toContain('REQUEST_REWORK');
    expect(a.map((intent) => intent.type)).toContain('APPROVE');
    expect(q.map((intent) => intent.type)).toContain('OPEN_CANCEL_CONFIRM');
  });

  it('maps recovery I/C/X keys to task-scoped typed intents', async () => {
    const recovery = baseSnapshot({
      screen: 'recovery',
      workflowState: 'interrupted_needs_inspection',
      taskId: 'task-recovery-keyboard',
      processRunning: false,
      canApprove: false,
      canRework: false,
      recoveryAllowedActions: ['inspect', 'continue', 'cancel'],
    });

    const inspect = await pressAndCollect(recovery, 'i');
    const continued = await pressAndCollect(recovery, 'c');
    const cancelled = await pressAndCollect(recovery, 'x');

    expect(inspect).toContainEqual({
      type: 'RECOVERY_INSPECT',
      taskId: 'task-recovery-keyboard',
    });
    expect(continued).toContainEqual({
      type: 'RECOVERY_CONTINUE',
      taskId: 'task-recovery-keyboard',
    });
    expect(cancelled).toContainEqual({
      type: 'RECOVERY_CANCEL',
      taskId: 'task-recovery-keyboard',
    });
  });

  it('does not dispatch recovery actions that are absent from the allowed action set', async () => {
    const recovery = baseSnapshot({
      screen: 'recovery',
      workflowState: 'awaiting_user',
      taskId: 'task-recovery-cancel-only',
      processRunning: false,
      canApprove: false,
      canRework: false,
      recoveryAllowedActions: ['cancel'],
    });

    const inspect = await pressAndCollect(recovery, 'i');
    const continued = await pressAndCollect(recovery, 'c');
    const cancelled = await pressAndCollect(recovery, 'x');

    expect(inspect.map((intent) => intent.type)).not.toContain('RECOVERY_INSPECT');
    expect(continued.map((intent) => intent.type)).not.toContain('RECOVERY_CONTINUE');
    expect(cancelled).toContainEqual({
      type: 'RECOVERY_CANCEL',
      taskId: 'task-recovery-cancel-only',
    });
  });

  it('ignores action keys while modal or text entry owns focus', async () => {
    const intents: TuiIntent[] = [];
    const initial = baseSnapshot({
      modal: 'message_entry',
      focusOwner: 'text_entry',
    });
    const { stdin, unmount } = render(
      <Harness
        initial={initial}
        onIntent={(intent) => {
          intents.push(intent);
        }}
      />,
    );

    stdin.write('p');
    stdin.write('d');
    stdin.write('r');
    stdin.write('a');
    stdin.write('q');
    await flushUi();

    expect(intents.map((intent) => intent.type)).not.toContain('OPEN_PAUSE_MENU');
    expect(intents.map((intent) => intent.type)).not.toContain('OPEN_DIFF');
    expect(intents.map((intent) => intent.type)).not.toContain('REQUEST_REWORK');
    expect(intents.map((intent) => intent.type)).not.toContain('APPROVE');
    expect(intents.map((intent) => intent.type)).not.toContain('OPEN_CANCEL_CONFIRM');
    unmount();
  });

  it('rejects illegal rework/approve intents when not legal', async () => {
    const intents: TuiIntent[] = [];
    const initial = baseSnapshot({
      canRework: false,
      canApprove: false,
      workflowState: 'implementing',
    });
    const { stdin, lastFrame, unmount } = render(
      <Harness
        initial={initial}
        onIntent={(intent) => {
          intents.push(intent);
        }}
      />,
    );

    stdin.write('r');
    await flushUi();
    stdin.write('a');
    await flushUi();

    expect(intents.map((intent) => intent.type)).not.toContain('REQUEST_REWORK');
    expect(intents.map((intent) => intent.type)).not.toContain('APPROVE');
    const text = frameText(lastFrame());
    expect(text).toMatch(/not legal|not available|illegal/i);
    unmount();
  });

  it('first Ctrl+C opens control menu; second after rearm opens termination confirmation', async () => {
    vi.useFakeTimers();
    try {
      const intents: TuiIntent[] = [];
      const initial = baseSnapshot({
        ctrlCStage: 'none',
        modal: 'none',
        focusOwner: 'app',
      });
      const { stdin, lastFrame, unmount } = render(
        <Harness
          initial={initial}
          onIntent={(intent) => {
            intents.push(intent);
          }}
        />,
      );

      stdin.write('\x03');
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(intents.map((intent) => intent.type)).toContain('OPEN_CONTROL_MENU');
      expect(frameText(lastFrame())).toMatch(/control menu/i);

      // Wait out cooldown so second press is a distinct deliberate press.
      await vi.advanceTimersByTimeAsync(500);
      stdin.write('\x03');
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(intents.map((intent) => intent.type)).toContain('OPEN_TERMINATION_CONFIRM');
      expect(frameText(lastFrame())).toMatch(/termination|confirm/i);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirmed termination invokes controller exit gate and never process.exit', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const requestExit = vi.fn(async () => ({
      allowed: false,
      reason: 'exit blocked: cleanup incomplete while workflow is cleanup_failed',
    }));
    const controller: ApplicationControllerPort = {
      dispatch: async (intent) => {
        if (
          intent.type === 'CONFIRM_TERMINATION' ||
          intent.type === 'REQUEST_CANCEL_OR_INTERRUPT' ||
          intent.type === 'REQUEST_EXIT'
        ) {
          return { kind: 'exit_gate', gate: await requestExit() };
        }
        return { kind: 'accepted' };
      },
    };

    const initial = baseSnapshot({
      modal: 'termination_confirm',
      focusOwner: 'modal',
      ctrlCStage: 'termination_confirm',
      workflowState: 'cleanup_failed',
      processRunning: false,
      exitGate: { allowed: false, reason: 'exit blocked: cleanup incomplete' },
    });

    const { stdin, lastFrame, unmount } = render(
      <Harness initial={initial} controller={controller} />,
    );

    stdin.write('\r');
    await flushUi();

    expect(requestExit).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    const text = frameText(lastFrame());
    expect(text).toMatch(/exit blocked/i);
    expect(text).toMatch(/cleanup/i);

    exitSpy.mockRestore();
    unmount();
  });

  it('prevents key-repeat double dispatch races', async () => {
    const intents: TuiIntent[] = [];
    const initial = baseSnapshot();
    const { stdin, unmount } = render(
      <Harness
        initial={initial}
        onIntent={(intent) => {
          intents.push(intent);
        }}
      />,
    );

    stdin.write('p');
    stdin.write('p');
    stdin.write('p');
    await flushUi();

    const pauseCount = intents.filter((intent) => intent.type === 'OPEN_PAUSE_MENU').length;
    expect(pauseCount).toBe(1);
    unmount();
  });

  it('cycles log tabs with Tab', async () => {
    const initial = baseSnapshot({ activeLogTab: 'implementer' });
    const { stdin, lastFrame, unmount } = render(<Harness initial={initial} />);

    stdin.write('\t');
    await flushUi();
    let text = frameText(lastFrame());
    expect(text).toMatch(/Log:\s*reviewer/i);

    stdin.write('\t');
    await flushUi();
    text = frameText(lastFrame());
    expect(text).toMatch(/Log:\s*system/i);
    unmount();
  });
});
