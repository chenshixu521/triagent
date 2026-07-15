import React from 'react';
import { Box, Text } from 'ink';

import { TriFox, TRI_FOX_WIDTH, type TriFoxState } from '../components/TriFox.js';
import { uiText } from '../i18n.js';
import {
  DEFAULT_ROLE_ASSIGNMENT,
  formatAgentKind,
  isNarrowLayout,
  type TuiSnapshot,
} from '../store.js';

export interface StartScreenProps {
  readonly snapshot: TuiSnapshot;
}

export const START_SCREEN_ACCENT = '#d6a756';

const START_SCREEN_FRAME_MAX_WIDTH = 116;
const WIDE_PROMPT_HEIGHT = 9;
const NARROW_PROMPT_HEIGHT = 6;

function triFoxState(snapshot: TuiSnapshot): TriFoxState {
  if (snapshot.error !== undefined) return 'error';
  if (snapshot.loading || snapshot.processRunning) return 'thinking';
  if (snapshot.workflowState === 'completed') return 'success';
  return 'idle';
}

export function StartScreen(props: StartScreenProps): React.ReactElement {
  const { snapshot } = props;
  const language = snapshot.uiLanguage;
  const roles = snapshot.roles ?? DEFAULT_ROLE_ASSIGNMENT;
  const narrow = isNarrowLayout(snapshot);
  const viewportWidth = snapshot.columns > 0 ? snapshot.columns : 80;
  const horizontalGutter = viewportWidth >= 40 ? (narrow ? 2 : 4) : 0;
  const frameWidth = Math.max(
    1,
    Math.min(
      START_SCREEN_FRAME_MAX_WIDTH,
      viewportWidth - horizontalGutter,
    ),
  );
  const showFox = frameWidth >= TRI_FOX_WIDTH + 4;
  const projectPath = snapshot.projectPath
    ?? uiText(language, 'start.unknownProject');
  const planApproval = snapshot.requiresPlanApprovalDraft
    ? uiText(language, 'start.required')
    : uiText(language, 'start.automatic');
  const state = triFoxState(snapshot);

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      paddingTop={narrow ? 0 : 1}
      width={viewportWidth}
    >
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="#363636"
        paddingX={narrow ? 1 : 2}
        paddingY={narrow ? 0 : 1}
        width={frameWidth}
      >
        <Box
          flexDirection={narrow ? 'column' : 'row'}
          alignItems={narrow ? 'center' : 'flex-start'}
          justifyContent={narrow ? undefined : 'space-between'}
          width="100%"
        >
          <Box
            flexDirection="column"
            alignSelf={narrow ? 'flex-start' : undefined}
          >
            <Text bold color={START_SCREEN_ACCENT}>TRIAGENT</Text>
            {!narrow ? (
              <Text dimColor>{uiText(language, 'start.tagline')}</Text>
            ) : null}
          </Box>
          {showFox ? <TriFox state={state} /> : null}
        </Box>

        <Box
          flexDirection="column"
          marginTop={narrow ? 0 : 1}
          width="100%"
        >
          <Text dimColor>{uiText(language, 'start.currentProject')}</Text>
          <Text>
            {projectPath}
            <Text color="gray">  {uiText(language, 'start.cwd')}</Text>
          </Text>
        </Box>

        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={START_SCREEN_ACCENT}
          height={narrow ? NARROW_PROMPT_HEIGHT : WIDE_PROMPT_HEIGHT}
          marginTop={narrow ? 0 : 1}
          paddingX={narrow ? 1 : 2}
          paddingY={narrow ? 0 : 1}
          width="100%"
        >
          <Text dimColor>{uiText(language, 'start.prompt')}</Text>
          <Box flexGrow={1} flexDirection="column" justifyContent="center">
            <Text wrap="truncate-end">
              <Text bold color={START_SCREEN_ACCENT}>&gt;</Text>{' '}
              {snapshot.requirementsDraft.length > 0 ? (
                snapshot.requirementsDraft
              ) : (
                <Text dimColor>{uiText(language, 'start.placeholder')}</Text>
              )}
              <Text color={START_SCREEN_ACCENT}>_</Text>
            </Text>
          </Box>
          <Box flexDirection="row" justifyContent="space-between" width="100%">
            <Text dimColor>{uiText(language, 'start.submit')}</Text>
            <Text dimColor>
              {uiText(language, 'start.planApprovalShortcut')} · {planApproval}
            </Text>
          </Box>
        </Box>

        <Box marginTop={narrow ? 0 : 1} width="100%">
          <Text dimColor>
            <Text bold>{uiText(language, 'start.master')}</Text>{' '}
            {formatAgentKind(roles.master)}  ·  {' '}
            <Text bold>{uiText(language, 'start.roleImplement')}</Text>{' '}
            {formatAgentKind(roles.implementer)}  ·  {' '}
            <Text bold>{uiText(language, 'start.roleReview')}</Text>{' '}
            {formatAgentKind(roles.reviewer)}
          </Text>
        </Box>

        <Box marginTop={narrow ? 0 : 1} width="100%">
          <Text color="gray">
            {uiText(
              language,
              narrow
                ? 'start.secondaryShortcutsCompact'
                : 'start.secondaryShortcuts',
            )}
          </Text>
        </Box>

        {snapshot.error !== undefined ? (
          <Text color="red">{snapshot.error}</Text>
        ) : snapshot.statusMessage !== undefined ? (
          <Text dimColor>{snapshot.statusMessage}</Text>
        ) : null}
      </Box>
    </Box>
  );
}
