import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createIsolatedCopyPackageRoot } from '../unit/scripts/isolated-copy-package-root.js';

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const PACKAGE_JSON = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
) as {
  name: string;
  version: string;
  bin?: Record<string, string>;
  files?: string[];
  type?: string;
  engines?: { node?: string };
};

const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
} {
  const cwd = options.cwd ?? PACKAGE_ROOT;
  const env = options.env ?? process.env;
  const timeout = options.timeoutMs ?? 120_000;
  const isCmdShim =
    /\.(cmd|bat)$/iu.test(command) || command === 'npm' || command === 'npm.cmd';

  const result =
    isCmdShim && process.platform === 'win32'
      ? spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        [
          '/d',
          '/s',
          '/c',
          [command, ...args]
            .map((part) =>
              /\s/u.test(part) ? `"${part.replaceAll('"', '""')}"` : part,
            )
            .join(' '),
        ],
        {
          cwd,
          env,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          timeout,
        },
      )
      : spawnSync(command, [...args], {
        cwd,
        env,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout,
      });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function runNpm(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): ReturnType<typeof run> {
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

beforeAll(() => {
  // Ensure package artifacts exist without invoking prepack (avoids recursive test loops).
  const helper = join(
    PACKAGE_ROOT,
    'dist',
    'native',
    'win-x64',
    'triagent-process-host.exe',
  );
  const checksum = join(
    PACKAGE_ROOT,
    'dist',
    'native',
    'win-x64',
    'checksum-metadata.json',
  );
  const cli = join(PACKAGE_ROOT, 'dist', 'cli.js');
  const trust = join(
    PACKAGE_ROOT,
    'src',
    'process',
    'generated-native-helper-trust.ts',
  );
  if (
    !existsSync(cli)
    || !existsSync(helper)
    || !existsSync(checksum)
    || !existsSync(trust)
    || readFileSync(trust, 'utf8').includes('0'.repeat(64))
  ) {
    const built = runNpm(['run', 'build'], {
      timeoutMs: 600_000,
      env: {
        ...process.env,
        TRIAGENT_SKIP_PREPACK: '1',
      },
    });
    expect(
      built.status,
      `${built.stdout}\n${built.stderr}\n${built.error?.message ?? ''}`,
    ).toBe(0);
  }
  expect(existsSync(cli), 'dist/cli.js must exist after build').toBe(true);
  expect(existsSync(helper), 'packaged native helper must exist after build').toBe(
    true,
  );
  expect(existsSync(checksum), 'checksum metadata must exist after build').toBe(
    true,
  );

  // Real dist is verified read-only above. Consecutive copy must use an isolated
  // package root so parallel integration tests mapping the real helper are not
  // disrupted by rename-to-bak of the production dist exe.
  const isolated = createIsolatedCopyPackageRoot(
    PACKAGE_ROOT,
    'triagent-e2e-copy-',
  );
  temporaryDirectories.push(isolated);
  const copyScript = join(PACKAGE_ROOT, 'scripts', 'copy-native.mjs');
  const firstCopy = run(
    process.execPath,
    [copyScript, `--package-root=${isolated}`],
    {
      cwd: isolated,
      timeoutMs: 120_000,
      env: { ...process.env, TRIAGENT_BUILD_LOCK_TOKEN: '' },
    },
  );
  expect(firstCopy.status, `${firstCopy.stdout}\n${firstCopy.stderr}`).toBe(0);
  const secondCopy = run(
    process.execPath,
    [copyScript, `--package-root=${isolated}`],
    {
      cwd: isolated,
      timeoutMs: 120_000,
      env: { ...process.env, TRIAGENT_BUILD_LOCK_TOKEN: '' },
    },
  );
  expect(secondCopy.status, `${secondCopy.stdout}\n${secondCopy.stderr}`).toBe(
    0,
  );
  const isolatedNativeOut = join(isolated, 'dist', 'native', 'win-x64');
  const unexpected = readdirSync(isolatedNativeOut).filter((name) => {
    const lower = name.toLowerCase();
    return (
      lower.endsWith('.tmp')
      || lower.endsWith('.bak')
      || lower.endsWith('.bad')
      || lower.startsWith('.')
    );
  });
  expect(unexpected, `tmp/bak leftovers: ${unexpected.join(', ')}`).toEqual([]);
}, 650_000);

afterEach(() => {
  for (const file of temporaryFiles.splice(0)) {
    rmSync(file, { force: true });
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('package install e2e', () => {
  it(
    'packs only allowlisted artifacts, installs globally, help has no side effects',
    () => {
      expect(PACKAGE_JSON.bin).toEqual({ triagent: './dist/cli.js' });
      expect(PACKAGE_JSON.type).toBe('module');
      expect(PACKAGE_JSON.engines?.node).toMatch(/24/);
      expect(PACKAGE_JSON.files).toEqual([
        'dist/cli.js',
        'dist/cli.js.map',
        'dist/migrations/*.sql',
        'dist/native/win-x64/triagent-process-host.exe',
        'dist/native/win-x64/checksum-metadata.json',
        'dist/native/win-x64/triagent-process-host.sha256',
        'schemas/agent-result.schema.json',
        'schemas/agent-patch-result.schema.json',
        'README.md',
      ]);

      const packDir = temporaryDirectory('triagent-pack-');
      // --ignore-scripts avoids recursive prepack; also set skip flag.
      const pack = runNpm(
        ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
        {
          cwd: PACKAGE_ROOT,
          timeoutMs: 300_000,
          env: {
            ...process.env,
            TRIAGENT_SKIP_PREPACK: '1',
          },
        },
      );
      expect(
        pack.status,
        `${pack.stdout}\n${pack.stderr}\n${pack.error?.message ?? ''}`,
      ).toBe(0);

      const jsonStart = pack.stdout.indexOf('[');
      const jsonEnd = pack.stdout.lastIndexOf(']');
      expect(jsonStart, pack.stdout).toBeGreaterThanOrEqual(0);
      const packJson = JSON.parse(
        pack.stdout.slice(jsonStart, jsonEnd + 1),
      ) as Array<{
        name?: string;
        version?: string;
        filename: string;
        size?: number;
        files?: Array<{ path: string; size?: number }>;
      }>;
      const packEntry = packJson[0]!;
      expect(packEntry.name ?? PACKAGE_JSON.name).toBe(PACKAGE_JSON.name);

      const tarballName =
        packEntry.filename
        || `${PACKAGE_JSON.name}-${PACKAGE_JSON.version}.tgz`;
      const tarballPath = join(packDir, tarballName);
      temporaryFiles.push(tarballPath);
      expect(existsSync(tarballPath)).toBe(true);

      const tarballSize = statSync(tarballPath).size;
      // Helper is ~70MB self-contained; total pack should be under ~120MB.
      expect(tarballSize).toBeGreaterThan(1_000_000);
      expect(tarballSize).toBeLessThan(120 * 1024 * 1024);

      const filesFromJson = (packEntry.files ?? []).map((file) =>
        file.path.replaceAll('\\', '/'),
      );
      let normalized = filesFromJson;
      if (normalized.length === 0) {
        const tarList = run('tar', ['-tf', tarballPath], {
          cwd: PACKAGE_ROOT,
          timeoutMs: 60_000,
        });
        expect(tarList.status).toBe(0);
        normalized = tarList.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim().replace(/^package\//u, ''))
          .filter((line) => line.length > 0);
      }

      const required = [
        'package.json',
        'README.md',
        'dist/cli.js',
        'dist/cli.js.map',
        'dist/migrations/001_initial.sql',
        'dist/migrations/002_project_lock_leases.sql',
        'dist/migrations/003_guard_active_lock_deletes.sql',
        'dist/migrations/004_log_index_integrity.sql',
        'dist/migrations/005_budget_runtime_and_calls.sql',
        'dist/migrations/006_agent_session_resume_evidence.sql',
        'dist/migrations/007_implementation_workspaces.sql',
        'dist/migrations/008_agent_session_workspace_write_mode.sql',
        'schemas/agent-result.schema.json',
        'schemas/agent-patch-result.schema.json',
        'dist/native/win-x64/triagent-process-host.exe',
        'dist/native/win-x64/checksum-metadata.json',
        'dist/native/win-x64/triagent-process-host.sha256',
      ];
      for (const path of required) {
        expect(normalized, `missing ${path}`).toContain(path);
      }

      for (const path of normalized) {
        expect(path, `forbidden ${path}`).not.toMatch(
          /(?:^|\/)(?:src|tests|docs|\.worktrees|native\/TriAgent|node_modules)(?:\/|$)/u,
        );
        expect(path, `transient ${path}`).not.toMatch(
          /\.(tmp|bak|bad)$/u,
        );
        expect(path, `dotfile ${path}`).not.toMatch(/(?:^|\/)\./u);
      }

      // Embedded trust constants must appear in bundled CLI (not only adjacent metadata).
      const cliText = readFileSync(join(PACKAGE_ROOT, 'dist', 'cli.js'), 'utf8');
      const trust = readFileSync(
        join(PACKAGE_ROOT, 'src', 'process', 'generated-native-helper-trust.ts'),
        'utf8',
      );
      const shaMatch = trust.match(/["']([0-9a-f]{64})["']/u);
      expect(shaMatch).toBeTruthy();
      expect(cliText).toContain(shaMatch![1]!);

      const cliHead = readFileSync(join(PACKAGE_ROOT, 'dist', 'cli.js'), 'utf8').slice(
        0,
        64,
      );
      expect(cliHead.startsWith('#!/usr/bin/env node')).toBe(true);

      const prefix = temporaryDirectory('triagent-npm-prefix-');
      const install = runNpm(
        ['install', '-g', tarballPath, '--prefix', prefix],
        {
          cwd: packDir,
          env: {
            ...process.env,
            npm_config_update_notifier: 'false',
            npm_config_fund: 'false',
            npm_config_audit: 'false',
            TRIAGENT_SKIP_PREPACK: '1',
          },
          timeoutMs: 300_000,
        },
      );
      expect(
        install.status,
        `${install.stdout}\n${install.stderr}`,
      ).toBe(0);

      const binDirCandidates = [
        join(prefix, 'triagent.cmd'),
        join(prefix, 'bin', 'triagent.cmd'),
        join(prefix, 'triagent'),
        join(prefix, 'bin', 'triagent'),
      ];
      const triagentCmd = binDirCandidates.find((candidate) =>
        existsSync(candidate),
      );
      expect(triagentCmd).toBeDefined();

      const isolatedAppRoot = temporaryDirectory('triagent-app-root-');
      const helpCwd = temporaryDirectory('triagent-help-cwd-');
      const help = run(triagentCmd!, ['--help'], {
        cwd: helpCwd,
        env: {
          ...process.env,
          TRIAGENT_APP_ROOT: isolatedAppRoot,
          TRIAGENT_REAL_AI_TESTS: '0',
        },
        timeoutMs: 60_000,
      });
      expect(help.status, `${help.stdout}\n${help.stderr}`).toBe(0);
      expect(`${help.stdout}\n${help.stderr}`).toMatch(/TriAgent|Usage|triagent/i);
      expect(readdirSync(isolatedAppRoot)).toEqual([]);
      expect(readdirSync(helpCwd)).toEqual([]);

      const installedRootCandidates = [
        join(prefix, 'node_modules', PACKAGE_JSON.name),
        join(prefix, 'lib', 'node_modules', PACKAGE_JSON.name),
      ];
      const installedRoot = installedRootCandidates.find((candidate) =>
        existsSync(join(candidate, 'package.json')),
      );
      expect(installedRoot).toBeDefined();
      expect(
        statSync(
          join(
            installedRoot!,
            'dist',
            'native',
            'win-x64',
            'triagent-process-host.exe',
          ),
        ).isFile(),
      ).toBe(true);
      // Generated source must not ship.
      expect(
        existsSync(
          join(installedRoot!, 'src', 'process', 'generated-native-helper-trust.ts'),
        ),
      ).toBe(false);
    },
    600_000,
  );
});
