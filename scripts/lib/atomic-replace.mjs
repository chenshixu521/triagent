/**
 * Windows-safe atomic file replace with backup rollback.
 *
 * Primary algorithm: rename destination -> backup, rename staging -> destination,
 * verify destination, remove backup. Never delete-then-recreate destination names.
 *
 * If post-promotion validation fails: quarantine/remove only the failed new
 * destination, then restore last-known-good backup. Never delete backup merely
 * because destination also exists.
 */
import {
  existsSync,
  lstatSync,
  renameSync,
  rmSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientFsError(error) {
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
export function withTransientRenameRetry(operation, label, options = {}) {
  const maxAttempts = options.maxAttempts ?? 6;
  /** @type {unknown} */
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isTransientFsError(error) || attempt === maxAttempts) break;
      const waitMs = 25 * attempt * attempt;
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        // short spin for delete-pending / AV
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

function pathKey(input) {
  return process.platform === 'win32'
    ? input.replaceAll('/', '\\').toLocaleLowerCase('en-US')
    : input;
}

/**
 * @param {string} path
 * @param {string} label
 */
export function assertRegularNonReparseFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} missing: ${path}`);
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new Error(
      `${label} unreadable: ${path} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} is a reparse/symlink; refusing: ${path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`${label} is not a regular file: ${path}`);
  }
  // Fail closed on every realpathSync.native error — never swallow platform errors.
  let real;
  try {
    real = realpathSync.native(path);
  } catch (error) {
    throw new Error(
      `${label} realpath failed (fail-closed): ${path} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (pathKey(normalize(real)) !== pathKey(normalize(path))) {
    if (pathKey(resolve(real)) !== pathKey(resolve(path))) {
      throw new Error(
        `${label} realpath diverges (possible reparse): ${path} -> ${real}`,
      );
    }
  }
}

/**
 * @param {string} path
 * @param {string} label
 * @param {string} token
 */
function removeOwnedPathStrict(path, label, token) {
  if (!existsSync(path)) return;
  if (!path.includes(token)) {
    throw new Error(`${label}: refusing to remove non-owned path ${path}`);
  }
  withTransientRenameRetry(() => {
    rmSync(path, { force: true });
    if (existsSync(path)) {
      const err = new Error(`path still exists after rmSync: ${path}`);
      /** @type {{ code?: string }} */ (err).code = 'EBUSY';
      throw err;
    }
  }, `remove ${label}`, { maxAttempts: 8 });
}

/**
 * @param {object} options
 * @param {string} options.stagingPath
 * @param {string} options.destinationPath
 * @param {string} options.label
 * @param {string} [options.token] process-owned token embedded in bak/tmp names
 * @param {() => void} [options.validateDestination] post-promotion validation
 * @param {Set<string>} [options.ownedPaths] optional tracker for cleanup
 * @returns {{ backupPath: string | null, restored: boolean }}
 */
export function atomicReplaceFile(options) {
  const stagingResolved = resolve(options.stagingPath);
  const destinationResolved = resolve(options.destinationPath);
  const label = options.label;
  const token =
    options.token
    ?? `${process.pid}.${randomBytes(8).toString('hex')}`;
  const ownedPaths = options.ownedPaths;

  const stagingDir = dirname(stagingResolved);
  const destDir = dirname(destinationResolved);
  if (pathKey(stagingDir) !== pathKey(destDir)) {
    throw new Error(
      `${label}: staging and destination must be in the same directory`,
    );
  }

  assertRegularNonReparseFile(stagingResolved, `${label} staging`);

  const safeLabel = label.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  const backupPath = join(destDir, `.${safeLabel}.${token}.bak`);
  const quarantinePath = join(destDir, `.${safeLabel}.${token}.bad`);

  ownedPaths?.add(stagingResolved);
  ownedPaths?.add(backupPath);
  ownedPaths?.add(quarantinePath);

  if (existsSync(backupPath)) {
    removeOwnedPathStrict(backupPath, `${label} stale backup`, token);
  }
  if (existsSync(quarantinePath)) {
    removeOwnedPathStrict(quarantinePath, `${label} stale quarantine`, token);
  }

  let destinationMovedToBackup = false;
  let promoted = false;

  try {
    if (existsSync(destinationResolved)) {
      assertRegularNonReparseFile(
        destinationResolved,
        `${label} existing destination`,
      );
      withTransientRenameRetry(() => {
        renameSync(destinationResolved, backupPath);
      }, `${label} rename destination to backup`);
      destinationMovedToBackup = true;
    }

    withTransientRenameRetry(() => {
      renameSync(stagingResolved, destinationResolved);
    }, `${label} rename staging to destination`);
    promoted = true;
    ownedPaths?.delete(stagingResolved);

    assertRegularNonReparseFile(
      destinationResolved,
      `${label} final destination`,
    );

    if (typeof options.validateDestination === 'function') {
      options.validateDestination();
    }

    if (destinationMovedToBackup) {
      try {
        removeOwnedPathStrict(backupPath, `${label} backup`, token);
        ownedPaths?.delete(backupPath);
      } catch (cleanupError) {
        if (!isTransientFsError(cleanupError)) throw cleanupError;
        // Leave tracked for caller finalize; success still holds.
      }
    } else {
      ownedPaths?.delete(backupPath);
    }

    return { backupPath: destinationMovedToBackup ? backupPath : null, restored: false };
  } catch (error) {
    // Post-promotion validation / assert failure: restore last-known-good.
    if (promoted && destinationMovedToBackup && existsSync(backupPath)) {
      // Quarantine/remove only the failed NEW destination — never delete backup
      // merely because destination also exists.
      if (existsSync(destinationResolved)) {
        try {
          withTransientRenameRetry(() => {
            if (existsSync(quarantinePath)) {
              rmSync(quarantinePath, { force: true });
            }
            renameSync(destinationResolved, quarantinePath);
          }, `${label} quarantine failed destination`);
        } catch {
          // If quarantine rename fails, try direct remove of failed new file only.
          try {
            withTransientRenameRetry(() => {
              rmSync(destinationResolved, { force: true });
            }, `${label} remove failed destination`);
          } catch {
            // continue to restore attempt
          }
        }
      }

      if (!existsSync(destinationResolved)) {
        try {
          withTransientRenameRetry(() => {
            renameSync(backupPath, destinationResolved);
          }, `${label} restore backup`);
          ownedPaths?.delete(backupPath);
          // Best-effort quarantine cleanup after successful restore.
          if (existsSync(quarantinePath)) {
            try {
              removeOwnedPathStrict(quarantinePath, `${label} quarantine`, token);
              ownedPaths?.delete(quarantinePath);
            } catch {
              // keep quarantine for forensics
            }
          }
          throw new Error(
            `${label} post-promotion validation failed; restored last-known-good from backup. `
            + `cause: ${error instanceof Error ? error.message : String(error)}`,
          );
        } catch (restoreError) {
          if (
            restoreError instanceof Error
            && restoreError.message.includes('restored last-known-good')
          ) {
            throw restoreError;
          }
          throw new Error(
            `${label} post-promotion validation failed AND backup restore failed. `
            + `backup preserved at: ${backupPath}. `
            + `cause: ${error instanceof Error ? error.message : String(error)}; `
            + `restore: ${
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError)
            }`,
          );
        }
      }

      // Destination still exists (could not quarantine) and backup remains —
      // NEVER delete backup. Fail with recovery path.
      throw new Error(
        `${label} post-promotion validation failed; backup preserved at: ${backupPath}. `
        + `failed destination still at: ${destinationResolved}. `
        + `cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Promotion never happened: restore if we only moved to backup.
    if (
      !promoted
      && destinationMovedToBackup
      && !existsSync(destinationResolved)
      && existsSync(backupPath)
    ) {
      try {
        withTransientRenameRetry(() => {
          renameSync(backupPath, destinationResolved);
        }, `${label} restore backup after failed promote`);
        ownedPaths?.delete(backupPath);
      } catch (restoreError) {
        throw new Error(
          `${label} atomic replace failed and restore failed; backup at ${backupPath}. `
          + `cause: ${error instanceof Error ? error.message : String(error)}; `
          + `restore: ${
            restoreError instanceof Error
              ? restoreError.message
              : String(restoreError)
          }`,
        );
      }
    }

    throw error instanceof Error
      ? error
      : new Error(`${label} atomic replace failed: ${String(error)}`);
  }
}

/**
 * @param {string} destinationPath
 * @param {string | Buffer} contents
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.token
 * @param {Set<string>} [options.ownedPaths]
 * @param {() => void} [options.validateDestination]
 * @param {BufferEncoding} [options.encoding]
 */
export function writeFileAtomically(destinationPath, contents, options) {
  const destDir = dirname(destinationPath);
  mkdirSync(destDir, { recursive: true });
  const safeLabel = options.label.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  const stagingPath = join(destDir, `.${safeLabel}.${options.token}.tmp`);
  options.ownedPaths?.add(resolve(stagingPath));
  if (existsSync(stagingPath)) {
    removeOwnedPathStrict(stagingPath, `${options.label} stale staging`, options.token);
  }
  if (typeof contents === 'string') {
    writeFileSync(stagingPath, contents, options.encoding ?? 'utf8');
  } else {
    writeFileSync(stagingPath, contents);
  }
  try {
    return atomicReplaceFile({
      stagingPath,
      destinationPath,
      label: options.label,
      token: options.token,
      ownedPaths: options.ownedPaths,
      validateDestination: options.validateDestination,
    });
  } finally {
    if (existsSync(stagingPath)) {
      try {
        removeOwnedPathStrict(
          stagingPath,
          `${options.label} leftover staging`,
          options.token,
        );
      } catch {
        // tracked for outer finalize
      }
    }
  }
}
