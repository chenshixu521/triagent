import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  relative,
  resolve,
  toNamespacedPath,
} from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  areProjectRootsOverlapping,
  canonicalizeProjectPath,
  windowsPathComparisonKey,
} from '../../../src/project/canonical-path.js';
import { detectProjectKind } from '../../../src/project/project-kind.js';
import { ReparseInspectionError } from '../../../src/project/reparse-points.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix = 'triagent-project-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('canonical project paths', () => {
  it('preserves the display input while resolving spaces, Chinese names, dot segments, and trailing separators', () => {
    const root = temporaryDirectory();
    const project = join(root, '项目 with spaces');
    mkdirSync(join(project, 'nested'), { recursive: true });
    const input = `${join(project, 'nested', '..')}${process.platform === 'win32' ? '\\' : '/'}`;

    const canonical = canonicalizeProjectPath(input);

    expect(canonical.displayPath).toBe(input);
    expect(canonical.absolutePath).toBe(resolve(project));
    expect(canonical.canonicalRoot).toBe(resolve(project));
    expect(canonical.realPath).toBe(resolve(project));
    expect(canonical.comparisonKey).toBe(
      process.platform === 'win32'
        ? windowsPathComparisonKey(project)
        : resolve(project),
    );
    expect(canonical.reparsePoints).toEqual([]);
    expect(canonical.traversedReparsePoint).toBe(false);
  });

  it('normalizes Windows drive case, separator form, trailing separators, and namespace paths for comparison', () => {
    expect(windowsPathComparisonKey('d:/Repo/子目录/')).toBe(
      windowsPathComparisonKey('D:\\repo\\子目录'),
    );
    expect(windowsPathComparisonKey('\\\\?\\D:\\Repo\\')).toBe(
      windowsPathComparisonKey('d:\\repo'),
    );
    expect(windowsPathComparisonKey('\\\\?\\UNC\\Server\\Share\\Repo')).toBe(
      windowsPathComparisonKey('\\\\server\\share\\repo\\'),
    );
  });

  it.each([
    '\\\\.\\C:\\device-path',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1',
    '\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\project',
    '\\\\?\\NamedDevice\\project',
    '\\\\?\\C:relative',
    '\\\\?\\UNC\\server-only',
  ])('rejects unsupported Windows namespace %s before comparison or filesystem resolution', (input) => {
    const cwd = temporaryDirectory();
    mkdirSync(join(cwd, 'GLOBALROOT', 'Device', 'HarddiskVolumeShadowCopy1'), {
      recursive: true,
    });
    mkdirSync(
      join(cwd, 'Volume{00000000-0000-0000-0000-000000000000}', 'project'),
      { recursive: true },
    );
    mkdirSync(join(cwd, 'NamedDevice', 'project'), { recursive: true });

    expect(() => windowsPathComparisonKey(input)).toThrow(
      /UnsupportedWindowsNamespace/i,
    );
    expect(() => canonicalizeProjectPath(input, { cwd })).toThrow(
      /UnsupportedWindowsNamespace/i,
    );
  });

  it('canonicalizes a namespaced long path without losing its readable root', () => {
    const root = temporaryDirectory('triagent-long-');
    let project = root;
    for (let index = 0; index < 5; index += 1) {
      project = join(project, `segment-${index}-${'长'.repeat(40)}`);
    }
    mkdirSync(project, { recursive: true });

    const canonical = canonicalizeProjectPath(toNamespacedPath(project));

    expect(canonical.canonicalRoot).toBe(resolve(project));
    expect(canonical.comparisonKey).toBe(
      process.platform === 'win32'
        ? windowsPathComparisonKey(project)
        : resolve(project),
    );
  });

  it('rejects missing paths and files instead of treating them as project directories', () => {
    const root = temporaryDirectory();
    const file = join(root, 'not-a-directory.txt');
    writeFileSync(file, 'data', 'utf8');

    expect(() => canonicalizeProjectPath(join(root, 'missing'))).toThrow(
      /does not exist|missing/i,
    );
    expect(() => canonicalizeProjectPath(file)).toThrow(/directory/i);
  });

  it.runIf(process.platform === 'win32')('records junction evidence and the real target', () => {
    const root = temporaryDirectory();
    const target = join(root, '目标 project');
    const junction = join(root, 'junction 中文');
    mkdirSync(target);
    symlinkSync(target, junction, 'junction');

    const canonical = canonicalizeProjectPath(junction);

    expect(canonical.canonicalRoot).toBe(resolve(target));
    expect(canonical.traversedReparsePoint).toBe(true);
    expect(canonical.reparsePoints).toEqual([
      expect.objectContaining({
        inputPath: resolve(junction),
        targetPath: resolve(target),
        kind: expect.stringMatching(/junction|symbolic/i),
      }),
    ]);
  });

  it('records injected Windows reparse evidence even when lstat does not report a symbolic link', () => {
    const root = temporaryDirectory();
    const component = join(root, '项目 non-symlink reparse');
    const reportedTarget = join(root, 'reported target');
    mkdirSync(component);
    mkdirSync(reportedTarget);
    const probedRoots: string[] = [];

    const canonical = canonicalizeProjectPath(component, {
      reparseProbe: (requestedRoot) => {
        probedRoots.push(requestedRoot);
        return [{
          path: resolve(component),
          isReparsePoint: true,
          linkType: 'MountPoint',
          target: [resolve(reportedTarget)],
          attributes: ['Directory', 'ReparsePoint'],
        }];
      },
    });

    expect(probedRoots).toEqual([resolve(component)]);
    expect(canonical.traversedReparsePoint).toBe(true);
    expect(canonical.reparsePoints).toEqual([
      expect.objectContaining({
        inputPath: resolve(component),
        kind: 'unknown-reparse-point',
        linkType: 'MountPoint',
        reportedTargets: [resolve(reportedTarget)],
        attributes: ['Directory', 'ReparsePoint'],
      }),
    ]);
  });

  it('fails closed with ReparseInspectionError when a probe returns invalid structured output', () => {
    const project = temporaryDirectory();

    expect(() =>
      canonicalizeProjectPath(project, {
        reparseProbe: () => ({ invalid: true }) as never,
      }),
    ).toThrow(ReparseInspectionError);
    expect(() =>
      canonicalizeProjectPath(project, {
        reparseProbe: () => {
          throw new Error('probe process failed');
        },
      }),
    ).toThrow(/ReparseInspectionError|reparse.*inspect|probe process failed/i);
  });

  it('passes one constant root payload to the probe for a deep project path', () => {
    const root = temporaryDirectory();
    let project = root;
    for (let index = 0; index < 24; index += 1) {
      project = join(project, `component-${String(index).padStart(2, '0')}`);
    }
    mkdirSync(project, { recursive: true });
    const requests: string[] = [];

    canonicalizeProjectPath(project, {
      reparseProbe: (requestedRoot) => {
        requests.push(requestedRoot);
        return [];
      },
    });

    expect(requests).toEqual([resolve(project)]);
  });

  it('fails closed for duplicate or non-ancestor paths returned by a probe', () => {
    const project = temporaryDirectory();
    const outside = temporaryDirectory();
    const result = {
      path: resolve(project),
      isReparsePoint: true,
      linkType: 'MountPoint',
      target: [],
      attributes: ['ReparsePoint'],
    };

    expect(() =>
      canonicalizeProjectPath(project, {
        reparseProbe: () => [result, result],
      }),
    ).toThrow(/ReparseInspectionError|duplicate/i);
    expect(() =>
      canonicalizeProjectPath(project, {
        reparseProbe: () => [{ ...result, path: outside }],
      }),
    ).toThrow(/ReparseInspectionError|ancestor|component/i);
  });

  it('wraps probe timeouts as fail-closed ReparseInspectionError', () => {
    const project = temporaryDirectory();
    const timeout = Object.assign(new Error('probe timed out'), {
      code: 'ETIMEDOUT',
    });

    expect(() =>
      canonicalizeProjectPath(project, {
        reparseProbe: () => {
          throw timeout;
        },
      }),
    ).toThrow(ReparseInspectionError);
  });

  it('records symbolic-link evidence when the platform permits creating one', (context) => {
    const root = temporaryDirectory();
    const target = join(root, 'target');
    const link = join(root, 'link');
    mkdirSync(target);
    try {
      symlinkSync(target, link, process.platform === 'win32' ? 'dir' : undefined);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        context.skip();
        return;
      }
      throw error;
    }

    const canonical = canonicalizeProjectPath(link);

    expect(canonical.canonicalRoot).toBe(resolve(target));
    expect(canonical.traversedReparsePoint).toBe(true);
    expect(canonical.reparsePoints[0]).toMatchObject({
      inputPath: resolve(link),
      targetPath: resolve(target),
    });
  });
});

describe('project path overlap', () => {
  it.each([
    ['same root', 'D:\\repo', 'd:/REPO/', true],
    ['parent and child', 'D:\\repo', 'D:\\repo\\packages\\a', true],
    ['child and parent', 'D:\\repo\\packages\\a', 'D:\\repo', true],
    ['sibling', 'D:\\repo\\a', 'D:\\repo\\b', false],
    ['textual prefix only', 'D:\\repo', 'D:\\repo-a', false],
    ['different volume', 'D:\\repo', 'E:\\repo', false],
    ['UNC same root', '\\\\Server\\Share\\Repo', '\\\\server\\share\\repo\\', true],
    ['UNC parent and child', '\\\\server\\share\\repo', '\\\\SERVER\\SHARE\\repo\\child', true],
    ['UNC sibling shares', '\\\\server\\share-a\\repo', '\\\\server\\share-b\\repo', false],
  ])('%s', (_label, left, right, expected) => {
    expect(areProjectRootsOverlapping(left, right, 'windows')).toBe(expected);
  });
});

describe('project kind detection', () => {
  it('identifies an ordinary directory', () => {
    const root = temporaryDirectory();
    const canonical = canonicalizeProjectPath(root);

    expect(detectProjectKind(canonical)).toEqual({
      kind: 'directory',
      projectRoot: canonical.canonicalRoot,
    });
  });

  it('returns an explicit result when Git is unavailable', () => {
    const canonical = canonicalizeProjectPath(temporaryDirectory());

    expect(
      detectProjectKind(canonical, { gitExecutable: join(canonical.canonicalRoot, 'missing-git.exe') }),
    ).toMatchObject({
      kind: 'git-unavailable',
      projectRoot: canonical.canonicalRoot,
    });
  });

  it.each([
    ['timeout', 'ETIMEDOUT'],
    ['output overflow', 'ENOBUFS'],
  ])('maps Git %s to an explicit unavailable result with bounded runner options', (_label, code) => {
    const canonical = canonicalizeProjectPath(temporaryDirectory(), {
      reparseProbe: () => [],
    });
    const requests: unknown[] = [];

    const result = detectProjectKind(canonical, {
      runner: (request) => {
        requests.push(request);
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: Object.assign(new Error(`Git ${code}`), { code }),
        };
      },
    });

    expect(result).toMatchObject({
      kind: 'git-unavailable',
      projectRoot: canonical.canonicalRoot,
      error: expect.stringMatching(/timeout|timed|buffer|overflow|ENOBUFS|ETIMEDOUT/i),
    });
    expect(requests).toEqual([
      expect.objectContaining({
        executable: 'git',
        args: ['-C', canonical.canonicalRoot, 'rev-parse', '--show-toplevel'],
        timeoutMs: expect.any(Number),
        maxBuffer: expect.any(Number),
        windowsHide: true,
      }),
    ]);
    expect((requests[0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(10_000);
    expect((requests[0] as { maxBuffer: number }).maxBuffer).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });

  it.each([
    ['empty output', ''],
    ['relative path', 'relative/repository\n'],
    ['extra output line', 'C:\\repo\nC:\\other\n'],
    ['extra blank line', 'C:\\repo\n\n'],
  ])('rejects malformed successful Git top-level %s', (_label, stdout) => {
    const canonical = canonicalizeProjectPath(temporaryDirectory(), {
      reparseProbe: () => [],
    });

    expect(() =>
      detectProjectKind(canonical, {
        runner: () => ({ status: 0, stdout, stderr: '' }),
      }),
    ).toThrow(/GitDetectionError|one non-empty line|absolute/i);
  });

  it('maps unexpected nonzero Git detection to a clear detection error', () => {
    const canonical = canonicalizeProjectPath(temporaryDirectory(), {
      reparseProbe: () => [],
    });

    expect(() =>
      detectProjectKind(canonical, {
        runner: () => ({
          status: 2,
          stdout: '',
          stderr: 'fatal: unexpected repository failure',
        }),
      }),
    ).toThrow(/GitDetectionError|unexpected repository failure/i);
  });

  it('rejects a reported Git top-level that is a child of the selected root', () => {
    const selected = temporaryDirectory();
    const child = join(selected, 'child');
    mkdirSync(child);
    const canonical = canonicalizeProjectPath(selected, {
      reparseProbe: () => [],
    });

    expect(() =>
      detectProjectKind(canonical, {
        runner: () => ({
          status: 0,
          stdout: `${resolve(child)}\n`,
          stderr: '',
        }),
      }),
    ).toThrow(/GitDetectionError|ancestor|selected project/i);
  });

  it.runIf(gitAvailable())('ignores repository-shaping Git environment variables in the default runner', () => {
    const externalRepository = temporaryDirectory('triagent-external-git-');
    const selected = temporaryDirectory('triagent-selected-');
    const selectedChild = join(selected, 'child');
    mkdirSync(selectedChild);
    execFileSync('git', ['init', externalRepository], { stdio: 'ignore' });
    const variableNames = [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ] as const;
    const previous = new Map(
      variableNames.map((name) => [name, process.env[name]] as const),
    );
    process.env.GIT_DIR = join(externalRepository, '.git');
    process.env.GIT_WORK_TREE = selectedChild;
    process.env.GIT_COMMON_DIR = join(externalRepository, '.git');
    process.env.GIT_INDEX_FILE = join(externalRepository, '.git', 'index');
    process.env.GIT_OBJECT_DIRECTORY = join(externalRepository, '.git', 'objects');
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(
      externalRepository,
      '.git',
      'objects',
    );
    try {
      expect(detectProjectKind(canonicalizeProjectPath(selected))).toEqual({
        kind: 'directory',
        projectRoot: resolve(selected),
      });
    } finally {
      for (const name of variableNames) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 15_000);

  it.runIf(gitAvailable())('ignores lowercase and mixed-case repository-shaping Git environment variables on Windows', () => {
    const externalRepository = temporaryDirectory('triagent-external-git-case-');
    const selected = temporaryDirectory('triagent-selected-case-');
    const selectedChild = join(selected, 'child');
    mkdirSync(selectedChild);
    execFileSync('git', ['init', externalRepository], { stdio: 'ignore' });
    const deniedUppercase = new Set([
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ]);
    const previousEntries = Object.keys(process.env)
      .filter((key) => deniedUppercase.has(key.toUpperCase()))
      .map((key) => [key, process.env[key]] as const);
    for (const [key] of previousEntries) delete process.env[key];
    const poisonedEntries = [
      ['git_dir', join(externalRepository, '.git')],
      ['git_work_tree', selectedChild],
      ['Git_Common_Dir', join(externalRepository, '.git')],
      ['gIt_InDeX_fIlE', join(externalRepository, '.git', 'index')],
      ['git_Object_Directory', join(externalRepository, '.git', 'objects')],
      [
        'Git_Alternate_Object_Directories',
        join(externalRepository, '.git', 'objects'),
      ],
    ] as const;
    for (const [key, value] of poisonedEntries) process.env[key] = value;
    try {
      expect(detectProjectKind(canonicalizeProjectPath(selected))).toEqual({
        kind: 'directory',
        projectRoot: resolve(selected),
      });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (deniedUppercase.has(key.toUpperCase())) delete process.env[key];
      }
      for (const [key, value] of previousEntries) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  }, 15_000);

  it.runIf(gitAvailable())('identifies a normal Git repository and nested selection semantics', () => {
    const root = temporaryDirectory();
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    const nested = join(root, 'packages', 'a');
    mkdirSync(nested, { recursive: true });

    expect(detectProjectKind(canonicalizeProjectPath(root))).toMatchObject({
      kind: 'git',
      projectRoot: resolve(root),
      repositoryRoot: resolve(root),
      relationship: 'root',
      gitMetadata: 'directory',
    });
    expect(detectProjectKind(canonicalizeProjectPath(nested))).toMatchObject({
      kind: 'git',
      projectRoot: resolve(nested),
      repositoryRoot: resolve(root),
      relationship: 'nested',
      gitMetadata: 'ancestor',
    });
  }, 15_000);

  it.runIf(gitAvailable())('identifies a Git worktree whose .git marker is a file', () => {
    const repository = temporaryDirectory('triagent-git-main-');
    const worktreeParent = temporaryDirectory('triagent-git-worktree-');
    const worktree = join(worktreeParent, 'checkout');
    execFileSync('git', ['init', repository], { stdio: 'ignore' });
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'triagent@example.invalid']);
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'TriAgent Tests']);
    writeFileSync(join(repository, 'README.md'), 'fixture\n', 'utf8');
    execFileSync('git', ['-C', repository, 'add', 'README.md']);
    execFileSync('git', ['-C', repository, 'commit', '-m', 'fixture'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-b', 'fixture-worktree', worktree], {
      stdio: 'ignore',
    });

    const canonical = canonicalizeProjectPath(worktree);
    expect(detectProjectKind(canonical)).toMatchObject({
      kind: 'git',
      projectRoot: resolve(worktree),
      repositoryRoot: resolve(worktree),
      relationship: 'root',
      gitMetadata: 'file',
    });
    expect(relative(dirname(worktree), canonical.canonicalRoot)).toBe('checkout');
  }, 15_000);
});
