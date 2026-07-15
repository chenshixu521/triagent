import type {
  CompatibilityKey,
  CompatibilityRecord,
} from './compatibility-matrix.js';
import {
  assertCompatibilityRecordInvariants,
  lookupCompatibility,
  registerRuntimeCompatibility,
} from './compatibility-matrix.js';
import {
  compatibilityProbeContractHash,
  deriveProbedCompatibilityRecord,
  getCompatibilityProbeManifest,
  isVersionEligibleForDynamicProbe,
} from './compatibility-probe-manifests.js';
import {
  loadCompatibilityCache,
  receiptMatches,
  resolveExecutableIdentity,
  saveCompatibilityCache,
  type CompatibilityCacheReceipt,
  type ExecutableIdentityProvider,
} from './compatibility-cache.js';
import type {
  CommandProbeEvidence,
  CommandProbeResult,
} from './health/command-probe.js';

export const DEFAULT_COMPATIBILITY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface CompatibilityProbePort {
  runArgv(
    executable: string,
    args: readonly string[],
  ): Promise<CommandProbeResult>;
}

export interface CompatibilityResolverOptions {
  readonly cachePath: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executableCwd?: string;
  readonly identityProvider?: ExecutableIdentityProvider;
}

export interface CompatibilityResolutionRequest {
  readonly key: CompatibilityKey;
  readonly executable: string;
  readonly probe: CompatibilityProbePort;
}

export type CompatibilityResolutionResult =
  | {
      readonly status: 'verified';
      readonly source: 'matrix' | 'cache' | 'probe';
      readonly record: CompatibilityRecord;
      readonly evidence: readonly CommandProbeEvidence[];
      readonly warning?: string;
    }
  | {
      readonly status: 'unsupported';
      readonly reason: string;
      readonly evidence: readonly CommandProbeEvidence[];
    };

export interface CompatibilityResolverPort {
  resolve(
    request: CompatibilityResolutionRequest,
  ): Promise<CompatibilityResolutionResult>;
}

function positiveDuration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function sameReceiptKey(
  receipt: CompatibilityCacheReceipt,
  key: CompatibilityKey,
): boolean {
  return receipt.cliName === key.cliName
    && receipt.version === key.version
    && receipt.platform === key.platform;
}

export class CompatibilityResolver implements CompatibilityResolverPort {
  readonly #cachePath: string;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #executableCwd: string;
  readonly #identityProvider: ExecutableIdentityProvider;
  #entries: readonly CompatibilityCacheReceipt[];
  #writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: CompatibilityResolverOptions) {
    if (options.cachePath.trim().length === 0) {
      throw new Error('compatibility cachePath must be non-empty');
    }
    this.#cachePath = options.cachePath;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = positiveDuration(
      options.ttlMs ?? DEFAULT_COMPATIBILITY_CACHE_TTL_MS,
      'compatibility cache ttlMs',
    );
    this.#environment = options.environment ?? process.env;
    this.#executableCwd = options.executableCwd ?? process.cwd();
    this.#identityProvider = options.identityProvider ?? resolveExecutableIdentity;
    this.#entries = loadCompatibilityCache(options.cachePath);
  }

  public async resolve(
    request: CompatibilityResolutionRequest,
  ): Promise<CompatibilityResolutionResult> {
    const known = lookupCompatibility(request.key);
    if (known !== undefined) {
      return {
        status: 'verified',
        source: 'matrix',
        record: known,
        evidence: Object.freeze([]),
      };
    }
    if (!isVersionEligibleForDynamicProbe(request.key.cliName, request.key.version)) {
      return {
        status: 'unsupported',
        reason:
          `version is outside the dynamic compatibility range: `
          + `${request.key.cliName}@${request.key.version}`,
        evidence: Object.freeze([]),
      };
    }

    let executableIdentity;
    try {
      executableIdentity = await this.#identityProvider({
        executable: request.executable,
        environment: this.#environment,
        cwd: this.#executableCwd,
        platform: request.key.platform,
      });
    } catch (error) {
      return {
        status: 'unsupported',
        reason:
          `cannot verify executable identity for ${request.key.cliName}: `
          + (error instanceof Error ? error.message : String(error)),
        evidence: Object.freeze([]),
      };
    }

    const nowMs = this.#now();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      return {
        status: 'unsupported',
        reason: 'compatibility resolver clock returned an invalid time',
        evidence: Object.freeze([]),
      };
    }
    const probeContractHash = compatibilityProbeContractHash(request.key.cliName);
    const cached = this.#entries.find((receipt) => receiptMatches(receipt, {
      key: request.key,
      executableIdentity,
      probeContractHash,
      nowMs,
    }));
    if (cached !== undefined) {
      const record = this.#registerDerivedRecord(request.key);
      return {
        status: 'verified',
        source: 'cache',
        record,
        evidence: Object.freeze([]),
      };
    }

    const evidence: CommandProbeEvidence[] = [];
    const manifest = getCompatibilityProbeManifest(request.key.cliName);
    for (const contract of manifest.probes) {
      let probeResult: CommandProbeResult;
      try {
        probeResult = await request.probe.runArgv(
          request.executable,
          contract.args,
        );
      } catch (error) {
        return {
          status: 'unsupported',
          reason:
            `compatibility probe threw for ${request.key.cliName} `
            + `${contract.args.join(' ')}: `
            + (error instanceof Error ? error.message : String(error)),
          evidence: Object.freeze([...evidence]),
        };
      }
      evidence.push(probeResult.evidence);
      if (probeResult.timedOut) {
        return {
          status: 'unsupported',
          reason:
            `compatibility probe timeout for ${request.key.cliName} `
            + contract.args.join(' '),
          evidence: Object.freeze([...evidence]),
        };
      }
      if (!probeResult.ok || probeResult.exitCode !== 0) {
        return {
          status: 'unsupported',
          reason:
            `compatibility probe exit failure for ${request.key.cliName} `
            + `${contract.args.join(' ')} (exit=${String(probeResult.exitCode)})`,
          evidence: Object.freeze([...evidence]),
        };
      }
      const output = `${probeResult.stdout}\n${probeResult.stderr}`
        .toLocaleLowerCase('en-US');
      const missing = contract.requiredTokens.filter(
        (token) => !output.includes(token.toLocaleLowerCase('en-US')),
      );
      if (missing.length > 0) {
        return {
          status: 'unsupported',
          reason:
            `compatibility probe missing required token(s) for `
            + `${request.key.cliName}: ${missing.join(', ')}`,
          evidence: Object.freeze([...evidence]),
        };
      }
    }

    const record = this.#registerDerivedRecord(request.key);
    const receipt: CompatibilityCacheReceipt = Object.freeze({
      cliName: request.key.cliName,
      version: request.key.version,
      platform: request.key.platform,
      executableIdentity,
      probeContractHash,
      verifiedAtMs: nowMs,
      expiresAtMs: nowMs + this.#ttlMs,
    });
    let warning: string | undefined;
    try {
      await this.#persistReceipt(request.key, receipt, nowMs);
    } catch (error) {
      warning = `compatibility cache write failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    return {
      status: 'verified',
      source: 'probe',
      record,
      evidence: Object.freeze([...evidence]),
      ...(warning === undefined ? {} : { warning }),
    };
  }

  #registerDerivedRecord(key: CompatibilityKey): CompatibilityRecord {
    const derived = deriveProbedCompatibilityRecord(key);
    assertCompatibilityRecordInvariants(derived);
    return registerRuntimeCompatibility(derived);
  }

  async #persistReceipt(
    key: CompatibilityKey,
    receipt: CompatibilityCacheReceipt,
    nowMs: number,
  ): Promise<void> {
    const previous = this.#writeQueue;
    let release: (() => void) | undefined;
    this.#writeQueue = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      const next = this.#entries
        .filter((entry) => !sameReceiptKey(entry, key) && entry.expiresAtMs >= nowMs);
      this.#entries = Object.freeze([...next, receipt]);
      saveCompatibilityCache(this.#cachePath, this.#entries);
    } finally {
      release?.();
    }
  }
}
