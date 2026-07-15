import type { AgentCapabilities, AgentWriteMode } from '../agents/agent-capabilities.js';
import type { CompatibilityRecord } from '../agents/compatibility-matrix.js';
import type { AgentKind, AgentRole } from '../domain/task.js';

export type AdapterProfileMode =
  | 'project_write'
  | 'workspace_write'
  | 'read_only'
  | 'patch_mode'
  | 'disabled';

/**
 * Where an adapter is allowed to execute.
 * - live_project: canonical project root (existing fail-closed rules)
 * - isolated_implementation: app-owned candidate workspace only
 * - immutable_review_bundle: read-only review artifact root
 */
export type ExecutionScope =
  | 'live_project'
  | 'isolated_implementation'
  | 'immutable_review_bundle';

export interface AdapterIdentity {
  readonly kind: AgentKind;
  readonly version: string;
}

export interface AdapterPermissionProfile {
  readonly role: AgentRole;
  readonly adapter: AdapterIdentity;
  readonly mode: AdapterProfileMode;
  readonly writeMode: AgentWriteMode | 'none';
  readonly fileWriteEnabled: boolean;
  readonly shellToolsEnabled: boolean;
  readonly preCommandApprovalEvents: boolean;
  readonly capabilityVerified: boolean;
  readonly executionScope: ExecutionScope;
  readonly reason: string;
  readonly evidence: {
    readonly writeModes: readonly AgentWriteMode[];
    readonly nativePermissionRules: boolean;
    readonly structuredOutput: boolean;
    readonly version: string;
  };
}

export interface ResolveProfileInput {
  readonly role: AgentRole;
  readonly capabilities: AgentCapabilities;
  readonly adapter: AdapterIdentity;
  readonly capabilityRecord?: CompatibilityRecord;
  /**
   * Defaults to live_project. Isolated implementation never elevates the
   * compatibility record's live projectWrite bit.
   */
  readonly executionScope?: ExecutionScope;
  /**
   * Set only after ImplementationWorkspaceRepository has validated (prepare)
   * or consumed (authorize) a matching single-use workspace authorization.
   */
  readonly workspaceAuthorizationValidated?: boolean;
}

function hasWriteMode(
  capabilities: AgentCapabilities,
  mode: AgentWriteMode,
): boolean {
  return capabilities.writeModes.includes(mode);
}

/**
 * Exact verified adapter/version pairs with proven read-only profiles.
 * Generic structuredOutput / nativePermissionRules alone are never sufficient.
 * Grok 0.2.93 is intentionally absent until a persisted opt-in disposable-project
 * enforcement proof elevates writeModes to include read-only (help flags ≠ proof).
 */
const VERIFIED_READ_ONLY_ADAPTERS: ReadonlySet<string> = new Set([
  'codex@0.144.1',
  'claude@2.1.206',
  // 'grok@0.2.93' — only after loaded enforcement proof elevates matrix writeModes
]);

/**
 * Exact verified adapter/version pairs with enforceable project-write profiles.
 * Claude 2.1.206 is intentionally absent: no project-scoped write sandbox is
 * proven; implementer must use patch_mode (PatchApplier sole writer).
 * Grok never has project-write auto.
 */
const VERIFIED_PROJECT_WRITE_ADAPTERS: ReadonlySet<string> = new Set([
  'codex@0.144.1',
]);

/**
 * Exact verified adapter/version pairs that support the read-only structured patch contract.
 * Grok 0.2.93 patch against live project is denied (enforcement unproven); use
 * immutable review bundle for review roles only until Task17 + live proof exist.
 */
const VERIFIED_PATCH_MODE_ADAPTERS: ReadonlySet<string> = new Set([
  'codex@0.144.1',
  'claude@2.1.206',
  // 'grok@0.2.93' — not proven for live-project patch_mode
  'codex@patch-applier',
]);

function adapterKey(adapter: AdapterIdentity): string {
  return `${adapter.kind}@${adapter.version}`;
}

function capabilitiesEqual(
  left: AgentCapabilities,
  right: AgentCapabilities,
): boolean {
  return left.fixedSessionId === right.fixedSessionId
    && left.resume === right.resume
    && left.structuredOutput === right.structuredOutput
    && left.streamJson === right.streamJson
    && left.realTimeInput === right.realTimeInput
    && left.nativeSandbox === right.nativeSandbox
    && left.nativePermissionRules === right.nativePermissionRules
    && left.budgetLimit === right.budgetLimit
    && left.turnLimit === right.turnLimit
    && left.timeLimit === right.timeLimit
    && left.nonGitProjects === right.nonGitProjects
    && left.writeModes.length === right.writeModes.length
    && left.writeModes.every((mode, index) => mode === right.writeModes[index]);
}

function verifiedCompatibilityFor(
  input: ResolveProfileInput,
): CompatibilityRecord | undefined {
  const record = input.capabilityRecord;
  if (
    record === undefined
    || record.verified !== true
    || record.key.cliName !== input.adapter.kind
    || record.key.version !== input.adapter.version
    || record.key.platform !== process.platform
    || !capabilitiesEqual(record.capabilities, input.capabilities)
  ) {
    return undefined;
  }
  return record;
}

function isExactVerifiedReadOnly(
  adapter: AdapterIdentity,
  capabilities: AgentCapabilities,
  compatibility: CompatibilityRecord | undefined,
): boolean {
  if (VERIFIED_READ_ONLY_ADAPTERS.has(adapterKey(adapter))) {
    return true;
  }
  if (
    compatibility?.readOnly === true
    && hasWriteMode(compatibility.capabilities, 'read-only')
  ) {
    return true;
  }
  // Grok 0.2.93: only when matrix capabilities were elevated by loaded
  // opt-in disposable-project enforcement proof (writeModes includes read-only
  // + nativePermissionRules). Help flags alone never qualify.
  if (
    adapter.kind === 'grok'
    && adapter.version === '0.2.93'
    && hasWriteMode(capabilities, 'read-only')
    && capabilities.nativePermissionRules === true
  ) {
    return true;
  }
  return false;
}

function isExactVerifiedProjectWrite(
  adapter: AdapterIdentity,
  compatibility: CompatibilityRecord | undefined,
): boolean {
  return VERIFIED_PROJECT_WRITE_ADAPTERS.has(adapterKey(adapter))
    || compatibility?.projectWrite === true;
}

function isExactVerifiedPatchMode(
  adapter: AdapterIdentity,
  capabilities: AgentCapabilities,
  compatibility: CompatibilityRecord | undefined,
): boolean {
  if (VERIFIED_PATCH_MODE_ADAPTERS.has(adapterKey(adapter))) {
    return true;
  }
  if (
    adapter.kind !== 'grok'
    && compatibility?.readOnly === true
    && compatibility.capabilities.structuredOutput === true
    && hasWriteMode(compatibility.capabilities, 'read-only')
  ) {
    return true;
  }
  // Grok patch against live project remains disabled even with proof —
  // implementer uses immutable bundle only at adapter layer; never auto-enable
  // ProjectGuard patch_mode for Grok from proof elevation alone.
  void capabilities;
  return false;
}

/**
 * Role-specific Adapter permission profiles.
 * Direct project-write requires an exact verified enforceable profile.
 * Reviewer/master require exact verified read-only profile or immutable review bundle.
 * Otherwise implementer falls back to proven patch mode, or is disabled.
 */
export function resolveAdapterPermissionProfile(
  input: ResolveProfileInput,
): AdapterPermissionProfile {
  const compatibility = verifiedCompatibilityFor(input);
  const executionScope: ExecutionScope = input.executionScope ?? 'live_project';
  const evidence = {
    writeModes: input.capabilities.writeModes,
    nativePermissionRules: input.capabilities.nativePermissionRules,
    structuredOutput: input.capabilities.structuredOutput,
    version: input.adapter.version,
  };

  // Isolated candidate write is independent of live projectWrite proofs.
  // Never grant this for live_project, and never elevate matrix projectWrite.
  if (
    executionScope === 'isolated_implementation'
    && input.role === 'implementer'
    && input.adapter.kind === 'grok'
    && input.workspaceAuthorizationValidated === true
    && compatibility !== undefined
    && input.capabilities.streamJson === true
  ) {
    return {
      role: 'implementer',
      adapter: input.adapter,
      mode: 'workspace_write',
      writeMode: 'workspace-write',
      fileWriteEnabled: true,
      shellToolsEnabled: false,
      preCommandApprovalEvents: true,
      capabilityVerified: true,
      executionScope,
      reason:
        'isolated_implementation authorization grants candidate workspace-write only; live projectWrite remains unproven',
      evidence,
    };
  }

  if (executionScope === 'isolated_implementation' && input.role === 'implementer') {
    return {
      role: 'implementer',
      adapter: input.adapter,
      mode: 'disabled',
      writeMode: 'none',
      fileWriteEnabled: false,
      shellToolsEnabled: false,
      preCommandApprovalEvents: false,
      capabilityVerified: false,
      executionScope,
      reason:
        'isolated_implementation requires a validated single-use workspace authorization for Grok implementer',
      evidence,
    };
  }

  if (input.role === 'reviewer' || input.role === 'master') {
    // Only exact verified adapter/version read-only profile, or an immutable review
    // bundle signal (explicit read-only writeModes + verified adapter), may allow.
    // Generic structuredOutput / nativePermissionRules alone are never proof.
    const exactReadOnly =
      isExactVerifiedReadOnly(input.adapter, input.capabilities, compatibility) &&
      hasWriteMode(input.capabilities, 'read-only');

    const immutableReviewBundle =
      isExactVerifiedReadOnly(input.adapter, input.capabilities, compatibility) &&
      hasWriteMode(input.capabilities, 'read-only') &&
      input.capabilities.structuredOutput === true;

    if (exactReadOnly || immutableReviewBundle) {
      return {
        role: input.role,
        adapter: input.adapter,
        mode: 'read_only',
        writeMode: 'read-only',
        fileWriteEnabled: false,
        shellToolsEnabled: false,
        preCommandApprovalEvents: input.capabilities.nativePermissionRules,
        capabilityVerified: true,
        executionScope:
          executionScope === 'immutable_review_bundle'
            ? 'immutable_review_bundle'
            : 'live_project',
        reason: `${input.role} has exact verified read-only profile or immutable review bundle`,
        evidence,
      };
    }

    return {
      role: input.role,
      adapter: input.adapter,
      mode: 'disabled',
      writeMode: 'none',
      fileWriteEnabled: false,
      shellToolsEnabled: false,
      preCommandApprovalEvents: false,
      capabilityVerified: false,
      executionScope,
      reason: `${input.role} lacks exact verified read-only adapter/version profile; disabled (never auto_allowed)`,
      evidence,
    };
  }

  // implementer on live_project: project-write only with exact verified adapter.
  // Grok never receives live projectWrite from this path.
  const canProjectWrite =
    executionScope === 'live_project' &&
    isExactVerifiedProjectWrite(input.adapter, compatibility) &&
    hasWriteMode(input.capabilities, 'workspace-write') &&
    input.capabilities.nativePermissionRules === true;

  if (canProjectWrite) {
    return {
      role: 'implementer',
      adapter: input.adapter,
      mode: 'project_write',
      writeMode: 'workspace-write',
      fileWriteEnabled: true,
      shellToolsEnabled: false,
      preCommandApprovalEvents: true,
      capabilityVerified: true,
      executionScope: 'live_project',
      reason:
        'exact adapter/version has verified enforceable project-write permission profile',
      evidence,
    };
  }

  // Patch mode requires proven supported read-only/structured patch contract on an
  // exact verified adapter — not generic structuredOutput alone.
  const canPatchMode =
    executionScope === 'live_project' &&
    isExactVerifiedPatchMode(input.adapter, input.capabilities, compatibility) &&
    input.capabilities.structuredOutput === true &&
    hasWriteMode(input.capabilities, 'read-only');

  if (canPatchMode) {
    return {
      role: 'implementer',
      adapter: input.adapter,
      mode: 'patch_mode',
      writeMode: 'read-only',
      fileWriteEnabled: false,
      shellToolsEnabled: false,
      preCommandApprovalEvents: input.capabilities.nativePermissionRules,
      capabilityVerified: true,
      executionScope: 'live_project',
      reason:
        'adapter cannot objectively constrain file writes; implementer runs in proven read-only patch mode',
      evidence,
    };
  }

  return {
    role: 'implementer',
    adapter: input.adapter,
    mode: 'disabled',
    writeMode: 'none',
    fileWriteEnabled: false,
    shellToolsEnabled: false,
    preCommandApprovalEvents: false,
    capabilityVerified: false,
    executionScope,
    reason:
      'neither direct-write nor read-only patch mode can be proven; adapter disabled for implementer',
    evidence,
  };
}
