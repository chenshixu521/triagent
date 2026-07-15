import { describe, expect, it } from 'vitest';

import { resolveUiLanguage, uiText } from '../../../src/tui/i18n.js';

describe('TUI i18n', () => {
  it('resolves auto from the system locale and preserves explicit choices', () => {
    expect(resolveUiLanguage('auto', 'zh-CN')).toBe('zh-CN');
    expect(resolveUiLanguage('auto', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveUiLanguage('auto', 'en-US')).toBe('en');
    expect(resolveUiLanguage('auto', 'ja-JP')).toBe('en');
    expect(resolveUiLanguage('en', 'zh-CN')).toBe('en');
    expect(resolveUiLanguage('zh-CN', 'en-US')).toBe('zh-CN');
  });

  it('returns typed Chinese and English text for the same key', () => {
    expect(uiText('zh-CN', 'start.placeholder')).toContain('任务');
    expect(uiText('en', 'start.placeholder').toLowerCase()).toContain('task');
    expect(uiText('zh-CN', 'commands.unknown')).toContain('/help');
    expect(uiText('en', 'commands.unknown')).toContain('/help');
  });
});
