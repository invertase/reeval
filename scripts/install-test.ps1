# Tests scripts/install.ps1 as `irm | iex` runs it, against a release directory (the binaries and
# SHA256SUMS that binary.yml builds): what it installs, what it refuses, and that it leaves the
# session's preferences, variables and functions as they were.
#
#   pwsh -File scripts/install-test.ps1 -Release out -Version 0.13.0
param([Parameter(Mandatory)] [string] $Release, [Parameter(Mandatory)] [string] $Version)

$script = Join-Path $PSScriptRoot 'install.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
$name = "reeval-$Version-windows-x64.exe"
$failures = 0
function Check($label, $ok, $detail) {
  if ($ok) { Write-Host "ok   $label" } else { Write-Host "FAIL $label $detail"; $script:failures++ }
}
function Release($dir, [switch] $Tamper, [switch] $Unlisted) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item (Join-Path $Release $name) $dir
  Copy-Item (Join-Path $Release 'SHA256SUMS') $dir
  if ($Tamper) { Add-Content -LiteralPath (Join-Path $dir $name) 'tampered' }
  if ($Unlisted) { Set-Content -LiteralPath (Join-Path $dir 'SHA256SUMS') '' }
  ([Uri]('file:///' + ((Resolve-Path $dir).Path -replace '\\', '/').TrimStart('/'))).AbsoluteUri
}
# Runs install.ps1 through Invoke-Expression in the caller's scope (call it dot-sourced, as
# `. Install`), as `irm | iex` runs it at a prompt; the error it threw, if any.
function Install($download, $dir) {
  $env:REEVAL_VERSION = $Version
  $env:REEVAL_DOWNLOAD = $download
  $env:REEVAL_INSTALL_DIR = $dir
  try { Get-Content -Raw $script | Invoke-Expression *> $null; $null } catch { "$_" }
}
function Untouched {
  $ErrorActionPreference -eq 'Continue' -and $ProgressPreference -eq 'Continue' -and
    -not (Get-Command Fail, Get-ReleaseFile -ErrorAction SilentlyContinue) -and
    -not (Get-Variable tmp, base, expected -Scope Script -ErrorAction SilentlyContinue)
}

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'Continue'
try {
  $good = Release (Join-Path $work 'good')
  $err = . Install $good (Join-Path $work 'a')
  $exe = Join-Path $work 'a/reeval.exe'
  $installed = if (Test-Path $exe) { & $exe --version }
  Check "installs the release's binary" ($null -eq $err -and $installed -eq $Version) "$err $installed"
  Check 'leaves the session as it was' (Untouched)

  $err = . Install (Release (Join-Path $work 'tampered') -Tamper) (Join-Path $work 'b')
  Check "refuses a binary that doesn't match SHA256SUMS" (
    "$err" -match "doesn't match SHA256SUMS" -and -not (Test-Path (Join-Path $work 'b/reeval.exe'))) $err
  Check 'leaves the session as it was after failing' (Untouched)

  $err = . Install (Release (Join-Path $work 'unlisted') -Unlisted) (Join-Path $work 'c')
  Check "refuses a binary SHA256SUMS doesn't list" ("$err" -match "doesn't list") $err
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
if ($failures) { exit 1 }
