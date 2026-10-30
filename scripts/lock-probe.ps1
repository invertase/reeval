param([string] $Exe, [int] $Runs = 40, [string] $Handle)
$ErrorActionPreference = 'Stop'
$work = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
New-Item -ItemType Directory $work | Out-Null
$stats = @{}
foreach ($mode in 'copy-hash-move', 'copy-hash-run-move') {
  $stats[$mode] = 0
  foreach ($i in 1..$Runs) {
    $tmp = Join-Path $work "$mode-$i"
    New-Item -ItemType Directory $tmp | Out-Null
    $file = Join-Path $tmp 'reeval-x-windows-x64.exe'
    Copy-Item -LiteralPath $Exe $file
    $null = Get-FileHash -Algorithm SHA256 $file
    if ($mode -like '*run*') { $v = & $file --version 2>$null }
    $dest = Join-Path $work "$mode-$i-dest"
    New-Item -ItemType Directory $dest | Out-Null
    try { Move-Item -Force $file (Join-Path $dest 'reeval.exe') }
    catch {
      $stats[$mode]++
      Write-Host "LOCK $mode #$i : $_"
      if ($Handle) { & $Handle -accepteula -nobanner -u $file 2>&1 | Write-Host }
      Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$work*" } |
        ForEach-Object { Write-Host "  proc $($_.ProcessId) $($_.ExecutablePath) parent $($_.ParentProcessId)" }
      $sw = [Diagnostics.Stopwatch]::StartNew()
      while ($true) {
        try { Move-Item -Force $file (Join-Path $dest 'reeval.exe'); break }
        catch { if ($sw.ElapsedMilliseconds -gt 15000) { Write-Host '  still locked after 15s'; break }; Start-Sleep -Milliseconds 20 }
      }
      Write-Host "  released after $($sw.ElapsedMilliseconds) ms"
    }
  }
}
$stats.GetEnumerator() | ForEach-Object { Write-Host "SUMMARY $($_.Key): $($_.Value)/$Runs locked" }
