import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PromptArtifactStore,
  PromptArtifactStoreError,
  createVerifiedPromptArtifactStore,
} from '../../../src/agents/grok/prompt-artifact-store.js';

const temporaryDirs: string[] = [];

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const directory = temporaryDirs.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

describe('PromptArtifactStore (secure Grok prompt files)', () => {
  it('creates exclusive file under trusted base outside project with content integrity', () => {
    const projectRoot = tempDir('triagent-pas-project-');
    const base = tempDir('triagent-pas-base-');
    const store = createVerifiedPromptArtifactStore({
      baseDirectory: base,
      projectRoot,
    });
    expect(store).toBeInstanceOf(PromptArtifactStore);

    const artifact = store.createPromptFile({
      prompt: 'secret prompt body for exclusive create',
      projectRoot,
    });
    expect(existsSync(artifact.path)).toBe(true);
    expect(readFileSync(artifact.path, 'utf8')).toBe(
      'secret prompt body for exclusive create',
    );
    expect(artifact.path.toLowerCase().startsWith(resolve(base).toLowerCase())).toBe(
      true,
    );
    expect(artifact.path.toLowerCase()).not.toContain(
      resolve(projectRoot).toLowerCase(),
    );
    expect(artifact.byteLength).toBe(
      Buffer.byteLength('secret prompt body for exclusive create', 'utf8'),
    );
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lstatSync(artifact.path).isFile()).toBe(true);
    expect(lstatSync(artifact.path).nlink).toBe(1);

    const cleanup = artifact.cleanup();
    expect(cleanup.ok).toBe(true);
    expect(existsSync(artifact.path)).toBe(false);
  });

  it('rejects base directory inside projectRoot', () => {
    const projectRoot = tempDir('triagent-pas-proj-in-');
    const baseInside = join(projectRoot, 'nested-base');
    mkdirSync(baseInside, { recursive: true });
    expect(() =>
      createVerifiedPromptArtifactStore({
        baseDirectory: baseInside,
        projectRoot,
      }),
    ).toThrow(/outside project|AdapterDisabled|PromptArtifact/i);
  });

  it('rejects reparse/junction base that escapes trusted path', (context) => {
    const projectRoot = tempDir('triagent-pas-proj-j-');
    const realOutside = tempDir('triagent-pas-out-j-');
    const staging = tempDir('triagent-pas-stage-j-');
    const junction = join(staging, 'escaped-base');
    try {
      symlinkSync(
        realOutside,
        junction,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      context.skip(
        `symlink/junction not available: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    // Even if junction target is outside project, reparse on the base path
    // must fail closed (no insecure realpath-only acceptance of reparse bases).
    expect(() =>
      createVerifiedPromptArtifactStore({
        baseDirectory: junction,
        projectRoot,
      }),
    ).toThrow(/reparse|junction|symlink|PromptArtifact|AdapterDisabled/i);
  });

  it('rejects hardlinked prompt file identity (nlink > 1)', (context) => {
    const projectRoot = tempDir('triagent-pas-proj-hl-');
    const base = tempDir('triagent-pas-base-hl-');
    const store = createVerifiedPromptArtifactStore({
      baseDirectory: base,
      projectRoot,
    });
    const artifact = store.createPromptFile({
      prompt: 'hardlink race target',
      projectRoot,
    });
    const alias = join(base, `alias-${Date.now()}.txt`);
    try {
      linkSync(artifact.path, alias);
    } catch (error) {
      artifact.cleanup();
      context.skip(
        `hardlink not available: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    // After hardlink, nlink should be 2 — store must reject on re-verify path
    // or refuse reuse. create must have already checked nlink===1 at open time;
    // assert post-create identity helper fails closed when nlink elevated.
    expect(lstatSync(artifact.path).nlink).toBeGreaterThan(1);
    expect(() => store.assertArtifactIdentity(artifact.path)).toThrow(
      /hardlink|nlink|identity|PromptArtifact/i,
    );
    try {
      rmSync(alias, { force: true });
    } catch {
      // ignore
    }
    artifact.cleanup();
  });

  it('cleanup is bounded and verified (file gone or fail-closed)', () => {
    const projectRoot = tempDir('triagent-pas-proj-cl-');
    const base = tempDir('triagent-pas-base-cl-');
    const store = createVerifiedPromptArtifactStore({
      baseDirectory: base,
      projectRoot,
    });
    const artifact = store.createPromptFile({
      prompt: 'cleanup me',
      projectRoot,
    });
    const first = artifact.cleanup();
    expect(first.ok).toBe(true);
    expect(existsSync(artifact.path)).toBe(false);
    // Second cleanup is idempotent success (ENOENT).
    const second = artifact.cleanup();
    expect(second.ok).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'hardens Windows ACL to current user + SYSTEM + Administrators only and fails closed on broad ACLs',
    () => {
      const projectRoot = tempDir('triagent-pas-proj-acl-');
      const base = tempDir('triagent-pas-base-acl-');
      const store = createVerifiedPromptArtifactStore({
        baseDirectory: base,
        projectRoot,
      });
      const artifact = store.createPromptFile({
        prompt: 'acl protected prompt',
        projectRoot,
      });

      // SID-based assert already ran at create; re-assert identity.
      expect(() => store.assertWindowsAclHardened(artifact.path)).not.toThrow();

      const icacls = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'icacls.exe',
      );
      // Fail closed if we inject a broad ACE (Everyone SID S-1-1-0) and re-verify.
      execFileSync(
        icacls,
        [artifact.path, '/grant', '*S-1-1-0:(R)'],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(() => store.assertWindowsAclHardened(artifact.path)).toThrow(
        /ACL|broad|S-1-1-0|Everyone|PromptArtifact/i,
      );

      artifact.cleanup();
    },
    30_000,
  );

  it('adapter-facing factory refuses insecure fallback when base is missing', () => {
    const projectRoot = tempDir('triagent-pas-proj-miss-');
    const missing = join(tempDir('triagent-pas-parent-'), 'does-not-exist-yet');
    // Nonexistent child under verified parent: must create only via store
    // after parent verification — not via realpath fallback on missing path.
    expect(() =>
      createVerifiedPromptArtifactStore({
        baseDirectory: missing,
        projectRoot,
        // do not auto-create missing leaf unless explicitly allowed after parent verify
        createBaseIfMissing: false,
      }),
    ).toThrow(/exist|PromptArtifact|AdapterDisabled|base/i);
  });

  it('createBaseIfMissing verifies parents then creates leaf without reparse race', () => {
    const projectRoot = tempDir('triagent-pas-proj-mk-');
    const parent = tempDir('triagent-pas-parent-mk-');
    const leaf = join(parent, `prompt-base-${Date.now()}`);
    const store = createVerifiedPromptArtifactStore({
      baseDirectory: leaf,
      projectRoot,
      createBaseIfMissing: true,
    });
    expect(existsSync(leaf)).toBe(true);
    const artifact = store.createPromptFile({
      prompt: 'after secure base create',
      projectRoot,
    });
    expect(readdirSync(leaf).length).toBeGreaterThan(0);
    artifact.cleanup();
  });
});

describe('PromptArtifactStoreError', () => {
  it('is a fail-closed typed error', () => {
    const error = new PromptArtifactStoreError('test reason');
    expect(error.name).toBe('PromptArtifactStoreError');
    expect(error.code).toBe('PromptArtifactStoreError');
    expect(error.message).toMatch(/test reason/);
  });
});
