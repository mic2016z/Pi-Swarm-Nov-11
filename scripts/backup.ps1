<#
.SYNOPSIS
  Timestamped local snapshot of the project, keeping the newest few.

.DESCRIPTION
  Copies the source tree (including .git, so history travels with the snapshot)
  into Coding\backup\<name>-<timestamp>, then deletes the oldest snapshots until
  only -Keep remain. Build output and dependencies are skipped: they are large,
  regenerable, and would dwarf the source they are meant to protect.
#>
[CmdletBinding()]
param(
    [string]$Destination = 'D:\Coding\backup',
    [int]$Keep = 5,
    [string]$Label = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$name = Split-Path -Leaf $projectRoot
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$suffix = if ($Label) { '_' + ($Label -replace '[^A-Za-z0-9._-]', '-') } else { '' }
$target = Join-Path $Destination ("{0}_{1}{2}" -f $name, $stamp, $suffix)

# Regenerable, and orders of magnitude larger than the source.
$exclude = @('node_modules', 'target', 'dist', '__pycache__', '.pytest_cache', 'outputs')
$excludeFiles = @('*.exe', '*.pdb')

# Free the oldest slot first, so the new snapshot replaces it rather than the
# disk briefly holding one more than asked for.
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$existing = Get-ChildItem $Destination -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "$name`_*" } |
            Sort-Object Name -Descending
if ($existing.Count -ge $Keep) {
    foreach ($old in $existing | Select-Object -Skip ($Keep - 1)) {
        Remove-Item $old.FullName -Recurse -Force
        Write-Output "Replaced oldest snapshot: $($old.Name)"
    }
}

New-Item -ItemType Directory -Path $target -Force | Out-Null
$args = @($projectRoot, $target, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
$args += '/XD'; $args += $exclude
$args += '/XF'; $args += $excludeFiles
& robocopy @args | Out-Null

# robocopy uses exit codes below 8 for success with varying detail.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

$size = (Get-ChildItem $target -Recurse -File -ErrorAction SilentlyContinue |
         Measure-Object -Property Length -Sum).Sum
Write-Output ("Snapshot: {0} ({1:N1} MB)" -f $target, ($size / 1MB))

$kept = @(Get-ChildItem $Destination -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -like "$name`_*" })
Write-Output ("Holding {0} of {1} snapshot(s)." -f $kept.Count, $Keep)

# robocopy signals detail in its exit code; below 8 is success, so do not leak
# a non-zero status to whatever called this script.
exit 0
