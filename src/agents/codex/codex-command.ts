import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  type CompatibilityKey,
  type CompatibilityRecord,
  type WorkerStartGateRecord,
} from '../compatibility-matrix.js';
import type { AttemptId } from '../../domain/ids.js';
import type { AgentRole } from '../../domain/task.js';

/**
 * Detect custom/non-OpenAI Codex providers that often 502 on --output-schema.
 * Override with TRIAGENT_CODEX_OMIT_OUTPUT_SCHEMA=1 or FORCE=1.
 */
export function shouldOmitCodexOutputSchema(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const force = environment.TRIAGENT_CODEX_FORCE_OUTPUT_SCHEMA;
  if (force === '1' || force === 'true' || force === 'yes') return false;
  const omit = environment.TRIAGENT_CODEX_OMIT_OUTPUT_SCHEMA;
  if (omit === '1' || omit === 'true' || omit === 'yes') return true;
  try {
    const cfg = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
    if (/^\s*model_provider\s*=\s*"custom"/im.test(cfg)) return true;
    const base = /base_url\s*=\s*"([^"]+)"/i.exec(cfg);
    if (base?.[1] !== undefined && !/api\.openai\.com/i.test(base[1])) {
      return true;
    }
  } catch {
    // No config → keep official schema path.
  }
  return false;
}

/** Guard / adapter profile modes relevant to Codex command building. */
export type CodexGuardMode =
  | 'project_write'
  | 'read_only'
  | 'patch_mode'
  | 'auto_allowed'
  | 'disabled';

export type CodexSandboxMode = 'workspace-write' | 'read-only';
export type CodexApprovalPolicy = 'never';

export type CodexCommandOperation = 'start' | 'resume';

/**
 * Inputs required to build a Codex CLI argv array.
 * Command builders accept a verified capability record; they may not invent
 * flags from product name alone.
 */
export interface CodexCommandInput {
  readonly capabilityKey: CompatibilityKey;
  /** Exact verified matrix record; undefined ⇒ AdapterDisabled. */
  readonly capabilityRecord: CompatibilityRecord | undefined;
  readonly projectRoot: string;
  /**
   * Optional isolated candidate root for read-only review/master inspection.
   * When set, -C routes to this tree so Codex validates the candidate rather
   * than the still-empty pre-promote canonical project.
   */
  readonly inspectionRoot?: string;
  readonly role: AgentRole;
  readonly mode: CodexGuardMode;
  readonly nonGit: boolean;
  readonly schemaPath: string;
  readonly projectGuardDecisionId: string;
  readonly reservedBudgetId: string;
  readonly budgetAttemptId: AttemptId;
  readonly operation: CodexCommandOperation;
  readonly conversationId?: string;
  /** Optional executable override (tests); default `codex`. */
  readonly executable?: string;
  /**
   * When false, omit `--output-schema` from argv (still bind schemaPath for auth).
   * Needed for some custom Responses providers that 502 on structured-output
   * requests while plain exec works. Default true.
   */
  readonly emitOutputSchema?: boolean;
}

/**
 * Persisted run intent attached to every generated command.
 * Bindings must match Task 13 worker start-gate evidence.
 */
export interface CodexRunIntent {
  readonly capabilityKey: CompatibilityKey;
  readonly projectGuardDecisionId: string;
  readonly reservedBudgetId: string;
  readonly budgetAttemptId: AttemptId;
  readonly role: AgentRole;
  readonly mode: CodexGuardMode;
  readonly sandbox: CodexSandboxMode;
  readonly approval: CodexApprovalPolicy;
  readonly schemaPath: string;
  readonly nonGit: boolean;
  readonly projectRoot: string;
  readonly operation: CodexCommandOperation;
  readonly conversationId?: string;
  /** When true, implementer returns structured patch; PatchApplier is sole writer. */
  readonly structuredPatchRequired: boolean;
}

export interface CodexPermissionProfile {
  readonly projectRoot: string;
  readonly sandbox: CodexSandboxMode;
  readonly approval: CodexApprovalPolicy;
  readonly schemaPath: string;
  readonly nonGit: boolean;
  readonly json: true;
  readonly skipGitRepoCheck: boolean;
}

export type CodexCommandBuildResult =
  | {
      readonly ok: true;
      readonly executable: string;
      readonly args: readonly string[];
      readonly intent: CodexRunIntent;
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

function capabilityKeysEqual(a: CompatibilityKey, b: CompatibilityKey): boolean {
  return (
    a.cliName === b.cliName
    && a.version === b.version
    && a.platform === b.platform
  );
}

function disabled(reason: string): CodexCommandBuildResult {
  return { ok: false, code: 'AdapterDisabled', reason };
}

/**
 * Map role + ProjectGuard mode to Codex sandbox.
 * Reviewer/master → read-only; implementer project_write → workspace-write;
 * patch_mode → read-only (PatchApplier is the sole writer).
 */
export function resolveCodexSandbox(
  role: AgentRole,
  mode: CodexGuardMode,
): CodexSandboxMode | undefined {
  if (mode === 'disabled') return undefined;
  if (role === 'reviewer' || role === 'master') return 'read-only';
  if (mode === 'patch_mode' || mode === 'read_only') return 'read-only';
  if (mode === 'project_write' || mode === 'auto_allowed') {
    return 'workspace-write';
  }
  return undefined;
}

/**
 * Build a structural Codex argv array for a record whose current command
 * contract was verified by the static matrix or runtime help probes.
 * Never returns a shell string. Never adds dangerously-bypass or ephemeral.
 */
export function buildCodexCommand(
  input: CodexCommandInput,
): CodexCommandBuildResult {
  const record = input.capabilityRecord;
  if (record === undefined || !record.verified) {
    return disabled(
      `AdapterDisabled: unverified Codex compatibility record `
        + '(require verified requested version on matching platform)',
    );
  }
  if (record.key.cliName !== 'codex') {
    return disabled(
      `AdapterDisabled: capability record cliName is ${record.key.cliName}, not codex`,
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
  if (!record.jsonl || !record.outputSchema || !record.readOnly) {
    return disabled(
      'AdapterDisabled: verified record lacks required jsonl/outputSchema/readOnly',
    );
  }
  if (input.operation === 'resume' && !record.resume) {
    return disabled('AdapterDisabled: resume is not verified for this Codex version');
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
    return disabled('AdapterDisabled: schemaPath is required for launch authorization binding');
  }
  // Some custom Responses providers return 502 when Codex attaches --output-schema
  // (json_schema / structured output). Default remains emit-on; callers may omit.
  const emitOutputSchema = input.emitOutputSchema !== false;
  if (input.projectRoot.trim().length === 0) {
    return disabled('AdapterDisabled: projectRoot is required');
  }

  if (input.nonGit) {
    if (!record.nonGit || !record.capabilities.nonGitProjects) {
      return disabled(
        'AdapterDisabled: nonGit/--skip-git-repo-check is not verified for this record',
      );
    }
  }

  const sandbox = resolveCodexSandbox(input.role, input.mode);
  if (sandbox === undefined) {
    return disabled(
      `AdapterDisabled: cannot map role=${input.role} mode=${input.mode} to a sandbox`,
    );
  }
  if (sandbox === 'workspace-write' && !record.projectWrite) {
    return disabled(
      'AdapterDisabled: workspace-write is not verified for this Codex record',
    );
  }
  if (sandbox === 'read-only' && !record.readOnly) {
    return disabled(
      'AdapterDisabled: read-only sandbox is not verified for this Codex record',
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

  const approval: CodexApprovalPolicy = 'never';
  const structuredPatchRequired =
    input.mode === 'patch_mode' && input.role === 'implementer';
  const skipGit = input.nonGit === true;
  const inspectionRoot = input.inspectionRoot?.trim() ?? '';
  const workingRoot =
    inspectionRoot.length > 0 ? inspectionRoot : input.projectRoot;

  // Patch mode uses the strict patch-result schema so structured output
  // requires unifiedDiff + requestedCommands (PatchApplier is sole writer).
  const effectiveSchemaPath = structuredPatchRequired
    ? resolvePatchSchemaPath(input.schemaPath)
    : input.schemaPath;

  const intent: CodexRunIntent = Object.freeze({
    capabilityKey: Object.freeze({ ...input.capabilityKey }),
    projectGuardDecisionId: input.projectGuardDecisionId,
    reservedBudgetId: input.reservedBudgetId,
    budgetAttemptId: input.budgetAttemptId,
    role: input.role,
    mode: input.mode,
    sandbox,
    approval,
    schemaPath: effectiveSchemaPath,
    nonGit: input.nonGit,
    projectRoot: input.projectRoot,
    operation: input.operation,
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: input.conversationId }),
    structuredPatchRequired,
  });

  const executable = input.executable?.trim() || 'codex';
  const args =
    input.operation === 'start'
      ? buildStartArgs({
          projectRoot: workingRoot,
          sandbox,
          approval,
          schemaPath: effectiveSchemaPath,
          skipGit,
          emitOutputSchema,
        })
      : buildResumeArgs({
          projectRoot: workingRoot,
          sandbox,
          approval,
          schemaPath: effectiveSchemaPath,
          skipGit,
          conversationId: input.conversationId as string,
          emitOutputSchema,
        });

  // Hard bans: never emit these flags even if a future caller tries to inject them.
  const banned = [
    '--dangerously-bypass-approvals-and-sandbox',
    '--ephemeral',
  ];
  for (const flag of banned) {
    if (args.includes(flag)) {
      return disabled(`AdapterDisabled: forbidden flag ${flag}`);
    }
  }

  return {
    ok: true,
    executable,
    args: Object.freeze([...args]),
    intent,
  };
}

function buildStartArgs(options: {
  readonly projectRoot: string;
  readonly sandbox: CodexSandboxMode;
  readonly approval: CodexApprovalPolicy;
  readonly schemaPath: string;
  readonly skipGit: boolean;
  readonly emitOutputSchema: boolean;
}): string[] {
  // Exact contract:
  // codex -a never exec -C <project> -s workspace-write|read-only --json [--output-schema <schema>] -
  // Non-Git: --skip-git-repo-check only when verified.
  const args: string[] = [
    '-a',
    options.approval,
    'exec',
    '-C',
    options.projectRoot,
    '-s',
    options.sandbox,
  ];
  if (options.skipGit) {
    args.push('--skip-git-repo-check');
  }
  args.push('--json');
  if (options.emitOutputSchema) {
    args.push('--output-schema', options.schemaPath);
  }
  args.push('-');
  return args;
}

function buildResumeArgs(options: {
  readonly projectRoot: string;
  readonly sandbox: CodexSandboxMode;
  readonly approval: CodexApprovalPolicy;
  readonly schemaPath: string;
  readonly skipGit: boolean;
  readonly conversationId: string;
  readonly emitOutputSchema: boolean;
}): string[] {
  // Exact global-options-before-exec contract:
  // codex -C <project> -s <sandbox> -a never [ --skip-git-repo-check ]
  //   exec resume <conversation-id> --json [--output-schema <schema>] -
  const args: string[] = [
    '-C',
    options.projectRoot,
    '-s',
    options.sandbox,
    '-a',
    options.approval,
  ];
  if (options.skipGit) {
    args.push('--skip-git-repo-check');
  }
  args.push(
    'exec',
    'resume',
    options.conversationId,
    '--json',
  );
  if (options.emitOutputSchema) {
    args.push('--output-schema', options.schemaPath);
  }
  args.push('-');
  return args;
}

/**
 * Extract the security/permission profile from a successful build for
 * start↔resume equivalence assertions.
 */
export function extractCodexPermissionProfile(
  built: Extract<CodexCommandBuildResult, { ok: true }>,
): CodexPermissionProfile {
  return Object.freeze({
    projectRoot: built.intent.projectRoot,
    sandbox: built.intent.sandbox,
    approval: built.intent.approval,
    schemaPath: built.intent.schemaPath,
    nonGit: built.intent.nonGit,
    json: true as const,
    skipGitRepoCheck: built.intent.nonGit,
  });
}

/**
 * Fail closed when run intent bindings do not match Task 13 start-gate record.
 */
export function assertCodexRunBindings(
  intent: CodexRunIntent,
  gate: WorkerStartGateRecord,
): void {
  if (!capabilityKeysEqual(intent.capabilityKey, gate.capabilityKey)) {
    throw new Error(
      'Codex run intent capabilityKey does not match Task13 start gate',
    );
  }
  if (intent.projectGuardDecisionId !== gate.projectGuardDecisionId) {
    throw new Error(
      'Codex run intent projectGuardDecisionId does not match Task13 start gate',
    );
  }
  if (intent.reservedBudgetId !== gate.reservedBudgetId) {
    throw new Error(
      'Codex run intent reservedBudgetId does not match Task13 start gate',
    );
  }
  if (
    gate.projectGuardAttemptId !== undefined
    && gate.projectGuardAttemptId.length > 0
    && intent.budgetAttemptId !== gate.projectGuardAttemptId
  ) {
    throw new Error(
      'Codex run intent budgetAttemptId does not match Task13 start gate attempt',
    );
  }
  // Mode must be compatible with the persisted guard mode string.
  if (
    gate.projectGuardMode.length > 0
    && intent.mode !== gate.projectGuardMode
    && !modesCompatible(intent.mode, gate.projectGuardMode)
  ) {
    throw new Error(
      `Codex run intent mode (${intent.mode}) does not match projectGuardMode (${gate.projectGuardMode})`,
    );
  }
  if (!gate.budgetCanLaunch) {
    throw new Error('Codex run intent rejected: budgetCanLaunch is false');
  }
}

function modesCompatible(intentMode: string, gateMode: string): boolean {
  // auto_allowed may have been recorded with profileMode project_write / read_only.
  if (gateMode === 'auto_allowed') {
    return (
      intentMode === 'project_write'
      || intentMode === 'read_only'
      || intentMode === 'auto_allowed'
    );
  }
  if (intentMode === 'auto_allowed') {
    return gateMode === 'project_write' || gateMode === 'read_only';
  }
  return intentMode === gateMode;
}

const PATCH_SCHEMA_BASENAME = 'agent-patch-result.schema.json';

/**
 * Resolve the strict patch-mode schema path next to the default agent-result
 * schema (or absolute override ending in the patch schema name).
 */
function resolvePatchSchemaPath(schemaPath: string): string {
  const trimmed = schemaPath.trim();
  if (trimmed.endsWith(PATCH_SCHEMA_BASENAME)) {
    return trimmed;
  }
  // Prefer sibling of the provided schema path (schemas/ directory).
  try {
    return resolve(dirname(trimmed), PATCH_SCHEMA_BASENAME);
  } catch {
    return resolve('schemas', PATCH_SCHEMA_BASENAME);
  }
}
