import { describe, expect, it } from 'vitest';

import { parseGrokEventLine } from '../../../src/agents/grok/grok-events.js';
import { asAttemptId } from '../../../src/domain/ids.js';
import { Redactor } from '../../../src/logging/redact.js';

const ATTEMPT = asAttemptId('attempt-grok-redact-1');
/** Configured non-pattern secret — only survives if Redactor is applied. */
const CONFIGURED_SECRET = 'configured-non-pattern-secret-value-xyz';
const PATTERN_SECRET = 'sk-live-super-secret-token-value-xyz';
const BEARER = 'Bearer sk-live-another-secret-token-abcdef';

function configuredRedactor(): Redactor {
  return new Redactor({ secrets: [CONFIGURED_SECRET] });
}

function expectNoSecrets(serialized: string): void {
  expect(serialized).not.toContain(CONFIGURED_SECRET);
  expect(serialized).not.toContain(PATTERN_SECRET);
  expect(serialized).not.toMatch(/sk-live-super-secret/i);
  expect(serialized).not.toMatch(/Bearer\s+sk-live-another/i);
}

describe('Grok ParseGrokEventOptions.redactor on every parser path', () => {
  it.each([
    {
      branch: 'invalid-line parse_error',
      line: `not-json Authorization: ${BEARER} api_key=${PATTERN_SECRET} leak=${CONFIGURED_SECRET}`,
      expectType: 'parse_error' as const,
    },
    {
      branch: 'non-object parse_error',
      line: JSON.stringify([`leak=${CONFIGURED_SECRET}`, PATTERN_SECRET]),
      expectType: 'parse_error' as const,
    },
    {
      branch: 'result string output',
      line: JSON.stringify({
        type: 'result',
        result: `plain text with ${CONFIGURED_SECRET} and ${PATTERN_SECRET}`,
      }),
      expectType: 'output' as const,
    },
    {
      branch: 'assistant message text',
      line: JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `assistant body ${CONFIGURED_SECRET} ${PATTERN_SECRET}`,
            },
          ],
        },
      }),
      expectType: 'output' as const,
    },
    {
      branch: 'content_block_delta text',
      line: JSON.stringify({
        type: 'content_block_delta',
        delta: {
          type: 'text_delta',
          text: `delta ${CONFIGURED_SECRET} ${BEARER}`,
        },
      }),
      expectType: 'output' as const,
    },
    {
      branch: 'delta partial_json',
      line: JSON.stringify({
        type: 'content_block_delta',
        delta: {
          type: 'input_json_delta',
          partial_json: `{"token":"${CONFIGURED_SECRET}","k":"${PATTERN_SECRET}"}`,
        },
      }),
      expectType: 'output' as const,
    },
    {
      branch: 'assistant without extractable text (safeJson raw)',
      line: JSON.stringify({
        type: 'assistant',
        authorization: BEARER,
        payload: {
          apiKey: PATTERN_SECRET,
          note: CONFIGURED_SECRET,
        },
      }),
      expectType: 'output' as const,
    },
    {
      branch: 'known system lifecycle raw',
      line: JSON.stringify({
        type: 'system',
        subtype: 'init',
        authorization: BEARER,
        secret: CONFIGURED_SECRET,
        api_key: PATTERN_SECRET,
      }),
      expectType: 'output' as const,
    },
    {
      branch: 'unknown raw event',
      line: JSON.stringify({
        type: 'unknown.secret_event',
        authorization: BEARER,
        payload: {
          apiKey: PATTERN_SECRET,
          note: `token=${CONFIGURED_SECRET}`,
        },
      }),
      expectType: 'output' as const,
    },
    {
      branch: 'result missing structured payload parse_error',
      line: JSON.stringify({
        type: 'result',
        // no structured output — becomes parse_error; raw line must redact
        message: `leak ${CONFIGURED_SECRET} ${PATTERN_SECRET}`,
      }),
      expectType: 'parse_error' as const,
    },
  ])(
    'redacts configured + pattern secrets on branch: $branch',
    ({ line, expectType }) => {
      const event = parseGrokEventLine(line, ATTEMPT, {
        redactor: configuredRedactor(),
      });
      expect(event).not.toBeNull();
      expect(event?.type).toBe(expectType);

      const serialized = JSON.stringify(event);
      expectNoSecrets(serialized);

      if (event?.type === 'parse_error') {
        expect(event.raw).not.toContain(CONFIGURED_SECRET);
        expect(event.error).not.toContain(CONFIGURED_SECRET);
        expect(event.raw.length).toBeLessThanOrEqual(512);
        expect(event.error.length).toBeLessThanOrEqual(256);
        // Bounded, no cause/raw Error objects on the event.
        expect(event).not.toHaveProperty('cause');
        expect(Object.keys(event).sort()).toEqual(
          ['attemptId', 'error', 'raw', 'type'].sort(),
        );
      }
      if (event?.type === 'output') {
        expect(event.text).not.toContain(CONFIGURED_SECRET);
        expect(event.text.length).toBeLessThanOrEqual(64 * 1024);
      }
    },
  );

  it('default redactor still strips pattern secrets when options.redactor omitted', () => {
    const line = JSON.stringify({
      type: 'unknown.event',
      authorization: BEARER,
      token: PATTERN_SECRET,
    });
    const event = parseGrokEventLine(line, ATTEMPT);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(PATTERN_SECRET);
    expect(serialized).not.toMatch(/Bearer\s+sk-live-another/i);
  });
});
