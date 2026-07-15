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
    activeRole: 'implementer',
    activeAdapter: 'Claude',
    executionScopeLabel: '候选工作区',
    activityLines: [
      '15:01:02  [system] 任务已提交',
      '15:01:12  [master] Claude 开始规划',
      '15:01:18  [tool] master Read README.md',
      '15:02:05  [impl] Grok 开始实施',
      '15:02:22  [tool] impl Write src/hello.ts',
    ],
    logs: {
      master: ['Master planning complete'],
      implementer: ['Claude: editing src/server.ts', 'token=super-secret-token-value'],
      reviewer: [],
      system: ['Worker heartbeat ok'],
    },
    canApprove: false,
    canRework: true,
    elapsedLabel: '00:12:46',
    statusMessage: '实施代理正在修改代码…',
    ...overrides,
  });
}

describe('RunScreen rendering (design work-status-v2)', () => {
  it('renders header, short stepper, left meta, activity tags', () => {
    const snapshot = runningSnapshot();
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/Master\s*=\s*Codex/i);
    expect(text).toMatch(/Implementer\s*=\s*Claude/i);
    expect(text).toMatch(/Reviewer\s*=\s*Grok/i);
    // Design short stepper labels (EN)
    expect(text).toMatch(/Env|环境/);
    expect(text).toMatch(/Implement|实施/);
    expect(text).toMatch(/working|工作中/i);
    expect(text).toMatch(/Rework\s*1\s*\/\s*3|返工\s*1\s*\/\s*3/i);
    expect(text).toMatch(/Activity|工作动态/i);
    expect(text).toMatch(/\[tool\]/);
    expect(text).toMatch(/Write src\/hello\.ts/i);
    expect(text).toMatch(/实施代理正在修改代码/);
    expect(text).toMatch(/Current role|当前角色/i);
    expect(text).not.toMatch(/Screen:\s*run|Layout:/i);
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

    expect(text).toMatch(/pause after current run|当前运行结束后暂停/i);
    expect(text).toMatch(/running|工作中|运行中/i);
    expect(text).not.toMatch(/stopped|已停止/i);
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

  it('redacts secrets from activity surfaces', () => {
    const snapshot = runningSnapshot({
      activityLines: [
        '15:00:00  [impl] Authorization: Bearer super-secret-token-value',
      ],
      redactorSecrets: ['super-secret-token-value'],
    });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).not.toContain('super-secret-token-value');
    expect(text).toMatch(/\[REDACTED\]/i);
    unmount();
  });

  it('uses single major panel on narrow terminals', () => {
    const snapshot = runningSnapshot({
      columns: 60,
      rows: 24,
      activeNarrowPanel: 'log',
    });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/Activity|工作动态/i);
    expect(text).not.toMatch(/State:\s*implementing|状态:\s*implementing/i);
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

    expect(text).toMatch(/Workflow|工作流/i);
    expect(text).toMatch(/Activity|工作动态/i);
    unmount();
  });

  it('renders loading, empty, and error states safely', () => {
    const loading = runningSnapshot({
      loading: true,
      activityLines: [],
      logs: { master: [], implementer: [], reviewer: [], system: [] },
      statusMessage: '正在启动工作流…',
    });
    const empty = runningSnapshot({
      loading: false,
      processRunning: false,
      activityLines: [],
      logs: { master: [], implementer: [], reviewer: [], system: [] },
      empty: true,
      statusMessage: undefined,
    });
    const errored = runningSnapshot({
      loading: false,
      error: 'Worker disconnected',
    });

    const loadingRender = render(
      <App snapshot={loading} disableWindowSizeSync />,
    );
    expect(frameText(loadingRender.lastFrame())).toMatch(
      /working|工作中|启动/i,
    );
    loadingRender.unmount();

    const emptyRender = render(
      <App snapshot={empty} disableWindowSizeSync />,
    );
    expect(frameText(emptyRender.lastFrame())).toMatch(
      /no activity yet|暂无动态/i,
    );
    emptyRender.unmount();

    const errorRender = render(
      <App snapshot={errored} disableWindowSizeSync />,
    );
    expect(frameText(errorRender.lastFrame())).toMatch(/Worker disconnected/i);
    errorRender.unmount();
  });

  it('localizes UI labels while preserving raw activity and paths', () => {
    const snapshot = runningSnapshot({ uiLanguage: 'zh-CN' });
    const { lastFrame, unmount } = render(
      <App snapshot={snapshot} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());

    expect(text).toMatch(/工作流|工作动态|运行中/);
    expect(text).toContain('implementing');
    expect(text).toMatch(/\[tool\]/);
    expect(text).toContain('Write src/hello.ts');
    expect(text).not.toContain('�');
    unmount();
  });
});
