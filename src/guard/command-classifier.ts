import * as path from 'node:path';

export type CommandClassification =
  | 'auto_allowed'
  | 'requires_confirmation'
  | 'denied';

export interface CommandStructuralFlags {
  readonly normalizedExecutable: string;
  readonly isShell: boolean;
  readonly isPowerShell: boolean;
  readonly isCmd: boolean;
  readonly isEvalLike: boolean;
  readonly isVerification: boolean;
  readonly isDependencyInstall: boolean;
  readonly isPackageLifecycle: boolean;
  readonly isDestructiveGit: boolean;
  readonly isNetwork: boolean;
  readonly isPrivilegeEscalation: boolean;
  readonly isUnknown: boolean;
}

export interface ClassifiedCommand {
  readonly classification: CommandClassification;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly structural: CommandStructuralFlags;
  readonly reason: string;
  /** Path-bearing arguments derived strictly from argv (never caller-supplied). */
  readonly derivedPathArguments: readonly string[];
}

export interface ClassifyCommandInput {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

const VERIFICATION_NPM_SCRIPTS = new Set([
  'test',
  'typecheck',
  'lint',
  'build',
  'check',
]);

const PACKAGE_LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'prepack',
  'postpack',
  'preversion',
  'postversion',
  'dependencies',
]);

const SHELL_EXECUTABLES = new Set([
  'bash',
  'bash.exe',
  'sh',
  'sh.exe',
  'zsh',
  'zsh.exe',
  'fish',
  'fish.exe',
  'dash',
  'dash.exe',
]);

const POWERSHELL_EXECUTABLES = new Set([
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

const CMD_EXECUTABLES = new Set(['cmd', 'cmd.exe']);

const NETWORK_EXECUTABLES = new Set([
  'curl',
  'curl.exe',
  'wget',
  'wget.exe',
  'ssh',
  'ssh.exe',
  'scp',
  'scp.exe',
  'sftp',
  'sftp.exe',
  'ftp',
  'ftp.exe',
  'nc',
  'nc.exe',
  'ncat',
  'ncat.exe',
]);

const PRIVILEGE_EXECUTABLES = new Set([
  'sudo',
  'sudo.exe',
  'runas',
  'runas.exe',
  'doas',
  'doas.exe',
  'gsudo',
  'gsudo.exe',
]);

const TRUSTED_VERIFICATION_EXECUTABLES = new Set([
  'npm',
  'npm.cmd',
  'npm.exe',
  'pnpm',
  'pnpm.cmd',
  'pnpm.exe',
  'yarn',
  'yarn.cmd',
  'yarn.exe',
  'bun',
  'bun.exe',
  'node',
  'node.exe',
  'tsc',
  'tsc.exe',
  'tsc.cmd',
  'git',
  'git.exe',
]);

/** npx can download and execute remote packages — never auto_allowed. */
const NPX_EXECUTABLES = new Set(['npx', 'npx.cmd', 'npx.exe']);

const PACKAGE_MANAGERS = new Set([
  'npm',
  'npm.cmd',
  'npm.exe',
  'npx',
  'npx.cmd',
  'npx.exe',
  'pnpm',
  'pnpm.cmd',
  'pnpm.exe',
  'yarn',
  'yarn.cmd',
  'yarn.exe',
  'bun',
  'bun.exe',
  'pip',
  'pip.exe',
  'pip3',
  'pip3.exe',
  'poetry',
  'poetry.exe',
  'cargo',
  'cargo.exe',
]);

function baseName(executable: string): string {
  const trimmed = executable.trim();
  const leaf = path.basename(trimmed.replaceAll('/', path.sep));
  return leaf.toLocaleLowerCase('en-US');
}

function argvLower(argv: readonly string[]): readonly string[] {
  return argv.map((entry) => entry.toLocaleLowerCase('en-US'));
}

function isAbsoluteOrOutsideLookingPath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes('\0')) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith('\\\\') || value.startsWith('//')) return true;
  if (value.startsWith('/') || value.startsWith('\\')) return true;
  if (value.split(/[\\/]/).some((part) => part === '..')) return true;
  return false;
}

function isDestructiveGit(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const [head, ...rest] = argvLower(argv);
  if (head === 'clean') return true;
  if (head === 'reset') {
    return rest.some((entry) => entry === '--hard' || entry === '--merge');
  }
  if (head === 'checkout' || head === 'restore' || head === 'switch') {
    return true;
  }
  if (head === 'push') {
    return rest.some(
      (entry) =>
        entry === '--force' ||
        entry === '-f' ||
        entry.startsWith('--force-with-lease'),
    );
  }
  if (head === 'branch') {
    return rest.some((entry) => entry === '-d' || entry === '-D' || entry === '--delete');
  }
  if (head === 'stash' && rest[0] === 'drop') return true;
  if (head === 'filter-branch' || head === 'filter-repo') return true;
  return false;
}

/**
 * Derive path-bearing arguments from git argv. Output flags are never auto-allow safe.
 */
function deriveGitPathArguments(argv: readonly string[]): {
  readonly paths: string[];
  readonly hasOutputFlag: boolean;
  readonly hasUnsafeFlag: boolean;
} {
  const paths: string[] = [];
  let hasOutputFlag = false;
  let hasUnsafeFlag = false;
  const lower = argvLower(argv);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    const token = lower[i]!;
    if (token === '--output' || token === '-o') {
      hasOutputFlag = true;
      hasUnsafeFlag = true;
      if (i + 1 < argv.length) {
        paths.push(argv[i + 1]!);
        i += 1;
      }
      continue;
    }
    if (token.startsWith('--output=')) {
      hasOutputFlag = true;
      hasUnsafeFlag = true;
      paths.push(raw.slice(raw.indexOf('=') + 1));
      continue;
    }
    if (
      token === '--no-index' ||
      token === '--ext-diff' ||
      token.startsWith('--output-indicator-')
    ) {
      hasUnsafeFlag = true;
    }
  }
  return { paths, hasOutputFlag, hasUnsafeFlag };
}

function isSafeGitRead(argv: readonly string[]): {
  readonly ok: boolean;
  readonly reason?: string;
  readonly paths: readonly string[];
} {
  if (argv.length === 0) return { ok: false, paths: [] };
  const [head] = argvLower(argv);
  const derived = deriveGitPathArguments(argv);
  if (derived.hasOutputFlag || derived.hasUnsafeFlag) {
    return {
      ok: false,
      reason: 'git output or unsafe path-bearing flag is not auto-allowed',
      paths: derived.paths,
    };
  }
  if (head === 'status') return { ok: true, paths: derived.paths };
  if (head === 'diff') {
    // Only pure read forms; any path-bearing output already rejected above.
    return { ok: true, paths: derived.paths };
  }
  if (head === 'log' || head === 'show' || head === 'rev-parse' || head === 'describe') {
    return { ok: true, paths: derived.paths };
  }
  return { ok: false, paths: derived.paths };
}

function isNpmInstall(argv: readonly string[]): boolean {
  const lower = argvLower(argv);
  if (lower.length === 0) return false;
  const head = lower[0]!;
  return (
    head === 'install' ||
    head === 'i' ||
    head === 'ci' ||
    head === 'add' ||
    head === 'uninstall' ||
    head === 'update' ||
    head === 'upgrade'
  );
}

function npmScriptName(argv: readonly string[]): string | null {
  const lower = argvLower(argv);
  if (lower[0] === 'run' && typeof lower[1] === 'string') return lower[1];
  if (
    lower[0] === 'test' ||
    lower[0] === 'start' ||
    lower[0] === 'stop' ||
    lower[0] === 'restart'
  ) {
    return lower[0]!;
  }
  return null;
}

function isEvalLike(executable: string, argv: readonly string[]): boolean {
  const name = baseName(executable);
  const lower = argvLower(argv);
  if (name === 'node' || name === 'node.exe') {
    return lower.some(
      (entry) =>
        entry === '-e' ||
        entry === '--eval' ||
        entry === '--print' ||
        entry === '-p',
    );
  }
  if (POWERSHELL_EXECUTABLES.has(name)) {
    return lower.some(
      (entry) =>
        entry === '-command' ||
        entry === '-c' ||
        entry === '-encodedcommand' ||
        entry === '-file',
    );
  }
  if (CMD_EXECUTABLES.has(name)) {
    return lower.some((entry) => entry === '/c' || entry === '/k' || entry === '/r');
  }
  if (SHELL_EXECUTABLES.has(name)) {
    return lower.some((entry) => entry === '-c' || entry === '-lc' || entry === '--command');
  }
  return false;
}

function isPrivilegeEscalation(executable: string, argv: readonly string[]): boolean {
  const name = baseName(executable);
  if (PRIVILEGE_EXECUTABLES.has(name)) return true;
  const lower = argvLower(argv);
  if (POWERSHELL_EXECUTABLES.has(name)) {
    if (lower.includes('runas') || lower.includes('-verb')) return true;
    const joined = lower.join(' ');
    if (joined.includes('start-process') && joined.includes('runas')) return true;
  }
  return false;
}

/**
 * Derive path-bearing args for node --test forms.
 * Any absolute/outside-looking script path is recorded for guard evaluation.
 */
function deriveNodeTestPaths(argv: readonly string[]): {
  readonly paths: string[];
  readonly hasOutside: boolean;
  readonly unknownFlags: boolean;
} {
  const lower = argvLower(argv);
  const paths: string[] = [];
  let unknownFlags = false;
  if (lower[0] !== '--test') {
    return { paths, hasOutside: false, unknownFlags: true };
  }
  for (let i = 1; i < argv.length; i += 1) {
    const raw = argv[i]!;
    const token = lower[i]!;
    if (token.startsWith('-')) {
      // Allow only a small set of node --test read-only flags.
      if (
        token === '--test-name-pattern' ||
        token === '--test-reporter' ||
        token === '--experimental-test-coverage'
      ) {
        if (
          (token === '--test-name-pattern' || token === '--test-reporter') &&
          i + 1 < argv.length
        ) {
          i += 1;
        }
        continue;
      }
      if (token.startsWith('--test-name-pattern=') || token.startsWith('--test-reporter=')) {
        continue;
      }
      unknownFlags = true;
      continue;
    }
    paths.push(raw);
  }
  const hasOutside = paths.some((entry) => isAbsoluteOrOutsideLookingPath(entry));
  return { paths, hasOutside, unknownFlags };
}

function deriveTscPaths(argv: readonly string[]): {
  readonly paths: string[];
  readonly hasOutside: boolean;
  readonly hasUnsafe: boolean;
} {
  const paths: string[] = [];
  let hasUnsafe = false;
  const lower = argvLower(argv);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    const token = lower[i]!;
    if (token === '-p' || token === '--project' || token === '--outDir'.toLowerCase() || token === '--out') {
      hasUnsafe = token === '--outdir' || token === '--out';
      if (i + 1 < argv.length) {
        paths.push(argv[i + 1]!);
        i += 1;
      }
      continue;
    }
    if (token.startsWith('--project=')) {
      paths.push(raw.slice(raw.indexOf('=') + 1));
      continue;
    }
    if (
      token === '--outDir'.toLowerCase() ||
      token.startsWith('--outdir=') ||
      token === '--out' ||
      token.startsWith('--out=') ||
      token === '--declarationDir'.toLowerCase() ||
      token.startsWith('--declarationdir=')
    ) {
      hasUnsafe = true;
      if (token.includes('=')) {
        paths.push(raw.slice(raw.indexOf('=') + 1));
      } else if (i + 1 < argv.length) {
        paths.push(argv[i + 1]!);
        i += 1;
      }
      continue;
    }
    if (!token.startsWith('-') && token !== '--noemit') {
      // Positional file paths.
      paths.push(raw);
    }
  }
  // Re-scan with case-preserved raw tokens for --noEmit already handled by caller.
  const hasOutside = paths.some((entry) => isAbsoluteOrOutsideLookingPath(entry));
  return { paths, hasOutside, hasUnsafe };
}

export class CommandClassifier {
  public classify(input: ClassifyCommandInput): ClassifiedCommand {
    const executable = input.executable.trim();
    const argv = [...input.argv];
    const cwd = input.cwd;
    const normalizedExecutable = baseName(executable);

    const isPowerShell = POWERSHELL_EXECUTABLES.has(normalizedExecutable);
    const isCmd = CMD_EXECUTABLES.has(normalizedExecutable);
    const isShell =
      SHELL_EXECUTABLES.has(normalizedExecutable) || isPowerShell || isCmd;
    const evalLike = isEvalLike(executable, argv);
    const privilege = isPrivilegeEscalation(executable, argv);
    const network = NETWORK_EXECUTABLES.has(normalizedExecutable);
    const packageManager = PACKAGE_MANAGERS.has(normalizedExecutable);
    const isGit =
      normalizedExecutable === 'git' || normalizedExecutable === 'git.exe';
    const isNpx = NPX_EXECUTABLES.has(normalizedExecutable);

    let isDependencyInstall = false;
    let isPackageLifecycle = false;
    let isVerification = false;
    let isDestructive = false;
    let isUnknown = false;
    let derivedPathArguments: string[] = [];

    if (privilege) {
      return finish(
        'denied',
        'privilege escalation constructs are denied',
        true,
      );
    }

    // Shell forms never auto-allow.
    if (isShell || evalLike) {
      return finish(
        'requires_confirmation',
        'shell, PowerShell, cmd, or eval-like construct requires confirmation',
        false,
      );
    }

    if (network) {
      return finish(
        'requires_confirmation',
        'network command requires confirmation',
        false,
      );
    }

    // npx can download/execute — never auto_allowed regardless of argv.
    if (isNpx) {
      return finish(
        'requires_confirmation',
        'npx can download and execute packages; never auto-allowed',
        false,
      );
    }

    if (isGit) {
      isDestructive = isDestructiveGit(argv);
      if (isDestructive) {
        return finish('denied', 'destructive Git command is denied', false);
      }
      const safe = isSafeGitRead(argv);
      derivedPathArguments = [...safe.paths];
      if (safe.ok) {
        // Outside-looking output paths already blocked; remaining path args still require
        // project-guard path evaluation when present.
        if (derivedPathArguments.some((entry) => isAbsoluteOrOutsideLookingPath(entry))) {
          return finish(
            'requires_confirmation',
            'git path-bearing argument is outside-looking or untrusted',
            false,
          );
        }
        isVerification = true;
        return finish(
          'auto_allowed',
          'allowlisted read-only Git verification command',
          false,
        );
      }
      if (safe.reason !== undefined) {
        return finish('requires_confirmation', safe.reason, false);
      }
      return finish(
        'requires_confirmation',
        'non-allowlisted Git command requires confirmation',
        false,
      );
    }

    if (packageManager) {
      if (
        normalizedExecutable.startsWith('npm') ||
        normalizedExecutable.startsWith('pnpm') ||
        normalizedExecutable.startsWith('yarn') ||
        normalizedExecutable.startsWith('bun')
      ) {
        if (isNpmInstall(argv)) {
          isDependencyInstall = true;
          return finish(
            'requires_confirmation',
            'dependency installation requires confirmation',
            false,
          );
        }
        const script = npmScriptName(argv);
        if (script !== null && PACKAGE_LIFECYCLE_SCRIPTS.has(script)) {
          isPackageLifecycle = true;
          return finish(
            'requires_confirmation',
            'package lifecycle script requires confirmation',
            false,
          );
        }
        if (script !== null && VERIFICATION_NPM_SCRIPTS.has(script)) {
          if (!TRUSTED_VERIFICATION_EXECUTABLES.has(normalizedExecutable)) {
            return finish(
              'requires_confirmation',
              'unknown package-manager provenance is never auto-allowed',
              false,
            );
          }
          isVerification = true;
          return finish(
            'auto_allowed',
            'allowlisted package-manager verification command',
            false,
          );
        }
        return finish(
          'requires_confirmation',
          'package-manager command is not on the verification allowlist',
          false,
        );
      }

      if (
        normalizedExecutable.startsWith('pip') ||
        normalizedExecutable.startsWith('poetry') ||
        normalizedExecutable.startsWith('cargo')
      ) {
        const lower = argvLower(argv);
        if (lower[0] === 'install' || lower[0] === 'add' || lower[0] === 'uninstall') {
          isDependencyInstall = true;
          return finish(
            'requires_confirmation',
            'dependency installation requires confirmation',
            false,
          );
        }
        return finish(
          'requires_confirmation',
          'package-manager command requires confirmation',
          false,
        );
      }
    }

    if (normalizedExecutable === 'node' || normalizedExecutable === 'node.exe') {
      const lower = argvLower(argv);
      if (lower[0] === '--test') {
        const derived = deriveNodeTestPaths(argv);
        derivedPathArguments = derived.paths;
        if (derived.unknownFlags) {
          return finish(
            'requires_confirmation',
            'node --test unknown flags require confirmation',
            false,
          );
        }
        if (derived.hasOutside) {
          return finish(
            'requires_confirmation',
            'node --test outside or absolute script path is not auto-allowed',
            false,
          );
        }
        isVerification = true;
        return finish(
          'auto_allowed',
          'allowlisted node test runner verification command',
          false,
        );
      }
    }

    if (
      normalizedExecutable === 'tsc' ||
      normalizedExecutable === 'tsc.exe' ||
      normalizedExecutable === 'tsc.cmd'
    ) {
      const lower = argvLower(argv);
      if (!lower.includes('--noemit')) {
        return finish(
          'requires_confirmation',
          'tsc without --noEmit is not a proven read-only verification command',
          false,
        );
      }
      const derived = deriveTscPaths(argv);
      derivedPathArguments = derived.paths;
      if (derived.hasUnsafe) {
        return finish(
          'requires_confirmation',
          'tsc emit/output flags are not auto-allowed',
          false,
        );
      }
      if (derived.hasOutside) {
        return finish(
          'requires_confirmation',
          'tsc project/config/script path is outside-looking and not auto-allowed',
          false,
        );
      }
      // Reject unknown flags that are not on a small read-only set.
      for (const token of lower) {
        if (!token.startsWith('-')) continue;
        if (
          token === '--noemit' ||
          token === '-p' ||
          token === '--project' ||
          token.startsWith('--project=') ||
          token === '--pretty' ||
          token === '--pretty=true' ||
          token === '--pretty=false' ||
          token === '--incremental' ||
          token === '--incremental=false' ||
          token === '--strict' ||
          token === '--skipLibCheck'.toLowerCase()
        ) {
          continue;
        }
        // Unknown flag — fail closed for auto-allow.
        return finish(
          'requires_confirmation',
          'tsc unknown or untrusted flags require confirmation',
          false,
        );
      }
      isVerification = true;
      return finish(
        'auto_allowed',
        'allowlisted typecheck verification command',
        false,
      );
    }

    // Unknown executable provenance is never auto_allowed.
    isUnknown = true;
    return finish(
      'requires_confirmation',
      'unknown or unprovable command requires confirmation',
      false,
    );

    function finish(
      classification: CommandClassification,
      reason: string,
      privilegeFlag: boolean,
    ): ClassifiedCommand {
      return {
        classification,
        executable,
        argv,
        cwd,
        derivedPathArguments,
        structural: {
          normalizedExecutable,
          isShell,
          isPowerShell,
          isCmd,
          isEvalLike: evalLike,
          isVerification,
          isDependencyInstall,
          isPackageLifecycle,
          isDestructiveGit: isDestructive,
          isNetwork: network,
          isPrivilegeEscalation: privilegeFlag || privilege,
          isUnknown,
        },
        reason,
      };
    }
  }
}
