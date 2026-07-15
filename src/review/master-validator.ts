import {
  consumeImmutableReviewBundle,
  type ImmutableReviewBundle,
  type ReviewBundleCommandEvidence,
  type ReviewBundleFixedDiff,
} from '../protocol/review-bundle.js';
import type { AgentIssue } from '../protocol/result-schema.js';
import {
  isTrustedReviewRecord,
  type ReviewRecord,
} from './reviewer-runner.js';
import { stableJson } from '../tracking/hash.js';

const REDACTED = '[REDACTED]';
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type MasterDecision = 'approved' | 'needs_rework' | 'failed' | 'await_user';

export interface MasterReviewResultSummary {
  readonly status: string;
  readonly summary: string;
  readonly issues: readonly Pick<AgentIssue, 'severity' | 'message'>[];
  readonly nextAction: string;
}

export interface MasterCommandExitCode {
  readonly command: string;
  readonly exitCode: number;
}

/**
 * Approval requires the trusted ImmutableReviewBundle and the trusted
 * ReviewRecord produced by runReadOnlyReview. Caller-supplied hashes alone
 * are never sufficient.
 */
export interface MasterApprovalEvidence {
  readonly decision: MasterDecision;
  /** Trusted immutable review bundle (required for approved). */
  readonly bundle?: ImmutableReviewBundle | unknown;
  /** Trusted valid ReviewRecord from runReadOnlyReview (required for approved). */
  readonly reviewRecord?: ReviewRecord;
  /** Current live baseline hash at master validation time. */
  readonly currentBaselineHash?: string;
  /**
   * Optional claimed fileDiff — must canonically match bundle.payload.fixedDiff
   * when provided; when omitted, bundle.payload.fixedDiff is used.
   */
  readonly fileDiff?: ReviewBundleFixedDiff;
  /**
   * Optional claimed command exit evidence — must match
   * bundle.payload.commandEvidence exactly (order + content).
   */
  readonly commandExitCodes?: readonly MasterCommandExitCode[];
  /** Optional partial review summary for non-approved paths only. */
  readonly reviewResult?: MasterReviewResultSummary;
  /** @deprecated forged hash fields are ignored for approved path */
  readonly reviewBundleHash?: string;
  readonly expectedReviewBundleHash?: string;
  readonly expectedBaselineHash?: string;
}

export type MasterValidationResult =
  | {
      readonly ok: true;
      readonly decision: MasterDecision;
      readonly bundleHash?: string;
      readonly baselineHash?: string;
    }
  | {
      readonly ok: false;
      readonly decision: Exclude<MasterDecision, 'approved'> | 'rejected';
      readonly reason: string;
    };

function isRedacted(value: unknown): boolean {
  return (
    value === REDACTED ||
    (typeof value === 'string' &&
      (value.includes(REDACTED) || value.trim() === REDACTED))
  );
}

function isPresentObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateReviewResult(
  value: unknown,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (value === undefined || value === null) {
    return { ok: false, reason: 'reviewResult is required' };
  }
  if (isRedacted(value)) {
    return {
      ok: false,
      reason: 'reviewResult is redacted and cannot satisfy evidence',
    };
  }
  if (!isPresentObject(value)) {
    return { ok: false, reason: 'reviewResult is malformed' };
  }
  if (typeof value.status !== 'string' || value.status.trim().length === 0) {
    return { ok: false, reason: 'reviewResult.status is missing' };
  }
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) {
    return { ok: false, reason: 'reviewResult.summary is missing' };
  }
  if (!Array.isArray(value.issues)) {
    return { ok: false, reason: 'reviewResult.issues must be an array' };
  }
  if (typeof value.nextAction !== 'string' || value.nextAction.trim().length === 0) {
    return { ok: false, reason: 'reviewResult.nextAction is missing' };
  }
  return { ok: true };
}

function commandExitEvidenceFromBundle(
  evidence: readonly ReviewBundleCommandEvidence[],
): readonly MasterCommandExitCode[] {
  return evidence.map((entry) =>
    Object.freeze({
      command: entry.command,
      exitCode: entry.exitCode,
    }),
  );
}

function commandExitCodesMatch(
  claimed: readonly MasterCommandExitCode[],
  trusted: readonly MasterCommandExitCode[],
): boolean {
  if (claimed.length !== trusted.length) return false;
  return claimed.every((entry, index) => {
    const expected = trusted[index]!;
    return entry.command === expected.command && entry.exitCode === expected.exitCode;
  });
}

function reviewerIsSuccessful(record: ReviewRecord): {
  readonly ok: true;
} | {
  readonly ok: false;
  readonly reason: string;
} {
  const result = record.agentResult;
  if (result.status !== 'completed') {
    return {
      ok: false,
      reason: `reviewer status is not successful for approval: ${result.status}`,
    };
  }
  if (result.verification.passed !== true) {
    return {
      ok: false,
      reason: 'reviewer verification.passed is not true',
    };
  }
  const blocking = result.issues.filter(
    (issue) => issue.severity === 'critical' || issue.severity === 'major',
  );
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: `reviewer has blocking critical/major issues (${blocking.length})`,
    };
  }
  return { ok: true };
}

/**
 * Master cannot return `approved` unless a trusted ImmutableReviewBundle and
 * a trusted ReviewRecord from runReadOnlyReview are present and consistent
 * with current baseline, file diff, and command exit evidence.
 * Fail closed on missing/stale/mismatched/malformed/redacted-required evidence.
 */
export function validateMasterApproval(
  evidence: MasterApprovalEvidence,
): MasterValidationResult {
  if (evidence === null || typeof evidence !== 'object') {
    return {
      ok: false,
      decision: 'rejected',
      reason: 'master approval evidence is missing',
    };
  }

  const decision = evidence.decision;
  if (
    decision !== 'approved' &&
    decision !== 'needs_rework' &&
    decision !== 'failed' &&
    decision !== 'await_user'
  ) {
    return {
      ok: false,
      decision: 'rejected',
      reason: 'master decision is missing or invalid',
    };
  }

  // Non-approved decisions may proceed with partial evidence.
  if (decision !== 'approved') {
    if (evidence.reviewResult !== undefined) {
      const reviewCheck = validateReviewResult(evidence.reviewResult);
      if (!reviewCheck.ok) {
        return {
          ok: false,
          decision: 'rejected',
          reason: reviewCheck.reason,
        };
      }
    }
    return {
      ok: true,
      decision,
      ...(evidence.reviewRecord !== undefined &&
      SHA256_HEX.test(evidence.reviewRecord.bundleHash)
        ? { bundleHash: evidence.reviewRecord.bundleHash }
        : {}),
      ...(evidence.currentBaselineHash !== undefined &&
      SHA256_HEX.test(evidence.currentBaselineHash)
        ? { baselineHash: evidence.currentBaselineHash }
        : {}),
    };
  }

  // --- approved path: fail closed on every trusted gate ---

  if (evidence.bundle === undefined || evidence.bundle === null) {
    return {
      ok: false,
      decision: 'rejected',
      reason: 'trusted ImmutableReviewBundle is required for master approval',
    };
  }
  if (isRedacted(evidence.bundle)) {
    return {
      ok: false,
      decision: 'rejected',
      reason: 'review bundle is redacted and cannot satisfy master approval',
    };
  }

  const consumed = consumeImmutableReviewBundle(evidence.bundle);
  if (!consumed.ok) {
    return {
      ok: false,
      decision: 'rejected',
      reason: `untrusted or invalid review bundle: ${consumed.reason}`,
    };
  }
  const bundle = consumed.bundle;

  if (evidence.reviewRecord === undefined || evidence.reviewRecord === null) {
    return {
      ok: false,
      decision: 'rejected',
      reason:
        'trusted ReviewRecord from runReadOnlyReview is required for master approval',
    };
  }
  if (isRedacted(evidence.reviewRecord)) {
    return {
      ok: false,
      decision: 'rejected',
      reason: 'review record is redacted and cannot satisfy master approval',
    };
  }
  if (!isTrustedReviewRecord(evidence.reviewRecord)) {
    return {
      ok: false,
      decision: 'rejected',
      reason:
        'review record is not a trusted ReviewRecord produced by runReadOnlyReview',
    };
  }
  const reviewRecord = evidence.reviewRecord;

  // Bind record to consumed bundle.
  if (reviewRecord.bundleHash !== bundle.bundleHash) {
    return {
      ok: false,
      decision: 'rejected',
      reason: 'reviewRecord.bundleHash does not match trusted bundle hash',
    };
  }
  if (reviewRecord.role !== 'reviewer' && reviewRecord.role !== 'master') {
    return {
      ok: false,
      decision: 'rejected',
      reason: 'reviewRecord.role is not a review role',
    };
  }
  if (
    typeof reviewRecord.attemptId !== 'string' ||
    reviewRecord.attemptId.trim().length === 0 ||
    typeof reviewRecord.taskId !== 'string' ||
    reviewRecord.taskId.trim().length === 0
  ) {
    return {
      ok: false,
      decision: 'rejected',
      reason: 'reviewRecord attempt/task identity is missing',
    };
  }

  // Current baseline must match the trusted record baseline (not stale).
  if (
    evidence.currentBaselineHash === undefined ||
    isRedacted(evidence.currentBaselineHash) ||
    typeof evidence.currentBaselineHash !== 'string' ||
    !SHA256_HEX.test(evidence.currentBaselineHash)
  ) {
    return {
      ok: false,
      decision: 'rejected',
      reason:
        'currentBaselineHash is required, non-redacted, and must be sha256 hex',
    };
  }
  if (evidence.currentBaselineHash !== reviewRecord.baselineHash) {
    return {
      ok: false,
      decision: 'rejected',
      reason:
        'currentBaselineHash does not match trusted reviewRecord.baselineHash (stale or mismatched)',
    };
  }

  // File diff: claimed (if any) must canonically equal bundle.payload.fixedDiff.
  const trustedDiff = bundle.payload.fixedDiff;
  if (evidence.fileDiff !== undefined) {
    if (isRedacted(evidence.fileDiff)) {
      return {
        ok: false,
        decision: 'rejected',
        reason: 'fileDiff is redacted and cannot satisfy master approval',
      };
    }
    if (stableJson(evidence.fileDiff) !== stableJson(trustedDiff)) {
      return {
        ok: false,
        decision: 'rejected',
        reason: 'fileDiff does not match trusted bundle.payload.fixedDiff',
      };
    }
  }

  // Command exit codes: exact match against bundle.payload.commandEvidence.
  const trustedExits = commandExitEvidenceFromBundle(
    bundle.payload.commandEvidence,
  );
  if (trustedExits.length === 0) {
    return {
      ok: false,
      decision: 'rejected',
      reason:
        'trusted bundle commandEvidence is empty; master approval requires command exit evidence',
    };
  }
  const claimedExits =
    evidence.commandExitCodes === undefined
      ? trustedExits
      : evidence.commandExitCodes;
  if (isRedacted(claimedExits)) {
    return {
      ok: false,
      decision: 'rejected',
      reason: 'commandExitCodes are redacted',
    };
  }
  if (!Array.isArray(claimedExits) || claimedExits.length === 0) {
    return {
      ok: false,
      decision: 'rejected',
      reason: 'commandExitCodes are missing or empty',
    };
  }
  if (!commandExitCodesMatch(claimedExits, trustedExits)) {
    return {
      ok: false,
      decision: 'rejected',
      reason:
        'commandExitCodes do not exactly match trusted bundle.payload.commandEvidence (order and content)',
    };
  }
  const failedCommand = trustedExits.find((entry) => entry.exitCode !== 0);
  if (failedCommand !== undefined) {
    return {
      ok: false,
      decision: 'rejected',
      reason: `command evidence is not consistent with approval: ${failedCommand.command} exited ${failedCommand.exitCode}`,
    };
  }

  // Reviewer result must be successful with zero blocking issues.
  const success = reviewerIsSuccessful(reviewRecord);
  if (!success.ok) {
    return { ok: false, decision: 'rejected', reason: success.reason };
  }

  return {
    ok: true,
    decision: 'approved',
    bundleHash: bundle.bundleHash,
    baselineHash: reviewRecord.baselineHash,
  };
}

/** Helper: project command evidence rows into master exit-code evidence. */
export function commandEvidenceToExitCodes(
  evidence: readonly ReviewBundleCommandEvidence[],
): readonly MasterCommandExitCode[] {
  return commandExitEvidenceFromBundle(evidence);
}
