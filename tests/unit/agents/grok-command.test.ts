import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AdapterDisabledError,
  assertGrokRunBindings,
  buildGrokCommand,
  cleanupGrokPromptArtifact,
  createGrokPromptFile,
  extractGrokPermissionProfile,
  GROK_ALWAYS_APPROVE_PROVEN,
  GROK_DEFAULT_MAX_TURNS,
  GROK_LIVE_PROJECT_ENFORCEMENT_PROVEN,
  GROK_PROJECT_WRITE_AUTO_PROVEN,
  GROK_SANDBOX_PROFILE_PROVEN,
  GROK_ISOLATED_IMPLEMENTATION_ALLOWED_TOOLS,
  GROK_ISOLATED_IMPLEMENTATION_DENIED_TOOLS,
  GROK_VERIFIED_DISALLOWED_WRITE_TOOLS,
  GROK_VERIFIED_READ_ONLY_TOOLS,
  isValidGrokSessionUuid,
  type GrokCommandInput,
  type GrokRunIntent,
  VERIFIED_GROK_VERSION,
} from '../../../src/agents/grok/grok-command.js';
import {
  isAllowedWindowsAclNamePrincipal,
  logonSessionPrincipalNameFromSid,
  type PromptArtifactRef,
} from '../../../src/agents/grok/prompt-artifact-store.js';
import { createHash } from 'node:crypto';
import { GrokAdapter } from '../../../src/agents/grok/grok-adapter.js';
import type { GrokRunRequest } from '../../../src/agents/grok/grok-adapter.js';
import {
  lookupCompatibility,
  requireVerifiedCompatibility,
  type CompatibilityKey,
  type WorkerStartGateRecord,
} from '../../../src/agents/compatibility-matrix.js';
import {
  deriveProbedCompatibilityRecord,
  getCompatibilityProbeManifest,
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
import {
  hashImmutableReviewManifestContent,
  IMMUTABLE_REVIEW_BUNDLE_KIND,
  type ImmutableReviewBundleRef,
} from '../../../src/protocol/immutable-review-bundle.js';
import { TaskRepository } from '../../../src/persistence/task-repository.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';

const SCHEMA = resolve('schemas/agent-result.schema.json');
const PROJECT = 'D:\\temporary project\\demo';
const FIXED_SESSION = '11111111-2222-4333-8444-555555555555';
const PROMPT = 'Return structured result only. secret-token-xyz';

function verifiedKey(
  overrides: Partial<CompatibilityKey> = {},
): CompatibilityKey {
  return {
    cliName: 'grok',
    version: VERIFIED_GROK_VERSION,
    platform: process.platform,
    ...overrides,
  };
}

function makeBundle(liveProjectRoot: string = PROJECT): {
  readonly ref: ImmutableReviewBundleRef;
  readonly root: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'triagent-grok-bundle-'));
  temporaryPromptDirs.push(root);
  // Ensure bundle is outside live project (tmpdir is).
  const manifestBody = JSON.stringify({
    kind: IMMUTABLE_REVIEW_BUNDLE_KIND,
    files: ['README.md'],
    note: 'narrow Task16 input only',
  });
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, manifestBody, 'utf8');
  writeFileSync(join(root, 'README.md'), 'review bundle body\n', 'utf8');
  const ref: ImmutableReviewBundleRef = Object.freeze({
    kind: IMMUTABLE_REVIEW_BUNDLE_KIND,
    bundleRoot: root,
    manifestPath,
    contentHash: hashImmutableReviewManifestContent(manifestBody),
  });
  // Guard: never under live project path string.
  expect(root.toLowerCase()).not.toContain(liveProjectRoot.toLowerCase());
  return { ref, root };
}

function makeSyntheticPromptArtifact(
  prompt: string = PROMPT,
  absolutePath?: string,
): PromptArtifactRef {
  const path =
    absolutePath
    ?? join(tmpdir(), `triagent-synthetic-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  // Pure builder must not require the path to exist on disk.
  return Object.freeze({
    path,
    sha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    byteLength: Buffer.byteLength(prompt, 'utf8'),
    stagingDir: join(tmpdir(), 'triagent-synthetic-staging'),
    cleanup: () => ({ ok: true as const }),
  });
}

function baseInput(
  overrides: Partial<GrokCommandInput> = {},
): GrokCommandInput {
  const capabilityKey = verifiedKey();
  const { ref } = makeBundle(PROJECT);
  const promptArtifact =
    Object.prototype.hasOwnProperty.call(overrides, 'promptArtifact')
      ? overrides.promptArtifact
      : makeSyntheticPromptArtifact(overrides.prompt ?? PROMPT);
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
    budgetAttemptId: asAttemptId('attempt-grok-1'),
    taskId: 'task-grok-unit-1',
    operation: 'start',
    sessionId: FIXED_SESSION,
    prompt: PROMPT,
    ...(promptArtifact === undefined ? {} : { promptArtifact }),
    immutableReviewBundle: ref,
    ...overrides,
    // Keep promptArtifact from overrides if explicitly undefined for dry-run.
    ...(Object.prototype.hasOwnProperty.call(overrides, 'promptArtifact')
      ? { promptArtifact: overrides.promptArtifact }
      : {}),
  };
}

const temporaryPromptDirs: string[] = [];
const builtCleanups: Array<() => void> = [];

afterEach(() => {
  while (builtCleanups.length > 0) {
    try {
      builtCleanups.pop()?.();
    } catch {
      // ignore
    }
  }
  while (temporaryPromptDirs.length > 0) {
    const directory = temporaryPromptDirs.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function trackBuilt(
  built: ReturnType<typeof buildGrokCommand>,
): ReturnType<typeof buildGrokCommand> {
  if (built.ok) {
    builtCleanups.push(() => {
      built.cleanupPromptFile();
    });
  }
  return built;
}

function gateFromIntent(intent: GrokRunIntent): WorkerStartGateRecord {
  return Object.freeze({
    capabilityKey: Object.freeze({ ...intent.capabilityKey }),
    projectGuardDecisionId: intent.projectGuardDecisionId,
    projectGuardMode: intent.mode,
    projectGuardAttemptId: intent.budgetAttemptId,
    reservedBudgetId: intent.reservedBudgetId,
    budgetCanLaunch: true as const,
    authStatus: 'unknown' as const,
    requiresReadinessProbe: true,
    readinessProbeCompleted: true,
  });
}

describe('buildGrokCommand (Grok CLI 0.2.93)', () => {
  it('builds the exact implementer patch_mode start contract as structural argv', () => {
    const input = baseInput();
    const built = trackBuilt(buildGrokCommand(input));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.executable).toBe('grok');
    expect(built.args[0]).toBe('--cwd');
    // --cwd is immutable bundle only — never live project.
    expect(built.args[1]).toBe(built.intent.cwd);
    expect(built.args[1]).not.toBe(PROJECT);
    expect(built.intent.cwd).toBe(input.immutableReviewBundle!.bundleRoot);
    expect(built.intent.liveProjectAccess).toBe(false);
    expect(built.args).toContain('--session-id');
    expect(built.args).toContain(FIXED_SESSION);
    expect(built.args).toContain('--prompt-file');
    expect(built.args).toContain('--output-format');
    expect(built.args).toContain('streaming-json');
    expect(built.args).toContain('--permission-mode');
    expect(built.args).toContain('auto');
    expect(built.args).toContain('--tools');
    expect(built.args).toContain(GROK_VERIFIED_READ_ONLY_TOOLS.join(','));
    expect(built.args).toContain('--disallowed-tools');
    expect(built.args).toContain(
      GROK_VERIFIED_DISALLOWED_WRITE_TOOLS.join(','),
    );
    expect(built.args).toContain('--max-turns');
    expect(built.args).toContain(String(GROK_DEFAULT_MAX_TURNS));
    // Prompt is never in argv / process list (--prompt-file only).
    expect(built.args).not.toContain(PROMPT);
    expect(built.args).not.toContain('--single');
    expect(built.args).not.toContain('-p');
    expect(built.args.every((part) => !part.includes('secret-token-xyz'))).toBe(
      true,
    );
    // Structural command — never a shell string.
    expect(built.args.every((part) => typeof part === 'string')).toBe(true);
    expect(Array.isArray(built.args)).toBe(true);
    expect(built.args).not.toContain('&&');
    expect(built.args).not.toContain('|');
    expect(built.args).not.toContain(';');
    // Never always-approve or unproven sandbox.
    expect(built.args).not.toContain('--always-approve');
    expect(built.args).not.toContain('--sandbox');
    expect(built.intent.structuredPatchRequired).toBe(true);
    expect(built.intent.mode).toBe('patch_mode');
    expect(built.intent.promptDelivery).toBe('prompt-file');
    expect(built.intent.permissionMode).toBe('auto');
    // Evidence redacts prompt file path.
    const evidenceIdx = built.argsForEvidence.indexOf('--prompt-file');
    expect(built.argsForEvidence[evidenceIdx + 1]).toBe(
      '[REDACTED_PROMPT_FILE]',
    );
    expect(built.argsForEvidence.join(' ')).not.toContain('secret-token-xyz');
    // Pure builder consumes verified ref path; no store create / ACL / FS work.
    expect(built.promptFilePath.toLowerCase()).not.toContain(
      PROJECT.toLowerCase(),
    );
    expect(built.promptFilePath).toBe(input.promptArtifact!.path);
    expect(built.intent.promptFileSha256).toBe(input.promptArtifact!.sha256);
  });

  it('pure builder completes in under 100ms without filesystem/ACL work', () => {
    // Reuse one pre-made bundle so the loop measures builder cost only.
    const { ref } = makeBundle(PROJECT);
    const artifact = makeSyntheticPromptArtifact();
    const input = baseInput({
      immutableReviewBundle: ref,
      promptArtifact: artifact,
    });
    // Warm once (module init / path normalize).
    expect(buildGrokCommand(input).ok).toBe(true);
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) {
      const built = buildGrokCommand(input);
      expect(built.ok).toBe(true);
    }
    const elapsed = Date.now() - started;
    expect(elapsed / 20).toBeLessThan(100);
  });

  it('declares every Grok flag used by the builder in the no-model probe manifest', () => {
    const manifest = getCompatibilityProbeManifest('grok');
    const required = manifest.probes.flatMap((probe) => probe.requiredTokens);
    expect(required).toEqual(expect.arrayContaining([
      '--output-format',
      'streaming-json',
      '--prompt-file',
      '--session-id',
      '--permission-mode',
      'auto',
      'plan',
      '--max-turns',
      '--tools',
      '--disallowed-tools',
      '--cwd',
      '--resume',
    ]));
    expect(required).not.toContain('--always-approve');
    expect(required).not.toContain('--sandbox');
    expect(GROK_ALWAYS_APPROVE_PROVEN).toBe(false);
    expect(GROK_SANDBOX_PROFILE_PROVEN).toBe(false);
    expect(GROK_PROJECT_WRITE_AUTO_PROVEN).toBe(false);
    expect(GROK_LIVE_PROJECT_ENFORCEMENT_PROVEN).toBe(false);
  });

  it('accepts Grok 0.2.101 after the current command contract was probed', () => {
    const capabilityKey = verifiedKey({ version: '0.2.101' });
    const built = trackBuilt(buildGrokCommand(baseInput({
      capabilityKey,
      capabilityRecord: deriveProbedCompatibilityRecord(capabilityKey),
    })));

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.intent.capabilityKey).toEqual(capabilityKey);
    expect(built.args).toContain('streaming-json');
    expect(built.args).toContain('--max-turns');
  });

  it('uses plan permission-mode and Read,Glob,Grep only for reviewer and master', () => {
    for (const role of ['reviewer', 'master'] as const) {
      const built = trackBuilt(
        buildGrokCommand(baseInput({ role, mode: 'read_only', schemaPath: SCHEMA })),
      );
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.args).toContain('--permission-mode');
      expect(built.args).toContain('plan');
      expect(built.args).not.toContain('auto');
      const toolsIdx = built.args.indexOf('--tools');
      expect(toolsIdx).toBeGreaterThan(-1);
      const tools = built.args[toolsIdx + 1] ?? '';
      expect(tools).toBe('Read,Glob,Grep');
      expect(tools).not.toMatch(/Edit|Write|Bash|Shell/i);
      const denied =
        built.args[built.args.indexOf('--disallowed-tools') + 1] ?? '';
      expect(denied).toMatch(/Edit/);
      expect(denied).toMatch(/Write/);
      expect(denied).toMatch(/Bash/);
      expect(built.intent.structuredPatchRequired).toBe(false);
      expect(built.intent.mode).toBe('read_only');
      expect(built.intent.permissionMode).toBe('plan');
    }
  });

  it('disables implementer project_write auto when write profile is not proven', () => {
    expect(GROK_PROJECT_WRITE_AUTO_PROVEN).toBe(false);
    const built = trackBuilt(
      buildGrokCommand(
        baseInput({ mode: 'project_write', role: 'implementer' }),
      ),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/project-write|patch_mode|not proven/i);
  });

  it('maps implementer auto_allowed to patch_mode (preferred fallback)', () => {
    const built = trackBuilt(
      buildGrokCommand(baseInput({ mode: 'auto_allowed', role: 'implementer' })),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.intent.mode).toBe('patch_mode');
    expect(built.intent.structuredPatchRequired).toBe(true);
    expect(built.args).toContain('Read,Glob,Grep');
    expect(built.args).toContain('--permission-mode');
    expect(built.args).toContain('auto');
    expect(built.args).not.toContain('--always-approve');
  });

  it('never emits always-approve, sandbox, or single-prompt flags', () => {
    const start = trackBuilt(buildGrokCommand(baseInput()));
    const resume = trackBuilt(
      buildGrokCommand(
        baseInput({
          operation: 'resume',
          conversationId: 'conversation-abc',
        }),
      ),
    );
    for (const built of [start, resume]) {
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const joined = built.args.join(' ');
      expect(joined).not.toMatch(/always-approve/i);
      expect(built.args).not.toContain('--always-approve');
      expect(built.args).not.toContain('--sandbox');
      expect(built.args).not.toContain('--single');
      expect(built.args).not.toContain('-p');
      expect(built.args).not.toContain('bypassPermissions');
    }
  });

  it('builds resume with reattached format, permission, tools, max-turns, cwd', () => {
    const { ref, root } = makeBundle();
    const start = trackBuilt(
      buildGrokCommand(
        baseInput({
          mode: 'patch_mode',
          role: 'implementer',
          immutableReviewBundle: ref,
        }),
      ),
    );
    expect(start.ok).toBe(true);
    if (!start.ok) return;

    const resume = trackBuilt(
      buildGrokCommand(
        baseInput({
          operation: 'resume',
          conversationId: 'conversation-xyz',
          mode: 'patch_mode',
          role: 'implementer',
          immutableReviewBundle: ref,
        }),
      ),
    );
    expect(resume.ok).toBe(true);
    if (!resume.ok) return;

    expect(resume.args[0]).toBe('--cwd');
    expect(resume.args[1]).toBe(root);
    expect(resume.args[1]).not.toBe(PROJECT);
    expect(resume.args).toContain('--resume');
    expect(resume.args).toContain('conversation-xyz');
    expect(resume.args).toContain('--output-format');
    expect(resume.args).toContain('streaming-json');
    expect(resume.args).toContain('--permission-mode');
    expect(resume.args).toContain('auto');
    expect(resume.args).toContain('--tools');
    expect(resume.args).toContain('Read,Glob,Grep');
    expect(resume.args).toContain('--disallowed-tools');
    expect(resume.args).toContain('--max-turns');
    expect(resume.args).toContain(String(GROK_DEFAULT_MAX_TURNS));
    // Resume must not invent --session-id (uses --resume id).
    expect(resume.args).not.toContain('--session-id');
    // No prompt / secret in argv.
    expect(resume.args).not.toContain(PROMPT);

    const startProfile = extractGrokPermissionProfile(start);
    const resumeProfile = extractGrokPermissionProfile(resume);
    expect(resumeProfile).toEqual(startProfile);
    expect(resumeProfile.permissionMode).toBe(startProfile.permissionMode);
    expect(resumeProfile.allowedTools).toEqual(startProfile.allowedTools);
    expect(resumeProfile.disallowedTools).toEqual(startProfile.disallowedTools);
    expect(resumeProfile.maxTurns).toBe(startProfile.maxTurns);
    expect(resumeProfile.projectRoot).toBe(startProfile.projectRoot);
    expect(resumeProfile.cwd).toBe(root);
    expect(resumeProfile.liveProjectAccess).toBe(false);
    expect(resumeProfile.alwaysApprove).toBe(false);
    expect(resumeProfile.sandboxEmitted).toBe(false);
  });

  it('proves resume reviewer profile is not weaker than start', () => {
    const { ref } = makeBundle();
    const start = trackBuilt(
      buildGrokCommand(
        baseInput({
          role: 'reviewer',
          mode: 'read_only',
          immutableReviewBundle: ref,
        }),
      ),
    );
    const resume = trackBuilt(
      buildGrokCommand(
        baseInput({
          role: 'reviewer',
          mode: 'read_only',
          operation: 'resume',
          conversationId: 'conversation-review',
          immutableReviewBundle: ref,
        }),
      ),
    );
    expect(start.ok && resume.ok).toBe(true);
    if (!start.ok || !resume.ok) return;
    expect(extractGrokPermissionProfile(resume)).toEqual(
      extractGrokPermissionProfile(start),
    );
    expect(resume.args).toContain('Read,Glob,Grep');
    expect(resume.args).toContain('plan');
    const denied =
      resume.args[resume.args.indexOf('--disallowed-tools') + 1] ?? '';
    expect(denied).toMatch(/Bash/);
  });

  it('persists capability key, guard decision, budget, role/mode on run intent', () => {
    const built = trackBuilt(
      buildGrokCommand(
        baseInput({
          nonGit: true,
          mode: 'patch_mode',
          role: 'implementer',
        }),
      ),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.intent).toMatchObject({
      capabilityKey: verifiedKey(),
      projectGuardDecisionId: 'guard-decision-1',
      reservedBudgetId: 'budget-reservation-1',
      budgetAttemptId: 'attempt-grok-1',
      role: 'implementer',
      mode: 'patch_mode',
      permissionMode: 'auto',
      nonGit: true,
      projectRoot: PROJECT,
      liveProjectAccess: false,
      operation: 'start',
      sessionId: FIXED_SESSION,
      promptDelivery: 'prompt-file',
      maxTurns: GROK_DEFAULT_MAX_TURNS,
    });
    expect(built.intent.cwd).not.toBe(PROJECT);
  });

  it('returns AdapterDisabled for unverified grok version/platform', () => {
    const unknownVersion = lookupCompatibility({
      cliName: 'grok',
      version: '9.9.9',
      platform: process.platform,
    });
    expect(unknownVersion).toBeUndefined();

    const built = trackBuilt(
      buildGrokCommand(
        baseInput({
          capabilityKey: {
            cliName: 'grok',
            version: '9.9.9',
            platform: process.platform,
          },
          capabilityRecord: undefined,
        }),
      ),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/unverified|disabled|0\.2\.93/i);
    expect(() => {
      throw new AdapterDisabledError(built.reason);
    }).toThrow(AdapterDisabledError);
  });

  it('returns AdapterDisabled when capability record does not match key', () => {
    const key = verifiedKey();
    const record = requireVerifiedCompatibility(key);
    const built = trackBuilt(
      buildGrokCommand(
        baseInput({
          capabilityKey: {
            cliName: 'grok',
            version: '9.9.9',
            platform: process.platform,
          },
          capabilityRecord: record,
        }),
      ),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
  });

  it('rejects run intent bindings that do not match Task13 start gate', () => {
    const built = trackBuilt(buildGrokCommand(baseInput()));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const gate = gateFromIntent(built.intent);
    expect(() => assertGrokRunBindings(built.intent, gate)).not.toThrow();

    expect(() =>
      assertGrokRunBindings(built.intent, {
        ...gate,
        projectGuardDecisionId: 'other-guard',
      }),
    ).toThrow(/projectGuardDecisionId|guard/i);

    expect(() =>
      assertGrokRunBindings(built.intent, {
        ...gate,
        reservedBudgetId: 'other-budget',
      }),
    ).toThrow(/reservedBudgetId|budget/i);

    expect(() =>
      assertGrokRunBindings(built.intent, {
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
    const built = trackBuilt(
      buildGrokCommand(baseInput({ operation: 'resume' })),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/conversation/i);
  });

  it('rejects invalid session-id that is not a UUID', () => {
    const built = trackBuilt(
      buildGrokCommand(baseInput({ sessionId: 'not-a-uuid' })),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/UUID|session/i);
  });

  it('validates session UUID helper', () => {
    expect(isValidGrokSessionUuid(FIXED_SESSION)).toBe(true);
    expect(isValidGrokSessionUuid('nope')).toBe(false);
  });

  it('rejects empty prompt for prompt-file delivery', () => {
    const built = trackBuilt(buildGrokCommand(baseInput({ prompt: '' })));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/prompt/i);
  });

  it('rejects promptViaFile=false (no --single prompt in argv)', () => {
    const built = trackBuilt(
      buildGrokCommand(baseInput({ promptViaFile: false })),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('AdapterDisabled');
    expect(built.reason).toMatch(/prompt-file|argv|--single/i);
  });

  it('createGrokPromptFile is not used by pure builder (store owns OS work)', () => {
    expect(() =>
      createGrokPromptFile({
        prompt: 'x',
        projectRoot: PROJECT,
        directory: tmpdir(),
      }),
    ).toThrow(/SecurePromptArtifactStore|pure builder|AdapterDisabled/i);
  });

  it('Windows ACL name-only allowlist accepts whoami/SYSTEM/Administrators/current logon and rejects others', () => {
    const current = 'DESKTOP-TEST\\alice';
    const currentLogonSid = 'S-1-5-5-0-278359';
    const currentLogonName = logonSessionPrincipalNameFromSid(currentLogonSid);
    expect(currentLogonName).toBe('NT AUTHORITY\\LogonSessionId_0_278359');
    const ctx = {
      currentUserName: current,
      currentLogonSessionName: currentLogonName,
    };
    // Exact normalized DOMAIN\\user only (case/slash fold); no bare-name match.
    expect(isAllowedWindowsAclNamePrincipal(current, ctx)).toBe(true);
    expect(isAllowedWindowsAclNamePrincipal('desktop-test\\alice', ctx)).toBe(
      true,
    );
    expect(isAllowedWindowsAclNamePrincipal('CONTOSO\\alice', ctx)).toBe(false);
    expect(isAllowedWindowsAclNamePrincipal('NT AUTHORITY\\SYSTEM', ctx)).toBe(
      true,
    );
    expect(isAllowedWindowsAclNamePrincipal('SYSTEM', ctx)).toBe(true);
    expect(
      isAllowedWindowsAclNamePrincipal('BUILTIN\\Administrators', ctx),
    ).toBe(true);
    expect(isAllowedWindowsAclNamePrincipal('Administrators', ctx)).toBe(true);
    // Exact current logon session only — no prefix allow.
    expect(isAllowedWindowsAclNamePrincipal(currentLogonName, ctx)).toBe(true);
    expect(
      isAllowedWindowsAclNamePrincipal(
        'NT AUTHORITY\\LogonSessionId_0_999999',
        ctx,
      ),
    ).toBe(false);
    expect(
      isAllowedWindowsAclNamePrincipal('CONTOSO\\UnexpectedUser', ctx),
    ).toBe(false);
  });

  it('cleanup delegates to PromptArtifactRef.cleanup (pure builder wiring)', () => {
    let cleaned = false;
    const artifact = makeSyntheticPromptArtifact();
    const wired: PromptArtifactRef = {
      ...artifact,
      cleanup: () => {
        cleaned = true;
        return { ok: true };
      },
    };
    const built = trackBuilt(
      buildGrokCommand(baseInput({ promptArtifact: wired })),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const result = built.cleanupPromptFile();
    expect(result.ok).toBe(true);
    expect(cleaned).toBe(true);
  });

  it('denies live-project reviewer/master/patch without immutable review bundle', () => {
    for (const sample of [
      { role: 'reviewer' as const, mode: 'read_only' as const },
      { role: 'master' as const, mode: 'read_only' as const },
      { role: 'implementer' as const, mode: 'patch_mode' as const },
    ]) {
      const built = trackBuilt(
        buildGrokCommand(
          baseInput({
            role: sample.role,
            mode: sample.mode,
            immutableReviewBundle: undefined,
          }),
        ),
      );
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.code).toBe('AdapterDisabled');
      expect(built.reason).toMatch(
        /immutable review bundle|liveProjectAccess|live-project/i,
      );
    }
  });

  it('permits valid immutable bundle command but capability record stays enforcement-unproven', () => {
    const capabilityKey = verifiedKey();
    const record = requireVerifiedCompatibility(capabilityKey);
    // Default matrix: help proves syntax only.
    expect(record.readOnly).toBe(false);
    expect(record.capabilities.nativePermissionRules).toBe(false);
    expect(record.capabilities.writeModes).toEqual([]);

    const { ref, root } = makeBundle();
    const built = trackBuilt(
      buildGrokCommand(
        baseInput({
          role: 'reviewer',
          mode: 'read_only',
          immutableReviewBundle: ref,
          capabilityRecord: record,
        }),
      ),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.args[0]).toBe('--cwd');
    expect(built.args[1]).toBe(root);
    expect(built.intent.liveProjectAccess).toBe(false);
    expect(built.intent.cwd).toBe(root);
    // Capability record still unproven even when bundle command is permitted.
    expect(record.readOnly).toBe(false);
    expect(record.capabilities.writeModes).toEqual([]);
    expect(GROK_LIVE_PROJECT_ENFORCEMENT_PROVEN).toBe(false);
  });

  it('omitted promptArtifact is dry-run (auth-before-prompt; no FS work)', () => {
    const built = trackBuilt(
      buildGrokCommand(
        baseInput({
          promptArtifact: undefined,
        }),
      ),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.promptFilePath).toBe('');
    expect(built.args).toContain('[PENDING_PROMPT_FILE]');
    expect(built.argsForEvidence).toContain('[REDACTED_PROMPT_FILE]');
  });

  it('cleanupGrokPromptArtifact reports sensitive_artifact_cleanup_failed on EPERM', () => {
    const eperm = Object.assign(new Error('EPERM simulated'), { code: 'EPERM' });
    const result = cleanupGrokPromptArtifact({
      filePath: join(tmpdir(), 'does-not-matter-prompt.txt'),
      maxAttempts: 3,
      unlinkImpl: () => {
        throw eperm;
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('sensitive_artifact_cleanup_failed');
    expect(result.pathRedacted).toMatch(/REDACTED_PROMPT/);
    expect(result.reason).toMatch(/sensitive_artifact_cleanup_failed|EPERM/i);
  });
});

describe('GrokAdapter ProcessSupervisorPort path', () => {
  const temporaryDirectories: string[] = [];
  const openedDatabases: OpenedDatabase[] = [];
  const TASK_ID = asTaskId('task-adapter-grok-1');

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
    readonly promptDir: string;
    readonly bundle: ImmutableReviewBundleRef;
    readonly bundleRoot: string;
  } {
    const directory = mkdtempSync(join(tmpdir(), 'triagent-grok-cmd-'));
    temporaryDirectories.push(directory);
    const promptDir = join(directory, 'prompts');
    const { ref, root } = makeBundle(PROJECT);
    temporaryDirectories.push(root);
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
      promptDir,
      bundle: ref,
      bundleRoot: root,
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
    request: GrokRunRequest,
  ): string {
    return repo.issue(
      {
        taskId: request.taskId ?? TASK_ID,
        attemptId: request.attemptId,
        adapterKind: 'grok',
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
    overrides: Partial<GrokRunRequest> = {},
    bundle?: ImmutableReviewBundleRef,
  ): GrokRunRequest {
    const capabilityKey = verifiedKey();
    const attemptId = overrides.attemptId ?? asAttemptId('attempt-adapter-grok-1');
    const mode = overrides.mode ?? 'patch_mode';
    const projectGuardDecisionId =
      overrides.projectGuardDecisionId ?? 'guard-decision-1';
    const reservedBudgetId =
      overrides.reservedBudgetId ?? 'budget-reservation-1';
    const base: GrokRunRequest = {
      attemptId,
      taskId: TASK_ID,
      baselineId: asBaselineId('baseline-adapter-grok-1'),
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
    // Only inject a default bundle when caller did not set the property at all.
    if (!Object.prototype.hasOwnProperty.call(overrides, 'immutableReviewBundle')) {
      return {
        ...base,
        immutableReviewBundle: bundle ?? makeBundle(PROJECT).ref,
      };
    }
    return base;
  }

  it('starts via ProcessSupervisorPort with exact structural argv and prompt-file', async () => {
    const clock = new FakeClock('2026-07-12T03:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 9101,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 9101 } },
        {
          afterMs: 1,
          event: {
            type: 'exited',
            pid: 9101,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    }]);
    const { launchAuth, sessionRepo, connection, promptDir, bundle, bundleRoot } =
      openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new GrokAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      promptFileDirectory: promptDir,
    });
    const base = runRequest({}, bundle);
    const request = runRequest({
      launchAuthorizationId: issueAuth(launchAuth, base),
      immutableReviewBundle: bundle,
    });
    const handle = await adapter.start(request);
    clock.advanceBy(5);

    const startCall = supervisor.calls.find((call) => call.type === 'start');
    expect(startCall).toBeDefined();
    if (startCall?.type !== 'start') return;
    expect(startCall.request.executable).toBe('grok');
    expect(startCall.request.args[0]).toBe('--cwd');
    expect(startCall.request.args).toContain(bundleRoot);
    expect(startCall.request.args).not.toContain(PROJECT);
    expect(startCall.request.args).toContain('--output-format');
    expect(startCall.request.args).toContain('streaming-json');
    expect(startCall.request.args).toContain('--session-id');
    expect(startCall.request.args).toContain(FIXED_SESSION);
    expect(startCall.request.args).toContain('--permission-mode');
    expect(startCall.request.args).toContain('auto');
    expect(startCall.request.args).toContain('Read,Glob,Grep');
    expect(startCall.request.args).toContain('--max-turns');
    expect(startCall.request.args).toContain('--prompt-file');
    // Prompt / secret never appear in argv.
    expect(startCall.request.args).not.toContain(PROMPT);
    expect(
      startCall.request.args.every((a) => !a.includes('secret-token-xyz')),
    ).toBe(true);
    expect(startCall.request.args).not.toContain('--single');
    expect(startCall.request.args).not.toContain('--always-approve');
    expect(startCall.request.args).not.toContain('--sandbox');
    // Process cwd is immutable bundle, not live project.
    expect(startCall.request.cwd).toBe(bundleRoot);
    expect(startCall.request.cwd).not.toBe(PROJECT);
    // No stdin prompt delivery for Grok (prompt-file).
    expect(startCall.request.stdin).toBeUndefined();
    expect(adapter.lastArgsForEvidence?.join(' ')).not.toContain(
      'secret-token-xyz',
    );
    expect(adapter.lastArgsForEvidence).toContain('[REDACTED_PROMPT_FILE]');
    expect(adapter.lastRunIntent?.projectGuardDecisionId).toBe('guard-decision-1');
    expect(adapter.lastRunIntent?.reservedBudgetId).toBe('budget-reservation-1');
    expect(adapter.lastRunIntent?.liveProjectAccess).toBe(false);
    await handle.wait();
    // Prompt cleaned after wait finally.
    if (adapter.lastPromptFilePath) {
      expect(existsSync(adapter.lastPromptFilePath)).toBe(false);
    }
  });

  it('resume requires persisted safe session evidence and fresh launch auth', async () => {
    const clock = new FakeClock('2026-07-12T03:10:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 9201,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 9201 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 9201,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
      {
        pid: 9202,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 9202 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 9202,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
    ]);
    const { launchAuth, sessionRepo, connection, promptDir, bundle, bundleRoot } =
      openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new GrokAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      promptFileDirectory: promptDir,
      fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
    });

    const startBase = runRequest({ mode: 'patch_mode', immutableReviewBundle: bundle });
    const startReq = runRequest({
      mode: 'patch_mode',
      immutableReviewBundle: bundle,
      launchAuthorizationId: issueAuth(launchAuth, startBase),
    });
    await adapter.start(startReq);
    const startIntent = adapter.lastRunIntent;
    adapter.markAttemptPersisted({
      attemptId: startReq.attemptId,
      conversationId: asConversationId(FIXED_SESSION),
      exitReason: 'completed',
    });

    const resumeBase = runRequest({
      attemptId: asAttemptId('attempt-adapter-grok-2'),
      mode: 'patch_mode',
      immutableReviewBundle: bundle,
    });
    const resumeReq = runRequest({
      attemptId: asAttemptId('attempt-adapter-grok-2'),
      mode: 'patch_mode',
      immutableReviewBundle: bundle,
      launchAuthorizationId: issueAuth(launchAuth, resumeBase),
    });
    await adapter.resume(asConversationId(FIXED_SESSION), resumeReq);
    const starts = supervisor.calls.filter((c) => c.type === 'start');
    expect(starts).toHaveLength(2);
    const resumeCall = starts[1];
    if (resumeCall?.type !== 'start') return;

    expect(resumeCall.request.args[0]).toBe('--cwd');
    expect(resumeCall.request.args).toContain(bundleRoot);
    expect(resumeCall.request.args).not.toContain(PROJECT);
    expect(resumeCall.request.args).toContain('--resume');
    expect(resumeCall.request.args).toContain(FIXED_SESSION);
    expect(resumeCall.request.args).toContain('streaming-json');
    expect(resumeCall.request.args).toContain('--permission-mode');
    expect(resumeCall.request.args).toContain('auto');
    expect(resumeCall.request.args).toContain('Read,Glob,Grep');
    expect(resumeCall.request.args).toContain('--max-turns');
    expect(resumeCall.request.args).not.toContain(PROMPT);
    expect(adapter.lastRunIntent?.permissionMode).toBe(startIntent?.permissionMode);
    expect(adapter.lastRunIntent?.allowedTools).toEqual(startIntent?.allowedTools);
    expect(adapter.lastRunIntent?.disallowedTools).toEqual(
      startIntent?.disallowedTools,
    );
    expect(adapter.lastRunIntent?.maxTurns).toBe(startIntent?.maxTurns);
    expect(adapter.lastRunIntent?.liveProjectAccess).toBe(false);
    expect(resumeCall.request.args).not.toContain('--always-approve');
  });

  it('refuses resume without persisted safe session evidence (killed/unpersisted)', async () => {
    const clock = new FakeClock('2026-07-12T03:15:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 9211,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 9211 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 9211,
              exitCode: 1,
              signal: null,
              reason: 'force_stop',
            },
          },
        ],
      },
    ]);
    const { launchAuth, sessionRepo, connection, promptDir, bundle } =
      openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new GrokAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      promptFileDirectory: promptDir,
      fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
    });

    const startBase = runRequest({ mode: 'patch_mode', immutableReviewBundle: bundle });
    await adapter.start(
      runRequest({
        mode: 'patch_mode',
        immutableReviewBundle: bundle,
        launchAuthorizationId: issueAuth(launchAuth, startBase),
      }),
    );
    adapter.markAttemptUnresumable({
      attemptId: startBase.attemptId,
      conversationId: asConversationId(FIXED_SESSION),
      reason: 'killed_unpersisted',
    });

    const resumeBase = runRequest({
      attemptId: asAttemptId('attempt-adapter-grok-killed'),
      mode: 'patch_mode',
      immutableReviewBundle: bundle,
    });
    await expect(
      adapter.resume(
        asConversationId(FIXED_SESSION),
        runRequest({
          attemptId: asAttemptId('attempt-adapter-grok-killed'),
          mode: 'patch_mode',
          immutableReviewBundle: bundle,
          launchAuthorizationId: issueAuth(launchAuth, resumeBase),
        }),
      ),
    ).rejects.toThrow(/start-new-context|unpersisted|killed|AdapterDisabled|resume/i);
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(1);
  });

  it('persists full permission profile hash and resumes only when current hash matches', async () => {
    const clock = new FakeClock('2026-07-12T03:16:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 9221,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 9221 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 9221,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
      {
        pid: 9222,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 9222 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 9222,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
    ]);
    const { launchAuth, sessionRepo, connection, promptDir, bundle } =
      openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new GrokAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      promptFileDirectory: promptDir,
      fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
    });

    const startBase = runRequest({
      mode: 'patch_mode',
      role: 'implementer',
      maxTurns: 16,
      immutableReviewBundle: bundle,
    });
    await adapter.start(
      runRequest({
        mode: 'patch_mode',
        role: 'implementer',
        maxTurns: 16,
        immutableReviewBundle: bundle,
        launchAuthorizationId: issueAuth(launchAuth, startBase),
      }),
    );
    const startHash = adapter.lastRunIntent
      ? undefined
      : undefined;
    void startHash;
    const stored = sessionRepo.findResumable({
      taskId: TASK_ID,
      agentKind: 'grok',
      conversationId: asConversationId(FIXED_SESSION),
      adapterVersion: VERIFIED_GROK_VERSION,
      adapterPlatform: process.platform,
    });
    // Not yet completed_persisted
    expect(stored).toBeUndefined();

    adapter.markAttemptPersisted({
      attemptId: startBase.attemptId,
      conversationId: asConversationId(FIXED_SESSION),
      exitReason: 'completed',
    });
    const completed = sessionRepo.findResumable({
      taskId: TASK_ID,
      agentKind: 'grok',
      conversationId: asConversationId(FIXED_SESSION),
      adapterVersion: VERIFIED_GROK_VERSION,
      adapterPlatform: process.platform,
    });
    expect(completed?.status).toBe('completed_persisted');
    expect(completed?.permissionProfileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completed?.role).toBe('implementer');
    expect(completed?.mode).toBe('patch_mode');

    const resumeBase = runRequest({
      attemptId: asAttemptId('attempt-adapter-grok-profile-ok'),
      mode: 'patch_mode',
      role: 'implementer',
      maxTurns: 16,
      immutableReviewBundle: bundle,
    });
    await adapter.resume(
      asConversationId(FIXED_SESSION),
      runRequest({
        attemptId: asAttemptId('attempt-adapter-grok-profile-ok'),
        mode: 'patch_mode',
        role: 'implementer',
        maxTurns: 16,
        immutableReviewBundle: bundle,
        launchAuthorizationId: issueAuth(launchAuth, resumeBase),
      }),
    );
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(2);
  });

  it.each([
    {
      label: 'plan->auto permission mode change',
      start: {
        role: 'implementer' as const,
        mode: 'read_only' as const,
        maxTurns: 16,
      },
      resume: {
        role: 'implementer' as const,
        mode: 'patch_mode' as const,
        maxTurns: 16,
      },
    },
    {
      label: 'role change',
      start: {
        role: 'reviewer' as const,
        mode: 'read_only' as const,
        maxTurns: 16,
      },
      resume: {
        role: 'master' as const,
        mode: 'read_only' as const,
        maxTurns: 16,
      },
    },
    {
      label: 'maxTurns change',
      start: {
        role: 'implementer' as const,
        mode: 'patch_mode' as const,
        maxTurns: 16,
      },
      resume: {
        role: 'implementer' as const,
        mode: 'patch_mode' as const,
        maxTurns: 32,
      },
    },
  ])(
    'resume with changed $label returns start-new-context with zero supervisor start (auth not sufficient)',
    async ({ start, resume }) => {
      const clock = new FakeClock('2026-07-12T03:17:00.000Z');
      const supervisor = new FakeProcessSupervisor(clock, [
        {
          pid: 9231,
          timeline: [
            { afterMs: 0, event: { type: 'started', pid: 9231 } },
            {
              afterMs: 1,
              event: {
                type: 'exited',
                pid: 9231,
                exitCode: 0,
                signal: null,
                reason: 'exited',
              },
            },
          ],
        },
      ]);
      const { launchAuth, sessionRepo, connection, promptDir, bundle } =
        openAuthAndSession();
      seedTask(connection, TASK_ID);
      const adapter = new GrokAdapter({
        supervisor,
        launchAuthorization: launchAuth,
        agentSessions: sessionRepo,
        promptFileDirectory: promptDir,
        fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
      });

      const startBase = runRequest({
        ...start,
        immutableReviewBundle: bundle,
      });
      await adapter.start(
        runRequest({
          ...start,
          immutableReviewBundle: bundle,
          launchAuthorizationId: issueAuth(launchAuth, startBase),
        }),
      );
      adapter.markAttemptPersisted({
        attemptId: startBase.attemptId,
        conversationId: asConversationId(FIXED_SESSION),
        exitReason: 'completed',
      });

      const resumeBase = runRequest({
        attemptId: asAttemptId(`attempt-adapter-grok-mismatch-${start.role}`),
        ...resume,
        immutableReviewBundle: bundle,
      });
      // Fresh auth is issued — necessary but not sufficient when profile diverges.
      const freshAuth = issueAuth(launchAuth, resumeBase);
      await expect(
        adapter.resume(
          asConversationId(FIXED_SESSION),
          runRequest({
            attemptId: asAttemptId(`attempt-adapter-grok-mismatch-${start.role}`),
            ...resume,
            immutableReviewBundle: bundle,
            launchAuthorizationId: freshAuth,
          }),
        ),
      ).rejects.toThrow(
        /start-new-context|permission profile|profile hash|AdapterDisabled/i,
      );
      expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(1);
    },
  );

  it('resume with different immutable bundle hash returns start-new-context (zero start)', async () => {
    const clock = new FakeClock('2026-07-12T03:18:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, [
      {
        pid: 9241,
        timeline: [
          { afterMs: 0, event: { type: 'started', pid: 9241 } },
          {
            afterMs: 1,
            event: {
              type: 'exited',
              pid: 9241,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
    ]);
    const { launchAuth, sessionRepo, connection, promptDir, bundle } =
      openAuthAndSession();
    seedTask(connection, TASK_ID);
    const otherBundle = makeBundle(PROJECT).ref;
    temporaryDirectories.push(otherBundle.bundleRoot);
    const adapter = new GrokAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      promptFileDirectory: promptDir,
      fixedCapabilities: requireVerifiedCompatibility(verifiedKey()).capabilities,
    });

    const startBase = runRequest({
      mode: 'patch_mode',
      immutableReviewBundle: bundle,
    });
    await adapter.start(
      runRequest({
        mode: 'patch_mode',
        immutableReviewBundle: bundle,
        launchAuthorizationId: issueAuth(launchAuth, startBase),
      }),
    );
    adapter.markAttemptPersisted({
      attemptId: startBase.attemptId,
      conversationId: asConversationId(FIXED_SESSION),
      exitReason: 'completed',
    });

    const resumeBase = runRequest({
      attemptId: asAttemptId('attempt-adapter-grok-bundle-mismatch'),
      mode: 'patch_mode',
      immutableReviewBundle: otherBundle,
    });
    await expect(
      adapter.resume(
        asConversationId(FIXED_SESSION),
        runRequest({
          attemptId: asAttemptId('attempt-adapter-grok-bundle-mismatch'),
          mode: 'patch_mode',
          immutableReviewBundle: otherBundle,
          launchAuthorizationId: issueAuth(launchAuth, resumeBase),
        }),
      ),
    ).rejects.toThrow(
      /start-new-context|permission profile|profile hash|bundle|AdapterDisabled/i,
    );
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(1);
  });

  it('refuses start without launch authorization (zero ProcessSupervisor start)', async () => {
    const clock = new FakeClock('2026-07-12T03:20:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const { launchAuth, sessionRepo, connection, promptDir, bundle } =
      openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new GrokAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      promptFileDirectory: promptDir,
    });
    await expect(
      adapter.start(runRequest({ immutableReviewBundle: bundle })),
    ).rejects.toThrow(
      /launchAuthorizationId|AdapterDisabled/i,
    );
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(0);
    // Auth rejected ⇒ no prompt file created under promptDir.
    expect(existsSync(promptDir) ? readdirSync(promptDir) : []).toEqual([]);
  });

  it('rejects forgeable startGate records', async () => {
    const clock = new FakeClock('2026-07-12T03:25:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const { launchAuth, sessionRepo, connection, promptDir, bundle } =
      openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new GrokAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      promptFileDirectory: promptDir,
    });
    const base = runRequest({ immutableReviewBundle: bundle });
    await expect(
      adapter.start({
        ...runRequest({
          immutableReviewBundle: bundle,
          launchAuthorizationId: issueAuth(launchAuth, base),
        }),
        // forgeable gate
        startGate: { allowed: true },
      } as GrokRunRequest & { startGate: { allowed: true } }),
    ).rejects.toThrow(/startGate|forgeable|AdapterDisabled/i);
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(0);
  });

  it('denies live-project reviewer/master/patch at adapter (no bundle)', async () => {
    const clock = new FakeClock('2026-07-12T03:30:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const { launchAuth, sessionRepo, connection, promptDir } =
      openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new GrokAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      promptFileDirectory: promptDir,
    });
    for (const sample of [
      { role: 'reviewer' as const, mode: 'read_only' as const },
      { role: 'master' as const, mode: 'read_only' as const },
      { role: 'implementer' as const, mode: 'patch_mode' as const },
    ]) {
      const base = runRequest({
        role: sample.role,
        mode: sample.mode,
        immutableReviewBundle: undefined,
      });
      // Force-clear bundle even if helper re-added.
      const req: GrokRunRequest = {
        ...base,
        role: sample.role,
        mode: sample.mode,
        launchAuthorizationId: issueAuth(launchAuth, {
          ...base,
          role: sample.role,
          mode: sample.mode,
        }),
      };
      delete (req as { immutableReviewBundle?: ImmutableReviewBundleRef })
        .immutableReviewBundle;
      await expect(adapter.start(req)).rejects.toThrow(
        /immutable review bundle|live-project|AdapterDisabled/i,
      );
    }
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(0);
  });

  it('auth rejection leaves zero prompt plaintext on disk', async () => {
    const clock = new FakeClock('2026-07-12T03:35:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const { launchAuth, sessionRepo, connection, promptDir, bundle } =
      openAuthAndSession();
    seedTask(connection, TASK_ID);
    const adapter = new GrokAdapter({
      supervisor,
      launchAuthorization: launchAuth,
      agentSessions: sessionRepo,
      promptFileDirectory: promptDir,
    });
    const base = runRequest({ immutableReviewBundle: bundle });
    // Reuse wrong auth id after issue+consume simulation: forge id.
    await expect(
      adapter.start(
        runRequest({
          immutableReviewBundle: bundle,
          launchAuthorizationId: 'not-a-real-auth-id',
        }),
      ),
    ).rejects.toThrow(/authorization|AdapterDisabled/i);
    expect(supervisor.calls.filter((c) => c.type === 'start')).toHaveLength(0);
    // No prompt files under promptDir.
    if (existsSync(promptDir)) {
      const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const name of readdirSync(dir)) {
          const abs = join(dir, name);
          out.push(abs);
          try {
            out.push(...walk(abs));
          } catch {
            // file
          }
        }
        return out;
      };
      for (const path of walk(promptDir)) {
        try {
          const body = readFileSync(path, 'utf8');
          expect(body).not.toContain('secret-token-xyz');
        } catch {
          // dirs
        }
      }
    }
    void base;
  });

  describe('isolated_implementation workspace_write profile', () => {
    function isolatedInput(
      overrides: Partial<GrokCommandInput> = {},
    ): GrokCommandInput {
      const workspaceRoot = join(tmpdir(), `triagent-isolated-ws-${Date.now()}`);
      temporaryPromptDirs.push(workspaceRoot);
      const { immutableReviewBundle: overrideBundle, isolatedWorkspace: overrideIsolated, ...rest } =
        overrides;
      const hasIsolated = Object.prototype.hasOwnProperty.call(overrides, 'isolatedWorkspace');
      return baseInput({
        role: 'implementer',
        mode: 'workspace_write',
        ...rest,
        isolatedWorkspace: hasIsolated
          ? overrideIsolated
          : {
              workspaceRoot,
              authorizationId: 'workspace-auth-unit-1',
              sourceManifestHash: 'c'.repeat(64),
            },
        immutableReviewBundle: Object.prototype.hasOwnProperty.call(overrides, 'immutableReviewBundle')
          ? overrideBundle
          : undefined,
      });
    }

    it('uses only the authorized candidate root for --cwd with auto mode and edit tools', () => {
      const workspaceRoot = join(tmpdir(), `triagent-isolated-ok-${Date.now()}`);
      temporaryPromptDirs.push(workspaceRoot);
      const built = buildGrokCommand(isolatedInput({
        isolatedWorkspace: {
          workspaceRoot,
          authorizationId: 'workspace-auth-ok',
          sourceManifestHash: 'd'.repeat(64),
        },
      }));
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.args).toContain('--cwd');
      expect(built.args[built.args.indexOf('--cwd') + 1]).toBe(resolve(workspaceRoot));
      expect(built.args).toContain('--permission-mode');
      expect(built.args[built.args.indexOf('--permission-mode') + 1]).toBe('auto');
      expect(built.args).toContain('streaming-json');
      expect(built.args).toContain('--prompt-file');
      expect(built.args).toContain('--max-turns');
      expect(built.intent.liveProjectAccess).toBe(false);
      expect(built.intent.mode).toBe('workspace_write');
      expect(built.intent.allowedTools).toEqual([
        ...GROK_ISOLATED_IMPLEMENTATION_ALLOWED_TOOLS,
      ]);
      expect(built.intent.disallowedTools).toEqual(
        expect.arrayContaining([...GROK_ISOLATED_IMPLEMENTATION_DENIED_TOOLS]),
      );
      expect(built.intent.allowedTools).toEqual(
        expect.arrayContaining(['Read', 'Glob', 'Grep', 'Edit', 'Write']),
      );
      expect(built.intent.disallowedTools).toEqual(
        expect.arrayContaining(['Bash', 'Shell']),
      );
      expect(built.args.join(' ')).not.toMatch(/always-approve|bypass|dontAsk/i);
      expect(built.args).not.toContain(PROJECT);
      expect(built.args.join(' ')).not.toContain(PROMPT);
      expect(built.intent.workspaceAuthorizationId).toBe('workspace-auth-ok');
      // Existing read-only tool set must remain for non-isolated profiles.
      expect(GROK_VERIFIED_READ_ONLY_TOOLS).not.toContain('Edit');
      expect(GROK_VERIFIED_DISALLOWED_WRITE_TOOLS).toContain('Edit');
    });

    it('refuses isolated profile without workspace ref or with root confusion', () => {
      expect(buildGrokCommand(isolatedInput({
        isolatedWorkspace: undefined,
      })).ok).toBe(false);

      const confused = buildGrokCommand(isolatedInput({
        isolatedWorkspace: {
          workspaceRoot: PROJECT,
          authorizationId: 'workspace-auth-confused',
          sourceManifestHash: 'e'.repeat(64),
        },
      }));
      expect(confused.ok).toBe(false);
      if (confused.ok) return;
      expect(confused.reason).toMatch(/root confusion|differ from live/i);

      const withBundle = buildGrokCommand(isolatedInput({
        immutableReviewBundle: makeBundle(PROJECT).ref,
      }));
      expect(withBundle.ok).toBe(false);
    });

    it('keeps immutable review profile unchanged for patch_mode', () => {
      const built = buildGrokCommand(baseInput({
        role: 'implementer',
        mode: 'patch_mode',
      }));
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.intent.allowedTools).toEqual([...GROK_VERIFIED_READ_ONLY_TOOLS]);
      expect(built.intent.disallowedTools).toEqual([
        ...GROK_VERIFIED_DISALLOWED_WRITE_TOOLS,
      ]);
      expect(built.intent.mode).toBe('patch_mode');
      expect(built.args[built.args.indexOf('--permission-mode') + 1]).toBe('auto');
    });
  });
});
