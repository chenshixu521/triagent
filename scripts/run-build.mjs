#!/usr/bin/env node
/**
 * Orchestrated build under a single interprocess lock:
 *   1) native (unlocked ps1 under our lock)
 *   2) trust generation
 *   3) node (tsup under our lock)
 *   4) copy-native
 *
 * Invokes unlocked implementations directly so nested public wrappers do not
 * re-acquire / deadlock. Exports TRIAGENT_BUILD_LOCK_TOKEN only to sequential
 * nested children that may reenter if they call acquireBuildLock.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireBuildLock } from './lib/build-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    const err = new Error(
      `${command} ${args.join(' ')} failed with exit ${String(result.status)}`,
    );
    /** @type {{ exitCode?: number }} */ (err).exitCode = result.status ?? 1;
    throw err;
  }
}

function resolveTsupCli() {
  const candidates = [
    resolve(root, 'node_modules/tsup/dist/cli-default.js'),
    resolve(root, 'node_modules/tsup/dist/cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  const inherited =
    typeof process.env.TRIAGENT_BUILD_LOCK_TOKEN === 'string'
    && process.env.TRIAGENT_BUILD_LOCK_TOKEN.length > 0
      ? process.env.TRIAGENT_BUILD_LOCK_TOKEN
      : undefined;

  const lock = acquireBuildLock({
    lockRoot: root,
    ...(inherited !== undefined ? { reentrantToken: inherited } : {}),
  });

  const env = {
    TRIAGENT_BUILD_LOCK_TOKEN: lock.token,
    TRIAGENT_BUILD_LOCK_WAIT_MS: '5000',
  };

  try {
    // Unlocked implementations — lock held by this process only.
    run(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve(root, 'scripts/build-native.ps1'),
      ],
      env,
    );
    run(
      process.execPath,
      [resolve(root, 'scripts/generate-native-trust.mjs')],
      env,
    );
    const tsupCli = resolveTsupCli();
    if (tsupCli !== null) {
      run(process.execPath, [tsupCli], env);
    } else if (process.platform === 'win32') {
      run(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', 'npx --no-install tsup'],
        env,
      );
    } else {
      run('npx', ['--no-install', 'tsup'], env);
    }
    run(process.execPath, [resolve(root, 'scripts/copy-native.mjs')], env);
  } finally {
    lock.release();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode =
    error && typeof error === 'object' && 'exitCode' in error
      ? Number(/** @type {{ exitCode?: number }} */ (error).exitCode) || 1
      : 1;
}
