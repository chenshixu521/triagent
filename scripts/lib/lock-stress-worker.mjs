#!/usr/bin/env node
/**
 * Child-process worker for concurrent lock acquisition stress tests.
 * Usage: node lock-stress-worker.mjs <lockRoot> <holdMs> <waitMs>
 * Prints JSON line: { ok, pid, token?, error? }
 */
import { acquireBuildLock } from './build-lock.mjs';

const lockRoot = process.argv[2];
const holdMs = Number(process.argv[3] ?? 50);
const waitMs = Number(process.argv[4] ?? 30_000);

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy hold so the lock is actually held across the interval
  }
}

try {
  const lock = acquireBuildLock({ lockRoot, waitMs });
  sleep(holdMs);
  lock.release();
  process.stdout.write(
    `${JSON.stringify({ ok: true, pid: process.pid, token: lock.token })}\n`,
  );
  process.exitCode = 0;
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}
