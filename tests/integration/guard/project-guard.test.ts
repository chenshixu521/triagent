import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentCapabilities } from '../../../src/agents/agent-capabilities.js';
import { asAttemptId } from '../../../src/domain/ids.js';
import {
  ProjectGuard,
  type GuardDecision,
} from '../../../src/guard/project-guard.js';
import type { AdapterPermissionProfile } from '../../../src/guard/adapter-permission-profile.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix = 'triagent-project-guard-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createProject(): string {
  const root = temporaryDirectory();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
  writeFileSync(join(root, 'package.json'), '{"name":"demo"}\n', 'utf8');
  return resolve(root);
}

function verifiedWriteCapabilities(): AgentCapabilities {
  return Object.freeze({
    fixedSessionId: true,
    resume: true,
    structuredOutput: true,
    streamJson: true,
    realTimeInput: false,
    nativeSandbox: false,
    nativePermissionRules: true,
    budgetLimit: true,
    turnLimit: true,
    timeLimit: true,
    nonGitProjects: true,
    writeModes: Object.freeze(['workspace-write', 'read-only'] as const),
  });
}

function readOnlyCapabilities(): AgentCapabilities {
  return Object.freeze({
    ...verifiedWriteCapabilities(),
    writeModes: Object.freeze(['read-only'] as const),
    nativePermissionRules: true,
  });
}

function unprovenCapabilities(): AgentCapabilities {
  return Object.freeze({
    fixedSessionId: false,
    resume: false,
    structuredOutput: true,
    streamJson: false,
    realTimeInput: false,
    nativeSandbox: false,
    nativePermissionRules: false,
    budgetLimit: false,
    turnLimit: false,
    timeLimit: false,
    nonGitProjects: false,
    writeModes: Object.freeze([] as const),
  });
}

function assertDecisionShape(decision: GuardDecision): void {
  expect(decision.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(decision.mode).toMatch(/^(auto_allowed|requires_confirmation|denied|patch_mode|disabled)$/);
  expect(decision.scope).toBeTypeOf('object');
  expect(decision.reason.length).toBeGreaterThan(0);
  expect(decision.attemptId).toBeTruthy();
  expect(decision.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(decision.expiresAt === null || typeof decision.expiresAt === 'string').toBe(true);
  expect(decision.capabilityEvidence).toBeTypeOf('object');
  expect(JSON.stringify(decision)).not.toMatch(/os sandbox|operating system sandbox/i);
  // Persistable plain data (structured clone / JSON).
  expect(() => JSON.parse(JSON.stringify(decision))).not.toThrow();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ProjectGuard side-effect gate', () => {
  it('auto-approves explicit project-local file operations for implementer with verified write capability', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const decision = guard.evaluateFileOperation({
      attemptId: asAttemptId('attempt-write-1'),
      role: 'implementer',
      operation: 'write',
      path: 'src/app.ts',
      capabilities: verifiedWriteCapabilities(),
      adapter: { kind: 'codex', version: '0.144.1' },
    });
    assertDecisionShape(decision);
    expect(decision.mode).toBe('auto_allowed');
    expect(decision.scope.kind).toBe('file_operation');
    expect(decision.capabilityEvidence.verified).toBe(true);
  });

  it('forces reviewer and master into read-only profiles', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    for (const role of ['reviewer', 'master'] as const) {
      const profile: AdapterPermissionProfile = guard.resolvePermissionProfile({
        role,
        capabilities: verifiedWriteCapabilities(),
        adapter: { kind: 'claude', version: '2.1.206' },
      });
      expect(profile.writeMode).toBe('read-only');
      expect(profile.shellToolsEnabled).toBe(false);
      expect(profile.fileWriteEnabled).toBe(false);

      const decision = guard.evaluateFileOperation({
        attemptId: asAttemptId(`attempt-${role}`),
        role,
        operation: 'write',
        path: 'src/app.ts',
        capabilities: verifiedWriteCapabilities(),
        adapter: { kind: 'claude', version: '2.1.206' },
      });
      expect(decision.mode).toBe('denied');
      expect(decision.reason).toMatch(/read-only|reviewer|master/i);
    }
  });

  it('selects read-only patch mode when implementer write capability is not objectively enforceable', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    // Claude has proven patch_mode; Grok 0.2.93 live-project patch is disabled.
    const profile = guard.resolvePermissionProfile({
      role: 'implementer',
      capabilities: readOnlyCapabilities(),
      adapter: { kind: 'claude', version: '2.1.206' },
    });
    expect(profile.mode).toBe('patch_mode');
    expect(profile.writeMode).toBe('read-only');
    expect(profile.fileWriteEnabled).toBe(false);

    const decision = guard.evaluateAdapterStart({
      attemptId: asAttemptId('attempt-patch-mode'),
      role: 'implementer',
      capabilities: readOnlyCapabilities(),
      adapter: { kind: 'claude', version: '2.1.206' },
    });
    expect(decision.mode).toBe('patch_mode');
    expect(decision.capabilityEvidence.verified).toBe(true);

    // Grok default: neither project-write nor live patch is proven.
    const grokProfile = guard.resolvePermissionProfile({
      role: 'implementer',
      capabilities: readOnlyCapabilities(),
      adapter: { kind: 'grok', version: '0.2.93' },
    });
    expect(grokProfile.mode).toBe('disabled');
  });

  it('disables implementer adapter when neither direct-write nor patch mode can be proven', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const profile = guard.resolvePermissionProfile({
      role: 'implementer',
      capabilities: unprovenCapabilities(),
      adapter: { kind: 'claude', version: '0.0.0-unknown' },
    });
    expect(profile.mode).toBe('disabled');
    const decision = guard.evaluateAdapterStart({
      attemptId: asAttemptId('attempt-disabled'),
      role: 'implementer',
      capabilities: unprovenCapabilities(),
      adapter: { kind: 'claude', version: '0.0.0-unknown' },
    });
    expect(decision.mode).toBe('disabled');
    expect(decision.capabilityEvidence.verified).toBe(false);
  });

  it('requires confirmation for shells/network/unknown commands and denies destructive git', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const shell = guard.evaluateCommand({
      attemptId: asAttemptId('attempt-shell'),
      role: 'implementer',
      executable: 'powershell.exe',
      argv: ['-Command', 'Get-Process'],
      cwd: root,
      capabilities: verifiedWriteCapabilities(),
      adapter: { kind: 'codex', version: '0.144.1' },
    });
    expect(shell.mode).toBe('requires_confirmation');

    const install = guard.evaluateCommand({
      attemptId: asAttemptId('attempt-install'),
      role: 'implementer',
      executable: 'npm.cmd',
      argv: ['install', 'lodash'],
      cwd: root,
      capabilities: verifiedWriteCapabilities(),
      adapter: { kind: 'codex', version: '0.144.1' },
    });
    expect(install.mode).toBe('requires_confirmation');

    const unknown = guard.evaluateCommand({
      attemptId: asAttemptId('attempt-unknown'),
      role: 'implementer',
      executable: 'mystery.exe',
      argv: ['run'],
      cwd: root,
      capabilities: verifiedWriteCapabilities(),
      adapter: { kind: 'codex', version: '0.144.1' },
    });
    expect(unknown.mode).toBe('requires_confirmation');

    const destructive = guard.evaluateCommand({
      attemptId: asAttemptId('attempt-git'),
      role: 'implementer',
      executable: 'git.exe',
      argv: ['reset', '--hard', 'HEAD'],
      cwd: root,
      capabilities: verifiedWriteCapabilities(),
      adapter: { kind: 'codex', version: '0.144.1' },
    });
    expect(destructive.mode).toBe('denied');
  });

  it('auto-allows only allowlisted verification commands with project-local cwd', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const decision = guard.evaluateCommand({
      attemptId: asAttemptId('attempt-verify'),
      role: 'implementer',
      executable: 'npm.cmd',
      argv: ['test'],
      cwd: root,
      capabilities: verifiedWriteCapabilities(),
      adapter: { kind: 'codex', version: '0.144.1' },
    });
    expect(decision.mode).toBe('auto_allowed');
    expect(decision.scope.kind).toBe('command');
  });

  it('fails closed for path escape via command argument even when cwd is project-local', () => {
    const root = createProject();
    const outside = join(root, '..', 'outside.txt');
    writeFileSync(outside, 'x\n', 'utf8');
    temporaryDirectories.push(outside);
    const guard = new ProjectGuard({ projectRoot: root });
    const decision = guard.evaluateCommand({
      attemptId: asAttemptId('attempt-arg-escape'),
      role: 'implementer',
      executable: 'node.exe',
      argv: [outside],
      cwd: root,
      pathArguments: [outside],
      capabilities: verifiedWriteCapabilities(),
      adapter: { kind: 'codex', version: '0.144.1' },
    });
    expect(decision.mode).toBe('denied');
    expect(decision.reason).toMatch(/outside|escape|path/i);
  });

  it('denies capability downgrade attempts that request write without verified evidence', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const decision = guard.evaluateFileOperation({
      attemptId: asAttemptId('attempt-downgrade'),
      role: 'implementer',
      operation: 'write',
      path: 'src/app.ts',
      capabilities: unprovenCapabilities(),
      adapter: { kind: 'grok', version: '0.0.1' },
    });
    expect(['denied', 'patch_mode', 'disabled']).toContain(decision.mode);
    expect(decision.mode).not.toBe('auto_allowed');
    expect(decision.capabilityEvidence.verified).toBe(false);
  });

  it('binds decisions to attempt IDs and supports expiry metadata', () => {
    const root = createProject();
    const guard = new ProjectGuard({
      projectRoot: root,
      decisionTtlMs: 60_000,
      now: () => new Date('2026-07-12T12:00:00.000Z'),
    });
    const decision = guard.evaluateCommand({
      attemptId: asAttemptId('attempt-binding'),
      role: 'implementer',
      executable: 'npm.cmd',
      argv: ['test'],
      cwd: root,
      capabilities: verifiedWriteCapabilities(),
      adapter: { kind: 'codex', version: '0.144.1' },
    });
    expect(decision.attemptId).toBe('attempt-binding');
    expect(decision.createdAt).toBe('2026-07-12T12:00:00.000Z');
    expect(decision.expiresAt).toBe('2026-07-12T12:01:00.000Z');
    assertDecisionShape(decision);
  });

  it('fails closed for unknown operations', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const decision = guard.evaluateUnknown({
      attemptId: asAttemptId('attempt-unknown-op'),
      role: 'implementer',
      description: 'opaque side effect',
      capabilities: verifiedWriteCapabilities(),
      adapter: { kind: 'codex', version: '0.144.1' },
    });
    expect(decision.mode).toBe('denied');
    expect(decision.reason).toMatch(/unknown|fail.?closed/i);
  });

  it('does not auto-allow reviewer/master when all capabilities are false', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const allFalse: AgentCapabilities = Object.freeze({
      fixedSessionId: false,
      resume: false,
      structuredOutput: false,
      streamJson: false,
      realTimeInput: false,
      nativeSandbox: false,
      nativePermissionRules: false,
      budgetLimit: false,
      turnLimit: false,
      timeLimit: false,
      nonGitProjects: false,
      writeModes: Object.freeze([] as const),
    });
    for (const role of ['reviewer', 'master'] as const) {
      const profile = guard.resolvePermissionProfile({
        role,
        capabilities: allFalse,
        adapter: { kind: 'claude', version: '0.0.0-unknown' },
      });
      expect(profile.mode).toMatch(/disabled|requires_confirmation|read_only/);
      expect(profile.capabilityVerified).toBe(false);

      const start = guard.evaluateAdapterStart({
        attemptId: asAttemptId(`attempt-all-false-${role}`),
        role,
        capabilities: allFalse,
        adapter: { kind: 'claude', version: '0.0.0-unknown' },
      });
      expect(start.mode).not.toBe('auto_allowed');
      expect(['disabled', 'requires_confirmation']).toContain(start.mode);

      const command = guard.evaluateCommand({
        attemptId: asAttemptId(`attempt-all-false-cmd-${role}`),
        role,
        executable: 'npm.cmd',
        argv: ['test'],
        cwd: root,
        capabilities: allFalse,
        adapter: { kind: 'claude', version: '0.0.0-unknown' },
      });
      expect(command.mode).not.toBe('auto_allowed');
    }
  });

  it('does not treat generic structuredOutput or native rules alone as proven read-only for reviewer/master', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const genericOnly: AgentCapabilities = Object.freeze({
      fixedSessionId: false,
      resume: false,
      structuredOutput: true,
      streamJson: false,
      realTimeInput: false,
      nativeSandbox: false,
      nativePermissionRules: true,
      budgetLimit: false,
      turnLimit: false,
      timeLimit: false,
      nonGitProjects: false,
      writeModes: Object.freeze([] as const),
    });
    for (const role of ['reviewer', 'master'] as const) {
      const start = guard.evaluateAdapterStart({
        attemptId: asAttemptId(`attempt-generic-${role}`),
        role,
        capabilities: genericOnly,
        adapter: { kind: 'grok', version: 'unproven-generic' },
      });
      expect(start.mode).not.toBe('auto_allowed');
      expect(start.capabilityEvidence.verified).toBe(false);
    }
  });

  it('requires proven read-only/structured patch contract for implementer patch mode', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const structuredOnly: AgentCapabilities = Object.freeze({
      fixedSessionId: false,
      resume: false,
      structuredOutput: true,
      streamJson: false,
      realTimeInput: false,
      nativeSandbox: false,
      nativePermissionRules: false,
      budgetLimit: false,
      turnLimit: false,
      timeLimit: false,
      nonGitProjects: false,
      writeModes: Object.freeze([] as const),
    });
    const profile = guard.resolvePermissionProfile({
      role: 'implementer',
      capabilities: structuredOnly,
      adapter: { kind: 'claude', version: 'unproven' },
    });
    expect(profile.mode).not.toBe('project_write');
    // structuredOutput alone without read-only writeModes or proven contract is not enough.
    if (profile.mode === 'patch_mode') {
      expect(profile.capabilityVerified).toBe(true);
      expect(structuredOnly.writeModes).toContain('read-only');
    } else {
      expect(profile.mode).toBe('disabled');
    }
  });

  it('does not grant Claude 2.1.206 direct project_write (patch_mode only)', () => {
    const root = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const claudeCaps: AgentCapabilities = Object.freeze({
      fixedSessionId: true,
      resume: true,
      structuredOutput: true,
      streamJson: true,
      realTimeInput: false,
      nativeSandbox: false,
      nativePermissionRules: true,
      budgetLimit: false,
      turnLimit: false,
      timeLimit: false,
      nonGitProjects: true,
      writeModes: Object.freeze(['read-only'] as const),
    });
    const profile = guard.resolvePermissionProfile({
      role: 'implementer',
      capabilities: claudeCaps,
      adapter: { kind: 'claude', version: '2.1.206' },
    });
    expect(profile.mode).toBe('patch_mode');
    expect(profile.fileWriteEnabled).toBe(false);
    expect(profile.writeMode).toBe('read-only');

    // Even if a caller forges workspace-write on capabilities, Claude is not
    // on the verified project-write allowlist.
    const forgedWrite: AgentCapabilities = Object.freeze({
      ...claudeCaps,
      writeModes: Object.freeze(['workspace-write', 'read-only'] as const),
    });
    const forged = guard.resolvePermissionProfile({
      role: 'implementer',
      capabilities: forgedWrite,
      adapter: { kind: 'claude', version: '2.1.206' },
    });
    expect(forged.mode).not.toBe('project_write');
    expect(forged.mode).toBe('patch_mode');
  });
});
