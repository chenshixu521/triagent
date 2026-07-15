import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { asAttemptId } from '../../../src/domain/ids.js';
import type { IdentityProbeRaw } from '../../../src/process/process-identity-probe.js';
import { ProcessSupervisor } from '../../../src/process/process-supervisor.js';
import type { ProcessSupervisorEvent } from '../../../src/process/process-supervisor-port.js';

/**
 * Lightweight host double: emits host_exit so supervisor must prove cleanup via
 * the identity probe without spawning a real ProcessHost.
 */
class FakeHostClient {
  readonly #emitter = new EventEmitter();
  killHelperCalls = 0;
  readonly startRequests: Array<{
    readonly attemptId: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }> = [];

  async start(): Promise<void> {
    // no-op
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.#emitter.on('event', listener);
    return () => {
      this.#emitter.off('event', listener);
    };
  }

  async startProcess(request: {
    readonly attemptId: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }): Promise<{
    readonly attemptId: string;
    readonly pid: number;
    readonly startedAt: string;
  }> {
    this.startRequests.push(request);
    return {
      attemptId: request.attemptId,
      pid: 4242,
      startedAt: '2026-07-12T12:00:00.000Z',
    };
  }

  requestStop(): void {
    // no-op
  }

  killHelper(): void {
    this.killHelperCalls += 1;
    this.#emitter.emit('event', {
      type: 'host_exit',
      exitCode: 1,
      signal: null,
    });
  }

  closeStdin(): void {
    this.killHelper();
  }

  async dispose(): Promise<void> {
    // no-op
  }
}

function installHostFactory(host: FakeHostClient): () => void {
  const original = ProcessSupervisor.createHostClientForTests;
  ProcessSupervisor.createHostClientForTests = () => host as never;
  return () => {
    ProcessSupervisor.createHostClientForTests = original;
  };
}

describe('ProcessSupervisor identity probe fail-closed', () => {
  const restorers: Array<() => void> = [];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const restore of restorers.splice(0).reverse()) restore();
    for (const directory of temporaryDirectories.splice(0).reverse()) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('passes the package-native executable to ProcessHost for a Codex npm shim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'triagent-supervisor-cli-'));
    temporaryDirectories.push(root);
    const npmBin = join(root, 'npm');
    const project = join(root, 'project');
    const native = join(
      npmBin,
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    );
    mkdirSync(dirname(native), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(npmBin, 'codex.cmd'), '@echo off\r\n', 'utf8');
    writeFileSync(native, 'codex-native', 'utf8');

    const host = new FakeHostClient();
    restorers.push(installHostFactory(host));
    restorers.push(
      ProcessSupervisor.installIdentityProbeForTests(async () => ({
        kind: 'close',
        exitCode: 3,
        stdout: '',
        stderr: '',
      })),
    );
    const attemptId = asAttemptId('attempt-resolved-codex-native');
    const supervisor = new ProcessSupervisor({
      helperPath: 'unused.exe',
      __testOnlyAllowUntrustedHelper: true,
    });

    await supervisor.start({
      attemptId,
      executable: 'codex',
      args: ['--version'],
      cwd: project,
      environment: {
        PATH: npmBin,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      },
    });

    expect(host.startRequests).toHaveLength(1);
    expect(host.startRequests[0]?.command).toBe(realpathSync.native(native));

    await supervisor.crashHelperForTests(attemptId);
    await supervisor.wait(attemptId);
    await supervisor.dispose();
  });

  it('emits cleanup_failed (not cleanup_succeeded) when PowerShell is missing', async () => {
    const host = new FakeHostClient();
    restorers.push(installHostFactory(host));
    restorers.push(
      ProcessSupervisor.installIdentityProbeForTests(async () => ({
        kind: 'spawn_error',
        error: new Error('spawn powershell.exe ENOENT'),
      })),
    );

    const attemptId = asAttemptId('attempt-missing-powershell');
    const supervisor = new ProcessSupervisor({ helperPath: 'unused.exe', __testOnlyAllowUntrustedHelper: true });
    const events: ProcessSupervisorEvent[] = [];
    supervisor.subscribe(attemptId, (event) => {
      events.push(event);
    });

    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    await supervisor.crashHelperForTests(attemptId);
    const waitResult = await supervisor.wait(attemptId);

    expect(events.some((event) => event.type === 'cleanup_succeeded')).toBe(false);
    const failed = events.find((event) => event.type === 'cleanup_failed');
    expect(failed).toBeDefined();
    if (failed?.type === 'cleanup_failed') {
      expect(failed.error).toMatch(/probe|spawn|ENOENT|unavailable|proven/i);
    }
    expect(events.some((event) => event.type === 'exited')).toBe(true);
    expect(waitResult.reason).toBe('force_stop');
    await supervisor.dispose();
  });

  it('emits cleanup_failed when identity probe exits nonzero', async () => {
    const host = new FakeHostClient();
    restorers.push(installHostFactory(host));
    restorers.push(
      ProcessSupervisor.installIdentityProbeForTests(async () => ({
        kind: 'close',
        exitCode: 1,
        stdout: '',
        stderr: 'Access is denied',
      } satisfies IdentityProbeRaw)),
    );

    const attemptId = asAttemptId('attempt-probe-nonzero');
    const supervisor = new ProcessSupervisor({ helperPath: 'unused.exe', __testOnlyAllowUntrustedHelper: true });
    const events: ProcessSupervisorEvent[] = [];
    supervisor.subscribe(attemptId, (event) => {
      events.push(event);
    });

    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    await supervisor.crashHelperForTests(attemptId);
    await supervisor.wait(attemptId);

    expect(events.some((event) => event.type === 'cleanup_succeeded')).toBe(false);
    expect(events.some((event) => event.type === 'cleanup_failed')).toBe(true);
    await supervisor.dispose();
  });

  it('emits cleanup_failed when identity probe returns malformed output', async () => {
    const host = new FakeHostClient();
    restorers.push(installHostFactory(host));
    restorers.push(
      ProcessSupervisor.installIdentityProbeForTests(async () => ({
        kind: 'close',
        exitCode: 0,
        stdout: 'not-a-date',
        stderr: '',
      })),
    );

    const attemptId = asAttemptId('attempt-probe-malformed');
    const supervisor = new ProcessSupervisor({ helperPath: 'unused.exe', __testOnlyAllowUntrustedHelper: true });
    const events: ProcessSupervisorEvent[] = [];
    supervisor.subscribe(attemptId, (event) => {
      events.push(event);
    });

    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    await supervisor.crashHelperForTests(attemptId);
    await supervisor.wait(attemptId);

    expect(events.some((event) => event.type === 'cleanup_succeeded')).toBe(false);
    expect(events.some((event) => event.type === 'cleanup_failed')).toBe(true);
    await supervisor.dispose();
  });

  it('emits cleanup_failed on access-denied probe exit', async () => {
    const host = new FakeHostClient();
    restorers.push(installHostFactory(host));
    restorers.push(
      ProcessSupervisor.installIdentityProbeForTests(async () => ({
        kind: 'close',
        exitCode: 5,
        stdout: '',
        stderr: 'Access is denied.',
      })),
    );

    const attemptId = asAttemptId('attempt-probe-access-denied');
    const supervisor = new ProcessSupervisor({ helperPath: 'unused.exe', __testOnlyAllowUntrustedHelper: true });
    const events: ProcessSupervisorEvent[] = [];
    supervisor.subscribe(attemptId, (event) => {
      events.push(event);
    });

    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    await supervisor.crashHelperForTests(attemptId);
    await supervisor.wait(attemptId);

    expect(events.some((event) => event.type === 'cleanup_succeeded')).toBe(false);
    const failed = events.find((event) => event.type === 'cleanup_failed');
    expect(failed?.type).toBe('cleanup_failed');
    await supervisor.dispose();
  });

  it('emits cleanup_succeeded only when probe verifies process gone', async () => {
    const host = new FakeHostClient();
    restorers.push(installHostFactory(host));
    restorers.push(
      ProcessSupervisor.installIdentityProbeForTests(async () => ({
        kind: 'close',
        exitCode: 3,
        stdout: '',
        stderr: '',
      })),
    );

    const attemptId = asAttemptId('attempt-probe-gone');
    const supervisor = new ProcessSupervisor({ helperPath: 'unused.exe', __testOnlyAllowUntrustedHelper: true });
    const events: ProcessSupervisorEvent[] = [];
    supervisor.subscribe(attemptId, (event) => {
      events.push(event);
    });

    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    await supervisor.crashHelperForTests(attemptId);
    await supervisor.wait(attemptId);

    expect(events.some((event) => event.type === 'cleanup_succeeded')).toBe(true);
    expect(events.some((event) => event.type === 'cleanup_failed')).toBe(false);
    await supervisor.dispose();
  });

  it('settles wait and fans out exited even when an exited listener throws', async () => {
    const host = new FakeHostClient();
    restorers.push(installHostFactory(host));
    restorers.push(
      ProcessSupervisor.installIdentityProbeForTests(async () => ({
        kind: 'close',
        exitCode: 3,
        stdout: '',
        stderr: '',
      })),
    );

    const attemptId = asAttemptId('attempt-throwing-exited');
    const supervisor = new ProcessSupervisor({ helperPath: 'unused.exe', __testOnlyAllowUntrustedHelper: true });
    const healthy: string[] = [];
    supervisor.subscribe(attemptId, (event) => {
      if (event.type === 'exited') throw new Error('exit listener exploded');
    });
    supervisor.subscribe(attemptId, (event) => {
      healthy.push(event.type);
    });

    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });

    const waiting = supervisor.wait(attemptId);
    const settlements = vi.fn();
    void waiting.then(settlements);

    // host_exit path is async via eventChain; throw must not wedge wait.
    await supervisor.crashHelperForTests(attemptId);

    await expect(waiting).resolves.toMatchObject({
      attemptId,
      reason: 'force_stop',
    });
    expect(settlements).toHaveBeenCalledTimes(1);
    expect(healthy).toContain('exited');
    expect(healthy).toContain('cleanup_succeeded');
    // Second force must be a no-op after settle.
    await supervisor.forceStopTree(attemptId);
    await Promise.resolve();
    expect(settlements).toHaveBeenCalledTimes(1);

    await supervisor.dispose();
  });
});
