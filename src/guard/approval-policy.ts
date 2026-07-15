import type { AgentRole } from '../domain/task.js';
import type { CommandClassification } from './command-classifier.js';

export type ApprovalMode =
  | 'auto_allowed'
  | 'requires_confirmation'
  | 'denied'
  | 'patch_mode'
  | 'disabled';

export interface ApprovalPolicyInput {
  readonly role: AgentRole;
  readonly commandClassification?: CommandClassification;
  readonly pathAllowed?: boolean;
  readonly isFileWrite?: boolean;
  readonly profileMode:
    | 'project_write'
    | 'workspace_write'
    | 'read_only'
    | 'patch_mode'
    | 'disabled';
  readonly capabilityVerified: boolean;
  readonly unknownOperation?: boolean;
}

export interface ApprovalPolicyResult {
  readonly mode: ApprovalMode;
  readonly reason: string;
}

/**
 * Role and capability aware approval policy.
 * Best-effort project guardrails only — never an OS sandbox claim.
 */
export class ApprovalPolicy {
  public decide(input: ApprovalPolicyInput): ApprovalPolicyResult {
    if (input.unknownOperation) {
      return {
        mode: 'denied',
        reason: 'unknown operation fails closed',
      };
    }

    if (input.profileMode === 'disabled') {
      return {
        mode: 'disabled',
        reason: 'adapter is disabled for this role due to unproven capabilities',
      };
    }

    if (input.pathAllowed === false) {
      return {
        mode: 'denied',
        reason: 'path is outside the project or fails closed path policy',
      };
    }

    if (input.role === 'reviewer' || input.role === 'master') {
      if (input.isFileWrite) {
        return {
          mode: 'denied',
          reason: `${input.role} is read-only and may not write project files`,
        };
      }
      if (
        input.commandClassification === 'denied' ||
        input.commandClassification === 'requires_confirmation'
      ) {
        return {
          mode: input.commandClassification,
          reason: `${input.role} command is not auto-allowed under read-only policy`,
        };
      }
      if (input.commandClassification === 'auto_allowed') {
        return {
          mode: 'auto_allowed',
          reason: `${input.role} allowlisted verification command`,
        };
      }
      return {
        mode: 'requires_confirmation',
        reason: `${input.role} operations require confirmation unless allowlisted`,
      };
    }

    // implementer
    if (input.profileMode === 'patch_mode') {
      if (input.isFileWrite) {
        return {
          mode: 'patch_mode',
          reason:
            'implementer lacks proven direct-write enforcement; use read-only patch mode',
        };
      }
      if (input.commandClassification === 'auto_allowed') {
        return {
          mode: 'auto_allowed',
          reason: 'allowlisted verification command under patch mode',
        };
      }
      if (input.commandClassification === 'denied') {
        return {
          mode: 'denied',
          reason: 'command is denied by structural policy',
        };
      }
      return {
        mode: 'requires_confirmation',
        reason: 'command requires confirmation under patch mode',
      };
    }

    if (input.profileMode === 'project_write' || input.profileMode === 'workspace_write') {
      if (!input.capabilityVerified) {
        return {
          mode: 'denied',
          reason: input.profileMode === 'workspace_write'
            ? 'workspace-write requires verified isolated authorization'
            : 'project-write requires verified capability evidence',
        };
      }
      if (input.isFileWrite) {
        return {
          mode: 'auto_allowed',
          reason: input.profileMode === 'workspace_write'
            ? 'candidate workspace-local file operation with isolated authorization'
            : 'explicit project-local file operation with verified write capability',
        };
      }
      if (input.commandClassification === 'auto_allowed') {
        return {
          mode: 'auto_allowed',
          reason: 'allowlisted verification command',
        };
      }
      if (input.commandClassification === 'denied') {
        return {
          mode: 'denied',
          reason: 'command is denied by structural policy',
        };
      }
      if (input.commandClassification === 'requires_confirmation') {
        return {
          mode: 'requires_confirmation',
          reason: 'command requires manual confirmation',
        };
      }
      return {
        mode: 'requires_confirmation',
        reason: 'unclassified implementer operation requires confirmation',
      };
    }

    // read_only profile for implementer should not happen often; treat as patch mode.
    if (input.isFileWrite) {
      return {
        mode: 'patch_mode',
        reason: 'read-only implementer profile routes writes through patch mode',
      };
    }
    return {
      mode: 'requires_confirmation',
      reason: 'operation requires confirmation under read-only profile',
    };
  }
}
