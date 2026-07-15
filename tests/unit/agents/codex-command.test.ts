import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AdapterDisabledError,
  assertCodexRunBindings,
  buildCodexCommand,
  extractCodexPermissionProfile,
  type CodexCommandInput,
  type CodexRunIntent,
} from '../../../src/agents/codex/codex-command.js';
import { CodexAdapter } from '../../../src/agents/codex/codex-adapter.js';
import type { CodexRunRequest } from '../../../src/agents/codex/codex-adapter.js';
import {
  lookupCompatibility,
  requireVerifiedCompatibility,
  type CompatibilityKey,
  type WorkerStartGateRecord,
} from '../../../src/agents/compatibility-matrix.js';
import {
  deriveProbedCompatibilityRecord,
} from '../../../src/agents/compatibility-probe-manifests.js';
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

function verifiedKey(
  overrides: Partial<CompatibilityKey> = {},
): CompatibilityKey {
  return {
    cliName: 'codex',
    version: '0.144.1',
    platform: process.platform,
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<CodexCommandInput> = {},
): CodexCommandInput {
  const capabilityKey = verifiedKey();
  return {
    capabilityKey,
    capabilityRecord: requireVerifiedCompatibility(capabilityKey),
    projectRoot: PROJECT,
    role: 'implementer',
    mode: 'project_write',
    nonGit: false,
    schemaPath: SCHEMA,
    projectGuardDecisionId: 'guard-decision-1',
    reservedBudgetId: 'budget-reservation-1',
    budgetAttemptId: asAttemptId('attempt-codex-1'),
    operation: 'start',
    ...overrides,
  };
}

function gateFromIntent(intent: CodexRunIntent): WorkerStartGateRecord {
  return Object.freeze({
    capabilityKey: Object.freeze({ ...intent.capabilityKey }),
    projectGuardDecisionId: intent.projectGuardDecisionId,
    projectGuardMode: intent.mode,
    projectGuardAttemptId: intent.budgetAttemptId,
    reservedBudgetId: intent.reservedBudgetId,
    budgetCanLaunch: true as const,
    authStatus: 'authenticated' as const,
    requiresReadinessProbe: false,
    readinessProbeCompleted: false,
  });
}

describe('buildCodexCommand (Codex CLI 0.144.1)', () => {
  it('can omit --output-schema for custom providers that 502 on structured output', () => {
    const built = buildCodexCommand(baseInput({ emitOutputSchema: false }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.args).toContain('--json');
    expect(built.args).not.toContain('--output-schema');
    expect(built.args.at(-1)).toBe('-');
  });

  it('builds the exact implementer start contract as a structural argv array', () => {
    const built = buildCodexCommand(baseInput());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.executable).toBe('codex');
    expect(built.args).toEqual([
      '-a',
      'never',
      'exec',
      '-C',
      PROJECT,
      '-s',
      'workspace-write',
      '--json',
      '--output-schema',
      SCHEMA,
      '-',
    ]);
    // Structural command — never a shell string.
    expect(built.args.every((part) => typeof part === 'string')).toBe(true);
    expect(built.args.join(' ')).not.toMatch(/&&|\||;|`/);
  });

  it('accepts a newer version record after the current command contract was probed', () => {
    const capabilityKey = verifiedKey({ version: '0.145.0' });
    const built = buildCodexCommand(baseInput({
      capabilityKey,
      capabilityRecord: deriveProbedCompatibilityRecord(capabilityKey),
    }));

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.intent.capabilityKey).toEqual(capabilityKey);
    expect(built.args).toContain('--json');
    expect(built.args).toContain('--output-schema');
  });

  it('adds --skip-git-repo-check only when nonGit is verified', () => {
    const withNonGit = buildCodexCommand(baseInput({ nonGit: true }));
    expect(withNonGit.ok).toBe(true);
    if (!withNonGit.ok) return;
    expect(withNonGit.args).toContain('--skip-git-repo-check');
    expect(withNonGit.intent.nonGit).toBe(true);

    const gitProject = buildCodexCommand(baseInput({ nonGit: false }));
    expect(gitProject.ok).toBe(true);
    if (!gitProject.ok) return;
    expect(gitProject.args).not.toContain('--skip-git-repo-check');
  });

  it('uses read-only sandbox for reviewer and master', () => {
    for (const role of ['reviewer', 'master'] as const) {
      const built = buildCodexCommand(
        baseInput({ role, mode: 'read_only' }),
      );
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.args).toEqual([
        '-a',
        'never',
        'exec',
        '-C',
        PROJECT,
        '-s',
        'read-only',
        '--json',
        '--output-schema',
        SCHEMA,
        '-',
      ]);
      expect(built.intent.sandbox).toBe('read-only');
    }
  });

  it('uses read-only sandbox for implementer patch_mode (PatchApplier is sole writer)', () => {
    const built = buildCodexCommand(
      baseInput({ mode: 'patch_mode' }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.args).toContain('read-only');
    expect(built.args).not.toContain('workspace-write');
    expect(built.intent.sandbox).toBe('read-only');
    expect(built.intent.mode).toBe('patch_mode');
    expect(built.intent.structuredPatchRequired).toBe(true);
    // Patch mode must use the strict patch-result schema (not project-write).
    expect(built.args).toContain(
      resolve('schemas/agent-patch-result.schema.json'),
    );
    expect(built.intent.schemaPath).toMatch(/agent-patch-result\.schema\.json$/);
  });

  it('never emits dangerously-bypass or ephemeral flags', () => {
    const start = buildCodexCommand(baseInput());
    const resume = buildCodexCommand(
      baseInput({
        operation: 'resume',
        conversationId: 'conversation-abc',
      }),
    );
    for (const built of [start, resume]) {
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const joined = built.args.join(' ');
      expect(joined).not.toMatch(/dangerously-bypass/i);
      expect(joined).not.toMatch(/--ephemeral\b/);
      expect(built.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(built.args).not.toContain('--ephemeral');
    }
  });

  it('builds resume with global options before exec resume and reapplied constraints', () => {
    const start = buildCodexCommand(
      baseInput({
        nonGit: true,
        mode: 'project_write',
        role: 'implementer',
      }),
    );
    expect(start.ok).toBe(true);
    if (!start.ok) return;

    const resume = buildCodexCommand(
      baseInput({
        operation: 'resume',
        conversationId: 'conversation-xyz',
        nonGit: true,
        mode: 'project_write',
        role: 'implementer',
      }),
    );
    expect(resume.ok).toBe(true);
    if (!resume.ok) return;

    expect(resume.args).toEqual([
      '-C',
      PROJECT,
      '-s',
      'workspace-write',
      '-a',
      'never',
      '--skip-git-repo-check',
      'exec',
      'resume',
      'conversation-xyz',
      '--json',
      '--output-schema',
      SCHEMA,
      '-',
    ]);

    const startProfile = extractCodexPermissionProfile(start);
    const resumeProfile = extractCodexPermissionProfile(resume);
    expect(resumeProfile).toEqual(startProfile);
    // Resume must not be weaker than start.
    expect(resumeProfile.sandbox).toBe(startProfile.sandbox);
    expect(resumeProfile.approval).toBe(startProfile.approval);
    expect(resumeProfile.schemaPath).toBe(startProfile.schemaPath);
    expect(resumeProfile.nonGit).toBe(startProfile.nonGit);
    expect(resumeProfile.projectRoot).toBe(startProfile.projectRoot);
    expect(resumeProfile.json).toBe(true);
  });

  it('proves resume reviewer/master profile is not weaker than start', () => {
    const start = buildCodexCommand(
      baseInput({ role: 'reviewer', mode: 'read_only', nonGit: true }),
    );
    const resume = buildCodexCommand(
      baseInput({
        role: 'reviewer',
        mode: 'read_only',
        nonGit: true,
        operation: 'resume',
        conversationId: 'conversation-review',
      }),
    );
    expect(start.ok && resume.ok).toBe(true);
    if (!start.ok || !resume.ok) return;
    expect(extractCodexPermissionProfile(resume)).toEqual(
      extractCodexPermissionProfile(start),
    );
    expect(resume.args).toContain('read-only');
    expect(resume.args).toContain('--skip-git-repo-check');
  });

  it('persists capability key, guard decision, budget reservation, role/mode/schema/nonGit on run intent', () => {
    const built = buildCodexCommand(
      baseInput({
        nonGit: true,
        mode: 'patch_mode',
        role: 'implementer',
      }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.intent).toMatchObject({
      capabilityKey: verifiedKey(),
      projectGuardDecisionId: 'guard-decision-1',
      reservedBudgetId: 'budget-reservation-1',
      budgetAttemptId: 'attempt-codex-1',
      role: 'implementer',
      mode: 'patch_mode',
      sandbox: 'read-only',
      schemaPath: resolve('schemas/agent-patch-result.schema.json'),
      nonGit: true,
      projectRoot: PROJECT,
      operation: 'start',
    });
  });

  it('returns AdapterDisabled for unverified codex version/platform', () => {
    const unknownVersion = lookupCompatibility({
      cliName: 'codex',
      version: '9.9.9',
      platform: process.platform,
    });
    expect(unknownVersion).toBeUndefined();

    const built = buildCodexCommand(
      baseInput({
        capabilityKey: {
          cliName: 'codex',
          version: '9.9.9',
          platform: process.platform,
        },
        capabilityRecord: undefined,
      }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/unverified|disabled|0\.144\.1/i);
    expect(() => {
      throw new AdapterDisabledError(built.reason);
    }).toThrow(AdapterDisabledError);
  });

  it('returns AdapterDisabled when capability record does not match key', () => {
    const key = verifiedKey();
    const record = requireVerifiedCompatibility(key);
    const built = buildCodexCommand(
      baseInput({
        capabilityKey: {
          cliName: 'codex',
          version: '9.9.9',
          platform: process.platform,
        },
        capabilityRecord: record,
      }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
  });

  it('rejects run intent bindings that do not match Task13 start gate', () => {
    const built = buildCodexCommand(baseInput());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const gate = gateFromIntent(built.intent);
    expect(() => assertCodexRunBindings(built.intent, gate)).not.toThrow();

    expect(() =>
      assertCodexRunBindings(built.intent, {
        ...gate,
        projectGuardDecisionId: 'other-guard',
      }),
    ).toThrow(/projectGuardDecisionId|guard/i);

    expect(() =>
      assertCodexRunBindings(built.intent, {
        ...gate,
        reservedBudgetId: 'other-budget',
      }),
    ).toThrow(/reservedBudgetId|budget/i);

    expect(() =>
      assertCodexRunBindings(built.intent, {
        ...gate,
        capabilityKey: {
          cliName: 'claude',
          version: '2.1.206',
          platform: process.platform,
        },
      }),
    ).toThrow(/capability/i);

    expect(() =>
      assertCodexRunBindings(
        { ...built.intent, mode: 'read_only' },
        gate,
      ),
    ).toThrow(/mode|projectGuardMode/i);
  });

  it('rejects resume without conversation id', () => {
    const built = buildCodexCommand(
      baseInput({ operation: 'resume' }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/conversation/i);
  });

  it('rejects nonGit when capability record does not verify nonGit', () => {
    const key = verifiedKey();
    const record = requireVerifiedCompatibility(key);
    // Forge a record that disables nonGit (should not happen for 0.144.1, but builder must check).
    const forged = Object.freeze({
      ...record,
      nonGit: false,
      capabilities: Object.freeze({
        ...record.capabilities,
        nonGitProjects: false,
      }),
    });
    const built = buildCodexCommand(
      baseInput({
        nonGit: true,
        capabilityRecord: forged,
      }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/nonGit|skip-git/i);
  });
});

describe('CodexAdapter ProcessSupervisorPort path', () => {
  const temporaryDirectories: string[] = [];
  const openedDatabases: OpenedDatabase[] = [];
  const TASK_ID = asTaskId('task-adapter-codex-1');
  const previousForceSchema = process.env.TRIAGENT_CODEX_FORCE_OUTPUT_SCHEMA;
  const previousOmitSchema = process.env.TRIAGENT_CODEX_OMIT_OUTPUT_SCHEMA;

  beforeEach(() => {
    // Unit fixtures expect the official --output-schema argv contract regardless
    // of the developer's local custom Codex provider config.
    process.env.TRIAGENT_CODEX_FORCE_OUTPUT_SCHEMA = '1';
    delete process.env.TRIAGENT_CODEX_OMIT_OUTPUT_SCHEMA;
  });

  afterEach(() => {
    if (previousForceSchema === undefined) {
      delete process.env.TRIAGENT_CODEX_FORCE_OUTPUT_SCHEMA;
    } else {
      process.env.TRIAGENT_CODEX_FORCE_OUTPUT_SCHEMA = previousForceSchema;
    }
    if (previousOmitSchema === undefined) {
      delete process.env.TRIAGENT_CODEX_OMIT_OUTPUT_SCHEMA;
    } else {
      process.env.TRIAGENT_CODEX_OMIT_OUTPUT_SCHEMA = previousOmitSchema;
    }
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

  function openAuthRepo(): LaunchAuthorizationRepository {
    const directory = mkdtempSync(join(tmpdir(), 'triagent-codex-cmd-'));
    temporaryDirectories.push(directory);
    const opened = openDatabase(join(directory, 'triagent.sqlite'));
    openedDatabases.push(opened);
    if (opened.mode !== 'read-write') {
      throw new Error(opened.diagnostics.error);
    }
    return new LaunchAuthorizationRepository(
      (opened as ReadWriteDatabase).connection,
    );
  }

  function issueAuth(
    repo: LaunchAuthorizationRepository,
    request: CodexRunRequest,
  ): string {
    return repo.issue(
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
        nowIso: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    ).authorizationId;
  }

  function runRequest(
    overrides: Partial<CodexRunRequest> = {},
  ): CodexRunRequest {
    const capabilityKey = verifiedKey();
    const attemptId = overrides.attemptId ?? asAttemptId('attempt-adapter-codex-1');
    const mode = overrides.mode ?? 'project_write';
    const projectGuardDecisionId =
      overrides.projectGuardDecisionId ?? 'guard-decision-1';
    const reservedBudgetId =
      overrides.reservedBudgetId ?? 'budget-reservation-1';
    return {
      attemptId,
      taskId: TASK_ID,
      baselineId: asBaselineId('baseline-adapter-codex-1'),
      requirementVersion: 1,
      role: 'implementer',
      projectRoot: PROJECT,
      prompt: 'Return structured result only.',
      capabilityKey,
      projectGuardDecisionId,
      reservedBudgetId,
      mode,
      nonGit: false,
      schemaPath: SCHEMA,
      capabilityRecord: requireVerifiedCompatibility(capabilityKey),
      ...overrides,
    };
  }

  it('starts via ProcessSupervisorPort with exact structural argv (no raw spawn)', async () => {
    const clock = new FakeClock('2026-07-12T03:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 7101,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 7101 } },
        {
          afterMs: 1,
          event: {
            type: 'exited',
            pid: 7101,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const launchAuth = openAuthRepo();
    const adapter = new CodexAdapter({
      supervisor,
      launchAuthorization: launchAuth,
    });
    const base = runRequest();
    const request = runRequest({
      launchAuthorizationId: issueAuth(launchAuth, base),
    });
    const handle = await adapter.start(request);
    clock.advanceBy(5);

    const startCall = supervisor.calls.find((call) => call.type === 'start');
    expect(startCall).toBeDefined();
    if (startCall?.type !== 'start') return;
    expect(startCall.request.executable).toBe('codex');
    expect(startCall.request.args).toEqual([
      '-a',
      'never',
      'exec',
      '-C',
      PROJECT,
      '-s',
      'workspace-write',
      '--json',
      '--output-schema',
      SCHEMA,
      '-',
    ]);
    expect(startCall.request.cwd).toBe(PROJECT);
    expect(startCall.request.stdin).toEqual({
      encoding: 'utf8',
      data: request.prompt,
      closeAfterWrite: true,
    });
    expect(startCall.request.args.join('\0')).not.toContain(request.prompt);
    expect(adapter.lastRunIntent?.projectGuardDecisionId).toBe('guard-decision-1');
    expect(adapter.lastRunIntent?.reservedBudgetId).toBe('budget-reservation-1');
    await handle.wait();
  });

  it('resume reuses identical permission profile and is not weaker than start', async () => {
    const clock = new FakeClock('2026-07-12T03:10:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 7201,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 7201 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 7201,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
      {
        pid: 7202,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 7202 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 7202,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
    ]);
    const launchAuth = openAuthRepo();
    const adapter = new CodexAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
    });

    const startBase = runRequest({ nonGit: true });
    const startReq = runRequest({
      nonGit: true,
      launchAuthorizationId: issueAuth(launchAuth, startBase),
    });
    await adapter.start(startReq);
    const startArgs = supervisor.calls.find((c) => c.type === 'start');
    if (startArgs?.type !== 'start') throw new Error('missing start');
    const startIntent = adapter.lastRunIntent;

    const resumeBase = runRequest({
      attemptId: asAttemptId('attempt-adapter-codex-2'),
      nonGit: true,
    });
    const resumeReq = runRequest({
      attemptId: asAttemptId('attempt-adapter-codex-2'),
      nonGit: true,
      launchAuthorizationId: issueAuth(launchAuth, resumeBase),
    });
    await adapter.resume(asConversationId('conversation-resume-1'), resumeReq);
    const starts = supervisor.calls.filter((c) => c.type === 'start');
    expect(starts).toHaveLength(2);
    const resumeCall = starts[1];
    if (resumeCall?.type !== 'start') return;

    expect(resumeCall.request.args).toEqual([
      '-C',
      PROJECT,
      '-s',
      'workspace-write',
      '-a',
      'never',
      '--skip-git-repo-check',
      'exec',
      'resume',
      'conversation-resume-1',
      '--json',
      '--output-schema',
      SCHEMA,
      '-',
    ]);
    expect(adapter.lastRunIntent?.sandbox).toBe(startIntent?.sandbox);
    expect(adapter.lastRunIntent?.approval).toBe(startIntent?.approval);
    expect(adapter.lastRunIntent?.nonGit).toBe(true);
    expect(resumeCall.request.args).not.toContain('--ephemeral');
    expect(resumeCall.request.args).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('rejects start when launch authorization intent bindings mismatch', async () => {
    const clock = new FakeClock('2026-07-12T03:20:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 7301,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 7301 } },
        {
          afterMs: 1,
          event: {
            type: 'exited',
            pid: 7301,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const launchAuth = openAuthRepo();
    const adapter = new CodexAdapter({
      supervisor,
      launchAuthorization: launchAuth,
    });
    const matching = runRequest();
    const authId = issueAuth(launchAuth, matching);

    await expect(
      adapter.start(
        runRequest({
          launchAuthorizationId: authId,
          reservedBudgetId: 'wrong-budget',
        }),
      ),
    ).rejects.toThrow(/budget|reservedBudgetId|mismatch|authorization|intent/i);

    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(0);
  });

  it('throws AdapterDisabled for unverified capability key', async () => {
    const clock = new FakeClock('2026-07-12T03:30:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const launchAuth = openAuthRepo();
    const adapter = new CodexAdapter({
      supervisor,
      launchAuthorization: launchAuth,
    });
    const bad = runRequest({
      capabilityKey: {
        cliName: 'codex',
        version: '0.0.1',
        platform: process.platform,
      },
      capabilityRecord: undefined,
    });
    // Issue auth for a verified key so failure is capability, not missing auth.
    // Actually unverified capability fails at buildCodexCommand before auth.
    await expect(adapter.start(bad)).rejects.toBeInstanceOf(AdapterDisabledError);
  });
});
