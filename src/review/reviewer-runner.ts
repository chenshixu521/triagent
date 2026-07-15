import { resolve } from 'node:path';

import type { AttemptId, TaskId } from '../domain/ids.js';
import type { AgentRole } from '../domain/task.js';
import { CommandClassifier } from '../guard/command-classifier.js';
import {
  consumeImmutableReviewBundle,
  type ImmutableReviewBundle,
} from '../protocol/review-bundle.js';
import {
  AgentResultSchema,
  type AgentResult,
} from '../protocol/result-schema.js';

export interface ReviewCommandRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

export type ReviewCommandAuthorization =
  | {
      readonly allowed: true;
      readonly executable: string;
      readonly argv: readonly string[];
      /** Controlled verification copy for any project-code execution. */
      readonly executionCwd: string;
      readonly routedToVerificationCopy: boolean;
      readonly reason: string;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export interface ReviewerAgentResult extends AgentResult {
  readonly reviewBundleHash: string;
  readonly observedBaselineHash: string;
}

export interface ReviewerContext {
  readonly role: AgentRole;
  readonly attemptId: AttemptId;
  readonly taskId: TaskId;
  readonly projectRoot: string;
  readonly verificationCopyRoot: string;
  readonly preReviewBaselineHash: string;
  readonly bundle: ImmutableReviewBundle;
  readonly authorizeCommand: (
    request: ReviewCommandRequest,
  ) => ReviewCommandAuthorization;
  /**
   * Explicit write channel — using it marks the review as invalidated.
   * Defense in depth; production adapters should never call this.
   */
  readonly reportWriteAttempt: (path: string) => void;
}

export interface ReviewerAgent {
  readonly review: (context: ReviewerContext) => Promise<ReviewerAgentResult>;
}

/**
 * Trusted isolation/write-monitor port. Task 20 may provide Chokidar;
 * tests inject a monitor that observes real writes without agent self-report.
 */
export interface ReadOnlyWriteMonitor {
  readonly start: (projectRoot: string) => Promise<void> | void;
  readonly stop: () =>
    | Promise<{ readonly writes: readonly string[] }>
    | { readonly writes: readonly string[] };
}

export interface ReviewerRunnerOptions {
  readonly projectRoot: string;
  readonly verificationCopyRoot: string;
  readonly role: Extract<AgentRole, 'reviewer' | 'master'>;
  readonly attemptId: AttemptId;
  readonly taskId: TaskId;
  readonly bundle: ImmutableReviewBundle;
  readonly agent: ReviewerAgent;
  /** Deterministic project content hash used for pre/post baseline recheck. */
  readonly hashProject: (projectRoot: string) => string;
  readonly classifier?: CommandClassifier;
  /**
   * Mandatory trusted write monitor. Must start before agent.review and
   * stop/settle after. Any write during review invalidates even if restored.
   */
  readonly writeMonitor: ReadOnlyWriteMonitor;
}

export interface ReviewRecord {
  readonly bundleHash: string;
  readonly baselineHash: string;
  readonly role: AgentRole;
  readonly attemptId: string;
  readonly taskId: string;
  readonly agentResult: ReviewerAgentResult;
  /** Opaque trust marker — only runReadOnlyReview creates valid records. */
  readonly readonlyTrustToken: string;
}

export type ReadOnlyReviewResult =
  | {
      readonly status: 'valid';
      readonly preReviewBaselineHash: string;
      readonly postReviewBaselineHash: string;
      readonly reviewRecord: ReviewRecord;
      readonly agentResult: ReviewerAgentResult;
    }
  | {
      readonly status: 'invalidated';
      readonly reason: string;
      readonly preReviewBaselineHash: string;
      readonly postReviewBaselineHash: string;
      readonly writeObserved: boolean;
    };

/** Module-private trust tokens issued only by runReadOnlyReview. */
const trustedReviewRecords = new WeakSet<object>();

export function isTrustedReviewRecord(record: ReviewRecord | undefined): boolean {
  return record !== undefined && trustedReviewRecords.has(record);
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const entry of value) freezeDeep(entry);
    } else {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        freezeDeep(entry);
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezeDeep(entry);
  }
  return Object.freeze(value);
}

/**
 * Parse/validate through AgentResultSchema, then deep-freeze a complete trusted
 * copy including review-only hash fields. Fail closed on malformed results.
 */
function trustAgentResult(
  raw: unknown,
  options: {
    readonly expectedBundleHash: string;
    readonly expectedBaselineHash: string;
  },
):
  | { readonly ok: true; readonly result: ReviewerAgentResult }
  | { readonly ok: false; readonly reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'reviewer agent result is missing or not an object' };
  }
  const record = raw as Record<string, unknown>;
  const reviewBundleHash = record.reviewBundleHash;
  const observedBaselineHash = record.observedBaselineHash;
  if (typeof reviewBundleHash !== 'string' || !/^[0-9a-f]{64}$/.test(reviewBundleHash)) {
    return {
      ok: false,
      reason: 'reviewer result reviewBundleHash is missing or malformed',
    };
  }
  if (
    typeof observedBaselineHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(observedBaselineHash)
  ) {
    return {
      ok: false,
      reason: 'reviewer result observedBaselineHash is missing or malformed',
    };
  }
  if (reviewBundleHash !== options.expectedBundleHash) {
    return {
      ok: false,
      reason:
        'reviewer result reviewBundleHash does not match the immutable bundle',
    };
  }
  if (observedBaselineHash !== options.expectedBaselineHash) {
    return {
      ok: false,
      reason:
        'reviewer result observedBaselineHash does not match pre-review baseline',
    };
  }

  // Strip review-only fields before Task 8 AgentResultSchema (strict).
  const {
    reviewBundleHash: _bundleHash,
    observedBaselineHash: _baselineHash,
    ...agentFields
  } = record;
  const parsed = AgentResultSchema.safeParse(agentFields);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'reviewer agent result failed AgentResultSchema validation',
    };
  }

  // Clone through JSON so nested arrays/objects are not shared with the agent.
  let cloned: AgentResult;
  try {
    cloned = JSON.parse(JSON.stringify(parsed.data)) as AgentResult;
  } catch {
    return {
      ok: false,
      reason: 'reviewer agent result could not be cloned as JSON',
    };
  }

  const trusted: ReviewerAgentResult = freezeDeep({
    ...cloned,
    reviewBundleHash,
    observedBaselineHash,
  });
  return { ok: true, result: trusted };
}

function comparisonRoot(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function baseName(executable: string): string {
  const leaf = executable.replaceAll('/', '\\').split('\\').pop() ?? executable;
  return leaf.toLocaleLowerCase('en-US');
}

/**
 * Exact read-only command family allowed against the live project.
 * Everything else that can execute project code is routed to the verification copy
 * (if classifier auto_allowed) or rejected.
 */
function isExactLiveReadOnlyCommand(
  executable: string,
  argv: readonly string[],
): boolean {
  const name = baseName(executable);
  const lower = argv.map((entry) => entry.toLocaleLowerCase('en-US'));

  // git status / diff / log / show / rev-parse / describe (classifier already vetted)
  if (name === 'git' || name === 'git.exe') {
    const head = lower[0];
    return (
      head === 'status' ||
      head === 'diff' ||
      head === 'log' ||
      head === 'show' ||
      head === 'rev-parse' ||
      head === 'describe'
    );
  }

  return false;
}

/**
 * Any command capable of executing project code/scripts must never run live.
 * Includes interpreters, package managers, test runners, compilers, shells.
 */
function isProjectCodeExecutionCommand(executable: string): boolean {
  const name = baseName(executable);
  const executors = new Set([
    'node',
    'node.exe',
    'nodejs',
    'nodejs.exe',
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
    'tsx',
    'tsx.cmd',
    'tsx.exe',
    'ts-node',
    'ts-node.cmd',
    'ts-node.exe',
    'python',
    'python.exe',
    'python3',
    'python3.exe',
    'py',
    'py.exe',
    'ruby',
    'ruby.exe',
    'perl',
    'perl.exe',
    'php',
    'php.exe',
    'deno',
    'deno.exe',
    'vitest',
    'vitest.cmd',
    'vitest.exe',
    'jest',
    'jest.cmd',
    'jest.exe',
    'mocha',
    'mocha.cmd',
    'mocha.exe',
    'tsc',
    'tsc.cmd',
    'tsc.exe',
    'vite',
    'vite.cmd',
    'vite.exe',
    'webpack',
    'webpack.cmd',
    'webpack.exe',
    'esbuild',
    'esbuild.exe',
    'rollup',
    'rollup.cmd',
    'rollup.exe',
    'powershell',
    'powershell.exe',
    'pwsh',
    'pwsh.exe',
    'cmd',
    'cmd.exe',
    'bash',
    'bash.exe',
    'sh',
    'sh.exe',
    'zsh',
    'zsh.exe',
  ]);
  return executors.has(name);
}

function authorizeReviewCommand(
  request: ReviewCommandRequest,
  options: {
    readonly projectRoot: string;
    readonly verificationCopyRoot: string;
    readonly classifier: CommandClassifier;
  },
): ReviewCommandAuthorization {
  const classified = options.classifier.classify({
    executable: request.executable,
    argv: request.argv,
    cwd: request.cwd,
  });

  if (classified.classification === 'denied') {
    return {
      allowed: false,
      reason: classified.reason,
    };
  }

  if (classified.classification !== 'auto_allowed') {
    return {
      allowed: false,
      reason:
        'reviewer/master may not run non-allowlisted commands during read-only review',
    };
  }

  const cwdKey = comparisonRoot(request.cwd);
  const projectKey = comparisonRoot(options.projectRoot);
  const copyKey = comparisonRoot(options.verificationCopyRoot);
  if (cwdKey !== projectKey && cwdKey !== copyKey) {
    return {
      allowed: false,
      reason: 'command cwd is outside the project and verification copy',
    };
  }

  // Project-code execution: never live project — route to verification copy.
  if (isProjectCodeExecutionCommand(request.executable)) {
    return {
      allowed: true,
      executable: request.executable,
      argv: request.argv,
      executionCwd: options.verificationCopyRoot,
      routedToVerificationCopy: true,
      reason:
        'project-code execution command routed to controlled verification copy',
    };
  }

  // Live project: only exact read-only family with safe argv.
  if (isExactLiveReadOnlyCommand(request.executable, request.argv)) {
    return {
      allowed: true,
      executable: request.executable,
      argv: request.argv,
      executionCwd: options.projectRoot,
      routedToVerificationCopy: false,
      reason: 'exact allowlisted live-project read-only command',
    };
  }

  // Other auto_allowed commands still must not hit live project.
  return {
    allowed: true,
    executable: request.executable,
    argv: request.argv,
    executionCwd: options.verificationCopyRoot,
    routedToVerificationCopy: true,
    reason:
      'auto-allowed command routed to verification copy (not live-project read-only family)',
  };
}

/**
 * Injectable manual write monitor for tests / Task 20 scaffolding.
 * Records recursive write events reported via recordWrite.
 */
export function createManualWriteMonitor(): ReadOnlyWriteMonitor & {
  readonly recordWrite: (path: string) => void;
} {
  let started = false;
  const writes: string[] = [];
  return {
    async start() {
      started = true;
      writes.length = 0;
    },
    recordWrite(path: string) {
      if (!started) {
        throw new Error('write monitor is not started');
      }
      writes.push(path);
    },
    async stop() {
      if (!started) {
        throw new Error('write monitor was never started');
      }
      started = false;
      return { writes: Object.freeze([...writes]) };
    },
  };
}

/**
 * Run reviewer/master against fixed evidence under a read-only contract.
 * Captures project hash baseline before and after; write monitor + hash are
 * defense in depth. Project-code execution routes to a verification copy.
 */
export async function runReadOnlyReview(
  options: ReviewerRunnerOptions,
): Promise<ReadOnlyReviewResult> {
  if (options.role !== 'reviewer' && options.role !== 'master') {
    return {
      status: 'invalidated',
      reason: 'read-only review only supports reviewer or master roles',
      preReviewBaselineHash: '',
      postReviewBaselineHash: '',
      writeObserved: false,
    };
  }

  if (options.writeMonitor === undefined || options.writeMonitor === null) {
    return {
      status: 'invalidated',
      reason: 'read-only write monitor is required and missing',
      preReviewBaselineHash: '',
      postReviewBaselineHash: '',
      writeObserved: false,
    };
  }

  const consumed = consumeImmutableReviewBundle(options.bundle);
  if (!consumed.ok) {
    return {
      status: 'invalidated',
      reason: consumed.reason,
      preReviewBaselineHash: '',
      postReviewBaselineHash: '',
      writeObserved: false,
    };
  }

  const projectRoot = resolve(options.projectRoot);
  const verificationCopyRoot = resolve(options.verificationCopyRoot);
  if (comparisonRoot(projectRoot) === comparisonRoot(verificationCopyRoot)) {
    return {
      status: 'invalidated',
      reason: 'verification copy must be distinct from the live project',
      preReviewBaselineHash: '',
      postReviewBaselineHash: '',
      writeObserved: false,
    };
  }

  const classifier = options.classifier ?? new CommandClassifier();
  let preReviewBaselineHash = '';
  let writeObserved = false;
  const writePaths: string[] = [];
  let monitorStarted = false;

  try {
    await options.writeMonitor.start(projectRoot);
    monitorStarted = true;
  } catch (error) {
    return {
      status: 'invalidated',
      reason:
        error instanceof Error
          ? `read-only write monitor failed to start: ${error.message}`
          : 'read-only write monitor failed to start',
      preReviewBaselineHash: '',
      postReviewBaselineHash: '',
      writeObserved: false,
    };
  }

  try {
    preReviewBaselineHash = options.hashProject(projectRoot);

    const context: ReviewerContext = {
      role: options.role,
      attemptId: options.attemptId,
      taskId: options.taskId,
      projectRoot,
      verificationCopyRoot,
      preReviewBaselineHash,
      bundle: consumed.bundle,
      authorizeCommand: (request) =>
        authorizeReviewCommand(request, {
          projectRoot,
          verificationCopyRoot,
          classifier,
        }),
      reportWriteAttempt: (path) => {
        writeObserved = true;
        writePaths.push(path);
      },
    };

    let rawAgentResult: unknown;
    try {
      rawAgentResult = await options.agent.review(context);
    } catch (error) {
      let postHash = preReviewBaselineHash;
      try {
        postHash = options.hashProject(projectRoot);
      } catch {
        // keep pre hash
      }
      return {
        status: 'invalidated',
        reason:
          error instanceof Error
            ? `reviewer agent failed: ${error.message}`
            : 'reviewer agent failed',
        preReviewBaselineHash,
        postReviewBaselineHash: postHash,
        writeObserved,
      };
    }

    let monitorWrites: readonly string[] = [];
    try {
      const stopped = await options.writeMonitor.stop();
      monitorStarted = false;
      monitorWrites = stopped.writes;
    } catch (error) {
      return {
        status: 'invalidated',
        reason:
          error instanceof Error
            ? `read-only write monitor failed to settle: ${error.message}`
            : 'read-only write monitor failed to settle',
        preReviewBaselineHash,
        postReviewBaselineHash: options.hashProject(projectRoot),
        writeObserved: true,
      };
    }

    if (monitorWrites.length > 0) {
      writeObserved = true;
      writePaths.push(...monitorWrites);
    }

    const postReviewBaselineHash = options.hashProject(projectRoot);
    if (writeObserved || preReviewBaselineHash !== postReviewBaselineHash) {
      return {
        status: 'invalidated',
        reason:
          writeObserved
            ? `read-only review invalidated: write observed (${writePaths.join(', ') || 'unknown path'})`
            : 'read-only review invalidated: project baseline hash mismatch after review',
        preReviewBaselineHash,
        postReviewBaselineHash,
        writeObserved:
          writeObserved || preReviewBaselineHash !== postReviewBaselineHash,
      };
    }

    const trusted = trustAgentResult(rawAgentResult, {
      expectedBundleHash: consumed.bundle.bundleHash,
      expectedBaselineHash: preReviewBaselineHash,
    });
    if (!trusted.ok) {
      return {
        status: 'invalidated',
        reason: trusted.reason,
        preReviewBaselineHash,
        postReviewBaselineHash,
        writeObserved: false,
      };
    }
    const agentResult = trusted.result;

    const reviewRecord: ReviewRecord = freezeDeep({
      bundleHash: consumed.bundle.bundleHash,
      baselineHash: preReviewBaselineHash,
      role: options.role,
      attemptId: String(options.attemptId),
      taskId: String(options.taskId),
      agentResult,
      readonlyTrustToken: `trusted:${consumed.bundle.bundleHash}:${preReviewBaselineHash}`,
    });
    trustedReviewRecords.add(reviewRecord);

    return {
      status: 'valid',
      preReviewBaselineHash,
      postReviewBaselineHash,
      reviewRecord,
      agentResult,
    };
  } finally {
    if (monitorStarted) {
      try {
        await options.writeMonitor.stop();
      } catch {
        // already failing closed via outer path
      }
    }
  }
}
