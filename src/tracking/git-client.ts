import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export type GitReadCommand =
  | 'rev-parse'
  | 'status'
  | 'diff'
  | 'ls-files'
  | 'check-ignore';

export interface GitCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  readonly windowsHide: true;
}

export interface GitCommandResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: Error & { readonly code?: string };
}

export type GitCommandRunner = (request: GitCommandRequest) => GitCommandResult;

export interface GitClientOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly runner?: GitCommandRunner;
}

export interface GitRepositoryIdentity {
  readonly canonicalRoot: string;
  readonly headSha: string;
  readonly branch: string | null;
  readonly detached: boolean;
}

export interface GitStatusEntry {
  readonly recordType: 'ordinary' | 'renamed-or-copied' | 'unmerged' | 'untracked' | 'ignored';
  readonly xy?: string;
  readonly path: string;
  readonly originalPath?: string;
  readonly raw: string;
}

export interface GitStatusSnapshot {
  readonly raw: string;
  readonly entries: readonly GitStatusEntry[];
}

export class GitClientError extends Error {
  public override readonly name = 'GitClientError';

  public constructor(message: string, options?: ErrorOptions) {
    super(`GitClientError: ${message}`, options);
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

function defaultRunner(request: GitCommandRequest): GitCommandResult {
  const result = spawnSync(request.executable, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    encoding: null,
    maxBuffer: request.maxBuffer,
    timeout: request.timeoutMs,
    windowsHide: request.windowsHide,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    error: result.error,
  };
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase().startsWith('GIT_')) delete environment[name];
  }
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_CONFIG_NOSYSTEM = '1';
  return environment;
}

function decode(buffer: Buffer, label: string): string {
  const value = buffer.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(buffer)) {
    throw new GitClientError(`${label} was not valid UTF-8`);
  }
  return value;
}

function identityLines(buffer: Buffer): readonly [string, string, string] {
  const value = decode(buffer, 'repository identity');
  const lines = value.replace(/\r?\n$/, '').split(/\r?\n/);
  if (lines.length !== 3 || lines.some((line) => line.length === 0)) {
    throw new GitClientError('malformed repository identity: expected exactly three non-empty lines');
  }
  return [lines[0]!, lines[1]!, lines[2]!];
}

function normalizeComparison(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function normalizeGitRelativePath(value: string): string {
  const path = value.replaceAll('\\', '/');
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new GitClientError(`unsafe Git relative path: ${JSON.stringify(value)}`);
  }
  return path;
}

function parseNulPaths(buffer: Buffer, label: string): readonly string[] {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) throw new GitClientError(`${label} was not NUL terminated`);
  return decode(buffer.subarray(0, -1), label)
    .split('\0')
    .map(normalizeGitRelativePath);
}

function parseStatus(buffer: Buffer): GitStatusSnapshot {
  if (buffer.length === 0) return { raw: '', entries: [] };
  if (buffer.at(-1) !== 0) throw new GitClientError('status output was not NUL terminated');
  const raw = decode(buffer, 'status output');
  const records = raw.slice(0, -1).split('\0');
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const prefix = record.slice(0, 2);
    if (prefix === '? ' || prefix === '! ') {
      entries.push({
        recordType: prefix === '? ' ? 'untracked' : 'ignored',
        path: normalizeGitRelativePath(record.slice(2)),
        raw: record,
      });
      continue;
    }
    const fields = record.split(' ');
    if (fields[0] === '1' && fields.length >= 9) {
      entries.push({
        recordType: 'ordinary',
        xy: fields[1],
        path: normalizeGitRelativePath(fields.slice(8).join(' ')),
        raw: record,
      });
      continue;
    }
    if (fields[0] === '2' && fields.length >= 10) {
      const originalPath = records[index + 1];
      if (originalPath === undefined) {
        throw new GitClientError('rename status record was missing its original path');
      }
      index += 1;
      entries.push({
        recordType: 'renamed-or-copied',
        xy: fields[1],
        path: normalizeGitRelativePath(fields.slice(9).join(' ')),
        originalPath: normalizeGitRelativePath(originalPath),
        raw: record,
      });
      continue;
    }
    if (fields[0] === 'u' && fields.length >= 11) {
      entries.push({
        recordType: 'unmerged',
        xy: fields[1],
        path: normalizeGitRelativePath(fields.slice(10).join(' ')),
        raw: record,
      });
      continue;
    }
    throw new GitClientError(`malformed porcelain v2 status record: ${record}`);
  }
  return { raw, entries };
}

function isAllowedArguments(command: GitReadCommand, args: readonly string[]): boolean {
  const signature = args.join('\0');
  if (command === 'rev-parse') {
    return new Set([
      '--show-toplevel',
      '--verify\0HEAD',
      '--abbrev-ref\0HEAD',
      '--show-toplevel\0HEAD\0--abbrev-ref\0HEAD',
    ]).has(signature);
  }
  if (command === 'status') return signature === '--porcelain=v2\0-z\0--untracked-files=all';
  if (command === 'ls-files') {
    return new Set([
      '-z\0--cached\0--others\0--exclude-standard\0--',
      '-z\0--cached\0--',
    ]).has(signature);
  }
  if (command === 'check-ignore') {
    return args.length >= 3 && args[0] === '-z' && args[1] === '--';
  }
  if (command === 'diff') {
    if (signature === '--binary\0--no-ext-diff\0--no-textconv\0HEAD\0--') return true;
    return (
      args.length === 7 &&
      args[0] === '--binary' &&
      args[1] === '--no-ext-diff' &&
      args[2] === '--no-textconv' &&
      args[3] === '--no-index' &&
      args[4] === '--' &&
      (args[5] === '/dev/null' || isAbsolute(args[5]!)) &&
      (args[6] === '/dev/null' || isAbsolute(args[6]!))
    );
  }
  return false;
}

export class GitClient {
  readonly #projectRoot: string;
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #maxBuffer: number;
  readonly #runner: GitCommandRunner;

  public constructor(projectRoot: string, options: GitClientOptions = {}) {
    if (!isAbsolute(projectRoot)) {
      throw new GitClientError('project root must be absolute');
    }
    this.#projectRoot = realpathSync.native(projectRoot);
    this.#executable = options.executable ?? 'git';
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.#runner = options.runner ?? defaultRunner;
    if (this.#timeoutMs <= 0 || this.#maxBuffer <= 0) {
      throw new GitClientError('timeout and maxBuffer must be positive');
    }
  }

  public get projectRoot(): string {
    return this.#projectRoot;
  }

  public inspect(command: string, args: readonly string[] = []): Buffer {
    if (!new Set<string>(['rev-parse', 'status', 'diff', 'ls-files', 'check-ignore']).has(command)) {
      throw new GitClientError(`command ${command} is not allowed by the read-only Git client`);
    }
    const readCommand = command as GitReadCommand;
    if (!isAllowedArguments(readCommand, args)) {
      throw new GitClientError(`arguments are not allowed for read-only Git command ${command}`);
    }
    const request: GitCommandRequest = {
      executable: this.#executable,
      args: ['-c', 'core.quotepath=false', '-C', this.#projectRoot, readCommand, ...args],
      cwd: this.#projectRoot,
      env: sanitizedEnvironment(),
      timeoutMs: this.#timeoutMs,
      maxBuffer: this.#maxBuffer,
      windowsHide: true,
    };
    const result = this.#runner(request);
    if (result.error !== undefined) {
      const detail = result.error.code === undefined ? result.error.message : `${result.error.code}: ${result.error.message}`;
      throw new GitClientError(`Git ${command} failed: ${detail}`, { cause: result.error });
    }
    if (result.status === null) {
      throw new GitClientError(`Git ${command} terminated without an exit status`);
    }
    const allowedStatuses = command === 'check-ignore' || (command === 'diff' && args.includes('--no-index'))
      ? new Set([0, 1])
      : new Set([0]);
    if (!allowedStatuses.has(result.status)) {
      throw new GitClientError(
        `Git ${command} exited with ${String(result.status)}: ${decode(result.stderr, `${command} stderr`).trim()}`,
      );
    }
    return result.stdout;
  }

  public repositoryIdentity(): GitRepositoryIdentity {
    const [topLevel, headSha, branchValue] = identityLines(
      this.inspect('rev-parse', ['--show-toplevel', 'HEAD', '--abbrev-ref', 'HEAD']),
    );
    if (!isAbsolute(topLevel)) throw new GitClientError('Git top-level must be absolute');
    const canonicalTopLevel = realpathSync.native(topLevel);
    if (normalizeComparison(canonicalTopLevel) !== normalizeComparison(this.#projectRoot)) {
      throw new GitClientError(
        `Git top-level must equal the canonical project root; nested roots are not supported (${canonicalTopLevel})`,
      );
    }
    if (!SHA_PATTERN.test(headSha)) throw new GitClientError('Git returned a malformed HEAD SHA');
    const detached = branchValue === 'HEAD';
    return {
      canonicalRoot: this.#projectRoot,
      headSha,
      branch: detached ? null : branchValue,
      detached,
    };
  }

  public status(): GitStatusSnapshot {
    return parseStatus(this.inspect('status', ['--porcelain=v2', '-z', '--untracked-files=all']));
  }

  public listFiles(): readonly string[] {
    return parseNulPaths(
      this.inspect('ls-files', ['-z', '--cached', '--others', '--exclude-standard', '--']),
      'ls-files output',
    );
  }

  public listTrackedFiles(): ReadonlySet<string> {
    return new Set(
      parseNulPaths(this.inspect('ls-files', ['-z', '--cached', '--']), 'tracked ls-files output'),
    );
  }

  public checkIgnored(paths: readonly string[]): ReadonlySet<string> {
    if (paths.length === 0) return new Set();
    const normalized = paths.map(normalizeGitRelativePath);
    return new Set(parseNulPaths(this.inspect('check-ignore', ['-z', '--', ...normalized]), 'check-ignore output'));
  }

  public headToCurrentPatch(): string {
    return decode(
      this.inspect('diff', ['--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--']),
      'Git diff output',
    );
  }

  public diffNoIndex(before: string, after: string): string {
    return decode(
      this.inspect('diff', [
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        '--no-index',
        '--',
        before,
        after,
      ]),
      'Git no-index diff output',
    );
  }
}
