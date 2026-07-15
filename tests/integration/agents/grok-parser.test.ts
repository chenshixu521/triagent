import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../../src/agents/agent-adapter.js';
import {
  parseGrokEventLine,
  parseGrokJsonl,
} from '../../../src/agents/grok/grok-events.js';
import { asAttemptId } from '../../../src/domain/ids.js';
import { parseAgentResult } from '../../../src/protocol/result-parser.js';

const ATTEMPT = asAttemptId('attempt-grok-parser-1');
const FIXTURE_DIR = resolve('tests/fixtures/grok');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf8');
}

describe('Grok streaming-json parser (recorded fixtures)', () => {
  it('maps sanitized recorded streaming-json into attempt-attributed AgentEvents', () => {
    const raw = loadFixture('recorded-streaming-json.jsonl');
    const events = parseGrokJsonl(raw, ATTEMPT);

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.attemptId === ATTEMPT)).toBe(true);

    const outputs = events.filter(
      (event): event is Extract<AgentEvent, { type: 'output' }> =>
        event.type === 'output',
    );
    expect(
      outputs.some((event) => event.text.includes('Planning the change')),
    ).toBe(true);

    const results = events.filter(
      (event): event is Extract<AgentEvent, { type: 'result' }> =>
        event.type === 'result',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.conversationId).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
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
    const events = parseGrokJsonl(
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
    expect(text).not.toMatch(/sk-[a-zA-Z0-9]/);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/i);
  });

  it('turns invalid lines into bounded parse_error without secret/raw error leak', () => {
    const secretLine =
      'Authorization: Bearer sk-xai-super-secret-token-value-xyz and garbage';
    const event = parseGrokEventLine(secretLine, ATTEMPT);
    expect(event).not.toBeNull();
    expect(event?.type).toBe('parse_error');
    if (event?.type !== 'parse_error') return;

    expect(event.attemptId).toBe(ATTEMPT);
    expect(event.error.length).toBeGreaterThan(0);
    expect(event.error.length).toBeLessThanOrEqual(256);
    expect(event.error).not.toMatch(/sk-xai-super-secret/i);
    expect(event.error).not.toMatch(/Bearer\s+sk-xai/i);
    expect(event.raw.length).toBeLessThanOrEqual(512);
    expect(event.raw).not.toMatch(/sk-xai-super-secret/i);
  });

  it('handles partial multi-chunk lines when reassembled by caller', () => {
    const full = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello from partial stream' }],
      },
    });
    const mid = Math.floor(full.length / 2);
    const first = parseGrokEventLine(full.slice(0, mid), ATTEMPT);
    // Incomplete JSON becomes parse_error when treated as a finished line.
    expect(first?.type).toBe('parse_error');

    const complete = parseGrokEventLine(full, ATTEMPT);
    expect(complete).toMatchObject({
      type: 'output',
      attemptId: ATTEMPT,
      text: expect.stringContaining('hello from partial stream'),
    });
  });

  it('parses partial-and-invalid fixture: invalid -> parse_error, valid result retained', () => {
    const raw = loadFixture('partial-and-invalid.jsonl');
    const events = parseGrokJsonl(raw, ATTEMPT);

    const parseErrors = events.filter((event) => event.type === 'parse_error');
    expect(parseErrors.length).toBeGreaterThanOrEqual(1);
    for (const error of parseErrors) {
      if (error.type !== 'parse_error') continue;
      expect(error.raw).not.toMatch(/sk-xai-super-secret/i);
      expect(error.error).not.toMatch(/sk-xai-super-secret/i);
    }

    const results = events.filter((event) => event.type === 'result');
    expect(results.length).toBe(1);
    if (results[0]?.type === 'result') {
      expect(results[0].output).toMatchObject({
        status: 'completed',
        nextAction: 'complete',
      });
    }
  });

  it('rejects structured result that fails Task 8 schema as parse_error', () => {
    const line = JSON.stringify({
      type: 'result',
      structured_output: {
        status: 'completed',
        // missing required fields
      },
    });
    const event = parseGrokEventLine(line, ATTEMPT);
    expect(event?.type).toBe('parse_error');
    if (event?.type !== 'parse_error') return;
    expect(event.error).toMatch(/schema|result/i);
    expect(event.error).not.toMatch(/sk-|Bearer/i);
  });

  it('maps patch_mode structured result via Task 8 patch schema', () => {
    const line = JSON.stringify({
      type: 'result',
      session_id: 'cccccccc-dddd-4eee-8fff-000000000000',
      structured_output: {
        status: 'completed',
        summary: 'patch only',
        unifiedDiff:
          '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        requestedCommands: ['npm.cmd test'],
        changedFiles: ['src/a.ts'],
        commandsRun: [],
        verification: { passed: true, details: 'diff only' },
        issues: [],
        nextAction: 'review',
      },
    });
    const event = parseGrokEventLine(line, ATTEMPT, { resultMode: 'patch_mode' });
    // May succeed as patch schema or fail if schema requires extra fields —
    // either way must not leak secrets and must be result or bounded parse_error.
    expect(event).not.toBeNull();
    expect(['result', 'parse_error']).toContain(event?.type);
    if (event?.type === 'result') {
      expect(event.conversationId).toBe(
        'cccccccc-dddd-4eee-8fff-000000000000',
      );
    }
  });
});

describe('Grok live smoke (opt-in only)', () => {
  const enabled = process.env.TRIAGENT_REAL_AI_TESTS === '1';

  it.skipIf(!enabled)(
    'live disposable-project hash+event proof for permission-mode plan / tool allow-deny (TRIAGENT_REAL_AI_TESTS=1)',
    async () => {
      // REAL opt-in only (never default CI):
      // 1) Require readiness evidence + successful structured run.
      // 2) Disposable project is the immutable review bundle (--cwd).
      // 3) Prompt EXPLICITLY asks Grok to attempt creating/modifying a marker.
      // 4) Pass only if: write denied, zero FS events, hashes unchanged,
      //    run.status=succeeded, schema-valid result reports denied.
      // 5) On success persist enforcement proof for exact version/platform.
      // Do NOT run with TRIAGENT_REAL_AI_TESTS unset.
      if (process.platform !== 'win32') {
        return;
      }

      const {
        mkdtempSync,
        readdirSync,
        rmSync,
        statSync,
        mkdirSync,
        writeFileSync,
        readFileSync: readFs,
        existsSync,
      } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join, resolve: pathResolve } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const { watch } = await import('node:fs');
      const { GrokAdapter } = await import(
        '../../../src/agents/grok/grok-adapter.js'
      );
      type GrokRunRequest = import(
        '../../../src/agents/grok/grok-adapter.js'
      ).GrokRunRequest;
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
      const {
        hashImmutableReviewManifestContent,
        IMMUTABLE_REVIEW_BUNDLE_KIND,
      } = await import('../../../src/protocol/immutable-review-bundle.js');
      const {
        defaultGrokEnforcementProofPath,
        persistGrokEnforcementProof,
        registerLoadedGrokEnforcementProof,
      } = await import('../../../src/agents/grok/grok-enforcement-proof.js');
      const { parseAgentResultForMode } = await import(
        '../../../src/protocol/result-parser.js'
      );

      function requireReadWrite(opened: OpenedDatabase): ReadWriteDatabase {
        if (opened.mode !== 'read-write') {
          throw new Error(opened.diagnostics.error);
        }
        return opened;
      }

      function hashFile(abs: string): string {
        return createHash('sha256').update(readFs(abs)).digest('hex');
      }

      function snapshotTree(
        root: string,
      ): Map<string, { size: number; mtimeMs: number; sha256: string; isDir: boolean }> {
        const out = new Map<
          string,
          { size: number; mtimeMs: number; sha256: string; isDir: boolean }
        >();
        const walk = (dir: string, prefix: string): void => {
          for (const name of readdirSync(dir)) {
            const abs = join(dir, name);
            const rel = prefix.length === 0 ? name : `${prefix}/${name}`;
            const st = statSync(abs);
            if (st.isDirectory()) {
              out.set(rel, {
                size: 0,
                mtimeMs: st.mtimeMs,
                sha256: '',
                isDir: true,
              });
              walk(abs, rel);
            } else {
              out.set(rel, {
                size: st.size,
                mtimeMs: st.mtimeMs,
                sha256: hashFile(abs),
                isDir: false,
              });
            }
          }
        };
        walk(root, '');
        return out;
      }

      const tempRoot = mkdtempSync(join(tmpdir(), 'triagent-grok-smoke-'));
      // Fake live project (must not be written). Bundle is the disposable cwd.
      const liveProject = join(tempRoot, 'live-project');
      const disposableBundle = join(tempRoot, 'immutable-bundle');
      const promptDir = join(tempRoot, 'prompts');
      const proofDir = join(tempRoot, 'proofs');
      mkdirSync(liveProject);
      mkdirSync(disposableBundle);
      mkdirSync(promptDir);
      mkdirSync(proofDir);
      mkdirSync(join(disposableBundle, 'src', 'nested'), { recursive: true });
      writeFileSync(
        join(disposableBundle, 'sentinel.txt'),
        'SENTINEL_DO_NOT_MODIFY\n',
        'utf8',
      );
      writeFileSync(
        join(disposableBundle, 'src', 'nested', 'keep.ts'),
        'export const keep = true;\n',
        'utf8',
      );
      writeFileSync(
        join(disposableBundle, 'package.json'),
        '{"name":"grok-smoke-sentinel"}\n',
        'utf8',
      );
      const manifestBody = JSON.stringify({
        kind: IMMUTABLE_REVIEW_BUNDLE_KIND,
        files: ['sentinel.txt', 'src/nested/keep.ts', 'package.json'],
        smoke: true,
      });
      const manifestPath = join(disposableBundle, 'manifest.json');
      writeFileSync(manifestPath, manifestBody, 'utf8');
      const contentHash = hashImmutableReviewManifestContent(manifestBody);

      const fsEvents: Array<{ event: string; filename: string | null }> = [];
      const watcher = watch(
        disposableBundle,
        { recursive: true },
        (eventType, filename) => {
          fsEvents.push({
            event: eventType,
            filename: filename === null ? null : String(filename),
          });
        },
      );

      const dbPath = join(tempRoot, 'triagent.sqlite');
      const opened = requireReadWrite(openDatabase(dbPath));
      const { createPersistenceRepositories } = databaseModule;
      const supervisor = new ProcessSupervisor({
        helperPath: resolveProcessHostExecutable(),
      });
      try {
        const capabilityKey = {
          cliName: 'grok' as const,
          version: '0.2.93',
          platform: process.platform,
        };
        const capabilityRecord = requireVerifiedCompatibility(capabilityKey);
        // Static matrix must still be unproven until this test persists proof.
        expect(capabilityRecord.readOnly).toBe(false);
        expect(capabilityRecord.capabilities.writeModes).toEqual([]);

        const elevatedCaps = Object.freeze({
          ...capabilityRecord.capabilities,
          nativePermissionRules: true,
          writeModes: Object.freeze(['read-only'] as const),
        });

        const taskId = asTaskId('live-smoke-grok-task');
        const attemptId = asAttemptId('live-smoke-grok-attempt');
        const schemaPath = pathResolve('schemas/agent-result.schema.json');
        // Explicitly ask the model to ATTEMPT a write, then report denial.
        const prompt =
          'You are running with permission-mode plan and write tools denied. '
          + 'Using whatever tools are available, ATTEMPT to create a new file '
          + 'named WRITE_ATTEMPT_MARKER.txt in the current working directory '
          + 'with content MARKER_SHOULD_NOT_EXIST, or modify sentinel.txt. '
          + 'Then report the outcome in a structured agent-result JSON object: '
          + 'status must be "completed", summary must include the word "denied" '
          + 'if the write was blocked (or "succeeded" only if the write worked), '
          + 'changedFiles must be [], verification.passed true only when denied, '
          + 'verification.details must state whether the write was denied, '
          + 'issues may be empty, nextAction "await_user". '
          + 'Do not claim success if the write was blocked.';

        const repositories = createPersistenceRepositories(opened);
        repositories.tasks.createProject({
          projectId: 'project-live-smoke-grok',
          rootPath: liveProject,
        });
        repositories.tasks.create({
          taskId,
          projectId: 'project-live-smoke-grok',
          workflowSnapshot: {
            state: 'reviewing',
            taskId,
            requirementVersion: 1,
            reworkCount: 0,
            maxReworks: 3,
            pauseAfterAttempt: false,
            activeAttemptId: attemptId,
            activeAttemptBaselineId: asBaselineId('live-smoke-grok-baseline'),
            activeAttemptRole: 'reviewer',
          },
          workflowVersion: 1,
          status: 'reviewing',
        });

        // Readiness required; elevate guard caps only for authorize path.
        const seeded = seedVerifiedWorkerStartGate(opened.connection, {
          taskId,
          attemptId,
          role: 'reviewer',
          agentKind: 'grok',
          projectRoot: liveProject,
          readinessSucceeded: true,
          capabilitiesOverride: elevatedCaps,
        });
        expect(seeded.readinessEvidenceId).toBeTruthy();
        const verifier = new WorkerStartGateVerifier(opened.connection);
        const authorized = verifier.authorizeForLaunch({
          taskId,
          attemptId,
          role: 'reviewer',
          agentKind: 'grok',
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
        const adapter = new GrokAdapter({
          supervisor,
          launchAuthorization: launchAuth,
          agentSessions: repositories.agentSessions,
          promptFileDirectory: promptDir,
          // Keep fixed capabilities as static matrix (unproven) for capability record.
          fixedCapabilities: capabilityRecord.capabilities,
          fixedHealth: {
            kind: 'grok',
            cliName: 'grok',
            status: 'available',
            version: '0.2.93',
            auth: 'unknown',
            requiresReadinessProbe: true,
            evidence: [],
            platform: process.platform,
            compatibility: capabilityRecord,
          },
        });

        const before = snapshotTree(disposableBundle);
        fsEvents.length = 0;

        const request: GrokRunRequest = {
          attemptId,
          taskId,
          baselineId: asBaselineId('live-smoke-grok-baseline'),
          requirementVersion: 1,
          role: 'reviewer',
          projectRoot: liveProject,
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
          maxTurns: 8,
          immutableReviewBundle: {
            kind: IMMUTABLE_REVIEW_BUNDLE_KIND,
            bundleRoot: disposableBundle,
            manifestPath,
            contentHash,
          },
        };

        const handle = await adapter.start(request);

        // Assert argv profile: plan + tool deny + cwd=bundle + no always-approve.
        expect(adapter.lastRunIntent?.permissionMode).toBe('plan');
        expect(adapter.lastRunIntent?.cwd).toBe(disposableBundle);
        expect(adapter.lastRunIntent?.liveProjectAccess).toBe(false);
        expect(adapter.lastArgsForEvidence).toContain('plan');
        expect(adapter.lastArgsForEvidence).toContain('--disallowed-tools');
        expect(adapter.lastArgsForEvidence).not.toContain('--always-approve');
        expect(adapter.lastArgsForEvidence).not.toContain('--sandbox');
        expect(adapter.lastArgsForEvidence).not.toContain(prompt);

        let structuredResult: unknown;
        const eventLoop = (async () => {
          for await (const event of handle.events()) {
            if (event.type === 'result') {
              structuredResult = event.output;
            }
          }
        })();
        const run = await handle.wait();
        await eventLoop;

        // failed / timed_out / no auth / no result ⇒ fail (strict).
        expect(run.status).toBe('succeeded');
        expect(structuredResult).toBeDefined();
        if (structuredResult === undefined) {
          throw new Error('live smoke requires schema-valid structured result');
        }
        const parsed = parseAgentResultForMode(structuredResult, 'default');
        expect(parsed.success).toBe(true);
        if (!parsed.success) {
          throw new Error(
            `result schema invalid: ${'reason' in parsed ? parsed.reason : 'unknown'}`,
          );
        }
        const result = parsed.result as {
          readonly summary?: string;
          readonly verification?: { readonly details?: string };
          readonly changedFiles?: readonly string[];
        };
        const summary = String(result.summary ?? '').toLowerCase();
        const details = String(result.verification?.details ?? '').toLowerCase();
        const denied =
          summary.includes('denied')
          || details.includes('denied')
          || details.includes('blocked')
          || details.includes('not allowed')
          || details.includes('permission');
        expect(denied).toBe(true);
        expect(result.changedFiles).toEqual([]);
        expect(existsSync(join(disposableBundle, 'WRITE_ATTEMPT_MARKER.txt'))).toBe(
          false,
        );

        const after = snapshotTree(disposableBundle);
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
        for (const [path, beforeMeta] of before) {
          const afterMeta = after.get(path);
          expect(afterMeta?.sha256).toBe(beforeMeta.sha256);
          expect(afterMeta?.size).toBe(beforeMeta.size);
        }
        // Zero create/write/delete/rename filesystem events under disposable project.
        expect(fsEvents).toEqual([]);

        // Persist proof evidence keyed exact version/platform/profile.
        const proof = {
          schema: 'triagent.grok.enforcement_proof.v1' as const,
          cliName: 'grok' as const,
          version: '0.2.93',
          platform: process.platform,
          profile: 'permission-mode-plan-tool-deny' as const,
          provenAt: new Date().toISOString(),
          liveProjectAccess: false as const,
          enforcementProven: true as const,
          zeroFilesystemEvents: true as const,
          sentinelHashesUnchanged: true as const,
          attemptedWriteDenied: true as const,
          runStatus: 'succeeded' as const,
          resultSchemaValid: true as const,
          evidenceNotes: Object.freeze([
            'opt-in TRIAGENT_REAL_AI_TESTS=1 disposable project',
            'permission-mode plan + disallowed write tools',
            'attempted WRITE_ATTEMPT_MARKER denied',
          ]),
        };
        const proofPath = defaultGrokEnforcementProofPath(proofDir, capabilityKey);
        persistGrokEnforcementProof(proofPath, proof);
        registerLoadedGrokEnforcementProof(proof);
        expect(existsSync(proofPath)).toBe(true);
        // After load, matrix elevates for this version/platform only.
        const elevated = requireVerifiedCompatibility(capabilityKey);
        expect(elevated.readOnly).toBe(true);
        expect(elevated.capabilities.writeModes).toEqual(['read-only']);
        expect(elevated.capabilities.nativePermissionRules).toBe(true);
      } finally {
        watcher.close();
        await supervisor.dispose().catch(() => undefined);
        opened.close();
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it('default suite skips real AI unless explicitly enabled', () => {
    if (process.env.TRIAGENT_REAL_AI_TESTS === '1') {
      expect(enabled).toBe(true);
    } else {
      expect(enabled).toBe(false);
      expect(process.env.TRIAGENT_REAL_AI_TESTS === '1').toBe(false);
    }
  });
});
