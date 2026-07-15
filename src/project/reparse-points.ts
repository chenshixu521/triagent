import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { parse, relative, resolve, sep } from 'node:path';

export type ReparsePointKind =
  | 'symbolic-link'
  | 'junction'
  | 'junction-or-directory-symbolic-link'
  | 'unknown-reparse-point';

export interface ReparsePointEvidence {
  readonly inputPath: string;
  readonly targetPath: string;
  readonly linkTarget: string | null;
  readonly reportedTargets: readonly string[];
  readonly attributes: readonly string[];
  readonly linkType: string | null;
  readonly kind: ReparsePointKind;
}

export interface ReparseProbeResult {
  readonly path: string;
  readonly isReparsePoint: true;
  readonly linkType: string | null;
  readonly target: readonly string[];
  readonly attributes: readonly string[];
}

export type ReparsePointProbe = (requestedRoot: string) => unknown;

export class ReparseInspectionError extends Error {
  public override readonly name = 'ReparseInspectionError';

  public constructor(message: string, options?: ErrorOptions) {
    super(`ReparseInspectionError: ${message}`, options);
  }
}

const POWERSHELL_REPARSE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$requestedRoot = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRIAGENT_REPARSE_ROOT_BASE64))
$leaf = Get-Item -LiteralPath $requestedRoot -Force -ErrorAction Stop
$ancestors = New-Object 'System.Collections.Generic.List[object]'
$current = $leaf
while ($null -ne $current) {
  $ancestors.Add($current)
  $current = $current.Parent
}
$orderedAncestors = [object[]]$ancestors.ToArray()
[Array]::Reverse($orderedAncestors)
$results = New-Object 'System.Collections.Generic.List[object]'
foreach ($item in $orderedAncestors) {
  $isReparsePoint = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  if (-not $isReparsePoint) { continue }
  $attributeNames = @(([string]$item.Attributes -split ',') | ForEach-Object { $_.Trim() })
  $targets = @()
  if ($null -ne $item.Target) {
    $targets = @($item.Target | ForEach-Object { [string]$_ })
  }
  $linkType = if ($null -eq $item.LinkType) { $null } else { [string]$item.LinkType }
  $results.Add([pscustomobject]@{
    path = [string]$item.FullName
    isReparsePoint = $true
    linkType = $linkType
    target = $targets
    attributes = $attributeNames
  })
}
$json = if ($results.Count -eq 0) {
  '[]'
} else {
  ConvertTo-Json -InputObject ([object[]]$results.ToArray()) -Compress -Depth 4
}
$jsonBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
[Console]::Out.Write($jsonBase64)
`;

function pathComponents(absolutePath: string): readonly string[] {
  const root = parse(absolutePath).root;
  const remainder = relative(root, absolutePath);
  if (remainder.length === 0) return [];
  const components = remainder.split(sep).filter((component) => component.length > 0);
  const paths: string[] = [];
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    paths.push(current);
  }
  return paths;
}

function componentKey(input: string, platform: NodeJS.Platform): string {
  const absolute = resolve(input);
  return platform === 'win32'
    ? absolute.replaceAll('/', '\\').toLocaleLowerCase('en-US')
    : absolute;
}

function validateStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ReparseInspectionError(`probe field ${field} must be a string array`);
  }
  return value;
}

function validateProbeOutput(value: unknown): readonly ReparseProbeResult[] {
  if (!Array.isArray(value)) {
    throw new ReparseInspectionError('probe output must be an array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ReparseInspectionError(`probe result ${String(index)} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.path !== 'string' ||
      record.isReparsePoint !== true ||
      (record.linkType !== null && typeof record.linkType !== 'string')
    ) {
      throw new ReparseInspectionError(
        `probe result ${String(index)} has invalid path, reparse flag, or link type`,
      );
    }
    return {
      path: record.path,
      isReparsePoint: true,
      linkType: record.linkType,
      target: validateStringArray(record.target, `target[${String(index)}]`),
      attributes: validateStringArray(
        record.attributes,
        `attributes[${String(index)}]`,
      ),
    };
  });
}

function windowsPowerShellProbe(requestedRoot: string): unknown {
  let output: string;
  try {
    const rootBase64 = Buffer.from(requestedRoot, 'utf8').toString('base64');
    const encodedCommand = Buffer.from(
      POWERSHELL_REPARSE_SCRIPT,
      'utf16le',
    ).toString('base64');
    output = execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-OutputFormat',
        'Text',
        '-EncodedCommand',
        encodedCommand,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TRIAGENT_REPARSE_ROOT_BASE64: rootBase64,
        },
        maxBuffer: 512 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new ReparseInspectionError(
      'Windows PowerShell reparse-point probe failed, timed out, or exceeded its output limit',
      { cause: error },
    );
  }
  const normalizedOutput = output.replace(/^\uFEFF/, '').trim();
  try {
    const json = Buffer.from(normalizedOutput, 'base64').toString('utf8');
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new ReparseInspectionError(
      'Windows PowerShell reparse-point probe returned invalid JSON',
      { cause: error },
    );
  }
}

function fallbackProbe(
  components: readonly string[],
  stats: readonly Stats[],
): readonly ReparseProbeResult[] {
  const results: ReparseProbeResult[] = [];
  for (let index = 0; index < components.length; index += 1) {
    if (!stats[index]!.isSymbolicLink()) continue;
    results.push({
      path: components[index]!,
      isReparsePoint: true,
      linkType: 'SymbolicLink',
      target: [readlinkSync(components[index]!)],
      attributes: ['SymbolicLink'],
    });
  }
  return results;
}

function reparseKind(
  stats: Stats,
  componentPath: string,
  result: ReparseProbeResult,
): ReparsePointKind {
  const linkType = result.linkType?.toLocaleLowerCase('en-US') ?? '';
  if (linkType.includes('junction')) return 'junction';
  if (!stats.isSymbolicLink()) return 'unknown-reparse-point';
  if (process.platform === 'win32') {
    try {
      if (statSync(componentPath).isDirectory()) {
        return 'junction-or-directory-symbolic-link';
      }
    } catch {
      // realpath below reports the more useful failure for a broken link.
    }
  }
  return 'symbolic-link';
}

export function inspectInputReparsePoints(
  absolutePath: string,
  options: {
    readonly probe?: ReparsePointProbe;
    readonly platform?: NodeJS.Platform;
  } = {},
): readonly ReparsePointEvidence[] {
  const components = pathComponents(absolutePath);
  const stats = components.map((componentPath) => {
    try {
      return lstatSync(componentPath);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') {
        throw new Error(`project path does not exist: ${componentPath}`, {
          cause: error,
        });
      }
      throw error;
    }
  });
  if (components.length === 0) return [];

  const platform = options.platform ?? process.platform;
  let rawResults: unknown;
  try {
    rawResults = options.probe !== undefined
      ? options.probe(absolutePath)
      : platform === 'win32'
        ? windowsPowerShellProbe(absolutePath)
        : fallbackProbe(components, stats);
  } catch (error) {
    if (error instanceof ReparseInspectionError) throw error;
    throw new ReparseInspectionError('reparse-point probe failed', {
      cause: error,
    });
  }
  const results = validateProbeOutput(rawResults);
  const componentByKey = new Map(
    components.map((componentPath, index) => [
      componentKey(componentPath, platform),
      { componentPath, stats: stats[index]! },
    ]),
  );
  const seen = new Set<string>();
  const resultByKey = new Map<string, ReparseProbeResult>();
  for (const result of results) {
    const key = componentKey(result.path, platform);
    if (!componentByKey.has(key)) {
      throw new ReparseInspectionError(
        `probe returned a path that is not an ancestor component of the requested root: ${result.path}`,
      );
    }
    if (seen.has(key)) {
      throw new ReparseInspectionError(
        `probe returned duplicate reparse component: ${result.path}`,
      );
    }
    seen.add(key);
    resultByKey.set(key, result);
  }

  const evidence: ReparsePointEvidence[] = [];
  for (const [key, component] of componentByKey) {
    const result = resultByKey.get(key);
    if (component.stats.isSymbolicLink() && result === undefined) {
      throw new ReparseInspectionError(
        `probe failed to report symbolic-link component: ${component.componentPath}`,
      );
    }
    if (result === undefined) continue;
    evidence.push({
      inputPath: component.componentPath,
      targetPath: realpathSync.native(component.componentPath),
      linkTarget: component.stats.isSymbolicLink()
        ? readlinkSync(component.componentPath)
        : null,
      reportedTargets: result.target,
      attributes: result.attributes,
      linkType: result.linkType,
      kind: reparseKind(component.stats, component.componentPath, result),
    });
  }
  return evidence;
}
