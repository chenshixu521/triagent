import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('package contract', () => {
  it('defines the private triagent executable package for Node.js 24 and newer', async () => {
    const packageJsonUrl = new URL('../../../package.json', import.meta.url);
    const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as {
      name?: string;
      private?: boolean;
      bin?: Record<string, string>;
      engines?: { node?: string };
    };

    expect(packageJson.name).toBe('triagent-orchestrator');
    expect(packageJson.private).toBe(true);
    expect(packageJson.bin).toEqual({ triagent: './dist/cli.js' });
    expect(packageJson.engines?.node).toBe('>=24.0.0');
  });
});
