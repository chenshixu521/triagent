import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

export type WindowsAgentCliName = 'codex' | 'claude' | 'grok';

export interface WindowsAgentExecutableRequest {
  readonly executable: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
}

export interface ResolvedWindowsAgentExecutable {
  readonly cliName: WindowsAgentCliName;
  readonly configuredExecutable: string;
  readonly resolvedPath: string;
  readonly source: 'native' | 'npm-shim-native';
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const direct = environment[name];
  if (direct !== undefined) return direct;
  const match = Object.entries(environment).find(
    ([key]) => key.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'),
  );
  return match?.[1];
}

function cliNameFromExecutable(executable: string): WindowsAgentCliName | undefined {
  const extension = extname(executable);
  const name = basename(executable, extension).toLocaleLowerCase('en-US');
  return name === 'codex' || name === 'claude' || name === 'grok'
    ? name
    : undefined;
}

function executableCandidates(
  executable: string,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
): readonly string[] {
  const hasDirectory = isAbsolute(executable) || /[\\/]/.test(executable);
  if (hasDirectory) {
    return [isAbsolute(executable) ? resolve(executable) : resolve(cwd, executable)];
  }
  const roots = (environmentValue(environment, 'PATH') ?? '')
    .split(delimiter)
    .map((part) => part.trim().replace(/^"|"$/g, ''))
    .filter((part) => part.length > 0);
  const extensions = extname(executable).length === 0
    ? (environmentValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    : [''];
  return roots.flatMap((root) =>
    extensions.map((extension) => resolve(root, `${executable}${extension}`))
  );
}

function comparisonPath(path: string): string {
  return path
    .replaceAll('/', '\\')
    .replace(/\\+$/, '')
    .toLocaleLowerCase('en-US');
}

function isSameOrChild(candidate: string, root: string): boolean {
  const candidateKey = comparisonPath(candidate);
  const rootKey = comparisonPath(root);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`);
}

function canonicalDirectory(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function requireRegularNonLinkFile(path: string, description: string): string {
  if (!existsSync(path)) {
    throw new Error(`${description} is missing: ${path}`);
  }
  const linkStatus = lstatSync(path);
  if (linkStatus.isSymbolicLink() || !linkStatus.isFile()) {
    throw new Error(`${description} must be a regular non-link file: ${path}`);
  }
  const canonical = realpathSync.native(path);
  if (!statSync(canonical).isFile()) {
    throw new Error(`${description} realpath is not a regular file: ${path}`);
  }
  return canonical;
}

function rejectProjectControlledPath(path: string, cwd: string): void {
  const projectRoot = canonicalDirectory(cwd);
  if (isSameOrChild(path, projectRoot)) {
    throw new Error(`agent CLI path is project-controlled and is not trusted: ${path}`);
  }
}

function requireContainedTarget(target: string, packageRoot: string): string {
  const canonicalRoot = canonicalDirectory(packageRoot);
  const canonicalTarget = requireRegularNonLinkFile(target, 'agent CLI native target');
  if (!isSameOrChild(canonicalTarget, canonicalRoot)) {
    throw new Error(
      `agent CLI native target escapes its package root: ${canonicalTarget}`,
    );
  }
  const relativeTarget = relative(canonicalRoot, canonicalTarget);
  if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    throw new Error(
      `agent CLI native target escapes its package root: ${canonicalTarget}`,
    );
  }
  return canonicalTarget;
}

function nativeTargetForShim(
  cliName: WindowsAgentCliName,
  shimPath: string,
): { readonly packageRoot: string; readonly target: string } {
  const npmBin = dirname(shimPath);
  if (cliName === 'codex') {
    const packageRoot = join(npmBin, 'node_modules', '@openai', 'codex');
    return {
      packageRoot,
      target: join(
        packageRoot,
        'node_modules',
        '@openai',
        'codex-win32-x64',
        'vendor',
        'x86_64-pc-windows-msvc',
        'bin',
        'codex.exe',
      ),
    };
  }
  if (cliName === 'claude') {
    const packageRoot = join(
      npmBin,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
    );
    return {
      packageRoot,
      target: join(packageRoot, 'bin', 'claude.exe'),
    };
  }
  throw new Error('Grok npm command wrappers are not supported; configure grok.exe');
}

/**
 * Resolve the three supported Agent CLIs to a native Windows executable.
 *
 * Bare commands are searched only through PATH/PATHEXT; the project cwd is
 * never searched. Codex/Claude npm `.cmd` shims are not executed. They are
 * mapped to the package-owned native `.exe`, with realpath containment checks.
 * Returns undefined for non-Windows or unrelated executables.
 */
export function resolveWindowsAgentExecutable(
  request: WindowsAgentExecutableRequest,
): ResolvedWindowsAgentExecutable | undefined {
  const platform = request.platform ?? process.platform;
  const configuredExecutable = request.executable.trim();
  if (platform !== 'win32' || configuredExecutable.length === 0) return undefined;
  const cliName = cliNameFromExecutable(configuredExecutable);
  if (cliName === undefined) return undefined;

  const environment = request.environment ?? process.env;
  const cwd = request.cwd ?? process.cwd();
  const candidate = executableCandidates(
    configuredExecutable,
    environment,
    cwd,
  ).find((path) => existsSync(path));
  if (candidate === undefined) {
    throw new Error(`cannot resolve ${cliName} executable: ${configuredExecutable}`);
  }

  const canonicalCandidate = requireRegularNonLinkFile(
    candidate,
    `${cliName} executable`,
  );
  rejectProjectControlledPath(canonicalCandidate, cwd);
  const extension = extname(canonicalCandidate).toLocaleLowerCase('en-US');
  if (extension === '.exe') {
    return Object.freeze({
      cliName,
      configuredExecutable,
      resolvedPath: canonicalCandidate,
      source: 'native',
    });
  }
  if (extension !== '.cmd') {
    throw new Error(
      `${cliName} executable must be a native .exe or a supported npm .cmd shim`,
    );
  }

  const native = nativeTargetForShim(cliName, canonicalCandidate);
  const resolvedPath = requireContainedTarget(native.target, native.packageRoot);
  rejectProjectControlledPath(resolvedPath, cwd);
  return Object.freeze({
    cliName,
    configuredExecutable,
    resolvedPath,
    source: 'npm-shim-native',
  });
}
