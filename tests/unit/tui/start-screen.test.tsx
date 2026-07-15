import React from 'react';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { App } from '../../../src/tui/App.js';
import {
  TRI_FOX_HEIGHT,
  TRI_FOX_WIDTH,
  triFoxLines,
  type TriFoxState,
} from '../../../src/tui/components/TriFox.js';
import { StartScreen } from '../../../src/tui/screens/StartScreen.js';
import {
  createInitialTuiSnapshot,
  type TuiSnapshot,
} from '../../../src/tui/store.js';

function frameText(frame: string | undefined): string {
  return stripAnsi(frame ?? '');
}

function visibleLines(frame: string | undefined): readonly string[] {
  return frameText(frame)
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function terminalWidth(value: string): number {
  return Array.from(value).reduce((width, character) => {
    const wide = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/u
      .test(character);
    return width + (wide ? 2 : 1);
  }, 0);
}

function collectElements(
  node: React.ReactNode,
  elements: React.ReactElement[] = [],
): readonly React.ReactElement[] {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return;
    elements.push(child);
    const props = child.props as { readonly children?: React.ReactNode };
    collectElements(props.children, elements);
  });
  return elements;
}

function elementText(node: React.ReactNode): string {
  let value = '';
  React.Children.forEach(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      value += String(child);
      return;
    }
    if (!React.isValidElement(child)) return;
    const props = child.props as { readonly children?: React.ReactNode };
    value += elementText(props.children);
  });
  return value;
}

function startSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return createInitialTuiSnapshot({
    screen: 'new_task',
    workflowState: 'draft',
    projectPath: 'D:\\codex\\project\\demo',
    roles: {
      master: 'codex',
      implementer: 'claude',
      reviewer: 'grok',
    },
    processRunning: false,
    requiresPlanApprovalDraft: true,
    columns: 100,
    rows: 40,
    uiLanguage: 'en',
    ...overrides,
  });
}

describe('TriAgent start screen', () => {
  it('matches the approved wide hierarchy with a full frame and a large prompt', () => {
    const { lastFrame, unmount } = render(
      <App snapshot={startSnapshot()} disableWindowSizeSync />,
    );
    const text = frameText(lastFrame());
    const lines = visibleLines(lastFrame());

    expect(lines.at(0)?.trim()).toMatch(/^╭─+╮$/u);
    expect(lines.at(-1)?.trim()).toMatch(/^╰─+╯$/u);
    expect(text).not.toContain('◆ TRIAGENT');
    expect(text).toContain('Multi-agent coding assistant');
    expect(text).toContain('What would you like the agents to build?');

    const brandLineIndex = lines.findIndex((line) => line.includes('TRIAGENT'));
    const foxLabelLineIndex = lines.findIndex((line) => line.includes('TRIFOX · IDLE'));
    const projectLabelLineIndex = lines.findIndex((line) => line.includes('Project'));
    const projectPathLineIndex = lines.findIndex((line) =>
      line.includes('D:\\codex\\project\\demo'),
    );
    expect(brandLineIndex).toBeGreaterThan(0);
    expect(foxLabelLineIndex).toBeGreaterThan(brandLineIndex);
    expect(projectLabelLineIndex).toBeGreaterThan(foxLabelLineIndex);
    expect(projectPathLineIndex).toBeGreaterThan(projectLabelLineIndex);

    const brandLine = lines[brandLineIndex]!;
    const projectPathLine = lines[projectPathLineIndex]!;
    const brandColumn = terminalWidth(
      brandLine.slice(0, brandLine.indexOf('TRIAGENT')),
    );
    const projectColumn = terminalWidth(
      projectPathLine.slice(0, projectPathLine.indexOf('D:\\codex')),
    );
    expect(Math.abs(projectColumn - brandColumn)).toBeLessThanOrEqual(2);
    expect(projectPathLine).toContain('current working directory');

    const foxLine = lines.find((line) => /[█▓▒░]/u.test(line));
    expect(foxLine).toBeDefined();
    if (foxLine === undefined) throw new Error('expected pixel TriFox row');
    const foxColumn = terminalWidth(
      foxLine.slice(0, foxLine.search(/[█▓▒░]/u)),
    );
    expect(foxColumn).toBeGreaterThan(60);

    const promptTopLineIndex = lines.findIndex(
      (line, index) => index > projectPathLineIndex && line.includes('╭'),
    );
    const promptBottomLineIndex = lines.findIndex(
      (line, index) => index > promptTopLineIndex && line.includes('╰'),
    );
    expect(promptTopLineIndex).toBeGreaterThan(projectPathLineIndex);
    expect(promptBottomLineIndex - promptTopLineIndex).toBeGreaterThanOrEqual(7);

    const promptFooterLineIndex = lines.findIndex(
      (line, index) =>
        index > promptTopLineIndex &&
        index < promptBottomLineIndex &&
        line.includes('Enter to start') &&
        line.includes('Ctrl+P plan approval'),
    );
    expect(promptFooterLineIndex).toBeGreaterThan(promptTopLineIndex);
    const promptFooterLine = lines[promptFooterLineIndex]!;
    expect(promptFooterLine.indexOf('Enter to start')).toBeLessThan(
      promptFooterLine.indexOf('Ctrl+P plan approval'),
    );

    const rolesLineIndex = lines.findIndex((line) =>
      line.includes('Master Codex'),
    );
    expect(rolesLineIndex).toBeGreaterThan(promptBottomLineIndex);
    expect(lines[rolesLineIndex]).toContain('Implement Claude');
    expect(lines[rolesLineIndex]).toContain('Review Grok');
    const secondaryShortcutLineIndex = lines.findIndex(
      (line, index) =>
        index > rolesLineIndex &&
        line.includes('Tab') &&
        line.includes('/help') &&
        line.includes('/lang') &&
        line.includes('Ctrl+C'),
    );
    expect(secondaryShortcutLineIndex).toBeGreaterThan(rolesLineIndex);

    expect(text).not.toMatch(/Screen:\s*new_task/i);
    expect(text).not.toMatch(/Workflow:|Layout:|Retry|Log tab:/i);
    unmount();
  });

  it('uses the approved gold accent for the brand and prompt border', () => {
    const tree = StartScreen({ snapshot: startSnapshot() });
    const elements = collectElements(tree);
    const brand = elements.find((element) => {
      const props = element.props as {
        readonly children?: React.ReactNode;
        readonly color?: unknown;
      };
      return props.color !== undefined && elementText(props.children).includes('TRIAGENT');
    });
    const bordered = elements.filter((element) => {
      const props = element.props as { readonly borderStyle?: unknown };
      return props.borderStyle === 'round';
    });
    const prompt = bordered.at(-1);

    expect(brand).toBeDefined();
    expect((brand?.props as { readonly color?: unknown }).color).toBe('#d6a756');
    expect(prompt).toBeDefined();
    expect((prompt?.props as { readonly borderColor?: unknown }).borderColor)
      .toBe('#d6a756');
  });

  it('stacks cleanly in a 60-column Chinese terminal without overflow', () => {
    const { lastFrame, unmount } = render(
      <App
        snapshot={startSnapshot({ uiLanguage: 'zh-CN', columns: 60, rows: 24 })}
        disableWindowSizeSync
      />,
    );
    const text = frameText(lastFrame());
    const lines = visibleLines(lastFrame());

    expect(lines.at(0)?.trim()).toMatch(/^╭─+╮$/u);
    expect(lines.at(-1)?.trim()).toMatch(/^╰─+╯$/u);
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(Math.max(...lines.map(terminalWidth))).toBeLessThanOrEqual(60);
    expect(text).toContain('想让三个 Agent 构建什么？');
    expect(text).toContain('D:\\codex\\project\\demo');
    expect(text).toContain('TRIFOX · IDLE');
    expect(text).toContain('/help');
    expect(text).toContain('/lang');
    expect(text).not.toContain('�');
    expect(text).not.toMatch(/Screen:|Workflow:|Layout:/i);

    const foxIndex = lines.findIndex((line) => line.includes('TRIFOX · IDLE'));
    const projectIndex = lines.findIndex((line) => line.includes('项目'));
    const promptIndex = lines.findIndex((line) =>
      line.includes('想让三个 Agent 构建什么？'),
    );
    expect(foxIndex).toBeGreaterThan(0);
    expect(projectIndex).toBeGreaterThan(foxIndex);
    expect(promptIndex).toBeGreaterThan(projectIndex);
    unmount();
  });

  it('keeps every TriFox state on the approved fixed pixel grid with three tails', () => {
    const states: readonly TriFoxState[] = [
      'idle',
      'thinking',
      'success',
      'error',
    ];
    const stateLabels: Readonly<Record<TriFoxState, string>> = {
      idle: 'IDLE',
      thinking: 'THINKING',
      success: 'SUCCESS',
      error: 'ERROR',
    };

    expect(TRI_FOX_WIDTH).toBe(32);
    expect(TRI_FOX_HEIGHT).toBe(10);

    for (const state of states) {
      const lines = triFoxLines(state);
      expect(lines).toHaveLength(TRI_FOX_HEIGHT);
      expect(lines.every((line) => line.length === TRI_FOX_WIDTH)).toBe(true);
      expect(lines.at(-1)?.trim()).toBe(`TRIFOX · ${stateLabels[state]}`);
      expect(lines.slice(0, -1).filter((line) => /[█▓▒░]/u.test(line)).length)
        .toBeGreaterThanOrEqual(8);
      expect(lines.some((line) => (line.match(/◆/gu)?.length ?? 0) === 3))
        .toBe(true);
      const tailRegion = lines.slice(0, -1).map((line) => line.slice(20));
      expect(tailRegion.filter((line) => /[█▓▒░]/u.test(line)).length)
        .toBeGreaterThanOrEqual(6);
      expect(tailRegion.filter((line) => line.includes('░')).length)
        .toBeGreaterThanOrEqual(3);
      expect(lines.join('\n')).not.toMatch(/[\\/]/u);
    }
  });

  it('localizes the help modal while preserving literal slash commands', () => {
    const { lastFrame, unmount } = render(
      <App
        snapshot={startSnapshot({
          uiLanguage: 'zh-CN',
          modal: 'help',
          focusOwner: 'modal',
        })}
        disableWindowSizeSync
      />,
    );
    const text = frameText(lastFrame());

    expect(text).toContain('操作说明');
    expect(text).toContain('/help');
    expect(text).toContain('/lang');
    expect(text).toContain('Esc');
    expect(text).not.toContain('�');
    unmount();
  });
});
