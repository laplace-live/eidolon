@echo off
rem Copyright (c) 2026 DeepSeek
rem SPDX-License-Identifier: MIT
rem
rem Ported from deepseek-harness apps/desktop/cli/dsh.cmd@2e39e70496
rem
rem The eidolon command, whose folder Settings adds to the PATH: with no arguments it opens
rem Eidolon, with any it runs the CLI on the app's own binary as Node.
setlocal DisableDelayedExpansion
if "%~1"=="" (
  set "ELECTRON_RUN_AS_NODE="
  start "" "%~dp0..\..\Eidolon.exe"
  exit /b 0
)
set "ELECTRON_RUN_AS_NODE=1"
set "EIDOLON_APP_ROOT=%~dp0..\eidolon"
set "EIDOLON_NO_DOTENV=1"
"%~dp0..\..\Eidolon.exe" --disable-sigusr1 --use-system-ca "%~dp0..\eidolon\dist\cli.js" %*
exit /b %errorlevel%
