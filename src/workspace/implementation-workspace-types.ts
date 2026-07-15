export const IMPLEMENTATION_WORKSPACE_STATUSES = [
  'preparing',
  'ready',
  'running',
  'candidate_ready',
  'under_review',
  'approved',
  'validating',
  'promoting',
  'promoted',
  'rejected',
  'abandoned',
  'recovery_required',
] as const;

export type ImplementationWorkspaceStatus =
  (typeof IMPLEMENTATION_WORKSPACE_STATUSES)[number];

export interface ImplementationWorkspaceRecord {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly canonicalProjectRoot: string;
  readonly workspaceRoot: string;
  readonly sourceBaselineId: string;
  readonly sourceManifestHash: string;
  readonly candidateManifestHash: string | null;
  readonly changeSetHash: string | null;
  readonly status: ImplementationWorkspaceStatus;
  readonly authorizationId: string;
  readonly authorizationExpiresAt: string;
  readonly authorizationConsumedAt: string | null;
  readonly retainedUntil: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateImplementationWorkspaceInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly canonicalProjectRoot: string;
  readonly workspaceRoot: string;
  readonly sourceBaselineId: string;
  readonly sourceManifestHash: string;
  readonly authorizationId: string;
  readonly authorizationExpiresAt: string;
  readonly nowIso: string;
}

export interface ImplementationWorkspaceAuthorizationIntent {
  readonly taskId: string;
  readonly attemptId: string;
  readonly workspaceRoot: string;
  readonly sourceManifestHash: string;
}

export type ConsumeImplementationWorkspaceAuthorizationResult =
  | { readonly ok: true; readonly record: ImplementationWorkspaceRecord }
  | { readonly ok: false; readonly reason: string };

export interface TransitionImplementationWorkspaceInput {
  readonly workspaceId: string;
  readonly expectedStatus: ImplementationWorkspaceStatus;
  readonly status: ImplementationWorkspaceStatus;
  readonly nowIso: string;
  readonly candidateManifestHash?: string;
  readonly changeSetHash?: string;
  readonly retainedUntil?: string | null;
  readonly lastError?: string | null;
}

export interface MaterializeImplementationWorkspaceInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly sourceBaselineId: string;
  readonly sourceManifestHash: string;
  readonly authorizationId: string;
  readonly authorizationExpiresAt: string;
  readonly nowIso: string;
  readonly canonicalProjectRoot: string;
}

export interface MaterializeImplementationWorkspaceResult {
  readonly record: ImplementationWorkspaceRecord;
  readonly protectedPaths: readonly string[];
  readonly candidateManifestHash: string;
}

export interface CandidateManifestFile {
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
  readonly hash: string | null;
  readonly executable: boolean;
  readonly binary: boolean;
}

export interface CandidateManifest {
  readonly schema: 'triagent.candidate_manifest.v1';
  readonly taskId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly sourceBaselineId: string;
  readonly sourceManifestHash: string;
  readonly files: readonly CandidateManifestFile[];
  readonly protectedPaths: readonly string[];
}

export type WorkspaceChangeKind = 'add' | 'modify' | 'delete';

export interface WorkspaceChangeEntry {
  readonly kind: WorkspaceChangeKind;
  readonly path: string;
  readonly detectedFromPath?: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly beforeSize: number;
  readonly afterSize: number;
  readonly beforeBlobHash: string | null;
  readonly afterBlobHash: string | null;
}

export interface WorkspaceCandidateChangeSet {
  readonly schema: 'triagent.workspace_change_set.v1';
  readonly taskId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly sourceBaselineId: string;
  readonly sourceManifestHash: string;
  readonly candidateManifestHash: string;
  readonly entries: readonly WorkspaceChangeEntry[];
  readonly unifiedDiff: string;
  readonly changeSetHash: string;
}
