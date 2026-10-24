# Installs the reeval binary for Windows from a GitHub release, checked against the release's
# SHA256SUMS, and adds its folder to your user PATH.
#
#   irm https://raw.githubusercontent.com/invertase/reeval/main/scripts/install.ps1 | iex
#
# REEVAL_VERSION     a version (0.13.0) instead of the newest release
# REEVAL_INSTALL_DIR where to put reeval.exe (default %LOCALAPPDATA%\reeval\bin)
# REEVAL_DOWNLOAD    where the release's files are, instead of its GitHub release (needs REEVAL_VERSION)
# GITHUB_TOKEN       sent to the GitHub API when it looks up the newest release, if set
#
# It all runs in a script block, so under `irm | iex` none of its variables, functions or
# preferences outlive it in your session.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $protocol = [Net.ServicePointManager]::SecurityProtocol
  [Net.ServicePointManager]::SecurityProtocol = $protocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'invertase/reeval'
  # Throws rather than exits: under `irm | iex`, exit would close the terminal.
  function Fail($message) { throw "reeval install: $message" }
  # REEVAL_DOWNLOAD may be a file:// directory, which Invoke-WebRequest doesn't read.
  function Get-ReleaseFile($uri, $out) {
    if ($uri -like 'file://*') { Copy-Item -LiteralPath ([Uri]$uri).LocalPath $out }
    else { Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $out }
  }

  # The only Windows builds are x64. The default one needs AVX2; the baseline one runs on any x64
  # CPU. 40 is PF_AVX2_INSTRUCTIONS_AVAILABLE.
  $target = 'windows-x64'
  if ([Environment]::OSVersion.Platform -eq 'Win32NT') {
    $cpu = Add-Type -PassThru -Name Cpu -Namespace ReevalInstall -MemberDefinition `
      '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);'
    if (-not $cpu::IsProcessorFeaturePresent(40)) { $target = 'windows-x64-baseline' }
  }
  $version = "$env:REEVAL_VERSION" -replace '^v', ''
  if (-not $version) {
    if ($env:REEVAL_DOWNLOAD) { Fail 'REEVAL_DOWNLOAD needs REEVAL_VERSION' }
    # The newest published reeval release that has its binaries: they upload after the release is
    # created, and the repository's other releases are tagged <component>-v<version>.
    $api = "https://api.github.com/repos/$repo/releases?per_page=30"
    $headers = @{}
    if ($env:GITHUB_TOKEN) { $headers.Authorization = "Bearer $env:GITHUB_TOKEN" }
    $releases = $null
    foreach ($attempt in 1..2) {
      try { $releases = Invoke-RestMethod -Headers $headers $api; break }
      catch {
        $status = [int]$_.Exception.Response.StatusCode
        if ($status -eq 401 -and $headers.Authorization) {
          Write-Host "reeval install: the GitHub API refused GITHUB_TOKEN; listing the releases without it"
          $headers = @{}
          continue
        }
        if ($status -eq 403 -or $status -eq 429) {
          Fail "the GitHub API rate-limited listing the releases of $repo; set GITHUB_TOKEN to a token"
        }
        Fail "couldn't list the releases of ${repo}: $_"
      }
    }
    $tag = $releases |
      Where-Object { $_.tag_name -match '^v\d' -and -not $_.draft -and -not $_.prerelease -and @($_.assets.name) -contains 'SHA256SUMS' } |
      Select-Object -First 1 -ExpandProperty tag_name
    if (-not $tag) { Fail "no release of $repo has binaries yet" }
    $version = $tag.Substring(1)
  }
  $base = if ($env:REEVAL_DOWNLOAD) { $env:REEVAL_DOWNLOAD } else { "https://github.com/$repo/releases/download/v$version" }
  $name = "reeval-$version-$target.exe"
  $dir = if ($env:REEVAL_INSTALL_DIR) { $env:REEVAL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'reeval\bin' }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "reeval install: $name"
    try { Get-ReleaseFile "$base/SHA256SUMS" (Join-Path $tmp 'SHA256SUMS') }
    catch { Fail "reeval $version has no binaries ($base/SHA256SUMS)" }
    try { Get-ReleaseFile "$base/$name" (Join-Path $tmp $name) }
    catch { Fail "couldn't download $base/${name}: $_" }

    $expected = Get-Content (Join-Path $tmp 'SHA256SUMS') |
      ForEach-Object { $hash, $file = $_ -split '\s+\*?', 2; if ($file -eq $name) { $hash } } |
      Select-Object -First 1
    if (-not $expected) { Fail "SHA256SUMS doesn't list $name" }
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $name)).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
      Fail "$name doesn't match SHA256SUMS (got $actual, expected $expected)"
    }

    # Only its stdout is read, and not under 'Stop': Windows PowerShell turns a native command's
    # stderr into errors, which 'Stop' throws, failing a binary that started.
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = $null
    $installed = try { & (Join-Path $tmp $name) --version 2>$null } catch { $_ }
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) {
      $code = if ($null -eq $LASTEXITCODE) { "it couldn't run" } else { "exit $LASTEXITCODE" }
      Fail "$name doesn't start on this machine ($code), so nothing was installed: $installed"
    }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Move-Item -Force (Join-Path $tmp $name) (Join-Path $dir 'reeval.exe')
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    [Net.ServicePointManager]::SecurityProtocol = $protocol
  }
  $exe = Join-Path $dir 'reeval.exe'
  Write-Host "reeval install: reeval $installed at $exe"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $dir) {
    [Environment]::SetEnvironmentVariable('Path', (@($dir, $userPath) | Where-Object { $_ }) -join ';', 'User')
    Write-Host "reeval install: added $dir to your user PATH; open a new terminal to use it"
  }
  if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$dir;$env:Path" }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "reeval install: reeval needs git, which isn't on your PATH"
  }
}
