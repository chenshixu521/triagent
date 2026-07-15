import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Windows ACL, CIM, Git, npm-pack, and Job Object tests are resource-heavy.
    // The host exposes 32 logical CPUs; unbounded file workers cause false
    // timeout/performance failures through process and filesystem contention.
    maxWorkers: 4,
  },
});
