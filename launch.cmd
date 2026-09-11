@echo off
setlocal
if exist "%~dp0hermes-quad-squad.exe" (
  start "" "%~dp0hermes-quad-squad.exe"
  exit /b
)
if exist "%~dp0src-tauri\target\debug\hermes-quad-squad.exe" (
  start "" "%~dp0src-tauri\target\debug\hermes-quad-squad.exe"
  exit /b
)
echo Build the app first: npm ci, then npm run tauri build -- --debug --no-bundle
pause
exit /b 1
