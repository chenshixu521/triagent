import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PathPolicy,
  type PathEvaluation,
} from '../../../src/guard/path-policy.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix = 'triagent-path-policy-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function projectFixture(): { root: string; policy: PathPolicy } {
  const root = temporaryDirectory();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export {}\n', 'utf8');
  writeFileSync(join(root, 'readme.txt'), 'hello\n', 'utf8');
  return { root: resolve(root), policy: new PathPolicy({ projectRoot: root }) };
}

function expectDenied(result: PathEvaluation, reasonPattern: RegExp): void {
  expect(result.allowed).toBe(false);
  if (result.allowed) throw new Error('expected denial');
  expect(result.reason).toMatch(reasonPattern);
  expect(result.failClosed).toBe(true);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('PathPolicy project containment', () => {
  it('allows a relative project-local file path and returns a safe relative path', () => {
    const { policy } = projectFixture();
    const result = policy.evaluatePath('src/main.ts');
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('expected allow');
    expect(result.relativePath.replaceAll('\\', '/')).toBe('src/main.ts');
    expect(result.insideProject).toBe(true);
    expect(result.traversedReparsePoint).toBe(false);
  });

  it('denies absolute paths outside the project', () => {
    const { policy } = projectFixture();
    const outside = join(tmpdir(), 'triagent-outside-absolute.txt');
    writeFileSync(outside, 'x', 'utf8');
    temporaryDirectories.push(outside);
    expectDenied(policy.evaluatePath(outside), /outside|escape|not inside/i);
  });

  it('denies parent-directory traversal with .. segments', () => {
    const { policy, root } = projectFixture();
    const outsideRelative = join('src', '..', '..', 'escape.txt');
    const outsideTarget = resolve(root, outsideRelative);
    expect(outsideTarget.startsWith(root)).toBe(false);
    expectDenied(policy.evaluatePath(outsideRelative), /outside|escape|traversal|\.\./i);
  });

  it.runIf(process.platform === 'win32')(
    'denies alternate drive letters even when the path looks relative',
    () => {
      const { policy, root } = projectFixture();
      const drive = root.slice(0, 1).toUpperCase() === 'C' ? 'D' : 'C';
      expectDenied(
        policy.evaluatePath(`${drive}:\\Windows\\System32\\drivers\\etc\\hosts`),
        /outside|drive|escape|not inside/i,
      );
    },
  );

  it.runIf(process.platform === 'win32')('denies UNC paths', () => {
    const { policy } = projectFixture();
    expectDenied(
      policy.evaluatePath('\\\\server\\share\\repo\\file.txt'),
      /outside|unc|escape|unsupported|not inside/i,
    );
  });

  it.runIf(process.platform === 'win32')(
    'denies device namespace and ADS-style paths',
    () => {
      const { policy } = projectFixture();
      expectDenied(
        policy.evaluatePath('\\\\.\\C:\\device-path'),
        /device|namespace|unsupported|outside|escape/i,
      );
      expectDenied(
        policy.evaluatePath('\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1'),
        /device|namespace|unsupported|outside|escape/i,
      );
      expectDenied(
        policy.evaluatePath('src\\main.ts:Zone.Identifier'),
        /ads|alternate|stream|device|unsupported|unsafe/i,
      );
    },
  );

  it.runIf(process.platform === 'win32')(
    'treats case-only path differences as the same project-local path',
    () => {
      const { policy, root } = projectFixture();
      const mixed = root
        .split(sep)
        .map((part, index) => (index % 2 === 0 ? part.toUpperCase() : part.toLowerCase()))
        .join(sep);
      const candidate = join(mixed, 'SRC', 'MAIN.TS');
      const result = policy.evaluatePath(candidate);
      expect(result.allowed).toBe(true);
      if (!result.allowed) throw new Error('expected allow');
      expect(result.relativePath.replaceAll('\\', '/').toLowerCase()).toBe('src/main.ts');
    },
  );

  it('denies symlink/junction/reparse targets that resolve outside the project', () => {
    const { root, policy } = projectFixture();
    const outsideDir = temporaryDirectory('triagent-outside-target-');
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret\n', 'utf8');
    const linkPath = join(root, 'escape-link');
    try {
      symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Some environments require elevation for symlink creation; force a logical outside path.
      expectDenied(
        policy.evaluatePath(join('..', 'not-in-project', 'secret.txt')),
        /outside|escape|reparse|symlink|junction/i,
      );
      return;
    }
    expectDenied(
      policy.evaluatePath(join('escape-link', 'secret.txt')),
      /outside|escape|reparse|symlink|junction/i,
    );
  });

  it('records internal reparse points that stay inside the project without auto-allowing unknown provenance', () => {
    const { root, policy } = projectFixture();
    const realDir = join(root, 'real-nested');
    const linkDir = join(root, 'internal-link');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'file.ts'), 'export const n = 1;\n', 'utf8');
    let created = false;
    try {
      symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
      created = true;
    } catch {
      created = false;
    }
    if (!created) {
      const evaluation = policy.evaluatePath('src/main.ts');
      expect(evaluation.allowed).toBe(true);
      return;
    }
    const result = policy.evaluatePath(join('internal-link', 'file.ts'));
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('expected allow');
    expect(result.traversedReparsePoint).toBe(true);
    expect(result.insideProject).toBe(true);
    expect(result.relativePath.replaceAll('\\', '/')).toMatch(/file\.ts$/);
  });

  it('denies a request whose cwd is inside the project but an argument path targets outside', () => {
    const { policy, root } = projectFixture();
    const outside = join(root, '..', 'outside-arg.txt');
    writeFileSync(outside, 'payload\n', 'utf8');
    temporaryDirectories.push(outside);
    const evaluation = policy.evaluateCommandPaths({
      cwd: root,
      pathArguments: [outside],
    });
    expect(evaluation.cwd.allowed).toBe(true);
    expect(evaluation.arguments.some((entry) => !entry.allowed)).toBe(true);
    expect(evaluation.allInsideProject).toBe(false);
    expect(evaluation.failClosed).toBe(true);
  });

  it('fails closed for final-target and hard-link risk markers when provenance is unprovable', () => {
    const { policy, root } = projectFixture();
    writeFileSync(join(root, 'src', 'shared.txt'), 'shared\n', 'utf8');
    const result = policy.evaluatePath('src/shared.txt', {
      hardLinkRisk: true,
      finalTargetUnprovable: true,
    });
    expectDenied(result, /hard.?link|final.?target|unprovable|provenance|fail.?closed/i);
  });

  it('never auto-classifies unknown path provenance as project-local', () => {
    const { policy } = projectFixture();
    const result = policy.evaluatePath('src/main.ts', { provenanceUnknown: true });
    expectDenied(result, /unknown|provenance|unprovable|fail.?closed/i);
  });

  it('rejects empty and whitespace-only path candidates', () => {
    const { policy } = projectFixture();
    expectDenied(policy.evaluatePath(''), /empty|invalid/i);
    expectDenied(policy.evaluatePath('   '), /empty|invalid/i);
  });

  it('exposes comparison evidence without claiming an OS sandbox', () => {
    const { policy } = projectFixture();
    const result = policy.evaluatePath('readme.txt');
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('expected allow');
    expect(JSON.stringify(result)).not.toMatch(/os sandbox|operating system sandbox/i);
    expect(result.evidence.projectRoot.length).toBeGreaterThan(0);
    expect(existsSync(result.evidence.projectRoot)).toBe(true);
  });

  it('fails closed when an inside path is a hard link to an outside file without caller flags', () => {
    const { root, policy } = projectFixture();
    const outsideDir = temporaryDirectory('triagent-hardlink-outside-');
    const outsideFile = join(outsideDir, 'secret-outside.txt');
    writeFileSync(outsideFile, 'outside-secret\n', 'utf8');
    const insideLink = join(root, 'src', 'linked-secret.txt');
    try {
      linkSync(outsideFile, insideLink);
    } catch {
      // Environments that cannot create hard links still must not auto-allow risk markers.
      expectDenied(
        policy.evaluatePath('src/linked-secret.txt', { hardLinkRisk: true }),
        /hard.?link|final.?target|unprovable|fail.?closed/i,
      );
      return;
    }
    const result = policy.evaluatePath('src/linked-secret.txt');
    expectDenied(result, /hard.?link|multi.?link|nlink|provenance|fail.?closed/i);
    // Outside content must remain unchanged by policy evaluation alone.
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside-secret\n');
  });

  it('fails closed for multi-link provenance on an existing final target', () => {
    const { root, policy } = projectFixture();
    const primary = join(root, 'src', 'primary.txt');
    const alias = join(root, 'src', 'alias.txt');
    writeFileSync(primary, 'shared\n', 'utf8');
    try {
      linkSync(primary, alias);
    } catch {
      expectDenied(
        policy.evaluatePath('src/primary.txt', { hardLinkRisk: true }),
        /hard.?link|final.?target|unprovable|fail.?closed/i,
      );
      return;
    }
    expectDenied(
      policy.evaluatePath('src/primary.txt'),
      /hard.?link|multi.?link|nlink|provenance|fail.?closed/i,
    );
    expectDenied(
      policy.evaluatePath('src/alias.txt'),
      /hard.?link|multi.?link|nlink|provenance|fail.?closed/i,
    );
  });

  it.runIf(process.platform === 'win32')(
    'rejects Windows DOS device names per path component including variants',
    () => {
      const { policy } = projectFixture();
      const devices = [
        'NUL',
        'nul',
        'CON',
        'PRN',
        'AUX',
        'CLOCK$',
        'COM1',
        'COM9',
        'LPT1',
        'LPT9',
        'nul.txt',
        'CON.log',
        'com1.',
        'lpt1 ',
        'AuX.dat',
        join('src', 'NUL'),
        join('src', 'con.txt'),
        join('src', 'COM3.bak'),
      ];
      for (const candidate of devices) {
        expectDenied(
          policy.evaluatePath(candidate),
          /dos.?device|device|reserved|unsupported|namespace/i,
        );
      }
    },
  );
});
