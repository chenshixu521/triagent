#!/usr/bin/env node
/**
 * Child-process worker for concurrent copyNativeHelper stress tests.
 * Usage: node copy-stress-worker.mjs <packageRoot>
 * Prints JSON line: { ok, pid, sha256?, error? }
 */
import { copyNativeHelper } from '../copy-native.mjs';

const packageRoot = process.argv[2];

try {
  const result = copyNativeHelper({ packageRoot });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      pid: process.pid,
      sha256: result.sha256,
    })}\n`,
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
