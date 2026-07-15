import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AdapterDisabledError,
  assertClaudeRunBindings,
  buildClaudeCommand,
  CLAUDE_JSON_SCHEMA_MAX_BYTES,
  CLAUDE_PROJECT_WRITE_AUTO_PROVEN,
  CLAUDE_VERIFIED_DISALLOWED_WRITE_TOOLS,
  CLAUDE_VERIFIED_READ_ONLY_TOOLS,
  extractClaudePermissionProfile,
  isValidClaudeSessionUuid,
  loadClaudeJsonSchemaContent,
  type ClaudeCommandInput,
  type ClaudeRunIntent,
  VERIFIED_CLAUDE_VERSION,
} from '../../../src/agents/claude/claude-command.js';
import { ClaudeAdapter } from '../../../src/agents/claude/claude-adapter.js';
import type { ClaudeRunRequest } from '../../../src/agents/claude/claude-adapter.js';
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
  AgentSessionRepository,
} from '../../../src/persistence/agent-session-repository.js';
import {
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import { TaskRepository } from '../../../src/persistence/task-repository.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';

const SCHEMA = resolve('schemas/agent-result.schema.json');
const PATCH_SCHEMA = resolve('schemas/agent-patch-result.schema.json');
const PROJECT = 'D:\\temporary project\\demo';
const FIXED_SESSION = '11111111-2222-4333-8444-555555555555';
const PROMPT = 'Return structured result only. secret-token-xyz';

function expectedSchemaContent(schemaPath: string): string {
  return loadClaudeJsonSchemaContent(schemaPath).content;
}

function verifiedKey(
  overrides: Partial<CompatibilityKey> = {},
): CompatibilityKey {
  return {
    cliName: 'claude',
    version: VERIFIED_CLAUDE_VERSION,
    platform: process.platform,
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<ClaudeCommandInput> = {},
): ClaudeCommandInput {
  const capabilityKey = verifiedKey();
  return {
    capabilityKey,
    capabilityRecord: requireVerifiedCompatibility(capabilityKey),
    projectRoot: PROJECT,
    role: 'implementer',
    mode: 'patch_mode',
    nonGit: false,
    schemaPath: SCHEMA,
    projectGuardDecisionId: 'guard-decision-1',
    reservedBudgetId: 'budget-reservation-1',
    budgetAttemptId: asAttemptId('attempt-claude-1'),
    operation: 'start',
    sessionId: FIXED_SESSION,
    prompt: PROMPT,
    ...overrides,
  };
}

function gateFromIntent(intent: ClaudeRunIntent): WorkerStartGateRecord {
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

describe('buildClaudeCommand (Claude Code 2.1.206)', () => {
  it('accepts a newer version record after the current command contract was probed', () => {
    const capabilityKey = verifiedKey({ version: '2.2.0' });
    const built = buildClaudeCommand(baseInput({
      capabilityKey,
      capabilityRecord: deriveProbedCompatibilityRecord(capabilityKey),
    }));

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.intent.capabilityKey).toEqual(capabilityKey);
    expect(built.args).toContain('--output-format');
    expect(built.args).toContain('stream-json');
  });

  it('builds the exact implementer patch_mode start contract as structural argv', () => {
    const built = buildClaudeCommand(baseInput());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const patchSchemaContent = expectedSchemaContent(PATCH_SCHEMA);
    expect(built.executable).toBe('claude');
    expect(built.args[0]).toBe('-p');
    expect(built.args).toContain('--safe-mode');
    expect(built.args).toContain('--output-format');
    expect(built.args).toContain('stream-json');
    expect(built.args).toContain('--verbose');
    expect(built.args).toContain('--input-format');
    expect(built.args).toContain('text');
    expect(built.args).toContain('--session-id');
    expect(built.args).toContain(FIXED_SESSION);
    expect(built.args).toContain('--json-schema');
    const schemaIdx = built.args.indexOf('--json-schema');
    expect(built.args[schemaIdx + 1]).toBe(patchSchemaContent);
    // Content, not a filesystem path (Claude 2.1.206 help: JSON Schema content).
    expect(built.args[schemaIdx + 1]).not.toBe(PATCH_SCHEMA);
    expect(built.args[schemaIdx + 1]).not.toBe(SCHEMA);
    expect(built.args[schemaIdx + 1]?.startsWith('{')).toBe(true);
    expect(built.args[schemaIdx + 1]).not.toMatch(/agent-patch-result\.schema\.json$/);
    expect(built.args).toContain('--permission-mode');
    expect(built.args).toContain('auto');
    expect(built.args).toContain('--tools');
    expect(built.args).toContain(CLAUDE_VERIFIED_READ_ONLY_TOOLS.join(','));
    expect(built.args).toContain('--disallowedTools');
    expect(built.args).toContain(
      CLAUDE_VERIFIED_DISALLOWED_WRITE_TOOLS.join(','),
    );
    expect(built.args).toContain('--add-dir');
    expect(built.args).toContain(PROJECT);
    // Prompt is never in argv / process list (stdin delivery).
    expect(built.args).not.toContain(PROMPT);
    expect(built.args.every((part) => !part.includes('secret-token-xyz'))).toBe(
      true,
    );
    // Structural command — never a shell string (argv array, not shell metacharacters as operators).
    expect(built.args.every((part) => typeof part === 'string')).toBe(true);
    expect(Array.isArray(built.args)).toBe(true);
    // No shell chaining operators as standalone argv tokens.
    expect(built.args).not.toContain('&&');
    expect(built.args).not.toContain('|');
    expect(built.args).not.toContain(';');
    expect(built.args).not.toContain('`');
    // include-partial-messages stays disabled.
    expect(built.args).not.toContain('--include-partial-messages');
    expect(built.intent.structuredPatchRequired).toBe(true);
    expect(built.intent.mode).toBe('patch_mode');
    expect(built.intent.promptDelivery).toBe('stdin');
    expect(built.intent.schemaContent).toBe(patchSchemaContent);
    // Evidence redacts schema content (not a path leak of secrets either).
    const evidenceSchemaIdx = built.argsForEvidence.indexOf('--json-schema');
    expect(built.argsForEvidence[evidenceSchemaIdx + 1]).toBe(
      '[REDACTED_JSON_SCHEMA]',
    );
    expect(built.argsForEvidence.join(' ')).not.toContain('secret-token-xyz');
  });

  it('offline CLI help proves --json-schema expects content and --safe-mode / --input-format exist', () => {
    let help = '';
    // Windows npm shims are *.cmd; invoke via cmd.exe without shell:true (no DEP0190).
    try {
      help = execFileSync(
        process.platform === 'win32' ? 'cmd.exe' : 'claude',
        process.platform === 'win32'
          ? ['/d', '/s', '/c', 'claude --help']
          : ['--help'],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      );
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      help = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    expect(help.length).toBeGreaterThan(100);
    expect(help).toMatch(/--json-schema\s+<schema>/i);
    expect(help).toMatch(/JSON Schema for structured output/i);
    expect(help).toMatch(/Example:\s*\{"type":"object"/i);
    expect(help).toMatch(/--safe-mode/i);
    expect(help).toMatch(/CLAUDE\.md|hooks|MCP|plugins|skills/i);
    expect(help).toMatch(/--input-format\s+<format>/i);
    expect(help).toMatch(/"text"\s*\(default\)/i);
  });

  it('loads and canonical-serializes only allowlisted result/patch schemas', () => {
    const result = loadClaudeJsonSchemaContent(SCHEMA);
    expect(result.content).toContain('"type":"object"');
    expect(JSON.parse(result.content)).toMatchObject({ type: 'object' });
    expect(result.byteLength).toBeLessThanOrEqual(CLAUDE_JSON_SCHEMA_MAX_BYTES);
    expect(result.schemaPath).toBe(resolve(SCHEMA));

    const patch = loadClaudeJsonSchemaContent(PATCH_SCHEMA);
    expect(patch.content).toContain('unifiedDiff');
    expect(JSON.parse(patch.content)).toMatchObject({ type: 'object' });

    // Reject arbitrary project-controlled files.
    const temp = mkdtempSync(join(tmpdir(), 'triagent-claude-schema-'));
    try {
      const evil = join(temp, 'evil.schema.json');
      writeFileSync(evil, JSON.stringify({ type: 'object' }), 'utf8');
      expect(() => loadClaudeJsonSchemaContent(evil)).toThrow(
        /allowlist|schema|AdapterDisabled/i,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }

    expect(() => loadClaudeJsonSchemaContent('')).toThrow(/schema/i);
  });

  it('emits a Claude-compatible schema and only current-CLI-known deny tool names', () => {
    const source = JSON.parse(readFileSync(SCHEMA, 'utf8')) as Record<string, unknown>;
    expect(source.$schema).toBe('https://json-schema.org/draft/2020-12/schema');

    const loaded = loadClaudeJsonSchemaContent(SCHEMA);
    const emitted = JSON.parse(loaded.content) as Record<string, unknown>;
    expect(emitted).not.toHaveProperty('$schema');
    expect(emitted).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(CLAUDE_VERIFIED_DISALLOWED_WRITE_TOOLS).toEqual([
      'Edit',
      'Write',
      'Bash',
    ]);
    expect(CLAUDE_VERIFIED_DISALLOWED_WRITE_TOOLS).not.toContain('MultiEdit');
  });

  it('rejects invalid or oversized schema content before start', () => {
    // Non-allowlisted basename (not result/patch contract).
    const builtMissing = buildClaudeCommand(
      baseInput({
        role: 'reviewer',
        mode: 'read_only',
        schemaPath: resolve('schemas/does-not-exist.schema.json'),
      }),
    );
    expect(builtMissing.ok).toBe(false);
    if (builtMissing.ok) return;
    expect(builtMissing.code).toBe('AdapterDisabled');
    expect(builtMissing.reason).toMatch(/schema|allowlist/i);

    // Oversized content must fail closed.
    expect(CLAUDE_JSON_SCHEMA_MAX_BYTES).toBeLessThanOrEqual(256 * 1024);
  });

  it('uses Read,Glob,Grep only for reviewer and master (no Edit/Write/Bash)', () => {
    for (const role of ['reviewer', 'master'] as const) {
      const built = buildClaudeCommand(
        baseInput({ role, mode: 'read_only', schemaPath: SCHEMA }),
      );
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.args).toContain('--safe-mode');
      const toolsIdx = built.args.indexOf('--tools');
      expect(toolsIdx).toBeGreaterThan(-1);
      const tools = built.args[toolsIdx + 1] ?? '';
      expect(tools).toBe('Read,Glob,Grep');
      expect(tools).not.toMatch(/Edit|Write|Bash/i);
      const denied = built.args[built.args.indexOf('--disallowedTools') + 1] ?? '';
      expect(denied).toMatch(/Edit/);
      expect(denied).toMatch(/Write/);
      expect(denied).toMatch(/Bash/);
      // schemaPath on intent is the resolved allowlisted path; argv carries content.
      expect(built.intent.schemaPath).toBe(resolve(SCHEMA));
      expect(built.args[built.args.indexOf('--json-schema') + 1]).toBe(
        expectedSchemaContent(SCHEMA),
      );
      expect(built.intent.structuredPatchRequired).toBe(false);
      expect(built.intent.mode).toBe('read_only');
      // No customization bypass / load flags.
      expect(built.args).not.toContain('--mcp-config');
      expect(built.args).not.toContain('--plugin-dir');
      expect(built.args).not.toContain('--plugin-url');
      expect(built.args).not.toContain('--settings');
      expect(built.args).not.toContain('--setting-sources');
      expect(built.args).not.toContain('--agents');
      expect(built.args).not.toContain('--agent');
    }
  });

  it('disables implementer project_write auto when write profile is not proven', () => {
    expect(CLAUDE_PROJECT_WRITE_AUTO_PROVEN).toBe(false);
    const built = buildClaudeCommand(
      baseInput({ mode: 'project_write', role: 'implementer' }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/project-write|patch_mode|not proven/i);
  });

  it('maps implementer auto_allowed to patch_mode (preferred fallback)', () => {
    const built = buildClaudeCommand(
      baseInput({ mode: 'auto_allowed', role: 'implementer' }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.intent.mode).toBe('patch_mode');
    expect(built.intent.structuredPatchRequired).toBe(true);
    expect(built.args[built.args.indexOf('--json-schema') + 1]).toBe(
      expectedSchemaContent(PATCH_SCHEMA),
    );
    expect(built.args).toContain('Read,Glob,Grep');
    expect(built.args).toContain('--safe-mode');
  });

  it('never emits dangerously-skip-permissions or customization bypass flags', () => {
    const start = buildClaudeCommand(baseInput());
    const resume = buildClaudeCommand(
      baseInput({
        operation: 'resume',
        conversationId: 'conversation-abc',
      }),
    );
    for (const built of [start, resume]) {
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const joined = built.args.join(' ');
      expect(joined).not.toMatch(/dangerously-skip-permissions/i);
      expect(built.args).not.toContain('--dangerously-skip-permissions');
      expect(built.args).not.toContain('--allow-dangerously-skip-permissions');
      expect(built.args).toContain('--safe-mode');
      expect(built.args).not.toContain('--mcp-config');
      expect(built.args).not.toContain('--plugin-dir');
      expect(built.args).not.toContain('--plugin-url');
      expect(built.args).not.toContain('--settings');
      expect(built.args).not.toContain('--setting-sources');
      expect(built.args).not.toContain('--agents');
      expect(built.args).not.toContain('--bare');
    }
  });

  it('builds resume with reattached format, schema content, permission, tools, project, safe-mode', () => {
    const start = buildClaudeCommand(
      baseInput({
        mode: 'patch_mode',
        role: 'implementer',
      }),
    );
    expect(start.ok).toBe(true);
    if (!start.ok) return;

    const resume = buildClaudeCommand(
      baseInput({
        operation: 'resume',
        conversationId: 'conversation-xyz',
        mode: 'patch_mode',
        role: 'implementer',
      }),
    );
    expect(resume.ok).toBe(true);
    if (!resume.ok) return;

    const patchSchemaContent = expectedSchemaContent(PATCH_SCHEMA);
    expect(resume.args[0]).toBe('-p');
    expect(resume.args[1]).toBe('--resume');
    expect(resume.args[2]).toBe('conversation-xyz');
    expect(resume.args).toContain('--safe-mode');
    expect(resume.args).toContain('--output-format');
    expect(resume.args).toContain('stream-json');
    expect(resume.args).toContain('--input-format');
    expect(resume.args).toContain('text');
    expect(resume.args).toContain('--json-schema');
    expect(resume.args[resume.args.indexOf('--json-schema') + 1]).toBe(
      patchSchemaContent,
    );
    expect(resume.args).toContain('--permission-mode');
    expect(resume.args).toContain('auto');
    expect(resume.args).toContain('--tools');
    expect(resume.args).toContain('Read,Glob,Grep');
    expect(resume.args).toContain('--disallowedTools');
    expect(resume.args).toContain('--add-dir');
    expect(resume.args).toContain(PROJECT);
    // Resume must not invent --session-id (uses --resume id).
    expect(resume.args).not.toContain('--session-id');
    // No prompt / secret in argv.
    expect(resume.args).not.toContain(PROMPT);

    const startProfile = extractClaudePermissionProfile(start);
    const resumeProfile = extractClaudePermissionProfile(resume);
    expect(resumeProfile).toEqual(startProfile);
    expect(resumeProfile.permissionMode).toBe(startProfile.permissionMode);
    expect(resumeProfile.schemaPath).toBe(startProfile.schemaPath);
    expect(resumeProfile.schemaContent).toBe(startProfile.schemaContent);
    expect(resumeProfile.allowedTools).toEqual(startProfile.allowedTools);
    expect(resumeProfile.disallowedTools).toEqual(startProfile.disallowedTools);
    expect(resumeProfile.projectRoot).toBe(startProfile.projectRoot);
    expect(resumeProfile.includePartialMessages).toBe(false);
    expect(resumeProfile.safeMode).toBe(true);
  });

  it('proves resume reviewer profile is not weaker than start', () => {
    const start = buildClaudeCommand(
      baseInput({ role: 'reviewer', mode: 'read_only' }),
    );
    const resume = buildClaudeCommand(
      baseInput({
        role: 'reviewer',
        mode: 'read_only',
        operation: 'resume',
        conversationId: 'conversation-review',
      }),
    );
    expect(start.ok && resume.ok).toBe(true);
    if (!start.ok || !resume.ok) return;
    expect(extractClaudePermissionProfile(resume)).toEqual(
      extractClaudePermissionProfile(start),
    );
    expect(resume.args).toContain('Read,Glob,Grep');
    expect(resume.args).toContain('--safe-mode');
    const denied = resume.args[resume.args.indexOf('--disallowedTools') + 1] ?? '';
    expect(denied).toMatch(/Bash/);
  });

  it('persists capability key, guard decision, budget, role/mode/schema on run intent', () => {
    const built = buildClaudeCommand(
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
      budgetAttemptId: 'attempt-claude-1',
      role: 'implementer',
      mode: 'patch_mode',
      permissionMode: 'auto',
      schemaPath: resolve(PATCH_SCHEMA),
      schemaContent: expectedSchemaContent(PATCH_SCHEMA),
      nonGit: true,
      projectRoot: PROJECT,
      operation: 'start',
      sessionId: FIXED_SESSION,
      promptDelivery: 'stdin',
      safeMode: true,
    });
  });

  it('returns AdapterDisabled for unverified claude version/platform', () => {
    const unknownVersion = lookupCompatibility({
      cliName: 'claude',
      version: '9.9.9',
      platform: process.platform,
    });
    expect(unknownVersion).toBeUndefined();

    const built = buildClaudeCommand(
      baseInput({
        capabilityKey: {
          cliName: 'claude',
          version: '9.9.9',
          platform: process.platform,
        },
        capabilityRecord: undefined,
      }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/unverified|disabled|2\.1\.206/i);
    expect(() => {
      throw new AdapterDisabledError(built.reason);
    }).toThrow(AdapterDisabledError);
  });

  it('returns AdapterDisabled when capability record does not match key', () => {
    const key = verifiedKey();
    const record = requireVerifiedCompatibility(key);
    const built = buildClaudeCommand(
      baseInput({
        capabilityKey: {
          cliName: 'claude',
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
    const built = buildClaudeCommand(baseInput());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const gate = gateFromIntent(built.intent);
    expect(() => assertClaudeRunBindings(built.intent, gate)).not.toThrow();

    expect(() =>
      assertClaudeRunBindings(built.intent, {
        ...gate,
        projectGuardDecisionId: 'other-guard',
      }),
    ).toThrow(/projectGuardDecisionId|guard/i);

    expect(() =>
      assertClaudeRunBindings(built.intent, {
        ...gate,
        reservedBudgetId: 'other-budget',
      }),
    ).toThrow(/reservedBudgetId|budget/i);

    expect(() =>
      assertClaudeRunBindings(built.intent, {
        ...gate,
        capabilityKey: {
          cliName: 'codex',
          version: '0.144.1',
          platform: process.platform,
        },
      }),
    ).toThrow(/capability/i);
  });

  it('rejects resume without conversation id', () => {
    const built = buildClaudeCommand(
      baseInput({ operation: 'resume' }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/conversation/i);
  });

  it('rejects invalid session-id that is not a UUID', () => {
    const built = buildClaudeCommand(
      baseInput({ sessionId: 'not-a-uuid' }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/UUID|session/i);
  });

  it('validates session UUID helper', () => {
    expect(isValidClaudeSessionUuid(FIXED_SESSION)).toBe(true);
    expect(isValidClaudeSessionUuid('nope')).toBe(false);
  });

  it('rejects empty prompt for stdin delivery', () => {
    const built = buildClaudeCommand(baseInput({ prompt: '' }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/prompt/i);
  });

  it('rejects maxBudget when not verified for 2.1.206', () => {
    const built = buildClaudeCommand(
      baseInput({ maxBudgetUsd: 1.5 }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/maxBudget|budget/i);
  });

  it('defaults prompt delivery to stdin and never places prompt in argv', () => {
    const built = buildClaudeCommand(baseInput());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.intent.promptDelivery).toBe('stdin');
    expect(built.args).not.toContain(PROMPT);
    expect(built.stdinPayload).toEqual({
      encoding: 'utf8',
      data: PROMPT,
      closeAfterWrite: true,
    });
    // Evidence must not contain the prompt secret.
    expect(JSON.stringify(built.argsForEvidence)).not.toContain(
      'secret-token-xyz',
    );
  });
});

describe('ClaudeAdapter ProcessSupervisorPort path', () => {
  const temporaryDirectories: string[] = [];
  const openedDatabases: OpenedDatabase[] = [];
  const TASK_ID = asTaskId('task-adapter-claude-1');

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

  function openAuthAndSession(): {
    readonly launchAuth: LaunchAuthorizationRepository;
    readonly sessionRepo: AgentSessionRepository;
    readonly connection: ReadWriteDatabase['connection'];
  } {
    const directory = mkdtempSync(join(tmpdir(), 'triagent-claude-cmd-'));
    temporaryDirectories.push(directory);
    const opened = openDatabase(join(directory, 'triagent.sqlite'));
    openedDatabases.push(opened);
    if (opened.mode !== 'read-write') {
      throw new Error(opened.diagnostics.error);
    }
    const connection = (opened as ReadWriteDatabase).connection;
    return {
      launchAuth: new LaunchAuthorizationRepository(connection),
      sessionRepo: new AgentSessionRepository(connection),
      connection,
    };
  }

  function seedTask(
    connection: ReadWriteDatabase['connection'],
    taskId: ReturnType<typeof asTaskId>,
  ): void {
    const tasks = new TaskRepository(connection);
    const projectId = `project-${taskId}`;
    try {
      tasks.createProject({
        projectId,
        rootPath: `${PROJECT}\\${taskId}`,
      });
    } catch {
      // project may already exist for this connection
    }
    try {
      tasks.create({
        taskId,
        projectId,
        workflowSnapshot: {
          state: 'draft',
          taskId,
          requirementVersion: 1,
          reworkCount: 0,
          maxReworks: 3,
          pauseAfterAttempt: false,
        },
        workflowVersion: 1,
        status: 'draft',
      });
    } catch {
      // task may already exist
    }
  }

  function issueAuth(
    repo: LaunchAuthorizationRepository,
    request: ClaudeRunRequest,
  ): string {
    return repo.issue(
      {
        taskId: request.taskId ?? TASK_ID,
        attemptId: request.attemptId,
        adapterKind: 'claude',
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
    overrides: Partial<ClaudeRunRequest> = {},
  ): ClaudeRunRequest {
    const capabilityKey = verifiedKey();
    const attemptId = overrides.attemptId ?? asAttemptId('attempt-adapter-claude-1');
    const mode = overrides.mode ?? 'patch_mode';
    const projectGuardDecisionId =
      overrides.projectGuardDecisionId ?? 'guard-decision-1';
    const reservedBudgetId =
      overrides.reservedBudgetId ?? 'budget-reservation-1';
    return {
      attemptId,
      taskId: TASK_ID,
      baselineId: asBaselineId('baseline-adapter-claude-1'),
      requirementVersion: 1,
      role: 'implementer',
      projectRoot: PROJECT,
      prompt: PROMPT,
      capabilityKey,
      projectGuardDecisionId,
      reservedBudgetId,
      mode,
      nonGit: false,
      schemaPath: SCHEMA,
      sessionId: FIXED_SESSION,
      capabilityRecord: requireVerifiedCompatibility(capabilityKey),
      ...overrides,
    };
  }

  it('starts via ProcessSupervisorPort with exact structural argv and stdin prompt', async () => {
    const clock = new FakeClock('2026-07-12T03:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 8101,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 8101 } },
        {
          afterMs: 1,
          event: {
            type: 'exited',
            pid: 8101,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const { launchAuth, sessionRepo, connection } = openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new ClaudeAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
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
    expect(startCall.request.executable).toBe('claude');
    expect(startCall.request.args[0]).toBe('-p');
    expect(startCall.request.args).toContain('--safe-mode');
    expect(startCall.request.args).toContain('--output-format');
    expect(startCall.request.args).toContain('stream-json');
    expect(startCall.request.args).toContain('--input-format');
    expect(startCall.request.args).toContain('text');
    expect(startCall.request.args).toContain('--session-id');
    expect(startCall.request.args).toContain(FIXED_SESSION);
    expect(startCall.request.args).toContain('--permission-mode');
    expect(startCall.request.args).toContain('auto');
    expect(startCall.request.args).toContain('Read,Glob,Grep');
    // Prompt / secret never appear in argv.
    expect(startCall.request.args).not.toContain(PROMPT);
    expect(
      startCall.request.args.every((a) => !a.includes('secret-token-xyz')),
    ).toBe(true);
    expect(startCall.request.cwd).toBe(PROJECT);
    // Default: exact UTF-8 stdin prompt, closed after write.
    expect(startCall.request.stdin).toEqual({
      encoding: 'utf8',
      data: PROMPT,
      closeAfterWrite: true,
    });
    expect(adapter.lastArgsForEvidence?.join(' ')).not.toContain(
      'secret-token-xyz',
    );
    expect(adapter.lastArgsForEvidence).toContain('[REDACTED_JSON_SCHEMA]');
    expect(adapter.lastRunIntent?.projectGuardDecisionId).toBe('guard-decision-1');
    expect(adapter.lastRunIntent?.reservedBudgetId).toBe('budget-reservation-1');
    await handle.wait();
  });

  it('resume requires persisted safe session evidence and fresh launch auth', async () => {
    const clock = new FakeClock('2026-07-12T03:10:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 8201,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 8201 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 8201,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
      {
        pid: 8202,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 8202 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 8202,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
    ]);
    const { launchAuth, sessionRepo, connection } = openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new ClaudeAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
    });

    const startBase = runRequest({ mode: 'patch_mode' });
    const startReq = runRequest({
      mode: 'patch_mode',
      launchAuthorizationId: issueAuth(launchAuth, startBase),
    });
    await adapter.start(startReq);
    const startIntent = adapter.lastRunIntent;
    // Persist completed turn evidence before resume is allowed.
    adapter.markAttemptPersisted({
      attemptId: startReq.attemptId,
      conversationId: asConversationId(FIXED_SESSION),
      exitReason: 'completed',
    });

    const resumeBase = runRequest({
      attemptId: asAttemptId('attempt-adapter-claude-2'),
      mode: 'patch_mode',
    });
    const resumeReq = runRequest({
      attemptId: asAttemptId('attempt-adapter-claude-2'),
      mode: 'patch_mode',
      launchAuthorizationId: issueAuth(launchAuth, resumeBase),
    });
    await adapter.resume(asConversationId(FIXED_SESSION), resumeReq);
    const starts = supervisor.calls.filter((c) => c.type === 'start');
    expect(starts).toHaveLength(2);
    const resumeCall = starts[1];
    if (resumeCall?.type !== 'start') return;

    expect(resumeCall.request.args[0]).toBe('-p');
    expect(resumeCall.request.args[1]).toBe('--resume');
    expect(resumeCall.request.args[2]).toBe(FIXED_SESSION);
    expect(resumeCall.request.args).toContain('--safe-mode');
    expect(resumeCall.request.args).toContain('stream-json');
    expect(resumeCall.request.args).toContain('--input-format');
    expect(resumeCall.request.args).toContain('text');
    expect(resumeCall.request.args).toContain('--permission-mode');
    expect(resumeCall.request.args).toContain('auto');
    expect(resumeCall.request.args).toContain('Read,Glob,Grep');
    expect(resumeCall.request.args).not.toContain(PROMPT);
    expect(resumeCall.request.stdin?.data).toBe(PROMPT);
    expect(adapter.lastRunIntent?.permissionMode).toBe(startIntent?.permissionMode);
    expect(adapter.lastRunIntent?.allowedTools).toEqual(startIntent?.allowedTools);
    expect(adapter.lastRunIntent?.disallowedTools).toEqual(
      startIntent?.disallowedTools,
    );
    expect(resumeCall.request.args).not.toContain('--dangerously-skip-permissions');
  });

  it('refuses resume without persisted safe session evidence (killed/unpersisted)', async () => {
    const clock = new FakeClock('2026-07-12T03:15:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 8211,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 8211 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 8211,
              exitCode: 1,
              signal: null,
              reason: 'force_stop',
            },
          },
        ],
      },
    ]);
    const { launchAuth, sessionRepo, connection } = openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new ClaudeAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
    });

    const startBase = runRequest({ mode: 'patch_mode' });
    await adapter.start(
      runRequest({
        mode: 'patch_mode',
        launchAuthorizationId: issueAuth(launchAuth, startBase),
      }),
    );
    // Mark killed/unpersisted — must not resume.
    adapter.markAttemptUnresumable({
      attemptId: startBase.attemptId,
      conversationId: asConversationId(FIXED_SESSION),
      reason: 'killed_unpersisted',
    });

    const resumeBase = runRequest({
      attemptId: asAttemptId('attempt-adapter-claude-killed'),
      mode: 'patch_mode',
    });
    await expect(
      adapter.resume(
        asConversationId(FIXED_SESSION),
        runRequest({
          attemptId: asAttemptId('attempt-adapter-claude-killed'),
          mode: 'patch_mode',
          launchAuthorizationId: issueAuth(launchAuth, resumeBase),
        }),
      ),
    ).rejects.toThrow(/start-new-context|unpersisted|killed|AdapterDisabled|resume/i);
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(1);
  });

  it('refuses resume when conversation/task/adapter evidence mismatches', async () => {
    const clock = new FakeClock('2026-07-12T03:16:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 8221,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 8221 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 8221,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
    ]);
    const { launchAuth, sessionRepo, connection } = openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new ClaudeAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
    });
    const startBase = runRequest({ mode: 'patch_mode' });
    await adapter.start(
      runRequest({
        mode: 'patch_mode',
        launchAuthorizationId: issueAuth(launchAuth, startBase),
      }),
    );
    adapter.markAttemptPersisted({
      attemptId: startBase.attemptId,
      conversationId: asConversationId(FIXED_SESSION),
      exitReason: 'completed',
    });

    const otherTask = asTaskId('task-other-mismatch');
    seedTask(connection, otherTask);
    const resumeBase = runRequest({
      attemptId: asAttemptId('attempt-adapter-claude-mismatch'),
      taskId: otherTask,
      mode: 'patch_mode',
    });
    await expect(
      adapter.resume(
        asConversationId(FIXED_SESSION),
        runRequest({
          attemptId: asAttemptId('attempt-adapter-claude-mismatch'),
          taskId: otherTask,
          mode: 'patch_mode',
          launchAuthorizationId: issueAuth(launchAuth, resumeBase),
        }),
      ),
    ).rejects.toThrow(/mismatch|AdapterDisabled|session|task/i);
  });

  it('rejects start when launch authorization intent bindings mismatch', async () => {
    const clock = new FakeClock('2026-07-12T03:20:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 8301,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 8301 } },
        {
          afterMs: 1,
          event: {
            type: 'exited',
            pid: 8301,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const { launchAuth, sessionRepo, connection } = openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new ClaudeAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
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
    const { launchAuth, sessionRepo, connection } = openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new ClaudeAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
    });
    const bad = runRequest({
      capabilityKey: {
        cliName: 'claude',
        version: '0.0.1',
        platform: process.platform,
      },
      capabilityRecord: undefined,
    });
    await expect(adapter.start(bad)).rejects.toBeInstanceOf(AdapterDisabledError);
  });

  it('requires fresh launch authorization for resume (one-time store-backed)', async () => {
    const clock = new FakeClock('2026-07-12T03:40:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 8401,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 8401 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 8401,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
    ]);
    const { launchAuth, sessionRepo, connection } = openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new ClaudeAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
    });
    const startBase = runRequest();
    const authId = issueAuth(launchAuth, startBase);
    await adapter.start(runRequest({ launchAuthorizationId: authId }));
    adapter.markAttemptPersisted({
      attemptId: startBase.attemptId,
      conversationId: asConversationId(FIXED_SESSION),
      exitReason: 'completed',
    });

    // Reuse same auth id for resume must fail (one-time).
    await expect(
      adapter.resume(
        asConversationId(FIXED_SESSION),
        runRequest({
          attemptId: asAttemptId('attempt-adapter-claude-resume-reuse'),
          launchAuthorizationId: authId,
        }),
      ),
    ).rejects.toThrow(/authorization|consumed|AdapterDisabled|reuse|mismatch/i);
  });
});

describe('Claude agent_sessions resume evidence', () => {
  const temporaryDirectories: string[] = [];
  const openedDatabases: OpenedDatabase[] = [];

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

  function openSessionRepo(): {
    readonly repo: AgentSessionRepository;
    readonly connection: ReadWriteDatabase['connection'];
  } {
    const directory = mkdtempSync(join(tmpdir(), 'triagent-claude-session-'));
    temporaryDirectories.push(directory);
    const opened = openDatabase(join(directory, 'triagent.sqlite'));
    openedDatabases.push(opened);
    if (opened.mode !== 'read-write') {
      throw new Error(opened.diagnostics.error);
    }
    return {
      repo: new AgentSessionRepository(
        (opened as ReadWriteDatabase).connection,
      ),
      connection: (opened as ReadWriteDatabase).connection,
    };
  }

  function seed(connection: ReadWriteDatabase['connection'], taskId: string): void {
    const tasks = new TaskRepository(connection);
    const id = asTaskId(taskId);
    tasks.createProject({
      projectId: `project-${taskId}`,
      rootPath: `${PROJECT}\\${taskId}`,
    });
    tasks.create({
      taskId: id,
      projectId: `project-${taskId}`,
      workflowSnapshot: {
        state: 'draft',
        taskId: id,
        requirementVersion: 1,
        reworkCount: 0,
        maxReworks: 3,
        pauseAfterAttempt: false,
      },
      workflowVersion: 1,
      status: 'draft',
    });
  }

  it('persists session evidence bound to task/adapter/conversation and resumable status', () => {
    const { repo, connection } = openSessionRepo();
    const taskId = asTaskId('task-session-1');
    seed(connection, taskId);
    const attemptId = asAttemptId('attempt-session-1');
    const conversationId = asConversationId(FIXED_SESSION);
    const profileHash = createHash('sha256')
      .update('read_only|auto|safe')
      .digest('hex');

    const created = repo.create({
      sessionId: 'session-row-1',
      taskId,
      role: 'implementer',
      agentKind: 'claude',
      conversationId,
      attemptId,
      adapterVersion: VERIFIED_CLAUDE_VERSION,
      adapterPlatform: process.platform,
      mode: 'patch_mode',
      permissionProfileHash: profileHash,
      guardDecisionId: 'guard-decision-1',
      status: 'active',
      startedAt: '2026-07-12T04:00:00.000Z',
    });
    expect(created.resumable).toBe(false);
    expect(created.status).toBe('active');

    const completed = repo.markCompletedAndPersisted({
      sessionId: 'session-row-1',
      attemptId,
      conversationId,
      endedAt: '2026-07-12T04:01:00.000Z',
      exitReason: 'completed',
    });
    expect(completed.status).toBe('completed_persisted');
    expect(completed.resumable).toBe(true);
    expect(completed.lastAttemptId).toBe(attemptId);

    const found = repo.findResumable({
      taskId,
      agentKind: 'claude',
      conversationId,
      adapterVersion: VERIFIED_CLAUDE_VERSION,
      adapterPlatform: process.platform,
    });
    expect(found?.sessionId).toBe('session-row-1');
    expect(found?.resumable).toBe(true);
  });

  it('marks killed/unpersisted turns non-resumable', () => {
    const { repo, connection } = openSessionRepo();
    const taskId = asTaskId('task-session-killed');
    seed(connection, taskId);
    const attemptId = asAttemptId('attempt-session-killed');
    const conversationId = asConversationId(FIXED_SESSION);
    repo.create({
      sessionId: 'session-killed-1',
      taskId,
      role: 'implementer',
      agentKind: 'claude',
      conversationId,
      attemptId,
      adapterVersion: VERIFIED_CLAUDE_VERSION,
      adapterPlatform: process.platform,
      mode: 'patch_mode',
      permissionProfileHash: 'abc',
      guardDecisionId: 'guard-decision-1',
      status: 'active',
      startedAt: '2026-07-12T04:00:00.000Z',
    });
    const killed = repo.markUnresumable({
      sessionId: 'session-killed-1',
      attemptId,
      endedAt: '2026-07-12T04:00:30.000Z',
      reason: 'killed_unpersisted',
    });
    expect(killed.resumable).toBe(false);
    expect(killed.status).toBe('unresumable');
    expect(
      repo.findResumable({
        taskId,
        agentKind: 'claude',
        conversationId,
        adapterVersion: VERIFIED_CLAUDE_VERSION,
        adapterPlatform: process.platform,
      }),
    ).toBeUndefined();
  });
});
