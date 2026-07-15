import { describe, expect, it } from 'vitest';

import { parseTaskEntry } from '../../../src/tui/slash-commands.js';

describe('task-entry slash commands', () => {
  it('recognizes /help without turning it into a task', () => {
    expect(parseTaskEntry('/help', 'en')).toEqual({
      kind: 'command',
      command: 'help',
    });
  });

  it('toggles /lang from the current UI language', () => {
    expect(parseTaskEntry('  /LANG  ', 'zh-CN')).toEqual({
      kind: 'command',
      command: 'set-language',
      language: 'en',
    });
    expect(parseTaskEntry('/lang', 'en')).toEqual({
      kind: 'command',
      command: 'set-language',
      language: 'zh-CN',
    });
  });

  it('rejects unknown slash commands', () => {
    expect(parseTaskEntry('/unknown', 'en')).toEqual({
      kind: 'error',
      code: 'unknown-command',
    });
    expect(parseTaskEntry('/help now', 'en')).toEqual({
      kind: 'error',
      code: 'unknown-command',
    });
  });

  it('preserves ordinary task text after trimming outer whitespace', () => {
    expect(parseTaskEntry('  fix the tests  ', 'en')).toEqual({
      kind: 'task',
      requirements: 'fix the tests',
    });
  });
});
