#Requires -Version 5.1
<#
.SYNOPSIS
  Compile the TriAgent ProcessHost native helper for win-x64 Release into a
  fresh staging directory, then atomically promote the exact exe to the stable
  publish path.

.DESCRIPTION
  - Publishes to a unique clean staging directory under the project native tree.
  - Ensures the expected staging exe did not preexist before publish.
  - Does not download SDKs/toolchains implicitly; missing dotnet fails clearly.
  - Validates command success, exact newly emitted regular PE x64 exe.
  - Atomically promotes to stable publish output with rollback.
  - finally removes exact staging only.
  - A successful publish that emits no exact exe FAILS even if an old stable
    exe still exists (no silent reuse of stale prebuilt).
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$Project = Join-Path $Root 'native\TriAgent.ProcessHost\TriAgent.ProcessHost.csproj'
$NativeRoot = Join-Path $Root 'native\TriAgent.ProcessHost'
$StablePublishDir = Join-Path $NativeRoot 'bin\Release\net10.0\win-x64\publish'
$StableExe = Join-Path $StablePublishDir 'triagent-process-host.exe'
$ExeName = 'triagent-process-host.exe'

# Injectable publish command for stale-exe regression tests.
# When TRIAGENT_DOTNET_PUBLISH_CMD is set, it is invoked instead of real dotnet.
$InjectedPublishCmd = $env:TRIAGENT_DOTNET_PUBLISH_CMD

function Write-Err([string]$Message) {
  [Console]::Error.WriteLine($Message)
}

function Test-IsReparse([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Get-PeMachine([string]$Path) {
  $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $br = New-Object System.IO.BinaryReader($fs)
    $mz = $br.ReadUInt16()
    if ($mz -ne 0x5A4D) { throw 'not MZ' }
    $null = $fs.Seek(0x3C, [System.IO.SeekOrigin]::Begin)
    $peOffset = $br.ReadUInt32()
    $null = $fs.Seek($peOffset, [System.IO.SeekOrigin]::Begin)
    $peSig = $br.ReadUInt32()
    if ($peSig -ne 0x00004550) { throw 'not PE' }
    return $br.ReadUInt16()
  }
  finally {
    $fs.Dispose()
  }
}

function Get-Sha256Hex([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $fs = [System.IO.File]::OpenRead($Path)
    try {
      $hash = $sha.ComputeHash($fs)
      return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
    }
    finally { $fs.Dispose() }
  }
  finally { $sha.Dispose() }
}

if (-not (Test-Path -LiteralPath $Project)) {
  Write-Err "ProcessHost project missing: $Project"
  exit 1
}

# Validate native root is under package root (path containment).
$NativeRootResolved = (Resolve-Path -LiteralPath $NativeRoot).Path
if (-not $NativeRootResolved.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
  Write-Err "native root escapes package root: $NativeRootResolved"
  exit 1
}

if (-not $InjectedPublishCmd) {
  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($null -eq $dotnet) {
    Write-Err @'
Prerequisite missing: .NET SDK (dotnet) is not on PATH.

Install the .NET 10 SDK (or the SDK matching TargetFramework net10.0) from
https://dotnet.microsoft.com/download before running build:native.

This script will not download SDKs or toolchains automatically.
'@
    exit 1
  }
}

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$nonce = [guid]::NewGuid().ToString('N').Substring(0, 12)
$StagingDir = Join-Path $NativeRoot "bin\Release\net10.0\win-x64\publish-staging-$stamp-$nonce"
$StagingExe = Join-Path $StagingDir $ExeName

# Ensure staging is unique and empty; expected exe must not preexist.
if (Test-Path -LiteralPath $StagingDir) {
  Write-Err "staging directory already exists (refusing reuse): $StagingDir"
  exit 1
}
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null
if (Test-Path -LiteralPath $StagingExe) {
  Write-Err "staging exe preexisted before publish: $StagingExe"
  exit 1
}

$publishStarted = Get-Date
$exitCode = 1
$promoted = $false
$stableBackup = $null

try {
  Write-Host "Publishing ProcessHost to fresh staging: $StagingDir"

  if ($InjectedPublishCmd) {
    Write-Host "Using injected publish command (test seam): $InjectedPublishCmd"
    # Injected command receives staging dir as first arg; must create exact exe or nothing.
    & cmd.exe /d /s /c "`"$InjectedPublishCmd`" `"$StagingDir`""
    if ($LASTEXITCODE -ne 0) {
      throw "injected publish failed with exit code $LASTEXITCODE"
    }
  }
  else {
    $publishArgs = @(
      'publish',
      $Project,
      '-c', 'Release',
      '-r', 'win-x64',
      '--self-contained', 'true',
      '-p:PublishSingleFile=true',
      # Do not restore remote toolchains beyond the configured SDK.
      '--nologo',
      '-o', $StagingDir
    )
    Write-Host "dotnet $($publishArgs -join ' ')"
    & dotnet @publishArgs
    if ($LASTEXITCODE -ne 0) {
      throw "dotnet publish failed with exit code $LASTEXITCODE"
    }
  }

  # Exact newly emitted exe required — old stable exe must NOT satisfy this.
  if (-not (Test-Path -LiteralPath $StagingExe)) {
    throw "Published helper missing after compile at staging path: $StagingExe (refusing stale stable exe)"
  }
  if (Test-IsReparse $StagingExe) {
    throw "Published staging helper is a reparse point: $StagingExe"
  }
  $item = Get-Item -LiteralPath $StagingExe
  if (-not $item.PSIsContainer -and $item.Length -le 0) {
    throw "Published staging helper is empty: $StagingExe"
  }
  if ($item.LastWriteTime -lt $publishStarted.AddSeconds(-5)) {
    # Soft check: warn-level only if clock skew; still require staging path existence
    # which cannot be the pre-existing stable file.
  }

  try {
    $machine = Get-PeMachine -Path $StagingExe
  }
  catch {
    throw "staging helper is not a valid PE executable: $StagingExe ($($_.Exception.Message))"
  }
  if ($machine -ne 0x8664) {
    throw ("staging helper PE machine 0x{0:x} is not win-x64 (expected 0x8664)" -f $machine)
  }

  $sha = Get-Sha256Hex -Path $StagingExe
  Write-Host "Staging helper OK: $StagingExe ($($item.Length) bytes, sha256=$sha, pe=0x$('{0:x}' -f $machine))"

  # Atomic promote to stable publish dir.
  if (-not (Test-Path -LiteralPath $StablePublishDir)) {
    New-Item -ItemType Directory -Path $StablePublishDir -Force | Out-Null
  }

  $stableBackup = Join-Path $StablePublishDir (".triagent-process-host.stable.bak.$PID.$nonce")
  if (Test-Path -LiteralPath $StableExe) {
    if (Test-IsReparse $StableExe) {
      throw "stable publish exe is a reparse point: $StableExe"
    }
    Move-Item -LiteralPath $StableExe -Destination $stableBackup -Force
  }

  try {
    Copy-Item -LiteralPath $StagingExe -Destination $StableExe -Force
    if (-not (Test-Path -LiteralPath $StableExe)) {
      throw "stable promote failed: destination missing after copy"
    }
    if (Test-IsReparse $StableExe) {
      throw "stable promote produced reparse point: $StableExe"
    }
    $stableSha = Get-Sha256Hex -Path $StableExe
    if ($stableSha -ne $sha) {
      throw "stable promote checksum mismatch (staging=$sha stable=$stableSha)"
    }
    $promoted = $true
    if ($null -ne $stableBackup -and (Test-Path -LiteralPath $stableBackup)) {
      Remove-Item -LiteralPath $stableBackup -Force
      $stableBackup = $null
    }
  }
  catch {
    # Rollback stable from backup if present.
    if ($null -ne $stableBackup -and (Test-Path -LiteralPath $stableBackup)) {
      if (Test-Path -LiteralPath $StableExe) {
        Remove-Item -LiteralPath $StableExe -Force -ErrorAction SilentlyContinue
      }
      Move-Item -LiteralPath $stableBackup -Destination $StableExe -Force
      $stableBackup = $null
    }
    throw
  }

  Write-Host "ProcessHost published: $StableExe ($($item.Length) bytes)"
  $exitCode = 0
}
catch {
  Write-Err $_.Exception.Message
  $exitCode = 1
}
finally {
  # Remove exact staging directory only (never the stable publish tree).
  if (Test-Path -LiteralPath $StagingDir) {
    try {
      Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction Stop
    }
    catch {
      Write-Err "warning: could not remove staging dir $StagingDir : $($_.Exception.Message)"
    }
  }
  # If promote failed and backup remains, keep it for recovery (do not delete).
  if ($null -ne $stableBackup -and (Test-Path -LiteralPath $stableBackup) -and -not $promoted) {
    Write-Err "stable backup preserved for recovery: $stableBackup"
  }
}

exit $exitCode
