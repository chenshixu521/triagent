import { describe, expect, it } from 'vitest';

import { Redactor } from '../../../src/logging/redact.js';
import {
  NON_DROPPABLE_DISPLAY_EVENT_TYPES,
  TerminalDisplayRateLimiter,
  safeDisplayJson,
  sanitizeTerminal,
} from '../../../src/logging/sanitize-terminal.js';

describe('terminal output safety', () => {
  it('removes ANSI, cursor controls, OSC title, hyperlink, and clipboard sequences', () => {
    const unsafe = [
      '\u001b[31mred\u001b[0m',
      '\u001b[2J\u001b[Hvisible',
      '\u001b]0;owned title\u0007title-safe',
      '\u001b]8;;https://example.invalid\u001b\\link\u001b]8;;\u001b\\',
      '\u001b]52;c;Y2xpcGJvYXJk\u0007clipboard-safe',
      '\u009d0;c1-title\u009ctail',
    ].join('\n');

    const result = sanitizeTerminal(unsafe);

    expect(result.text).toContain('red');
    expect(result.text).toContain('visible');
    expect(result.text).toContain('title-safe');
    expect(result.text).toContain('link');
    expect(result.text).toContain('clipboard-safe');
    expect(result.text).toContain('tail');
    expect(result.text).not.toMatch(/[\u001b\u009b\u009d\u009c\u0007]/u);
    expect(result.text).not.toContain('owned title');
    expect(result.text).not.toContain('Y2xpcGJvYXJk');
    expect(result.truncated).toBe(false);
  });

  it('normalizes CRLF and removes NUL, unsafe C0, and C1 controls while preserving tabs and newlines', () => {
    const result = sanitizeTerminal(
      'a\r\nb\rc\u0000\u0001\u0008\tkept\n\u0080\u0085done',
    );

    expect(result.text).toBe('a\nb\nc\tkept\ndone');
    expect(result.truncated).toBe(false);
  });

  it('bounds long lines and total chunks with explicit safe truncation markers', () => {
    const result = sanitizeTerminal(
      `${'x'.repeat(200)}\n${'y'.repeat(200)}`,
      { maxLineCharacters: 48, maxChunkCharacters: 80 },
    );

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(80);
    expect(result.text).toContain('[truncated]');
  });

  it('handles a two-megabyte line without returning an unbounded display value', () => {
    const result = sanitizeTerminal('z'.repeat(2 * 1024 * 1024), {
      maxLineCharacters: 2_048,
      maxChunkCharacters: 4_096,
    });

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(4_096);
    expect(result.text).toContain('[truncated]');
  });
});

describe('redaction', () => {
  it('recursively redacts explicit and whitelisted environment secrets before serialization', () => {
    const redactor = new Redactor({
      secrets: ['known-secret-value'],
      environmentVariableNames: ['TRIAGENT_TEST_SECRET'],
      environment: { TRIAGENT_TEST_SECRET: 'environment-secret-value' },
    });

    const result = redactor.redact({
      nested: ['known-secret-value', { value: 'environment-secret-value' }],
      combined: 'prefix-known-secret-value-suffix',
    });

    expect(result.redactionApplied).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain('known-secret-value');
    expect(JSON.stringify(result.value)).not.toContain('environment-secret-value');
    expect(JSON.stringify(result.value)).toContain('[REDACTED]');
  });

  it('best-effort redacts headers, bearer tokens, token parameters, and URL credentials', () => {
    const redactor = new Redactor();
    const result = redactor.redact({
      authorization: 'Authorization: Bearer eyJhbGciOiJub25l.long-token.signature',
      header: 'X-Api-Key: abcdefghijklmnop',
      url: 'https://demo-user:demo-password@example.invalid/path?access_token=query-token-value',
    });
    const serialized = JSON.stringify(result.value);

    expect(result.redactionApplied).toBe(true);
    expect(serialized).not.toContain('eyJhbGciOiJub25l');
    expect(serialized).not.toContain('abcdefghijklmnop');
    expect(serialized).not.toContain('demo-password');
    expect(serialized).not.toContain('query-token-value');
    expect(serialized).toContain('[REDACTED]');
  });

  it('does not redact short explicit values or ordinary text', () => {
    const result = new Redactor({ secrets: ['short'], minSecretLength: 8 }).redact({
      message: 'a short ordinary token budget report',
      url: 'https://example.invalid/public',
    });

    expect(result).toEqual({
      value: {
        message: 'a short ordinary token budget report',
        url: 'https://example.invalid/public',
      },
      redactionApplied: false,
    });
  });

  it('always redacts exact sensitive fields even when their values are short', () => {
    const result = new Redactor({ minSecretLength: 100 }).redact({
      authorization: 'x',
      password: '',
      message: 'x',
    });

    expect(result).toEqual({
      value: {
        authorization: '[REDACTED]',
        password: '[REDACTED]',
        message: 'x',
      },
      redactionApplied: true,
    });
  });

  it('replaces the entire value under exact sensitive keys regardless of JSON type', () => {
    const result = new Redactor().redact({
      password: 7_382_910,
      token: false,
      authorization: null,
      secret: ['array-sensitive-marker'],
      credential: { nested: 'object-sensitive-marker' },
    });

    expect(result).toEqual({
      value: {
        password: '[REDACTED]',
        token: '[REDACTED]',
        authorization: '[REDACTED]',
        secret: '[REDACTED]',
        credential: '[REDACTED]',
      },
      redactionApplied: true,
    });
  });

  it('preserves own __proto__ JSON keys without invoking the prototype setter', () => {
    const input = JSON.parse(
      '{"__proto__":"preserve-me","nested":{"__proto__":"known-secret-value"}}',
    ) as unknown;
    const result = new Redactor({ secrets: ['known-secret-value'] }).redact(input);
    const root = result.value as { readonly [key: string]: unknown };
    const nested = root.nested as { readonly [key: string]: unknown };

    expect(Object.hasOwn(root, '__proto__')).toBe(true);
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(root.__proto__).toBe('preserve-me');
    expect(nested.__proto__).toBe('[REDACTED]');
    expect(JSON.stringify(result.value)).toBe(
      '{"__proto__":"preserve-me","nested":{"__proto__":"[REDACTED]"}}',
    );
  });

  it.each([
    ['undefined', { nested: undefined }],
    ['non-finite', { nested: Number.NaN }],
    ['bigint', { nested: 1n }],
    ['function', { nested: () => undefined }],
  ])('rejects non-JSON input: %s', (_name, value) => {
    expect(() => new Redactor().redact(value)).toThrow(/invalid JSON value/i);
  });

  it('rejects cyclic JSON input', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => new Redactor().redact(cycle)).toThrow(/cyclic|invalid JSON/i);
  });

  it('does not expose invalid JSON property names through redaction validation errors', () => {
    const recognizableInvalidKey = 'recognizable-invalid-json-key';
    const invalid = Object.fromEntries([[recognizableInvalidKey, undefined]]);
    let caught: unknown;
    try {
      new Redactor().redact(invalid);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid JSON value/i);
    expect(`${(caught as Error).message}\n${(caught as Error).stack ?? ''}`)
      .not.toContain(recognizableInvalidKey);
    expect(caught).not.toHaveProperty('cause');
  });

  it('redacts again before display and then sanitizes the serialized value', () => {
    const displayed = safeDisplayJson(
      { output: '\u001b]52;c;c3RlYWw=\u0007secret-display-value\u001b[31m' },
      new Redactor({ secrets: ['secret-display-value'] }),
    );

    expect(displayed.text).not.toContain('secret-display-value');
    expect(displayed.text).not.toContain('c3RlYWw=');
    expect(displayed.text).not.toContain('\u001b');
    expect(displayed.redactionApplied).toBe(true);
  });
});

describe('display rate limiting', () => {
  it('coalesces low-priority partial output and emits a standardized summary', () => {
    let now = 1_000;
    const limiter = new TerminalDisplayRateLimiter({
      maxEvents: 1,
      maxBytes: 8,
      windowMs: 1_000,
      clock: () => now,
    });

    expect(limiter.accept({ eventType: 'partial', text: '1234', priority: 'low' }))
      .toEqual([{ eventType: 'partial', text: '1234', priority: 'low' }]);
    expect(limiter.accept({ eventType: 'partial', text: '5678', priority: 'low' }))
      .toEqual([]);
    expect(limiter.accept({ eventType: 'partial', text: '90', priority: 'low' }))
      .toEqual([]);

    now += 1_000;
    expect(limiter.accept({ eventType: 'partial', text: 'next', priority: 'low' }))
      .toEqual([
        {
          eventType: 'rate_limited',
          text: '[rate limited: 2 events, 6 bytes omitted]',
          priority: 'high',
          metadata: { droppedEvents: 2, droppedBytes: 6, truncated: true },
        },
        { eventType: 'partial', text: 'next', priority: 'low' },
      ]);
  });

  it('never drops high-priority terminal or error events', () => {
    const limiter = new TerminalDisplayRateLimiter({
      maxEvents: 0,
      maxBytes: 0,
      windowMs: 1_000,
      clock: () => 0,
    });

    expect(limiter.accept({ eventType: 'run_failed', text: 'failed', priority: 'high' }))
      .toEqual([{ eventType: 'run_failed', text: 'failed', priority: 'high' }]);
    expect(limiter.accept({ eventType: 'run_completed', text: 'done', priority: 'high' }))
      .toEqual([{ eventType: 'run_completed', text: 'done', priority: 'high' }]);
  });

  it('drops only low partial output and retains normal, error, and terminal events at zero limits', () => {
    const limiter = new TerminalDisplayRateLimiter({
      maxEvents: 0,
      maxBytes: 0,
      windowMs: 1_000,
      clock: () => 0,
    });

    expect(limiter.accept({ eventType: 'diagnostic', text: 'normal', priority: 'normal' }))
      .toEqual([{ eventType: 'diagnostic', text: 'normal', priority: 'normal' }]);
    expect(limiter.accept({ eventType: 'error', text: 'error', priority: 'low' }))
      .toEqual([{ eventType: 'error', text: 'error', priority: 'low' }]);
    expect(limiter.accept({ eventType: 'run_completed', text: 'terminal', priority: 'low' }))
      .toEqual([{ eventType: 'run_completed', text: 'terminal', priority: 'low' }]);
    expect(limiter.accept({ eventType: 'partial', text: 'drop-me', priority: 'low' }))
      .toEqual([]);
    expect(limiter.flush()).toEqual([{
      eventType: 'rate_limited',
      text: '[rate limited: 1 events, 7 bytes omitted]',
      priority: 'high',
      metadata: { droppedEvents: 1, droppedBytes: 7, truncated: true },
    }]);
  });

  it.each([
    'cleanup_failed',
    'error',
    'exited',
    'fatal',
    'run_cancelled',
    'run_completed',
    'run_exited',
    'run_failed',
    'run_interrupted',
    'run_succeeded',
    'run_timed_out',
    'start_failed',
    'tree_clean',
    'worker_failed',
  ])('retains explicit terminal or error event %s even when marked low priority', (eventType) => {
    const limiter = new TerminalDisplayRateLimiter({
      maxEvents: 0,
      maxBytes: 0,
      windowMs: 1_000,
      clock: () => 0,
    });

    expect(limiter.accept({ eventType, text: 'state', priority: 'low' }))
      .toEqual([{ eventType, text: 'state', priority: 'low' }]);
  });

  it('matches the complete audited terminal/error event list from domain and approved protocols', () => {
    expect(NON_DROPPABLE_DISPLAY_EVENT_TYPES).toEqual([
      'cleanup_failed',
      'error',
      'exited',
      'fatal',
      'run_cancelled',
      'run_completed',
      'run_exited',
      'run_failed',
      'run_interrupted',
      'run_succeeded',
      'run_timed_out',
      'start_failed',
      'tree_clean',
      'worker_failed',
    ]);
  });

  it('standardizes sanitized size truncation as a truncated event', () => {
    const limiter = new TerminalDisplayRateLimiter({
      maxEvents: 10,
      maxBytes: 10_000,
      windowMs: 1_000,
      clock: () => 0,
    });

    expect(limiter.accept({
      eventType: 'partial',
      text: '[truncated]',
      priority: 'low',
      truncated: true,
    })).toEqual([{
      eventType: 'truncated',
      text: '[truncated]',
      priority: 'low',
      metadata: { originalEventType: 'partial', truncated: true },
    }]);
  });
});
