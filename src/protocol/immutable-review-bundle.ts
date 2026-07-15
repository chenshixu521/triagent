/**
 * Narrow immutable review-bundle interface for Task 16 Grok adapter.
 * Task 17 builds full bundles; adapters only accept a validated external
 * reference + manifest and must never reparse the path back into the live project.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/** Discriminated bundle kind — Task 17 may extend fields; adapters stay narrow. */
export const IMMUTABLE_REVIEW_BUNDLE_KIND = 'immutable_review_bundle' as const;

/**
 * Minimal input adapters accept. Task 17 constructs full evidence bundles;
 * this is only the reference/manifest contract needed to route --cwd safely.
 */
export interface ImmutableReviewBundleRef {
  readonly kind: typeof IMMUTABLE_REVIEW_BUNDLE_KIND;
  /** Absolute directory outside the live project (canonical review workspace). */
  readonly bundleRoot: string;
  /** Absolute path to the bundle manifest; must resolve under bundleRoot. */
  readonly manifestPath: string;
  /** Content hash of the canonical bundle payload (sha256 hex). */
  readonly contentHash: string;
}

export type ImmutableReviewBundleValidationResult =
  | {
      readonly ok: true;
      /** Realpath-normalized absolute root used as --cwd. */
      readonly canonicalRoot: string;
      /** Always false: adapters must not treat this as live project access. */
      readonly liveProjectAccess: false;
      readonly contentHash: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

function normalizeAbsolute(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rootNorm = normalizeAbsolute(root).toLowerCase();
  const candNorm = normalizeAbsolute(candidate).toLowerCase();
  if (candNorm === rootNorm) return true;
  const prefix = rootNorm.endsWith(sep) ? rootNorm : rootNorm + sep;
  return candNorm.startsWith(prefix);
}

/**
 * Validate a narrow immutable review-bundle reference.
 * Fail closed when the path is missing, non-absolute, under the live project,
 * a symlink escape, or when the manifest cannot be bound under the root.
 */
export function validateImmutableReviewBundleRef(
  ref: ImmutableReviewBundleRef | undefined,
  options: {
    readonly liveProjectRoot: string;
  },
): ImmutableReviewBundleValidationResult {
  if (ref === undefined) {
    return {
      ok: false,
      reason:
        'AdapterDisabled: immutable review bundle reference is required '
        + '(live project access is not proven for this Grok profile)',
    };
  }
  if (ref.kind !== IMMUTABLE_REVIEW_BUNDLE_KIND) {
    return {
      ok: false,
      reason: `AdapterDisabled: unknown review bundle kind ${String(ref.kind)}`,
    };
  }

  const liveRoot = options.liveProjectRoot.trim();
  if (liveRoot.length === 0) {
    return {
      ok: false,
      reason: 'AdapterDisabled: live projectRoot is required for bundle isolation',
    };
  }

  const bundleRootRaw = ref.bundleRoot?.trim() ?? '';
  const manifestRaw = ref.manifestPath?.trim() ?? '';
  const contentHash = ref.contentHash?.trim() ?? '';

  if (bundleRootRaw.length === 0 || !isAbsolute(bundleRootRaw)) {
    return {
      ok: false,
      reason: 'AdapterDisabled: immutable review bundleRoot must be absolute',
    };
  }
  if (manifestRaw.length === 0 || !isAbsolute(manifestRaw)) {
    return {
      ok: false,
      reason: 'AdapterDisabled: immutable review manifestPath must be absolute',
    };
  }
  if (!/^[a-f0-9]{64}$/i.test(contentHash)) {
    return {
      ok: false,
      reason: 'AdapterDisabled: immutable review contentHash must be sha256 hex',
    };
  }

  // Refuse any bundle that sits inside the live project (including via reparse).
  if (isPathInside(liveRoot, bundleRootRaw)) {
    return {
      ok: false,
      reason:
        'AdapterDisabled: immutable review bundle must be outside the live project; '
        + 'refusing liveProjectAccess',
    };
  }

  let bundleStat;
  try {
    bundleStat = lstatSync(bundleRootRaw);
  } catch {
    return {
      ok: false,
      reason: 'AdapterDisabled: immutable review bundleRoot does not exist',
    };
  }
  if (bundleStat.isSymbolicLink()) {
    return {
      ok: false,
      reason:
        'AdapterDisabled: immutable review bundleRoot must not be a symlink '
        + '(no reparse back to live project)',
    };
  }
  if (!bundleStat.isDirectory()) {
    return {
      ok: false,
      reason: 'AdapterDisabled: immutable review bundleRoot must be a directory',
    };
  }

  const canonicalRoot = normalizeAbsolute(bundleRootRaw);
  if (isPathInside(liveRoot, canonicalRoot)) {
    return {
      ok: false,
      reason:
        'AdapterDisabled: immutable review bundle realpath resolves inside live project',
    };
  }

  let manifestStat;
  try {
    manifestStat = lstatSync(manifestRaw);
  } catch {
    return {
      ok: false,
      reason: 'AdapterDisabled: immutable review manifestPath does not exist',
    };
  }
  if (manifestStat.isSymbolicLink()) {
    return {
      ok: false,
      reason:
        'AdapterDisabled: immutable review manifestPath must not be a symlink',
    };
  }
  if (!manifestStat.isFile()) {
    return {
      ok: false,
      reason: 'AdapterDisabled: immutable review manifestPath must be a file',
    };
  }

  const canonicalManifest = normalizeAbsolute(manifestRaw);
  if (!isPathInside(canonicalRoot, canonicalManifest)) {
    return {
      ok: false,
      reason:
        'AdapterDisabled: immutable review manifest must resolve under bundleRoot',
    };
  }
  if (isPathInside(liveRoot, canonicalManifest)) {
    return {
      ok: false,
      reason:
        'AdapterDisabled: immutable review manifest realpath resolves inside live project',
    };
  }

  // Bind contentHash to manifest body when possible (narrow integrity check).
  try {
    const body = readFileSync(canonicalManifest);
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest.toLowerCase() !== contentHash.toLowerCase()) {
      return {
        ok: false,
        reason:
          'AdapterDisabled: immutable review contentHash does not match manifest body',
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason:
        'AdapterDisabled: cannot read immutable review manifest: '
        + (error instanceof Error ? error.message : String(error)),
    };
  }

  // Final existence check via stat (not just lstat) for the directory.
  if (!existsSync(canonicalRoot) || !statSync(canonicalRoot).isDirectory()) {
    return {
      ok: false,
      reason: 'AdapterDisabled: immutable review bundleRoot is not a directory',
    };
  }

  return Object.freeze({
    ok: true as const,
    canonicalRoot,
    liveProjectAccess: false as const,
    contentHash: contentHash.toLowerCase(),
  });
}

/** Helper for tests / Task 17 scaffolding: hash arbitrary manifest content. */
export function hashImmutableReviewManifestContent(
  content: string | Buffer,
): string {
  return createHash('sha256').update(content).digest('hex');
}
