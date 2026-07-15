import { describe, expect, it } from 'vitest';

import {
  parseCodexEventLine,
} from '../../../src/agents/codex/codex-events.js';
import { asAttemptId } from '../../../src/domain/ids.js';

const ATTEMPT = asAttemptId('attempt-redact-unknown-1');
const SECRET = 'sk-live-super-secret-token-value-xyz';
const BEARER = 'Bearer sk-live-another-secret-token-abcdef';

describe('Codex unknown / raw event redaction', () => {
  it('redacts secret-bearing unknown JSON before AgentEvent serialization', () => {
    const line = JSON.stringify({
      type: 'unknown.secret_event',
      authorization: BEARER,
      payload: {
        apiKey: SECRET,
        note: `token=${SECRET}`,
      },
    });
    const event = parseCodexEventLine(line, ATTEMPT);
    expect(event).not.toBeNull();
    expect(event?.type).toBe('output');
    if (event?.type !== 'output') return;

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toMatch(/sk-live-super-secret/i);
    expect(serialized).not.toMatch(/Bearer\s+sk-live-another/i);
    expect(event.text).toMatch(/unknown\.secret_event|REDACTED|\[REDACTED\]/i);
    // Bounded redacted raw retained
    expect(event.text.length).toBeGreaterThan(0);
    expect(event.text.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('redacts secrets in parse_error raw/error via Redactor + terminal sanitizer', () => {
    const line = `not-json Authorization: ${BEARER} api_key=${SECRET}`;
    const event = parseCodexEventLine(line, ATTEMPT);
    expect(event?.type).toBe('parse_error');
    if (event?.type !== 'parse_error') return;

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toMatch(/sk-live-super-secret/i);
    expect(event.raw).not.toMatch(/sk-live-super-secret/i);
    expect(event.error).not.toMatch(/sk-live-super-secret/i);
    expect(event.raw.length).toBeLessThanOrEqual(512);
    expect(event.error.length).toBeLessThanOrEqual(256);
  });
});
