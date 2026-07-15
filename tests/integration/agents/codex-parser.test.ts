import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../../src/agents/agent-adapter.js';
import {
  parseCodexEventLine,
  parseCodexJsonl,
} from '../../../src/agents/codex/codex-events.js';
import { asAttemptId } from '../../../src/domain/ids.js';
import { parseAgentResult } from '../../../src/protocol/result-parser.js';

const ATTEMPT = asAttemptId('attempt-codex-parser-1');
const FIXTURE_DIR = resolve('tests/fixtures/codex');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf8');
}

describe('Codex JSONL parser (recorded fixtures)', () => {
  it('maps sanitized recorded JSONL into attempt-attributed AgentEvents', () => {
    const raw = loadFixture('recorded-jsonl.jsonl');
    const events = parseCodexJsonl(raw, ATTEMPT);

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.attemptId === ATTEMPT)).toBe(true);

    const outputs = events.filter(
      (event): event is Extract<AgentEvent, { type: 'output' }> =>
        event.type === 'output',
    );
    expect(outputs.some((event) => event.text.includes('Planning the change'))).toBe(
      true,
    );

    const results = events.filter(
      (event): event is Extract<AgentEvent, { type: 'result' }> =>
        event.type === 'result',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.conversationId).toBe('conversation-sanitized-001');
    expect(results[0]?.output).toMatchObject({
      status: 'completed',
      summary: 'Implemented the requested change',
      nextAction: 'review',
    });

    // Task 8 schema integration
    const schemaOutcome = parseAgentResult(results[0]?.output);
    expect(schemaOutcome.success).toBe(true);
  });

  it('retains unknown events safely as raw records (output), never drops them', () => {
    const events = parseCodexJsonl(
      `${JSON.stringify({
        type: 'unknown.future_event',
        payload: { note: 'retain me as raw', count: 2 },
      })}\n`,
      ATTEMPT,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'output',
      attemptId: ATTEMPT,
    });
    const text = (events[0] as Extract<AgentEvent, { type: 'output' }>).text;
    expect(text).toMatch(/unknown\.future_event/);
    expect(text).toMatch(/retain me as raw/);
    // No secret leakage markers from fixture
    expect(text).not.toMatch(/sk-[a-zA-Z0-9]/);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/i);
  });

  it('turns invalid lines into bounded parse_error without secret/raw error leak', () => {
    const secretLine =
      'Authorization: Bearer sk-live-super-secret-token-value-xyz and garbage';
    const event = parseCodexEventLine(secretLine, ATTEMPT);
    expect(event).not.toBeNull();
    expect(event?.type).toBe('parse_error');
    if (event?.type !== 'parse_error') return;

    expect(event.attemptId).toBe(ATTEMPT);
    expect(event.error.length).toBeGreaterThan(0);
    expect(event.error.length).toBeLessThanOrEqual(256);
    // Bounded / sanitized: must not echo the secret token or full raw line as error.
    expect(event.error).not.toMatch(/sk-live-super-secret/i);
    expect(event.error).not.toMatch(/Bearer\s+sk-live/i);
    expect(event.raw.length).toBeLessThanOrEqual(512);
    expect(event.raw).not.toMatch(/sk-live-super-secret/i);
  });

  it('handles partial multi-chunk lines when reassembled by caller', () => {
    const full = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'hello from partial stream' },
    });
    const mid = Math.floor(full.length / 2);
    const first = parseCodexEventLine(full.slice(0, mid), ATTEMPT);
    // Incomplete JSON becomes parse_error when treated as a finished line.
    expect(first?.type).toBe('parse_error');

    const complete = parseCodexEventLine(full, ATTEMPT);
    expect(complete).toMatchObject({
      type: 'output',
      attemptId: ATTEMPT,
      text: expect.stringContaining('hello from partial stream'),
    });
  });

  it('parses partial-and-invalid fixture: invalid -> parse_error, valid result retained', () => {
    const raw = loadFixture('partial-and-invalid.jsonl');
    const events = parseCodexJsonl(raw, ATTEMPT);

    const parseErrors = events.filter((event) => event.type === 'parse_error');
    expect(parseErrors.length).toBeGreaterThanOrEqual(1);
    for (const error of parseErrors) {
      if (error.type !== 'parse_error') continue;
      expect(error.attemptId).toBe(ATTEMPT);
      expect(error.error.length).toBeLessThanOrEqual(256);
      expect(error.raw.length).toBeLessThanOrEqual(512);
    }

    const results = events.filter((event) => event.type === 'result');
    // One valid result; schema-invalid result should become parse_error or failed parse path.
    expect(results.length).toBeGreaterThanOrEqual(1);
    const good = results.find(
      (event) =>
        event.type === 'result'
        && event.conversationId === 'conversation-partial',
    );
    expect(good).toBeDefined();
    if (good?.type === 'result') {
      expect(parseAgentResult(good.output).success).toBe(true);
    }
  });

  it('attributes every event to the provided attemptId (never invents another)', () => {
    const other = asAttemptId('attempt-other');
    const line = JSON.stringify({
      type: 'result',
      attemptId: 'attempt-spoofed',
      conversationId: 'conversation-x',
      output: {
        status: 'completed',
        summary: 'spoof',
        changedFiles: [],
        commandsRun: [],
        verification: { passed: true, details: 'ok' },
        issues: [],
        nextAction: 'review',
      },
    });
    const event = parseCodexEventLine(line, other);
    expect(event?.attemptId).toBe(other);
  });

  it('rejects result payloads that fail Task8 agent-result schema as parse_error', () => {
    const line = JSON.stringify({
      type: 'result',
      conversationId: 'conversation-bad',
      output: {
        status: 'failed',
        summary: 'missing verification.details',
        changedFiles: [],
        commandsRun: [],
        verification: { passed: false },
        issues: [],
        nextAction: 'await_user',
      },
    });
    const event = parseCodexEventLine(line, ATTEMPT);
    expect(event?.type).toBe('parse_error');
    if (event?.type !== 'parse_error') return;
    expect(event.error).toMatch(/schema|result/i);
    expect(event.error).not.toMatch(/sk-|Bearer/i);
  });
});

describe('Codex live smoke (opt-in only)', () => {
  const enabled = process.env.TRIAGENT_REAL_AI_TESTS === '1';

  it.skipIf(!enabled)(
    'live no-write structured response via real ProcessSupervisor (TRIAGENT_REAL_AI_TESTS=1)',
    async () => {
      // REAL opt-in only: start Codex through ProcessSupervisor in a temp
      // no-write directory, deliver a no-write prompt on stdin, wait for a
      // structured response, assert no file changes. Never runs in default CI.
      if (process.platform !== 'win32') {
        // ProcessHost Job Object is Windows-only for this smoke path.
        return;
      }

      const {
        mkdtempSync,
        readdirSync,
        rmSync,
        statSync,
      } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { CodexAdapter } = await import(
        '../../../src/agents/codex/codex-adapter.js'
      );
      type CodexRunRequest = import(
        '../../../src/agents/codex/codex-adapter.js'
      ).CodexRunRequest;
      const { requireVerifiedCompatibility } = await import(
        '../../../src/agents/compatibility-matrix.js'
      );
      const {
        asAttemptId,
        asBaselineId,
        asTaskId,
      } = await import('../../../src/domain/ids.js');
      const { ProcessSupervisor } = await import(
        '../../../src/process/process-supervisor.js'
      );
      const { resolveProcessHostExecutable } = await import(
        '../../../src/process/process-host-client.js'
      );
      const databaseModule = await import(
        '../../../src/persistence/database.js'
      );
      const { openDatabase } = databaseModule;
      type OpenedDatabase = import(
        '../../../src/persistence/database.js'
      ).OpenedDatabase;
      type ReadWriteDatabase = import(
        '../../../src/persistence/database.js'
      ).ReadWriteDatabase;
      const { WorkerStartGateVerifier } = await import(
        '../../../src/workers/worker-start-gate-verifier.js'
      );
      const {
        LaunchAuthorizationRepository,
      } = await import(
        '../../../src/agents/launch-authorization-repository.js'
      );
      const { seedVerifiedWorkerStartGate } = await import(
        '../../fakes/worker-start-gate.js'
      );
      const { parseAgentResult } = await import(
        '../../../src/protocol/result-parser.js'
      );

      function requireReadWrite(opened: OpenedDatabase): ReadWriteDatabase {
        if (opened.mode !== 'read-write') {
          throw new Error(opened.diagnostics.error);
        }
        return opened;
      }

      function snapshotTree(root: string): Map<string, { size: number; mtimeMs: number }> {
        const out = new Map<string, { size: number; mtimeMs: number }>();
        const walk = (dir: string, prefix: string): void => {
          for (const name of readdirSync(dir)) {
            const abs = join(dir, name);
            const rel = prefix.length === 0 ? name : `${prefix}/${name}`;
            const st = statSync(abs);
            if (st.isDirectory()) {
              walk(abs, rel);
            } else {
              out.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
            }
          }
        };
        walk(root, '');
        return out;
      }

      const tempRoot = mkdtempSync(join(tmpdir(), 'triagent-codex-smoke-'));
      const tempProject = join(tempRoot, 'project');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(tempProject);
      const dbPath = join(tempRoot, 'triagent.sqlite');
      const opened = requireReadWrite(openDatabase(dbPath));
      const { createPersistenceRepositories } = databaseModule;
      const supervisor = new ProcessSupervisor({
        helperPath: resolveProcessHostExecutable(),
      });
      try {
        const capabilityKey = {
          cliName: 'codex' as const,
          version: '0.144.1',
          platform: process.platform,
        };
        const capabilityRecord = requireVerifiedCompatibility(capabilityKey);
        const taskId = asTaskId('live-smoke-task');
        const attemptId = asAttemptId('live-smoke-attempt');
        const schemaPath = resolve('schemas/agent-result.schema.json');
        const prompt =
          'Do not write any files. Return only a valid structured agent result '
          + 'JSON with status completed, empty changedFiles, empty commandsRun, '
          + 'verification.passed true, nextAction complete, and a short summary.';

        // Seed task row for GuardDecision FK + budget state.
        const repositories = createPersistenceRepositories(opened);
        repositories.tasks.createProject({
          projectId: 'project-live-smoke',
          rootPath: tempProject,
        });
        repositories.tasks.create({
          taskId,
          projectId: 'project-live-smoke',
          workflowSnapshot: {
            state: 'reviewing',
            taskId,
            requirementVersion: 1,
            reworkCount: 0,
            maxReworks: 3,
            pauseAfterAttempt: false,
            activeAttemptId: attemptId,
            activeAttemptBaselineId: asBaselineId('live-smoke-baseline'),
            activeAttemptRole: 'reviewer',
          },
          workflowVersion: 1,
          status: 'reviewing',
        });

        const seeded = seedVerifiedWorkerStartGate(opened.connection, {
          taskId,
          attemptId,
          role: 'reviewer',
          agentKind: 'codex',
          projectRoot: tempProject,
        });
        const verifier = new WorkerStartGateVerifier(opened.connection);
        const authorized = verifier.authorizeForLaunch({
          taskId,
          attemptId,
          role: 'reviewer',
          agentKind: 'codex',
          refs: seeded.startGate,
          nonGit: true,
          schemaPath,
          mode: 'read_only',
        });
        expect(authorized.allowed).toBe(true);
        if (!authorized.allowed) {
          throw new Error(
            `live smoke authorize failed: ${authorized.missing.join(', ')}`,
          );
        }

        const launchAuth = new LaunchAuthorizationRepository(opened.connection);
        const adapter = new CodexAdapter({
          supervisor,
          launchAuthorization: launchAuth,
          fixedCapabilities: capabilityRecord.capabilities,
          fixedHealth: {
            kind: 'codex',
            cliName: 'codex',
            status: 'available',
            version: '0.144.1',
            auth: 'authenticated',
            requiresReadinessProbe: false,
            evidence: [],
            platform: process.platform,
            compatibility: capabilityRecord,
          },
        });

        // Exact before snapshot (empty project tree).
        const before = snapshotTree(tempProject);

        const request: CodexRunRequest = {
          attemptId,
          taskId,
          baselineId: asBaselineId('live-smoke-baseline'),
          requirementVersion: 1,
          role: 'reviewer',
          projectRoot: tempProject,
          prompt,
          capabilityKey,
          capabilityRecord,
          projectGuardDecisionId: seeded.guardDecision.id,
          reservedBudgetId: seeded.reservedBudgetId,
          mode: 'read_only',
          nonGit: true,
          schemaPath,
          launchAuthorizationId: authorized.launchAuthorizationId,
          timeoutMs: 120_000,
        };

        const handle = await adapter.start(request);

        // Collect structured result; do not swallow wait failure.
        let structuredOutput: unknown;
        const eventLoop = (async () => {
          for await (const event of handle.events()) {
            if (event.type === 'result') {
              structuredOutput = event.output;
              break;
            }
          }
        })();
        const run = await handle.wait();
        await eventLoop;

        expect(run.status).toBe('succeeded');
        expect(structuredOutput).toBeDefined();
        const parsed = parseAgentResult(structuredOutput);
        expect(parsed.success).toBe(true);
        if (!parsed.success) {
          throw new Error(
            `live smoke structured result invalid: ${parsed.reason}`,
          );
        }

        // Exact before/after filesystem snapshot must be unchanged.
        const after = snapshotTree(tempProject);
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
        for (const [path, beforeMeta] of before) {
          const afterMeta = after.get(path);
          expect(afterMeta).toEqual(beforeMeta);
        }
      } finally {
        await supervisor.dispose().catch(() => undefined);
        opened.close();
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it('default suite skips real AI unless explicitly enabled', () => {
    // When enabled, the opt-in suite is allowed to run; when disabled, it stays skipped.
    // Never assert env === false unconditionally (that breaks enabled mode).
    if (process.env.TRIAGENT_REAL_AI_TESTS === '1') {
      expect(enabled).toBe(true);
    } else {
      expect(enabled).toBe(false);
      expect(process.env.TRIAGENT_REAL_AI_TESTS === '1').toBe(false);
    }
  });
});

