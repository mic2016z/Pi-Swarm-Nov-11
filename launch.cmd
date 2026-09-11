@echo off
setlocal
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 is required. Install Python and add it to PATH.
  pause
  exit /b 1
)
if exist "%~dp0pi-squad.exe" (
  start "" "%~dp0pi-squad.exe"
  exit /b
)
if exist "%~dp0src-tauri\target\debug\pi-squad.exe" (
  start "" "%~dp0src-tauri\target\debug\pi-squad.exe"
  exit /b
)
if exist "%~dp0chatgpt-plus-pi-subagents.exe" (
  start "" "%~dp0chatgpt-plus-pi-subagents.exe"
  exit /b 0
)
if exist "%~dp0src-tauri\target\debug\chatgpt-plus-pi-subagents.exe" (
  start "" "%~dp0src-tauri\target\debug\chatgpt-plus-pi-subagents.exe"
  exit /b 0
)
echo Build the app first: npm ci, then npm run tauri build -- --debug --no-bundle
pause
exit /b 1
