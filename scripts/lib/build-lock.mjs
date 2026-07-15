/**
 * Atomic interprocess lock for native build/copy transactions.
 *
 * Publication: prepare a fully-initialized unique directory (owner.json written
 * first), then rename it to the canonical `.triagent-build.lock` path. Contenders
 * never observe an ownerless canonical directory.
 *
 * Stale recovery is identity-bound: before renaming canonical away, re-read and
 * compare immutable owner fields (token, pid, acquiredAt, nonce). After rename,
 * re-verify the quarantined identity before deletion. A newly published successor
 * is never deleted by a stale recovery contender.
 *
 * Reentrant: nested sequential build children may re-enter with the owner token
 * while the owner pid is still alive. Nested release is a no-op; outer owner
 * releases and hard-fails if the canonical lock is already missing.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  statSync,
  openSync,
  closeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const LOCK_DIR_NAME = '.triagent-build.lock';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 50;

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isTransientFsError(error) {
  if (error === null || typeof error !== 'object') return false;
  const code = /** @type {{ code?: string }} */ (error).code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

/**
 * @template T
 * @param {() => T} operation
 * @param {string} label
 * @param {{ maxAttempts?: number }} [options]
 * @returns {T}
 */
export function withTransientFsRetry(operation, label, options = {}) {
  const maxAttempts = options.maxAttempts ?? 8;
  /** @type {unknown} */
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isTransientFsError(error) || attempt === maxAttempts) break;
      const waitMs = 20 * attempt * attempt;
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        // short spin
      }
    }
  }
  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);
  const wrapped = new Error(`${label}: ${detail}`);
  if (lastError instanceof Error && 'code' in lastError) {
    /** @type {{ code?: string }} */ (wrapped).code =
      /** @type {{ code?: string }} */ (lastError).code;
  }
  throw wrapped;
}

/**
 * @typedef {{ pid: number, token: string, acquiredAt: number, nonce: string }} LockOwner
 */

/**
 * @param {string} lockDir
 * @returns {LockOwner | null}
 */
export function readOwner(lockDir) {
  const ownerPath = join(lockDir, 'owner.json');
  if (!existsSync(ownerPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (
      typeof raw.pid !== 'number'
      || typeof raw.token !== 'string'
      || typeof raw.acquiredAt !== 'number'
      || typeof raw.nonce !== 'string'
    ) {
      return null;
    }
    return {
      pid: raw.pid,
      token: raw.token,
      acquiredAt: raw.acquiredAt,
      nonce: raw.nonce,
    };
  } catch {
    return null;
  }
}

/**
 * @param {LockOwner | null} a
 * @param {LockOwner | null} b
 */
export function ownersEqual(a, b) {
  if (a === null || b === null) return false;
  return (
    a.pid === b.pid
    && a.token === b.token
    && a.acquiredAt === b.acquiredAt
    && a.nonce === b.nonce
  );
}

/**
 * Stable identity for missing/corrupt owner recovery (mtime + ino when available).
 * @param {string} lockDir
 * @returns {{ mtimeMs: number, ino: string, size: number } | null}
 */
export function readDirIdentity(lockDir) {
  try {
    const st = statSync(lockDir);
    const mtimeMs =
      typeof st.mtimeMs === 'number' ? st.mtimeMs : st.mtime.getTime();
    const ino =
      typeof st.ino === 'bigint'
        ? st.ino.toString()
        : String(st.ino ?? 0);
    return {
      mtimeMs,
      ino,
      size: typeof st.size === 'number' ? st.size : 0,
    };
  } catch {
    return null;
  }
}

/**
 * @param {{ mtimeMs: number, ino: string, size: number } | null} a
 * @param {{ mtimeMs: number, ino: string, size: number } | null} b
 */
function dirIdentitiesEqual(a, b) {
  if (a === null || b === null) return false;
  return a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.size === b.size;
}

/**
 * Directory age for missing/corrupt owner: use mtime, never treat as immediately stale.
 * @param {string} lockDir
 * @param {() => number} now
 */
function directoryAgeMs(lockDir, now) {
  const id = readDirIdentity(lockDir);
  if (id === null) return 0;
  return Math.max(0, now() - id.mtimeMs);
}

/**
 * Identity-bound quarantine of a stale lock.
 * Never deletes a successor: re-reads owner (or dir identity) immediately before
 * rename and again after rename before deletion.
 *
 * @param {string} lockRoot
 * @param {string} lockDir
 * @param {{
 *   expectedOwner?: LockOwner | null,
 *   expectedDirIdentity?: { mtimeMs: number, ino: string, size: number } | null,
 *   reason: string,
 * }} claim
 * @returns {'removed' | 'skipped' | 'gone'}
 */
export function quarantineAndRemoveLockIdentityBound(lockRoot, lockDir, claim) {
  if (!existsSync(lockDir)) return 'gone';

  const quarantine = join(
    lockRoot,
    `.triagent-build.lock.stale.${process.pid}.${randomBytes(8).toString('hex')}`,
  );

  try {
    withTransientFsRetry(() => {
      if (!existsSync(lockDir)) {
        const err = new Error('canonical lock already gone');
        /** @type {{ code?: string }} */ (err).code = 'ENOENT';
        throw err;
      }

      if (claim.expectedOwner !== undefined && claim.expectedOwner !== null) {
        const current = readOwner(lockDir);
        if (!ownersEqual(current, claim.expectedOwner)) {
          throw new Error(
            `stale recovery aborted: owner identity changed before quarantine (${claim.reason})`,
          );
        }
      } else if (claim.expectedDirIdentity !== undefined) {
        // Missing/corrupt owner path: bind to directory identity.
        const currentOwner = readOwner(lockDir);
        if (currentOwner !== null) {
          // A live owner appeared — never delete.
          throw new Error(
            `stale recovery aborted: owner appeared before quarantine (${claim.reason})`,
          );
        }
        const currentId = readDirIdentity(lockDir);
        if (!dirIdentitiesEqual(currentId, claim.expectedDirIdentity ?? null)) {
          throw new Error(
            `stale recovery aborted: directory identity changed before quarantine (${claim.reason})`,
          );
        }
      } else {
        throw new Error('stale recovery requires expectedOwner or expectedDirIdentity');
      }

      renameSync(lockDir, quarantine);
    }, `identity-bound quarantine (${claim.reason})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /identity changed|owner appeared|already gone/i.test(message)
      || /** @type {{ code?: string }} */ (error).code === 'ENOENT'
    ) {
      return 'skipped';
    }
    return 'skipped';
  }

  // Post-rename: verify quarantined identity still matches before deletion.
  try {
    if (claim.expectedOwner !== undefined && claim.expectedOwner !== null) {
      const quarantined = readOwner(quarantine);
      if (!ownersEqual(quarantined, claim.expectedOwner)) {
        // Fail closed: leave quarantine for forensics; do not delete unknown content.
        // Attempt restore only if canonical is free and identity is still ours.
        if (!existsSync(lockDir) && ownersEqual(readOwner(quarantine), claim.expectedOwner)) {
          try {
            renameSync(quarantine, lockDir);
          } catch {
            // leave quarantine
          }
        }
        return 'skipped';
      }
    } else {
      // Missing-owner claim: ensure quarantine still has no valid owner
      // (a successor would have been a different directory).
      if (readOwner(quarantine) !== null) {
        return 'skipped';
      }
    }
  } catch {
    return 'skipped';
  }

  try {
    withTransientFsRetry(() => {
      rmSync(quarantine, { recursive: true, force: true });
    }, `remove quarantined lock (${claim.reason})`);
  } catch {
    // Non-canonical leftover is acceptable.
  }
  return 'removed';
}

/**
 * @param {string} lockRoot
 * @param {string} lockDir
 * @param {LockOwner} owner
 */
function publishInitializedLock(lockRoot, lockDir, owner) {
  const prepDir = join(
    lockRoot,
    `.triagent-build.lock.prep.${owner.pid}.${owner.nonce}`,
  );
  if (existsSync(prepDir)) {
    rmSync(prepDir, { recursive: true, force: true });
  }
  mkdirSync(prepDir, { recursive: false });
  try {
    const ownerPath = join(prepDir, 'owner.json');
    writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    const written = readOwner(prepDir);
    if (
      written === null
      || written.token !== owner.token
      || written.pid !== owner.pid
      || written.nonce !== owner.nonce
      || written.acquiredAt !== owner.acquiredAt
    ) {
      throw new Error('failed to materialize immutable owner.json before lock publish');
    }
    try {
      const fd = openSync(join(prepDir, 'held'), 'w');
      closeSync(fd);
    } catch {
      // optional
    }
    withTransientFsRetry(() => {
      renameSync(prepDir, lockDir);
    }, 'publish initialized lock directory');
  } catch (error) {
    try {
      if (existsSync(prepDir)) {
        rmSync(prepDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
    throw error;
  }
}

/**
 * @param {object} options
 * @param {string} options.lockRoot
 * @param {number} [options.ttlMs]
 * @param {number} [options.waitMs]
 * @param {string} [options.reentrantToken]
 * @param {() => number} [options.now]
 * @param {(pid: number) => boolean} [options.pidAlive]
 */
export function acquireBuildLock(options) {
  const lockRoot = resolve(options.lockRoot);
  mkdirSync(lockRoot, { recursive: true });
  const lockDir = join(lockRoot, LOCK_DIR_NAME);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const waitMs =
    options.waitMs
    ?? (process.env.TRIAGENT_BUILD_LOCK_WAIT_MS !== undefined
      && Number.isFinite(Number(process.env.TRIAGENT_BUILD_LOCK_WAIT_MS))
      ? Number(process.env.TRIAGENT_BUILD_LOCK_WAIT_MS)
      : DEFAULT_WAIT_MS);
  const now = options.now ?? (() => Date.now());
  const pidAlive = options.pidAlive ?? isPidAlive;
  const deadline = now() + waitMs;

  if (typeof options.reentrantToken === 'string' && options.reentrantToken.length > 0) {
    if (existsSync(lockDir)) {
      const owner = readOwner(lockDir);
      if (
        owner
        && owner.token === options.reentrantToken
        && pidAlive(owner.pid)
      ) {
        return {
          lockDir,
          token: owner.token,
          reentrant: true,
          release() {
            // Nested release is a no-op; outer owner releases.
          },
        };
      }
    }
  }

  const token = `${process.pid}.${now()}.${randomBytes(8).toString('hex')}`;
  const nonce = randomBytes(16).toString('hex');
  const ownerRecord = {
    pid: process.pid,
    token,
    acquiredAt: now(),
    nonce,
  };

  while (true) {
    if (!existsSync(lockDir)) {
      try {
        publishInitializedLock(lockRoot, lockDir, ownerRecord);
        return {
          lockDir,
          token,
          reentrant: false,
          release() {
            releaseBuildLock(lockDir, token);
          },
        };
      } catch (error) {
        const code = /** @type {{ code?: string }} */ (error).code;
        if (code !== 'EEXIST' && code !== 'EPERM' && !isTransientFsError(error)) {
          if (!existsSync(lockDir)) {
            throw error instanceof Error
              ? error
              : new Error(`lock acquire failed: ${String(error)}`);
          }
        }
      }
    }

    if (!existsSync(lockDir)) {
      if (now() >= deadline) {
        throw new Error(`timed out waiting for build lock at ${lockDir}`);
      }
      const end = now() + POLL_MS;
      while (now() < end) {
        // wait
      }
      continue;
    }

    const owner = readOwner(lockDir);

    if (
      owner
      && typeof options.reentrantToken === 'string'
      && owner.token === options.reentrantToken
      && pidAlive(owner.pid)
    ) {
      return {
        lockDir,
        token: owner.token,
        reentrant: true,
        release() {},
      };
    }

    if (owner) {
      const age = now() - owner.acquiredAt;
      const dead = !pidAlive(owner.pid);
      const expired = age > ttlMs;
      if (dead && expired) {
        // Snapshot identity, then identity-bound quarantine.
        const observed = { ...owner };
        quarantineAndRemoveLockIdentityBound(lockRoot, lockDir, {
          expectedOwner: observed,
          reason: `dead-owner pid=${owner.pid} ageMs=${String(age)}`,
        });
        continue;
      }
    } else {
      const age = directoryAgeMs(lockDir, now);
      if (age > ttlMs) {
        const dirId = readDirIdentity(lockDir);
        quarantineAndRemoveLockIdentityBound(lockRoot, lockDir, {
          expectedOwner: null,
          expectedDirIdentity: dirId,
          reason: `corrupt-or-missing-owner ageMs=${String(age)}`,
        });
        continue;
      }
    }

    if (now() >= deadline) {
      throw new Error(
        `timed out waiting for build lock at ${lockDir}`
        + (owner
          ? ` (owner pid=${owner.pid}, ageMs=${String(now() - owner.acquiredAt)})`
          : ` (owner missing/corrupt, dirAgeMs=${String(directoryAgeMs(lockDir, now))})`),
      );
    }
    const end = now() + POLL_MS;
    while (now() < end) {
      // short wait
    }
  }
}

/**
 * Outer-owner release. Hard-fails if the canonical lock is missing (lost ownership).
 * Reentrant holders must use the no-op release on the reentrant handle — never call this.
 *
 * @param {string} lockDir
 * @param {string} token
 */
export function releaseBuildLock(lockDir, token) {
  if (!existsSync(lockDir)) {
    throw new Error(
      `refusing to release build lock: canonical lock missing at ${lockDir} `
      + `(outer owner must hard-fail; reentrant release is no-op only via reentrant handle)`,
    );
  }
  const owner = readOwner(lockDir);
  if (owner === null) {
    throw new Error(
      `refusing to release build lock with missing/corrupt owner at ${lockDir}`,
    );
  }
  if (owner.token !== token) {
    throw new Error(
      `refusing to release build lock not owned by this token at ${lockDir}`,
    );
  }
  if (owner.pid !== process.pid) {
    throw new Error(
      `refusing to release build lock owned by pid ${owner.pid} from pid ${process.pid}`,
    );
  }

  const lockRoot = dirname(lockDir);
  const expected = { ...owner };
  const quarantine = join(
    lockRoot,
    `.triagent-build.lock.release.${owner.pid}.${owner.nonce}.${randomBytes(4).toString('hex')}`,
  );

  try {
    withTransientFsRetry(() => {
      if (!existsSync(lockDir)) {
        throw new Error(
          `refusing to release build lock: canonical lock missing at ${lockDir}`,
        );
      }
      const current = readOwner(lockDir);
      if (!ownersEqual(current, expected) || current === null || current.token !== token) {
        throw new Error(
          `lock ownership changed before release rename at ${lockDir}`,
        );
      }
      renameSync(lockDir, quarantine);
    }, 'release quarantine rename');
  } catch (error) {
    const current = existsSync(lockDir) ? readOwner(lockDir) : null;
    if (current !== null && current.token !== token) {
      throw new Error(
        `refusing to release build lock not owned by this token at ${lockDir}`,
      );
    }
    if (!existsSync(lockDir) && !existsSync(quarantine)) {
      throw new Error(
        `refusing to release build lock: canonical lock missing at ${lockDir}`,
      );
    }
    throw error instanceof Error
      ? error
      : new Error(`release quarantine failed: ${String(error)}`);
  }

  // Verify quarantine still holds our identity before delete.
  const quarantined = readOwner(quarantine);
  if (!ownersEqual(quarantined, expected)) {
    throw new Error(
      `release quarantine identity mismatch at ${quarantine}; refusing to delete`,
    );
  }

  try {
    withTransientFsRetry(() => {
      rmSync(quarantine, { recursive: true, force: true });
    }, 'release delete quarantine');
  } catch {
    // non-canonical leftover ok
  }
}
