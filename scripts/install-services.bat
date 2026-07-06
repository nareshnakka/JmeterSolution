@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0.."
set "BACKEND=%ROOT%\backend"
set "FRONTEND=%ROOT%\frontend"
set "SKIP_BUILD=0"
set "SKIP_DB=0"

if /I "%~1"=="--skip-build" set "SKIP_BUILD=1"
if /I "%~1"=="--skip-db" set "SKIP_DB=1"
if /I "%~2"=="--skip-build" set "SKIP_BUILD=1"
if /I "%~2"=="--skip-db" set "SKIP_DB=1"

echo ========================================
echo  JMeter Agent Server - Installation
echo ========================================
echo.

call :RequireCommand python "Python 3.11+"
call :RequireCommand node "Node.js 18+"
call :RequireCommand npm "npm (included with Node.js)"

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python 3.11 or newer is required.
  exit /b 1
)

if not exist "%ROOT%\.env" (
  if exist "%ROOT%\.env.example" (
    echo Creating .env from .env.example ...
    copy /Y "%ROOT%\.env.example" "%ROOT%\.env" >nul
    echo IMPORTANT: Edit %ROOT%\.env and set JMETER_HOME and DATA_ROOT for this server.
    echo.
  ) else (
    echo ERROR: .env.example not found.
    exit /b 1
  )
) else (
  echo Using existing .env
)

copy /Y "%ROOT%\.env" "%BACKEND%\.env" >nul 2>&1

call :LoadEnv "%ROOT%\.env"

if defined DATA_ROOT (
  if not exist "%DATA_ROOT%" (
    echo Creating data folder: %DATA_ROOT%
    mkdir "%DATA_ROOT%" 2>nul
  )
)

if defined JMETER_HOME (
  if exist "%JMETER_HOME%\bin\jmeter.bat" (
    echo JMeter found: %JMETER_HOME%
  ) else (
    echo WARNING: JMETER_HOME is set but jmeter.bat was not found.
    echo          Update JMETER_HOME in .env before running tests.
  )
) else (
  echo WARNING: JMETER_HOME is not set in .env.
)

echo.
echo [1/4] Setting up Python virtual environment ...
if not exist "%BACKEND%\venv\Scripts\python.exe" (
  pushd "%BACKEND%"
  python -m venv venv
  if errorlevel 1 (
    echo ERROR: Failed to create virtual environment.
    popd
    exit /b 1
  )
  popd
) else (
  echo Virtual environment already exists.
)

pushd "%BACKEND%"
call venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
  echo ERROR: pip install failed.
  popd
  exit /b 1
)
popd

echo.
if "%SKIP_BUILD%"=="1" (
  echo [2/4] Skipping frontend install/build ^(--skip-build^).
) else (
  echo [2/4] Installing frontend dependencies ...
  pushd "%FRONTEND%"
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    popd
    exit /b 1
  )

  echo.
  echo [3/4] Building frontend ...
  call npm run build
  if errorlevel 1 (
    echo ERROR: Frontend build failed.
    popd
    exit /b 1
  )
  popd
)

echo.
if "%SKIP_DB%"=="1" (
  echo [4/4] Skipping database initialization ^(--skip-db^).
) else (
  echo [4/4] Initializing SQLite database ...
  pushd "%BACKEND%"
  call venv\Scripts\activate.bat
  python -c "from app.database import init_db; init_db(); print('Database tables created successfully.')"
  if errorlevel 1 (
    echo ERROR: Database initialization failed.
    popd
    exit /b 1
  )
  popd
)

echo.
echo ========================================
echo  Installation completed successfully
echo ========================================
echo.
echo Next steps:
echo   1. Edit %ROOT%\.env
echo      - JMETER_HOME  = path to Apache JMeter
echo      - DATA_ROOT    = folder for test data and run artifacts
echo      - PORT         = server port ^(default 8080^)
echo   2. Start the server:
echo        scripts\start-services.bat
echo   3. Open in browser:
echo        http://localhost:%PORT%
echo.
echo Other scripts:
echo   scripts\stop-services.bat    Stop all services
echo   scripts\update-services.bat  Pull latest code and update
echo.
exit /b 0

:RequireCommand
where %~1 >nul 2>&1
if errorlevel 1 (
  echo ERROR: %~1 is not installed or not on PATH. Install %~2 and try again.
  exit /b 1
)
exit /b 0

:LoadEnv
set "ENV_FILE=%~1"
if not exist "%ENV_FILE%" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%ENV_FILE%") do (
  set "KEY=%%a"
  set "VAL=%%b"
  if defined VAL (
    if "!VAL:~0,1!"==" " set "VAL=!VAL:~1!"
  )
  if /I "!KEY!"=="JMETER_HOME" set "JMETER_HOME=!VAL!"
  if /I "!KEY!"=="DATA_ROOT" set "DATA_ROOT=!VAL!"
  if /I "!KEY!"=="PORT" set "PORT=!VAL!"
)
if not defined PORT set "PORT=8080"
exit /b 0
