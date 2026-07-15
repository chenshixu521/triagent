/**
 * Opt-in disposable-project enforcement proof for Grok 0.2.93.
 * Default matrix keeps readOnly=false / writeModes=[] until evidence is loaded.
 * Live proof is produced only when TRIAGENT_REAL_AI_TESTS=1 (not in default CI).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  CompatibilityKey,
  CompatibilityRecord,
} from '../compatibility-matrix.js';
import { registerGrokCompatibilityElevator } from '../compatibility-matrix.js';
import type { AgentCapabilities } from '../agent-capabilities.js';

// Elevate matrix lookups whenever process-local proofs are registered,
// without requiring GrokAdapter import.
registerGrokCompatibilityElevator((record) => {
  return resolveGrokCompatibilityRecord(record) ?? record;
});

export const GROK_ENFORCEMENT_PROOF_SCHEMA = 'triagent.grok.enforcement_proof.v1' as const;

export interface GrokEnforcementProof {
  readonly schema: typeof GROK_ENFORCEMENT_PROOF_SCHEMA;
  readonly cliName: 'grok';
  readonly version: string;
  readonly platform: NodeJS.Platform;
  /** Profile that was proven (plan + tool deny against disposable project). */
  readonly profile: 'permission-mode-plan-tool-deny';
  readonly provenAt: string;
  readonly liveProjectAccess: false;
  readonly enforcementProven: true;
  readonly zeroFilesystemEvents: true;
  readonly sentinelHashesUnchanged: true;
  readonly attemptedWriteDenied: true;
  readonly runStatus: 'succeeded';
  readonly resultSchemaValid: true;
  readonly evidenceNotes: readonly string[];
}

export function grokEnforcementProofKey(
  key: Pick<CompatibilityKey, 'cliName' | 'version' | 'platform'>,
): string {
  return `${key.cliName}@${key.version}@${key.platform}`;
}

export function isGrokEnforcementProof(value: unknown): value is GrokEnforcementProof {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.schema === GROK_ENFORCEMENT_PROOF_SCHEMA
    && v.cliName === 'grok'
    && typeof v.version === 'string'
    && typeof v.platform === 'string'
    && v.profile === 'permission-mode-plan-tool-deny'
    && typeof v.provenAt === 'string'
    && v.liveProjectAccess === false
    && v.enforcementProven === true
    && v.zeroFilesystemEvents === true
    && v.sentinelHashesUnchanged === true
    && v.attemptedWriteDenied === true
    && v.runStatus === 'succeeded'
    && v.resultSchemaValid === true
    && Array.isArray(v.evidenceNotes)
  );
}

export function defaultGrokEnforcementProofPath(
  baseDir: string,
  key: Pick<CompatibilityKey, 'cliName' | 'version' | 'platform'>,
): string {
  return join(
    baseDir,
    'grok-enforcement-proof',
    `${key.cliName}@${key.version}@${key.platform}.json`,
  );
}

/**
 * Persist proof evidence keyed by exact version/platform/profile.
 * Only called after a successful opt-in live disposable-project run.
 */
export function persistGrokEnforcementProof(
  path: string,
  proof: GrokEnforcementProof,
): void {
  if (!isGrokEnforcementProof(proof)) {
    throw new Error('invalid Grok enforcement proof payload');
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'w',
    mode: 0o600,
  });
}

export function loadGrokEnforcementProof(
  path: string,
): GrokEnforcementProof | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isGrokEnforcementProof(raw)) return undefined;
    return Object.freeze({ ...raw, evidenceNotes: Object.freeze([...raw.evidenceNotes]) });
  } catch {
    return undefined;
  }
}

/**
 * When loaded proof matches the exact key, elevate the static (disabled)
 * matrix record to a proven read-only profile for that version/platform only.
 * Default static matrix remains disabled when no proof is loaded.
 */
export function applyGrokEnforcementProof(
  record: CompatibilityRecord,
  proof: GrokEnforcementProof | undefined,
): CompatibilityRecord {
  if (proof === undefined) return record;
  if (record.key.cliName !== 'grok') return record;
  if (
    proof.cliName !== record.key.cliName
    || proof.version !== record.key.version
    || proof.platform !== record.key.platform
  ) {
    return record;
  }
  if (!proof.enforcementProven || proof.liveProjectAccess !== false) {
    return record;
  }

  const capabilities: AgentCapabilities = Object.freeze({
    ...record.capabilities,
    nativePermissionRules: true,
    writeModes: Object.freeze(['read-only'] as const),
  });

  return Object.freeze({
    ...record,
    readOnly: true,
    capabilities,
    notes: Object.freeze([
      ...record.notes,
      'enforcement proof loaded: permission-mode plan + tool deny (disposable project)',
      `provenAt=${proof.provenAt}`,
    ]),
  });
}

/** In-memory registry for process-local proof loading (tests / runtime). */
const LOADED_PROOFS = new Map<string, GrokEnforcementProof>();

export function registerLoadedGrokEnforcementProof(
  proof: GrokEnforcementProof,
): void {
  if (!isGrokEnforcementProof(proof)) {
    throw new Error('invalid Grok enforcement proof');
  }
  LOADED_PROOFS.set(
    grokEnforcementProofKey({
      cliName: proof.cliName,
      version: proof.version,
      platform: proof.platform,
    }),
    Object.freeze({ ...proof, evidenceNotes: Object.freeze([...proof.evidenceNotes]) }),
  );
}

export function clearLoadedGrokEnforcementProofs(): void {
  LOADED_PROOFS.clear();
}

export function getLoadedGrokEnforcementProof(
  key: Pick<CompatibilityKey, 'cliName' | 'version' | 'platform'>,
): GrokEnforcementProof | undefined {
  return LOADED_PROOFS.get(grokEnforcementProofKey(key));
}

/**
 * Resolve Grok matrix record: static defaults stay enforcement-unproven;
 * loaded proof elevates only the matching version/platform.
 */
export function resolveGrokCompatibilityRecord(
  record: CompatibilityRecord | undefined,
): CompatibilityRecord | undefined {
  if (record === undefined || record.key.cliName !== 'grok') return record;
  const proof = getLoadedGrokEnforcementProof(record.key);
  return applyGrokEnforcementProof(record, proof);
}
