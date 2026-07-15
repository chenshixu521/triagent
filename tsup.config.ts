import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'tsup';

/**
 * esbuild historically rewrites some `node:` built-ins (notably `node:sqlite`)
 * to bare package names. Restore the Node protocol after emit so the published
 * CLI runs on Node 24+ without a phantom `sqlite` dependency.
 */
function restoreNodeSqliteImports(outDir: string): void {
  const cliPath = join(outDir, 'cli.js');
  const original = readFileSync(cliPath, 'utf8');
  const rewritten = original
    .replaceAll('from "sqlite"', 'from "node:sqlite"')
    .replaceAll("from 'sqlite'", "from 'node:sqlite'")
    .replaceAll('from "sqlite/', 'from "node:sqlite/')
    .replaceAll("from 'sqlite/", "from 'node:sqlite/");
  if (rewritten !== original) {
    writeFileSync(cliPath, rewritten, 'utf8');
  }
  const mapPath = join(outDir, 'cli.js.map');
  try {
    const map = readFileSync(mapPath, 'utf8');
    const mapRewritten = map
      .replaceAll('from \\"sqlite\\"', 'from \\"node:sqlite\\"')
      .replaceAll("from 'sqlite'", "from 'node:sqlite'");
    if (mapRewritten !== map) {
      writeFileSync(mapPath, mapRewritten, 'utf8');
    }
  } catch {
    // source map optional
  }
}

function copyRuntimeMigrations(outDir: string): void {
  const sourceDirectory = join('src', 'persistence', 'migrations');
  const destinationDirectory = join(outDir, 'migrations');
  const migrationFiles = readdirSync(sourceDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile()
        && /^\d{3}_[a-z0-9_]+\.sql$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  if (migrationFiles.length === 0) {
    throw new Error('No runtime SQLite migrations found for distribution');
  }

  mkdirSync(destinationDirectory, { recursive: true });
  for (const name of migrationFiles) {
    copyFileSync(
      join(sourceDirectory, name),
      join(destinationDirectory, name),
    );
  }
}

export default defineConfig({
  entry: {
    cli: 'src/cli/main.tsx',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // Do not bundle Node built-ins or package dependencies; the global install
  // resolves them from the runtime Node + installed package tree.
  external: [/^node:/, /^[^./]/],
  banner: {
    js: '#!/usr/bin/env node',
  },
  async onSuccess() {
    restoreNodeSqliteImports('dist');
    copyRuntimeMigrations('dist');
  },
});
