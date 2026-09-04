@echo off
setlocal
rem ---------------------------------------------------------------------------
rem commonly-up.bat -- quick-start the local Commonly agent (pod member) on Windows.
rem
rem Windows-native equivalent of scripts/commonly-up.sh: checks the CLI, the
rem login state, reads the pod id from the project .env, scaffolds the
rem webhook-SDK agent on first run, then launches it. No Bash dependency.
rem
rem Registry identity matches AGENTS.md "Commonly Setup":
rem   COMMONLY_POD_ID     -- lives in the project's .env (shared by all members)
rem   COMMONLY_AGENT_NAME -- optional override; default is derived from the host
rem Agent name is sanitized to the registry charset [a-z0-9-].
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
setlocal EnableDelayedExpansion

rem ----- force UTF-8 for Windows console and Python webhook SDK -----
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "LANG=C.UTF-8"
set "LC_ALL=C.UTF-8"

rem ----- locate the repo root from this script's own path (%~dp0) -----
set "REPO_ROOT=%~dp0.."
set "AGENT_DIR=%REPO_ROOT%\scripts\commonly-agent"

rem ----- load COMMONLY_* from the project .env if present -----
if exist "%REPO_ROOT%\.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%REPO_ROOT%\.env") do (
    if "%%A"=="COMMONLY_POD_ID" set "COMMONLY_POD_ID=%%B"
    if "%%A"=="COMMONLY_AGENT_NAME" set "COMMONLY_AGENT_NAME=%%B"
  )
)
if not defined COMMONLY_POD_ID set "COMMONLY_POD_ID=6a520e34f4baa9b280bba195"

rem ----- agent name precedence: arg > COMMONLY_AGENT_NAME > %COMPUTERNAME%-agent
set "RAW_NAME="
if not "%~1"=="" set "RAW_NAME=%~1"
if not defined RAW_NAME if defined COMMONLY_AGENT_NAME set "RAW_NAME=%COMMONLY_AGENT_NAME%"
if not defined RAW_NAME set "RAW_NAME=%COMPUTERNAME%-agent"

rem Sanitize to [a-z0-9-] (lowercase, drop other chars, trim edge dashes) via
rem native Windows PowerShell; pass the value through the env to avoid quoting.
set "AGTRAW=%RAW_NAME%"
for /f "usebackq delims=" %%N in (`powershell -NoProfile -Command "$n = $env:AGTRAW.ToLowerInvariant() -replace '[^a-z0-9-]',''; $n = $n.Trim('-'); Write-Output $n"`) do set "AGENT_NAME=%%N"
if "%AGENT_NAME%"=="" (
  echo ERROR: agent name is empty after sanitization. 1>&2
  exit /b 1
)

rem ----- Python interpreter: prefer $PYTHON, else python -----
set "PY=%PYTHON%"
if not defined PY set "PY=python"

rem ----- tooling checks -----
where commonly >nul 2>nul
if errorlevel 1 (
  echo ERROR: 'commonly' CLI not found. Install with: npm i -g @commonlyai/cli@latest 1>&2
  exit /b 1
)
if not exist "%USERPROFILE%\.commonly\config.json" (
  echo Not logged in. Run in a terminal: commonly login   then re-run this script. 1>&2
  exit /b 1
)

rem ----- scaffold once (idempotent: only when the env marker is missing) -----
if not exist "%AGENT_DIR%\.commonly-env" (
  echo [commonly-up] scaffolding agent '%AGENT_NAME%' into %AGENT_DIR%
  call commonly agent init --language python --name "%AGENT_NAME%" --pod "%COMMONLY_POD_ID%" --dir "%AGENT_DIR%"
  if errorlevel 1 (
    echo ERROR: 'commonly agent init' failed. 1>&2
    exit /b 1
  )
)

rem ----- run the agent (webhook SDK polls the pod) -----
cd /d "%AGENT_DIR%"
echo [commonly-up] running '%AGENT_NAME%' in pod %COMMONLY_POD_ID% (Ctrl+C to stop)

rem Read COMMONLY_TOKEN from .commonly-env into the environment only (never echoed).
for /f "usebackq tokens=1,* delims==" %%A in ("%AGENT_DIR%\.commonly-env") do (
  if "%%A"=="COMMONLY_TOKEN" (
    set "TOK=%%B"
    set "TOK=!TOK:"=!"
    set "TOK=!TOK:'=!"
    set "COMMONLY_TOKEN=!TOK!"
  )
)

call "%PY%" "%AGENT_NAME%.py"
set "rc=%ERRORLEVEL%"
endlocal & endlocal & endlocal & exit /b %rc%