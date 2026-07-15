import React from 'react';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { App } from '../../../src/tui/App.js';
import { RecoveryScreen } from '../../../src/tui/screens/RecoveryScreen.js';
import {
  createInitialTuiSnapshot,
  createTuiStore,
  type TuiSnapshot,
} from '../../../src/tui/store.js';

function frameText(frame: string | undefined): string {
  return stripAnsi(frame ?? '');
}

function recoverySnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return createInitialTuiSnapshot({
    screen: 'recovery',
    workflowState: 'interrupted_needs_inspection',
    taskId: 'task-recover-1',
    projectPath: 'D:\\projects\\demo',
    processRunning: false,
    reworkCount: 1,
    maxReworks: 3,
    logs: {
      master: [],
      implementer: [],
      reviewer: [],
      system: [
        'Recovery evidence: process pid=4242 job=job-1',
        'Pending action process-cleanup is intent (never-auto-replay)',
      ],
    },
    error:
      'interrupted_needs_inspection: process identity requires operator review',
    statusMessage: 'Recovery mode — choose an allowed action',
    recoveryAllowedActions: ['inspect', 'continue', 'cancel'],
    canApprove: false,
    canRework: false,
    ...overrides,
  });
}

describe('RecoveryScreen', () => {
  it('renders bounded redacted evidence, allowed actions, and no secret/raw command leakage', () => {
    const snapshot = recoverySnapshot({
      logs: {
        master: [],
        implementer: [],
        reviewer: [],
        system: [
          'token=super-secret-token-value',
          'Authorization: Bearer sk-live-abcdef123456',
          'Recovery: pid=4242 job=job-1 status=interrupted_needs_inspection',
          'Allowed: inspect, cancel',
        ],
      },
      redactorSecrets: ['super-secret-token-value', 'sk-live-abcdef123456'],
    });

    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/Recovery/i);
    expect(text).toMatch(/task-recover-1/);
    expect(text).toMatch(/interrupted_needs_inspection/);
    expect(text).toMatch(/pid=4242|job=job-1/i);
    expect(text).toMatch(/inspect|cancel|Allowed/i);
    expect(text).not.toMatch(/super-secret-token-value/);
    expect(text).not.toMatch(/sk-live-abcdef123456/);
    expect(text).not.toMatch(/Bearer sk-live/i);
    // No raw shell/command execution strings leaked from recovery evidence.
    expect(text).not.toMatch(/cmd\.exe|powershell\.exe\s+-Command/i);
    expect(text).not.toMatch(/Screen:\s*recovery|Workflow:/i);
    unmount();
  });

  it('renders diagnostic database evidence without inviting destructive auto-repair', () => {
    const snapshot = recoverySnapshot({
      workflowState: 'failed',
      taskId: undefined,
      error:
        'Database diagnostic mode: file unreadable or incompatible. Side effects disabled.',
      logs: {
        master: [],
        implementer: [],
        reviewer: [],
        system: [
          'DB path: C:\\Users\\test\\AppData\\Local\\TriAgent\\triagent.db',
          'quick_check: unavailable',
          'Workers/adapters/locks/process host were not started',
        ],
      },
      statusMessage: 'Diagnostic read-only mode',
    });

    const { lastFrame, unmount } = render(
      <RecoveryScreen snapshot={snapshot} />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/diagnostic|database|unreadable|incompatible/i);
    expect(text).toMatch(/not started|side effects disabled|read-only/i);
    expect(text).not.toMatch(/auto[- ]?(delete|quarantine|repair|overwrite)/i);
    unmount();
  });

  it('shows only actions that the startup reconciliation decision actually allows', () => {
    const snapshot = recoverySnapshot({
      recoveryAllowedActions: ['cancel'],
      logs: {
        master: [],
        implementer: [],
        reviewer: [],
        system: ['Project lock lease is stale'],
      },
    });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/\[X\].*(cancel|取消)/i);
    expect(text).not.toMatch(/\[I\].*(inspect|检查)/i);
    expect(text).not.toMatch(/\[C\].*(continue|继续)/i);
    unmount();
  });

  it('recovery actions are typed intents; legality is enforced by controller not UI', async () => {
    const snapshot = recoverySnapshot();
    const store = createTuiStore({
      initial: snapshot,
      controller: {
        async dispatch(intent) {
          if (intent.type === 'REQUEST_CANCEL_OR_INTERRUPT') {
            return { kind: 'rejected', reason: 'cancel not legal without confirmation' };
          }
          if (intent.type === 'NAVIGATE' && intent.screen === 'settings') {
            return {
              kind: 'snapshot',
              snapshot: { screen: 'settings', statusMessage: 'Settings' },
            };
          }
          return { kind: 'accepted' };
        },
      },
    });

    // Direct cancel without confirmation path is rejected by store legality first.
    const afterIllegal = await store.dispatch({ type: 'REQUEST_CANCEL_OR_INTERRUPT' });
    expect(afterIllegal.statusMessage).toMatch(/not legal|requires open modal/i);

    const afterNav = await store.dispatch({ type: 'NAVIGATE', screen: 'settings' });
    expect(afterNav.screen).toBe('settings');
  });

  it('localizes recovery guidance while preserving raw evidence and workflow state', () => {
    const snapshot = recoverySnapshot({
      uiLanguage: 'zh-CN',
      logs: {
        master: [],
        implementer: [],
        reviewer: [],
        system: ['Recovery evidence: pid=4242 job=job-1'],
      },
    });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/恢复|证据|允许的操作/);
    expect(text).toContain('interrupted_needs_inspection');
    expect(text).toContain('Recovery evidence: pid=4242 job=job-1');
    expect(text).not.toMatch(/Screen:|Workflow:/i);
    expect(text).not.toContain('�');
    unmount();
  });
});
