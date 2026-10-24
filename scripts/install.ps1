# Installs the reeval binary for Windows from a GitHub release, checked against the release's
# SHA256SUMS, and adds its folder to your user PATH.
#
#   irm https://raw.githubusercontent.com/invertase/reeval/main/scripts/install.ps1 | iex
#
# REEVAL_VERSION     a version (0.13.0) instead of the newest release
# REEVAL_INSTALL_DIR where to put reeval.exe (default %LOCALAPPDATA%\reeval\bin)
# REEVAL_DOWNLOAD    where the release's files are, instead of its GitHub release (needs REEVAL_VERSION)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repo = 'invertase/reeval'
# Throws rather than exits: under `irm | iex`, exit would close the terminal.
function Fail($message) { throw "reeval install: $message" }

# Windows on Arm runs the x64 build under emulation.
$target = 'windows-x64'
$version = "$env:REEVAL_VERSION" -replace '^v', ''
if (-not $version) {
  if ($env:REEVAL_DOWNLOAD) { Fail 'REEVAL_DOWNLOAD needs REEVAL_VERSION' }
  # The newest reeval release: the repository's other releases are tagged <component>-v<version>.
  try { $releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=30" }
  catch { Fail "couldn't list the releases of ${repo}: $_" }
  $tag = $releases | Where-Object { $_.tag_name -match '^v\d' } | Select-Object -First 1 -ExpandProperty tag_name
  if (-not $tag) { Fail "no release of $repo found" }
  $version = $tag.Substring(1)
}
$base = if ($env:REEVAL_DOWNLOAD) { $env:REEVAL_DOWNLOAD } else { "https://github.com/$repo/releases/download/v$version" }
$name = "reeval-$version-$target.exe"
$dir = if ($env:REEVAL_INSTALL_DIR) { $env:REEVAL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'reeval\bin' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "reeval install: $name"
  try { Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS" }
  catch { Fail "reeval $version has no binaries ($base/SHA256SUMS)" }
  try { Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile "$tmp\$name" }
  catch { Fail "couldn't download $base/${name}: $_" }

  $expected = Get-Content "$tmp\SHA256SUMS" |
    ForEach-Object { $hash, $file = $_ -split '\s+\*?', 2; if ($file -eq $name) { $hash } } |
    Select-Object -First 1
  if (-not $expected) { Fail "SHA256SUMS doesn't list $name" }
  $actual = (Get-FileHash -Algorithm SHA256 "$tmp\$name").Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Fail "$name doesn't match SHA256SUMS (got $actual, expected $expected)"
  }

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Move-Item -Force "$tmp\$name" (Join-Path $dir 'reeval.exe')
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
$exe = Join-Path $dir 'reeval.exe'
Write-Host "reeval install: reeval $(& $exe --version) at $exe"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', (@($dir, $userPath) | Where-Object { $_ }) -join ';', 'User')
  Write-Host "reeval install: added $dir to your user PATH; open a new terminal to use it"
}
if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$dir;$env:Path" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "reeval install: reeval needs git, which isn't on your PATH"
}
