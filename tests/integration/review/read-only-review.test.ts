import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { asAttemptId, asBaselineId, asTaskId } from '../../../src/domain/ids.js';
import {
  buildImmutableReviewBundle,
  buildImmutableReviewBundleFromCandidateChangeSet,
  classifyCandidateReviewResult,
  consumeImmutableReviewBundle,
  type ReviewBundleInput,
} from '../../../src/protocol/review-bundle.js';
import { buildWorkspaceCandidateChangeSet } from '../../../src/workspace/workspace-change-set.js';
import {
  createManualWriteMonitor,
  runReadOnlyReview,
  type ReadOnlyWriteMonitor,
  type ReviewerAgent,
  type ReviewerRunnerOptions,
  type ReviewRecord,
} from '../../../src/review/reviewer-runner.js';
import {
  validateMasterApproval,
  type MasterApprovalEvidence,
} from '../../../src/review/master-validator.js';
import { CommandClassifier } from '../../../src/guard/command-classifier.js';
import { sha256, sha256Json, stableJson } from '../../../src/tracking/hash.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix = 'triagent-review-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createProject(): {
  readonly root: string;
  readonly projectRoot: string;
  readonly verificationCopyRoot: string;
} {
  const root = temporaryDirectory();
  const projectRoot = join(root, 'project');
  const verificationCopyRoot = join(root, 'verification-copy');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(verificationCopyRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'src.ts'), 'export const value = 1;\n', 'utf8');
  writeFileSync(
    join(projectRoot, 'package.json'),
    '{"name":"review-demo","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
    'utf8',
  );
  writeFileSync(
    join(verificationCopyRoot, 'src.ts'),
    'export const value = 1;\n',
    'utf8',
  );
  return {
    root,
    projectRoot: resolve(projectRoot),
    verificationCopyRoot: resolve(verificationCopyRoot),
  };
}

function listRelativeFiles(root: string, directory = root): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(root, absolute));
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(root, absolute).replaceAll('\\', '/'));
    }
  }
  return files;
}

function hashProjectFiles(projectRoot: string): string {
  const files = listRelativeFiles(projectRoot)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const absolute = join(projectRoot, name);
      const content = readFileSync(absolute);
      return {
        path: name,
        hash: sha256(content),
        size: content.length,
        mtimeMs: statSync(absolute).mtimeMs,
      };
    });
  return sha256Json(files);
}

function sampleBundleInput(
  projectRoot: string,
  overrides: Partial<ReviewBundleInput> = {},
): ReviewBundleInput {
  return {
    requirement: {
      text: 'Implement read-only review evidence.',
      version: 1,
    },
    plan: 'Capture baselines, freeze the diff, and review read-only.',
    taskStartBaselineId: asBaselineId('task-baseline-1'),
    attemptBaselineId: asBaselineId('attempt-baseline-1'),
    fixedDiff: {
      label: 'attempt-window changes',
      files: [
        {
          path: 'src.ts',
          kind: 'modified',
          beforeHash: sha256('export const value = 1;\n'),
          afterHash: sha256('export const value = 2;\n'),
        },
      ],
      unifiedDiff:
        '--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n',
    },
    relevantFileContentHashes: [
      {
        path: 'src.ts',
        hash: sha256('export const value = 2;\n'),
      },
      {
        path: 'package.json',
        hash: sha256(
          '{"name":"review-demo","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
        ),
      },
    ],
    commandEvidence: [
      {
        command: 'npm.cmd test',
        exitCode: 0,
        cwd: projectRoot,
        stdoutHash: sha256('ok\n'),
        stderrHash: sha256(''),
      },
    ],
    verificationLogs: [
      {
        stream: 'stdout',
        sequence: 1,
        checksum: sha256('verification passed'),
        text: 'verification passed',
      },
    ],
    ...overrides,
  };
}

/** Monitor that observes real filesystem writes via a test hook on the agent path. */
function createTestWriteMonitor(): ReadOnlyWriteMonitor & {
  readonly observeWrite: (path: string) => void;
} {
  const manual = createManualWriteMonitor();
  return {
    async start(projectRoot) {
      await manual.start(projectRoot);
    },
    observeWrite(path: string) {
      manual.recordWrite(path);
    },
    async stop() {
      return manual.stop();
    },
  };
}

function honestReviewer(): ReviewerAgent {
  return {
    async review(context) {
      return {
        status: 'completed',
        summary: 'No issues found in fixed evidence.',
        changedFiles: [],
        commandsRun: [],
        verification: { passed: true, details: 'read-only review completed' },
        issues: [],
        nextAction: 'master_validation',
        reviewBundleHash: context.bundle.bundleHash,
        observedBaselineHash: context.preReviewBaselineHash,
      };
    },
  };
}

function maliciousWriteReviewer(
  projectRoot: string,
  monitor?: { observeWrite: (path: string) => void },
): ReviewerAgent {
  return {
    async review(context) {
      const path = join(projectRoot, 'malicious.txt');
      writeFileSync(path, 'pwned\n', 'utf8');
      monitor?.observeWrite(path);
      return {
        status: 'completed',
        summary: 'Claiming success after write',
        changedFiles: [],
        commandsRun: [],
        verification: { passed: true, details: 'forged' },
        issues: [],
        nextAction: 'master_validation',
        reviewBundleHash: context.bundle.bundleHash,
        observedBaselineHash: context.preReviewBaselineHash,
      };
    },
  };
}

/**
 * Write-then-restore attacker: mutates then deletes so final hash matches.
 * Does NOT call reportWriteAttempt — monitor must catch it.
 */
function writeRestoreReviewer(
  projectRoot: string,
  monitor: { observeWrite: (path: string) => void },
): ReviewerAgent {
  return {
    async review(context) {
      const path = join(projectRoot, 'temp-write.txt');
      writeFileSync(path, 'temporary\n', 'utf8');
      monitor.observeWrite(path);
      unlinkSync(path);
      return {
        status: 'completed',
        summary: 'Restored after write',
        changedFiles: [],
        commandsRun: [],
        verification: { passed: true, details: 'hash restored' },
        issues: [],
        nextAction: 'master_validation',
        reviewBundleHash: context.bundle.bundleHash,
        observedBaselineHash: context.preReviewBaselineHash,
      };
    },
  };
}

async function validReview(
  projectRoot: string,
  verificationCopyRoot: string,
): Promise<{
  readonly bundle: ReturnType<typeof buildImmutableReviewBundle>;
  readonly reviewRecord: ReviewRecord;
  readonly baselineHash: string;
}> {
  const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
  const writeMonitor = createTestWriteMonitor();
  const result = await runReadOnlyReview({
    projectRoot,
    verificationCopyRoot,
    role: 'reviewer',
    attemptId: asAttemptId('attempt-review-1'),
    taskId: asTaskId('task-review-1'),
    bundle,
    agent: honestReviewer(),
    hashProject: hashProjectFiles,
    writeMonitor,
  });
  if (result.status !== 'valid') {
    throw new Error(`expected valid review, got ${result.status}: ${result.reason}`);
  }
  return {
    bundle,
    reviewRecord: result.reviewRecord,
    baselineHash: result.preReviewBaselineHash,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('immutable review bundles', () => {
  it('canonically serializes, hashes, freezes, and validates hash consistency', () => {
    const { projectRoot } = createProject();
    const input = sampleBundleInput(projectRoot);
    const bundle = buildImmutableReviewBundle(input);

    expect(bundle.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.bundleHash).toBe(sha256(bundle.canonicalJson));
    expect(bundle.canonicalJson).toBe(stableJson(bundle.payload));
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.payload)).toBe(true);
    expect(Object.isFrozen(bundle.payload.fixedDiff)).toBe(true);
    expect(Object.isFrozen(bundle.payload.commandEvidence)).toBe(true);

    expect(() => {
      (bundle as { bundleHash: string }).bundleHash = '0'.repeat(64);
    }).toThrow();
    expect(() => {
      (bundle.payload as { plan: string }).plan = 'mutated';
    }).toThrow();

    const consumed = consumeImmutableReviewBundle(bundle);
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(consumed.bundle.bundleHash).toBe(bundle.bundleHash);
    }

    const tampered = {
      ...bundle,
      payload: {
        ...bundle.payload,
        plan: 'tampered plan',
      },
      bundleHash: bundle.bundleHash,
      canonicalJson: bundle.canonicalJson,
    };
    Object.freeze(tampered);
    const failed = consumeImmutableReviewBundle(tampered);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toMatch(/hash|mismatch|immutable|canonical|payload/i);
    }
  });

  it('attaches the bundle hash on the review record surface', () => {
    const { projectRoot } = createProject();
    const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
    expect(bundle.reviewRecord).toMatchObject({
      bundleHash: bundle.bundleHash,
      taskStartBaselineId: 'task-baseline-1',
      attemptBaselineId: 'attempt-baseline-1',
    });
    expect(bundle.reviewRecord.bundleHash).toBe(bundle.bundleHash);
  });

  it('fully re-normalizes untrusted input and rejects frozen empty payload forgery', () => {
    const emptyFrozen = Object.freeze({
      payload: Object.freeze({}),
      canonicalJson: '{}',
      bundleHash: sha256('{}'),
      reviewRecord: Object.freeze({
        bundleHash: sha256('{}'),
        taskStartBaselineId: 'x',
        attemptBaselineId: 'y',
        requirementVersion: 1,
        fileCount: 0,
        commandCount: 0,
      }),
    });
    const empty = consumeImmutableReviewBundle(emptyFrozen);
    expect(empty.ok).toBe(false);

    const { projectRoot } = createProject();
    const honest = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
    // Untrusted plain object clone (not frozen) must still re-normalize.
    const untrusted = JSON.parse(JSON.stringify(honest)) as unknown;
    const consumed = consumeImmutableReviewBundle(untrusted);
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(Object.isFrozen(consumed.bundle)).toBe(true);
      expect(Object.isFrozen(consumed.bundle.payload.fixedDiff.files)).toBe(true);
      expect(consumed.bundle.bundleHash).toBe(honest.bundleHash);
    }

    // Wrong verification checksum must fail re-normalize.
    const badChecksum = JSON.parse(JSON.stringify(honest)) as {
      payload: {
        verificationLogs: Array<{ checksum: string; text: string }>;
      };
      bundleHash: string;
      canonicalJson: string;
    };
    badChecksum.payload.verificationLogs[0]!.checksum = 'a'.repeat(64);
    expect(consumeImmutableReviewBundle(badChecksum).ok).toBe(false);

    // Extra unknown field in payload must fail.
    const extraField = JSON.parse(JSON.stringify(honest)) as {
      payload: Record<string, unknown>;
    };
    extraField.payload.attacker = true;
    expect(consumeImmutableReviewBundle(extraField).ok).toBe(false);

    // Mismatched reviewRecord.fileCount must fail.
    const badCount = JSON.parse(JSON.stringify(honest)) as {
      reviewRecord: { fileCount: number };
    };
    badCount.reviewRecord.fileCount = 99;
    expect(consumeImmutableReviewBundle(badCount).ok).toBe(false);
  });
});

describe('read-only reviewer runner', () => {
  it('captures pre/post project hash baseline and accepts an honest read-only review', async () => {
    const { projectRoot, verificationCopyRoot } = createProject();
    const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
    const preHash = hashProjectFiles(projectRoot);
    const writeMonitor = createTestWriteMonitor();

    const result = await runReadOnlyReview({
      projectRoot,
      verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-review-1'),
      taskId: asTaskId('task-review-1'),
      bundle,
      agent: honestReviewer(),
      hashProject: hashProjectFiles,
      writeMonitor,
    });

    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.preReviewBaselineHash).toBe(preHash);
      expect(result.postReviewBaselineHash).toBe(preHash);
      expect(result.reviewRecord.bundleHash).toBe(bundle.bundleHash);
      expect(result.reviewRecord.baselineHash).toBe(preHash);
    }
    expect(existsSync(join(projectRoot, 'malicious.txt'))).toBe(false);
  });

  it('deep-freezes trusted agentResult so post-return nested mutation cannot forge master approval', async () => {
    const { projectRoot, verificationCopyRoot } = createProject();
    const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
    const writeMonitor = createTestWriteMonitor();

    // Mutable nested objects retained by the malicious agent after return.
    const mutableVerification = { passed: true, details: 'looks fine' };
    const mutableIssues: Array<{
      severity: 'critical' | 'major' | 'minor';
      message: string;
    }> = [{ severity: 'critical', message: 'security hole' }];
    const maliciousOriginal = {
      status: 'completed' as const,
      summary: 'claim success while holding mutable nested refs',
      changedFiles: [] as string[],
      commandsRun: [] as string[],
      verification: mutableVerification,
      issues: mutableIssues,
      nextAction: 'master_validation' as const,
      reviewBundleHash: '',
      observedBaselineHash: '',
    };

    const agent: ReviewerAgent = {
      async review(context) {
        maliciousOriginal.reviewBundleHash = context.bundle.bundleHash;
        maliciousOriginal.observedBaselineHash = context.preReviewBaselineHash;
        return maliciousOriginal;
      },
    };

    const result = await runReadOnlyReview({
      projectRoot,
      verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-mutate-1'),
      taskId: asTaskId('task-mutate-1'),
      bundle,
      agent,
      hashProject: hashProjectFiles,
      writeMonitor,
    });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') {
      throw new Error(`expected valid review, got invalidated: ${result.reason}`);
    }

    // Snapshot trusted state before attacker mutates the original object graph.
    expect(result.agentResult.issues).toEqual([
      { severity: 'critical', message: 'security hole' },
    ]);
    expect(result.reviewRecord.agentResult.issues).toEqual([
      { severity: 'critical', message: 'security hole' },
    ]);
    expect(result.agentResult).not.toBe(maliciousOriginal);
    expect(result.reviewRecord.agentResult).not.toBe(maliciousOriginal);
    expect(result.agentResult.verification).not.toBe(mutableVerification);
    expect(result.agentResult.issues).not.toBe(mutableIssues);

    // Attacker mutates the original nested objects after the runner returns.
    mutableVerification.passed = true;
    mutableVerification.details = 'forged after return';
    mutableIssues.length = 0;
    maliciousOriginal.status = 'completed';
    maliciousOriginal.summary = 'forged clean result';
    maliciousOriginal.issues = [];
    maliciousOriginal.verification = { passed: true, details: 'forged' };

    // Trusted copies must remain unchanged (deep-frozen clone).
    expect(result.agentResult.issues).toEqual([
      { severity: 'critical', message: 'security hole' },
    ]);
    expect(result.reviewRecord.agentResult.issues).toEqual([
      { severity: 'critical', message: 'security hole' },
    ]);
    expect(result.agentResult.verification.details).toBe('looks fine');
    expect(result.reviewRecord.agentResult.verification.details).toBe('looks fine');
    expect(() => {
      (result.agentResult.issues as unknown as Array<{ severity: string }>).push({
        severity: 'minor',
      });
    }).toThrow();
    expect(() => {
      (result.reviewRecord.agentResult.verification as unknown as {
        passed: boolean;
      }).passed = false;
    }).toThrow();

    // Master rejects the trusted record (still has critical issue).
    const trustedApproval = validateMasterApproval({
      decision: 'approved',
      bundle,
      reviewRecord: result.reviewRecord,
      currentBaselineHash: result.preReviewBaselineHash,
      fileDiff: bundle.payload.fixedDiff,
      commandExitCodes: bundle.payload.commandEvidence.map((entry) => ({
        command: entry.command,
        exitCode: entry.exitCode,
      })),
    });
    expect(trustedApproval.ok).toBe(false);
    if (!trustedApproval.ok) {
      expect(trustedApproval.reason).toMatch(/critical|major|blocking|issue/i);
    }

    // Master also rejects any attempt to use the malicious original as a record.
    const forgedFromOriginal = validateMasterApproval({
      decision: 'approved',
      bundle,
      reviewRecord: {
        bundleHash: bundle.bundleHash,
        baselineHash: result.preReviewBaselineHash,
        role: 'reviewer',
        attemptId: 'attempt-mutate-1',
        taskId: 'task-mutate-1',
        agentResult: maliciousOriginal,
        readonlyTrustToken: result.reviewRecord.readonlyTrustToken,
      },
      currentBaselineHash: result.preReviewBaselineHash,
      fileDiff: bundle.payload.fixedDiff,
      commandExitCodes: bundle.payload.commandEvidence.map((entry) => ({
        command: entry.command,
        exitCode: entry.exitCode,
      })),
    });
    expect(forgedFromOriginal.ok).toBe(false);
    if (!forgedFromOriginal.ok) {
      expect(forgedFromOriginal.reason).toMatch(
        /trusted|ReviewRecord|runReadOnlyReview/i,
      );
    }
  });

  it('invalidates review when agent returns malformed/unparseable agent result', async () => {
    const { projectRoot, verificationCopyRoot } = createProject();
    const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
    const writeMonitor = createTestWriteMonitor();

    const agent: ReviewerAgent = {
      async review(context) {
        // Intentionally malformed verification for fail-closed schema path.
        return {
          status: 'completed',
          summary: 'missing required nested shape',
          changedFiles: [],
          commandsRun: [],
          verification: { passed: 'yes', details: '' },
          issues: [],
          nextAction: 'master_validation',
          reviewBundleHash: context.bundle.bundleHash,
          observedBaselineHash: context.preReviewBaselineHash,
        } as unknown as import('../../../src/review/reviewer-runner.js').ReviewerAgentResult;
      },
    };

    const result = await runReadOnlyReview({
      projectRoot,
      verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-malformed-1'),
      taskId: asTaskId('task-malformed-1'),
      bundle,
      agent,
      hashProject: hashProjectFiles,
      writeMonitor,
    });

    expect(result.status).toBe('invalidated');
    if (result.status === 'invalidated') {
      expect(result.reason).toMatch(/schema|malformed|parse|invalid|result/i);
    }
  });

  it('invalidates review when a malicious reviewer writes the live project', async () => {
    const { projectRoot, verificationCopyRoot } = createProject();
    const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
    const writeMonitor = createTestWriteMonitor();

    const result = await runReadOnlyReview({
      projectRoot,
      verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-malicious-1'),
      taskId: asTaskId('task-malicious-1'),
      bundle,
      agent: maliciousWriteReviewer(projectRoot, writeMonitor),
      hashProject: hashProjectFiles,
      writeMonitor,
    });

    expect(result.status).toBe('invalidated');
    if (result.status === 'invalidated') {
      expect(result.reason).toMatch(/write|baseline|mismatch|read-only|monitor/i);
    }
    expect(existsSync(join(projectRoot, 'malicious.txt'))).toBe(true);
  });

  it('invalidates write-then-restore even when final hash matches (no self-report)', async () => {
    const { projectRoot, verificationCopyRoot } = createProject();
    const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
    const writeMonitor = createTestWriteMonitor();
    const preHash = hashProjectFiles(projectRoot);

    const result = await runReadOnlyReview({
      projectRoot,
      verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-restore-1'),
      taskId: asTaskId('task-restore-1'),
      bundle,
      agent: writeRestoreReviewer(projectRoot, writeMonitor),
      hashProject: hashProjectFiles,
      writeMonitor,
    });

    expect(result.status).toBe('invalidated');
    if (result.status === 'invalidated') {
      expect(result.reason).toMatch(/write|monitor/i);
      expect(result.writeObserved).toBe(true);
      // Final hash may match pre — still invalidated by monitor.
      expect(result.postReviewBaselineHash).toBe(preHash);
    }
    expect(existsSync(join(projectRoot, 'temp-write.txt'))).toBe(false);
  });

  it('fails closed when write monitor cannot start', async () => {
    const { projectRoot, verificationCopyRoot } = createProject();
    const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
    const writeMonitor: ReadOnlyWriteMonitor = {
      async start() {
        throw new Error('monitor start failed');
      },
      async stop() {
        return { writes: [] };
      },
    };

    const result = await runReadOnlyReview({
      projectRoot,
      verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-mon-fail'),
      taskId: asTaskId('task-mon-fail'),
      bundle,
      agent: honestReviewer(),
      hashProject: hashProjectFiles,
      writeMonitor,
    });

    expect(result.status).toBe('invalidated');
    if (result.status === 'invalidated') {
      expect(result.reason).toMatch(/monitor/i);
    }
  });

  it('routes project-code execution (npm build, node --test) to verification copy', async () => {
    const { projectRoot, verificationCopyRoot } = createProject();
    const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
    const writeMonitor = createTestWriteMonitor();
    const executed: Array<{ cwd: string; executable: string; argv: readonly string[] }> =
      [];

    const agent: ReviewerAgent = {
      async review(context) {
        for (const request of [
          { executable: 'npm.cmd', argv: ['run', 'build'] as const },
          { executable: 'node', argv: ['--test', 'tests/unit'] as const },
          { executable: 'node.exe', argv: ['--test'] as const },
        ]) {
          const decision = context.authorizeCommand({
            executable: request.executable,
            argv: [...request.argv],
            cwd: projectRoot,
          });
          expect(decision.allowed).toBe(true);
          if (decision.allowed) {
            expect(decision.executionCwd).toBe(verificationCopyRoot);
            expect(decision.executionCwd).not.toBe(projectRoot);
            expect(decision.routedToVerificationCopy).toBe(true);
            executed.push({
              cwd: decision.executionCwd,
              executable: decision.executable,
              argv: decision.argv,
            });
          }
        }
        // Safe git read may remain on live project.
        const git = context.authorizeCommand({
          executable: 'git',
          argv: ['status', '--porcelain=v1'],
          cwd: projectRoot,
        });
        expect(git.allowed).toBe(true);
        if (git.allowed) {
          expect(git.executionCwd).toBe(projectRoot);
          expect(git.routedToVerificationCopy).toBe(false);
        }

        return {
          status: 'completed',
          summary: 'Routed code execution away from live project',
          changedFiles: [],
          commandsRun: ['npm.cmd run build', 'node --test'],
          verification: { passed: true, details: 'routed' },
          issues: [],
          nextAction: 'master_validation',
          reviewBundleHash: context.bundle.bundleHash,
          observedBaselineHash: context.preReviewBaselineHash,
        };
      },
    };

    const result = await runReadOnlyReview({
      projectRoot,
      verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-route-1'),
      taskId: asTaskId('task-route-1'),
      bundle,
      agent,
      hashProject: hashProjectFiles,
      writeMonitor,
    } satisfies ReviewerRunnerOptions);

    expect(result.status).toBe('valid');
    expect(executed).toHaveLength(3);
    for (const entry of executed) {
      expect(entry.cwd).toBe(verificationCopyRoot);
    }
  });

  it('rejects destructive or non-allowlisted live-project commands for reviewer', async () => {
    const { projectRoot, verificationCopyRoot } = createProject();
    const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));
    const classifier = new CommandClassifier();
    const writeMonitor = createTestWriteMonitor();

    const agent: ReviewerAgent = {
      async review(context) {
        const denied = context.authorizeCommand({
          executable: 'git',
          argv: ['reset', '--hard', 'HEAD'],
          cwd: projectRoot,
        });
        expect(denied.allowed).toBe(false);
        if (!denied.allowed) {
          expect(denied.reason).toMatch(/denied|destructive|read-only|not auto/i);
        }
        const classified = classifier.classify({
          executable: 'git',
          argv: ['reset', '--hard', 'HEAD'],
          cwd: projectRoot,
        });
        expect(classified.classification).toBe('denied');

        return {
          status: 'completed',
          summary: 'Command correctly rejected',
          changedFiles: [],
          commandsRun: [],
          verification: { passed: true, details: 'no live write commands' },
          issues: [],
          nextAction: 'master_validation',
          reviewBundleHash: context.bundle.bundleHash,
          observedBaselineHash: context.preReviewBaselineHash,
        };
      },
    };

    const result = await runReadOnlyReview({
      projectRoot,
      verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-deny-1'),
      taskId: asTaskId('task-deny-1'),
      bundle,
      agent,
      hashProject: hashProjectFiles,
      writeMonitor,
    });

    expect(result.status).toBe('valid');
  });
});

describe('master approval evidence gate', () => {
  async function completeEvidence(
    overrides: Partial<MasterApprovalEvidence> = {},
  ): Promise<MasterApprovalEvidence> {
    const { projectRoot, verificationCopyRoot } = createProject();
    const { bundle, reviewRecord, baselineHash } = await validReview(
      projectRoot,
      verificationCopyRoot,
    );
    return {
      decision: 'approved',
      bundle,
      reviewRecord,
      currentBaselineHash: baselineHash,
      fileDiff: bundle.payload.fixedDiff,
      commandExitCodes: bundle.payload.commandEvidence.map((entry) => ({
        command: entry.command,
        exitCode: entry.exitCode,
      })),
      ...overrides,
    };
  }

  it('allows approved only with trusted bundle + valid review record + consistent evidence', async () => {
    const evidence = await completeEvidence();
    const result = validateMasterApproval(evidence);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toBe('approved');
      expect(result.bundleHash).toBe(evidence.reviewRecord?.bundleHash);
      expect(result.baselineHash).toBe(evidence.currentBaselineHash);
    }
  });

  it('rejects fabricated matching hashes without trusted bundle/record', () => {
    const fakeHash = 'a'.repeat(64);
    const result = validateMasterApproval({
      decision: 'approved',
      fileDiff: {
        label: 'forged',
        files: [
          {
            path: 'x.ts',
            kind: 'modified',
            beforeHash: fakeHash,
            afterHash: fakeHash,
          },
        ],
        unifiedDiff: '--- a/x\n+++ b/x\n',
      },
      commandExitCodes: [{ command: 'npm test', exitCode: 0 }],
      reviewResult: {
        status: 'completed',
        summary: 'forged',
        issues: [],
        nextAction: 'complete',
      },
      reviewBundleHash: fakeHash,
      currentBaselineHash: fakeHash,
      expectedReviewBundleHash: fakeHash,
      expectedBaselineHash: fakeHash,
    } as MasterApprovalEvidence);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/bundle|review record|trusted|required/i);
    }
  });

  it('rejects mismatched fileDiff against trusted bundle payload', async () => {
    const evidence = await completeEvidence({
      fileDiff: {
        label: 'tampered',
        files: [
          {
            path: 'evil.ts',
            kind: 'added',
            beforeHash: null,
            afterHash: 'c'.repeat(64),
          },
        ],
        unifiedDiff: 'forged diff',
      },
    });
    const result = validateMasterApproval(evidence);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/diff|mismatch|fixedDiff/i);
    }
  });

  it('rejects extra/missing/reordered command evidence vs bundle', async () => {
    const base = await completeEvidence();
    const missing = validateMasterApproval({
      ...base,
      commandExitCodes: [],
    });
    expect(missing.ok).toBe(false);

    const extra = validateMasterApproval({
      ...base,
      commandExitCodes: [
        ...(base.commandExitCodes ?? []),
        { command: 'extra', exitCode: 0 },
      ],
    });
    expect(extra.ok).toBe(false);

    const altered = validateMasterApproval({
      ...base,
      commandExitCodes: [{ command: 'npm.cmd test', exitCode: 1 }],
    });
    expect(altered.ok).toBe(false);
  });

  it('rejects failed/needs_rework reviews and blocking critical/major issues', async () => {
    // Mutating a trusted record breaks the trust token (forgery).
    const base = await completeEvidence();
    const forged: ReviewRecord = {
      ...base.reviewRecord!,
      agentResult: {
        ...base.reviewRecord!.agentResult,
        status: 'needs_rework',
        summary: 'found bugs',
        issues: [{ severity: 'major', message: 'broken' }],
        nextAction: 'rework',
      },
    };
    const forgedResult = validateMasterApproval({
      ...base,
      reviewRecord: forged,
    });
    expect(forgedResult.ok).toBe(false);
    if (!forgedResult.ok) {
      expect(forgedResult.reason).toMatch(/trusted|ReviewRecord|runReadOnlyReview/i);
    }

    // Real trusted records with needs_rework / critical issues must also fail.
    const { projectRoot, verificationCopyRoot } = createProject();
    const bundle = buildImmutableReviewBundle(sampleBundleInput(projectRoot));

    const reworkAgent: ReviewerAgent = {
      async review(context) {
        return {
          status: 'needs_rework',
          summary: 'found bugs',
          changedFiles: [],
          commandsRun: [],
          verification: { passed: false, details: 'needs rework' },
          issues: [{ severity: 'major', message: 'broken' }],
          nextAction: 'rework',
          reviewBundleHash: context.bundle.bundleHash,
          observedBaselineHash: context.preReviewBaselineHash,
        };
      },
    };
    const reworkRun = await runReadOnlyReview({
      projectRoot,
      verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-rework-review'),
      taskId: asTaskId('task-rework-review'),
      bundle,
      agent: reworkAgent,
      hashProject: hashProjectFiles,
      writeMonitor: createTestWriteMonitor(),
    });
    expect(reworkRun.status).toBe('valid');
    if (reworkRun.status === 'valid') {
      const result = validateMasterApproval({
        decision: 'approved',
        bundle,
        reviewRecord: reworkRun.reviewRecord,
        currentBaselineHash: reworkRun.preReviewBaselineHash,
        fileDiff: bundle.payload.fixedDiff,
        commandExitCodes: bundle.payload.commandEvidence.map((entry) => ({
          command: entry.command,
          exitCode: entry.exitCode,
        })),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(
          /status|issue|rework|critical|major|successful|verification/i,
        );
      }
    }

    const criticalAgent: ReviewerAgent = {
      async review(context) {
        return {
          status: 'completed',
          summary: 'critical issue found',
          changedFiles: [],
          commandsRun: [],
          verification: { passed: true, details: 'has critical' },
          issues: [{ severity: 'critical', message: 'security hole' }],
          nextAction: 'master_validation',
          reviewBundleHash: context.bundle.bundleHash,
          observedBaselineHash: context.preReviewBaselineHash,
        };
      },
    };
    const criticalRun = await runReadOnlyReview({
      projectRoot,
      verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-critical-review'),
      taskId: asTaskId('task-critical-review'),
      bundle,
      agent: criticalAgent,
      hashProject: hashProjectFiles,
      writeMonitor: createTestWriteMonitor(),
    });
    expect(criticalRun.status).toBe('valid');
    if (criticalRun.status === 'valid') {
      const critical = validateMasterApproval({
        decision: 'approved',
        bundle,
        reviewRecord: criticalRun.reviewRecord,
        currentBaselineHash: criticalRun.preReviewBaselineHash,
        fileDiff: bundle.payload.fixedDiff,
        commandExitCodes: bundle.payload.commandEvidence.map((entry) => ({
          command: entry.command,
          exitCode: entry.exitCode,
        })),
      });
      expect(critical.ok).toBe(false);
      if (!critical.ok) {
        expect(critical.reason).toMatch(/critical|major|blocking|issue/i);
      }
    }
  });

  it('rejects stale baseline hash vs review record', async () => {
    const evidence = await completeEvidence({
      currentBaselineHash: 'd'.repeat(64),
    });
    const result = validateMasterApproval(evidence);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/baseline|stale|mismatch/i);
    }
  });

  it('never returns approved when the agent claims approved without evidence', () => {
    const result = validateMasterApproval({
      decision: 'approved',
    } as MasterApprovalEvidence);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.decision).not.toBe('approved');
      expect(result.reason).toMatch(/evidence|missing|required|bundle|record/i);
    }
  });

  it('allows non-approved decisions without requiring full approval evidence', () => {
    const result = validateMasterApproval({
      decision: 'needs_rework',
      reviewResult: {
        status: 'needs_rework',
        summary: 'Missing tests',
        issues: [{ severity: 'major', message: 'Add unit tests' }],
        nextAction: 'rework',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toBe('needs_rework');
    }
  });
});

describe('Candidate change-set immutable review evidence', () => {
  function textFile(path: string, content: string) {
    const buffer = Buffer.from(content, 'utf8');
    const hash = sha256(buffer);
    return {
      path,
      type: 'file' as const,
      size: buffer.length,
      hash,
      blobHash: hash,
      binary: false as const,
      content: buffer,
    };
  }

  it('builds a consumable immutable bundle from a source-to-candidate change-set without absolute paths', () => {
    const changeSet = buildWorkspaceCandidateChangeSet({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace-1',
      sourceBaselineId: 'baseline-task',
      sourceManifestHash: 'a'.repeat(64),
      candidateManifestHash: 'b'.repeat(64),
      sourceFiles: [textFile('src.ts', 'export const value = 1;\n')],
      candidateFiles: [textFile('src.ts', 'export const value = 2;\n')],
    });
    const bundle = buildImmutableReviewBundleFromCandidateChangeSet({
      requirementText: 'Update src.ts value.',
      requirementVersion: 1,
      plan: 'Isolated candidate edit.',
      taskStartBaselineId: 'baseline-task',
      attemptBaselineId: 'baseline-attempt',
      changeSet,
    });
    expect(bundle.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.payload.fixedDiff.files).toEqual([
      expect.objectContaining({ path: 'src.ts', kind: 'modified' }),
    ]);
    expect(bundle.payload.fixedDiff.unifiedDiff).not.toMatch(/[A-Za-z]:\\/);
    expect(bundle.payload.plan).toContain(changeSet.changeSetHash);
    const consumed = consumeImmutableReviewBundle(bundle);
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(consumed.bundle.bundleHash).toBe(bundle.bundleHash);
    }
  });

  it('classifies Codex approve/rework/reject and rejects ambiguous outcomes', () => {
    expect(classifyCandidateReviewResult({
      status: 'completed',
      nextAction: 'master_validation',
      verification: { passed: true },
      issues: [],
    })).toEqual({ ok: true, verdict: 'approve' });

    expect(classifyCandidateReviewResult({
      status: 'completed',
      nextAction: 'rework',
      verification: { passed: false },
      issues: [{ message: 'fix' }],
    })).toEqual({ ok: true, verdict: 'rework' });

    expect(classifyCandidateReviewResult({
      status: 'failed',
      nextAction: 'await_user',
    })).toEqual({ ok: true, verdict: 'reject' });

    expect(classifyCandidateReviewResult({
      status: 'completed',
      nextAction: 'complete',
      verification: { passed: true },
      issues: [],
    }).ok).toBe(false);
  });

  it('runs read-only review against candidate evidence without mutating the live project', async () => {
    const project = createProject();
    const changeSet = buildWorkspaceCandidateChangeSet({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace-1',
      sourceBaselineId: 'baseline-task',
      sourceManifestHash: 'a'.repeat(64),
      candidateManifestHash: 'b'.repeat(64),
      sourceFiles: [textFile('src.ts', 'export const value = 1;\n')],
      candidateFiles: [textFile('src.ts', 'export const value = 2;\n')],
    });
    const bundle = buildImmutableReviewBundleFromCandidateChangeSet({
      requirementText: 'Update src.ts value.',
      requirementVersion: 1,
      plan: 'Isolated candidate edit.',
      taskStartBaselineId: 'baseline-task',
      attemptBaselineId: 'baseline-attempt',
      changeSet,
    });
    const before = hashProjectFiles(project.projectRoot);
    const monitor = createTestWriteMonitor();
    const outcome = await runReadOnlyReview({
      projectRoot: project.projectRoot,
      verificationCopyRoot: project.verificationCopyRoot,
      role: 'reviewer',
      attemptId: asAttemptId('attempt-review-1'),
      taskId: asTaskId('task-review-1'),
      bundle,
      agent: honestReviewer(),
      hashProject: hashProjectFiles,
      writeMonitor: monitor,
    });
    expect(outcome.status).toBe('valid');
    expect(hashProjectFiles(project.projectRoot)).toBe(before);
    if (outcome.status === 'valid') {
      expect(outcome.agentResult.nextAction).toBe('master_validation');
      expect(outcome.reviewRecord.bundleHash).toBe(bundle.bundleHash);
    }
  });
});
