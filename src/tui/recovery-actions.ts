import { uiText, type UiLanguage, type UiTextKey } from './i18n.js';
import type { TuiRecoveryAction } from './store.js';

const ACTION_TEXT_KEYS: Readonly<Record<TuiRecoveryAction, UiTextKey>> = {
  inspect: 'recovery.inspectShortcut',
  continue: 'recovery.continueShortcut',
  cancel: 'recovery.cancelShortcut',
};

export function recoveryActionHint(
  language: UiLanguage,
  actions: readonly TuiRecoveryAction[],
): string {
  if (actions.length === 0) {
    return uiText(language, 'recovery.noActions');
  }
  return actions
    .map((action) => uiText(language, ACTION_TEXT_KEYS[action]))
    .join(' · ');
}
