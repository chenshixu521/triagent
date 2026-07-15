import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAppPaths, type AppPaths } from '../../../src/config/app-paths.js';
import { openDatabase } from '../../../src/persistence/database.js';
import { sha256 } from '../../../src/tracking/hash.js';
import { NonGitBaselineService } from '../../../src/tracking/non-git-baseline-service.js';
import type { BaselineTrackerPort, TrackingBaselineManifest, TrackingFileEntry } from '../../../src/tracking/tracking-port.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'triagent-implementation-workspace-'));
  roots.push(root);
  return root;
}

function seedWorkspaceForeignKeys(
  database: DatabaseSync,
  projectRoot: string,
  options: {
    readonly taskId?: string;
    readonly attemptId?: string;
    readonly baselineId?: string;
    readonly projectId?: string;
  } = {},
): void {
  const now = '2026-07-15T00:00:00.000Z';
  const projectId = options.projectId ?? 'project-1';
  const taskId = options.taskId ?? 'task-1';
  const attemptId = options.attemptId ?? 'attempt-1';
  const baselineId = options.baselineId ?? 'baseline-1';
  database.prepare(
    `INSERT INTO projects(id, root_path, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(projectId, projectRoot, now, now);
  database.prepare(
    `INSERT INTO tasks(
       id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
     ) VALUES (?, ?, 'implementing', 1, ?, ?, ?)`,
  ).run(taskId, projectId, JSON.stringify({ state: 'implementing' }), now, now);
  database.prepare(
    `INSERT INTO run_attempts(
       id, task_id, status, role, pid, process_started_at, started_at,
       ended_at, exit_reason, baseline_id, requirement_version, conversation_id
     ) VALUES (?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, ?, 1, NULL)`,
  ).run(attemptId, taskId, now, baselineId);
  database.prepare(
    `INSERT INTO file_baselines(
       id, task_id, attempt_id, status, manifest_json, error_text, created_at, completed_at
     ) VALUES (?, ?, ?, 'complete', ?, NULL, ?, ?)`,
  ).run(
    baselineId,
    taskId,
    attemptId,
    JSON.stringify({ schemaVersion: 1, files: [] }),
    now,
    now,
  );
}

function openApp(appRoot: string): {
  readonly paths: AppPaths;
  readonly database: DatabaseSync;
  readonly close: () => void;
} {
  const paths = resolveAppPaths({ appRootOverride: appRoot });
  const opened = openDatabase(paths.databasePath);
  if (opened.mode !== 'read-write') {
    throw new Error(`expected read-write database, got ${opened.mode}`);
  }
  return {
    paths,
    database: opened.connection,
    close: () => opened.close(),
  };
}

function asTracker(service: NonGitBaselineService): BaselineTrackerPort {
  return service as unknown as BaselineTrackerPort;
}

function createMaterializerFixture(options: {
  readonly maxContentBytes?: number;
} = {}): {
  readonly appRoot: string;
  readonly projectRoot: string;
  readonly snapshots: string;
  readonly paths: AppPaths;
  readonly database: DatabaseSync;
  readonly tracker: NonGitBaselineService;
  readonly close: () => void;
} {
  const appRoot = temporaryRoot();
  const projectRoot = join(appRoot, 'canonical-project');
  mkdirSync(projectRoot, { recursive: true });
  const { paths, database, close } = openApp(appRoot);
  seedWorkspaceForeignKeys(database, projectRoot);
  const tracker = new NonGitBaselineService({
    projectRoot,
    snapshotStore: paths.snapshotsDirectory,
    maxContentBytes: options.maxContentBytes,
  });
  return {
    appRoot,
    projectRoot,
    snapshots: paths.snapshotsDirectory,
    paths,
    database,
    tracker,
    close,
  };
}

class FakeTracker implements BaselineTrackerPort {
  public readonly projectRoot: string;
  public readonly snapshotStore: string;
  readonly #manifest: TrackingBaselineManifest;
  readonly #blobs: Map<string, Buffer>;

  public constructor(options: {
    readonly projectRoot: string;
    readonly snapshotStore: string;
    readonly manifest: TrackingBaselineManifest;
    readonly blobs?: ReadonlyMap<string, Buffer>;
  }) {
    this.projectRoot = options.projectRoot;
    this.snapshotStore = options.snapshotStore;
    this.#manifest = options.manifest;
    this.#blobs = new Map(options.blobs ?? []);
  }

  public captureTaskBaseline(): TrackingBaselineManifest {
    throw new Error('not used');
  }

  public captureAttemptBaseline(): TrackingBaselineManifest {
    throw new Error('not used');
  }

  public loadBaseline(baselineId: string) {
    if (baselineId !== this.#manifest.baselineId) {
      return { status: 'ignored' as const, diagnostic: 'missing baseline' };
    }
    return { status: 'loaded' as const, manifest: this.#manifest };
  }

  public scanCurrent() {
    return { files: this.#manifest.files, exclusions: [], blobs: this.#blobs };
  }

  public readBlob(hash: string): Buffer {
    const blob = this.#blobs.get(hash);
    if (blob === undefined) throw new Error(`missing blob ${hash}`);
    return blob;
  }
}

describe('ImplementationWorkspace persistence foundation', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves an app-owned implementation workspace directory and migrates its table', () => {
    const appRoot = temporaryRoot();
    const paths = resolveAppPaths({ appRootOverride: appRoot });

    expect(paths.implementationWorkspacesDirectory).toBe(
      join(appRoot, 'implementation-workspaces'),
    );
    expect(existsSync(paths.implementationWorkspacesDirectory)).toBe(true);

    const opened = openDatabase(paths.databasePath);
    expect(opened.mode).toBe('read-write');
    if (opened.mode !== 'read-write') return;
    try {
      const table = opened.connection
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name = 'implementation_workspaces'`,
        )
        .get() as { readonly name: string } | undefined;
      expect(table?.name).toBe('implementation_workspaces');
    } finally {
      opened.close();
    }
  });

  it('persists legal lifecycle transitions and atomically consumes exact authorization once', async () => {
    const appRoot = temporaryRoot();
    const paths = resolveAppPaths({ appRootOverride: appRoot });
    const opened = openDatabase(paths.databasePath);
    expect(opened.mode).toBe('read-write');
    if (opened.mode !== 'read-write') return;

    try {
      seedWorkspaceForeignKeys(opened.connection, join(appRoot, 'canonical-project'));
      const repositoryModule = await import(
        '../../../src/workspace/implementation-workspace-repository.js'
      ).catch(() => undefined);
      expect(repositoryModule).toBeDefined();
      if (repositoryModule === undefined) return;

      const repository = new repositoryModule.ImplementationWorkspaceRepository(
        opened.connection,
      );
      const sourceManifestHash = 'a'.repeat(64);
      const workspaceRoot = join(
        paths.implementationWorkspacesDirectory,
        'task-1',
        'attempt-1',
        'project',
      );
      repository.create({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        canonicalProjectRoot: join(appRoot, 'canonical-project'),
        workspaceRoot,
        sourceBaselineId: 'baseline-1',
        sourceManifestHash,
        authorizationId: 'workspace-auth-1',
        authorizationExpiresAt: '2026-07-15T00:05:00.000Z',
        nowIso: '2026-07-15T00:00:00.000Z',
      });

      expect(repository.get('workspace-1')).toMatchObject({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        status: 'preparing',
        sourceManifestHash,
        candidateManifestHash: null,
        changeSetHash: null,
      });

      repository.transition({
        workspaceId: 'workspace-1',
        expectedStatus: 'preparing',
        status: 'ready',
        nowIso: '2026-07-15T00:01:00.000Z',
      });
      expect(() => repository.transition({
        workspaceId: 'workspace-1',
        expectedStatus: 'ready',
        status: 'promoted',
        nowIso: '2026-07-15T00:01:30.000Z',
      })).toThrow(/illegal implementation workspace transition/i);

      const intent = {
        taskId: 'task-1',
        attemptId: 'attempt-1',
        workspaceRoot,
        sourceManifestHash,
      } as const;
      expect(repository.consumeAuthorization(
        'workspace-auth-1',
        intent,
        { nowMs: Date.parse('2026-07-15T00:02:00.000Z') },
      )).toMatchObject({ ok: true, record: { status: 'running' } });
      expect(repository.consumeAuthorization(
        'workspace-auth-1',
        intent,
        { nowMs: Date.parse('2026-07-15T00:02:01.000Z') },
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/consumed|reused/i) });
    } finally {
      opened.close();
    }
  });
});

describe('ImplementationWorkspace materialization', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('materializes dirty and untracked baseline entries with independent exact bytes', async () => {
    const fixture = createMaterializerFixture();
    try {
      writeFileSync(join(fixture.projectRoot, 'tracked.txt'), 'tracked-bytes\n');
      writeFileSync(join(fixture.projectRoot, 'dirty.txt'), 'dirty-bytes\n');
      mkdirSync(join(fixture.projectRoot, 'src'), { recursive: true });
      writeFileSync(join(fixture.projectRoot, 'src', 'untracked.ts'), 'export const u = 1;\n');

      const baseline = fixture.tracker.captureTaskBaseline({
        taskId: 'task-1',
        baselineId: 'baseline-1',
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
      });

      const serviceModule = await import(
        '../../../src/workspace/implementation-workspace-service.js'
      );
      const service = new serviceModule.ImplementationWorkspaceService({
        database: fixture.database,
        paths: fixture.paths,
        tracker: asTracker(fixture.tracker),
      });

      const result = service.materializeFromBaseline({
        workspaceId: 'workspace-mat-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sourceBaselineId: baseline.baselineId,
        sourceManifestHash: baseline.checksum,
        authorizationId: 'workspace-auth-mat-1',
        authorizationExpiresAt: '2026-07-15T01:00:00.000Z',
        nowIso: '2026-07-15T00:00:00.000Z',
        canonicalProjectRoot: fixture.projectRoot,
      });

      const expectedRoot = join(
        fixture.paths.implementationWorkspacesDirectory,
        'task-1',
        'attempt-1',
        'project',
      );
      expect(result.record).toMatchObject({
        status: 'ready',
        workspaceRoot: expectedRoot,
        sourceBaselineId: 'baseline-1',
        sourceManifestHash: baseline.checksum,
      });
      expect(result.record.candidateManifestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.record.workspaceRoot).toBe(resolve(expectedRoot));

      expect(readFileSync(join(expectedRoot, 'tracked.txt'), 'utf8')).toBe('tracked-bytes\n');
      expect(readFileSync(join(expectedRoot, 'dirty.txt'), 'utf8')).toBe('dirty-bytes\n');
      expect(readFileSync(join(expectedRoot, 'src', 'untracked.ts'), 'utf8')).toBe(
        'export const u = 1;\n',
      );

      const sourceStat = statSync(join(fixture.projectRoot, 'tracked.txt'));
      const destStat = statSync(join(expectedRoot, 'tracked.txt'));
      expect(destStat.nlink).toBe(1);
      if (typeof sourceStat.ino === 'number' && sourceStat.ino !== 0) {
        expect(destStat.ino).not.toBe(sourceStat.ino);
      }

      // Destination must remain an independent byte copy after canonical mutation.
      writeFileSync(join(fixture.projectRoot, 'tracked.txt'), 'canonical-changed\n');
      expect(readFileSync(join(expectedRoot, 'tracked.txt'), 'utf8')).toBe('tracked-bytes\n');

      // Hard-linked source siblings (when the FS allows) still materialize as nlink===1 copies.
      try {
        linkSync(
          join(fixture.projectRoot, 'dirty.txt'),
          join(fixture.projectRoot, 'dirty-hardlink.txt'),
        );
        const hardStat = statSync(join(expectedRoot, 'dirty.txt'));
        expect(hardStat.nlink).toBe(1);
      } catch {
        // Optional on filesystems without hard-link support.
      }
    } finally {
      fixture.close();
    }
  });

  it('excludes VCS/cache/TriAgent paths, preserves baseline-included generated files, and protects secrets', async () => {
    const fixture = createMaterializerFixture();
    try {
      writeFileSync(join(fixture.projectRoot, 'app.ts'), 'export {}\n');
      writeFileSync(join(fixture.projectRoot, 'generated.out'), 'generated-keep\n');
      writeFileSync(join(fixture.projectRoot, '.env'), 'SECRET=1\n');
      writeFileSync(join(fixture.projectRoot, 'id_rsa'), 'PRIVATE KEY\n');
      mkdirSync(join(fixture.projectRoot, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(fixture.projectRoot, 'node_modules', 'pkg', 'index.js'), 'nope\n');
      mkdirSync(join(fixture.projectRoot, '.git'), { recursive: true });
      writeFileSync(join(fixture.projectRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      mkdirSync(join(fixture.projectRoot, '.worktrees', 'x'), { recursive: true });
      writeFileSync(join(fixture.projectRoot, '.worktrees', 'x', 'f.txt'), 'nope\n');
      mkdirSync(join(fixture.projectRoot, '.triagent'), { recursive: true });
      writeFileSync(join(fixture.projectRoot, '.triagent', 'state.json'), '{}\n');
      mkdirSync(join(fixture.projectRoot, '.cache'), { recursive: true });
      writeFileSync(join(fixture.projectRoot, '.cache', 'c.bin'), 'cache\n');

      // Real non-git capture omits skip-policy paths; inject generated + secret via fake overlay.
      const real = fixture.tracker.captureTaskBaseline({
        taskId: 'task-1',
        baselineId: 'baseline-1',
      });
      const generated = Buffer.from('generated-keep\n');
      const secretEnv = Buffer.from('SECRET=1\n');
      const privateKey = Buffer.from('PRIVATE KEY\n');
      const appTs = Buffer.from('export {}\n');
      const files: TrackingFileEntry[] = [
        {
          path: 'app.ts',
          type: 'file',
          size: appTs.length,
          hash: sha256(appTs),
          blobHash: sha256(appTs),
          missing: false,
          executable: false,
          binary: false,
          contentCaptured: true,
        },
        {
          path: 'generated.out',
          type: 'file',
          size: generated.length,
          hash: sha256(generated),
          blobHash: sha256(generated),
          missing: false,
          executable: false,
          binary: false,
          contentCaptured: true,
        },
        {
          path: '.env',
          type: 'file',
          size: secretEnv.length,
          hash: sha256(secretEnv),
          blobHash: sha256(secretEnv),
          missing: false,
          executable: false,
          binary: false,
          contentCaptured: true,
        },
        {
          path: 'id_rsa',
          type: 'file',
          size: privateKey.length,
          hash: sha256(privateKey),
          blobHash: sha256(privateKey),
          missing: false,
          executable: false,
          binary: false,
          contentCaptured: true,
        },
        // Policy-skip paths that must never appear even if a corrupt baseline lists them.
        {
          path: 'node_modules/pkg/index.js',
          type: 'file',
          size: 5,
          hash: sha256('nope\n'),
          blobHash: sha256('nope\n'),
          missing: false,
          executable: false,
          binary: false,
          contentCaptured: true,
        },
        {
          path: '.triagent/state.json',
          type: 'file',
          size: 3,
          hash: sha256('{}\n'),
          blobHash: sha256('{}\n'),
          missing: false,
          executable: false,
          binary: false,
          contentCaptured: true,
        },
      ];
      const blobs = new Map<string, Buffer>([
        [sha256(appTs), appTs],
        [sha256(generated), generated],
        [sha256(secretEnv), secretEnv],
        [sha256(privateKey), privateKey],
        [sha256('nope\n'), Buffer.from('nope\n')],
        [sha256('{}\n'), Buffer.from('{}\n')],
      ]);
      const manifest: TrackingBaselineManifest = {
        version: 1,
        status: 'complete',
        kind: 'task',
        taskId: 'task-1',
        baselineId: 'baseline-1',
        createdAt: real.createdAt,
        files,
        exclusions: [],
        checksum: real.checksum, // overridden by service via explicit sourceManifestHash input
      };
      // Use the synthetic checksum the service will be given.
      const sourceManifestHash = sha256(JSON.stringify({
        files: files.map((f) => f.path).sort(),
        marker: 'synthetic-protected-set',
      }));
      const tracker = new FakeTracker({
        projectRoot: fixture.projectRoot,
        snapshotStore: fixture.snapshots,
        manifest: { ...manifest, checksum: sourceManifestHash },
        blobs,
      });

      const serviceModule = await import(
        '../../../src/workspace/implementation-workspace-service.js'
      );
      const service = new serviceModule.ImplementationWorkspaceService({
        database: fixture.database,
        paths: fixture.paths,
        tracker,
      });

      const result = service.materializeFromBaseline({
        workspaceId: 'workspace-mat-2',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sourceBaselineId: 'baseline-1',
        sourceManifestHash,
        authorizationId: 'workspace-auth-mat-2',
        authorizationExpiresAt: '2026-07-15T01:00:00.000Z',
        nowIso: '2026-07-15T00:00:00.000Z',
        canonicalProjectRoot: fixture.projectRoot,
      });

      const root = result.record.workspaceRoot;
      expect(existsSync(join(root, 'app.ts'))).toBe(true);
      expect(existsSync(join(root, 'generated.out'))).toBe(true);
      expect(readFileSync(join(root, 'generated.out'), 'utf8')).toBe('generated-keep\n');
      expect(existsSync(join(root, '.env'))).toBe(false);
      expect(existsSync(join(root, 'id_rsa'))).toBe(false);
      expect(existsSync(join(root, 'node_modules'))).toBe(false);
      expect(existsSync(join(root, '.git'))).toBe(false);
      expect(existsSync(join(root, '.worktrees'))).toBe(false);
      expect(existsSync(join(root, '.triagent'))).toBe(false);
      expect(existsSync(join(root, '.cache'))).toBe(false);
      expect(result.protectedPaths).toEqual(
        expect.arrayContaining(['.env', 'id_rsa', '.triagent/state.json']),
      );

      // Protected paths must not be recreatable as candidate mutations via service API.
      expect(() => service.assertCandidatePathWritable(result.record.workspaceId, '.env'))
        .toThrow(/protected/i);
      expect(() => service.assertCandidatePathWritable(result.record.workspaceId, 'id_rsa'))
        .toThrow(/protected/i);
    } finally {
      fixture.close();
    }
  });

  it('fails closed on nested repositories and reparse/symlink entries', async () => {
    const fixture = createMaterializerFixture();
    try {
      writeFileSync(join(fixture.projectRoot, 'ok.txt'), 'ok\n');
      mkdirSync(join(fixture.projectRoot, 'vendor', 'lib'), { recursive: true });
      writeFileSync(join(fixture.projectRoot, 'vendor', 'lib', 'mod.ts'), 'export {}\n');
      mkdirSync(join(fixture.projectRoot, 'vendor', 'lib', '.git'), { recursive: true });
      writeFileSync(join(fixture.projectRoot, 'vendor', 'lib', '.git', 'HEAD'), 'ref\n');

      const nestedBaseline = fixture.tracker.captureTaskBaseline({
        taskId: 'task-1',
        baselineId: 'baseline-1',
      });

      const serviceModule = await import(
        '../../../src/workspace/implementation-workspace-service.js'
      );
      const nestedService = new serviceModule.ImplementationWorkspaceService({
        database: fixture.database,
        paths: fixture.paths,
        tracker: asTracker(fixture.tracker),
      });

      expect(() => nestedService.materializeFromBaseline({
        workspaceId: 'workspace-nested',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sourceBaselineId: nestedBaseline.baselineId,
        sourceManifestHash: nestedBaseline.checksum,
        authorizationId: 'workspace-auth-nested',
        authorizationExpiresAt: '2026-07-15T01:00:00.000Z',
        nowIso: '2026-07-15T00:00:00.000Z',
        canonicalProjectRoot: fixture.projectRoot,
      })).toThrow(/nested_repository_unsupported/i);

      // Nested failure must not leave a ready workspace or incomplete project root.
      const nestedRoot = join(
        fixture.paths.implementationWorkspacesDirectory,
        'task-1',
        'attempt-1',
        'project',
      );
      expect(existsSync(nestedRoot)).toBe(false);

      // Fresh attempt for symlink case.
      fixture.database.prepare(
        `INSERT INTO run_attempts(
           id, task_id, status, role, pid, process_started_at, started_at,
           ended_at, exit_reason, baseline_id, requirement_version, conversation_id
         ) VALUES (?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, ?, 1, NULL)`,
      ).run('attempt-2', 'task-1', '2026-07-15T00:00:00.000Z', 'baseline-2');
      fixture.database.prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, error_text, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, NULL, ?, ?)`,
      ).run(
        'baseline-2',
        'task-1',
        'attempt-2',
        JSON.stringify({ schemaVersion: 1, files: [] }),
        '2026-07-15T00:00:00.000Z',
        '2026-07-15T00:00:00.000Z',
      );

      const cleanProject = join(fixture.appRoot, 'symlink-project');
      mkdirSync(cleanProject, { recursive: true });
      writeFileSync(join(cleanProject, 'target.txt'), 'target\n');
      let createdLink = false;
      try {
        symlinkSync(
          process.platform === 'win32' ? join(cleanProject, 'target.txt') : 'target.txt',
          join(cleanProject, 'link.txt'),
        );
        createdLink = true;
      } catch {
        // Privilege may be missing; synthesize a symlink baseline entry instead.
      }

      const content = Buffer.from('target\n');
      const files: TrackingFileEntry[] = [
        {
          path: 'target.txt',
          type: 'file',
          size: content.length,
          hash: sha256(content),
          blobHash: sha256(content),
          missing: false,
          executable: false,
          binary: false,
          contentCaptured: true,
        },
        {
          path: 'link.txt',
          type: 'symlink',
          size: 0,
          hash: null,
          blobHash: null,
          missing: false,
          executable: false,
          binary: false,
          contentCaptured: false,
          contentExclusionReason: 'symlink-not-followed',
          linkTarget: createdLink ? 'target.txt' : 'target.txt',
        },
      ];
      const sourceManifestHash = sha256('symlink-case');
      const tracker = new FakeTracker({
        projectRoot: cleanProject,
        snapshotStore: fixture.snapshots,
        manifest: {
          version: 1,
          status: 'complete',
          kind: 'task',
          taskId: 'task-1',
          baselineId: 'baseline-2',
          createdAt: '2026-07-15T00:00:00.000Z',
          files,
          exclusions: [],
          checksum: sourceManifestHash,
        },
        blobs: new Map([[sha256(content), content]]),
      });
      const symlinkService = new serviceModule.ImplementationWorkspaceService({
        database: fixture.database,
        paths: fixture.paths,
        tracker,
      });
      expect(() => symlinkService.materializeFromBaseline({
        workspaceId: 'workspace-symlink',
        taskId: 'task-1',
        attemptId: 'attempt-2',
        sourceBaselineId: 'baseline-2',
        sourceManifestHash,
        authorizationId: 'workspace-auth-symlink',
        authorizationExpiresAt: '2026-07-15T01:00:00.000Z',
        nowIso: '2026-07-15T00:00:00.000Z',
        canonicalProjectRoot: cleanProject,
      })).toThrow(/unsupported[_-]entry|reparse|symlink/i);
    } finally {
      fixture.close();
    }
  });

  it('copies content-excluded files only after current hash matches and never marks incomplete roots ready', async () => {
    const fixture = createMaterializerFixture();
    try {
      const large = Buffer.alloc(64, 0x61);
      writeFileSync(join(fixture.projectRoot, 'big.bin'), large);
      writeFileSync(join(fixture.projectRoot, 'small.txt'), 'ok\n');
      const largeHash = sha256(large);
      const small = Buffer.from('ok\n');
      const smallHash = sha256(small);
      const sourceManifestHash = sha256('content-excluded-case');
      const excludedTracker = new FakeTracker({
        projectRoot: fixture.projectRoot,
        snapshotStore: fixture.snapshots,
        manifest: {
          version: 1,
          status: 'complete',
          kind: 'task',
          taskId: 'task-1',
          baselineId: 'baseline-1',
          createdAt: '2026-07-15T00:00:00.000Z',
          files: [
            {
              path: 'big.bin',
              type: 'file',
              size: large.length,
              hash: largeHash,
              blobHash: null,
              missing: false,
              executable: false,
              binary: true,
              contentCaptured: false,
              contentExclusionReason: 'too-large',
            },
            {
              path: 'small.txt',
              type: 'file',
              size: small.length,
              hash: smallHash,
              blobHash: smallHash,
              missing: false,
              executable: false,
              binary: false,
              contentCaptured: true,
            },
          ],
          exclusions: [],
          checksum: sourceManifestHash,
        },
        blobs: new Map([[smallHash, small]]),
      });

      const serviceModule = await import(
        '../../../src/workspace/implementation-workspace-service.js'
      );
      const service = new serviceModule.ImplementationWorkspaceService({
        database: fixture.database,
        paths: fixture.paths,
        tracker: excludedTracker,
      });

      const ready = service.materializeFromBaseline({
        workspaceId: 'workspace-large',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sourceBaselineId: 'baseline-1',
        sourceManifestHash,
        authorizationId: 'workspace-auth-large',
        authorizationExpiresAt: '2026-07-15T01:00:00.000Z',
        nowIso: '2026-07-15T00:00:00.000Z',
        canonicalProjectRoot: fixture.projectRoot,
      });
      expect(ready.record.status).toBe('ready');
      expect(readFileSync(join(ready.record.workspaceRoot, 'big.bin'))).toEqual(large);
      expect(lstatSync(join(ready.record.workspaceRoot, 'big.bin')).nlink).toBe(1);

      // Drifted content-excluded source must fail closed for a new attempt.
      writeFileSync(join(fixture.projectRoot, 'big.bin'), Buffer.alloc(64, 0x62));
      fixture.database.prepare(
        `INSERT INTO run_attempts(
           id, task_id, status, role, pid, process_started_at, started_at,
           ended_at, exit_reason, baseline_id, requirement_version, conversation_id
         ) VALUES (?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, ?, 1, NULL)`,
      ).run('attempt-drift', 'task-1', '2026-07-15T00:00:00.000Z', 'baseline-1');
      expect(() => service.materializeFromBaseline({
        workspaceId: 'workspace-large-drift',
        taskId: 'task-1',
        attemptId: 'attempt-drift',
        sourceBaselineId: 'baseline-1',
        sourceManifestHash,
        authorizationId: 'workspace-auth-large-drift',
        authorizationExpiresAt: '2026-07-15T01:00:00.000Z',
        nowIso: '2026-07-15T00:10:00.000Z',
        canonicalProjectRoot: fixture.projectRoot,
      })).toThrow(/content[_-]hash|baseline|mismatch|changed/i);
      expect(existsSync(join(
        fixture.paths.implementationWorkspacesDirectory,
        'task-1',
        'attempt-drift',
        'project',
      ))).toBe(false);

      // Missing blob must not produce ready.
      const missingHash = 'f'.repeat(64);
      const brokenFiles: TrackingFileEntry[] = [
        {
          path: 'ghost.txt',
          type: 'file',
          size: 4,
          hash: missingHash,
          blobHash: missingHash,
          missing: false,
          executable: false,
          binary: false,
          contentCaptured: true,
        },
      ];
      const brokenHash = sha256('broken');
      fixture.database.prepare(
        `INSERT INTO run_attempts(
           id, task_id, status, role, pid, process_started_at, started_at,
           ended_at, exit_reason, baseline_id, requirement_version, conversation_id
         ) VALUES (?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, ?, 1, NULL)`,
      ).run('attempt-broken', 'task-1', '2026-07-15T00:00:00.000Z', 'baseline-broken');
      fixture.database.prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, error_text, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, NULL, ?, ?)`,
      ).run(
        'baseline-broken',
        'task-1',
        'attempt-broken',
        JSON.stringify({ schemaVersion: 1, files: [] }),
        '2026-07-15T00:00:00.000Z',
        '2026-07-15T00:00:00.000Z',
      );
      const brokenTracker = new FakeTracker({
        projectRoot: fixture.projectRoot,
        snapshotStore: fixture.snapshots,
        manifest: {
          version: 1,
          status: 'complete',
          kind: 'task',
          taskId: 'task-1',
          baselineId: 'baseline-broken',
          createdAt: '2026-07-15T00:00:00.000Z',
          files: brokenFiles,
          exclusions: [],
          checksum: brokenHash,
        },
        blobs: new Map(),
      });
      const brokenService = new serviceModule.ImplementationWorkspaceService({
        database: fixture.database,
        paths: fixture.paths,
        tracker: brokenTracker,
      });
      expect(() => brokenService.materializeFromBaseline({
        workspaceId: 'workspace-broken',
        taskId: 'task-1',
        attemptId: 'attempt-broken',
        sourceBaselineId: 'baseline-broken',
        sourceManifestHash: brokenHash,
        authorizationId: 'workspace-auth-broken',
        authorizationExpiresAt: '2026-07-15T01:00:00.000Z',
        nowIso: '2026-07-15T00:20:00.000Z',
        canonicalProjectRoot: fixture.projectRoot,
      })).toThrow(/blob|missing|corrupt/i);

      const brokenRoot = join(
        fixture.paths.implementationWorkspacesDirectory,
        'task-1',
        'attempt-broken',
        'project',
      );
      expect(existsSync(brokenRoot)).toBe(false);
      const repositoryModule = await import(
        '../../../src/workspace/implementation-workspace-repository.js'
      );
      const repository = new repositoryModule.ImplementationWorkspaceRepository(fixture.database);
      const brokenRecord = repository.get('workspace-broken');
      expect(brokenRecord === undefined || brokenRecord.status !== 'ready').toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('uses deterministic workspace roots and candidate manifest hashes', async () => {
    const fixture = createMaterializerFixture();
    try {
      writeFileSync(join(fixture.projectRoot, 'a.txt'), 'A\n');
      writeFileSync(join(fixture.projectRoot, 'b.txt'), 'B\n');
      const baseline = fixture.tracker.captureTaskBaseline({
        taskId: 'task-1',
        baselineId: 'baseline-1',
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
      });

      const serviceModule = await import(
        '../../../src/workspace/implementation-workspace-service.js'
      );
      const service = new serviceModule.ImplementationWorkspaceService({
        database: fixture.database,
        paths: fixture.paths,
        tracker: asTracker(fixture.tracker),
      });

      const first = service.materializeFromBaseline({
        workspaceId: 'workspace-det-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sourceBaselineId: baseline.baselineId,
        sourceManifestHash: baseline.checksum,
        authorizationId: 'workspace-auth-det-1',
        authorizationExpiresAt: '2026-07-15T01:00:00.000Z',
        nowIso: '2026-07-15T00:00:00.000Z',
        canonicalProjectRoot: fixture.projectRoot,
      });

      expect(first.record.workspaceRoot).toBe(resolve(join(
        fixture.paths.implementationWorkspacesDirectory,
        'task-1',
        'attempt-1',
        'project',
      )));

      // Recompute the candidate hash from the on-disk tree via a second materialization
      // on a sibling attempt with identical source content.
      fixture.database.prepare(
        `INSERT INTO run_attempts(
           id, task_id, status, role, pid, process_started_at, started_at,
           ended_at, exit_reason, baseline_id, requirement_version, conversation_id
         ) VALUES (?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, ?, 1, NULL)`,
      ).run('attempt-2', 'task-1', '2026-07-15T00:00:00.000Z', 'baseline-1');

      const second = service.materializeFromBaseline({
        workspaceId: 'workspace-det-2',
        taskId: 'task-1',
        attemptId: 'attempt-2',
        sourceBaselineId: baseline.baselineId,
        sourceManifestHash: baseline.checksum,
        authorizationId: 'workspace-auth-det-2',
        authorizationExpiresAt: '2026-07-15T01:00:00.000Z',
        nowIso: '2026-07-15T00:01:00.000Z',
        canonicalProjectRoot: fixture.projectRoot,
      });

      expect(second.record.candidateManifestHash).toBe(first.record.candidateManifestHash);
      expect(second.record.workspaceRoot).toBe(resolve(join(
        fixture.paths.implementationWorkspacesDirectory,
        'task-1',
        'attempt-2',
        'project',
      )));
    } finally {
      fixture.close();
    }
  });
});
