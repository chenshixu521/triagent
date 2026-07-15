import { describe, expect, it } from 'vitest';

import {
  CommandClassifier,
  type ClassifiedCommand,
} from '../../../src/guard/command-classifier.js';

function classify(
  executable: string,
  argv: readonly string[],
  cwd = 'D:\\project',
): ClassifiedCommand {
  return new CommandClassifier().classify({
    executable,
    argv,
    cwd,
  });
}

describe('CommandClassifier structural policy', () => {
  it('auto-allows a small allowlist of proven verification commands', () => {
    for (const command of [
      { executable: 'npm.cmd', argv: ['test'] },
      { executable: 'npm.cmd', argv: ['run', 'test'] },
      { executable: 'npm.cmd', argv: ['run', 'typecheck'] },
      { executable: 'tsc.cmd', argv: ['--noEmit'] },
      { executable: 'node.exe', argv: ['--test', 'tests/example.test.js'] },
      { executable: 'git.exe', argv: ['status', '--porcelain=v2'] },
      { executable: 'git.exe', argv: ['diff', '--stat'] },
    ] as const) {
      const result = classify(command.executable, command.argv);
      expect(result.classification, JSON.stringify(command)).toBe('auto_allowed');
      expect(result.structural.isVerification).toBe(true);
      expect(result.structural.isShell).toBe(false);
    }
  });

  it('never auto-allows git diff --output escapes that write outside the project', () => {
    const result = classify('git.exe', [
      'diff',
      '--output=C:\\Temp\\escaped.txt',
    ]);
    expect(result.classification).not.toBe('auto_allowed');
    expect(['requires_confirmation', 'denied']).toContain(result.classification);
    expect(result.reason).toMatch(/output|path|escape|flag|confirmation|denied/i);
  });

  it('never auto-allows node --test with an outside script path', () => {
    const result = classify('node.exe', ['--test', 'C:\\Temp\\evil.js']);
    expect(result.classification).not.toBe('auto_allowed');
    expect(['requires_confirmation', 'denied']).toContain(result.classification);
  });

  it('never auto-allows npx because it can download and execute packages', () => {
    const result = classify('npx.cmd', ['tsc', '--noEmit']);
    expect(result.classification).not.toBe('auto_allowed');
    expect(['requires_confirmation', 'denied']).toContain(result.classification);
    expect(result.reason).toMatch(/npx|download|network|install|confirmation|untrusted/i);
  });

  it('derives path-bearing arguments from argv and rejects unknown provenance auto-allow', () => {
    const withOutput = classify('git.exe', ['diff', '--output', 'C:\\Temp\\out.txt']);
    expect(withOutput.classification).not.toBe('auto_allowed');
    expect(withOutput.structural.isVerification).toBe(false);

    const withOutsideConfig = classify('tsc.cmd', [
      '--noEmit',
      '-p',
      'C:\\Temp\\evil-tsconfig.json',
    ]);
    expect(withOutsideConfig.classification).not.toBe('auto_allowed');
  });

  it('classifies shells and PowerShell/cmd constructs as requiring confirmation', () => {
    const cases = [
      { executable: 'powershell.exe', argv: ['-Command', 'Get-ChildItem'] },
      { executable: 'pwsh.exe', argv: ['-c', 'dir'] },
      { executable: 'cmd.exe', argv: ['/c', 'dir'] },
      { executable: 'bash.exe', argv: ['-lc', 'ls'] },
      { executable: 'sh', argv: ['-c', 'ls'] },
      { executable: 'node.exe', argv: ['-e', 'console.log(1)'] },
    ] as const;
    for (const command of cases) {
      const result = classify(command.executable, command.argv);
      expect(result.classification, JSON.stringify(command)).toBe('requires_confirmation');
      expect(
        result.structural.isShell ||
          result.structural.isPowerShell ||
          result.structural.isCmd ||
          result.structural.isEvalLike,
      ).toBe(true);
    }
  });

  it('requires confirmation for dependency install and package lifecycle scripts', () => {
    for (const command of [
      { executable: 'npm.cmd', argv: ['install'] },
      { executable: 'npm.cmd', argv: ['ci'] },
      { executable: 'npm.cmd', argv: ['install', 'lodash'] },
      { executable: 'npm.cmd', argv: ['run', 'prepare'] },
      { executable: 'npm.cmd', argv: ['run', 'preinstall'] },
      { executable: 'pnpm.cmd', argv: ['install'] },
      { executable: 'yarn.cmd', argv: ['add', 'react'] },
      { executable: 'pip.exe', argv: ['install', 'requests'] },
    ] as const) {
      const result = classify(command.executable, command.argv);
      expect(result.classification, JSON.stringify(command)).toBe('requires_confirmation');
      expect(result.structural.isPackageLifecycle || result.structural.isDependencyInstall).toBe(
        true,
      );
    }
  });

  it('denies destructive Git commands', () => {
    for (const argv of [
      ['clean', '-fdx'],
      ['reset', '--hard', 'HEAD'],
      ['checkout', '--', '.'],
      ['push', '--force'],
      ['branch', '-D', 'main'],
      ['restore', '--source=HEAD', '--worktree', '--', '.'],
    ] as const) {
      const result = classify('git.exe', argv);
      expect(result.classification, argv.join(' ')).toBe('denied');
      expect(result.structural.isDestructiveGit).toBe(true);
    }
  });

  it('requires confirmation for network and unknown commands', () => {
    expect(classify('curl.exe', ['https://example.com']).classification).toBe(
      'requires_confirmation',
    );
    expect(classify('wget.exe', ['https://example.com']).classification).toBe(
      'requires_confirmation',
    );
    expect(classify('ssh.exe', ['host']).classification).toBe('requires_confirmation');
    expect(classify('mystery-tool.exe', ['do-stuff']).classification).toBe(
      'requires_confirmation',
    );
    expect(classify('mystery-tool.exe', ['do-stuff']).structural.isUnknown).toBe(true);
  });

  it('denies privilege-escalation constructs', () => {
    for (const command of [
      { executable: 'sudo', argv: ['npm', 'test'] },
      { executable: 'runas.exe', argv: ['/user:Administrator', 'cmd'] },
      { executable: 'powershell.exe', argv: ['Start-Process', '-Verb', 'RunAs'] },
    ] as const) {
      const result = classify(command.executable, command.argv);
      expect(result.classification, JSON.stringify(command)).toBe('denied');
      expect(result.structural.isPrivilegeEscalation).toBe(true);
    }
  });

  it('structurally records executable, argv, and cwd without shell interpretation', () => {
    const result = classify('npm.cmd', ['test', '--', 'guard'], 'D:\\repo\\app');
    expect(result.executable.toLowerCase()).toContain('npm');
    expect(result.argv).toEqual(['test', '--', 'guard']);
    expect(result.cwd).toBe('D:\\repo\\app');
    expect(result.structural.normalizedExecutable).toMatch(/npm/i);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('does not auto-allow shell wrappers around otherwise safe verification commands', () => {
    const result = classify('cmd.exe', ['/c', 'npm test']);
    expect(result.classification).toBe('requires_confirmation');
    expect(result.structural.isShell || result.structural.isCmd).toBe(true);
  });

  it('never claims an OS sandbox in classification reasons', () => {
    const result = classify('npm.cmd', ['test']);
    expect(result.reason).not.toMatch(/os sandbox|operating system sandbox/i);
  });
});
