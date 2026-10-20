@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Codex Model Guard Installer
set "CODEX_START_SETTINGS_NODE="
if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" set "CODEX_START_SETTINGS_NODE=%CODEX_MCP_NODE_PATH%"
if not defined CODEX_START_SETTINGS_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "CODEX_START_SETTINGS_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined CODEX_START_SETTINGS_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "CODEX_START_SETTINGS_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined CODEX_START_SETTINGS_NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined CODEX_START_SETTINGS_NODE set "CODEX_START_SETTINGS_NODE=%%N"
if not defined CODEX_START_SETTINGS_NODE (
  echo Node.js was not found. Open Codex and prepare its local runtime first.
  pause
  exit /b 1
)
"%CODEX_START_SETTINGS_NODE%" "%~dp0installer.mjs"
set "INSTALL_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %INSTALL_RESULT%
