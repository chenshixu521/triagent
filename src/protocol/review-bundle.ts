import type { BaselineId } from '../domain/ids.js';
import { sha256, stableJson } from '../tracking/hash.js';
import type { WorkspaceCandidateChangeSet } from '../workspace/implementation-workspace-types.js';

export interface ReviewBundleRequirement {
  readonly text: string;
  readonly version: number;
}

export interface ReviewBundleDiffFile {
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'type-changed' | 'renamed';
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}

export interface ReviewBundleFixedDiff {
  readonly label: string;
  readonly files: readonly ReviewBundleDiffFile[];
  readonly unifiedDiff: string;
}

export interface ReviewBundleFileHash {
  readonly path: string;
  readonly hash: string;
}

export interface ReviewBundleCommandEvidence {
  readonly command: string;
  readonly exitCode: number;
  readonly cwd: string;
  readonly stdoutHash: string;
  readonly stderrHash: string;
}

export interface ReviewBundleVerificationLog {
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly sequence: number;
  readonly checksum: string;
  readonly text: string;
}

export interface ReviewBundleInput {
  readonly requirement: ReviewBundleRequirement;
  readonly plan: string;
  readonly taskStartBaselineId: BaselineId | string;
  readonly attemptBaselineId: BaselineId | string;
  readonly fixedDiff: ReviewBundleFixedDiff;
  readonly relevantFileContentHashes: readonly ReviewBundleFileHash[];
  readonly commandEvidence: readonly ReviewBundleCommandEvidence[];
  readonly verificationLogs: readonly ReviewBundleVerificationLog[];
}

export interface ReviewBundlePayload {
  readonly version: 1;
  readonly requirement: ReviewBundleRequirement;
  readonly plan: string;
  readonly taskStartBaselineId: string;
  readonly attemptBaselineId: string;
  readonly fixedDiff: ReviewBundleFixedDiff;
  readonly relevantFileContentHashes: readonly ReviewBundleFileHash[];
  readonly commandEvidence: readonly ReviewBundleCommandEvidence[];
  readonly verificationLogs: readonly ReviewBundleVerificationLog[];
}

export interface ReviewBundleRecord {
  readonly bundleHash: string;
  readonly taskStartBaselineId: string;
  readonly attemptBaselineId: string;
  readonly requirementVersion: number;
  readonly fileCount: number;
  readonly commandCount: number;
}

export interface ImmutableReviewBundle {
  readonly payload: ReviewBundlePayload;
  readonly canonicalJson: string;
  readonly bundleHash: string;
  readonly reviewRecord: ReviewBundleRecord;
}

export type ConsumeReviewBundleResult =
  | { readonly ok: true; readonly bundle: ImmutableReviewBundle }
  | { readonly ok: false; readonly reason: string };

const PAYLOAD_KEYS = new Set([
  'version',
  'requirement',
  'plan',
  'taskStartBaselineId',
  'attemptBaselineId',
  'fixedDiff',
  'relevantFileContentHashes',
  'commandEvidence',
  'verificationLogs',
]);

const BUNDLE_KEYS = new Set([
  'payload',
  'canonicalJson',
  'bundleHash',
  'reviewRecord',
]);

const REVIEW_RECORD_KEYS = new Set([
  'bundleHash',
  'taskStartBaselineId',
  'attemptBaselineId',
  'requirementVersion',
  'fileCount',
  'commandCount',
]);

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function requireSha256OrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireSha256(value, label);
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requirePlainObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unexpected field: ${key}`);
    }
  }
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) {
    // Still walk children in case a frozen shell wraps mutable content.
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

function normalizeFixedDiff(value: unknown): ReviewBundleFixedDiff {
  const record = requirePlainObject(value, 'fixedDiff');
  assertExactKeys(record, new Set(['label', 'files', 'unifiedDiff']), 'fixedDiff');
  const files = record.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('fixedDiff.files must be a non-empty array');
  }
  const normalizedFiles = files.map((file, index) => {
    const entry = requirePlainObject(file, `fixedDiff.files[${index}]`);
    assertExactKeys(
      entry,
      new Set(['path', 'kind', 'beforeHash', 'afterHash']),
      `fixedDiff.files[${index}]`,
    );
    const kind = entry.kind;
    if (
      kind !== 'added' &&
      kind !== 'modified' &&
      kind !== 'deleted' &&
      kind !== 'type-changed' &&
      kind !== 'renamed'
    ) {
      throw new Error(`fixedDiff.files[${index}].kind is invalid`);
    }
    return Object.freeze({
      path: requireNonEmptyString(entry.path, `fixedDiff.files[${index}].path`),
      kind,
      beforeHash: requireSha256OrNull(
        entry.beforeHash,
        `fixedDiff.files[${index}].beforeHash`,
      ),
      afterHash: requireSha256OrNull(
        entry.afterHash,
        `fixedDiff.files[${index}].afterHash`,
      ),
    });
  });
  return Object.freeze({
    label: requireNonEmptyString(record.label, 'fixedDiff.label'),
    files: Object.freeze(normalizedFiles),
    unifiedDiff: requireNonEmptyString(record.unifiedDiff, 'fixedDiff.unifiedDiff'),
  });
}

function normalizeFileHashes(value: unknown): readonly ReviewBundleFileHash[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('relevantFileContentHashes must be a non-empty array');
  }
  return Object.freeze(
    value.map((entry, index) => {
      const record = requirePlainObject(
        entry,
        `relevantFileContentHashes[${index}]`,
      );
      assertExactKeys(
        record,
        new Set(['path', 'hash']),
        `relevantFileContentHashes[${index}]`,
      );
      return Object.freeze({
        path: requireNonEmptyString(
          record.path,
          `relevantFileContentHashes[${index}].path`,
        ),
        hash: requireSha256(
          record.hash,
          `relevantFileContentHashes[${index}].hash`,
        ),
      });
    }),
  );
}

function normalizeCommandEvidence(
  value: unknown,
): readonly ReviewBundleCommandEvidence[] {
  if (!Array.isArray(value)) {
    throw new Error('commandEvidence must be an array');
  }
  return Object.freeze(
    value.map((entry, index) => {
      const record = requirePlainObject(entry, `commandEvidence[${index}]`);
      assertExactKeys(
        record,
        new Set(['command', 'exitCode', 'cwd', 'stdoutHash', 'stderrHash']),
        `commandEvidence[${index}]`,
      );
      return Object.freeze({
        command: requireNonEmptyString(
          record.command,
          `commandEvidence[${index}].command`,
        ),
        exitCode: requireNonNegativeSafeInteger(
          record.exitCode,
          `commandEvidence[${index}].exitCode`,
        ),
        cwd: requireNonEmptyString(record.cwd, `commandEvidence[${index}].cwd`),
        stdoutHash: requireSha256(
          record.stdoutHash,
          `commandEvidence[${index}].stdoutHash`,
        ),
        stderrHash: requireSha256(
          record.stderrHash,
          `commandEvidence[${index}].stderrHash`,
        ),
      });
    }),
  );
}

function normalizeVerificationLogs(
  value: unknown,
  options: { readonly recomputeChecksums: boolean },
): readonly ReviewBundleVerificationLog[] {
  if (!Array.isArray(value)) {
    throw new Error('verificationLogs must be an array');
  }
  return Object.freeze(
    value.map((entry, index) => {
      const record = requirePlainObject(entry, `verificationLogs[${index}]`);
      assertExactKeys(
        record,
        new Set(['stream', 'sequence', 'checksum', 'text']),
        `verificationLogs[${index}]`,
      );
      const stream = record.stream;
      if (stream !== 'stdout' && stream !== 'stderr' && stream !== 'system') {
        throw new Error(`verificationLogs[${index}].stream is invalid`);
      }
      const text = requireNonEmptyString(
        record.text,
        `verificationLogs[${index}].text`,
      );
      const expectedChecksum = sha256(text);
      const claimed = requireSha256(
        record.checksum,
        `verificationLogs[${index}].checksum`,
      );
      if (options.recomputeChecksums && claimed !== expectedChecksum) {
        throw new Error(
          `verificationLogs[${index}].checksum does not match text content`,
        );
      }
      return Object.freeze({
        stream,
        sequence: requirePositiveSafeInteger(
          record.sequence,
          `verificationLogs[${index}].sequence`,
        ),
        checksum: expectedChecksum,
        text,
      });
    }),
  );
}

function normalizePayload(
  value: unknown,
  options: { readonly recomputeChecksums: boolean },
): ReviewBundlePayload {
  const record = requirePlainObject(value, 'payload');
  assertExactKeys(record, PAYLOAD_KEYS, 'payload');
  if (record.version !== 1) {
    throw new Error('payload.version must be 1');
  }
  const requirement = requirePlainObject(record.requirement, 'requirement');
  assertExactKeys(requirement, new Set(['text', 'version']), 'requirement');
  const requirementText = requireNonEmptyString(
    requirement.text,
    'requirement.text',
  );
  const requirementVersion = requirePositiveSafeInteger(
    requirement.version,
    'requirement.version',
  );
  const plan = requireNonEmptyString(record.plan, 'plan');
  const taskStartBaselineId = requireNonEmptyString(
    record.taskStartBaselineId,
    'taskStartBaselineId',
  );
  const attemptBaselineId = requireNonEmptyString(
    record.attemptBaselineId,
    'attemptBaselineId',
  );
  if (taskStartBaselineId === attemptBaselineId) {
    throw new Error('taskStartBaselineId and attemptBaselineId must differ');
  }

  return freezeDeep({
    version: 1 as const,
    requirement: Object.freeze({
      text: requirementText,
      version: requirementVersion,
    }),
    plan,
    taskStartBaselineId,
    attemptBaselineId,
    fixedDiff: normalizeFixedDiff(record.fixedDiff),
    relevantFileContentHashes: normalizeFileHashes(
      record.relevantFileContentHashes,
    ),
    commandEvidence: normalizeCommandEvidence(record.commandEvidence),
    verificationLogs: normalizeVerificationLogs(record.verificationLogs, options),
  });
}

function buildBundleFromPayload(payload: ReviewBundlePayload): ImmutableReviewBundle {
  const canonicalJson = stableJson(payload);
  const bundleHash = sha256(canonicalJson);
  const reviewRecord: ReviewBundleRecord = Object.freeze({
    bundleHash,
    taskStartBaselineId: payload.taskStartBaselineId,
    attemptBaselineId: payload.attemptBaselineId,
    requirementVersion: payload.requirement.version,
    fileCount: payload.fixedDiff.files.length,
    commandCount: payload.commandEvidence.length,
  });
  return freezeDeep({
    payload,
    canonicalJson,
    bundleHash,
    reviewRecord,
  });
}

/**
 * Build an immutable, canonically hashed review evidence bundle.
 * Mutation after construction is prevented via deep freeze.
 */
export function buildImmutableReviewBundle(
  input: ReviewBundleInput,
): ImmutableReviewBundle {
  // Build through the same normalizer used on consumption (fail-closed shape).
  const verificationLogs = (input.verificationLogs ?? []).map((entry) => ({
    stream: entry.stream,
    sequence: entry.sequence,
    text: entry.text,
    // Accept either precomputed correct checksum or recompute from text.
    checksum:
      typeof entry.checksum === 'string' && /^[0-9a-f]{64}$/.test(entry.checksum)
        ? entry.checksum
        : sha256(String(entry.text ?? '')),
  }));

  const payload = normalizePayload(
    {
      version: 1,
      requirement: input.requirement,
      plan: input.plan,
      taskStartBaselineId: input.taskStartBaselineId,
      attemptBaselineId: input.attemptBaselineId,
      fixedDiff: input.fixedDiff,
      relevantFileContentHashes: input.relevantFileContentHashes,
      commandEvidence: input.commandEvidence,
      verificationLogs,
    },
    { recomputeChecksums: true },
  );
  return buildBundleFromPayload(payload);
}

/**
 * Build an immutable review bundle from a validated candidate change-set.
 * Paths remain project-relative; absolute roots are never embedded in the
 * review-facing payload (Codex must not receive a writable canonical path).
 */
export function buildImmutableReviewBundleFromCandidateChangeSet(input: {
  readonly requirementText: string;
  readonly requirementVersion: number;
  readonly plan: string;
  readonly taskStartBaselineId: BaselineId | string;
  readonly attemptBaselineId: BaselineId | string;
  readonly changeSet: WorkspaceCandidateChangeSet;
  readonly commandEvidence?: ReviewBundleInput['commandEvidence'];
  readonly verificationLogs?: ReviewBundleInput['verificationLogs'];
}): ImmutableReviewBundle {
  const changeSet = input.changeSet;
  if (changeSet.schema !== 'triagent.workspace_change_set.v1') {
    throw new Error('candidate change-set schema is unsupported');
  }
  if (!/^[0-9a-f]{64}$/i.test(changeSet.changeSetHash)) {
    throw new Error('candidate change-set hash is malformed');
  }
  // Refuse absolute paths in the unified diff.
  if (/[A-Za-z]:[\\/]/.test(changeSet.unifiedDiff) || changeSet.unifiedDiff.includes('\\\\')) {
    if (/\n(?:---|\+\+\+)\s+[A-Za-z]:/.test(`\n${changeSet.unifiedDiff}`)) {
      throw new Error('candidate change-set unified diff must not contain absolute paths');
    }
  }

  const files = changeSet.entries.map((entry) => {
    const kind =
      entry.kind === 'add'
        ? 'added' as const
        : entry.kind === 'delete'
          ? 'deleted' as const
          : 'modified' as const;
    return Object.freeze({
      path: entry.path,
      kind,
      beforeHash: entry.beforeHash,
      afterHash: entry.afterHash,
    });
  });

  // Immutable review bundles require a non-empty fixedDiff file list. An empty
  // candidate change-set still freezes as an explicit no-op marker entry.
  const emptyMarkerHash = sha256('triagent-candidate-unchanged\n');
  const fixedFiles = files.length > 0
    ? files
    : [
        Object.freeze({
          path: '.triagent/candidate-unchanged',
          kind: 'modified' as const,
          beforeHash: emptyMarkerHash,
          afterHash: emptyMarkerHash,
        }),
      ];

  const relevantFileContentHashes = (
    changeSet.entries.length > 0
      ? changeSet.entries
          .filter((entry) => entry.afterHash !== null)
          .map((entry) =>
            Object.freeze({
              path: entry.path,
              hash: entry.afterHash!.toLowerCase(),
            }),
          )
      : [
          Object.freeze({
            path: '.triagent/candidate-unchanged',
            hash: emptyMarkerHash,
          }),
        ]
  );

  return buildImmutableReviewBundle({
    requirement: {
      text: input.requirementText,
      version: input.requirementVersion,
    },
    plan: [
      input.plan,
      `candidateChangeSetHash=${changeSet.changeSetHash}`,
      `candidateManifestHash=${changeSet.candidateManifestHash}`,
      `sourceManifestHash=${changeSet.sourceManifestHash}`,
      `workspaceId=${changeSet.workspaceId}`,
    ].join('\n'),
    taskStartBaselineId: input.taskStartBaselineId,
    attemptBaselineId: input.attemptBaselineId,
    fixedDiff: {
      label: 'source-to-candidate changes',
      files: fixedFiles,
      unifiedDiff: changeSet.unifiedDiff.length === 0
        ? 'diff --git a/.triagent/candidate-unchanged b/.triagent/candidate-unchanged\n'
        : changeSet.unifiedDiff,
    },
    relevantFileContentHashes,
    commandEvidence: input.commandEvidence ?? [],
    verificationLogs: input.verificationLogs ?? [
      {
        stream: 'system',
        sequence: 1,
        text: `candidate change-set ${changeSet.changeSetHash}`,
        checksum: sha256(`candidate change-set ${changeSet.changeSetHash}`),
      },
    ],
  });
}

/**
 * Machine-validated Codex review outcome for isolated candidate evidence.
 * Ambiguous results never permit promotion.
 */
export type CandidateReviewVerdict = 'approve' | 'rework' | 'reject';

export function classifyCandidateReviewResult(result: {
  readonly status: string;
  readonly nextAction: string;
  readonly verification?: { readonly passed: boolean };
  readonly issues?: readonly unknown[];
}):
  | { readonly ok: true; readonly verdict: CandidateReviewVerdict }
  | { readonly ok: false; readonly reason: string } {
  const status = result.status.trim().toLowerCase();
  const next = result.nextAction.trim().toLowerCase();
  const passed = result.verification?.passed;
  const issueCount = result.issues?.length ?? 0;

  if (status === 'completed' && next === 'master_validation' && passed === true && issueCount === 0) {
    return { ok: true, verdict: 'approve' };
  }
  if (
    (status === 'completed' || status === 'needs_rework')
    && (next === 'rework' || next === 'implement')
  ) {
    return { ok: true, verdict: 'rework' };
  }
  if (
    status === 'failed'
    || next === 'await_user'
    || next === 'reject'
    || (status === 'completed' && next === 'complete' && passed === false)
  ) {
    return { ok: true, verdict: 'reject' };
  }
  return {
    ok: false,
    reason: `ambiguous review outcome status=${result.status} nextAction=${result.nextAction}`,
  };
}

/**
 * Accept unknown/untrusted data, fully re-normalize every field, recompute
 * verification checksums / canonical JSON / bundle hash, validate reviewRecord
 * metadata, and return a freshly deep-frozen trusted bundle.
 */
export function consumeImmutableReviewBundle(
  bundle: unknown,
): ConsumeReviewBundleResult {
  try {
    if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
      return { ok: false, reason: 'review bundle must be an object' };
    }
    const record = bundle as Record<string, unknown>;
    assertExactKeys(record, BUNDLE_KEYS, 'review bundle');

    if (typeof record.bundleHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.bundleHash)) {
      return { ok: false, reason: 'review bundle hash is missing or malformed' };
    }
    if (typeof record.canonicalJson !== 'string' || record.canonicalJson.length === 0) {
      return { ok: false, reason: 'review bundle canonical JSON is missing' };
    }

    const payload = normalizePayload(record.payload, { recomputeChecksums: true });
    const trusted = buildBundleFromPayload(payload);

    if (trusted.canonicalJson !== record.canonicalJson) {
      return {
        ok: false,
        reason: 'review bundle canonical JSON does not match normalized payload',
      };
    }
    if (trusted.bundleHash !== record.bundleHash) {
      return {
        ok: false,
        reason: 'review bundle hash mismatch: payload integrity check failed',
      };
    }

    const reviewRecord = requirePlainObject(record.reviewRecord, 'reviewRecord');
    assertExactKeys(reviewRecord, REVIEW_RECORD_KEYS, 'reviewRecord');
    if (reviewRecord.bundleHash !== trusted.bundleHash) {
      return {
        ok: false,
        reason: 'reviewRecord.bundleHash does not match computed bundle hash',
      };
    }
    if (reviewRecord.taskStartBaselineId !== trusted.payload.taskStartBaselineId) {
      return {
        ok: false,
        reason: 'reviewRecord.taskStartBaselineId does not match payload',
      };
    }
    if (reviewRecord.attemptBaselineId !== trusted.payload.attemptBaselineId) {
      return {
        ok: false,
        reason: 'reviewRecord.attemptBaselineId does not match payload',
      };
    }
    if (reviewRecord.requirementVersion !== trusted.payload.requirement.version) {
      return {
        ok: false,
        reason: 'reviewRecord.requirementVersion does not match payload',
      };
    }
    if (reviewRecord.fileCount !== trusted.payload.fixedDiff.files.length) {
      return {
        ok: false,
        reason: 'reviewRecord.fileCount does not match payload fixedDiff.files',
      };
    }
    if (reviewRecord.commandCount !== trusted.payload.commandEvidence.length) {
      return {
        ok: false,
        reason: 'reviewRecord.commandCount does not match payload commandEvidence',
      };
    }

    return { ok: true, bundle: trusted };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? error.message
          : 'review bundle consumption failed',
    };
  }
}
