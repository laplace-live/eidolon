@echo off
setlocal
if not defined EIDOLON_NODE (
  echo npx: EIDOLON_NODE isn't set: Eidolon sets it for the MCP servers it starts 1>&2
  exit /b 1
)
set "SCRIPT=%~dp0npx.ts"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0..\..\npx.ts"
set ELECTRON_RUN_AS_NODE=1
"%EIDOLON_NODE%" --disable-sigusr1 --use-system-ca "%SCRIPT%" %*
