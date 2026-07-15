import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

import { Redactor } from '../../logging/redact.js';
import { sanitizeTerminal } from '../../logging/sanitize-terminal.js';
import { uiText } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface ReviewScreenProps {
  readonly snapshot: TuiSnapshot;
}

export function ReviewScreen(props: ReviewScreenProps): React.ReactElement {
  const { snapshot } = props;
  const lines = useMemo(() => {
    const redactor = new Redactor({ secrets: [...snapshot.redactorSecrets] });
    return snapshot.logs.reviewer.slice(0, snapshot.maxLogLines).map((line) => {
      const redacted = redactor.redact(line);
      return sanitizeTerminal(String(redacted.value), {
        maxLineCharacters: snapshot.maxLogLineCharacters,
      }).text;
    });
  }, [snapshot]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">{uiText(snapshot.uiLanguage, 'review.title')}</Text>
      <Text dimColor>{uiText(snapshot.uiLanguage, 'common.state')}: {snapshot.workflowState}</Text>
      <Text>
        {uiText(snapshot.uiLanguage, 'common.rework')}: {' '}
        {snapshot.canRework
          ? `${uiText(snapshot.uiLanguage, 'common.available')} (R)`
          : uiText(snapshot.uiLanguage, 'common.notLegal')}{' '}
        · {uiText(snapshot.uiLanguage, 'approval.approve')}: {' '}
        {snapshot.canApprove
          ? `${uiText(snapshot.uiLanguage, 'common.available')} (A)`
          : uiText(snapshot.uiLanguage, 'common.notLegal')}
      </Text>
      {snapshot.loading ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'review.loading')}</Text>
      ) : null}
      {snapshot.error !== undefined ? (
        <Text color="red">{uiText(snapshot.uiLanguage, 'common.error')}: {snapshot.error}</Text>
      ) : null}
      {!snapshot.loading && lines.length === 0 ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'review.empty')}</Text>
      ) : null}
      {lines.map((line, index) => (
        <Text key={`review-${index}`}>{line}</Text>
      ))}
    </Box>
  );
}
