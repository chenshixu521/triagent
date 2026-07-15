import type { UiLanguage } from './i18n.js';

export type TaskEntryParseResult =
  | { readonly kind: 'task'; readonly requirements: string }
  | { readonly kind: 'command'; readonly command: 'help' }
  | {
      readonly kind: 'command';
      readonly command: 'set-language';
      readonly language: UiLanguage;
    }
  | { readonly kind: 'error'; readonly code: 'unknown-command' };

export function parseTaskEntry(
  input: string,
  currentLanguage: UiLanguage,
): TaskEntryParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'task', requirements: trimmed };
  }

  switch (trimmed.toLowerCase()) {
    case '/help':
      return { kind: 'command', command: 'help' };
    case '/lang':
      return {
        kind: 'command',
        command: 'set-language',
        language: currentLanguage === 'zh-CN' ? 'en' : 'zh-CN',
      };
    default:
      return { kind: 'error', code: 'unknown-command' };
  }
}
