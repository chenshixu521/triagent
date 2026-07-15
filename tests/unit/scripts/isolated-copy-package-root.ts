/**
 * Build a fully isolated temporary package root for copy-native mutations.
 * Never points at the real project dist/.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function createIsolatedCopyPackageRoot(
  realPackageRoot: string,
  prefix = 'triagent-isolated-copy-',
): string {
  const isolated = mkdtempSync(join(tmpdir(), prefix));
  const publishExe = join(
    realPackageRoot,
    'native',
    'TriAgent.ProcessHost',
    'bin',
    'Release',
    'net10.0',
    'win-x64',
    'publish',
    'triagent-process-host.exe',
  );
  const trustPath = join(
    realPackageRoot,
    'src',
    'process',
    'generated-native-helper-trust.ts',
  );
  if (!existsSync(publishExe)) {
    throw new Error(`published helper missing at ${publishExe}`);
  }
  if (!existsSync(trustPath)) {
    throw new Error(`trust source missing at ${trustPath}`);
  }

  writeFileSync(
    join(isolated, 'package.json'),
    JSON.stringify({
      name: 'triagent-orchestrator',
      version: '0.0.0-test',
      private: true,
      type: 'module',
    }),
    'utf8',
  );

  const publishDir = join(
    isolated,
    'native',
    'TriAgent.ProcessHost',
    'bin',
    'Release',
    'net10.0',
    'win-x64',
    'publish',
  );
  mkdirSync(publishDir, { recursive: true });
  copyFileSync(publishExe, join(publishDir, 'triagent-process-host.exe'));

  mkdirSync(join(isolated, 'src', 'process'), { recursive: true });
  copyFileSync(
    trustPath,
    join(isolated, 'src', 'process', 'generated-native-helper-trust.ts'),
  );

  mkdirSync(join(isolated, 'dist', 'native', 'win-x64'), { recursive: true });

  // Do not copy dist/cli.js by default: isolated unit tests that only need
  // source trust + helper can run without a bundle. Tests that assert
  // source/bundle divergence copy cli.js explicitly.

  // Scripts are imported from the real tree via absolute path / packageRoot option;
  // no need to duplicate scripts into the isolated root for API callers.
  return resolve(isolated);
}
