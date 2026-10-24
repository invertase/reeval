# Tests scripts/install.ps1 as `irm | iex` runs it, against a release directory (the binaries and
# SHA256SUMS that binary.yml builds): what it installs, what it refuses, and that it leaves the
# session's preferences, variables and functions as they were.
#
#   pwsh -File scripts/install-test.ps1 -Release out -Version 0.13.0
param([Parameter(Mandatory)] [string] $Release, [Parameter(Mandatory)] [string] $Version)

$script = Join-Path $PSScriptRoot 'install.ps1'
# An HTTP error as Invoke-RestMethod throws it, carrying its response's status.
class HttpError : Exception {
  [object] $Response
  HttpError([int] $status) : base("HTTP $status") { $this.Response = [pscustomobject]@{ StatusCode = $status } }
}
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
function Install($download, $dir, [switch] $Latest) {
  $env:REEVAL_VERSION = if ($Latest) { '' } else { $Version }
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

  # The newest release with SHA256SUMS: these stand in for the GitHub API and release downloads,
  # with a newer release still without binaries, a prerelease, a draft and another component's.
  $script:requests = @()
  $script:releases = @(
    @{ tag_name = 'v99.0.0'; draft = $false; prerelease = $false; assets = @() }
    @{ tag_name = 'v98.0.0'; draft = $false; prerelease = $true; assets = @(@{ name = 'SHA256SUMS' }) }
    @{ tag_name = 'v97.0.0'; draft = $true; prerelease = $false; assets = @(@{ name = 'SHA256SUMS' }) }
    @{ tag_name = 'reeval-python-v96.0.0'; draft = $false; prerelease = $false; assets = @(@{ name = 'SHA256SUMS' }) }
    @{ tag_name = "v$Version"; draft = $false; prerelease = $false; assets = @(@{ name = $name }, @{ name = 'SHA256SUMS' }) }
  ) | ForEach-Object { [pscustomobject]$_ }
  function Invoke-RestMethod($Uri, $Headers) {
    $script:requests += "$($Headers.Authorization) $Uri"
    if ($script:refused -and $Headers.Authorization -eq "Bearer $script:refused") { throw [HttpError]::new(401) }
    if ($script:apiStatus) { throw [HttpError]::new($script:apiStatus) }
    $script:releases
  }
  function Invoke-WebRequest([switch] $UseBasicParsing, $Uri, $OutFile, $Headers) {
    $script:requests += "$($Headers.Authorization) $Uri"
    Copy-Item (Join-Path $Release ($Uri -replace '.*/')) $OutFile
  }
  $env:GITHUB_TOKEN = 'secret-token'
  $err = . Install '' (Join-Path $work 'd') -Latest
  $exe = Join-Path $work 'd/reeval.exe'
  $installed = if (Test-Path $exe) { & $exe --version }
  Check 'installs the newest published release that has SHA256SUMS' ($null -eq $err -and $installed -eq $Version) "$err $installed"
  Check 'sends GITHUB_TOKEN to the GitHub API only' (
    $requests[0] -eq 'Bearer secret-token https://api.github.com/repos/invertase/reeval/releases?per_page=30' -and
    -not ($requests | Select-Object -Skip 1 | Where-Object { $_ -match 'secret' })) ($requests -join '; ')
  $env:GITHUB_TOKEN = $script:refused = 'stale-token'
  $err = . Install '' (Join-Path $work 'f') -Latest
  Check 'lists the releases without a GITHUB_TOKEN the API refuses' (
    $null -eq $err -and (Test-Path (Join-Path $work 'f/reeval.exe'))) $err
  $script:refused = $null
  $script:apiStatus = 403
  $err = . Install '' (Join-Path $work 'g') -Latest
  Check 'says when the API rate-limits it' ("$err" -match 'rate-limited') $err
  $script:apiStatus = 500
  $err = . Install '' (Join-Path $work 'h') -Latest
  Check 'names the failure on any other status' ("$err" -match "couldn't list" -and "$err" -notmatch 'rate-limited') $err
  $script:apiStatus = $null
  $script:releases = @([pscustomobject]@{ tag_name = 'v99.0.0'; draft = $false; prerelease = $false; assets = @() })
  $err = . Install '' (Join-Path $work 'e') -Latest
  Check 'says when no release has binaries yet' ("$err" -match 'has binaries yet') $err
  Remove-Item Function:\Invoke-RestMethod, Function:\Invoke-WebRequest, Env:\GITHUB_TOKEN

  # Over HTTP, as from a GitHub release, and run with -File in a shell of its own.
  $python = (Get-Command python, python3 -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  $server = Start-Process $python -ArgumentList '-m', 'http.server', $port, '--bind', '127.0.0.1', '--directory', (Join-Path $work 'good') -PassThru
  try {
    $up = $false
    foreach ($i in 1..50) {
      try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/SHA256SUMS" | Out-Null; $up = $true; break }
      catch { Start-Sleep -Milliseconds 200 }
    }
    Check 'serves the release over HTTP' $up
    $env:REEVAL_VERSION = $Version
    $env:REEVAL_DOWNLOAD = "http://127.0.0.1:$port"
    $env:REEVAL_INSTALL_DIR = Join-Path $work 'http'
    & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $script *> $null
    $code = $LASTEXITCODE
    $exe = Join-Path $work 'http/reeval.exe'
    $installed = if (Test-Path $exe) { & $exe --version }
    Check 'installs over HTTP with -File' ($code -eq 0 -and $installed -eq $Version) "exit $code, $installed"
  } finally {
    Stop-Process $server -ErrorAction SilentlyContinue
  }
} catch {
  Write-Host "FAIL $_"
  $failures++
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
if ($failures) { exit 1 }
