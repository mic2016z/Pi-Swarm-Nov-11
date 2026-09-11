param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\outputs'), [string]$ReleaseTag = 'final')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$stage = Join-Path $outputRoot ('quad-squad-oc-windows-' + $ReleaseTag)
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$exe = Join-Path $projectRoot 'src-tauri\target\release\quad-squad-oc.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Build the desktop executable first.' }
Copy-Item -LiteralPath $exe -Destination $stage -Force
foreach ($name in @('bridge.py','native_session.py','native-pi.ts','pi-master.ts','pisquad-messenger.ts','native-team.ts','team.py','launch.cmd','README.md')) { Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $stage -Force }
# Messenger has runtime dependencies, including its TypeScript broker launcher.
foreach ($manifest in @('package.json','package-lock.json')) { Copy-Item -LiteralPath (Join-Path $projectRoot $manifest) -Destination $stage -Force }
Push-Location -LiteralPath $stage
try {
    npm ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install packaged Messenger runtime dependencies.' }
} finally { Pop-Location }
Copy-Item -LiteralPath (Join-Path $projectRoot 'skills') -Destination $stage -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs') -Destination $stage -Recurse -Force
Compress-Archive -LiteralPath $stage -DestinationPath (Join-Path $outputRoot ('quad-squad-oc-windows-' + $ReleaseTag + '.zip')) -Force
$sourceFiles = @('AGENTS.md','README.md','bridge.py','native_session.py','native-pi.ts','pi-master.ts','pisquad-messenger.ts','native-team.ts','team.py','launch.cmd','package.json','package-lock.json','index.html','src','skills','docs','tests','scripts','.gitignore') | ForEach-Object { Join-Path $projectRoot $_ }
$sourceStage = Join-Path $outputRoot ('quad-squad-oc-source-' + $ReleaseTag)
New-Item -ItemType Directory -Path $sourceStage -Force | Out-Null
foreach ($path in $sourceFiles) { Copy-Item -LiteralPath $path -Destination $sourceStage -Recurse -Force }
$rustStage = Join-Path $sourceStage 'src-tauri'
New-Item -ItemType Directory -Path $rustStage -Force | Out-Null
foreach ($name in @('src','capabilities','icons','Cargo.toml','Cargo.lock','build.rs','tauri.conf.json')) { Copy-Item -LiteralPath (Join-Path $projectRoot ('src-tauri\' + $name)) -Destination $rustStage -Recurse -Force }
Compress-Archive -LiteralPath $sourceStage -DestinationPath (Join-Path $outputRoot ('quad-squad-oc-source-' + $ReleaseTag + '.zip')) -Force
Get-ChildItem -LiteralPath $outputRoot -Filter '*.zip' | Select-Object Name,Length
