@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Codex Model Guard Settings
set "MODEL_GUARD_NODE="
if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" set "MODEL_GUARD_NODE=%CODEX_MCP_NODE_PATH%"
if not defined MODEL_GUARD_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "MODEL_GUARD_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined MODEL_GUARD_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "MODEL_GUARD_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined MODEL_GUARD_NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined MODEL_GUARD_NODE set "MODEL_GUARD_NODE=%%N"
if not defined MODEL_GUARD_NODE (
  echo Node.js was not found. Open Codex and prepare its local runtime first.
  pause
  exit /b 1
)
set "MODEL_GUARD_SCRIPT=%~dp0manage-settings.mjs"
if exist "%~dp0payload\manage-settings.mjs" set "MODEL_GUARD_SCRIPT=%~dp0payload\manage-settings.mjs"
"%MODEL_GUARD_NODE%" "%MODEL_GUARD_SCRIPT%" %*
set "MODEL_GUARD_RESULT=%ERRORLEVEL%"
if not "%MODEL_GUARD_RESULT%"=="0" pause
exit /b %MODEL_GUARD_RESULT%
