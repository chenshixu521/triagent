import React from 'react';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { App } from '../../../src/tui/App.js';
import {
  createInitialTuiSnapshot,
  type TuiSnapshot,
} from '../../../src/tui/store.js';

function frameText(frame: string | undefined): string {
  return stripAnsi(frame ?? '');
}

function runningSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return createInitialTuiSnapshot({
    screen: 'run',
    workflowState: 'implementing',
    taskId: 'task-18',
    projectPath: 'D:\\codex\\project\\demo',
    roles: {
      master: 'codex',
      implementer: 'claude',
      reviewer: 'grok',
    },
    processRunning: true,
    pauseAfterAttempt: true,
    reworkCount: 1,
    maxReworks: 3,
    activeLogTab: 'implementer',
    logs: {
      master: ['Master planning complete'],
      implementer: ['Claude: editing src/server.ts', 'token=super-secret-token-value'],
      reviewer: [],
      system: ['Worker heartbeat ok'],
    },
    canApprove: false,
    canRework: true,
    elapsedLabel: '00:12:46',
    ...overrides,
  });
}

describe('RunScreen rendering', () => {
  it('renders concise task, role, workflow, process, rework, and log context without debug rows', () => {
    const snapshot = runningSnapshot();
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/Master\s*=\s*Codex/i);
    expect(text).toMatch(/Implementer\s*=\s*Claude/i);
    expect(text).toMatch(/Reviewer\s*=\s*Grok/i);
    expect(text).toMatch(/implementing/i);
    expect(text).toMatch(/running/i);
    expect(text).toMatch(/Rework\s*1\s*\/\s*3/i);
    expect(text).toMatch(/Agent log|Log.*implementer/i);
    expect(text).toMatch(/Claude:\s*editing src\/server\.ts/i);
    expect(text).not.toMatch(/Screen:\s*run|Layout:|layout:\s*(single|multi)|Retry\s*1\s*\/\s*3/i);
    unmount();
  });

  it('shows pause-after-run without claiming the process has stopped', () => {
    const snapshot = runningSnapshot({
      pauseAfterAttempt: true,
      processRunning: true,
      workflowState: 'implementing',
    });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/pause after current run/i);
    expect(text).toMatch(/running/i);
    expect(text).not.toMatch(/stopped/i);
    unmount();
  });

  it('renders blocked-exit reason when cleanup gate denies exit', () => {
    const snapshot = runningSnapshot({
      workflowState: 'cleanup_failed',
      processRunning: false,
      pauseAfterAttempt: false,
      exitGate: {
        allowed: false,
        reason: 'exit blocked: cleanup incomplete while workflow is cleanup_failed',
      },
    });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/cleanup_failed/i);
    expect(text).toMatch(/exit blocked/i);
    expect(text).toMatch(/cleanup incomplete/i);
    unmount();
  });

  it('redacts secrets from log surfaces and truncates overlong lines', () => {
    const longLine = `noise ${'x'.repeat(200)}`;
    const snapshot = runningSnapshot({
      logs: {
        master: [],
        implementer: [
          'Authorization: Bearer super-secret-token-value',
          longLine,
        ],
        reviewer: [],
        system: [],
      },
      redactorSecrets: ['super-secret-token-value'],
    });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).not.toContain('super-secret-token-value');
    expect(text).toMatch(/\[REDACTED\]/i);
    expect(text).toMatch(/\[truncated\]/i);
    unmount();
  });

  it('uses single-panel layout on narrow terminals', () => {
    const snapshot = runningSnapshot({
      columns: 60,
      rows: 24,
      activeNarrowPanel: 'log',
    });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).not.toMatch(/layout:\s*(single|multi)|narrow panel/i);
    // Exactly one major panel: log active → no workflow step list.
    expect(text).toMatch(/Agent log|Log/i);
    expect(text).not.toMatch(/Environment check/);
    expect(text).not.toMatch(/Implement code/);
    unmount();
  });

  it('uses multi-panel layout on wide terminals', () => {
    const snapshot = runningSnapshot({
      columns: 120,
      rows: 40,
    });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/Workflow/i);
    expect(text).toMatch(/Agent log|Log/i);
    expect(text).not.toMatch(/layout:\s*(single|multi)/i);
    unmount();
  });

  it('renders loading, empty, and error states safely', () => {
    const loading = runningSnapshot({ loading: true, logs: { master: [], implementer: [], reviewer: [], system: [] } });
    const empty = runningSnapshot({
      loading: false,
      logs: { master: [], implementer: [], reviewer: [], system: [] },
      empty: true,
    });
    const errored = runningSnapshot({
      loading: false,
      error: 'Worker disconnected',
    });

    const loadingRender = render(
      <App snapshot={loading} disableWindowSizeSync />,
    );
    expect(frameText(loadingRender.lastFrame())).toMatch(/loading/i);
    loadingRender.unmount();

    const emptyRender = render(
      <App snapshot={empty} disableWindowSizeSync />,
    );
    expect(frameText(emptyRender.lastFrame())).toMatch(/no log output/i);
    emptyRender.unmount();

    const errorRender = render(
      <App snapshot={errored} disableWindowSizeSync />,
    );
    expect(frameText(errorRender.lastFrame())).toMatch(/Worker disconnected/i);
    errorRender.unmount();
  });

  it('localizes UI labels while preserving raw workflow, path, and agent log text', () => {
    const snapshot = runningSnapshot({ uiLanguage: 'zh-CN' });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/工作流|运行中|代理日志/);
    expect(text).toContain('implementing');
    expect(text).toContain('D:\\codex\\project\\demo');
    expect(text).toContain('Claude: editing src/server.ts');
    expect(text).not.toMatch(/Screen:|Layout:|Log tab:/i);
    expect(text).not.toContain('�');
    unmount();
  });
});
