#!/usr/bin/env node
/**
 * Publish the self-contained win-x64 ProcessHost helper and copy it to
 * dist/native/win-x64/triagent-process-host.exe for runtime resolution.
 *
 * Usage:
 *   node scripts/build-native.mjs           # full dotnet publish + copy
 *   node scripts/build-native.mjs --copy-only
 *     Re-copy from an existing publish output (used after tsup cleans dist/).
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'native', 'TriAgent.ProcessHost', 'TriAgent.ProcessHost.csproj');
const publishDir = join(
  root,
  'native',
  'TriAgent.ProcessHost',
  'bin',
  'Release',
  'net10.0',
  'win-x64',
  'publish',
);
const outDir = join(root, 'dist', 'native', 'win-x64');
const outExe = join(outDir, 'triagent-process-host.exe');
const copyOnly = process.argv.includes('--copy-only');

function findPublishedExe(directory) {
  const direct = join(directory, 'triagent-process-host.exe');
  if (existsSync(direct)) return direct;
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isFile() && entry.toLowerCase().endsWith('.exe')) {
      return full;
    }
  }
  return null;
}

function copyPublishedHelper() {
  const published = findPublishedExe(publishDir);
  if (published === null) {
    console.error(`Published helper not found under ${publishDir}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  copyFileSync(published, outExe);
  console.log(`Copied ProcessHost -> ${outExe}`);
}

if (copyOnly) {
  copyPublishedHelper();
  process.exit(0);
}

if (!existsSync(project)) {
  console.error(`ProcessHost project missing: ${project}`);
  process.exit(1);
}

const args = [
  'publish',
  project,
  '-c',
  'Release',
  '-r',
  'win-x64',
  '--self-contained',
  'true',
  '-p:PublishSingleFile=true',
  '-o',
  publishDir,
];

console.log(`dotnet ${args.join(' ')}`);
const result = spawnSync('dotnet', args, {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

copyPublishedHelper();
