import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import {
  type CompatibilityKey,
  type CompatibilityRecord,
  type WorkerStartGateRecord,
} from '../compatibility-matrix.js';
import type { AttemptId, TaskId } from '../../domain/ids.js';
import type { AgentRole } from '../../domain/task.js';
import {
  type ImmutableReviewBundleRef,
  validateImmutableReviewBundleRef,
} from '../../protocol/immutable-review-bundle.js';
import type {
  PromptArtifactCleanupResult,
  PromptArtifactRef,
} from './prompt-artifact-store.js';

/**
 * Guard / adapter profile modes relevant to Grok command building.
 * project_write is never proven for Grok live project.
 * workspace_write is only for app-owned isolated candidate workspaces.
 * Live-project reviewer/master/patch is denied; only immutable review bundle cwd
 * unless isolated_implementation authorization is present.
 */
export type GrokGuardMode =
  | 'project_write'
  | 'workspace_write'
  | 'read_only'
  | 'patch_mode'
  | 'auto_allowed'
  | 'disabled';

export type GrokCommandOperation = 'start' | 'resume';

/**
 * Tool names used when running against an immutable review bundle.
 * Help proves flag syntax only — not live-project enforcement.
 */
export const GROK_VERIFIED_READ_ONLY_TOOLS = Object.freeze([
  'Read',
  'Glob',
  'Grep',
] as const);

export const GROK_VERIFIED_DISALLOWED_WRITE_TOOLS = Object.freeze([
  'Edit',
  'Write',
  'Bash',
  'Shell',
  'MultiEdit',
  'NotebookEdit',
] as const);

/**
 * Isolated candidate implementation: inspect + edit/write only.
 * Shell, install, web, subagent, and MCP-capable tools stay denied.
 */
export const GROK_ISOLATED_IMPLEMENTATION_ALLOWED_TOOLS = Object.freeze([
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
] as const);

export const GROK_ISOLATED_IMPLEMENTATION_DENIED_TOOLS = Object.freeze([
  'Bash',
  'Shell',
  'MultiEdit',
  'NotebookEdit',
  'WebSearch',
  'WebFetch',
  'Task',
  'Agent',
  'MCP',
  'BashOutput',
  'KillShell',
] as const);

export interface IsolatedImplementationWorkspaceRef {
  readonly workspaceRoot: string;
  readonly authorizationId: string;
  readonly sourceManifestHash: string;
}

/** Static baseline Grok CLI version used by the compatibility matrix. */
export const VERIFIED_GROK_VERSION = '0.2.93';

/**
 * Project-write automatic mode remains disabled for Grok 0.2.93:
 * help proves `--sandbox <PROFILE>` exists but profile values are not proven
 * offline; `--always-approve` is never equated with an OS sandbox.
 */
export const GROK_PROJECT_WRITE_AUTO_PROVEN = false;

/**
 * `--always-approve` is present in help but must not be emitted until exact
 * compatibility + ProjectGuard enforcement are objectively proven.
 */
export const GROK_ALWAYS_APPROVE_PROVEN = false;

/**
 * Sandbox profile values are not proven offline for 0.2.93; never emit `--sandbox`.
 */
export const GROK_SANDBOX_PROFILE_PROVEN = false;

/**
 * Live-project enforcement of plan/tools is unproven until opt-in disposable
 * project proof is loaded. Default matrix keeps readOnly=false.
 */
export const GROK_LIVE_PROJECT_ENFORCEMENT_PROVEN = false;

/** Hard bound for prompt-file content (512 KiB). */
export const GROK_PROMPT_FILE_MAX_BYTES = 512 * 1024;

/** Default adapter-observable max turns when turnLimit is verified. */
export const GROK_DEFAULT_MAX_TURNS = 32;

/** Bounded retries when unlink hits EPERM/EACCES before fail-closed. */
export const GROK_PROMPT_CLEANUP_MAX_ATTEMPTS = 5;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidGrokSessionUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export interface GrokCommandInput {
  readonly capabilityKey: CompatibilityKey;
  /** Exact verified matrix record; undefined ⇒ AdapterDisabled. */
  readonly capabilityRecord: CompatibilityRecord | undefined;
  /** Live project root — used only for isolation checks, never as --cwd. */
  readonly projectRoot: string;
  readonly role: AgentRole;
  readonly mode: GrokGuardMode;
  readonly nonGit: boolean;
  readonly schemaPath: string;
  readonly projectGuardDecisionId: string;
  readonly reservedBudgetId: string;
  readonly budgetAttemptId: AttemptId;
  readonly operation: GrokCommandOperation;
  readonly conversationId?: string;
  /**
   * Fixed session UUID for start. Must be a valid UUID when provided.
   * When omitted on start, builder generates one (capability.fixedSessionId).
   */
  readonly sessionId?: string;
  /**
   * Prompt text length check only. The pure builder never writes this to disk
   * and never places it on argv. Delivery is always via an already-verified
   * PromptArtifactRef (adapter creates after LaunchAuthorization).
   */
  readonly prompt?: string;
  /**
   * When true (default), use --prompt-file. Setting false is rejected so
   * secrets never appear in process argv via --single.
   */
  readonly promptViaFile?: boolean;
  /** Optional max turns when capability.maxTurns is verified. */
  readonly maxTurns?: number;
  /**
   * Already-verified secure prompt artifact. Required for live argv builds.
   * Pure builder performs zero filesystem/ACL/process work on this ref —
   * it only reads path + sha256. Adapter creates via SecurePromptArtifactStore
   * after consumeAndVerify(LaunchAuthorization).
   * When omitted, builder emits structural dry-run with [PENDING_PROMPT_FILE].
   */
  readonly promptArtifact?: PromptArtifactRef;
  /** Optional executable override (tests); default `grok`. */
  readonly executable?: string;
  /**
   * Narrow immutable review bundle ref (Task 17 builds full bundles).
   * Required for review/master/patch Grok runs: --cwd routes only to this bundle.
   * Not used for isolated_implementation workspace_write.
   */
  readonly immutableReviewBundle?: ImmutableReviewBundleRef;
  /**
   * App-owned candidate workspace for Grok implementer workspace_write.
   * --cwd routes only to this root; live projectWrite remains unproven.
   */
  readonly isolatedWorkspace?: IsolatedImplementationWorkspaceRef;
  /**
   * Task id bound into the permission-profile hash for resume equivalence.
   * Required for persisted profile identity; defaults empty only for pure
   * structural unit tests that do not exercise resume hashing.
   */
  readonly taskId?: TaskId | string;
}

export interface GrokRunIntent {
  readonly capabilityKey: CompatibilityKey;
  readonly projectGuardDecisionId: string;
  readonly reservedBudgetId: string;
  readonly budgetAttemptId: AttemptId;
  /** Task binding for resume permission-profile equivalence. */
  readonly taskId: string;
  readonly role: AgentRole;
  readonly mode: GrokGuardMode;
  readonly permissionMode: 'auto' | 'plan';
  readonly schemaPath: string;
  readonly nonGit: boolean;
  /** Live project root (isolation only; not --cwd). */
  readonly projectRoot: string;
  /** Candidate workspace or immutable bundle root used as --cwd. */
  readonly cwd: string;
  readonly liveProjectAccess: false;
  /** Matrix still unproven unless loaded proof elevates; command may still run on bundle. */
  readonly enforcementProven: boolean;
  readonly operation: GrokCommandOperation;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly maxTurns: number;
  /** When true, implementer returns structured patch; PatchApplier is sole writer. */
  readonly structuredPatchRequired: boolean;
  /** Always prompt-file for Grok 0.2.93 (verified --prompt-file). */
  readonly promptDelivery: 'prompt-file';
  readonly promptFilePath: string;
  readonly promptFileSha256: string;
  readonly immutableReviewBundleHash: string;
  /** Opaque workspace authorization id when mode is workspace_write. */
  readonly workspaceAuthorizationId?: string;
  readonly sourceManifestHash?: string;
}

export interface GrokPermissionProfile {
  readonly projectRoot: string;
  readonly cwd: string;
  readonly permissionMode: 'auto' | 'plan';
  readonly outputFormat: 'streaming-json';
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly maxTurns: number;
  readonly nonGit: boolean;
  readonly alwaysApprove: false;
  readonly sandboxEmitted: false;
  readonly liveProjectAccess: false;
  readonly enforcementProven: boolean;
  /** Task id bound into resume equivalence. */
  readonly taskId: string;
  /** Role bound into resume equivalence (start must match resume). */
  readonly role: AgentRole;
  /** Effective guard mode after resolveGrokEffectiveMode. */
  readonly effectiveMode: GrokGuardMode;
  /** Prompt delivery channel (always prompt-file for 0.2.93). */
  readonly promptDelivery: 'prompt-file';
  /** Immutable review bundle manifest content hash (execution root identity). */
  readonly immutableReviewBundleHash: string;
  /** Capability version bound into the profile. */
  readonly adapterVersion: string;
  /** Capability platform bound into the profile. */
  readonly adapterPlatform: string;
  /** Capability CLI name (must be grok). */
  readonly adapterCliName: string;
  /** Guard decision id binding. */
  readonly projectGuardDecisionId: string;
  /** Budget reservation id binding. */
  readonly reservedBudgetId: string;
}

/** Re-export store cleanup result for adapter/session call sites. */
export type GrokPromptCleanupResult = PromptArtifactCleanupResult;

export type GrokCommandBuildResult =
  | {
      readonly ok: true;
      readonly executable: string;
      readonly args: readonly string[];
      readonly intent: GrokRunIntent;
      /**
       * Redacted argv suitable for persistence / diagnostics.
       * Prompt-file path is replaced with [REDACTED_PROMPT_FILE].
       * Prompt text is never present on argv.
       */
      readonly argsForEvidence: readonly string[];
      /** Absolute path of the secure outside-project prompt file (cleanup after run). */
      readonly promptFilePath: string;
      /**
       * Cleanup helper: unlink prompt file with bounded EPERM retries.
       * Does not swallow permanent permission failures.
       */
      readonly cleanupPromptFile: () => GrokPromptCleanupResult;
    }
  | {
      readonly ok: false;
      readonly code: 'AdapterDisabled';
      readonly reason: string;
    };

export class AdapterDisabledError extends Error {
  public override readonly name = 'AdapterDisabledError';
  public readonly code = 'AdapterDisabled' as const;

  public constructor(reason: string) {
    super(reason);
  }
}

export class SensitiveArtifactCleanupError extends Error {
  public override readonly name = 'SensitiveArtifactCleanupError';
  public readonly code = 'sensitive_artifact_cleanup_failed' as const;
  public readonly pathRedacted: string;

  public constructor(reason: string, pathRedacted: string) {
    super(reason);
    this.pathRedacted = pathRedacted;
  }
}

function capabilityKeysEqual(a: CompatibilityKey, b: CompatibilityKey): boolean {
  return (
    a.cliName === b.cliName
    && a.version === b.version
    && a.platform === b.platform
  );
}

function disabled(reason: string): GrokCommandBuildResult {
  return { ok: false, code: 'AdapterDisabled', reason };
}

function redactPromptPath(path: string): string {
  // Evidence only: never expose full predictable path with secrets.
  const base = path.split(/[/\\]/).pop() ?? 'prompt';
  return `[REDACTED_PROMPT_DIR]/${base}`;
}

/** Pure string path-prefix check (no realpath / lstat / ACL). */
function isPathPrefix(root: string, candidate: string): boolean {
  const rootNorm = root.trim().replace(/[/\\]+$/g, '').toLowerCase();
  const candNorm = candidate.trim().replace(/[/\\]+$/g, '').toLowerCase();
  if (rootNorm.length === 0 || candNorm.length === 0) return false;
  if (candNorm === rootNorm) return true;
  const sep = rootNorm.includes('\\') || candNorm.includes('\\') ? '\\' : '/';
  // Accept either separator for cross-platform structural checks.
  const roots = [rootNorm, rootNorm.replaceAll('\\', '/'), rootNorm.replaceAll('/', '\\')];
  for (const r of roots) {
    if (candNorm === r) return true;
    if (candNorm.startsWith(r + '\\') || candNorm.startsWith(r + '/')) return true;
  }
  void sep;
  return false;
}


/**
 * Resolve effective guard mode for Grok.
 * project_write auto is not proven → fail closed.
 * workspace_write is only for isolated candidate roots (builder validates ref).
 * Live-project patch/read is also denied at command layer without immutable bundle.
 */
export function resolveGrokEffectiveMode(
  role: AgentRole,
  mode: GrokGuardMode,
): GrokGuardMode | undefined {
  if (mode === 'disabled') return undefined;
  if (role === 'reviewer' || role === 'master') {
    if (mode === 'project_write' || mode === 'workspace_write') return undefined;
    return 'read_only';
  }
  // implementer
  if (mode === 'project_write') {
    if (!GROK_PROJECT_WRITE_AUTO_PROVEN) return undefined;
    return 'project_write';
  }
  if (mode === 'workspace_write') {
    return 'workspace_write';
  }
  if (mode === 'auto_allowed') {
    // Prefer patch_mode only when an immutable bundle is supplied (builder checks).
    return 'patch_mode';
  }
  if (mode === 'patch_mode' || mode === 'read_only') return mode;
  return undefined;
}

/**
 * Canonical permission-profile hash for session evidence binding.
 * Resume must recompute the current profile and require exact equality with
 * the stored completed_persisted hash. Fresh launch auth is necessary but not
 * sufficient when any stable security field diverges.
 *
 * Intentionally excludes per-launch identifiers (projectGuardDecisionId,
 * reservedBudgetId): those are fresh bindings on every resume attempt and are
 * validated separately via one-time LaunchAuthorization consume.
 */
export function hashGrokPermissionProfile(
  profile: Pick<
    GrokPermissionProfile,
    | 'permissionMode'
    | 'allowedTools'
    | 'disallowedTools'
    | 'maxTurns'
    | 'alwaysApprove'
    | 'sandboxEmitted'
    | 'liveProjectAccess'
    | 'enforcementProven'
    | 'taskId'
    | 'role'
    | 'effectiveMode'
    | 'promptDelivery'
    | 'outputFormat'
    | 'cwd'
    | 'immutableReviewBundleHash'
    | 'adapterVersion'
    | 'adapterPlatform'
    | 'adapterCliName'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        taskId: profile.taskId,
        adapterCliName: profile.adapterCliName,
        adapterVersion: profile.adapterVersion,
        adapterPlatform: profile.adapterPlatform,
        role: profile.role,
        effectiveMode: profile.effectiveMode,
        permissionMode: profile.permissionMode,
        outputFormat: profile.outputFormat,
        promptDelivery: profile.promptDelivery,
        maxTurns: profile.maxTurns,
        allowedTools: profile.allowedTools,
        disallowedTools: profile.disallowedTools,
        cwd: profile.cwd,
        immutableReviewBundleHash: profile.immutableReviewBundleHash,
        alwaysApprove: profile.alwaysApprove,
        sandboxEmitted: profile.sandboxEmitted,
        liveProjectAccess: profile.liveProjectAccess,
        enforcementProven: profile.enforcementProven,
      }),
      'utf8',
    )
    .digest('hex');
}

/**
 * Pure cleanup helper for unit tests that inject unlink failures.
 * Production cleanup is PromptArtifactRef.cleanup from the store.
 */
export function cleanupGrokPromptArtifact(options: {
  readonly filePath: string;
  readonly stagingDir?: string;
  readonly maxAttempts?: number;
  readonly unlinkImpl?: (path: string) => void;
  readonly rmdirImpl?: (path: string) => void;
}): GrokPromptCleanupResult {
  // Lazy import kept out of the pure build path: this function is only used by
  // unit tests that simulate EPERM. buildGrokCommand never calls it.
  // Inline minimal fail-closed loop without filesystem imports when injectors set.
  const maxAttempts = options.maxAttempts ?? GROK_PROMPT_CLEANUP_MAX_ATTEMPTS;
  const unlink = options.unlinkImpl;
  if (unlink === undefined) {
    return {
      ok: false,
      code: 'sensitive_artifact_cleanup_failed',
      reason:
        'sensitive_artifact_cleanup_failed: pure cleanupGrokPromptArtifact requires '
        + 'unlinkImpl (use PromptArtifactRef.cleanup from SecurePromptArtifactStore)',
      pathRedacted: redactPromptPath(options.filePath),
    };
  }
  const redacted = redactPromptPath(options.filePath);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      unlink(options.filePath);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        lastError = undefined;
        break;
      }
      const isPerm =
        error !== null
        && typeof error === 'object'
        && ((error as { code?: unknown }).code === 'EPERM'
          || (error as { code?: unknown }).code === 'EACCES');
      if (!isPerm || attempt === maxAttempts) {
        return {
          ok: false,
          code: 'sensitive_artifact_cleanup_failed',
          reason:
            `sensitive_artifact_cleanup_failed: cannot unlink prompt file `
            + `(attempt ${attempt}/${maxAttempts}): `
            + (error instanceof Error ? error.message : String(error)),
          pathRedacted: redacted,
        };
      }
    }
  }
  if (lastError !== undefined) {
    return {
      ok: false,
      code: 'sensitive_artifact_cleanup_failed',
      reason:
        'sensitive_artifact_cleanup_failed: prompt file cleanup exhausted retries',
      pathRedacted: redacted,
    };
  }
  if (options.stagingDir !== undefined && options.rmdirImpl !== undefined) {
    try {
      options.rmdirImpl(options.stagingDir);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
        const isPerm =
          error !== null
          && typeof error === 'object'
          && ((error as { code?: unknown }).code === 'EPERM'
            || (error as { code?: unknown }).code === 'EACCES');
        if (isPerm) {
          return {
            ok: false,
            code: 'sensitive_artifact_cleanup_failed',
            reason:
              'sensitive_artifact_cleanup_failed: cannot remove prompt staging dir: '
              + (error instanceof Error ? error.message : String(error)),
            pathRedacted: redacted,
          };
        }
      }
    }
  }
  return { ok: true };
}

/**
 * @deprecated Adapter/store create verified PromptArtifactRef. Kept as a typed
 * error factory for tests that previously called createGrokPromptFile with a
 * directory under projectRoot — pure builder never creates files.
 */
export function createGrokPromptFile(options: {
  readonly prompt: string;
  readonly projectRoot: string;
  readonly directory?: string;
  readonly maxBytes?: number;
}): never {
  void options;
  throw new AdapterDisabledError(
    'AdapterDisabled: createGrokPromptFile is not used by the pure builder; '
      + 'SecurePromptArtifactStore creates verified PromptArtifactRef after '
      + 'LaunchAuthorization (outside projectRoot; no insecure fallback)',
  );
}

/**
 * Pure structural Grok argv builder for a record whose current command
 * contract was verified by the static matrix or runtime help probes.
 * Zero filesystem / ACL / process work. Consumes an already-verified
 * PromptArtifactRef when present; otherwise emits [PENDING_PROMPT_FILE]
 * for dry-run validation (auth-before-prompt).
 * Never returns a shell string. Never adds --always-approve or unproven --sandbox.
 * --cwd is ALWAYS the immutable review bundle root — never the live project.
 *
 * Start contract:
 *   grok --cwd <immutable-bundle> --prompt-file <path> --output-format streaming-json
 *     --session-id <uuid> --permission-mode auto|plan
 *     --tools Read,Glob,Grep --disallowed-tools Edit,Write,Bash,...
 *     --max-turns <N>
 */
export function buildGrokCommand(
  input: GrokCommandInput,
): GrokCommandBuildResult {
  const record = input.capabilityRecord;
  if (record === undefined || !record.verified) {
    return disabled(
      `AdapterDisabled: unverified Grok compatibility record `
        + '(require verified requested version on matching platform)',
    );
  }
  if (record.key.cliName !== 'grok') {
    return disabled(
      `AdapterDisabled: capability record cliName is ${record.key.cliName}, not grok`,
    );
  }
  if (!capabilityKeysEqual(record.key, input.capabilityKey)) {
    return disabled(
      'AdapterDisabled: capabilityKey does not match verified capability record',
    );
  }
  if (record.key.platform !== process.platform) {
    return disabled(
      `AdapterDisabled: capability platform ${record.key.platform} `
        + `does not match runtime ${process.platform}`,
    );
  }
  // jsonl required. readOnly may remain false (help ≠ enforcement) when using bundle.
  if (!record.jsonl) {
    return disabled(
      'AdapterDisabled: verified record lacks required jsonl streaming contract',
    );
  }
  if (input.operation === 'resume' && !record.resume) {
    return disabled('AdapterDisabled: resume is not verified for this Grok version');
  }
  if (input.operation === 'start' && !record.fixedSessionId) {
    return disabled(
      'AdapterDisabled: fixed session-id is not verified for this Grok version',
    );
  }
  if (
    input.projectGuardDecisionId.trim().length === 0
    || input.reservedBudgetId.trim().length === 0
  ) {
    return disabled(
      'AdapterDisabled: projectGuardDecisionId and reservedBudgetId are required',
    );
  }
  if (input.schemaPath.trim().length === 0) {
    return disabled(
      'AdapterDisabled: schemaPath is required for launch-authorization binding',
    );
  }
  if (input.projectRoot.trim().length === 0) {
    return disabled('AdapterDisabled: projectRoot is required');
  }

  // Prompt-in-argv via --single is forbidden when --prompt-file is available.
  if (input.promptViaFile === false) {
    return disabled(
      'AdapterDisabled: verified Grok contract requires prompt via --prompt-file '
        + '(outside project); prompt must not appear in argv/process list via --single',
    );
  }

  // Implementer project_write always disabled (unproven live project).
  if (input.role === 'implementer' && input.mode === 'project_write') {
    return disabled(
      'AdapterDisabled: Grok implementer project-write auto is not proven '
        + '(sandbox profile values unproven; --always-approve not claimed); '
        + 'implementer/project_write disabled',
    );
  }

  const isolatedRequested =
    input.role === 'implementer' && input.mode === 'workspace_write';

  let cwdRoot = '';
  let immutableReviewBundleHash = '';
  let workspaceAuthorizationId: string | undefined;
  let sourceManifestHash: string | undefined;

  if (isolatedRequested) {
    const isolated = input.isolatedWorkspace;
    if (isolated === undefined) {
      return disabled(
        'AdapterDisabled: Grok workspace_write requires isolatedWorkspace authorization ref',
      );
    }
    const workspaceRoot = isolated.workspaceRoot?.trim() ?? '';
    const authorizationId = isolated.authorizationId?.trim() ?? '';
    const manifestHash = isolated.sourceManifestHash?.trim().toLowerCase() ?? '';
    if (
      workspaceRoot.length === 0
      || authorizationId.length === 0
      || !/^[0-9a-f]{64}$/.test(manifestHash)
    ) {
      return disabled(
        'AdapterDisabled: isolatedWorkspace requires workspaceRoot, authorizationId, and sourceManifestHash',
      );
    }
    if (isPathPrefix(input.projectRoot, workspaceRoot)
      || isPathPrefix(workspaceRoot, input.projectRoot)
      || workspaceRoot.toLowerCase() === input.projectRoot.trim().toLowerCase()) {
      return disabled(
        'AdapterDisabled: isolated workspace root must differ from live projectRoot '
          + '(original/candidate root confusion)',
      );
    }
    if (input.immutableReviewBundle !== undefined) {
      return disabled(
        'AdapterDisabled: isolated workspace_write cannot also bind an immutable review bundle',
      );
    }
    // Capability contract must still prove tool allow/deny flags exist.
    if (!record.capabilities.streamJson || !record.capabilities.turnLimit) {
      return disabled(
        'AdapterDisabled: isolated implementation requires streamJson and turnLimit on the verified record',
      );
    }
    cwdRoot = resolve(workspaceRoot);
    immutableReviewBundleHash = createHash('sha256')
      .update(
        JSON.stringify({
          kind: 'isolated_implementation',
          workspaceRoot: cwdRoot,
          authorizationId,
          sourceManifestHash: manifestHash,
        }),
        'utf8',
      )
      .digest('hex');
    workspaceAuthorizationId = authorizationId;
    sourceManifestHash = manifestHash;
  } else {
    // Live-project reviewer/master/patch denied without immutable review bundle.
    const bundleValidation = validateImmutableReviewBundleRef(
      input.immutableReviewBundle,
      { liveProjectRoot: input.projectRoot },
    );
    if (!bundleValidation.ok) {
      if (
        input.role === 'reviewer'
        || input.role === 'master'
        || input.mode === 'patch_mode'
        || input.mode === 'read_only'
        || input.mode === 'auto_allowed'
      ) {
        return disabled(
          `AdapterDisabled: Grok refuses live-project ${input.role}/${input.mode} `
            + `without immutable review bundle (liveProjectAccess=false; `
            + `enforcement unproven). ${bundleValidation.reason}`,
        );
      }
      return disabled(bundleValidation.reason);
    }
    cwdRoot = bundleValidation.canonicalRoot;
    immutableReviewBundleHash = bundleValidation.contentHash;
  }

  const effectiveMode = resolveGrokEffectiveMode(input.role, input.mode);
  if (effectiveMode === undefined) {
    if (
      input.role === 'implementer'
      && input.mode === 'project_write'
      && !GROK_PROJECT_WRITE_AUTO_PROVEN
    ) {
      return disabled(
        'AdapterDisabled: Grok implementer project-write auto is not proven '
          + '(sandbox profile values unproven; --always-approve not claimed)',
      );
    }
    return disabled(
      `AdapterDisabled: cannot map role=${input.role} mode=${input.mode} `
        + 'to a verified Grok permission profile',
    );
  }

  if (input.operation === 'resume') {
    const conversationId = input.conversationId?.trim() ?? '';
    if (conversationId.length === 0) {
      return disabled(
        'AdapterDisabled: resume requires a non-empty conversation-id',
      );
    }
  }

  if (!record.maxTurns || !record.capabilities.turnLimit) {
    return disabled(
      'AdapterDisabled: maxTurns is not verified for this Grok record',
    );
  }

  let maxTurns = input.maxTurns ?? GROK_DEFAULT_MAX_TURNS;
  if (
    !Number.isInteger(maxTurns)
    || maxTurns < 1
    || maxTurns > 10_000
  ) {
    return disabled(
      'AdapterDisabled: maxTurns must be an integer in [1, 10000]',
    );
  }

  // Reviewer/master use plan mode; isolated implementer uses auto with Edit/Write;
  // implementer patch uses auto with writes denied.
  const permissionMode: 'auto' | 'plan' =
    input.role === 'reviewer' || input.role === 'master' || effectiveMode === 'read_only'
      ? 'plan'
      : 'auto';

  if (permissionMode !== 'auto' && permissionMode !== 'plan') {
    return disabled(
      'AdapterDisabled: only permission-mode auto|plan are verified for this Grok contract',
    );
  }

  const structuredPatchRequired =
    effectiveMode === 'patch_mode' && input.role === 'implementer';

  const allowedTools: readonly string[] = isolatedRequested
    ? [...GROK_ISOLATED_IMPLEMENTATION_ALLOWED_TOOLS]
    : [...GROK_VERIFIED_READ_ONLY_TOOLS];
  const disallowedTools: readonly string[] = isolatedRequested
    ? [...GROK_ISOLATED_IMPLEMENTATION_DENIED_TOOLS]
    : [...GROK_VERIFIED_DISALLOWED_WRITE_TOOLS];

  for (const banned of disallowedTools) {
    if ((allowedTools as readonly string[]).includes(banned)) {
      return disabled(
        `AdapterDisabled: forbidden tool ${banned} in allowed tools`,
      );
    }
  }
  if (isolatedRequested) {
    for (const required of ['Bash', 'Shell'] as const) {
      if (!(disallowedTools as readonly string[]).includes(required)) {
        return disabled(
          `AdapterDisabled: isolated implementation must deny ${required}`,
        );
      }
    }
  }

  let sessionId: string | undefined;
  if (input.operation === 'start') {
    const provided = input.sessionId?.trim();
    if (provided !== undefined && provided.length > 0) {
      if (!isValidGrokSessionUuid(provided)) {
        return disabled(
          'AdapterDisabled: session-id must be a valid UUID',
        );
      }
      sessionId = provided;
    } else {
      sessionId = randomUUID();
    }
  }

  const promptText = input.prompt ?? '';
  if (promptText.length === 0) {
    return disabled(
      'AdapterDisabled: Grok requires a non-empty prompt delivered via --prompt-file; '
        + 'prompt must not appear in argv via --single',
    );
  }

  // Pure builder: consume already-verified PromptArtifactRef only.
  // Zero filesystem / ACL / process work. Adapter creates the artifact AFTER
  // LaunchAuthorization consumeAndVerify, then passes the ref here.
  const artifact = input.promptArtifact;
  let promptFilePath = '';
  let promptFileSha256 = createHash('sha256').update(promptText, 'utf8').digest('hex');
  let cleanupPromptFile: () => GrokPromptCleanupResult = () => ({ ok: true });
  const hasVerifiedArtifact = artifact !== undefined;

  if (hasVerifiedArtifact) {
    const path = artifact.path?.trim() ?? '';
    const sha = artifact.sha256?.trim() ?? '';
    if (path.length === 0 || sha.length === 0) {
      return disabled(
        'AdapterDisabled: PromptArtifactRef path and sha256 are required',
      );
    }
    // Structural path checks only (string identity — no realpath/lstat/ACL).
    if (isPathPrefix(input.projectRoot, path)) {
      return disabled(
        'AdapterDisabled: prompt file path must be outside projectRoot',
      );
    }
    if (isPathPrefix(cwdRoot, path)) {
      return disabled(
        isolatedRequested
          ? 'AdapterDisabled: prompt file path must be outside isolated workspace'
          : 'AdapterDisabled: prompt file path must be outside immutable review bundle',
      );
    }
    promptFilePath = path;
    promptFileSha256 = sha;
    cleanupPromptFile = artifact.cleanup;
  }

  // Capability record may still report enforcement unproven (default matrix).
  // Elevated only when loaded opt-in proof set readOnly + writeModes=['read-only'].
  // liveProjectAccess remains false either way (candidate/bundle cwd only).
  const enforcementProven =
    isolatedRequested
    || (record.readOnly === true
      && record.capabilities.writeModes.includes('read-only'));

  const taskId =
    typeof input.taskId === 'string' && input.taskId.trim().length > 0
      ? input.taskId.trim()
      : '';

  // Even with elevated proof, liveProjectAccess remains false (never live project cwd).
  const intent: GrokRunIntent = Object.freeze({
    capabilityKey: Object.freeze({ ...input.capabilityKey }),
    projectGuardDecisionId: input.projectGuardDecisionId,
    reservedBudgetId: input.reservedBudgetId,
    budgetAttemptId: input.budgetAttemptId,
    taskId,
    role: input.role,
    mode: effectiveMode,
    permissionMode,
    schemaPath: input.schemaPath,
    nonGit: input.nonGit,
    projectRoot: input.projectRoot,
    cwd: cwdRoot,
    liveProjectAccess: false as const,
    enforcementProven: Boolean(enforcementProven),
    operation: input.operation,
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: input.conversationId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    allowedTools: Object.freeze([...allowedTools]),
    disallowedTools: Object.freeze([...disallowedTools]),
    maxTurns,
    structuredPatchRequired,
    promptDelivery: 'prompt-file' as const,
    promptFilePath,
    promptFileSha256,
    immutableReviewBundleHash,
    ...(workspaceAuthorizationId === undefined
      ? {}
      : { workspaceAuthorizationId }),
    ...(sourceManifestHash === undefined ? {} : { sourceManifestHash }),
  });

  const executable = input.executable?.trim() || 'grok';
  const toolsCsv = allowedTools.join(',');
  const disallowedCsv = disallowedTools.join(',');

  // --cwd routes ONLY to isolated candidate or immutable bundle (never live project).
  const args: string[] = [];
  args.push('--cwd', cwdRoot);

  if (input.operation === 'resume') {
    args.push('--resume', input.conversationId as string);
  } else {
    args.push('--session-id', sessionId as string);
  }

  if (hasVerifiedArtifact) {
    args.push('--prompt-file', promptFilePath);
  } else {
    // Structural dry-run placeholder (auth-before-prompt; no FS work).
    args.push('--prompt-file', '[PENDING_PROMPT_FILE]');
  }

  args.push(
    '--output-format',
    'streaming-json',
    '--permission-mode',
    permissionMode,
    '--tools',
    toolsCsv,
    '--disallowed-tools',
    disallowedCsv,
    '--max-turns',
    String(maxTurns),
  );

  const banned = [
    '--always-approve',
    '--sandbox',
    '--single',
    '-p',
    'bypassPermissions',
    'dontAsk',
    'acceptEdits',
  ];
  for (const flag of banned) {
    if (args.includes(flag)) {
      if (hasVerifiedArtifact) cleanupPromptFile();
      return disabled(`AdapterDisabled: forbidden flag ${flag}`);
    }
  }
  if (args.includes(promptText)) {
    if (hasVerifiedArtifact) cleanupPromptFile();
    return disabled(
      'AdapterDisabled: prompt leaked into argv; use --prompt-file only',
    );
  }
  // Refuse live project path as any --cwd value (pure string compare).
  const cwdIdx = args.indexOf('--cwd');
  if (cwdIdx >= 0) {
    const cwdVal = args[cwdIdx + 1] ?? '';
    if (
      cwdVal.length > 0
      && cwdVal.trim().replace(/[/\\]+$/g, '').toLowerCase()
        === input.projectRoot.trim().replace(/[/\\]+$/g, '').toLowerCase()
    ) {
      if (hasVerifiedArtifact) cleanupPromptFile();
      return disabled(
        'AdapterDisabled: --cwd must not be the live projectRoot '
          + '(isolated workspace or immutable review bundle only; liveProjectAccess=false)',
      );
    }
  }
  if (!args.includes('--prompt-file')) {
    if (hasVerifiedArtifact) cleanupPromptFile();
    return disabled(
      'AdapterDisabled: --prompt-file is required for Grok prompt delivery',
    );
  }
  if (!args.includes('streaming-json')) {
    if (hasVerifiedArtifact) cleanupPromptFile();
    return disabled(
      'AdapterDisabled: --output-format streaming-json is required',
    );
  }
  if (!args.includes('--max-turns')) {
    if (hasVerifiedArtifact) cleanupPromptFile();
    return disabled(
      'AdapterDisabled: --max-turns is required when maxTurns is verified',
    );
  }

  const argsForEvidence = Object.freeze(
    args.map((part, index) => {
      if (index > 0 && args[index - 1] === '--prompt-file') {
        return '[REDACTED_PROMPT_FILE]';
      }
      return part;
    }),
  );

  return {
    ok: true,
    executable,
    args: Object.freeze([...args]),
    intent,
    argsForEvidence,
    promptFilePath,
    cleanupPromptFile,
  };
}

/**
 * Extract the security/permission profile from a successful build for
 * start↔resume equivalence assertions and session evidence hashing.
 */
export function extractGrokPermissionProfile(
  built: Extract<GrokCommandBuildResult, { ok: true }>,
): GrokPermissionProfile {
  return Object.freeze({
    projectRoot: built.intent.projectRoot,
    cwd: built.intent.cwd,
    permissionMode: built.intent.permissionMode,
    outputFormat: 'streaming-json' as const,
    allowedTools: Object.freeze([...built.intent.allowedTools]),
    disallowedTools: Object.freeze([...built.intent.disallowedTools]),
    maxTurns: built.intent.maxTurns,
    nonGit: built.intent.nonGit,
    alwaysApprove: false as const,
    sandboxEmitted: false as const,
    liveProjectAccess: false as const,
    enforcementProven: built.intent.enforcementProven,
    taskId: built.intent.taskId,
    role: built.intent.role,
    effectiveMode: built.intent.mode,
    promptDelivery: 'prompt-file' as const,
    immutableReviewBundleHash: built.intent.immutableReviewBundleHash,
    adapterVersion: built.intent.capabilityKey.version,
    adapterPlatform: built.intent.capabilityKey.platform,
    adapterCliName: built.intent.capabilityKey.cliName,
    projectGuardDecisionId: built.intent.projectGuardDecisionId,
    reservedBudgetId: built.intent.reservedBudgetId,
  });
}

/**
 * Fail closed when run intent bindings do not match Task 13 start-gate record.
 */
export function assertGrokRunBindings(
  intent: GrokRunIntent,
  gate: WorkerStartGateRecord,
): void {
  if (!capabilityKeysEqual(intent.capabilityKey, gate.capabilityKey)) {
    throw new Error(
      'Grok run intent capabilityKey does not match Task13 start gate',
    );
  }
  if (intent.projectGuardDecisionId !== gate.projectGuardDecisionId) {
    throw new Error(
      'Grok run intent projectGuardDecisionId does not match Task13 start gate',
    );
  }
  if (intent.reservedBudgetId !== gate.reservedBudgetId) {
    throw new Error(
      'Grok run intent reservedBudgetId does not match Task13 start gate',
    );
  }
  if (
    gate.projectGuardAttemptId !== undefined
    && gate.projectGuardAttemptId.length > 0
    && intent.budgetAttemptId !== gate.projectGuardAttemptId
  ) {
    throw new Error(
      'Grok run intent budgetAttemptId does not match Task13 start gate attempt',
    );
  }
  if (
    gate.projectGuardMode.length > 0
    && intent.mode !== gate.projectGuardMode
    && !modesCompatible(intent.mode, gate.projectGuardMode)
  ) {
    throw new Error(
      `Grok run intent mode (${intent.mode}) does not match projectGuardMode (${gate.projectGuardMode})`,
    );
  }
  if (!gate.budgetCanLaunch) {
    throw new Error('Grok run intent rejected: budgetCanLaunch is false');
  }
  if (intent.liveProjectAccess !== false) {
    throw new Error('Grok run intent rejected: liveProjectAccess must be false');
  }
}

function modesCompatible(intentMode: string, gateMode: string): boolean {
  if (gateMode === 'auto_allowed') {
    return (
      intentMode === 'project_write'
      || intentMode === 'read_only'
      || intentMode === 'patch_mode'
      || intentMode === 'auto_allowed'
    );
  }
  if (intentMode === 'auto_allowed') {
    return (
      gateMode === 'project_write'
      || gateMode === 'read_only'
      || gateMode === 'patch_mode'
    );
  }
  if (gateMode === 'project_write' && intentMode === 'patch_mode') {
    return true;
  }
  return intentMode === gateMode;
}

/** Resolve patch schema path for auth binding (schema not passed as CLI flag). */
export function resolveGrokPatchSchemaPath(schemaPath: string): string {
  const trimmed = schemaPath.trim();
  if (trimmed.endsWith('agent-patch-result.schema.json')) {
    return trimmed;
  }
  try {
    return resolve(dirname(trimmed), 'agent-patch-result.schema.json');
  } catch {
    return resolve(schemaPath);
  }
}
