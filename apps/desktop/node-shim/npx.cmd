@echo off
setlocal
if not defined EIDOLON_NODE (
  echo npx: EIDOLON_NODE isn't set: Eidolon sets it for the MCP servers it starts 1>&2
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=1
if exist "%~dp0npx.ts" goto checkout
"%EIDOLON_NODE%" --disable-sigusr1 --use-system-ca "%~dp0..\..\npx.ts" %*
goto end
:checkout
"%EIDOLON_NODE%" --disable-sigusr1 --use-system-ca "%~dp0npx.ts" %*
:end
