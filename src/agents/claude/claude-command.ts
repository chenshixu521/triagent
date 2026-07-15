import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  type CompatibilityKey,
  type CompatibilityRecord,
  type WorkerStartGateRecord,
} from '../compatibility-matrix.js';
import type { AttemptId } from '../../domain/ids.js';
import type { AgentRole } from '../../domain/task.js';
import { resolvePackageResourcePath } from '../../process/native-helper-discovery.js';
import type { ProcessStdinPayload } from '../../process/process-supervisor-port.js';

/**
 * Guard / adapter profile modes relevant to Claude command building.
 * project_write is only emitted when the exact write tool profile is proven;
 * for Claude Code 2.1.206 that profile is not proven (no project-scoped sandbox),
 * so implementer must use patch_mode (PatchApplier sole writer).
 */
export type ClaudeGuardMode =
  | 'project_write'
  | 'read_only'
  | 'patch_mode'
  | 'auto_allowed'
  | 'disabled';

export type ClaudeCommandOperation = 'start' | 'resume';

/**
 * Verified Claude Code 2.1.206 read-only tools.
 * Proven via `claude --help` tool-filter flags (`--tools`, `--disallowedTools`)
 * and the Task 15 / compatibility-matrix contract for this exact version.
 * Help examples name Bash, Edit, Read; Glob and Grep are standard Claude Code
 * built-ins accepted by `--tools` on 2.1.206 and required by the plan contract.
 */
export const CLAUDE_VERIFIED_READ_ONLY_TOOLS = Object.freeze([
  'Read',
  'Glob',
  'Grep',
] as const);

/**
 * Current-CLI-known write tools denied as defense in depth. The explicit --tools
 * allowlist remains the primary read-only boundary; unknown deny names are not
 * emitted because current Claude versions reject the entire command.
 */
export const CLAUDE_VERIFIED_DISALLOWED_WRITE_TOOLS = Object.freeze([
  'Edit',
  'Write',
  'Bash',
] as const);

/** Static baseline Claude Code version used by the compatibility matrix. */
export const VERIFIED_CLAUDE_VERSION = '2.1.206';

/**
 * Project-write automatic mode remains disabled for Claude 2.1.206:
 * help proves tool filters and permission-mode, but not an OS/project-scoped
 * write sandbox equivalent to Codex workspace-write. Prefer patch_mode.
 */
export const CLAUDE_PROJECT_WRITE_AUTO_PROVEN = false;

/**
 * Hard bound for JSON Schema content passed via --json-schema (256 KiB).
 * Claude 2.1.206 expects schema *content*, not a file path.
 */
export const CLAUDE_JSON_SCHEMA_MAX_BYTES = 256 * 1024;

const RESULT_SCHEMA_BASENAME = 'agent-result.schema.json';
const PATCH_SCHEMA_BASENAME = 'agent-patch-result.schema.json';

function defaultSchemasDirectory(): string {
  return resolvePackageResourcePath('schemas', import.meta.url);
}

/**
 * Allowlisted schema basenames the adapter may load. Never project-controlled
 * arbitrary files — only the orchestrator-owned result / patch contracts.
 */
const ALLOWLISTED_SCHEMA_BASENAMES = new Set([
  RESULT_SCHEMA_BASENAME,
  PATCH_SCHEMA_BASENAME,
]);

export interface ClaudeJsonSchemaLoadResult {
  readonly schemaPath: string;
  readonly content: string;
  readonly byteLength: number;
  readonly contentSha256: string;
}

/**
 * Securely load + parse + canonical-serialize a selected result/patch schema.
 * Rejects non-allowlisted paths, invalid JSON, non-object roots, and oversized
 * content before any process start.
 */
export function loadClaudeJsonSchemaContent(
  schemaPath: string,
  options: { readonly maxBytes?: number } = {},
): ClaudeJsonSchemaLoadResult {
  const maxBytes = options.maxBytes ?? CLAUDE_JSON_SCHEMA_MAX_BYTES;
  const trimmed = schemaPath.trim();
  if (trimmed.length === 0) {
    throw new AdapterDisabledError(
      'AdapterDisabled: schemaPath is required for --json-schema content',
    );
  }

  const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(trimmed);
  const name = basename(candidate);
  if (!ALLOWLISTED_SCHEMA_BASENAMES.has(name)) {
    throw new AdapterDisabledError(
      `AdapterDisabled: schema basename ${name} is not allowlisted `
        + `(only ${[...ALLOWLISTED_SCHEMA_BASENAMES].join(', ')})`,
    );
  }

  // Prefer the orchestrator schemas directory; allow exact basename match under
  // a realpath that ends with the allowlisted name (tests may pass resolve()).
  const schemasDir = defaultSchemasDirectory();
  let resolvedPath = resolve(schemasDir, name);
  try {
    // If caller passed the same basename under schemas/, use that real path.
    const callerBase = basename(candidate);
    if (callerBase === name) {
      try {
        const realCaller = realpathSync(candidate);
        if (basename(realCaller) === name) {
          // Only accept if file exists and basename is allowlisted (already checked).
          // Reject if the path is outside known schemas when basename would still match
          // an evil file named agent-result.schema.json in a project tree: require that
          // either the path is under defaultSchemasDirectory or equals resolve(schemas, name).
          const realSchemas = realpathSync(schemasDir);
          if (
            realCaller === resolve(realSchemas, name)
            || realCaller.startsWith(realSchemas + '\\')
            || realCaller.startsWith(realSchemas + '/')
            || realCaller === candidate
            || basename(dirname(realCaller)) === 'schemas'
          ) {
            // Accept only when parent directory is named "schemas" (orchestrator layout)
            // or under the package schemas directory. Blocks project-controlled
            // agent-result.schema.json dropped in arbitrary folders.
            if (
              realCaller === resolve(realSchemas, name)
              || realCaller.startsWith(realSchemas + '\\')
              || realCaller.startsWith(realSchemas + '/')
              || basename(dirname(realCaller)) === 'schemas'
            ) {
              resolvedPath = realCaller;
            }
          }
        }
      } catch {
        // fall through to package schemas path
      }
    }
  } catch {
    // keep resolvedPath = package schemas
  }

  let raw: string;
  try {
    const st = statSync(resolvedPath);
    if (!st.isFile()) {
      throw new AdapterDisabledError(
        `AdapterDisabled: schema path is not a file: ${name}`,
      );
    }
    if (st.size > maxBytes) {
      throw new AdapterDisabledError(
        `AdapterDisabled: schema content too large (${st.size} bytes; max ${maxBytes})`,
      );
    }
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    if (error instanceof AdapterDisabledError) throw error;
    throw new AdapterDisabledError(
      `AdapterDisabled: cannot read allowlisted schema ${name}: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }

  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength > maxBytes) {
    throw new AdapterDisabledError(
      `AdapterDisabled: schema content too large (${byteLength} bytes; max ${maxBytes})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AdapterDisabledError(
      `AdapterDisabled: schema ${name} is not valid JSON: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
  ) {
    throw new AdapterDisabledError(
      `AdapterDisabled: schema ${name} root must be a JSON object`,
    );
  }

  // Claude's current --json-schema validator accepts the contract keywords but
  // does not preload the Draft 2020-12 meta-schema named by our source files.
  // Remove only the dialect declaration for the CLI payload; the repository
  // schema and all validation constraints remain unchanged.
  const { $schema: _dialect, ...claudeCompatibleSchema } = parsed as Record<
    string,
    unknown
  >;
  const content = JSON.stringify(claudeCompatibleSchema);
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw new AdapterDisabledError(
      `AdapterDisabled: canonical schema content too large for ${name}`,
    );
  }

  return Object.freeze({
    schemaPath: resolvedPath,
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  });
}

export interface ClaudeCommandInput {
  readonly capabilityKey: CompatibilityKey;
  /** Exact verified matrix record; undefined ⇒ AdapterDisabled. */
  readonly capabilityRecord: CompatibilityRecord | undefined;
  readonly projectRoot: string;
  /**
   * Optional isolated candidate root for read-only review/master inspection.
   * When set, --add-dir prefers this tree (plus projectRoot) so tools can
   * validate the candidate without treating the live project as the target.
   */
  readonly inspectionRoot?: string;
  readonly role: AgentRole;
  readonly mode: ClaudeGuardMode;
  readonly nonGit: boolean;
  readonly schemaPath: string;
  readonly projectGuardDecisionId: string;
  readonly reservedBudgetId: string;
  readonly budgetAttemptId: AttemptId;
  readonly operation: ClaudeCommandOperation;
  readonly conversationId?: string;
  /**
   * Fixed session UUID for start. Must be a valid UUID when provided.
   * When omitted on start, builder generates one (capability.fixedSessionId).
   */
  readonly sessionId?: string;
  /**
   * Optional max budget USD when capability.maxBudget is verified.
   * For 2.1.206 matrix maxBudget is false — must not be emitted.
   */
  readonly maxBudgetUsd?: number;
  /**
   * Prompt text delivered via ProcessSupervisor stdin (default).
   * Never placed on argv / process list.
   */
  readonly prompt?: string;
  /**
   * @deprecated Prompt is always delivered via stdin for Claude 2.1.206.
   * Setting false is rejected (AdapterDisabled) to prevent prompt-in-argv.
   */
  readonly promptViaStdin?: boolean;
  /** Optional executable override (tests); default `claude`. */
  readonly executable?: string;
}

export interface ClaudeRunIntent {
  readonly capabilityKey: CompatibilityKey;
  readonly projectGuardDecisionId: string;
  readonly reservedBudgetId: string;
  readonly budgetAttemptId: AttemptId;
  readonly role: AgentRole;
  readonly mode: ClaudeGuardMode;
  readonly permissionMode: 'auto' | 'plan';
  /** Resolved allowlisted schema filesystem path (for auth binding). */
  readonly schemaPath: string;
  /** Canonical JSON Schema content passed as --json-schema value. */
  readonly schemaContent: string;
  readonly schemaContentSha256: string;
  readonly nonGit: boolean;
  readonly projectRoot: string;
  readonly operation: ClaudeCommandOperation;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  /** When true, implementer returns structured patch; PatchApplier is sole writer. */
  readonly structuredPatchRequired: boolean;
  /** Always stdin for Claude 2.1.206 (verified --input-format text). */
  readonly promptDelivery: 'stdin';
  /** Always true when --safe-mode is required and present. */
  readonly safeMode: true;
}

export interface ClaudePermissionProfile {
  readonly projectRoot: string;
  readonly permissionMode: 'auto' | 'plan';
  readonly outputFormat: 'stream-json';
  readonly schemaPath: string;
  readonly schemaContent: string;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly nonGit: boolean;
  readonly includePartialMessages: false;
  readonly safeMode: true;
  readonly inputFormat: 'text';
}

export type ClaudeCommandBuildResult =
  | {
      readonly ok: true;
      readonly executable: string;
      readonly args: readonly string[];
      readonly intent: ClaudeRunIntent;
      /**
       * Redacted argv suitable for persistence / diagnostics.
       * Schema content is replaced with [REDACTED_JSON_SCHEMA].
       * Prompt is never present on argv.
       */
      readonly argsForEvidence: readonly string[];
      /** Exact UTF-8 stdin payload for ProcessSupervisor (prompt). */
      readonly stdinPayload: ProcessStdinPayload;
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

function disabled(reason: string): ClaudeCommandBuildResult {
  return { ok: false, code: 'AdapterDisabled', reason };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidClaudeSessionUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/**
 * Resolve effective guard mode for Claude.
 * project_write auto is not proven → fail closed (caller must use patch_mode).
 * auto_allowed maps to patch_mode for implementer, read_only for review roles.
 */
export function resolveClaudeEffectiveMode(
  role: AgentRole,
  mode: ClaudeGuardMode,
): ClaudeGuardMode | undefined {
  if (mode === 'disabled') return undefined;
  if (role === 'reviewer' || role === 'master') {
    if (mode === 'project_write') return undefined;
    return 'read_only';
  }
  // implementer
  if (mode === 'project_write') {
    if (!CLAUDE_PROJECT_WRITE_AUTO_PROVEN) return undefined;
    return 'project_write';
  }
  if (mode === 'auto_allowed') {
    // Prefer proven patch_mode over unproven project-write auto.
    return 'patch_mode';
  }
  if (mode === 'patch_mode' || mode === 'read_only') return mode;
  return undefined;
}

/**
 * Hash of the permission profile for session evidence binding.
 */
export function hashClaudePermissionProfile(
  profile: Pick<
    ClaudePermissionProfile,
    | 'permissionMode'
    | 'allowedTools'
    | 'disallowedTools'
    | 'schemaPath'
    | 'safeMode'
    | 'inputFormat'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        permissionMode: profile.permissionMode,
        allowedTools: profile.allowedTools,
        disallowedTools: profile.disallowedTools,
        schemaPath: profile.schemaPath,
        safeMode: profile.safeMode,
        inputFormat: profile.inputFormat,
      }),
      'utf8',
    )
    .digest('hex');
}

/**
 * Build a structural Claude argv array for a record whose current command
 * contract was verified by the static matrix or runtime help probes.
 * Never returns a shell string. Never adds dangerously-skip-permissions.
 *
 * Start contract (prompt via stdin, not argv):
 *   claude -p --safe-mode --output-format stream-json --verbose --input-format text
 *     --session-id <uuid> --json-schema <CONTENT> --permission-mode auto
 *     --tools Read,Glob,Grep --disallowedTools Edit,Write,Bash,...
 *     --add-dir <project>
 *
 * Resume contract:
 *   claude -p --resume <conversation-id> --safe-mode ...
 *     (same security flags reattached; prompt via stdin)
 */
export function buildClaudeCommand(
  input: ClaudeCommandInput,
): ClaudeCommandBuildResult {
  const record = input.capabilityRecord;
  if (record === undefined || !record.verified) {
    return disabled(
      `AdapterDisabled: unverified Claude compatibility record `
        + '(require verified requested version on matching platform)',
    );
  }
  if (record.key.cliName !== 'claude') {
    return disabled(
      `AdapterDisabled: capability record cliName is ${record.key.cliName}, not claude`,
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
    return disabled('AdapterDisabled: resume is not verified for this Claude version');
  }
  if (input.operation === 'start' && !record.fixedSessionId) {
    return disabled(
      'AdapterDisabled: fixed session-id is not verified for this Claude version',
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
    return disabled('AdapterDisabled: schemaPath is required for --json-schema');
  }
  if (input.projectRoot.trim().length === 0) {
    return disabled('AdapterDisabled: projectRoot is required');
  }

  // Prompt-in-argv is forbidden; only stdin delivery is verified safe.
  if (input.promptViaStdin === false) {
    return disabled(
      'AdapterDisabled: verified Claude contract requires prompt via stdin '
        + '(--input-format text); prompt must not appear in argv/process list',
    );
  }

  const effectiveMode = resolveClaudeEffectiveMode(input.role, input.mode);
  if (effectiveMode === undefined) {
    if (
      input.role === 'implementer'
      && input.mode === 'project_write'
      && !CLAUDE_PROJECT_WRITE_AUTO_PROVEN
    ) {
      return disabled(
        'AdapterDisabled: Claude implementer project-write auto is not proven '
          + '(no project-scoped write sandbox); use patch_mode with Read,Glob,Grep '
          + 'and PatchApplier as sole writer',
      );
    }
    return disabled(
      `AdapterDisabled: cannot map role=${input.role} mode=${input.mode} `
        + 'to a verified Claude permission profile',
    );
  }

  if (!record.readOnly) {
    return disabled(
      'AdapterDisabled: read-only tool profile is not verified for this Claude record',
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

  if (input.maxBudgetUsd !== undefined) {
    if (!record.maxBudget || !record.capabilities.budgetLimit) {
      return disabled(
        'AdapterDisabled: maxBudget/--max-budget-usd is not verified for this Claude record',
      );
    }
  }

  const structuredPatchRequired =
    effectiveMode === 'patch_mode' && input.role === 'implementer';

  const allowedTools: readonly string[] = [...CLAUDE_VERIFIED_READ_ONLY_TOOLS];
  const disallowedTools: readonly string[] = [
    ...CLAUDE_VERIFIED_DISALLOWED_WRITE_TOOLS,
  ];

  for (const banned of CLAUDE_VERIFIED_DISALLOWED_WRITE_TOOLS) {
    if ((allowedTools as readonly string[]).includes(banned)) {
      return disabled(
        `AdapterDisabled: forbidden tool ${banned} in allowed tools`,
      );
    }
  }

  const schemaPathForLoad = structuredPatchRequired
    ? resolvePatchSchemaPath(input.schemaPath)
    : input.schemaPath;

  let schemaLoaded: ClaudeJsonSchemaLoadResult;
  try {
    schemaLoaded = loadClaudeJsonSchemaContent(schemaPathForLoad);
  } catch (error) {
    if (error instanceof AdapterDisabledError) {
      return disabled(error.message);
    }
    return disabled(
      `AdapterDisabled: schema load failed: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }

  const permissionMode: 'auto' | 'plan' = 'auto';

  let sessionId: string | undefined;
  if (input.operation === 'start') {
    const provided = input.sessionId?.trim();
    if (provided !== undefined && provided.length > 0) {
      if (!isValidClaudeSessionUuid(provided)) {
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
      'AdapterDisabled: Claude requires a non-empty prompt delivered via stdin '
        + '(--input-format text); prompt must not appear in argv',
    );
  }

  const intent: ClaudeRunIntent = Object.freeze({
    capabilityKey: Object.freeze({ ...input.capabilityKey }),
    projectGuardDecisionId: input.projectGuardDecisionId,
    reservedBudgetId: input.reservedBudgetId,
    budgetAttemptId: input.budgetAttemptId,
    role: input.role,
    mode: effectiveMode,
    permissionMode,
    schemaPath: schemaLoaded.schemaPath,
    schemaContent: schemaLoaded.content,
    schemaContentSha256: schemaLoaded.contentSha256,
    nonGit: input.nonGit,
    projectRoot: input.projectRoot,
    operation: input.operation,
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: input.conversationId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    allowedTools: Object.freeze([...allowedTools]),
    disallowedTools: Object.freeze([...disallowedTools]),
    structuredPatchRequired,
    promptDelivery: 'stdin' as const,
    safeMode: true as const,
  });

  const executable = input.executable?.trim() || 'claude';
  const toolsCsv = allowedTools.join(',');
  const disallowedCsv = disallowedTools.join(',');

  const args: string[] = [];
  // Always -p (print / non-interactive) first after executable.
  args.push('-p');

  if (input.operation === 'resume') {
    args.push('--resume', input.conversationId as string);
  } else {
    args.push('--session-id', sessionId as string);
  }

  // Customization isolation: --safe-mode disables CLAUDE.md/skills/plugins/
  // hooks/MCP/custom agents (verified Claude 2.1.206 help). Fail closed if we
  // ever drop this flag (checked below).
  args.push(
    '--safe-mode',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'text',
    '--json-schema',
    schemaLoaded.content,
    '--permission-mode',
    permissionMode,
    '--tools',
    toolsCsv,
    '--disallowedTools',
    disallowedCsv,
  );

  // Project directory context: --add-dir scopes additional tool access roots.
  // cwd is set separately by the adapter via ProcessSupervisor.
  // Prefer inspectionRoot (isolated candidate) when present so read-only
  // reviewer/master tools see the candidate tree, not the pre-promote canonical.
  const inspectionRoot = input.inspectionRoot?.trim() ?? '';
  if (inspectionRoot.length > 0) {
    args.push('--add-dir', inspectionRoot);
    if (inspectionRoot !== input.projectRoot) {
      args.push('--add-dir', input.projectRoot);
    }
  } else {
    args.push('--add-dir', input.projectRoot);
  }

  // Hard bans: dangerous permissions, partial messages, customization loaders.
  const banned = [
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--include-partial-messages',
    '--mcp-config',
    '--plugin-dir',
    '--plugin-url',
    '--settings',
    '--setting-sources',
    '--agents',
    '--agent',
    '--bare',
  ];
  for (const flag of banned) {
    if (args.includes(flag)) {
      return disabled(`AdapterDisabled: forbidden flag ${flag}`);
    }
  }
  if (!args.includes('--safe-mode')) {
    return disabled(
      'AdapterDisabled: --safe-mode is required for Claude customization isolation',
    );
  }
  // Prompt must never appear as argv token.
  if (args.includes(promptText)) {
    return disabled(
      'AdapterDisabled: prompt leaked into argv; use stdin only',
    );
  }

  const argsForEvidence = Object.freeze(
    args.map((part, index) => {
      if (index > 0 && args[index - 1] === '--json-schema') {
        return '[REDACTED_JSON_SCHEMA]';
      }
      return part;
    }),
  );

  const stdinPayload: ProcessStdinPayload = Object.freeze({
    encoding: 'utf8' as const,
    data: promptText,
    closeAfterWrite: true,
  });

  return {
    ok: true,
    executable,
    args: Object.freeze([...args]),
    intent,
    argsForEvidence,
    stdinPayload,
  };
}

/**
 * Extract the security/permission profile from a successful build for
 * start↔resume equivalence assertions.
 */
export function extractClaudePermissionProfile(
  built: Extract<ClaudeCommandBuildResult, { ok: true }>,
): ClaudePermissionProfile {
  return Object.freeze({
    projectRoot: built.intent.projectRoot,
    permissionMode: built.intent.permissionMode,
    outputFormat: 'stream-json' as const,
    schemaPath: built.intent.schemaPath,
    schemaContent: built.intent.schemaContent,
    allowedTools: Object.freeze([...built.intent.allowedTools]),
    disallowedTools: Object.freeze([...built.intent.disallowedTools]),
    nonGit: built.intent.nonGit,
    includePartialMessages: false as const,
    safeMode: true as const,
    inputFormat: 'text' as const,
  });
}

/**
 * Fail closed when run intent bindings do not match Task 13 start-gate record.
 */
export function assertClaudeRunBindings(
  intent: ClaudeRunIntent,
  gate: WorkerStartGateRecord,
): void {
  if (!capabilityKeysEqual(intent.capabilityKey, gate.capabilityKey)) {
    throw new Error(
      'Claude run intent capabilityKey does not match Task13 start gate',
    );
  }
  if (intent.projectGuardDecisionId !== gate.projectGuardDecisionId) {
    throw new Error(
      'Claude run intent projectGuardDecisionId does not match Task13 start gate',
    );
  }
  if (intent.reservedBudgetId !== gate.reservedBudgetId) {
    throw new Error(
      'Claude run intent reservedBudgetId does not match Task13 start gate',
    );
  }
  if (
    gate.projectGuardAttemptId !== undefined
    && gate.projectGuardAttemptId.length > 0
    && intent.budgetAttemptId !== gate.projectGuardAttemptId
  ) {
    throw new Error(
      'Claude run intent budgetAttemptId does not match Task13 start gate attempt',
    );
  }
  if (
    gate.projectGuardMode.length > 0
    && intent.mode !== gate.projectGuardMode
    && !modesCompatible(intent.mode, gate.projectGuardMode)
  ) {
    throw new Error(
      `Claude run intent mode (${intent.mode}) does not match projectGuardMode (${gate.projectGuardMode})`,
    );
  }
  if (!gate.budgetCanLaunch) {
    throw new Error('Claude run intent rejected: budgetCanLaunch is false');
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

function resolvePatchSchemaPath(schemaPath: string): string {
  const trimmed = schemaPath.trim();
  if (trimmed.endsWith(PATCH_SCHEMA_BASENAME)) {
    return trimmed;
  }
  try {
    return resolve(dirname(trimmed), PATCH_SCHEMA_BASENAME);
  } catch {
    return resolve(defaultSchemasDirectory(), PATCH_SCHEMA_BASENAME);
  }
}
