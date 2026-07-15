import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

import { Redactor } from '../../logging/redact.js';
import { sanitizeTerminal } from '../../logging/sanitize-terminal.js';
import { uiText } from '../i18n.js';
import { recoveryActionHint } from '../recovery-actions.js';
import type { TuiSnapshot } from '../store.js';

export interface RecoveryScreenProps {
  readonly snapshot: TuiSnapshot;
}

function prepareEvidenceLines(
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
    // Strip raw shell invocation patterns that must never surface in recovery UI.
    const scrubbed = sanitized.text
      .replace(/\bcmd\.exe\b/gi, '[cmd]')
      .replace(/\bpowershell\.exe\s+-Command\b/gi, '[powershell]');
    prepared.push(scrubbed);
  }
  return prepared;
}

/**
 * Recovery / diagnostic screen. Renders bounded redacted evidence and clear
 * allowed actions. Actions are typed intents dispatched via the store;
 * legality is enforced by AppContext, not this UI.
 */
export function RecoveryScreen(props: RecoveryScreenProps): React.ReactElement {
  const { snapshot } = props;
  const evidence = useMemo(
    () =>
      prepareEvidenceLines(
        snapshot.logs.system,
        snapshot.redactorSecrets,
        snapshot.maxLogLineCharacters,
        snapshot.maxLogLines,
      ),
    [
      snapshot.logs.system,
      snapshot.redactorSecrets,
      snapshot.maxLogLineCharacters,
      snapshot.maxLogLines,
    ],
  );

  const isDiagnostic =
    snapshot.error !== undefined
    && /diagnostic|database|unreadable|incompatible/i.test(snapshot.error);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="red">
        {uiText(snapshot.uiLanguage, 'recovery.title')}
      </Text>
      {snapshot.taskId !== undefined ? (
        <Text>{uiText(snapshot.uiLanguage, 'common.task')}: {snapshot.taskId}</Text>
      ) : (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'recovery.noTask')}</Text>
      )}
      <Text>{uiText(snapshot.uiLanguage, 'common.state')}: {snapshot.workflowState}</Text>
      {snapshot.error !== undefined ? (
        <Text color="red">
          {uiText(snapshot.uiLanguage, 'common.error')}: {snapshot.error}
        </Text>
      ) : null}
      {isDiagnostic ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'recovery.diagnostic')}</Text>
      ) : (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'recovery.operator')}</Text>
      )}
      <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
        <Text bold>{uiText(snapshot.uiLanguage, 'recovery.evidence')}</Text>
        {evidence.length === 0 ? (
          <Text dimColor>{uiText(snapshot.uiLanguage, 'recovery.noEvidence')}</Text>
        ) : (
          evidence.map((line, index) => (
            <Text key={`recovery-evidence-${index}`}>{line}</Text>
          ))
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{uiText(snapshot.uiLanguage, 'recovery.actions')}</Text>
        <Text dimColor>
          {recoveryActionHint(
            snapshot.uiLanguage,
            snapshot.recoveryAllowedActions,
          )}
        </Text>
      </Box>
    </Box>
  );
}
