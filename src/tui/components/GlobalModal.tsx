import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

import { Redactor } from '../../logging/redact.js';
import { sanitizeTerminal } from '../../logging/sanitize-terminal.js';
import { uiText } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface GlobalModalProps {
  readonly snapshot: TuiSnapshot;
}

/**
 * Shell-level modal/text-entry UI. Must render for every screen whenever
 * snapshot.modal !== 'none' so focusOwner never owns keyboard invisibly.
 */
export function GlobalModal(props: GlobalModalProps): React.ReactElement | null {
  const { snapshot } = props;

  const draftDisplay = useMemo(() => {
    if (snapshot.modal !== 'message_entry') return '';
    const redactor = new Redactor({ secrets: [...snapshot.redactorSecrets] });
    const redacted = redactor.redact(snapshot.messageDraft);
    return sanitizeTerminal(String(redacted.value), {
      maxLineCharacters: snapshot.maxMessageLength + 16,
    }).text;
  }, [
    snapshot.modal,
    snapshot.messageDraft,
    snapshot.redactorSecrets,
    snapshot.maxMessageLength,
  ]);

  if (snapshot.modal === 'none') {
    return null;
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
      {snapshot.modal === 'help' ? (
        <Box flexDirection="column">
          <Text bold>{uiText(snapshot.uiLanguage, 'help.title')}</Text>
          <Text>{uiText(snapshot.uiLanguage, 'help.summary')}</Text>
          <Text>{uiText(snapshot.uiLanguage, 'help.shortcuts')}</Text>
          <Text>{uiText(snapshot.uiLanguage, 'help.controls')}</Text>
          <Text>{uiText(snapshot.uiLanguage, 'help.commands')}</Text>
          <Text dimColor>{uiText(snapshot.uiLanguage, 'help.rawContent')}</Text>
        </Box>
      ) : null}
      {snapshot.modal === 'control_menu' ? (
        <Box flexDirection="column">
          <Text bold>{uiText(snapshot.uiLanguage, 'modal.controlTitle')}</Text>
          <Text>{uiText(snapshot.uiLanguage, 'modal.controlBody')}</Text>
        </Box>
      ) : null}
      {snapshot.modal === 'termination_confirm' ? (
        <Box flexDirection="column">
          <Text bold>{uiText(snapshot.uiLanguage, 'modal.terminationTitle')}</Text>
          <Text>{uiText(snapshot.uiLanguage, 'modal.terminationBody')}</Text>
        </Box>
      ) : null}
      {snapshot.modal === 'pause_menu' ? (
        <Box flexDirection="column">
          <Text bold>{uiText(snapshot.uiLanguage, 'modal.pauseTitle')}</Text>
          <Text>{uiText(snapshot.uiLanguage, 'modal.pauseBody')}</Text>
        </Box>
      ) : null}
      {snapshot.modal === 'cancel_confirm' ? (
        <Box flexDirection="column">
          <Text bold>{uiText(snapshot.uiLanguage, 'modal.cancelTitle')}</Text>
          <Text>{uiText(snapshot.uiLanguage, 'modal.cancelBody')}</Text>
        </Box>
      ) : null}
      {snapshot.modal === 'message_entry' ? (
        <Box flexDirection="column">
          <Text bold>{uiText(snapshot.uiLanguage, 'modal.messageTitle')}</Text>
          <Text>
            {uiText(snapshot.uiLanguage, 'modal.draft')}: {draftDisplay}
            {snapshot.messageDraft.length >= snapshot.maxMessageLength
              ? ' [max]'
              : ''}
          </Text>
          <Text dimColor>
            {uiText(snapshot.uiLanguage, 'modal.messageHint')} · max{' '}
            {snapshot.maxMessageLength}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
