import type { TaskId } from './ids.js';

export const AGENT_KINDS = ['codex', 'claude', 'grok'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_ROLES = ['master', 'implementer', 'reviewer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export type RequirementVersion = number;

export interface RoleAssignment {
  readonly master: AgentKind;
  readonly implementer: AgentKind;
  readonly reviewer: AgentKind;
}

export interface TaskDefinition {
  readonly taskId: TaskId;
  readonly requirementVersion: RequirementVersion;
  readonly roles: RoleAssignment;
}

export function createRoleAssignment(
  assignment: RoleAssignment,
): RoleAssignment {
  const assignedAgents = [
    assignment.master,
    assignment.implementer,
    assignment.reviewer,
  ];

  if (new Set(assignedAgents).size !== AGENT_ROLES.length) {
    throw new Error('master, implementer, and reviewer must use distinct agents');
  }

  return Object.freeze({ ...assignment });
}
