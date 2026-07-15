import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

import { Redactor } from '../../logging/redact.js';
import { sanitizeTerminal } from '../../logging/sanitize-terminal.js';
import { uiText } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface ActivityFeedProps {
  readonly snapshot: TuiSnapshot;
}

type DesignTag = 'system' | 'stage' | 'tool' | 'master' | 'impl' | 'review';

const TAG_COLOR: Readonly<Record<DesignTag, string>> = {
  system: 'gray',
  stage: 'gray',
  tool: 'blue',
  master: 'cyan',
  impl: 'yellow',
  review: 'magenta',
};

interface ParsedActivity {
  readonly key: string;
  readonly clock?: string;
  readonly tag: DesignTag;
  readonly body: string;
}

function prepareText(
  line: string,
  secrets: readonly string[],
  maxLineCharacters: number,
): string {
  const redactor = new Redactor({ secrets: [...secrets] });
  const redacted = redactor.redact(line);
  return sanitizeTerminal(String(redacted.value), {
    maxLineCharacters,
    maxChunkCharacters: maxLineCharacters * 4,
  }).text;
}

function parseDesignLine(raw: string, index: number): ParsedActivity {
  // Design: `HH:MM:SS  [tag] text`
  const match = raw.match(
    /^(\d{2}:\d{2}:\d{2})\s+\[(system|stage|tool|master|impl|review)\]\s*(.*)$/i,
  );
  if (match !== null) {
    const tag = match[2]!.toLowerCase() as DesignTag;
    return {
      key: `a-${index}`,
      clock: match[1],
      tag,
      body: match[3] ?? '',
    };
  }
  return {
    key: `a-${index}`,
    tag: 'system',
    body: raw,
  };
}

function collectLines(snapshot: TuiSnapshot): readonly string[] {
  if (snapshot.activityLines.length > 0) {
    return snapshot.activityLines.slice(-snapshot.maxLogLines);
  }
  // Fallback: role buckets (older snapshots / tests)
  return [
    ...snapshot.logs.system,
    ...snapshot.logs.master,
    ...snapshot.logs.implementer,
    ...snapshot.logs.reviewer,
  ].slice(-snapshot.maxLogLines);
}

/**
 * Work-status activity transcript — strictly matches design:
 * docs/design/work-status-v2.html (工作动态 panel).
 */
export function ActivityFeed(props: ActivityFeedProps): React.ReactElement {
  const { snapshot } = props;
  const working = snapshot.loading || snapshot.processRunning;
  const terminalDone =
    snapshot.workflowState === 'completed'
    || snapshot.workflowState === 'cancelled'
    || snapshot.workflowState === 'failed';

  const items = useMemo(() => {
    const lines = collectLines(snapshot);
    return lines.map((raw, index) => {
      const prepared = prepareText(
        raw,
        snapshot.redactorSecrets,
        snapshot.maxLogLineCharacters,
      );
      return parseDesignLine(prepared, index);
    });
  }, [snapshot]);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text bold>{uiText(snapshot.uiLanguage, 'activity.title')}</Text>
        {working ? (
          <Text color="yellow">
            ● {uiText(snapshot.uiLanguage, 'activity.working')}
          </Text>
        ) : terminalDone ? (
          <Text color="green">{uiText(snapshot.uiLanguage, 'activity.idle')}</Text>
        ) : (
          <Text dimColor>{uiText(snapshot.uiLanguage, 'activity.idle')}</Text>
        )}
      </Box>

      {snapshot.statusMessage !== undefined ? (
        <Text color="cyan">→ {snapshot.statusMessage}</Text>
      ) : null}

      {items.length === 0 ? (
        <Text dimColor>
          {working
            ? uiText(snapshot.uiLanguage, 'activity.waiting')
            : uiText(snapshot.uiLanguage, 'activity.empty')}
        </Text>
      ) : (
        items.map((item) => (
          <Text key={item.key}>
            {item.clock !== undefined ? (
              <Text dimColor>{item.clock}  </Text>
            ) : null}
            <Text color={TAG_COLOR[item.tag]}>[{item.tag}]</Text>
            {' '}
            {item.body}
          </Text>
        ))
      )}

      {terminalDone ? (
        <Text dimColor>
          {uiText(snapshot.uiLanguage, 'activity.exitHint')}
        </Text>
      ) : null}
    </Box>
  );
}
