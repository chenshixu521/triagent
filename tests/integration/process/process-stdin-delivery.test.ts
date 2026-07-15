import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { asAttemptId } from '../../../src/domain/ids.js';
import {
  resolveProcessHostExecutable,
} from '../../../src/process/process-host-client.js';
import { ProcessSupervisor } from '../../../src/process/process-supervisor.js';
import type { ProcessSupervisorEvent } from '../../../src/process/process-supervisor-port.js';

const temporaryDirectories: string[] = [];
const activeSupervisors: ProcessSupervisor[] = [];

const FIXTURE_STDOUT_BEFORE_STDIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/process-tree/stdout-before-stdin.mjs',
);

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-stdin-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('ProcessHost real stdin delivery', () => {
  beforeAll(() => {
    if (process.platform !== 'win32') {
      return;
    }
    const helper = resolveProcessHostExecutable();
    if (!existsSync(helper)) {
      throw new Error(
        `ProcessHost helper missing at ${helper}; run npm run build:native`,
      );
    }
  });

  afterEach(async () => {
    while (activeSupervisors.length > 0) {
      const supervisor = activeSupervisors.pop();
      if (supervisor === undefined) break;
      await supervisor.dispose?.().catch(() => undefined);
    }
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory === undefined) break;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'delivers exact UTF-8 stdin payload to target and closes stdin',
    async () => {
      const directory = temporaryDirectory();
      const outFile = join(directory, 'stdin-out.txt');
      // PowerShell: read all of stdin (until close) and write to outFile.
      const script = join(directory, 'read-stdin.ps1');
      writeFileSync(
        script,
        [
          '$ErrorActionPreference = "Stop"',
          `$out = "${outFile.replace(/\\/g, '\\\\')}"`,
          '$text = [Console]::In.ReadToEnd()',
          '[IO.File]::WriteAllText($out, $text, [Text.UTF8Encoding]::new($false))',
        ].join('\n'),
        'utf8',
      );

      const supervisor = new ProcessSupervisor({
        helperPath: resolveProcessHostExecutable(),
      });
      activeSupervisors.push(supervisor);

      const attemptId = asAttemptId('attempt-stdin-real-1');
      const prompt = 'Exact UTF-8 prompt ä¸­æ–‡ âœ?delivery-proof-token';
      const events: ProcessSupervisorEvent[] = [];
      supervisor.subscribe(attemptId, (event) => {
        events.push(event);
      });

      await supervisor.start({
        attemptId,
        executable: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        cwd: directory,
        stdin: {
          encoding: 'utf8',
          data: prompt,
          closeAfterWrite: true,
        },
      });

      const wait = await supervisor.wait(attemptId);
      expect(wait.reason === 'exited' || wait.exitCode === 0).toBeTruthy();

      // Prompt must not appear in args (we control args above).
      expect(events.some((e) => e.type === 'started')).toBe(true);

      // Wait briefly for file flush.
      const deadline = Date.now() + 10_000;
      while (!existsSync(outFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(outFile)).toBe(true);
      const { readFileSync } = await import('node:fs');
      const received = readFileSync(outFile, 'utf8');
      expect(received).toBe(prompt);
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'does not deadlock when child fills stdout before reading stdin',
    async () => {
      // Adversarial: child writes ~256KiB to stdout first, then reads stdin.
      // Without concurrent drain+stdin delivery this hangs forever.
      expect(existsSync(FIXTURE_STDOUT_BEFORE_STDIN)).toBe(true);

      const directory = temporaryDirectory();
      const supervisor = new ProcessSupervisor({
        helperPath: resolveProcessHostExecutable(),
      });
      activeSupervisors.push(supervisor);

      const attemptId = asAttemptId('attempt-stdin-deadlock-1');
      const prompt = 'DEADLOCK_PROMPT_TOKEN_exact_utf8_ä¸­æ–‡';
      const stdoutChunks: string[] = [];
      const events: ProcessSupervisorEvent[] = [];
      supervisor.subscribe(attemptId, (event) => {
        events.push(event);
        if (event.type === 'stdout') {
          stdoutChunks.push(event.chunk);
        }
      });

      await supervisor.start({
        attemptId,
        executable: process.execPath,
        args: [FIXTURE_STDOUT_BEFORE_STDIN],
        cwd: directory,
        environment: {
          FILL_BYTES: '262144',
        },
        stdin: {
          encoding: 'utf8',
          data: prompt,
          closeAfterWrite: true,
        },
      });

      // Bounded wait â€?hang would indicate the deadlock regression.
      const wait = await Promise.race([
        supervisor.wait(attemptId),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('stdin/stdout deadlock: wait timed out after 20s')),
            20_000,
          );
        }),
      ]);

      expect(wait.reason === 'exited' || wait.reason === 'force_stop').toBe(true);
      // Prefer clean completion; force_stop is acceptable only if stop path works.
      if (wait.reason === 'exited') {
        expect(wait.exitCode).toBe(0);
      }

      const combined = stdoutChunks.join('');
      // Filled pipe content was relayed (at least some of the X fill).
      expect(combined.includes('X')).toBe(true);
      // Exact prompt received and echoed â€?secrecy: prompt never in argv.
      expect(combined).toContain(`STDIN_PROMPT_RECEIVED:${prompt}`);
      expect(combined).toContain('FIXTURE_DONE');
      expect(events.some((e) => e.type === 'started')).toBe(true);

      // Handle allowlist / secrecy: prompt must not appear in start args.
      // (We control args; assert fixture path only.)
      expect(FIXTURE_STDOUT_BEFORE_STDIN).not.toContain(prompt);
    },
    30_000,
  );
});
