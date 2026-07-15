import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

import { Redactor } from '../../logging/redact.js';
import { sanitizeTerminal } from '../../logging/sanitize-terminal.js';
import { uiText } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface DiffScreenProps {
  readonly snapshot: TuiSnapshot;
}

export function DiffScreen(props: DiffScreenProps): React.ReactElement {
  const { snapshot } = props;
  // Diff content is supplied via system log bucket for this shell; Task 21
  // will feed real DiffService snapshots through the controller port.
  const lines = useMemo(() => {
    const redactor = new Redactor({ secrets: [...snapshot.redactorSecrets] });
    return snapshot.logs.system.slice(0, snapshot.maxLogLines).map((line) => {
      const redacted = redactor.redact(line);
      return sanitizeTerminal(String(redacted.value), {
        maxLineCharacters: snapshot.maxLogLineCharacters,
      }).text;
    });
  }, [snapshot]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">{uiText(snapshot.uiLanguage, 'diff.title')}</Text>
      <Text dimColor>{uiText(snapshot.uiLanguage, 'common.state')}: {snapshot.workflowState}</Text>
      {snapshot.loading ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'diff.loading')}</Text>
      ) : null}
      {snapshot.error !== undefined ? (
        <Text color="red">{uiText(snapshot.uiLanguage, 'common.error')}: {snapshot.error}</Text>
      ) : null}
      {!snapshot.loading && lines.length === 0 ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'diff.empty')}</Text>
      ) : null}
      {lines.map((line, index) => (
        <Text key={`diff-${index}`}>{line}</Text>
      ))}
    </Box>
  );
}
