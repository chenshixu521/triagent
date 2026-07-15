import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseAgentResult } from '../../../src/protocol/result-parser.js';
import {
  AgentResultSchema,
  type AgentResult,
} from '../../../src/protocol/result-schema.js';

const validResult = {
  status: 'completed',
  summary: '  agent-reported summary  ',
  changedFiles: ['src/agent-claimed.ts'],
  commandsRun: ['npm.cmd test -- agent-claimed'],
  verification: {
    passed: true,
    details: '  agent says its checks passed  ',
  },
  issues: [],
  nextAction: 'review',
} satisfies AgentResult;

function parseArtifactSchema() {
  const artifact = JSON.parse(
    readFileSync(resolve('schemas/agent-result.schema.json'), 'utf8'),
  ) as Parameters<typeof z.fromJSONSchema>[0];
  return {
    artifact,
    schema: z.fromJSONSchema(artifact),
  };
}

describe('parseAgentResult', () => {
  it('accepts an exact parsed result while preserving every agent claim verbatim', () => {
    const parsed = parseAgentResult(validResult);

    expect(parsed).toEqual({ success: true, result: validResult });
    if (parsed.success) {
      expect(parsed.result.changedFiles).toEqual(['src/agent-claimed.ts']);
      expect(parsed.result.commandsRun).toEqual([
        'npm.cmd test -- agent-claimed',
      ]);
      expect(parsed.result.verification).toEqual({
        passed: true,
        details: '  agent says its checks passed  ',
      });
    }
  });

  it('accepts a raw final payload only when the whole string is exact JSON', () => {
    expect(parseAgentResult(`\n${JSON.stringify(validResult)}\n`)).toEqual({
      success: true,
      result: validResult,
    });

    const fenced = parseAgentResult(
      `\`\`\`json\n${JSON.stringify(validResult)}\n\`\`\``,
    );
    expect(fenced).toEqual({
      success: false,
      code: 'invalid_json',
      reason: 'final result is not valid JSON',
    });
  });

  it.each([
    ['missing field', (({ nextAction: _omitted, ...rest }) => rest)(validResult)],
    ['unknown root field', { ...validResult, derivedEvidence: true }],
    [
      'unknown verification field',
      {
        ...validResult,
        verification: { ...validResult.verification, exitCode: 0 },
      },
    ],
    [
      'coerced boolean',
      {
        ...validResult,
        verification: { passed: 'true', details: 'claimed' },
      },
    ],
    ['blank summary', { ...validResult, summary: ' \t\r\n ' }],
    ['unknown status', { ...validResult, status: 'success' }],
    ['unknown next action', { ...validResult, nextAction: 'continue' }],
  ])('fails closed for %s', (_name, payload) => {
    expect(parseAgentResult(payload)).toEqual({
      success: false,
      code: 'schema_mismatch',
      reason: 'final result does not match the agent result schema',
    });
  });

  it('returns a bounded failure without echoing attacker-controlled invalid JSON', () => {
    const secret = `recognizable-secret-${'x'.repeat(16_384)}`;
    const parsed = parseAgentResult(`{not-json:"${secret}"}`);

    expect(parsed).toEqual({
      success: false,
      code: 'invalid_json',
      reason: 'final result is not valid JSON',
    });
    expect(JSON.stringify(parsed)).not.toContain('recognizable-secret');
    expect(JSON.stringify(parsed).length).toBeLessThan(256);
    expect(parsed).not.toHaveProperty('cause');
    expect(parsed).not.toHaveProperty('rawPayload');
  });

  it('does not expose attacker-controlled keys from schema failures', () => {
    const attackerKey = `recognizable-key-${'y'.repeat(16_384)}`;
    const parsed = parseAgentResult({
      ...validResult,
      [attackerKey]: 'attacker-controlled-value',
    });

    expect(parsed).toEqual({
      success: false,
      code: 'schema_mismatch',
      reason: 'final result does not match the agent result schema',
    });
    expect(JSON.stringify(parsed)).not.toContain('recognizable-key');
    expect(JSON.stringify(parsed).length).toBeLessThan(256);
  });

  it('rejects non-JSON parsed values without invoking accessors or throwing', () => {
    const secret = 'recognizable-getter-secret';
    let getterCalls = 0;
    const payload = { ...validResult } as Record<string, unknown>;
    Object.defineProperty(payload, 'summary', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(secret);
      },
    });

    let parsed: ReturnType<typeof parseAgentResult> | undefined;
    expect(() => {
      parsed = parseAgentResult(payload);
    }).not.toThrow();
    expect(parsed).toEqual({
      success: false,
      code: 'non_json_value',
      reason: 'final result must be a JSON-compatible value',
    });
    expect(getterCalls).toBe(0);
  });

  it('rejects hostile proxies without exposing trap errors or causes', () => {
    const secret = 'recognizable-proxy-secret';
    const payload = new Proxy(
      { ...validResult },
      {
        ownKeys() {
          throw new Error(secret);
        },
      },
    );

    let parsed: ReturnType<typeof parseAgentResult> | undefined;
    expect(() => {
      parsed = parseAgentResult(payload);
    }).not.toThrow();
    expect(parsed).toEqual({
      success: false,
      code: 'non_json_value',
      reason: 'final result must be a JSON-compatible value',
    });
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(parsed).not.toHaveProperty('cause');
  });

  it.each([
    ['undefined property', { ...validResult, unexpected: undefined }],
    ['bigint property', { ...validResult, unexpected: 1n }],
    [
      'symbol key',
      Object.assign({ ...validResult }, { [Symbol('secret')]: true }),
    ],
    [
      'custom prototype',
      Object.assign(Object.create({ inherited: true }), validResult),
    ],
  ])('rejects parsed objects containing a non-JSON shape: %s', (_name, payload) => {
    expect(parseAgentResult(payload)).toEqual({
      success: false,
      code: 'non_json_value',
      reason: 'final result must be a JSON-compatible value',
    });
  });

  it('rejects cyclic parsed objects', () => {
    const payload: Record<string, unknown> = { ...validResult };
    payload.unexpected = payload;

    expect(parseAgentResult(payload)).toEqual({
      success: false,
      code: 'non_json_value',
      reason: 'final result must be a JSON-compatible value',
    });
  });
});

describe('AgentResultSchema and JSON Schema artifact', () => {
  it('makes direct Zod validation fail closed before reading hostile properties', () => {
    let getterCalls = 0;
    const payload = { ...validResult } as Record<string, unknown>;
    Object.defineProperty(payload, 'summary', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must-not-escape');
      },
    });

    let result: ReturnType<typeof AgentResultSchema.safeParse> | undefined;
    expect(() => {
      result = AgentResultSchema.safeParse(payload);
    }).not.toThrow();
    expect(result?.success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('keeps representative artifact and parser fixtures in agreement', () => {
    const { artifact, schema } = parseArtifactSchema();
    expect(artifact).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'status',
        'summary',
        'changedFiles',
        'commandsRun',
        'verification',
        'issues',
        'nextAction',
      ],
    });

    const fixtures: readonly unknown[] = [
      validResult,
      {
        ...validResult,
        issues: [
          {
            severity: 'major',
            message: 'claimed issue',
            file: 'src/a.ts',
            line: 2,
          },
        ],
      },
      { ...validResult, summary: '' },
      { ...validResult, summary: '   ' },
      {
        ...validResult,
        verification: { ...validResult.verification, passed: 1 },
      },
      {
        ...validResult,
        issues: [{ severity: 'urgent', message: 'claimed issue' }],
      },
      {
        ...validResult,
        issues: [
          { severity: 'minor', message: 'claimed issue', line: 0 },
        ],
      },
      { ...validResult, extra: true },
    ];

    for (const fixture of fixtures) {
      expect(schema.safeParse(fixture).success).toBe(
        parseAgentResult(fixture).success,
      );
    }
  });
});
