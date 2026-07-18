@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0.."
set "BACKEND=%ROOT%\backend"
set "FRONTEND=%ROOT%\frontend"
set "PORT=8080"
set "HOST=0.0.0.0"
set "MODE=prod"

if /I "%~1"=="dev" set "MODE=dev"
if /I "%~1"=="--dev" set "MODE=dev"
if /I "%~2"=="dev" set "MODE=dev"

call :LoadEnv "%ROOT%\.env"

if not exist "%BACKEND%\venv\Scripts\python.exe" (
  echo Creating Python virtual environment...
  pushd "%BACKEND%"
  python -m venv venv
  if errorlevel 1 (
    echo ERROR: Failed to create venv. Install Python 3.11+ and try again.
    exit /b 1
  )
  call venv\Scripts\activate.bat
  pip install -r requirements.txt
  popd
)

if exist "%ROOT%\.env" (
  copy /Y "%ROOT%\.env" "%BACKEND%\.env" >nul 2>&1
)

call :IsPortInUse %PORT%
if errorlevel 1 (
  echo ERROR: Port %PORT% is already in use. Run scripts\stop-services.bat first.
  exit /b 1
)

if /I "%MODE%"=="dev" (
  call :IsPortInUse 5173
  if errorlevel 1 (
    echo ERROR: Port 5173 is already in use. Run scripts\stop-services.bat first.
    exit /b 1
  )
) else (
  echo Building frontend for production...
  pushd "%FRONTEND%"
  if not exist node_modules (
    echo Installing frontend dependencies...
    call npm install
    if errorlevel 1 (
      echo ERROR: npm install failed.
      popd
      exit /b 1
    )
  )
  call npm run build
  if errorlevel 1 (
    echo ERROR: Frontend build failed.
    popd
    exit /b 1
  )
  popd
)

echo Starting JMeter Agent backend on http://localhost:%PORT% ...
set "QE_SCRIPT=%ROOT%\scripts\disable-console-quickedit.ps1"
start "JMeter Agent Backend" /D "%BACKEND%" cmd /k "call venv\Scripts\activate.bat && powershell -NoProfile -ExecutionPolicy Bypass -File "!QE_SCRIPT!" >nul 2>&1 && echo Tip: Do not click inside this console while the server runs. && uvicorn app.main:app --host %HOST% --port %PORT%"

if /I "%MODE%"=="dev" (
  echo Starting frontend dev server on http://localhost:5173 ...
  start "JMeter Agent Frontend" /D "%FRONTEND%" cmd /k "npm run dev"
  echo.
  echo Services started in development mode:
  echo   Backend : http://localhost:%PORT%
  echo   Frontend: http://localhost:5173
) else (
  echo.
  echo Service started in production mode:
  echo   App: http://localhost:%PORT%
  echo.
  echo Tip: use "start-services.bat dev" to run the Vite dev server as well.
)

echo.
echo Use scripts\stop-services.bat to stop all services.
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
  if /I "!KEY!"=="PORT" set "PORT=!VAL!"
  if /I "!KEY!"=="HOST" set "HOST=!VAL!"
)
exit /b 0

:IsPortInUse
set "CHECK_PORT=%~1"
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":%CHECK_PORT%" ^| findstr "LISTENING"') do (
  if not "%%p"=="0" exit /b 1
)
exit /b 0
