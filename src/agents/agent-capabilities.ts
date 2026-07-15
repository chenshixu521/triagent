export type AgentWriteMode =
  | 'read-only'
  | 'workspace-write'
  | 'unrestricted';

export interface AgentCapabilities {
  readonly fixedSessionId: boolean;
  readonly resume: boolean;
  readonly structuredOutput: boolean;
  readonly streamJson: boolean;
  readonly realTimeInput: boolean;
  readonly nativeSandbox: boolean;
  readonly nativePermissionRules: boolean;
  readonly budgetLimit: boolean;
  readonly turnLimit: boolean;
  readonly timeLimit: boolean;
  readonly nonGitProjects: boolean;
  readonly writeModes: readonly AgentWriteMode[];
}

export function unknownAgentCapabilities(): AgentCapabilities {
  return Object.freeze({
    fixedSessionId: false,
    resume: false,
    structuredOutput: false,
    streamJson: false,
    realTimeInput: false,
    nativeSandbox: false,
    nativePermissionRules: false,
    budgetLimit: false,
    turnLimit: false,
    timeLimit: false,
    nonGitProjects: false,
    writeModes: Object.freeze([]),
  });
}
