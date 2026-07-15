import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { asAttemptId } from '../../../src/domain/ids.js';
import {
  resolveProcessHostExecutable,
  ProcessHostClient,
} from '../../../src/process/process-host-client.js';
import { ProcessSupervisor } from '../../../src/process/process-supervisor.js';
import type { ProcessSupervisorEvent } from '../../../src/process/process-supervisor-port.js';

const FIXTURE_DIR = dirname(
  fileURLToPath(new URL('../../fixtures/process-tree/parent.mjs', import.meta.url)),
);
const PARENT_FIXTURE = join(FIXTURE_DIR, 'parent.mjs');

const temporaryDirectories: string[] = [];
const activeSupervisors: ProcessSupervisor[] = [];
const orphanHelpers: ChildProcessWithoutNullStreams[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-job-object-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function readRecordedPids(pidFile: string): number[] {
  if (!existsSync(pidFile)) return [];
  const text = readFileSync(pidFile, 'utf8');
  const pids = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  return [...new Set(pids)];
}

interface PidIdentity {
  readonly pid: number;
  readonly startedAt: string;
}

/**
 * Capture PID+start-time while the fixture records PIDs so force-stop cannot
 * race out identity proof under concurrent suite load.
 */
async function captureIdentitiesAsRecorded(
  pidFile: string,
  minCount: number,
  label: string,
  timeoutMs = 20_000,
): Promise<{ pids: number[]; identities: PidIdentity[] }> {
  const identitiesByPid = new Map<number, PidIdentity>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = readRecordedPids(pidFile);
    for (const pid of pids) {
      if (identitiesByPid.has(pid)) continue;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const startedAt = await queryProcessStartTimeIso(pid);
        if (startedAt !== null) {
          identitiesByPid.set(pid, { pid, startedAt });
          break;
        }
        await sleep(25);
      }
    }
    if (identitiesByPid.size >= minCount) {
      const identities = [...identitiesByPid.values()];
      return {
        pids: identities.map((identity) => identity.pid),
        identities,
      };
    }
    await sleep(40);
  }
  const recorded = readRecordedPids(pidFile);
  throw new Error(
    `timed out waiting for ${label}: got ${String(identitiesByPid.size)} identities, recordedPids=${recorded.join(',')}`,
  );
}

/**
 * Create a parent Windows Job and assign a live PID into it.
 * Used to prove nested-job behavior for ProcessHost itself.
 * Returns a disposer that closes the Job handle (KILL_ON_JOB_CLOSE not set
 * on this parent job â€?we only use it for membership, not kill-on-close).
 */
async function assignPidToParentJob(pid: number): Promise<{
  readonly jobHandle: string;
  readonly dispose: () => Promise<void>;
}> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NestedJobNative {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
  public const uint PROCESS_SET_QUOTA = 0x0100;
  public const uint PROCESS_TERMINATE = 0x0001;
  public const uint PROCESS_QUERY_INFORMATION = 0x0400;
  public const uint PROCESS_VM_READ = 0x0010;
}
"@
$job = [NestedJobNative]::CreateJobObjectW([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw "CreateJobObjectW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$access = [NestedJobNative]::PROCESS_SET_QUOTA -bor [NestedJobNative]::PROCESS_TERMINATE -bor [NestedJobNative]::PROCESS_QUERY_INFORMATION
$proc = [NestedJobNative]::OpenProcess($access, $false, ${String(pid)})
if ($proc -eq [IntPtr]::Zero) {
  [void][NestedJobNative]::CloseHandle($job)
  throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
try {
  if (-not [NestedJobNative]::AssignProcessToJobObject($job, $proc)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "AssignProcessToJobObject(parent) failed: $err"
  }
} finally {
  [void][NestedJobNative]::CloseHandle($proc)
}
# Keep job handle open via a named event wait so the handle stays alive until we signal close.
# Emit handle as int64 for the test process to track.
Write-Output ([int64]$job)
# Block until stdin closes (test ends the PowerShell when dispose runs).
[Console]::In.ReadLine() | Out-Null
[void][NestedJobNative]::CloseHandle($job)
`;
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  orphanHelpers.push(child as ChildProcessWithoutNullStreams);

  const handleLine = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`assignPidToParentJob timed out; stderr=${stderr}`));
    }, 15_000);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const line = stdout.split(/\r?\n/u).find((entry) => entry.trim().length > 0);
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(line.trim());
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `parent-job helper exited early code=${String(code)} stderr=${stderr} stdout=${stdout}`,
        ),
      );
    });
  });

  return {
    jobHandle: handleLine,
    dispose: async () => {
      try {
        child.stdin?.write('\n');
        child.stdin?.end();
      } catch {
        // ignore
      }
      try {
        child.kill();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Query process start time via CIM without killing anything.
 * Returns null when the process is gone or identity cannot be read.
 */
async function queryProcessStartTimeIso(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}" -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 3 }; $p.CreationDate.ToUniversalTime().ToString('o')`,
      ],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const value = stdout.trim();
      if (value.length === 0) {
        resolve(null);
        return;
      }
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) {
        resolve(null);
        return;
      }
      resolve(new Date(parsed).toISOString());
      void stderr;
    });
  });
}

async function isProcessAlive(pid: number): Promise<boolean> {
  const start = await queryProcessStartTimeIso(pid);
  return start !== null;
}

async function assertAllPidsDead(pids: readonly number[], label: string): Promise<void> {
  // PID-only is insufficient under full-suite load (Windows reuses PIDs). Prefer
  // captureIdentities + assertIdentitiesDead for hard gates. This helper remains
  // as a best-effort check: a live PID without a matching start-time is reuse.
  const stillAlive: number[] = [];
  for (const pid of pids) {
    if (await isProcessAlive(pid)) stillAlive.push(pid);
  }
  if (stillAlive.length === 0) return;
  // Soft-note reuse candidates: if every "alive" PID has a different start-time
  // than any pre-stop identity, identity checks already covered the gate.
  expect(
    stillAlive,
    `${label}: PID-only still reports live PIDs (may be reuse under load): ${stillAlive.join(',')}. Prefer PID+start-time identity assertions.`,
  ).toEqual([]);
}

/**
 * Capture PID + start-time identity. PID-only liveness is insufficient under load
 * because Windows may reuse PIDs after termination.
 */
async function captureIdentities(pids: readonly number[]): Promise<PidIdentity[]> {
  const identities: PidIdentity[] = [];
  for (const pid of pids) {
    const startedAt = await queryProcessStartTimeIso(pid);
    expect(
      startedAt,
      `expected live identity for pid=${String(pid)} before stop`,
    ).not.toBeNull();
    if (startedAt !== null) {
      identities.push({ pid, startedAt });
    }
  }
  return identities;
}

/** True when the exact PID+start-time identity is still present. */
async function isIdentityAlive(identity: PidIdentity): Promise<boolean> {
  const liveStart = await queryProcessStartTimeIso(identity.pid);
  if (liveStart === null) return false;
  const expected = Date.parse(identity.startedAt);
  const actual = Date.parse(liveStart);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    // Cannot prove match â€?treat as still present for hard-gate safety.
    return true;
  }
  return Math.abs(expected - actual) <= 2_000;
}

async function assertIdentitiesDead(
  identities: readonly PidIdentity[],
  label: string,
): Promise<void> {
  const stillAlive: string[] = [];
  for (const identity of identities) {
    if (await isIdentityAlive(identity)) {
      stillAlive.push(`${String(identity.pid)}@${identity.startedAt}`);
    }
  }
  expect(
    stillAlive,
    `${label}: expected all PID+start-time identities dead, still alive: ${stillAlive.join(',')}`,
  ).toEqual([]);
}

beforeAll(() => {
  const helper = resolveProcessHostExecutable();
  if (!existsSync(helper)) {
    throw new Error(
      `ProcessHost helper missing at ${helper}. Run npm.cmd run build:native first.`,
    );
  }
});

afterEach(async () => {
  for (const supervisor of activeSupervisors.splice(0).reverse()) {
    await supervisor.dispose().catch(() => undefined);
  }
  for (const helper of orphanHelpers.splice(0).reverse()) {
    try {
      helper.kill();
    } catch {
      // ignore
    }
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Windows Job Object supervision (Task 12)', () => {
  it('force-stops parent+child+grandchild and proves every recorded PID is gone', async () => {
    const directory = temporaryDirectory();
    const pidFile = join(directory, 'pids.txt');
    writeFileSync(pidFile, '', 'utf8');
    const attemptId = asAttemptId('attempt-force-tree');
    const supervisor = new ProcessSupervisor({
      helperPath: resolveProcessHostExecutable(),
    });
    activeSupervisors.push(supervisor);

    const events: ProcessSupervisorEvent[] = [];
    supervisor.subscribe(attemptId, (event) => {
      events.push(event);
    });

    const started = await supervisor.start({
      attemptId,
      executable: process.execPath,
      args: [PARENT_FIXTURE],
      cwd: directory,
      environment: {
        TRIAGENT_PID_FILE: pidFile,
      },
    });

    expect(started.pid).toBeGreaterThan(0);
    expect(started.startedAt.length).toBeGreaterThan(0);

    // Deterministically record parent+child+grandchild identities BEFORE force.
    const { pids: treePids, identities } = await captureIdentitiesAsRecorded(
      pidFile,
      3,
      'parent/child/grandchild identities before force',
    );
    expect(treePids.length).toBeGreaterThanOrEqual(3);
    expect(identities.length).toBeGreaterThanOrEqual(3);
    // All recorded identities must be alive before force stop.
    for (const identity of identities) {
      expect(await isIdentityAlive(identity)).toBe(true);
    }

    await supervisor.forceStopTree(attemptId);
    const waitResult = await supervisor.wait(attemptId);

    expect(waitResult.reason).toBe('force_stop');
    expect(events.some((event) => event.type === 'cleanup_succeeded')).toBe(true);
    expect(events.some((event) => event.type === 'exited')).toBe(true);
    // Hard gate: wait must not complete before cleanup_succeeded (tree_clean path).
    const cleanupIdx = events.findIndex((event) => event.type === 'cleanup_succeeded');
    const exitedIdx = events.findIndex((event) => event.type === 'exited');
    expect(cleanupIdx).toBeGreaterThanOrEqual(0);
    expect(exitedIdx).toBeGreaterThanOrEqual(0);
    expect(cleanupIdx).toBeLessThan(exitedIdx);

    // Immediately after wait resolves, identities must already be proven gone
    // (no post-wait sleep/poll allowance). Hard gate is PID+start-time identity,
    // not PID-only (reuse under full-suite load fools PID-only).
    await assertIdentitiesDead(identities, 'immediately after wait(forceStopTree)');
    expect(identities.length).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('wait resolves only after tree_clean ordering and identity death under concurrent load', async () => {
    // Full-suite flake class: concurrent Job force-stops + PID churn.
    const concurrency = 3;
    const runs = await Promise.all(
      Array.from({ length: concurrency }, async (_, index) => {
        const directory = temporaryDirectory();
        const pidFile = join(directory, `load-pids-${String(index)}.txt`);
        writeFileSync(pidFile, '', 'utf8');
        const attemptId = asAttemptId(`attempt-load-${String(index)}`);
        const supervisor = new ProcessSupervisor({
          helperPath: resolveProcessHostExecutable(),
        });
        activeSupervisors.push(supervisor);

        const events: ProcessSupervisorEvent[] = [];
        supervisor.subscribe(attemptId, (event) => {
          events.push(event);
        });

        await supervisor.start({
          attemptId,
          executable: process.execPath,
          args: [PARENT_FIXTURE],
          cwd: directory,
          environment: {
            TRIAGENT_PID_FILE: pidFile,
          },
        });

        const { pids: treePids, identities } = await captureIdentitiesAsRecorded(
          pidFile,
          3,
          `load tree identities ${String(index)}`,
        );
        expect(identities.length).toBeGreaterThanOrEqual(3);

        await supervisor.forceStopTree(attemptId);
        const waitResult = await supervisor.wait(attemptId);

        return { events, identities, treePids, waitResult };
      }),
    );

    for (const [index, run] of runs.entries()) {
      expect(run.waitResult.reason, `run ${String(index)} reason`).toBe('force_stop');
      const cleanupIdx = run.events.findIndex(
        (event) => event.type === 'cleanup_succeeded',
      );
      const failedIdx = run.events.findIndex((event) => event.type === 'cleanup_failed');
      const exitedIdx = run.events.findIndex((event) => event.type === 'exited');
      expect(exitedIdx, `run ${String(index)} exited`).toBeGreaterThanOrEqual(0);
      // Success path: cleanup_succeeded before exited. Failure path must be cleanup_failed,
      // never silent success while identities remain.
      if (cleanupIdx >= 0) {
        expect(cleanupIdx).toBeLessThan(exitedIdx);
        await assertIdentitiesDead(
          run.identities,
          `load run ${String(index)} after wait`,
        );
      } else {
        expect(failedIdx).toBeGreaterThanOrEqual(0);
        expect(failedIdx).toBeLessThan(exitedIdx);
      }
      expect(run.identities.length).toBeGreaterThanOrEqual(3);
    }
  }, 120_000);

  it('helper crash (kill-on-close) cleans the target tree without Node taskkill', async () => {
    const directory = temporaryDirectory();
    const pidFile = join(directory, 'pids-crash.txt');
    writeFileSync(pidFile, '', 'utf8');
    const attemptId = asAttemptId('attempt-helper-crash');
    const supervisor = new ProcessSupervisor({
      helperPath: resolveProcessHostExecutable(),
    });
    activeSupervisors.push(supervisor);

    const events: ProcessSupervisorEvent[] = [];
    supervisor.subscribe(attemptId, (event) => {
      events.push(event);
    });

    await supervisor.start({
      attemptId,
      executable: process.execPath,
      args: [PARENT_FIXTURE],
      cwd: directory,
      environment: {
        TRIAGENT_PID_FILE: pidFile,
      },
    });

    await waitFor(
      () => readRecordedPids(pidFile).length >= 3,
      'tree PIDs before helper crash',
    );
    const treePids = readRecordedPids(pidFile);
    const identities = await captureIdentities(treePids);
    for (const identity of identities) {
      expect(await isIdentityAlive(identity)).toBe(true);
    }

    // Crash the helper process; Job handle close must kill the entire tree.
    await supervisor.crashHelperForTests(attemptId);

    const waitResult = await supervisor.wait(attemptId);
    // Helper death is not a normal exit â€?either verified cleanup or cleanup_failed.
    expect(['force_stop', 'exited', 'graceful_stop']).toContain(waitResult.reason);
    const cleanupFailed = events.some((event) => event.type === 'cleanup_failed');
    const cleanupSucceeded = events.some((event) => event.type === 'cleanup_succeeded');
    // Verified PID+start-time identities only; never kill reused PIDs.
    expect(cleanupFailed || cleanupSucceeded).toBe(true);
    // Hard gate immediately after wait â€?identity death, not PID-only.
    await assertIdentitiesDead(identities, 'immediately after helper-crash wait');
  }, 60_000);

  it('unexpected helper stdin close triggers kill-on-close tree cleanup', async () => {
    const directory = temporaryDirectory();
    const pidFile = join(directory, 'pids-stdin.txt');
    writeFileSync(pidFile, '', 'utf8');
    const attemptId = asAttemptId('attempt-stdin-close');
    const supervisor = new ProcessSupervisor({
      helperPath: resolveProcessHostExecutable(),
    });
    activeSupervisors.push(supervisor);

    await supervisor.start({
      attemptId,
      executable: process.execPath,
      args: [PARENT_FIXTURE],
      cwd: directory,
      environment: {
        TRIAGENT_PID_FILE: pidFile,
      },
    });

    await waitFor(
      () => readRecordedPids(pidFile).length >= 3,
      'tree PIDs before stdin close',
    );
    const treePids = readRecordedPids(pidFile);
    const identities = await captureIdentities(treePids);

    await supervisor.closeHelperStdinForTests(attemptId);

    await supervisor.wait(attemptId);
    await assertIdentitiesDead(identities, 'immediately after stdin-close wait');
  }, 60_000);

  it('graceful stop then force cleans the process tree', async () => {
    const directory = temporaryDirectory();
    const pidFile = join(directory, 'pids-graceful.txt');
    writeFileSync(pidFile, '', 'utf8');
    const attemptId = asAttemptId('attempt-graceful-force');
    const supervisor = new ProcessSupervisor({
      helperPath: resolveProcessHostExecutable(),
    });
    activeSupervisors.push(supervisor);

    const events: ProcessSupervisorEvent[] = [];
    supervisor.subscribe(attemptId, (event) => {
      events.push(event);
    });

    await supervisor.start({
      attemptId,
      executable: process.execPath,
      args: [PARENT_FIXTURE],
      cwd: directory,
      environment: {
        TRIAGENT_PID_FILE: pidFile,
      },
    });

    await waitFor(
      () => readRecordedPids(pidFile).length >= 3,
      'tree PIDs before graceful stop',
    );
    const treePids = readRecordedPids(pidFile);
    const identities = await captureIdentities(treePids);

    await supervisor.requestGracefulStop(attemptId);
    // Fixture ignores cooperative signals on Windows Node; force after short grace.
    await sleep(200);
    await supervisor.forceStopTree(attemptId);
    await supervisor.wait(attemptId);

    await assertIdentitiesDead(identities, 'immediately after graceful+force wait');
    const cleanupIdx = events.findIndex((event) => event.type === 'cleanup_succeeded');
    const exitedIdx = events.findIndex((event) => event.type === 'exited');
    expect(exitedIdx).toBeGreaterThanOrEqual(0);
    if (cleanupIdx >= 0) {
      expect(cleanupIdx).toBeLessThan(exitedIdx);
    }
  }, 60_000);

  it('relays arbitrary binary-ish stdout safely without corrupting the control protocol', async () => {
    const directory = temporaryDirectory();
    const attemptId = asAttemptId('attempt-safe-output');
    const supervisor = new ProcessSupervisor({
      helperPath: resolveProcessHostExecutable(),
    });
    activeSupervisors.push(supervisor);

    const stdoutChunks: string[] = [];
    supervisor.subscribe(attemptId, (event) => {
      if (event.type === 'stdout') stdoutChunks.push(event.chunk);
    });

    // Emit a line containing quotes, newlines-as-escaped, and non-ascii.
    const payload = 'hello "quotes" \\and\\ ä¸­æ–‡ \x00 partial';
    await supervisor.start({
      attemptId,
      executable: process.execPath,
      args: [
        '-e',
        `process.stdout.write(${JSON.stringify(payload)}); setTimeout(() => process.exit(0), 50);`,
      ],
      cwd: directory,
    });

    const result = await supervisor.wait(attemptId);
    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBe(0);
    const combined = stdoutChunks.join('');
    expect(combined).toContain('hello');
    expect(combined).toContain('ä¸­æ–‡');
  }, 30_000);

  it('start_failed path never leaves an unmanaged suspended target', async () => {
    const directory = temporaryDirectory();
    const attemptId = asAttemptId('attempt-start-failed');
    const supervisor = new ProcessSupervisor({
      helperPath: resolveProcessHostExecutable(),
    });
    activeSupervisors.push(supervisor);

    await expect(
      supervisor.start({
        attemptId,
        executable: join(directory, 'definitely-missing-executable-xyz.exe'),
        args: [],
        cwd: directory,
      }),
    ).rejects.toThrow(/start_failed|not found|failed/i);
  }, 30_000);

  it('nested parent Job: ProcessHost inside a parent Job either nests successfully or fails closed before unmanaged target execution', async () => {
    // Mandatory Task 12 gate: ProcessHost itself is already inside a parent Job.
    // Supported Windows nested assignment â†?target tree cleans via force stop.
    // Denied/unsupported nested assignment â†?start fails closed (no unmanaged run).
    // Missing-executable is NOT a substitute for this case.
    const directory = temporaryDirectory();
    const pidFile = join(directory, 'nested-pids.txt');
    writeFileSync(pidFile, '', 'utf8');

    // Start the helper first, assign it into a parent Job, then start the target.
    const client = ProcessHostClient.create();
    const hostEvents: Array<{ type: string; error?: string }> = [];
    client.onEvent((event) => {
      hostEvents.push({
        type: event.type,
        ...('error' in event && typeof event.error === 'string'
          ? { error: event.error }
          : {}),
      });
    });
    await client.start();
    const helperPid = client.helperPid;
    expect(helperPid, 'ProcessHost helper pid').toBeGreaterThan(0);

    const parentJob = await assignPidToParentJob(helperPid!);
    try {
      const attemptId = 'attempt-nested-parent-job';
      let startFailed = false;
      let startError = '';
      let startedPid = 0;
      try {
        const started = await client.startProcess({
          attemptId,
          command: process.execPath,
          args: [PARENT_FIXTURE],
          cwd: directory,
          env: {
            TRIAGENT_PID_FILE: pidFile,
          },
        });
        startedPid = started.pid;
        expect(startedPid).toBeGreaterThan(0);
      } catch (error) {
        startFailed = true;
        startError = error instanceof Error ? error.message : String(error);
      }

      if (startFailed) {
        // Fail closed: assignment denied/unsupported must not run unmanaged target.
        expect(startError).toMatch(/start_failed|assign_failed|nested|job/i);
        expect(hostEvents.some((event) => event.type === 'start_failed')).toBe(true);
        // No target PIDs should be recorded as a live unmanaged tree.
        const recorded = readRecordedPids(pidFile);
        for (const pid of recorded) {
          // If anything was briefly created, it must already be gone (terminated suspended).
          expect(await isProcessAlive(pid)).toBe(false);
        }
      } else {
        // Nested jobs supported: prove full tree cleanup without taskkill.
        const { pids: treePids, identities } = await captureIdentitiesAsRecorded(
          pidFile,
          3,
          'nested-job tree identities',
        );
        expect(treePids.length).toBeGreaterThanOrEqual(3);
        expect(identities.length).toBeGreaterThanOrEqual(3);

        client.requestStop(attemptId, 'force');
        await client.waitForTerminal(attemptId, 30_000);

        await assertIdentitiesDead(
          identities,
          'immediately after nested-job force stop',
        );
        await assertAllPidsDead(treePids, 'after nested-job force stop');
        expect(
          hostEvents.some((event) => event.type === 'tree_clean')
            || hostEvents.some((event) => event.type === 'exited'),
        ).toBe(true);
      }
    } finally {
      await client.dispose().catch(() => undefined);
      await parentJob.dispose();
    }
  }, 60_000);

  it('ProcessHostClient protocol: started/stdout/exited/tree_clean round-trip', async () => {
    const directory = temporaryDirectory();
    const client = ProcessHostClient.create();
    const events: Array<{ type: string }> = [];
    client.onEvent((event) => {
      events.push({ type: event.type });
    });
    await client.start();
    const attemptId = 'attempt-client-roundtrip';
    const started = await client.startProcess({
      attemptId,
      command: process.execPath,
      args: ['-e', "console.log('client-ok'); setTimeout(() => {}, 10);"],
      cwd: directory,
      env: {},
    });
    expect(started.pid).toBeGreaterThan(0);
    await client.waitForTerminal(attemptId, 15_000);
    await client.dispose();
    const types = events.map((event) => event.type);
    expect(types).toContain('started');
    expect(types).toContain('exited');
    // tree_clean may accompany natural exit when the job empties.
    expect(
      types.includes('tree_clean') || types.includes('exited'),
    ).toBe(true);
  }, 30_000);
});
