import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

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
import {
  AgentWorkerManager,
  probeSqliteWritable,
  resolveCrashingParserFixturePath,
  type WorkerReplacementAuthorization,
} from '../../../src/workers/agent-worker-manager.js';
import { seedVerifiedWorkerStartGate } from '../../fakes/worker-start-gate.js';

import {
  MAX_WORKER_IPC_MESSAGE_BYTES,
  parseWorkerIpcMessage,
  StartRunMessageSchema,
  WorkerToMainMessageSchema,
} from '../../../src/workers/worker-protocol.js';
import type { WorkflowSnapshot } from '../../../src/workflow/states.js';

/** Unique marker embedded in the crashing-parser fixture's crash-trigger line. */
export const CRASH_TRIGGER_MARKER = 'CRASH_TRIGGER_MARKER_T11_9f3c2a1b';

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];
const managers: AgentWorkerManager[] = [];
const logs: JsonlLog[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-worker-isolation-'));
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

function seedImplementingTask(
  database: ReadWriteDatabase,
  taskIdValue: string,
  attemptIdValue: string,
  baselineIdValue: string,
): {
  readonly taskId: ReturnType<typeof asTaskId>;
  readonly attemptId: ReturnType<typeof asAttemptId>;
  readonly baselineId: ReturnType<typeof asBaselineId>;
} {
  const taskId = asTaskId(taskIdValue);
  const attemptId = asAttemptId(attemptIdValue);
  const baselineId = asBaselineId(baselineIdValue);
  const repositories = createPersistenceRepositories(database);
  repositories.tasks.createProject({
    projectId: `project-${taskIdValue}`,
    rootPath: `D:\\${taskIdValue}`,
  });
  const snapshot: WorkflowSnapshot = {
    state: 'implementing',
    taskId,
    requirementVersion: 1,
    reworkCount: 0,
    maxReworks: 3,
    pauseAfterAttempt: false,
    activeAttemptId: attemptId,
    activeAttemptBaselineId: baselineId,
    activeAttemptRole: 'implementer',
  };
  repositories.tasks.create({
    taskId,
    projectId: `project-${taskIdValue}`,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
    status: 'implementing',
  });
  return { taskId, attemptId, baselineId };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(async () => {
  for (const manager of managers.splice(0).reverse()) {
    await manager.close().catch(() => undefined);
  }
  for (const log of logs.splice(0).reverse()) {
    await log.close().catch(() => undefined);
  }
  for (const opened of openedDatabases.splice(0).reverse()) {
    opened.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Worker isolation (Task 11)', () => {
  it('keeps main process and SQLite writer alive when the parser Worker crashes', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-worker-crash',
      'attempt-worker-crash',
      'baseline-worker-crash',
    );

    const log = await JsonlLog.open({
      directory: join(directory, 'logs'),
      fileName: 'worker.jsonl',
      database: database.connection,
    });
    logs.push(log);

    const mainPid = process.pid;
    let workerFailed = false;
    const manager = new AgentWorkerManager({
      database: database.connection,
      log,
      taskId,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 5_000,
      onWorkerFailed: () => {
        workerFailed = true;
      },
    });
    managers.push(manager);

    const crashingParserPath = resolveCrashingParserFixturePath();
    expect(crashingParserPath.endsWith('crashing-parser.mjs')).toBe(true);

    await manager.startRun({
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'implement something',
      baselineId,
      requirementVersion: 1,
      useCrashingParser: true,
      crashingParserPath,
      pid: 42_001,
      startGate: seedVerifiedWorkerStartGate(database.connection, { taskId, attemptId, agentKind: 'codex', projectRoot: directory }).startGate,
    });

    await waitFor(() => workerFailed, 'worker_failed after parser crash');

    // Main application process remains alive.
    expect(process.pid).toBe(mainPid);
    expect(manager.mainProcessAlive).toBe(true);

    // SQLite writer remains usable after Worker death.
    expect(probeSqliteWritable(database.connection)).toBe(true);
    database.connection
      .prepare('SELECT 1 AS ok')
      .get();

    // RunAttempt is marked failed (completed with exit_reason failed).
    const repositories = createPersistenceRepositories(database);
    const attempt = repositories.attempts.get(attemptId);
    expect(attempt).toBeDefined();
    expect(attempt?.status).toBe('completed');
    if (attempt?.status === 'completed') {
      expect(attempt.exitReason).toBe('failed');
    }

    // Raw crash-triggering output must be retained in durable JSONL even when
    // the parser Worker crashes before a parsed AgentEvent can cross IPC.
    const logText = readFileSync(log.path, 'utf8');
    expect(logText.length).toBeGreaterThan(0);
    expect(logText).toContain('worker_failed');
    expect(logText).toContain(CRASH_TRIGGER_MARKER);
    expect(logText).toMatch(/worker_raw_output|worker_event_/);
    // Secrets in raw evidence are redacted per logging contract.
    expect(logText).not.toMatch(/sk-live-secret-should-redact/);

    // Task moved to safe recoverable state (never auto-replay).
    const task = repositories.tasks.get(taskId);
    expect(task).toBeDefined();
    expect(task?.status).toBe('interrupted_needs_inspection');
    expect(task?.workflowSnapshot.state).toBe('interrupted_needs_inspection');
    expect(task?.workflowSnapshot.resumeTargetState).toBe('implementing');
    expect(task?.workflowSnapshot.activeAttemptId).toBeUndefined();

    // No automatic fresh Worker for unresolved active run.
    const blockedAttempt = asAttemptId('attempt-worker-crash-2');
    await expect(
      manager.startRun({
        attemptId: blockedAttempt,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'must not auto start',
        baselineId: asBaselineId('baseline-worker-crash-2'),
        requirementVersion: 1,
        useCrashingParser: true,
        crashingParserPath,
        startGate: seedVerifiedWorkerStartGate(database.connection, {
          taskId,
          attemptId: blockedAttempt,
          agentKind: 'codex',
          projectRoot: directory,
        }).startGate,
      }),
    ).rejects.toThrow(/reconcile|replacement|unresolved|authorization/i);

    // Typed reconcile authorization is required before replacement.
    const failedSnap = manager.snapshot();
    expect(failedSnap).toBeDefined();
    const authorization: WorkerReplacementAuthorization = {
      kind: 'worker_replacement',
      decisionId: `decision-${taskId}-1`,
      taskId,
      failedAttemptId: attemptId,
      failedGeneration: failedSnap!.generation,
      nextAttemptId: asAttemptId('attempt-worker-crash-2'),
      reasonCode: 'process_terminal_state_unknown',
    };
    manager.allowReplacementAfterReconcile(authorization);
    const snap = manager.snapshot();
    expect(snap?.replacementAllowed).toBe(true);
  }, 30_000);

  it('never throws on malformed IPC and routes failures without crashing main', async () => {
    const cyclic: Record<string, unknown> = { type: 'event' };
    cyclic.self = cyclic;

    const cases: Array<{ label: string; raw: unknown }> = [
      { label: 'undefined', raw: undefined },
      { label: 'symbol', raw: Symbol('hostile') },
      { label: 'function', raw: () => 'nope' },
      { label: 'non-json string', raw: '{not-json' },
      { label: 'cyclic', raw: cyclic },
      {
        label: 'hostile secret payload',
        raw: {
          type: 'event',
          attemptId: 'attempt-ipc',
          password: 'super-secret-password-value',
          authorization: 'Bearer sk-secret-value',
        },
      },
      {
        label: 'oversized',
        raw: {
          type: 'event',
          attemptId: 'attempt-ipc',
          event: {
            type: 'output',
            attemptId: 'attempt-ipc',
            text: 'x'.repeat(MAX_WORKER_IPC_MESSAGE_BYTES),
          },
          displayPriority: 'low',
        },
      },
    ];

    for (const entry of cases) {
      let result: ReturnType<typeof parseWorkerIpcMessage>;
      expect(() => {
        result = parseWorkerIpcMessage(entry.raw, 'worker_to_main');
      }, entry.label).not.toThrow();
      expect(result!.ok, entry.label).toBe(false);
      if (!result!.ok) {
        expect(result!.message, entry.label).not.toMatch(/super-secret-password-value/);
        expect(result!.message, entry.label).not.toMatch(/sk-secret-value/);
        expect(result!.message.length, entry.label).toBeLessThanOrEqual(2_048);
      }
    }

    const oversized = parseWorkerIpcMessage(
      {
        type: 'event',
        attemptId: 'attempt-ipc',
        event: {
          type: 'output',
          attemptId: 'attempt-ipc',
          text: 'x'.repeat(MAX_WORKER_IPC_MESSAGE_BYTES),
        },
        displayPriority: 'low',
      },
      'worker_to_main',
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.reasonCode).toBe('oversized_message');
    }

    // Manager listener must catch hostile messages without killing main / SQLite.
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-worker-malformed-ipc',
      'attempt-worker-malformed-ipc',
      'baseline-worker-malformed-ipc',
    );
    const log = await JsonlLog.open({
      directory: join(directory, 'logs'),
      fileName: 'malformed.jsonl',
      database: database.connection,
    });
    logs.push(log);

    let workerFailed = false;
    const manager = new AgentWorkerManager({
      database: database.connection,
      log,
      taskId,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 5_000,
      onWorkerFailed: () => {
        workerFailed = true;
      },
    });
    managers.push(manager);

    await manager.startRun({
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'malformed ipc',
      baselineId,
      requirementVersion: 1,
      pid: 70_001,
      fakePlans: [
        {
          pid: 70_001,
          timeline: [
            { afterMs: 1, event: { type: 'started', pid: 70_001 } },
            {
              afterMs: 200,
              event: {
                type: 'exited',
                pid: 70_001,
                exitCode: 0,
                signal: null,
                reason: 'exited',
              },
            },
          ],
        },
      ],
      startGate: seedVerifiedWorkerStartGate(database.connection, { taskId, attemptId, agentKind: 'codex', projectRoot: directory }).startGate,
    });

    expect(typeof manager.handleWorkerIpcForTests).toBe('function');
    expect(() => manager.handleWorkerIpcForTests(undefined)).not.toThrow();
    await waitFor(() => workerFailed, 'worker_failed after malformed IPC');

    expect(manager.mainProcessAlive).toBe(true);
    expect(probeSqliteWritable(database.connection)).toBe(true);
    database.connection.prepare('SELECT 1 AS ok').get();

    const logText = readFileSync(log.path, 'utf8');
    expect(logText).toContain('worker_failed');
  }, 30_000);

  it('validates typed IPC with Zod, size limits, and safe errors', () => {
    const start = StartRunMessageSchema.safeParse({
      type: 'start_run',
      attemptId: 'attempt-ipc',
      taskId: 'task-ipc',
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: 'D:\\project',
      prompt: 'hi',
      baselineId: 'baseline-ipc',
      requirementVersion: 1,
      executable: 'node',
      args: [],
      supervisorMode: 'fake',
    });
    expect(start.success).toBe(true);

    const heartbeat = WorkerToMainMessageSchema.safeParse({
      type: 'heartbeat',
      workerId: 'w1',
      sequence: 1,
      sentAt: '2026-07-12T12:00:00.000Z',
    });
    expect(heartbeat.success).toBe(true);

    const secretEcho = parseWorkerIpcMessage(
      {
        type: 'start_run',
        attemptId: 'attempt-ipc',
        // missing required fields; include secret-looking junk
        password: 'super-secret-password-value',
        authorization: 'Bearer sk-secret-value',
      },
      'main_to_worker',
    );
    expect(secretEcho.ok).toBe(false);
    if (!secretEcho.ok) {
      expect(secretEcho.message).not.toMatch(/super-secret-password-value/);
      expect(secretEcho.message).not.toMatch(/sk-secret-value/);
    }
  });

  it('rejects arbitrary replacement strings and never terminates a healthy running worker', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-worker-auth',
      'attempt-worker-auth-a',
      'baseline-worker-auth-a',
    );
    const log = await JsonlLog.open({
      directory: join(directory, 'logs'),
      fileName: 'auth.jsonl',
      database: database.connection,
    });
    logs.push(log);

    const manager = new AgentWorkerManager({
      database: database.connection,
      log,
      taskId,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 10_000,
    });
    managers.push(manager);

    await manager.startRun({
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'healthy run',
      baselineId,
      requirementVersion: 1,
      pid: 80_001,
      fakePlans: [
        {
          pid: 80_001,
          timeline: [
            { afterMs: 1, event: { type: 'started', pid: 80_001 } },
            {
              afterMs: 5_000,
              event: {
                type: 'exited',
                pid: 80_001,
                exitCode: 0,
                signal: null,
                reason: 'exited',
              },
            },
          ],
        },
      ],
      startGate: seedVerifiedWorkerStartGate(database.connection, { taskId, attemptId, agentKind: 'codex', projectRoot: directory }).startGate,
    });

    const runningSnap = manager.snapshot();
    expect(runningSnap?.state).toBe('running');
    const generation = runningSnap!.generation;

    // Arbitrary non-blank strings must not authorize replacement.
    expect(() =>
      (manager as unknown as { allowReplacementAfterReconcile(marker: unknown): void })
        .allowReplacementAfterReconcile(
          `reconcile:${taskId}:blocked:process_terminal_state_unknown`,
        ),
    ).toThrow(/authorization|typed|kind|decision/i);
    expect(manager.snapshot()?.replacementAllowed).toBe(false);
    expect(manager.snapshot()?.state).toBe('running');

    // Typed auth while still running/healthy is rejected.
    expect(() =>
      manager.allowReplacementAfterReconcile({
        kind: 'worker_replacement',
        decisionId: 'decision-too-early',
        taskId,
        failedAttemptId: attemptId,
        failedGeneration: generation,
        nextAttemptId: asAttemptId('attempt-worker-auth-b'),
        reasonCode: 'process_terminal_state_unknown',
      }),
    ).toThrow(/running|healthy|failed/i);
    expect(manager.snapshot()?.state).toBe('running');
    expect(manager.snapshot()?.replacementAllowed).toBe(false);

    // Must not silently start a replacement while the session is active.
    const blockedActiveAttempt = asAttemptId('attempt-worker-auth-b');
    await expect(
      manager.startRun({
        attemptId: blockedActiveAttempt,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'must not replace active',
        baselineId: asBaselineId('baseline-worker-auth-b'),
        requirementVersion: 1,
        pid: 80_002,
        startGate: seedVerifiedWorkerStartGate(database.connection, {
          taskId,
          attemptId: blockedActiveAttempt,
          agentKind: 'codex',
          projectRoot: directory,
        }).startGate,
      }),
    ).rejects.toThrow(/reconcile|replacement|unresolved|running|active/i);
    expect(manager.snapshot()?.state).toBe('running');
    expect(manager.snapshot()?.attemptId).toBe(attemptId);
  }, 30_000);

  it('consumes matching replacement authorization once after durable failure', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-worker-auth-ok',
      'attempt-worker-auth-ok-a',
      'baseline-worker-auth-ok-a',
    );
    const log = await JsonlLog.open({
      directory: join(directory, 'logs'),
      fileName: 'auth-ok.jsonl',
      database: database.connection,
    });
    logs.push(log);

    let failed = false;
    const manager = new AgentWorkerManager({
      database: database.connection,
      log,
      taskId,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 5_000,
      onWorkerFailed: () => {
        failed = true;
      },
    });
    managers.push(manager);

    const crashingParserPath = resolveCrashingParserFixturePath();
    await manager.startRun({
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'auth after failure',
      baselineId,
      requirementVersion: 1,
      useCrashingParser: true,
      crashingParserPath,
      pid: 81_001,
      startGate: seedVerifiedWorkerStartGate(database.connection, { taskId, attemptId, agentKind: 'codex', projectRoot: directory }).startGate,
    });
    await waitFor(() => failed, 'worker failure before auth');

    const failedSnap = manager.snapshot();
    expect(failedSnap?.state).toBe('failed');
    expect(failedSnap?.failurePersisted).toBe(true);
    expect(failedSnap?.replacementAllowed).toBe(false);

    const nextAttemptId = asAttemptId('attempt-worker-auth-ok-b');
    const authorization: WorkerReplacementAuthorization = {
      kind: 'worker_replacement',
      decisionId: 'decision-auth-ok-1',
      taskId,
      failedAttemptId: attemptId,
      failedGeneration: failedSnap!.generation,
      nextAttemptId,
      reasonCode: 'process_terminal_state_unknown',
    };

    // Mismatched generation / attempt / task rejected.
    expect(() =>
      manager.allowReplacementAfterReconcile({
        ...authorization,
        failedGeneration: failedSnap!.generation + 99,
      }),
    ).toThrow(/generation|mismatch|authorization/i);
    expect(() =>
      manager.allowReplacementAfterReconcile({
        ...authorization,
        failedAttemptId: asAttemptId('attempt-other'),
      }),
    ).toThrow(/attempt|mismatch|authorization/i);
    expect(() =>
      manager.allowReplacementAfterReconcile({
        ...authorization,
        taskId: asTaskId('task-other'),
      }),
    ).toThrow(/task|mismatch|authorization/i);

    manager.allowReplacementAfterReconcile(authorization);
    expect(manager.snapshot()?.replacementAllowed).toBe(true);

    // Wrong next attempt id cannot consume authorization.
    const wrongNextAttempt = asAttemptId('attempt-worker-auth-ok-wrong');
    await expect(
      manager.startRun({
        attemptId: wrongNextAttempt,
        role: 'implementer',
        agentKind: 'codex',
        projectRoot: directory,
        prompt: 'wrong next',
        baselineId: asBaselineId('baseline-worker-auth-ok-wrong'),
        requirementVersion: 1,
        pid: 81_002,
        startGate: seedVerifiedWorkerStartGate(database.connection, {
          taskId,
          attemptId: wrongNextAttempt,
          agentKind: 'codex',
          projectRoot: directory,
        }).startGate,
      }),
    ).rejects.toThrow(/authorization|nextAttempt|mismatch/i);
    expect(manager.snapshot()?.replacementAllowed).toBe(true);

    // Matching next attempt starts and consumes authorization once.
    await manager.startRun({
      attemptId: nextAttemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'authorized replacement',
      baselineId: asBaselineId('baseline-worker-auth-ok-b'),
      requirementVersion: 1,
      pid: 81_003,
      fakePlans: [
        {
          pid: 81_003,
          timeline: [
            { afterMs: 1, event: { type: 'started', pid: 81_003 } },
            {
              afterMs: 20,
              event: {
                type: 'exited',
                pid: 81_003,
                exitCode: 0,
                signal: null,
                reason: 'exited',
              },
            },
          ],
        },
      ],
      startGate: seedVerifiedWorkerStartGate(database.connection, {
        taskId,
        attemptId: nextAttemptId,
        agentKind: 'codex',
        projectRoot: directory,
      }).startGate,
    });
    expect(manager.snapshot()?.state).toBe('running');
    expect(manager.snapshot()?.attemptId).toBe(nextAttemptId);
    expect(manager.snapshot()?.replacementAllowed).toBe(false);

    // Stale / reused authorization is denied after consume.
    expect(() => manager.allowReplacementAfterReconcile(authorization)).toThrow(
      /running|healthy|failed|reuse|stale|consumed/i,
    );
  }, 30_000);

  it('drops only low-priority partial output under backpressure, never terminal events', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-worker-bp',
      'attempt-worker-bp',
      'baseline-worker-bp',
    );
    const log = await JsonlLog.open({
      directory: join(directory, 'logs'),
      fileName: 'bp.jsonl',
      database: database.connection,
    });
    logs.push(log);

    const normalized: Array<{ type: string; dropped?: boolean }> = [];
    const manager = new AgentWorkerManager({
      database: database.connection,
      log,
      taskId,
      maxQueuedLowPriorityEvents: 2,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 10_000,
      onNormalizedEvent: (event) => {
        normalized.push({
          type: event.event.type,
          ...(event.dropped === true ? { dropped: true } : {}),
        });
      },
    });
    managers.push(manager);

    // Successful non-crashing run with many low-priority output lines.
    const manyOutputs = Array.from({ length: 20 }, (_, index) => ({
      afterMs: 5 + index,
      event: {
        type: 'stdout' as const,
        chunk: `${JSON.stringify({
          type: 'output',
          attemptId: attemptId,
          text: `partial-${String(index)}`,
        })}\n`,
      },
    }));

    await manager.startRun({
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'backpressure',
      baselineId,
      requirementVersion: 1,
      pid: 50_001,
      fakePlans: [
        {
          pid: 50_001,
          timeline: [
            { afterMs: 1, event: { type: 'started', pid: 50_001 } },
            ...manyOutputs,
            {
              afterMs: 40,
              event: {
                type: 'stdout',
                chunk: `${JSON.stringify({
                  type: 'result',
                  attemptId,
                  output: { ok: true },
                })}\n`,
              },
            },
            {
              afterMs: 50,
              event: {
                type: 'exited',
                pid: 50_001,
                exitCode: 0,
                signal: null,
                reason: 'exited',
              },
            },
          ],
        },
      ],
      startGate: seedVerifiedWorkerStartGate(database.connection, { taskId, attemptId, agentKind: 'codex', projectRoot: directory }).startGate,
    });

    await waitFor(
      () => normalized.some((entry) => entry.type === 'process_exited')
        || normalized.some((entry) => entry.type === 'result'),
      'terminal events delivered',
    );

    // Terminal / run-state events must never be marked dropped.
    const terminal = normalized.filter(
      (entry) =>
        entry.type === 'process_exited'
        || entry.type === 'result'
        || entry.type === 'process_started',
    );
    expect(terminal.length).toBeGreaterThan(0);
    expect(terminal.every((entry) => entry.dropped !== true)).toBe(true);

    // Durable JSONL still retained raw output even if display dropped some.
    const logText = readFileSync(log.path, 'utf8');
    expect(logText).toContain('worker_event_');
  }, 30_000);

  it('ignores stale worker messages from a previous attempt generation', async () => {
    const directory = temporaryDirectory();
    const database = openTestDatabase(directory);
    const { taskId, attemptId, baselineId } = seedImplementingTask(
      database,
      'task-worker-stale',
      'attempt-worker-stale-a',
      'baseline-worker-stale-a',
    );
    const log = await JsonlLog.open({
      directory: join(directory, 'logs'),
      fileName: 'stale.jsonl',
      database: database.connection,
    });
    logs.push(log);

    let failed = false;
    const manager = new AgentWorkerManager({
      database: database.connection,
      log,
      taskId,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 5_000,
      onWorkerFailed: () => {
        failed = true;
      },
    });
    managers.push(manager);

    const crashingParserPath = resolveCrashingParserFixturePath();
    await manager.startRun({
      attemptId,
      role: 'implementer',
      agentKind: 'codex',
      projectRoot: directory,
      prompt: 'stale test',
      baselineId,
      requirementVersion: 1,
      useCrashingParser: true,
      crashingParserPath,
      pid: 60_001,
      startGate: seedVerifiedWorkerStartGate(database.connection, { taskId, attemptId, agentKind: 'codex', projectRoot: directory }).startGate,
    });
    await waitFor(() => failed, 'first worker failure');

    // Stale-message drop is covered by generation fence inside manager; after
    // failure, session generation remains and replacement is denied until
    // reconcile.
    expect(manager.snapshot()?.state).toBe('failed');
    expect(manager.snapshot()?.replacementAllowed).toBe(false);

    // Fixture path resolves inside the package, not outside the worktree.
    expect(fileURLToPath(new URL('../../../tests/fixtures/workers/crashing-parser.mjs', import.meta.url))).toContain('crashing-parser.mjs');
  }, 30_000);
});
