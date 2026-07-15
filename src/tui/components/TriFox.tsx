import React from 'react';
import { Box, Text } from 'ink';

export type TriFoxState = 'idle' | 'thinking' | 'success' | 'error';

export const TRI_FOX_WIDTH = 32;

const TRI_FOX_GOLD = '#d6a756';

const STATE_FACE: Readonly<Record<TriFoxState, {
  readonly eyes: string;
  readonly label: string;
  readonly color: string;
}>> = {
  idle: { eyes: '●', label: 'IDLE', color: TRI_FOX_GOLD },
  thinking: { eyes: '━', label: 'THINKING', color: '#e3b75f' },
  success: { eyes: '^', label: 'SUCCESS', color: '#7ee787' },
  error: { eyes: '×', label: 'ERROR', color: '#ff6b6b' },
};

/**
 * Terminal-scale raster of the approved 168x128 SVG mascot. The palette
 * tokens preserve the original ears, face, body, three fanned tails, and the
 * three agent collar lights without depending on font-sensitive line art.
 */
const PIXEL_TOKEN_ROWS = Object.freeze([
  '       ███      ███              ',
  '      ███▓▓     ▓▓███           ',
  '      ███████████████           ',
  '     ▒▒██EE██████EE█▒▒     ░░░  ',
  '     ▒▒████░░NN░░███▒▒  █████   ',
  '      ██▒▒▒▒▒▒▒▒▒▒▒██      ▓▓▓▓',
  '          ▒▒1▒2▒3▒▒  ▓▓▓▓▓▓▓▓   ',
  '        ███▒▒▒▒▒▒███▓▓▓▓▓▓   ░  ',
  '                           ░░   ',
]);

export const TRI_FOX_HEIGHT = PIXEL_TOKEN_ROWS.length + 1;

function fixedWidth(line: string): string {
  return line.slice(0, TRI_FOX_WIDTH).padEnd(TRI_FOX_WIDTH, ' ');
}

function centeredLabel(state: TriFoxState): string {
  const label = `TRIFOX · ${STATE_FACE[state].label}`;
  const leftPadding = Math.max(
    0,
    Math.floor((TRI_FOX_WIDTH - label.length) / 2),
  );
  return fixedWidth(`${' '.repeat(leftPadding)}${label}`);
}

function displayGlyph(token: string, state: TriFoxState): string {
  if (token === 'E') return STATE_FACE[state].eyes;
  if (token === 'N' || token === '1' || token === '2' || token === '3') {
    return '◆';
  }
  return token;
}

function tokenColor(token: string, state: TriFoxState): string | undefined {
  switch (token) {
    case '█':
      return TRI_FOX_GOLD;
    case '▓':
      return '#7a582d';
    case '▒':
      return '#b78342';
    case '░':
      return '#f2d59b';
    case 'E':
      return STATE_FACE[state].color;
    case 'N':
      return '#4b4339';
    case '1':
      return '#58a6ff';
    case '2':
      return '#7ee787';
    case '3':
      return '#c297ff';
    default:
      return undefined;
  }
}

function tokenRows(): readonly string[] {
  return PIXEL_TOKEN_ROWS.map(fixedWidth);
}

export function triFoxLines(state: TriFoxState): readonly string[] {
  return Object.freeze([
    ...tokenRows().map((row) =>
      Array.from(row, (token) => displayGlyph(token, state)).join(''),
    ),
    centeredLabel(state),
  ]);
}

export function TriFox(props: {
  readonly state: TriFoxState;
}): React.ReactElement {
  const rows = tokenRows();
  return (
    <Box flexDirection="column" width={TRI_FOX_WIDTH}>
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex}>
          {Array.from(row, (token, columnIndex) => (
            <Text
              key={columnIndex}
              color={tokenColor(token, props.state)}
            >
              {displayGlyph(token, props.state)}
            </Text>
          ))}
        </Text>
      ))}
      <Text color={STATE_FACE[props.state].color}>
        {centeredLabel(props.state)}
      </Text>
    </Box>
  );
}
