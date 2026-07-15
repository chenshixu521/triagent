import React from 'react';
import { Box, Text } from 'ink';

import { uiText } from '../i18n.js';
import type { TuiSnapshot } from '../store.js';

export interface ProjectScreenProps {
  readonly snapshot: TuiSnapshot;
}

export function ProjectScreen(props: ProjectScreenProps): React.ReactElement {
  const { snapshot } = props;
  const pathDraft = snapshot.projectPathDraft || snapshot.projectPath || '';
  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1}>
      <Text bold color="cyan">{uiText(snapshot.uiLanguage, 'project.title')}</Text>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
        {pathDraft.length > 0 ? (
          <Text>{uiText(snapshot.uiLanguage, 'project.path')}: {pathDraft}</Text>
        ) : (
          <Text dimColor>{uiText(snapshot.uiLanguage, 'project.placeholder')}</Text>
        )}
      </Box>
      <Text dimColor>{uiText(snapshot.uiLanguage, 'project.hint')}</Text>
      {snapshot.loading ? (
        <Text dimColor>{uiText(snapshot.uiLanguage, 'common.loading')}</Text>
      ) : null}
      {snapshot.error !== undefined ? (
        <Text color="red">
          {uiText(snapshot.uiLanguage, 'common.error')}: {snapshot.error}
        </Text>
      ) : null}
    </Box>
  );
}
