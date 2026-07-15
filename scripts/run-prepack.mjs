#!/usr/bin/env node
/**
 * prepack orchestration.
 *
 * Tests and typecheck run OUTSIDE any outer build lock and WITHOUT exporting a
 * reentrant bearer token into the parallel npm test tree (siblings must not
 * bypass mutual exclusion via inherited token).
 *
 * High-load packaging stress (64-child lock overlap, multi-copy concurrency)
 * runs first in a focused Vitest invocation with no other files active. The
 * full suite then runs with TRIAGENT_SKIP_PACKAGING_STRESS=1 so those cases
 * are not double-run under resource contention with Windows Job/process tests.
 *
 * Build runs afterward under its own lock (run-build.mjs); the token is scoped
 * only to sequential nested build children.
 *
 * Skipped when TRIAGENT_SKIP_PREPACK=1 (package e2e uses --ignore-scripts / this
 * flag to avoid recursive pack->prepack->test loops).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.TRIAGENT_SKIP_PREPACK === '1') {
  console.log('prepack skipped (TRIAGENT_SKIP_PREPACK=1)');
  process.exit(0);
}

/**
 * Run an npm script without a build-lock bearer token in the environment.
 * Strips TRIAGENT_BUILD_LOCK_TOKEN so parallel tests cannot reenter a parent lock.
 * @param {string} script
 * @param {NodeJS.ProcessEnv} [extraEnv]
 */
function runViaCmd(script, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.TRIAGENT_BUILD_LOCK_TOKEN;
  // `npm pack --dry-run` exports this lifecycle config to prepack. Nested npm
  // commands must run normally: package-install.test.ts intentionally creates
  // a real throwaway tarball and otherwise receives JSON for a file that npm
  // deliberately did not write.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_dry_run') {
      delete env[key];
    }
  }

  const result =
    process.platform === 'win32'
      ? spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `npm.cmd run ${script}`],
        {
          cwd: root,
          env,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          stdio: 'inherit',
        },
      )
      : spawnSync('npm', ['run', script], {
        cwd: root,
        env,
        encoding: 'utf8',
        shell: false,
        stdio: 'inherit',
      });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// 1) Packaging stress alone (full strength; no other Vitest files).
//    No build-lock token; outside the build transaction.
runViaCmd('test:packaging-stress');

// 2) Full suite with high-load packaging stress cases skipped only.
//    Low-load lock identity/security tests still run.
runViaCmd('test', { TRIAGENT_SKIP_PACKAGING_STRESS: '1' });

// 3) Typecheck outside the build transaction.
runViaCmd('typecheck');

// 4) Build under its own lock (run-build acquires/releases; token only for
//    sequential nested children).
runViaCmd('build');
