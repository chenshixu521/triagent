import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

import { Redactor } from '../../logging/redact.js';
import { sanitizeTerminal } from '../../logging/sanitize-terminal.js';
import { uiText } from '../i18n.js';
import type { LogTab, TuiSnapshot } from '../store.js';

export interface LogPanelProps {
  readonly snapshot: TuiSnapshot;
  readonly tab?: LogTab;
}

function prepareLogLines(
  lines: readonly string[],
  secrets: readonly string[],
  maxLineCharacters: number,
  maxLogLines: number,
): readonly string[] {
  const redactor = new Redactor({ secrets: [...secrets] });
  const prepared: string[] = [];
  const source = lines.slice(-maxLogLines);
  for (const line of source) {
    const redacted = redactor.redact(line);
    const sanitized = sanitizeTerminal(String(redacted.value), {
      maxLineCharacters,
      maxChunkCharacters: maxLineCharacters * 4,
    });
    prepared.push(sanitized.text);
  }
  return prepared;
}

export function LogPanel(props: LogPanelProps): React.ReactElement {
  const tab = props.tab ?? props.snapshot.activeLogTab;
  const { snapshot } = props;

  const lines = useMemo(
    () =>
      prepareLogLines(
        snapshot.logs[tab],
        snapshot.redactorSecrets,
        snapshot.maxLogLineCharacters,
        snapshot.maxLogLines,
      ),
    [
      snapshot.logs,
      tab,
      snapshot.redactorSecrets,
      snapshot.maxLogLineCharacters,
      snapshot.maxLogLines,
    ],
  );

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
      <Text bold>
        {uiText(snapshot.uiLanguage, 'logs.title')} ·{' '}
        {uiText(snapshot.uiLanguage, 'logs.tab')}: {tab}
      </Text>
      {snapshot.loading ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'common.loading')}</Text>
      ) : null}
      {!snapshot.loading && lines.length === 0 ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'logs.empty')}</Text>
      ) : null}
      {lines.map((line, index) => (
        <Text key={`${tab}-${index}`}>{line}</Text>
      ))}
    </Box>
  );
}
