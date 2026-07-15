#!/usr/bin/env node
/**
 * Mid-level process in the Job Object fixture tree.
 * Spawns a long-lived grandchild (detached from Node's handle but still in the Job).
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const pidFile = process.env.TRIAGENT_PID_FILE;
if (typeof pidFile !== 'string' || pidFile.trim().length === 0) {
  console.error('TRIAGENT_PID_FILE is required');
  process.exit(2);
}

const childPid = process.pid;
appendFileSync(pidFile, `${String(childPid)}\n`, 'utf8');
console.log(`child_self_pid=${String(childPid)}`);

// Grandchild: a tiny Node process that just sleeps forever.
// Write grandchild identity to stdout AND the pid file as soon as spawn fires
// so parent→supervisor capture is deterministic under suite load.
const grandchild = spawn(
  process.execPath,
  [
    '-e',
    [
      "const fs=require('fs');",
      "const pidFile=process.env.TRIAGENT_PID_FILE;",
      "if(pidFile){try{fs.appendFileSync(pidFile, process.pid+'\\n');}catch{}}",
      "process.stdout.write('grandchild_pid='+process.pid+'\\n');",
      "setInterval(() => process.stdout.write('grandchild_alive\\n'), 2000);",
    ].join(''),
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TRIAGENT_PID_FILE: pidFile,
      TRIAGENT_ROLE: 'grandchild',
    },
    windowsHide: true,
  },
);

grandchild.stdout?.on('data', (chunk) => {
  process.stdout.write(chunk);
});
grandchild.stderr?.on('data', (chunk) => {
  process.stderr.write(chunk);
});

grandchild.on('spawn', () => {
  if (typeof grandchild.pid === 'number' && grandchild.pid > 0) {
    // Parent also records for redundancy; grandchild self-records above.
    appendFileSync(pidFile, `${String(grandchild.pid)}\n`, 'utf8');
    console.log(`grandchild_pid=${String(grandchild.pid)}`);
  }
});

const keepAlive = setInterval(() => {
  process.stdout.write(`child_alive pid=${String(process.pid)}\n`);
}, 2_000);
if (typeof keepAlive.unref === 'function') keepAlive.unref();

const shutdown = () => {
  clearInterval(keepAlive);
  try {
    grandchild.kill();
  } catch {
    // Job Object is authoritative.
  }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

grandchild.on('exit', () => {
  // Stay alive so force-stop must kill mid-level too.
});
