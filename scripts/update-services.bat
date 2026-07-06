@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0.."
set "BACKEND=%ROOT%\backend"
set "FRONTEND=%ROOT%\frontend"
set "RESTART=1"

if /I "%~1"=="--no-restart" set "RESTART=0"
if /I "%~2"=="--no-restart" set "RESTART=0"

pushd "%ROOT%"
if errorlevel 1 (
  echo ERROR: Cannot access project root: %ROOT%
  exit /b 1
)

if not exist ".git" (
  echo ERROR: This folder is not a git repository.
  echo Clone the project first:
  echo   git clone https://github.com/nareshnakka/JmeterSolution.git
  popd
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: git is not installed or not on PATH.
  popd
  exit /b 1
)

echo ========================================
echo  JMeter Agent - Update from repository
echo ========================================
echo.

echo Stopping services before update...
call "%~dp0stop-services.bat"
echo.

git status --porcelain 2>nul | findstr /V "^??" | findstr "." >nul
if not errorlevel 1 (
  echo WARNING: You have local changes. git pull may fail or merge.
  echo          Commit or stash changes first, or reset local edits.
  echo.
)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if not defined BRANCH set "BRANCH=main"

echo Fetching latest changes from origin/%BRANCH% ...
git fetch origin %BRANCH%
if errorlevel 1 (
  echo ERROR: git fetch failed.
  popd
  exit /b 1
)

echo Pulling latest changes ...
git pull --ff-only origin %BRANCH%
if errorlevel 1 (
  echo ERROR: git pull failed. Resolve conflicts and run update again.
  popd
  exit /b 1
)

echo.
echo Updating Python dependencies ...
if not exist "%BACKEND%\venv\Scripts\python.exe" (
  echo Creating Python virtual environment...
  pushd "%BACKEND%"
  python -m venv venv
  if errorlevel 1 (
    echo ERROR: Failed to create venv.
    popd
    popd
    exit /b 1
  )
  popd
)

pushd "%BACKEND%"
call venv\Scripts\activate.bat
pip install -r requirements.txt
if errorlevel 1 (
  echo ERROR: pip install failed.
  popd
  popd
  exit /b 1
)
popd

if exist "%ROOT%\.env" (
  copy /Y "%ROOT%\.env" "%BACKEND%\.env" >nul 2>&1
)

echo.
echo Updating frontend dependencies and building ...
pushd "%FRONTEND%"
if not exist node_modules (
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    popd
    popd
    exit /b 1
  )
) else (
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    popd
    popd
    exit /b 1
  )
)

call npm run build
if errorlevel 1 (
  echo ERROR: Frontend build failed.
  popd
  popd
  exit /b 1
)
popd

echo.
echo Update completed successfully.

if "%RESTART%"=="1" (
  echo.
  echo Restarting services ...
  call "%~dp0start-services.bat"
) else (
  echo.
  echo Services were not restarted. Run scripts\start-services.bat when ready.
)

popd
exit /b 0
