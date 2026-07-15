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
import { spawn } from 'node:child_process';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { BudgetClock } from '../../../src/budget/budget-clock.js';
import { BudgetController } from '../../../src/budget/budget-controller.js';
import {
  asAttemptId,
  asBaselineId,
  asTaskId,
} from '../../../src/domain/ids.js';
import { JsonlLog } from '../../../src/logging/jsonl-log.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import { resolveProcessHostExecutable } from '../../../src/process/process-host-client.js';
import { ProcessSupervisor } from '../../../src/process/process-supervisor.js';
import {
  AgentWorkerManager,
} from '../../../src/workers/agent-worker-manager.js';
import { seedVerifiedWorkerStartGate } from '../../fakes/worker-start-gate.js';

import { WorkerProcessSupervisorProxy } from '../../../src/workers/worker-process-supervisor-proxy.js';
import type { WorkflowSnapshot } from '../../../src/workflow/states.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';

const FIXTURE_DIR = dirname(
  fileURLToPath(new URL('../../fixtures/process-tree/parent.mjs', import.meta.url)),
);
const PARENT_FIXTURE = join(FIXTURE_DIR, 'parent.mjs');

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];
const supervisors: ProcessSupervisor[] = [];
const managers: AgentWorkerManager[] = [];
const proxies: WorkerProcessSupervisorProxy[] = [];
const logs: JsonlLog[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-budget-ph-'));
  temporaryDirectories.push(directory);
  return directory;
}

function requireReadWrite(opened: OpenedDatabase): ReadWriteDatabase {
  expect(opened.mode).toBe('read-write');
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return opened;
}

function openTestDatabase(directory: string): ReadWriteDatabase {
  const opened = openDatabase(join(directory, 'triagent.sqlite'));
  openedDatabases.push(opened);
  return requireReadWrite(opened);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 25_000,
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
  return [
    ...new Set(
      readFileSync(pidFile, 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    ),
  ];
}

/**
 * Query process start time via CIM. Null when gone or unreadable.
 * Full-suite hard-gate must use PID+start-time identity, not PID-only liveness
 * (Windows may reuse PIDs under concurrent test load).
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
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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
    });
  });
}

interface PidIdentity {
  readonly pid: number;
  readonly startedAt: string;
}

/**
 * Capture PID+start-time as the fixture records PIDs so a concurrent budget
 * force-stop cannot race out identity proof before the hard gate.
 */
async function captureIdentitiesAsRecorded(
  pidFile: string,
  minCount: number,
  label: string,
  timeoutMs = 25_000,
): Promise<{ pids: number[]; identities: PidIdentity[] }> {
  const identitiesByPid = new Map<number, PidIdentity>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = readRecordedPids(pidFile);
    for (const pid of pids) {
      if (identitiesByPid.has(pid)) continue;
      // Retry CIM a few times per PID; WMI can lag under suite load.
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

async function isIdentityAlive(identity: PidIdentity): Promise<boolean> {
  const liveStart = await queryProcessStartTimeIso(identity.pid);
  if (liveStart === null) return false;
  const expected = Date.parse(identity.startedAt);
  const actual = Date.parse(liveStart);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    return true;
  }
  return Math.abs(expected - actual) <= 2_000;
}

async function isProcessAlive(pid: number): Promise<boolean> {
  return (await queryProcessStartTimeIso(pid)) !== null;
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

/** Real wall-clock source for BudgetController against ProcessHost. */
class WallClockSource {
  public now(): string {
    return new Date().toISOString();
  }

  public schedule(afterMs: number, action: () => void): void {
    const timer = setTimeout(action, afterMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
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
  for (const proxy of proxies.splice(0).reverse()) {
    proxy.dispose();
  }
  for (const manager of managers.splice(0).reverse()) {
    await manager.close().catch(() => undefined);
  }
  for (const log of logs.splice(0).reverse()) {
    await log.close().catch(() => undefined);
  }
  for (const supervisor of supervisors.splice(0).reverse()) {
    await supervisor.dispose().catch(() => undefined);
  }
  for (const opened of openedDatabases.splice(0).reverse()) {
    opened.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('BudgetController â†?Worker â†?real ProcessHost (Task 12)', () => {
  it('budget exhaustion alone drives Worker IPC stop_run and cleans parent+child+grandchild', async () => {
    // Hard gate: no manual manager.stopRun. Path is:
    // BudgetController (persist stop intent) â†?WorkerProcessSupervisorProxy
    // â†?Worker IPC stop_run â†?Worker ProcessSupervisor â†?ProcessHost Job cleanup
    // â†?cleanup result events back through Worker â†?budget finalize.
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const pidFile = join(directory, 'budget-chain-pids.txt');
    writeFileSync(pidFile, '', 'utf8');

    const taskId = asTaskId('task-budget-worker-chain');
    const attemptId = asAttemptId('attempt-budget-worker-chain');
    const baselineId = asBaselineId('baseline-budget-worker-chain');
    const repositories = createPersistenceRepositories(database);
    repositories.tasks.createProject({
      projectId: 'project-budget-worker-chain',
      rootPath: directory,
    });
    const snapshot: WorkflowSnapshot = {
      ...createInitialWorkflow(taskId),
      state: 'implementing',
      activeAttemptId: attemptId,
      activeAttemptBaselineId: baselineId,
      activeAttemptRole: 'implementer',
    };
    repositories.tasks.create({
      taskId,
      projectId: 'project-budget-worker-chain',
      workflowSnapshot: snapshot,
      workflowVersion: 1,
      status: 'implementing',
    });

    const log = await JsonlLog.open({
      directory: join(directory, 'logs'),
      fileName: 'budget-chain.jsonl',
      database: database.connection,
    });
    logs.push(log);

    let runExited = false;
    // Proxy is constructed after manager; wire acceptRunExited once both exist.
    let proxyRef: WorkerProcessSupervisorProxy | undefined;
    const manager = new AgentWorkerManager({
      database: database.connection,
      log,
      taskId,
      heartbeatIntervalMs: 200,
      heartbeatTimeoutMs: 10_000,
      onRunExited: (payload) => {
        runExited = true;
        proxyRef?.acceptRunExited(payload);
      },
    });
    managers.push(manager);

    const proxy = new WorkerProcessSupervisorProxy(manager);
    proxyRef = proxy;
    proxies.push(proxy);

    const proxyEvents: string[] = [];
    proxy.subscribe(attemptId, (event) => {
      proxyEvents.push(event.type);
    });

    // Budget uses the proxy port (not a direct ProcessSupervisor). Exhaustion
    // must invoke forceStopTree on the proxy â†?Worker IPC, never a local host.
    const budget = new BudgetController({
      database: database.connection,
      clock: new BudgetClock(new WallClockSource()),
      supervisor: proxy,
      taskId,
      limits: {
        totalActiveRuntimeMs: 60_000,
        // Short after identity capture so exhaustion alone drives cleanup.
        perAttemptTimeoutMs: 400,
        maxExternalCalls: 5,
      },
      graceMs: 100,
    });

    await manager.startRun({
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'budget chain process tree',
      baselineId,
      requirementVersion: 1,
      executable: process.execPath,
      args: [PARENT_FIXTURE],
      environment: {
        TRIAGENT_PID_FILE: pidFile,
      },
      supervisorMode: 'process_host',
      processHostPath: resolveProcessHostExecutable(),
      startGate: seedVerifiedWorkerStartGate(database.connection, { taskId, attemptId, agentKind: 'codex', projectRoot: directory }).startGate,
    });

    const { pids: treePids, identities } = await captureIdentitiesAsRecorded(
      pidFile,
      3,
      'budget-worker-chain tree identities',
    );
    expect(treePids.length).toBeGreaterThanOrEqual(3);
    expect(identities.length).toBeGreaterThanOrEqual(3);

    // Arm budget AFTER identities are proven live so exhaustion cleanup is the
    // only stop path (no manual manager.stopRun).
    const reservation = budget.reserveCall({
      attemptId,
      idempotencyKey: `${taskId}:launch:${attemptId}`,
    });
    budget.beginActiveInterval(attemptId);
    budget.markLaunched(reservation.reservationId);
    budget.armAttemptWatch(attemptId);

    await waitFor(
      () => runExited || proxyEvents.includes('exited'),
      'budgetâ†’worker chain terminal cleanup',
      20_000,
    );

    // Wait through the port; cleanup result returns via Worker events.
    await proxy.wait(attemptId).catch(() => undefined);

    await assertIdentitiesDead(
      identities,
      'immediately after budgetâ†’worker chain wait',
    );
    for (const identity of identities) {
      expect(await isIdentityAlive(identity)).toBe(false);
    }

    expect(budget.isExhausted()).toBe(true);
    // Stop intent must have been persisted (never silent replay).
    const stopRows = database.connection
      .prepare(
        `SELECT status FROM pending_actions
         WHERE action_type = 'budget-stop' AND task_id = ?
         ORDER BY created_at, id`,
      )
      .all(taskId) as Array<{ status: string }>;
    expect(stopRows.length).toBeGreaterThanOrEqual(1);

    // Prefer verified success via cleanup_succeeded; cleanup_failed is only
    // acceptable if tree identities are still proven dead above.
    expect(
      proxyEvents.includes('cleanup_succeeded')
        || proxyEvents.includes('exited')
        || proxyEvents.includes('cleanup_failed'),
    ).toBe(true);
    const cleanupIdx = proxyEvents.indexOf('cleanup_succeeded');
    const exitedIdx = proxyEvents.indexOf('exited');
    if (cleanupIdx >= 0 && exitedIdx >= 0) {
      expect(cleanupIdx).toBeLessThan(exitedIdx);
    }
  }, 60_000);

  it('Worker binds ProcessSupervisorPort to real ProcessHost and force-stops the tree', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const pidFile = join(directory, 'worker-pids.txt');
    writeFileSync(pidFile, '', 'utf8');

    const taskId = asTaskId('task-worker-processhost');
    const attemptId = asAttemptId('attempt-worker-processhost');
    const baselineId = asBaselineId('baseline-worker-processhost');
    const repositories = createPersistenceRepositories(database);
    repositories.tasks.createProject({
      projectId: 'project-worker-processhost',
      rootPath: directory,
    });
    const snapshot: WorkflowSnapshot = {
      ...createInitialWorkflow(taskId),
      state: 'implementing',
      activeAttemptId: attemptId,
      activeAttemptBaselineId: baselineId,
      activeAttemptRole: 'implementer',
    };
    repositories.tasks.create({
      taskId,
      projectId: 'project-worker-processhost',
      workflowSnapshot: snapshot,
      workflowVersion: 1,
      status: 'implementing',
    });

    const log = await JsonlLog.open({
      directory: join(directory, 'logs'),
      fileName: 'worker-ph.jsonl',
      database: database.connection,
    });
    logs.push(log);

    let runExited = false;
    const manager = new AgentWorkerManager({
      database: database.connection,
      log,
      taskId,
      heartbeatIntervalMs: 200,
      heartbeatTimeoutMs: 10_000,
      onRunExited: () => {
        runExited = true;
      },
    });
    managers.push(manager);

    await manager.startRun({
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'run process tree under ProcessHost',
      baselineId,
      requirementVersion: 1,
      executable: process.execPath,
      args: [PARENT_FIXTURE],
      environment: {
        TRIAGENT_PID_FILE: pidFile,
      },
      supervisorMode: 'process_host',
      processHostPath: resolveProcessHostExecutable(),
      startGate: seedVerifiedWorkerStartGate(database.connection, { taskId, attemptId, agentKind: 'codex', projectRoot: directory }).startGate,
    });

    // Capture identities while the tree comes up so force-stop / suite load
    // cannot race out PID+start-time proof (PID reuse must not fool the gate).
    const { pids: treePids, identities } = await captureIdentitiesAsRecorded(
      pidFile,
      3,
      'worker-supervised tree identities',
    );
    expect(treePids.length).toBeGreaterThanOrEqual(3);
    expect(identities.length).toBeGreaterThanOrEqual(3);

    await manager.stopRun(attemptId, 'force');

    await waitFor(() => runExited, 'worker run_exited after force stop', 30_000);

    // Hard gate: after handle/wait (run_exited) returns, identities must already
    // be proven gone â€?no sleep-based poll that hides premature success.
    await assertIdentitiesDead(
      identities,
      'immediately after worker run_exited (force stop)',
    );
    for (const identity of identities) {
      expect(await isIdentityAlive(identity)).toBe(false);
    }
  }, 60_000);
});
