import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_DELAY_MS = 60_000;
const CHILD_SOURCE = String.raw`
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const markerPath = process.argv[1];
const delayMs = Number(process.argv[2]);
const content = process.argv[3] ?? '';
setTimeout(() => {
  if (markerPath.length > 0) {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, content, 'utf8');
  }
}, delayMs);
`;

function fail(message) {
  throw new Error(`fake CLI protocol error: ${message}`);
}

function parseArguments(argv) {
  const scenarioPath = argv[0];
  if (typeof scenarioPath !== 'string' || scenarioPath.length === 0) {
    fail('scenario path is required');
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      typeof name !== 'string'
      || !name.startsWith('--')
      || typeof value !== 'string'
      || value.length === 0
    ) {
      fail('arguments must be --name value pairs');
    }
    if (values.has(name)) fail(`duplicate argument: ${name}`);
    values.set(name, value);
  }
  for (const name of values.keys()) {
    if (![
      '--attempt-id',
      '--project-root',
      '--temp-base',
      '--conversation-id',
    ].includes(name)) {
      fail(`unsupported argument: ${name}`);
    }
  }
  const attemptId = values.get('--attempt-id');
  const projectRoot = values.get('--project-root');
  const tempBase = values.get('--temp-base');
  if (attemptId === undefined || projectRoot === undefined || tempBase === undefined) {
    fail('--attempt-id, --project-root, and --temp-base are required');
  }
  return {
    scenarioPath: resolve(scenarioPath),
    attemptId,
    projectRoot: resolve(projectRoot),
    tempBase: resolve(tempBase),
    conversationId: values.get('--conversation-id'),
  };
}

function requireDelay(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DELAY_MS) {
    fail(`${field} must be an integer between 0 and ${String(MAX_DELAY_MS)}`);
  }
  return value;
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ''
    || (!pathFromRoot.startsWith(`..${sep}`)
      && pathFromRoot !== '..'
      && !isAbsolute(pathFromRoot));
}

function canonicalPlainDirectory(path, label) {
  let status;
  try {
    status = lstatSync(path);
  } catch (error) {
    throw new Error(`fake CLI could not inspect ${label}: ${path}`, { cause: error });
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    fail(`${label} must be a plain directory without a reparse or symlink alias`);
  }
  const absolute = resolve(path);
  const canonical = realpathSync(path);
  if (relative(absolute, canonical) !== '' || relative(canonical, absolute) !== '') {
    fail(`${label} contains a reparse, symlink, or non-canonical alias`);
  }
  return canonical;
}

function trustedTemporaryProject(tempBase, projectRoot) {
  const canonicalBase = canonicalPlainDirectory(tempBase, 'trusted temporary base');
  const canonicalProject = canonicalPlainDirectory(projectRoot, 'projectRoot');
  const projectFromBase = relative(canonicalBase, canonicalProject);
  if (projectFromBase === '') {
    fail('projectRoot must be a strict descendant of trusted temporary base');
  }
  if (
    projectFromBase === '..'
    || projectFromBase.startsWith(`..${sep}`)
    || isAbsolute(projectFromBase)
  ) {
    fail('projectRoot is outside the trusted temporary base');
  }
  return {
    tempBase: canonicalBase,
    projectRoot: canonicalProject,
  };
}

function projectFile(projectRoot, relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || isAbsolute(relativePath)
  ) {
    fail('project file path must be a non-empty relative path');
  }
  if (process.platform === 'win32') {
    for (const component of relativePath.split(/[\\/]+/)) {
      if (
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(component)
      ) {
        fail(`reserved Windows device name in project file: ${component}`);
      }
      if (component.includes(':') || /[. ]$/.test(component)) {
        fail(`unsafe Windows project file component: ${component}`);
      }
    }
  }
  const root = realpathSync(projectRoot);
  const target = resolve(root, relativePath);
  if (target === root || !isWithin(root, target)) {
    fail(`project file escapes supplied root: ${relativePath}`);
  }

  let current = root;
  for (const component of relative(root, dirname(target)).split(sep)) {
    if (component.length === 0) continue;
    current = resolve(current, component);
    try {
      const status = lstatSync(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        fail(`project file parent is not a plain directory: ${relativePath}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      mkdirSync(current);
    }
  }
  const realParent = realpathSync(dirname(target));
  if (!isWithin(root, realParent)) {
    fail(`project file parent escapes supplied root: ${relativePath}`);
  }
  try {
    lstatSync(target);
    fail(`project file target already exists: ${relativePath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target;
}

function loadScenario(path) {
  let scenario;
  try {
    scenario = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`fake CLI could not read scenario: ${path}`, { cause: error });
  }
  if (
    scenario === null
    || typeof scenario !== 'object'
    || Array.isArray(scenario)
    || scenario.version !== 1
    || !Array.isArray(scenario.steps)
  ) {
    fail('scenario must have version 1 and a steps array');
  }
  return scenario;
}

async function waitForChild(child) {
  await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(
        new Error(`fake descendant failed: code=${String(code)} signal=${String(signal)}`),
      );
    });
  });
}

async function runStep(step, context) {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) {
    fail('scenario steps must be objects');
  }
  switch (step.type) {
    case 'stdout':
    case 'stderr': {
      if (!Array.isArray(step.chunks) || !step.chunks.every((chunk) => typeof chunk === 'string')) {
        fail(`${step.type} chunks must be strings`);
      }
      const between = requireDelay(step.delayBetweenChunksMs ?? 0, 'delayBetweenChunksMs');
      const stream = step.type === 'stdout' ? process.stdout : process.stderr;
      for (let index = 0; index < step.chunks.length; index += 1) {
        stream.write(step.chunks[index]);
        if (between > 0 && index + 1 < step.chunks.length) await delay(between);
      }
      return false;
    }
    case 'delay':
      await delay(requireDelay(step.durationMs, 'durationMs'));
      return false;
    case 'write_file': {
      if (typeof step.content !== 'string') fail('write_file content must be a string');
      const path = projectFile(context.projectRoot, step.relativePath);
      writeFileSync(path, step.content, 'utf8');
      return false;
    }
    case 'spawn_descendant': {
      const delayMs = requireDelay(step.delayMs, 'descendant delayMs');
      const markerPath = step.markerRelativePath === undefined
        ? ''
        : projectFile(context.projectRoot, step.markerRelativePath);
      if (step.markerContent !== undefined && typeof step.markerContent !== 'string') {
        fail('descendant markerContent must be a string');
      }
      const waitForExit = step.waitForExit ?? false;
      if (typeof waitForExit !== 'boolean') fail('descendant waitForExit must be boolean');
      const child = spawn(
        process.execPath,
        [
          '-e',
          CHILD_SOURCE,
          markerPath,
          String(delayMs),
          step.markerContent ?? '',
        ],
        {
          cwd: context.projectRoot,
          stdio: 'ignore',
          windowsHide: true,
          detached: !waitForExit,
        },
      );
      if (waitForExit) await waitForChild(child);
      else child.unref();
      return false;
    }
    case 'exit':
      if (!Number.isInteger(step.code) || step.code < 0 || step.code > 255) {
        fail('exit code must be an integer from 0 to 255');
      }
      process.exitCode = step.code;
      return true;
    default:
      fail(`unsupported scenario step: ${String(step.type)}`);
  }
}

async function main() {
  const parsedArguments = parseArguments(process.argv.slice(2));
  const trustedPaths = trustedTemporaryProject(
    parsedArguments.tempBase,
    parsedArguments.projectRoot,
  );
  const context = { ...parsedArguments, ...trustedPaths };
  const scenario = loadScenario(context.scenarioPath);
  if (
    scenario.expectedAttemptId !== undefined
    && scenario.expectedAttemptId !== context.attemptId
  ) {
    fail('scenario attemptId does not match --attempt-id');
  }
  if (
    scenario.expectedConversationId !== undefined
    && scenario.expectedConversationId !== context.conversationId
  ) {
    fail('scenario conversationId does not match --conversation-id');
  }
  for (const step of scenario.steps) {
    if (await runStep(step, context)) return;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
