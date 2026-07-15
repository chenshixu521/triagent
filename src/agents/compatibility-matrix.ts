import {
  unknownAgentCapabilities,
  type AgentCapabilities,
  type AgentWriteMode,
} from './agent-capabilities.js';

/**
 * Exact CLI product binary name as invoked on PATH (never a marketing name).
 * Builders must key only by this + parsed version + platform.
 */
export type CompatibilityCliName = 'codex' | 'claude' | 'grok';

export interface CompatibilityKey {
  readonly cliName: CompatibilityCliName;
  readonly version: string;
  readonly platform: NodeJS.Platform;
}

/**
 * Verified capability record for an exact CLI name + version + platform.
 * Unknown features are represented as `false` / disabled — never inferred.
 */
export interface CompatibilityRecord {
  readonly key: CompatibilityKey;
  readonly verified: true;
  /** Streaming JSONL / NDJSON event protocol. */
  readonly jsonl: boolean;
  /** Structured final output via schema / --output-schema / --json-schema. */
  readonly outputSchema: boolean;
  /** Caller-supplied fixed session / conversation id. */
  readonly fixedSessionId: boolean;
  /** Resume an existing conversation after process exit. */
  readonly resume: boolean;
  /** Deliver mid-run interactive input to the live process. */
  readonly realTimeInput: boolean;
  /** Proven read-only / sandbox-restricted mode. */
  readonly readOnly: boolean;
  /** Proven project-write / workspace-write mode. */
  readonly projectWrite: boolean;
  /** Max budget / cost limit flag. */
  readonly maxBudget: boolean;
  /** Max turns limit flag. */
  readonly maxTurns: boolean;
  /** Max wall/time limit flag. */
  readonly maxTime: boolean;
  /** Non-Git project operation (skip-git / plain directory). */
  readonly nonGit: boolean;
  /** Mapped AgentCapabilities for adapters / ProjectGuard. */
  readonly capabilities: AgentCapabilities;
  /** Human-readable notes for diagnostics. */
  readonly notes: readonly string[];
}

export type WorkerStartMissingPrerequisite =
  | 'verified_capability_record'
  | 'project_guard_decision'
  | 'project_guard_mode'
  | 'budget_can_launch'
  | 'reserved_budget'
  | 'authenticated'
  | 'readiness_probe'
  | 'capability_mismatch'
  | 'expired_prerequisite'
  | 'attempt_mismatch';

/**
 * Typed evidence required before main may post `start_run` / launch a Worker.
 * Unknown, missing, expired, or mismatched fields fail closed.
 */
export interface WorkerStartPrerequisiteInput {
  readonly capabilityRecord: CompatibilityRecord | undefined;
  /** When set, must match capabilityRecord.key.cliName (exact CLI product binary). */
  readonly expectedCliName?: CompatibilityCliName;
  readonly projectGuardDecisionId: string | undefined;
  /** Guard decision mode (workspace-write / read-only / patch / …). Required non-empty. */
  readonly projectGuardMode: string | undefined;
  /** Optional attempt binding from ProjectGuard; when set must match start attempt. */
  readonly projectGuardAttemptId?: string;
  /** Attempt id for the Worker run being started (mismatch check). */
  readonly startAttemptId?: string;
  readonly budgetCanLaunch: boolean;
  /** Reserved budget identity; required non-empty when launching. */
  readonly reservedBudgetId: string | undefined;
  readonly authStatus: 'authenticated' | 'logged_out' | 'unknown' | 'error';
  readonly requiresReadinessProbe: boolean;
  readonly readinessProbeCompleted: boolean;
  /** Wall-clock expiry for the verified gate package (ms since epoch). */
  readonly expiresAtMs?: number;
  /** Clock override for tests; defaults to Date.now(). */
  readonly nowMs?: number;
}

/** Durable references retained after a successful start-gate evaluation. */
export interface WorkerStartGateRecord {
  readonly capabilityKey: CompatibilityKey;
  readonly projectGuardDecisionId: string;
  readonly projectGuardMode: string;
  readonly projectGuardAttemptId?: string;
  readonly reservedBudgetId: string;
  readonly budgetCanLaunch: true;
  readonly authStatus: 'authenticated' | 'logged_out' | 'unknown' | 'error';
  readonly requiresReadinessProbe: boolean;
  readonly readinessProbeCompleted: boolean;
}

export type WorkerStartPrerequisitesResult =
  | {
      readonly allowed: true;
      readonly missing: readonly [];
      readonly projectGuardDecisionId: string;
      readonly projectGuardMode: string;
      readonly budgetCanLaunch: true;
      readonly capabilityKey: CompatibilityKey;
      readonly reservedBudgetId: string;
      readonly gate: WorkerStartGateRecord;
    }
  | {
      readonly allowed: false;
      readonly missing: readonly WorkerStartMissingPrerequisite[];
      readonly projectGuardDecisionId?: string;
      readonly projectGuardMode?: string;
      readonly budgetCanLaunch: boolean;
      readonly capabilityKey?: CompatibilityKey;
      readonly reservedBudgetId?: string;
    };

function freezeCapabilities(
  partial: AgentCapabilities,
): AgentCapabilities {
  return Object.freeze({
    ...partial,
    writeModes: Object.freeze([...partial.writeModes]) as readonly AgentWriteMode[],
  });
}

function record(
  key: CompatibilityKey,
  fields: Omit<CompatibilityRecord, 'key' | 'verified' | 'capabilities'> & {
    readonly capabilities: AgentCapabilities;
  },
): CompatibilityRecord {
  return Object.freeze({
    key: Object.freeze({ ...key }),
    verified: true as const,
    jsonl: fields.jsonl,
    outputSchema: fields.outputSchema,
    fixedSessionId: fields.fixedSessionId,
    resume: fields.resume,
    realTimeInput: fields.realTimeInput,
    readOnly: fields.readOnly,
    projectWrite: fields.projectWrite,
    maxBudget: fields.maxBudget,
    maxTurns: fields.maxTurns,
    maxTime: fields.maxTime,
    nonGit: fields.nonGit,
    capabilities: freezeCapabilities(fields.capabilities),
    notes: Object.freeze([...fields.notes]),
  });
}

function keyString(key: CompatibilityKey): string {
  return `${key.cliName}@${key.version}@${key.platform}`;
}

/**
 * Current verified contracts (Task 13).
 * Exact versions only — builders later must consume these records, never
 * invent flags from the product name alone.
 */
const VERIFIED_RECORDS: readonly CompatibilityRecord[] = [
  // Codex CLI 0.144.1 — exec JSONL, output schema, resume, sandbox, non-Git.
  ...(['win32', 'darwin', 'linux'] as const).map((platform) =>
    record(
      { cliName: 'codex', version: '0.144.1', platform },
      {
        jsonl: true,
        outputSchema: true,
        fixedSessionId: false,
        resume: true,
        realTimeInput: false,
        readOnly: true,
        projectWrite: true,
        maxBudget: false,
        maxTurns: false,
        maxTime: false,
        nonGit: true,
        capabilities: freezeCapabilities({
          fixedSessionId: false,
          resume: true,
          structuredOutput: true,
          streamJson: true,
          realTimeInput: false,
          nativeSandbox: true,
          nativePermissionRules: true,
          budgetLimit: false,
          turnLimit: false,
          timeLimit: false,
          nonGitProjects: true,
          writeModes: ['read-only', 'workspace-write'],
        }),
        notes: [
          'codex exec --json --output-schema; sandbox -s workspace-write|read-only -a never',
          'resume via codex exec resume <id> with reapplied constraints',
          'non-Git: --skip-git-repo-check',
        ],
      },
    ),
  ),
  // Claude Code 2.1.206 — stream-json, session-id, resume, schema content, tools.
  // projectWrite=false: no proven project-scoped write sandbox; patch_mode only.
  ...(['win32', 'darwin', 'linux'] as const).map((platform) =>
    record(
      { cliName: 'claude', version: '2.1.206', platform },
      {
        jsonl: true,
        outputSchema: true,
        fixedSessionId: true,
        resume: true,
        realTimeInput: false,
        readOnly: true,
        projectWrite: false,
        maxBudget: false,
        maxTurns: false,
        maxTime: false,
        nonGit: true,
        capabilities: freezeCapabilities({
          fixedSessionId: true,
          resume: true,
          structuredOutput: true,
          streamJson: true,
          realTimeInput: false,
          nativeSandbox: false,
          nativePermissionRules: true,
          budgetLimit: false,
          turnLimit: false,
          timeLimit: false,
          nonGitProjects: true,
          writeModes: ['read-only'],
        }),
        notes: [
          'claude -p --safe-mode --output-format stream-json --verbose --input-format text --session-id --json-schema <CONTENT>',
          'resume via --resume <conversation-id> with reattached safe-mode/tools/schema',
          'project-write not proven; implementer uses patch_mode only',
          'prompt via stdin; never argv',
        ],
      },
    ),
  ),
  // Grok CLI 0.2.93 — offline help proves syntax only (`grok --help` / inspect).
  // DO NOT claim readOnly / nativePermissionRules / writeModes until a persisted
  // opt-in disposable-project enforcement proof is loaded (TRIAGENT_REAL_AI_TESTS=1).
  // projectWrite=false: --sandbox PROFILE values unproven; never --always-approve.
  // outputSchema=false: --json-schema conflicts with streaming-json baseline.
  // Default: live project access unproven; reviewer/master require immutable review bundle.
  ...(['win32', 'darwin', 'linux'] as const).map((platform) =>
    record(
      { cliName: 'grok', version: '0.2.93', platform },
      {
        jsonl: true,
        outputSchema: false,
        fixedSessionId: true,
        resume: true,
        realTimeInput: false,
        // Help flags prove syntax only — not enforcement against a live project.
        readOnly: false,
        projectWrite: false,
        maxBudget: false,
        maxTurns: true,
        maxTime: false,
        nonGit: true,
        capabilities: freezeCapabilities({
          fixedSessionId: true,
          resume: true,
          structuredOutput: false,
          streamJson: true,
          realTimeInput: false,
          nativeSandbox: false,
          // Permission-mode / tools flags exist; enforcement unproven without live proof.
          nativePermissionRules: false,
          budgetLimit: false,
          turnLimit: true,
          timeLimit: false,
          nonGitProjects: true,
          // Empty until persisted opt-in disposable-project proof elevates the profile.
          writeModes: [],
        }),
        notes: [
          'grok --cwd --output-format streaming-json --session-id --permission-mode auto|plan',
          'prompt via --prompt-file (outside project); avoid --single prompt in argv',
          'resume via --resume <id> with reattached permission/tools/max-turns',
          'max-turns verified; --always-approve and --sandbox not claimed',
          'tool filter via --tools/--disallowed-tools (Claude Code compatible names)',
          'DEFAULT: readOnly=false nativePermissionRules=false writeModes=[] — help proves syntax only',
          'liveProjectAccess=false until immutable review bundle + optional enforcement proof',
          'project-write disabled; implementer project_write/patch against live project denied',
          'auth may be unknown without model call; require readiness probe',
        ],
      },
    ),
  ),
];

const MATRIX = new Map<string, CompatibilityRecord>(
  VERIFIED_RECORDS.map((entry) => [keyString(entry.key), entry]),
);

/**
 * Process-local records created only after the current executable passed the
 * declarative no-model compatibility probe (or a matching cache receipt).
 * Static records remain the trust anchor and can never be overwritten here.
 */
const RUNTIME_MATRIX = new Map<string, CompatibilityRecord>();

function freezeCompatibilityRecord(
  entry: CompatibilityRecord,
): CompatibilityRecord {
  return record(
    entry.key,
    {
      jsonl: entry.jsonl,
      outputSchema: entry.outputSchema,
      fixedSessionId: entry.fixedSessionId,
      resume: entry.resume,
      realTimeInput: entry.realTimeInput,
      readOnly: entry.readOnly,
      projectWrite: entry.projectWrite,
      maxBudget: entry.maxBudget,
      maxTurns: entry.maxTurns,
      maxTime: entry.maxTime,
      nonGit: entry.nonGit,
      capabilities: entry.capabilities,
      notes: entry.notes,
    },
  );
}

/**
 * Register an invariant-checked runtime record for downstream immutable-key
 * lookups. Static keys cannot be replaced, and callers never register raw
 * cache JSON — the resolver reconstructs records from code-owned baselines.
 */
export function registerRuntimeCompatibility(
  entry: CompatibilityRecord,
): CompatibilityRecord {
  assertCompatibilityRecordInvariants(entry);
  const mapKey = keyString(entry.key);
  const builtIn = MATRIX.get(mapKey);
  if (builtIn !== undefined) {
    return builtIn;
  }
  const frozen = freezeCompatibilityRecord(entry);
  RUNTIME_MATRIX.set(mapKey, frozen);
  return frozen;
}

/** Test isolation only; production never clears verified runtime records. */
export function clearRuntimeCompatibilityForTests(): void {
  RUNTIME_MATRIX.clear();
}

export function lookupCompatibility(
  key: CompatibilityKey,
): CompatibilityRecord | undefined {
  const mapKey = keyString(key);
  const found = MATRIX.get(mapKey) ?? RUNTIME_MATRIX.get(mapKey);
  if (found === undefined) return undefined;
  // Grok static matrix stays enforcement-unproven unless process-local proof is loaded.
  if (found.key.cliName === 'grok') {
    // Lazy import avoided: apply via resolve helper registered by grok-enforcement-proof.
    const elevate = grokProofElevator;
    if (elevate !== undefined) {
      return elevate(found);
    }
  }
  return found;
}

/**
 * Optional elevator for Grok enforcement proofs (registered by grok-enforcement-proof).
 * Keeps matrix free of circular imports while allowing opt-in elevation.
 */
type GrokProofElevator = (record: CompatibilityRecord) => CompatibilityRecord;
let grokProofElevator: GrokProofElevator | undefined;

export function registerGrokCompatibilityElevator(
  elevator: GrokProofElevator | undefined,
): void {
  grokProofElevator = elevator;
}

/**
 * Fail closed: unknown CLI name / version / platform is disabled.
 * Command builders must call this (or lookup + explicit handling) and must not
 * invent flags from product name alone.
 */
export function requireVerifiedCompatibility(
  key: CompatibilityKey,
): CompatibilityRecord {
  const found = lookupCompatibility(key);
  if (found === undefined) {
    throw new Error(
      `unverified compatibility record disabled: ${key.cliName}@${key.version}@${key.platform}`,
    );
  }
  return found;
}

export function listVerifiedCompatibility(): readonly CompatibilityRecord[] {
  return VERIFIED_RECORDS;
}

/**
 * ProjectGuard + BudgetController approval prerequisites that must be true
 * before a Worker may receive `start_run`. Capability records alone are not
 * sufficient — callers must attach verified matrix, guard decision, and budget.
 *
 * Fail closed: unknown / missing / expired / mismatched prerequisites never
 * allow Worker or ProcessHost launch.
 */
export function workerStartPrerequisites(
  input: WorkerStartPrerequisiteInput,
): WorkerStartPrerequisitesResult {
  const missing: WorkerStartMissingPrerequisite[] = [];
  const nowMs = input.nowMs ?? Date.now();

  if (input.capabilityRecord === undefined || !input.capabilityRecord.verified) {
    missing.push('verified_capability_record');
  } else if (
    input.expectedCliName !== undefined
    && input.capabilityRecord.key.cliName !== input.expectedCliName
  ) {
    missing.push('capability_mismatch');
  }

  if (
    input.projectGuardDecisionId === undefined
    || input.projectGuardDecisionId.trim().length === 0
  ) {
    missing.push('project_guard_decision');
  }
  if (
    input.projectGuardMode === undefined
    || input.projectGuardMode.trim().length === 0
  ) {
    missing.push('project_guard_mode');
  }
  if (!input.budgetCanLaunch) {
    missing.push('budget_can_launch');
  }
  if (
    input.reservedBudgetId === undefined
    || input.reservedBudgetId.trim().length === 0
  ) {
    missing.push('reserved_budget');
  }
  if (input.authStatus === 'logged_out' || input.authStatus === 'error') {
    missing.push('authenticated');
  }
  if (input.requiresReadinessProbe && !input.readinessProbeCompleted) {
    missing.push('readiness_probe');
  }
  if (
    input.expiresAtMs !== undefined
    && Number.isFinite(input.expiresAtMs)
    && nowMs > input.expiresAtMs
  ) {
    missing.push('expired_prerequisite');
  }
  if (
    input.projectGuardAttemptId !== undefined
    && input.projectGuardAttemptId.trim().length > 0
    && input.startAttemptId !== undefined
    && input.projectGuardAttemptId !== input.startAttemptId
  ) {
    missing.push('attempt_mismatch');
  }

  if (missing.length > 0) {
    return {
      allowed: false,
      missing: Object.freeze([...missing]),
      ...(input.projectGuardDecisionId === undefined
        || input.projectGuardDecisionId.trim().length === 0
        ? {}
        : { projectGuardDecisionId: input.projectGuardDecisionId }),
      ...(input.projectGuardMode === undefined
        || input.projectGuardMode.trim().length === 0
        ? {}
        : { projectGuardMode: input.projectGuardMode }),
      budgetCanLaunch: input.budgetCanLaunch,
      ...(input.capabilityRecord === undefined
        ? {}
        : { capabilityKey: input.capabilityRecord.key }),
      ...(input.reservedBudgetId === undefined
        || input.reservedBudgetId.trim().length === 0
        ? {}
        : { reservedBudgetId: input.reservedBudgetId }),
    };
  }

  const record = input.capabilityRecord as CompatibilityRecord;
  const projectGuardDecisionId = input.projectGuardDecisionId as string;
  const projectGuardMode = input.projectGuardMode as string;
  const reservedBudgetId = input.reservedBudgetId as string;
  const gate: WorkerStartGateRecord = Object.freeze({
    capabilityKey: Object.freeze({ ...record.key }),
    projectGuardDecisionId,
    projectGuardMode,
    ...(input.projectGuardAttemptId === undefined
      || input.projectGuardAttemptId.trim().length === 0
      ? {}
      : { projectGuardAttemptId: input.projectGuardAttemptId }),
    reservedBudgetId,
    budgetCanLaunch: true as const,
    authStatus: input.authStatus,
    requiresReadinessProbe: input.requiresReadinessProbe,
    readinessProbeCompleted: input.readinessProbeCompleted,
  });

  return {
    allowed: true,
    missing: Object.freeze([]) as readonly [],
    projectGuardDecisionId,
    projectGuardMode,
    budgetCanLaunch: true,
    capabilityKey: record.key,
    reservedBudgetId,
    gate,
  };
}

/**
 * Matrix + AgentCapabilities internal consistency for every verified record.
 * Throws when fields disagree (unknown must stay disabled on both sides).
 */
export function assertCompatibilityRecordInvariants(
  entry: CompatibilityRecord,
): void {
  const caps = entry.capabilities;
  if (entry.outputSchema !== caps.structuredOutput) {
    throw new Error(
      `compatibility invariant: outputSchema (${String(entry.outputSchema)}) `
        + `!= structuredOutput (${String(caps.structuredOutput)}) for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (entry.jsonl !== caps.streamJson) {
    throw new Error(
      `compatibility invariant: jsonl != streamJson for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (entry.fixedSessionId !== caps.fixedSessionId) {
    throw new Error(
      `compatibility invariant: fixedSessionId mismatch for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (entry.resume !== caps.resume) {
    throw new Error(
      `compatibility invariant: resume mismatch for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (entry.realTimeInput !== caps.realTimeInput) {
    throw new Error(
      `compatibility invariant: realTimeInput mismatch for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (entry.maxBudget !== caps.budgetLimit) {
    throw new Error(
      `compatibility invariant: maxBudget != budgetLimit for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (entry.maxTurns !== caps.turnLimit) {
    throw new Error(
      `compatibility invariant: maxTurns != turnLimit for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (entry.maxTime !== caps.timeLimit) {
    throw new Error(
      `compatibility invariant: maxTime != timeLimit for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (entry.nonGit !== caps.nonGitProjects) {
    throw new Error(
      `compatibility invariant: nonGit != nonGitProjects for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (entry.readOnly && !caps.writeModes.includes('read-only')) {
    throw new Error(
      `compatibility invariant: readOnly true but writeModes lacks read-only for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (entry.projectWrite && !caps.writeModes.includes('workspace-write')) {
    throw new Error(
      `compatibility invariant: projectWrite true but writeModes lacks workspace-write for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  if (!entry.projectWrite && caps.writeModes.includes('workspace-write')) {
    throw new Error(
      `compatibility invariant: projectWrite false but writeModes includes workspace-write for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
  // Unknown / unproven features must stay disabled (never optimistic).
  if (!entry.outputSchema && caps.structuredOutput) {
    throw new Error(
      `compatibility invariant: structuredOutput enabled without outputSchema for `
        + `${entry.key.cliName}@${entry.key.version}`,
    );
  }
}

/** Convenience: disabled / unknown capabilities for unlisted versions. */
export function disabledCapabilities(): AgentCapabilities {
  return unknownAgentCapabilities();
}
