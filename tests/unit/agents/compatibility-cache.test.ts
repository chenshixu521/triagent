import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveExecutableIdentity } from '../../../src/agents/compatibility-cache.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-agent-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFixture(path: string, contents = 'fixture'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function windowsEnvironment(path: string): Readonly<Record<string, string>> {
  return {
    PATH: path,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };
}

describe('Windows agent CLI executable identity', () => {
  it('binds Codex npm shim identity to the package-native codex.exe', async () => {
    const root = temporaryDirectory();
    const npmBin = join(root, 'npm');
    const project = join(root, 'project');
    const shim = join(npmBin, 'codex.cmd');
    const native = join(
      npmBin,
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    );
    writeFixture(shim, '@echo off\r\nnode codex.js %*\r\n');
    writeFixture(native, 'codex-native');
    mkdirSync(project, { recursive: true });

    const identity = await resolveExecutableIdentity({
      executable: 'codex',
      environment: windowsEnvironment(npmBin),
      cwd: project,
      platform: 'win32',
    });

    expect(identity.configuredExecutable).toBe('codex');
    expect(identity.resolvedPath).toBe(realpathSync.native(native));
  });

  it('binds Claude npm shim identity to the package-native claude.exe', async () => {
    const root = temporaryDirectory();
    const npmBin = join(root, 'npm');
    const project = join(root, 'project');
    const shim = join(npmBin, 'claude.cmd');
    const native = join(
      npmBin,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    writeFixture(shim, '@echo off\r\nclaude.exe %*\r\n');
    writeFixture(native, 'claude-native');
    mkdirSync(project, { recursive: true });

    const identity = await resolveExecutableIdentity({
      executable: 'claude',
      environment: windowsEnvironment(npmBin),
      cwd: project,
      platform: 'win32',
    });

    expect(identity.configuredExecutable).toBe('claude');
    expect(identity.resolvedPath).toBe(realpathSync.native(native));
  });

  it('rejects a project-controlled npm shim even when it mimics the package layout', async () => {
    const root = temporaryDirectory();
    const project = join(root, 'project');
    const shim = join(project, 'codex.cmd');
    const native = join(
      project,
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    );
    writeFixture(shim, '@echo off\r\n');
    writeFixture(native, 'forged-native');

    await expect(resolveExecutableIdentity({
      executable: 'codex',
      environment: windowsEnvironment(project),
      cwd: project,
      platform: 'win32',
    })).rejects.toThrow(/project|trusted|shim/i);
  });

  it('rejects an npm shim when its expected package-native target is missing', async () => {
    const root = temporaryDirectory();
    const npmBin = join(root, 'npm');
    const project = join(root, 'project');
    writeFixture(join(npmBin, 'claude.cmd'), '@echo off\r\n');
    mkdirSync(project, { recursive: true });

    await expect(resolveExecutableIdentity({
      executable: 'claude',
      environment: windowsEnvironment(npmBin),
      cwd: project,
      platform: 'win32',
    })).rejects.toThrow(/native|target|claude\.exe/i);
  });
});
