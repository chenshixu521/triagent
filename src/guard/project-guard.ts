import { randomUUID } from 'node:crypto';

import type { AgentCapabilities } from '../agents/agent-capabilities.js';
import type { CompatibilityRecord } from '../agents/compatibility-matrix.js';
import type { AttemptId } from '../domain/ids.js';
import type { AgentRole } from '../domain/task.js';
import {
  resolveAdapterPermissionProfile,
  type AdapterIdentity,
  type AdapterPermissionProfile,
  type ExecutionScope,
} from './adapter-permission-profile.js';
import { ApprovalPolicy, type ApprovalMode } from './approval-policy.js';
import { CommandClassifier } from './command-classifier.js';
import { PathPolicy } from './path-policy.js';

export type GuardDecisionMode = ApprovalMode;

export interface GuardCapabilityEvidence {
  readonly verified: boolean;
  readonly adapter: AdapterIdentity;
  readonly writeModes: readonly string[];
  readonly nativePermissionRules: boolean;
  readonly structuredOutput: boolean;
  readonly profileMode: AdapterPermissionProfile['mode'];
  readonly notes: readonly string[];
}

export type GuardScope =
  | {
      readonly kind: 'file_operation';
      readonly operation: 'read' | 'write' | 'delete' | 'rename';
      readonly path: string;
      readonly relativePath?: string;
    }
  | {
      readonly kind: 'command';
      readonly executable: string;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly classification: string;
    }
  | {
      readonly kind: 'adapter_start';
      readonly role: AgentRole;
      readonly profileMode: AdapterPermissionProfile['mode'];
      readonly executionScope: ExecutionScope;
    }
  | {
      readonly kind: 'patch_apply';
      readonly files: readonly string[];
      readonly baselineId: string;
    }
  | {
      readonly kind: 'unknown';
      readonly description: string;
    };

export interface GuardDecision {
  readonly id: string;
  readonly mode: GuardDecisionMode;
  readonly scope: GuardScope;
  readonly reason: string;
  readonly attemptId: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly capabilityEvidence: GuardCapabilityEvidence;
  readonly role: AgentRole;
  readonly userConfirmationRequired: boolean;
}

export interface ProjectGuardOptions {
  readonly projectRoot: string;
  readonly decisionTtlMs?: number | null;
  readonly now?: () => Date;
}

export interface GuardCommonInput {
  readonly attemptId: AttemptId | string;
  readonly role: AgentRole;
  readonly capabilities: AgentCapabilities;
  readonly adapter: AdapterIdentity;
  readonly capabilityRecord?: CompatibilityRecord;
  readonly executionScope?: ExecutionScope;
  readonly workspaceAuthorizationValidated?: boolean;
}

function capabilityEvidence(
  profile: AdapterPermissionProfile,
): GuardCapabilityEvidence {
  return {
    verified: profile.capabilityVerified,
    adapter: profile.adapter,
    writeModes: [...profile.evidence.writeModes],
    nativePermissionRules: profile.evidence.nativePermissionRules,
    structuredOutput: profile.evidence.structuredOutput,
    profileMode: profile.mode,
    notes: [profile.reason],
  };
}

function approvalProfileMode(
  mode: AdapterPermissionProfile['mode'],
): 'project_write' | 'workspace_write' | 'read_only' | 'patch_mode' | 'disabled' {
  if (mode === 'project_write') return 'project_write';
  if (mode === 'workspace_write') return 'workspace_write';
  if (mode === 'patch_mode') return 'patch_mode';
  if (mode === 'disabled') return 'disabled';
  return 'read_only';
}

export class ProjectGuard {
  readonly #pathPolicy: PathPolicy;
  readonly #commands = new CommandClassifier();
  readonly #approvals = new ApprovalPolicy();
  readonly #decisionTtlMs: number | null;
  readonly #now: () => Date;

  public constructor(options: ProjectGuardOptions) {
    this.#pathPolicy = new PathPolicy({ projectRoot: options.projectRoot });
    this.#decisionTtlMs =
      options.decisionTtlMs === undefined ? null : options.decisionTtlMs;
    this.#now = options.now ?? (() => new Date());
  }

  public get projectRoot(): string {
    return this.#pathPolicy.projectRoot;
  }

  public resolvePermissionProfile(input: {
    readonly role: AgentRole;
    readonly capabilities: AgentCapabilities;
    readonly adapter: AdapterIdentity;
    readonly capabilityRecord?: CompatibilityRecord;
    readonly executionScope?: ExecutionScope;
    readonly workspaceAuthorizationValidated?: boolean;
  }): AdapterPermissionProfile {
    return resolveAdapterPermissionProfile(input);
  }

  public evaluateAdapterStart(input: GuardCommonInput): GuardDecision {
    const profile = this.resolvePermissionProfile(input);
    let mode: GuardDecisionMode;
    let reason: string;
    if (profile.mode === 'disabled') {
      mode = 'disabled';
      reason = profile.reason;
    } else if (profile.mode === 'patch_mode') {
      mode = 'patch_mode';
      reason = profile.reason;
    } else if (profile.mode === 'read_only') {
      // Only exact verified read-only profile may auto-allow start; never fail open.
      if (!profile.capabilityVerified) {
        mode = 'requires_confirmation';
        reason =
          'read-only profile is not capability-verified; adapter start requires confirmation';
      } else {
        mode = 'auto_allowed';
        reason = profile.reason;
      }
    } else if (
      (profile.mode === 'project_write' || profile.mode === 'workspace_write')
      && profile.capabilityVerified
    ) {
      mode = 'auto_allowed';
      reason = profile.reason;
    } else {
      mode = 'requires_confirmation';
      reason = 'unproven adapter start requires confirmation (never auto-allowed)';
    }
    return this.#decision({
      mode,
      reason,
      attemptId: String(input.attemptId),
      role: input.role,
      scope: {
        kind: 'adapter_start',
        role: input.role,
        profileMode: profile.mode,
        executionScope: profile.executionScope,
      },
      capabilityEvidence: capabilityEvidence(profile),
    });
  }

  public evaluateFileOperation(
    input: GuardCommonInput & {
      readonly operation: 'read' | 'write' | 'delete' | 'rename';
      readonly path: string;
    },
  ): GuardDecision {
    const profile = this.resolvePermissionProfile(input);
    const pathResult = this.#pathPolicy.evaluatePath(input.path);
    const isWrite =
      input.operation === 'write' ||
      input.operation === 'delete' ||
      input.operation === 'rename';

    if (!pathResult.allowed) {
      return this.#decision({
        mode: 'denied',
        reason: pathResult.reason,
        attemptId: String(input.attemptId),
        role: input.role,
        scope: {
          kind: 'file_operation',
          operation: input.operation,
          path: input.path,
        },
        capabilityEvidence: capabilityEvidence(profile),
      });
    }

    const approval = this.#approvals.decide({
      role: input.role,
      pathAllowed: true,
      isFileWrite: isWrite,
      profileMode: approvalProfileMode(profile.mode),
      capabilityVerified: profile.capabilityVerified,
    });

    return this.#decision({
      mode: approval.mode,
      reason: approval.reason,
      attemptId: String(input.attemptId),
      role: input.role,
      scope: {
        kind: 'file_operation',
        operation: input.operation,
        path: input.path,
        relativePath: pathResult.relativePath,
      },
      capabilityEvidence: capabilityEvidence(profile),
    });
  }

  public evaluateCommand(
    input: GuardCommonInput & {
      readonly executable: string;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly pathArguments?: readonly string[];
    },
  ): GuardDecision {
    const profile = this.resolvePermissionProfile(input);

    // Disabled / unverified reviewer-master profiles never auto-allow commands.
    if (profile.mode === 'disabled' || !profile.capabilityVerified) {
      if (input.role === 'reviewer' || input.role === 'master') {
        return this.#decision({
          mode: profile.mode === 'disabled' ? 'disabled' : 'requires_confirmation',
          reason:
            profile.mode === 'disabled'
              ? profile.reason
              : `${input.role} lacks verified read-only capability; commands never auto-allowed`,
          attemptId: String(input.attemptId),
          role: input.role,
          scope: {
            kind: 'command',
            executable: input.executable,
            argv: input.argv,
            cwd: input.cwd,
            classification: 'requires_confirmation',
          },
          capabilityEvidence: capabilityEvidence(profile),
        });
      }
      if (profile.mode === 'disabled') {
        return this.#decision({
          mode: 'disabled',
          reason: profile.reason,
          attemptId: String(input.attemptId),
          role: input.role,
          scope: {
            kind: 'command',
            executable: input.executable,
            argv: input.argv,
            cwd: input.cwd,
            classification: 'denied',
          },
          capabilityEvidence: capabilityEvidence(profile),
        });
      }
    }

    const classified = this.#commands.classify({
      executable: input.executable,
      argv: input.argv,
      cwd: input.cwd,
    });

    // Path-bearing args are derived from argv by the classifier; optional caller
    // pathArguments may only add more paths, never replace unknown provenance.
    const derivedPaths = [
      ...classified.derivedPathArguments,
      ...(input.pathArguments ?? []),
    ];
    const pathEval = this.#pathPolicy.evaluateCommandPaths({
      cwd: input.cwd,
      pathArguments: derivedPaths,
    });
    if (!pathEval.allInsideProject) {
      return this.#decision({
        mode: 'denied',
        reason:
          'command path escape: cwd or argument resolves outside the project',
        attemptId: String(input.attemptId),
        role: input.role,
        scope: {
          kind: 'command',
          executable: input.executable,
          argv: input.argv,
          cwd: input.cwd,
          classification: 'denied',
        },
        capabilityEvidence: capabilityEvidence(profile),
      });
    }

    // Reviewer/master: only verified allowlisted commands may auto-allow.
    if (
      (input.role === 'reviewer' || input.role === 'master') &&
      classified.classification !== 'auto_allowed'
    ) {
      const mode =
        classified.classification === 'denied'
          ? 'denied'
          : 'requires_confirmation';
      return this.#decision({
        mode,
        reason: `${input.role} may not run non-allowlisted commands without confirmation`,
        attemptId: String(input.attemptId),
        role: input.role,
        scope: {
          kind: 'command',
          executable: input.executable,
          argv: input.argv,
          cwd: input.cwd,
          classification: classified.classification,
        },
        capabilityEvidence: capabilityEvidence(profile),
      });
    }

    // If adapter cannot expose pre-command approval events, non-allowlisted commands
    // still require confirmation (shell tools should be removed in automatic mode).
    if (
      !profile.preCommandApprovalEvents &&
      classified.classification !== 'auto_allowed' &&
      classified.classification !== 'denied'
    ) {
      return this.#decision({
        mode: 'requires_confirmation',
        reason:
          'adapter lacks pre-command approval events; non-allowlisted command requires TUI confirmation',
        attemptId: String(input.attemptId),
        role: input.role,
        scope: {
          kind: 'command',
          executable: input.executable,
          argv: input.argv,
          cwd: input.cwd,
          classification: classified.classification,
        },
        capabilityEvidence: capabilityEvidence(profile),
      });
    }

    const approval = this.#approvals.decide({
      role: input.role,
      commandClassification: classified.classification,
      pathAllowed: true,
      isFileWrite: false,
      profileMode: approvalProfileMode(profile.mode),
      capabilityVerified: profile.capabilityVerified,
    });

    // Never auto-allow commands without verified capability evidence.
    if (approval.mode === 'auto_allowed' && !profile.capabilityVerified) {
      return this.#decision({
        mode: 'requires_confirmation',
        reason:
          'command is structurally allowlisted but capability evidence is unverified',
        attemptId: String(input.attemptId),
        role: input.role,
        scope: {
          kind: 'command',
          executable: input.executable,
          argv: input.argv,
          cwd: input.cwd,
          classification: classified.classification,
        },
        capabilityEvidence: capabilityEvidence(profile),
      });
    }

    return this.#decision({
      mode: approval.mode,
      reason: approval.reason,
      attemptId: String(input.attemptId),
      role: input.role,
      scope: {
        kind: 'command',
        executable: input.executable,
        argv: input.argv,
        cwd: input.cwd,
        classification: classified.classification,
      },
      capabilityEvidence: capabilityEvidence(profile),
    });
  }

  public evaluatePatchApply(
    input: GuardCommonInput & {
      readonly files: readonly string[];
      readonly baselineId: string;
    },
  ): GuardDecision {
    const profile = this.resolvePermissionProfile(input);
    for (const file of input.files) {
      const pathResult = this.#pathPolicy.evaluatePath(file);
      if (!pathResult.allowed) {
        return this.#decision({
          mode: 'denied',
          reason: `patch path denied: ${pathResult.reason}`,
          attemptId: String(input.attemptId),
          role: input.role,
          scope: {
            kind: 'patch_apply',
            files: input.files,
            baselineId: input.baselineId,
          },
          capabilityEvidence: capabilityEvidence(profile),
        });
      }
    }
    return this.#decision({
      mode: 'auto_allowed',
      reason: 'validated patch paths are project-local; PatchApplier is the only writer',
      attemptId: String(input.attemptId),
      role: input.role,
      scope: {
        kind: 'patch_apply',
        files: input.files,
        baselineId: input.baselineId,
      },
      capabilityEvidence: capabilityEvidence(profile),
    });
  }

  public evaluateUnknown(
    input: GuardCommonInput & { readonly description: string },
  ): GuardDecision {
    const profile = this.resolvePermissionProfile(input);
    const approval = this.#approvals.decide({
      role: input.role,
      profileMode: approvalProfileMode(profile.mode),
      capabilityVerified: profile.capabilityVerified,
      unknownOperation: true,
    });
    return this.#decision({
      mode: approval.mode,
      reason: approval.reason,
      attemptId: String(input.attemptId),
      role: input.role,
      scope: {
        kind: 'unknown',
        description: input.description,
      },
      capabilityEvidence: capabilityEvidence(profile),
    });
  }

  #decision(input: {
    readonly mode: GuardDecisionMode;
    readonly reason: string;
    readonly attemptId: string;
    readonly role: AgentRole;
    readonly scope: GuardScope;
    readonly capabilityEvidence: GuardCapabilityEvidence;
  }): GuardDecision {
    const created = this.#now();
    const expiresAt =
      this.#decisionTtlMs === null
        ? null
        : new Date(created.getTime() + this.#decisionTtlMs).toISOString();
    return {
      id: randomUUID(),
      mode: input.mode,
      scope: input.scope,
      reason: input.reason,
      attemptId: input.attemptId,
      createdAt: created.toISOString(),
      expiresAt,
      capabilityEvidence: input.capabilityEvidence,
      role: input.role,
      userConfirmationRequired:
        input.mode === 'requires_confirmation' || input.mode === 'patch_mode',
    };
  }
}
