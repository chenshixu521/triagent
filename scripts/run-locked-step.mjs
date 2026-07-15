#!/usr/bin/env node
/**
 * Lock-aware wrapper for public mutating build steps.
 *
 * Usage:
 *   node scripts/run-locked-step.mjs <native|trust|node|copy>
 *
 * Acquires the package build lock (or reenters with TRIAGENT_BUILD_LOCK_TOKEN
 * for sequential aggregate build children). Unlocked implementations are not
 * public npm scripts — only these wrappers are.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireBuildLock } from './lib/build-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const step = process.argv[2];

/**
 * @returns {{ command: string, args: string[] }}
 */
function resolveStep(name) {
  if (name === 'native') {
    return {
      command: 'powershell',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve(root, 'scripts/build-native.ps1'),
      ],
    };
  }
  if (name === 'trust') {
    return {
      command: process.execPath,
      args: [resolve(root, 'scripts/generate-native-trust.mjs')],
    };
  }
  if (name === 'node') {
    const candidates = [
      resolve(root, 'node_modules/tsup/dist/cli-default.js'),
      resolve(root, 'node_modules/tsup/dist/cli.js'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { command: process.execPath, args: [candidate] };
      }
    }
    // Fallback: cmd npm exec without re-entering package scripts.
    if (process.platform === 'win32') {
      return {
        command: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', 'npx --no-install tsup'],
      };
    }
    return {
      command: 'npx',
      args: ['--no-install', 'tsup'],
    };
  }
  if (name === 'copy') {
    return {
      command: process.execPath,
      args: [resolve(root, 'scripts/copy-native.mjs')],
    };
  }
  throw new Error(`unknown step: ${String(name)}`);
}

if (step === undefined) {
  console.error(
    'Usage: node scripts/run-locked-step.mjs <native|trust|node|copy>',
  );
  process.exit(2);
}

let def;
try {
  def = resolveStep(step);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const inherited =
  typeof process.env.TRIAGENT_BUILD_LOCK_TOKEN === 'string'
  && process.env.TRIAGENT_BUILD_LOCK_TOKEN.length > 0
    ? process.env.TRIAGENT_BUILD_LOCK_TOKEN
    : undefined;

const lock = acquireBuildLock({
  lockRoot: root,
  ...(inherited !== undefined ? { reentrantToken: inherited } : {}),
});

const childEnv = {
  ...process.env,
  TRIAGENT_BUILD_LOCK_TOKEN: lock.token,
  TRIAGENT_BUILD_LOCK_WAIT_MS:
    process.env.TRIAGENT_BUILD_LOCK_WAIT_MS ?? '5000',
};

let status = 1;
try {
  const result = spawnSync(def.command, def.args, {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  status = result.status ?? 1;
} finally {
  try {
    lock.release();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (status === 0) status = 1;
  }
}

process.exit(status);
