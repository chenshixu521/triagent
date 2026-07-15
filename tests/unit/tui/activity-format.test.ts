import { describe, expect, it } from 'vitest';

import { asAttemptId } from '../../../src/domain/ids.js';
import {
  formatAgentActivity,
  lookLikeToolLine,
  renderActivityLine,
  stageActivityMessage,
} from '../../../src/tui/activity-format.js';

describe('activity-format (design work-status-v2)', () => {
  it('renders design clock + tag lines', () => {
    const line = renderActivityLine('system', '任务已提交', new Date(2026, 0, 1, 15, 1, 2));
    expect(line.line).toMatch(/^\d{2}:\d{2}:\d{2}  \[system\] 任务已提交$/);
  });

  it('maps stages to [stage]/[system] lines', () => {
    expect(stageActivityMessage('implementing').tag).toBe('stage');
    expect(stageActivityMessage('completed').tag).toBe('system');
    expect(stageActivityMessage('completed').text).toContain('可退出');
  });

  it('detects tool-like output for [tool] tags', () => {
    expect(lookLikeToolLine('Read README.md')).toMatch(/Read README\.md/i);
    expect(lookLikeToolLine('Write src/hello.ts')).toMatch(/Write/i);
    expect(lookLikeToolLine('hello world plain text')).toBeUndefined();
  });

  it('formats agent process_started and tool output per design tags', () => {
    const started = formatAgentActivity({
      role: 'implementer',
      adapterKind: 'grok',
      event: {
        type: 'process_started',
        attemptId: asAttemptId('attempt-1'),
        pid: 42,
        occurredAt: new Date().toISOString(),
      },
    });
    expect(started?.tag).toBe('impl');
    expect(started?.text).toMatch(/Grok/);

    const tool = formatAgentActivity({
      role: 'implementer',
      adapterKind: 'grok',
      event: {
        type: 'output',
        attemptId: asAttemptId('attempt-1'),
        text: 'Write src/hello.ts',
      },
    });
    expect(tool?.tag).toBe('tool');
    expect(tool?.line).toMatch(/\[tool\].*Write src\/hello\.ts/i);
  });
});
