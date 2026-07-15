import { describe, expect, it } from 'vitest';

import {
  parseAgentResult,
  parseAgentResultForMode,
} from '../../../src/protocol/result-parser.js';
import type { AgentPatchResult } from '../../../src/protocol/result-schema.js';

const basePatch: AgentPatchResult = {
  status: 'completed',
  summary: 'Return a unified diff only; PatchApplier is the sole writer',
  changedFiles: [],
  commandsRun: [],
  verification: {
    passed: true,
    details: 'structured patch only; no project writes claimed',
  },
  issues: [],
  nextAction: 'review',
  unifiedDiff:
    '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
  requestedCommands: ['npm.cmd test -- src/example.ts'],
};

describe('patch-mode agent result schema', () => {
  it('accepts strict patch result with unifiedDiff and requestedCommands', () => {
    const parsed = parseAgentResultForMode(basePatch, 'patch_mode');
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.result).toMatchObject({
      status: 'completed',
      unifiedDiff: basePatch.unifiedDiff,
      requestedCommands: basePatch.requestedCommands,
    });
    // Normalized field alias: patch may be accepted as unifiedDiff synonym.
    expect('unifiedDiff' in parsed.result || 'patch' in parsed.result).toBe(
      true,
    );
  });

  it('accepts patch alias for unifiedDiff and normalizes to unifiedDiff', () => {
    const { unifiedDiff: _omit, ...rest } = basePatch;
    const withAlias = {
      ...rest,
      patch: basePatch.unifiedDiff,
      requestedCommands: basePatch.requestedCommands,
    };
    const parsed = parseAgentResultForMode(withAlias, 'patch_mode');
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = parsed.result as AgentPatchResult;
    expect(result.unifiedDiff).toBe(basePatch.unifiedDiff);
    expect(
      'patch' in result ? (result as { patch?: string }).patch : undefined,
    ).toBeUndefined();
  });

  it('rejects patch_mode payloads missing unifiedDiff/patch', () => {
    const { unifiedDiff: _omit, requestedCommands: _rc, ...rest } = basePatch;
    const parsed = parseAgentResultForMode(rest, 'patch_mode');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.code).toBe('schema_mismatch');
  });

  it('rejects unsafe extra fields in patch mode', () => {
    const parsed = parseAgentResultForMode(
      {
        ...basePatch,
        shellCommand: 'rm -rf /',
        writePath: 'C:\\\\Windows\\\\system32',
      },
      'patch_mode',
    );
    expect(parsed.success).toBe(false);
  });

  it('default parseAgentResult still rejects patch fields (strict default schema)', () => {
    const parsed = parseAgentResult(basePatch);
    expect(parsed.success).toBe(false);
  });

  it('project_write mode uses default schema and rejects unifiedDiff-only extras', () => {
    const parsed = parseAgentResultForMode(basePatch, 'project_write');
    expect(parsed.success).toBe(false);
  });
});
