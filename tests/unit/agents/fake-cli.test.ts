import {
  mkdtempSync,
  mkdirSync,
  linkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  crashScenario,
  invalidJsonScenario,
  queuedMessagesScenario,
  resumeScenario,
  successfulStructuredScenario,
  timeoutScenario,
  type FakeCliScenario,
} from '../../fixtures/fake-cli/scenarios.js';

const fakeCliPath = fileURLToPath(
  new URL('../../fixtures/fake-cli/index.mjs', import.meta.url),
);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-fake-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeScenario(directory: string, scenario: FakeCliScenario): string {
  const path = join(directory, 'scenario with spaces.json');
  writeFileSync(path, JSON.stringify(scenario), 'utf8');
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('fake CLI fixture', () => {
  it('emits partial NDJSON chunks and confines project writes and delayed descendants to the supplied root', () => {
    const temporary = temporaryDirectory();
    const projectRoot = join(temporary, '项目 with spaces');
    mkdirSync(projectRoot);
    const attemptId = 'attempt-cli-safe';
    const scenarioPath = writeScenario(
      temporary,
      successfulStructuredScenario({
        attemptId,
        conversationId: 'conversation-cli-safe',
        output: { summary: 'done' },
        partialOutput: { text: 'partial output', splitAt: 18 },
        projectWrite: {
          relativePath: 'nested/结果.txt',
          content: 'safe project write',
        },
        delayedDescendant: {
          delayMs: 5,
          markerRelativePath: 'descendant/完成.txt',
          markerContent: 'child complete',
          waitForExit: true,
        },
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        fakeCliPath,
        scenarioPath,
        '--attempt-id',
        attemptId,
        '--project-root',
        projectRoot,
        '--temp-base',
        temporary,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))).toEqual([
      {
        type: 'output',
        attemptId,
        text: 'partial output',
      },
      {
        type: 'result',
        attemptId,
        conversationId: 'conversation-cli-safe',
        output: { summary: 'done' },
      },
    ]);
    expect(readFileSync(join(projectRoot, 'nested', '结果.txt'), 'utf8')).toBe(
      'safe project write',
    );
    expect(
      readFileSync(join(projectRoot, 'descendant', '完成.txt'), 'utf8'),
    ).toBe('child complete');
  });

  it('emits the invalid JSON scenario verbatim without crashing the fixture', () => {
    const temporary = temporaryDirectory();
    const projectRoot = join(temporary, 'project');
    mkdirSync(projectRoot);
    const attemptId = 'attempt-cli-invalid';
    const scenarioPath = writeScenario(
      temporary,
      invalidJsonScenario(attemptId),
    );

    const result = spawnSync(
      process.execPath,
      [
        fakeCliPath,
        scenarioPath,
        '--attempt-id',
        attemptId,
        '--project-root',
        projectRoot,
        '--temp-base',
        temporary,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"invalid":\n');
  });

  it('exits nonzero for the deterministic crash scenario', () => {
    const temporary = temporaryDirectory();
    const projectRoot = join(temporary, 'project');
    mkdirSync(projectRoot);
    const attemptId = 'attempt-cli-crash';
    const scenarioPath = writeScenario(
      temporary,
      crashScenario(attemptId, 17, 'planned fake crash'),
    );

    const result = spawnSync(
      process.execPath,
      [
        fakeCliPath,
        scenarioPath,
        '--attempt-id',
        attemptId,
        '--project-root',
        projectRoot,
        '--temp-base',
        temporary,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );

    expect(result.status).toBe(17);
    expect(result.stderr).toBe('planned fake crash\n');
  });

  it('can remain active long enough for a supervisor timeout', () => {
    const temporary = temporaryDirectory();
    const projectRoot = join(temporary, 'project');
    mkdirSync(projectRoot);
    const attemptId = 'attempt-cli-timeout';
    const scenarioPath = writeScenario(
      temporary,
      timeoutScenario(attemptId, 1_000),
    );

    const result = spawnSync(
      process.execPath,
      [
        fakeCliPath,
        scenarioPath,
        '--attempt-id',
        attemptId,
        '--project-root',
        projectRoot,
        '--temp-base',
        temporary,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 200 },
    );

    expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(result.status).toBeNull();
  });

  it('binds a resume scenario to the explicitly supplied conversation', () => {
    const temporary = temporaryDirectory();
    const projectRoot = join(temporary, 'project');
    mkdirSync(projectRoot);
    const attemptId = 'attempt-cli-resume';
    const conversationId = 'conversation-cli-resume';
    const scenarioPath = writeScenario(
      temporary,
      resumeScenario(attemptId, conversationId, { resumed: true }),
    );

    const result = spawnSync(
      process.execPath,
      [
        fakeCliPath,
        scenarioPath,
        '--attempt-id',
        attemptId,
        '--project-root',
        projectRoot,
        '--temp-base',
        temporary,
        '--conversation-id',
        conversationId,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      type: 'result',
      attemptId,
      conversationId,
      output: { resumed: true },
    });
  });

  it('emits monotonically sequenced queued-message events', () => {
    const temporary = temporaryDirectory();
    const projectRoot = join(temporary, 'project');
    mkdirSync(projectRoot);
    const attemptId = 'attempt-cli-queued';
    const scenarioPath = writeScenario(
      temporary,
      queuedMessagesScenario(attemptId, ['first', 'second']),
    );

    const result = spawnSync(
      process.execPath,
      [
        fakeCliPath,
        scenarioPath,
        '--attempt-id',
        attemptId,
        '--project-root',
        projectRoot,
        '--temp-base',
        temporary,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );

    expect(result.status).toBe(0);
    expect(
      result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)),
    ).toEqual([
      {
        type: 'message_state',
        attemptId,
        message: { attemptId, sequence: 1, content: 'first', state: 'queued' },
      },
      {
        type: 'message_state',
        attemptId,
        message: { attemptId, sequence: 2, content: 'second', state: 'queued' },
      },
      {
        type: 'result',
        attemptId,
        output: { queuedMessages: 2 },
      },
    ]);
  });

  it('refuses a pre-existing hard-linked target that could write outside the supplied root', () => {
    const temporary = temporaryDirectory();
    const projectRoot = join(temporary, 'project');
    mkdirSync(projectRoot);
    const outside = join(temporary, 'outside.txt');
    const linked = join(projectRoot, 'linked.txt');
    writeFileSync(outside, 'outside original', 'utf8');
    linkSync(outside, linked);
    const attemptId = 'attempt-cli-hard-link';
    const scenarioPath = writeScenario(
      temporary,
      successfulStructuredScenario({
        attemptId,
        output: { unreachable: true },
        projectWrite: {
          relativePath: 'linked.txt',
          content: 'must not escape',
        },
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        fakeCliPath,
        scenarioPath,
        '--attempt-id',
        attemptId,
        '--project-root',
        projectRoot,
        '--temp-base',
        temporary,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/existing|linked|safe|project file/i);
    expect(readFileSync(outside, 'utf8')).toBe('outside original');
  });

  it.runIf(process.platform === 'win32')('rejects reserved Windows device names before writing', () => {
    const temporary = temporaryDirectory();
    const projectRoot = join(temporary, 'project');
    mkdirSync(projectRoot);
    const attemptId = 'attempt-cli-device-name';
    const scenarioPath = writeScenario(
      temporary,
      successfulStructuredScenario({
        attemptId,
        output: { unreachable: true },
        projectWrite: {
          relativePath: 'nested/NUL.txt',
          content: 'must not reach a device',
        },
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        fakeCliPath,
        scenarioPath,
        '--attempt-id',
        attemptId,
        '--project-root',
        projectRoot,
        '--temp-base',
        temporary,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/reserved Windows device/i);
  });

  it('rejects an existing non-temporary project outside the explicit trusted base', () => {
    const temporary = temporaryDirectory();
    const attemptId = 'attempt-cli-non-temp-root';
    const scenarioPath = writeScenario(
      temporary,
      successfulStructuredScenario({
        attemptId,
        output: { mustNotRun: true },
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        fakeCliPath,
        scenarioPath,
        '--attempt-id',
        attemptId,
        '--project-root',
        process.cwd(),
        '--temp-base',
        temporary,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/outside.*trusted temporary base|strict descendant/i);
    expect(result.stdout).toBe('');
  });

  it('rejects a temporary sibling and equality with the explicit trusted base', () => {
    const trustedBase = temporaryDirectory();
    const outsideBase = temporaryDirectory();
    const outsideProject = join(outsideBase, 'project');
    mkdirSync(outsideProject);
    const attemptId = 'attempt-cli-temp-boundary';
    const scenarioPath = writeScenario(
      trustedBase,
      successfulStructuredScenario({
        attemptId,
        output: { mustNotRun: true },
      }),
    );

    for (const projectRoot of [outsideProject, trustedBase]) {
      const result = spawnSync(
        process.execPath,
        [
          fakeCliPath,
          scenarioPath,
          '--attempt-id',
          attemptId,
          '--project-root',
          projectRoot,
          '--temp-base',
          trustedBase,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/outside.*trusted temporary base|strict descendant/i);
      expect(result.stdout).toBe('');
    }
  });

  it('rejects a symlink or junction alias even when its target is inside the trusted base', (context) => {
    const temporary = temporaryDirectory();
    const realProject = join(temporary, 'real-project');
    const aliasProject = join(temporary, 'alias-project');
    mkdirSync(realProject);
    try {
      symlinkSync(
        realProject,
        aliasProject,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        context.skip();
        return;
      }
      throw error;
    }
    const attemptId = 'attempt-cli-alias-root';
    const scenarioPath = writeScenario(
      temporary,
      successfulStructuredScenario({
        attemptId,
        output: { mustNotRun: true },
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        fakeCliPath,
        scenarioPath,
        '--attempt-id',
        attemptId,
        '--project-root',
        aliasProject,
        '--temp-base',
        temporary,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/alias|reparse|canonical/i);
    expect(result.stdout).toBe('');
  });
});
