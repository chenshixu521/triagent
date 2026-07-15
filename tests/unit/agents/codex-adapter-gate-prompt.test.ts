import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../../src/agents/codex/codex-adapter.js';
import type { CodexRunRequest } from '../../../src/agents/codex/codex-adapter.js';
import {
  requireVerifiedCompatibility,
  type CompatibilityKey,
} from '../../../src/agents/compatibility-matrix.js';
import {
  LaunchAuthorizationRepository,
} from '../../../src/agents/launch-authorization-repository.js';
import {
  asAttemptId,
  asBaselineId,
  asConversationId,
  asTaskId,
} from '../../../src/domain/ids.js';
import {
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';

const SCHEMA = resolve('schemas/agent-result.schema.json');
const PROJECT = 'D:\\temporary project\\demo';
const TASK_ID = asTaskId('task-gate-prompt-1');

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-gate-prompt-'));
  temporaryDirectories.push(directory);
  return directory;
}

function requireReadWrite(opened: OpenedDatabase): ReadWriteDatabase {
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return opened;
}

function openAuthRepo(): LaunchAuthorizationRepository {
  const directory = temporaryDirectory();
  const opened = openDatabase(join(directory, 'triagent.sqlite'));
  openedDatabases.push(opened);
  return new LaunchAuthorizationRepository(requireReadWrite(opened).connection);
}

function verifiedKey(): CompatibilityKey {
  return {
    cliName: 'codex',
    version: '0.144.1',
    platform: process.platform,
  };
}

function issueAuth(
  repo: LaunchAuthorizationRepository,
  request: CodexRunRequest,
): string {
  const nowMs = Date.now();
  const issued = repo.issue(
    {
      taskId: request.taskId ?? TASK_ID,
      attemptId: request.attemptId,
      adapterKind: 'codex',
      adapterVersion: request.capabilityKey.version,
      adapterPlatform: request.capabilityKey.platform,
      role: request.role,
      mode: request.mode,
      guardDecisionId: request.projectGuardDecisionId,
      budgetReservationId: request.reservedBudgetId,
      schemaPath: request.schemaPath ?? SCHEMA,
      nonGit: request.nonGit,
    },
    {
      nowIso: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 60 * 60_000).toISOString(),
    },
  );
  return issued.authorizationId;
}

function runRequest(
  overrides: Partial<CodexRunRequest> = {},
): CodexRunRequest {
  const capabilityKey = verifiedKey();
  return {
    attemptId: asAttemptId('attempt-gate-prompt-1'),
    taskId: TASK_ID,
    baselineId: asBaselineId('baseline-gate-prompt-1'),
    requirementVersion: 1,
    role: 'implementer',
    projectRoot: PROJECT,
    prompt: 'SECRET_PROMPT_TOKEN_do_not_put_in_argv',
    capabilityKey,
    projectGuardDecisionId: 'guard-decision-1',
    reservedBudgetId: 'budget-reservation-1',
    mode: 'project_write',
    nonGit: false,
    schemaPath: SCHEMA,
    capabilityRecord: requireVerifiedCompatibility(capabilityKey),
    ...overrides,
  };
}

function plan(pid: number) {
  return {
    pid,
    timeline: [
      { afterMs: 0, event: { type: 'started' as const, pid } },
      {
        afterMs: 1,
        event: {
          type: 'exited' as const,
          pid,
          exitCode: 0,
          signal: null,
          reason: 'exited' as const,
        },
      },
    ],
  };
}

afterEach(() => {
  while (openedDatabases.length > 0) {
    openedDatabases.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('CodexAdapter mandatory launch authorization + prompt stdin', () => {
  it('fails closed with zero ProcessSupervisor start when launchAuthorizationId is missing', async () => {
    const clock = new FakeClock('2026-07-12T05:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [plan(8101)]);
    const launchAuth = openAuthRepo();
    const adapter = new CodexAdapter({ supervisor, launchAuthorization: launchAuth });

    await expect(
      adapter.start(runRequest({ launchAuthorizationId: undefined })),
    ).rejects.toThrow(
      /launchAuthorizationId|authorization|start.?gate|prerequisite/i,
    );
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(0);
  });

  it('fails closed when authorization intent bindings mismatch (zero start)', async () => {
    const clock = new FakeClock('2026-07-12T05:05:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [plan(8102)]);
    const launchAuth = openAuthRepo();
    const adapter = new CodexAdapter({ supervisor, launchAuthorization: launchAuth });
    const request = runRequest();
    const authId = issueAuth(launchAuth, request);

    await expect(
      adapter.start(
        runRequest({
          launchAuthorizationId: authId,
          reservedBudgetId: 'wrong-budget',
        }),
      ),
    ).rejects.toThrow(/budget|mismatch|authorization|intent/i);

    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(0);
  });

  it('delivers prompt via one-shot stdin (not argv) when authorization is verified', async () => {
    const clock = new FakeClock('2026-07-12T05:10:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [plan(8103)]);
    const launchAuth = openAuthRepo();
    const adapter = new CodexAdapter({ supervisor, launchAuthorization: launchAuth });
    const requestBase = runRequest({
      prompt: 'Exact prompt for Codex stdin delivery',
    });
    const request = runRequest({
      prompt: 'Exact prompt for Codex stdin delivery',
      launchAuthorizationId: issueAuth(launchAuth, requestBase),
    });
    const handle = await adapter.start(request);

    const start = supervisor.calls.find((c) => c.type === 'start');
    expect(start?.type).toBe('start');
    if (start?.type !== 'start') return;

    expect(start.request.args.at(-1)).toBe('-');
    expect(start.request.args.join('\0')).not.toContain(request.prompt);
    expect(start.request.stdin).toEqual({
      encoding: 'utf8',
      data: request.prompt,
      closeAfterWrite: true,
    });
    // No shell.
    expect(start.request.executable).toBe('codex');
    expect(start.request.args.every((part) => typeof part === 'string')).toBe(
      true,
    );
    clock.advanceBy(5);
    await handle.wait();
  });

  it('resume re-requires fresh authorization and re-delivers prompt on stdin', async () => {
    const clock = new FakeClock('2026-07-12T05:15:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      plan(8201),
      plan(8202),
    ]);
    const launchAuth = openAuthRepo();
    const adapter = new CodexAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
    });

    const startReq = runRequest({
      prompt: 'start-prompt-body',
    });
    await adapter.start(
      runRequest({
        prompt: 'start-prompt-body',
        launchAuthorizationId: issueAuth(launchAuth, startReq),
      }),
    );

    const resumeReq = runRequest({
      attemptId: asAttemptId('attempt-gate-prompt-2'),
      prompt: 'resume-prompt-body',
      launchAuthorizationId: undefined,
    });

    // Missing authorization on resume → zero additional start.
    await expect(
      adapter.resume(asConversationId('conversation-1'), resumeReq),
    ).rejects.toThrow(/launchAuthorizationId|authorization|start.?gate/i);
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(1);

    const resumeWithAuth = runRequest({
      attemptId: asAttemptId('attempt-gate-prompt-2'),
      prompt: 'resume-prompt-body',
    });
    await adapter.resume(
      asConversationId('conversation-1'),
      runRequest({
        attemptId: asAttemptId('attempt-gate-prompt-2'),
        prompt: 'resume-prompt-body',
        launchAuthorizationId: issueAuth(launchAuth, resumeWithAuth),
      }),
    );
    const starts = supervisor.calls.filter((c) => c.type === 'start');
    expect(starts).toHaveLength(2);
    const resumeStart = starts[1];
    if (resumeStart?.type !== 'start') return;
    expect(resumeStart.request.stdin).toEqual({
      encoding: 'utf8',
      data: 'resume-prompt-body',
      closeAfterWrite: true,
    });
    expect(resumeStart.request.args.join('\0')).not.toContain(
      'resume-prompt-body',
    );
  });
});
