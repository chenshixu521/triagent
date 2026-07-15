#!/usr/bin/env node
/**
 * Process-tree fixture root for Windows Job Object cleanup tests.
 * Spawns child.mjs, which itself spawns a long-lived grandchild.
 * Writes every PID to TRIAGENT_PID_FILE so tests can verify full-tree death.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pidFile = process.env.TRIAGENT_PID_FILE;
if (typeof pidFile !== 'string' || pidFile.trim().length === 0) {
  console.error('TRIAGENT_PID_FILE is required');
  process.exit(2);
}

const parentPid = process.pid;
writeFileSync(pidFile, `${String(parentPid)}\n`, 'utf8');
// Flush immediately so supervisors can capture root identity before descendants.
console.log(`parent_pid=${String(parentPid)}`);
if (typeof process.stdout.write === 'function') {
  // Ensure line is visible to ProcessHost before spawning descendants.
  try {
    process.stdout.write('');
  } catch {
    // ignore
  }
}

const child = spawn(process.execPath, [join(here, 'child.mjs')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    TRIAGENT_PID_FILE: pidFile,
    TRIAGENT_ROLE: 'child',
  },
  windowsHide: true,
});

child.stdout?.on('data', (chunk) => {
  process.stdout.write(chunk);
});
child.stderr?.on('data', (chunk) => {
  process.stderr.write(chunk);
});

child.on('spawn', () => {
  if (typeof child.pid === 'number' && child.pid > 0) {
    appendFileSync(pidFile, `${String(child.pid)}\n`, 'utf8');
    console.log(`child_pid=${String(child.pid)}`);
  }
});

// Stay alive until killed by Job Object / force stop.
const keepAlive = setInterval(() => {
  // Heartbeat so the process is not considered idle-only.
  process.stdout.write(`parent_alive pid=${String(process.pid)}\n`);
}, 2_000);
if (typeof keepAlive.unref === 'function') keepAlive.unref();

const shutdown = () => {
  clearInterval(keepAlive);
  try {
    child.kill();
  } catch {
    // Best-effort; Job kill-on-close is the real cleanup path.
  }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Never exit spontaneously while children are alive.
child.on('exit', () => {
  // Keep parent alive so force-stop must kill the whole tree, not wait for natural exit.
});
