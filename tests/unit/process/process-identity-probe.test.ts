import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  buildIdentityProbeScript,
  interpretIdentityProbe,
  type IdentityProbeRaw,
} from '../../../src/process/process-identity-probe.js';

/** Run a PowerShell -Command body and capture the same raw shape as production. */
function runPowerShellCommand(command: string): Promise<IdentityProbeRaw> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true },
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      resolve({
        kind: 'spawn_error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.on('error', (error) => {
      resolve({ kind: 'spawn_error', error });
    });
    child.on('close', (code) => {
      resolve({
        kind: 'close',
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

describe('process identity probe interpretation (fail-closed)', () => {
  it('treats exit code 3 with empty output as verified gone', () => {
    const raw: IdentityProbeRaw = {
      kind: 'close',
      exitCode: 3,
      stdout: '',
      stderr: '',
    };
    expect(interpretIdentityProbe(raw)).toEqual({ status: 'gone' });
  });

  it('treats successful ISO start-time as alive', () => {
    const startedAt = '2026-07-12T12:00:00.000Z';
    const raw: IdentityProbeRaw = {
      kind: 'close',
      exitCode: 0,
      stdout: `${startedAt}\n`,
      stderr: '',
    };
    expect(interpretIdentityProbe(raw)).toEqual({
      status: 'alive',
      startedAt,
    });
  });

  it('treats missing PowerShell spawn error as probe_unavailable (not gone)', () => {
    const raw: IdentityProbeRaw = {
      kind: 'spawn_error',
      error: new Error('spawn powershell.exe ENOENT'),
    };
    const result = interpretIdentityProbe(raw);
    expect(result.status).toBe('probe_unavailable');
    if (result.status === 'probe_unavailable') {
      expect(result.reason).toMatch(/ENOENT|spawn|powershell/i);
    }
  });

  it('treats nonzero exit other than process-missing as probe_unavailable', () => {
    const raw: IdentityProbeRaw = {
      kind: 'close',
      exitCode: 1,
      stdout: '',
      stderr: 'Access is denied',
    };
    const result = interpretIdentityProbe(raw);
    expect(result.status).toBe('probe_unavailable');
    if (result.status === 'probe_unavailable') {
      expect(result.reason).toMatch(/exit|denied|nonzero/i);
    }
  });

  it('treats access-denied stderr with exit 5 empty body as probe_unavailable', () => {
    const raw: IdentityProbeRaw = {
      kind: 'close',
      exitCode: 5,
      stdout: '',
      stderr: 'Access is denied.',
    };
    const result = interpretIdentityProbe(raw);
    expect(result.status).toBe('probe_unavailable');
    if (result.status === 'probe_unavailable') {
      expect(result.reason).toMatch(/access|denied|exit/i);
    }
  });

  it('treats malformed ISO output as probe_invalid (not gone)', () => {
    const raw: IdentityProbeRaw = {
      kind: 'close',
      exitCode: 0,
      stdout: 'not-a-date\n',
      stderr: '',
    };
    const result = interpretIdentityProbe(raw);
    expect(result.status).toBe('probe_invalid');
    if (result.status === 'probe_invalid') {
      expect(result.reason).toMatch(/malformed|parse|date/i);
    }
  });

  it('treats empty stdout with exit 0 as probe_invalid', () => {
    const raw: IdentityProbeRaw = {
      kind: 'close',
      exitCode: 0,
      stdout: '   \n',
      stderr: '',
    };
    expect(interpretIdentityProbe(raw).status).toBe('probe_invalid');
  });
});

describe('generated identity probe script (real PowerShell path)', () => {
  /**
   * The production script previously used Get-CimInstance -ErrorAction SilentlyContinue.
   * On access denied / provider failure, $p became $null and the script exited 3 —
   * the same signal as a successful empty query. Synthetic unit exit 5 does not cover
   * that real script path; this executes the GENERATED body under a CIM shim.
   */
  it('CIM provider/command error cannot produce the same exit/status as verified gone', async () => {
    const productionBody = buildIdentityProbeScript(424_242);
    // Non-terminating CIM-style failure: empty result + error record, not a throw.
    // SilentlyContinue would swallow this into $null and incorrectly exit 3.
    const harness = [
      "function Get-CimInstance {",
      "  param([Parameter(Mandatory=$false)][string]$ClassName,[Parameter(Mandatory=$false)][string]$Filter)",
      "  Write-Error 'Access is denied.' -ErrorAction Continue",
      "  return $null",
      "}",
      productionBody,
    ].join('; ');

    const raw = await runPowerShellCommand(harness);
    const result = interpretIdentityProbe(raw);

    expect(raw.kind).toBe('close');
    if (raw.kind === 'close') {
      // Exit 3 is reserved for a successful CIM query that definitively returns no process.
      expect(raw.exitCode).not.toBe(3);
      expect(raw.exitCode).not.toBe(0);
    }
    expect(result.status).not.toBe('gone');
    expect(result.status).not.toBe('alive');
    expect(['probe_unavailable', 'probe_invalid']).toContain(result.status);
  }, 30_000);

  it('successful empty CIM query still reports verified gone (genuine PID absent)', async () => {
    // High unused PID; production script must still exit 3 only when the query succeeds empty.
    const absentPid = 2_147_483_647;
    const raw = await runPowerShellCommand(buildIdentityProbeScript(absentPid));
    expect(interpretIdentityProbe(raw)).toEqual({ status: 'gone' });
  }, 30_000);

  it('live PID returns parseable start-time (identity reusable for reuse checks)', async () => {
    const raw = await runPowerShellCommand(buildIdentityProbeScript(process.pid));
    const result = interpretIdentityProbe(raw);
    expect(result.status).toBe('alive');
    if (result.status === 'alive') {
      expect(Number.isFinite(Date.parse(result.startedAt))).toBe(true);
    }
  }, 30_000);
});
