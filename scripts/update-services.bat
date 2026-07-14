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
echo  JMeter Agent - Force update from repo
echo ========================================
echo  Application code will be replaced.
echo  Your database, test results, and .env are PRESERVED.
echo  Running JMeter tests continue during the brief UI restart.
echo.

echo Stopping services before update...
call "%~dp0stop-services.bat"
echo.

echo Protecting user data before update...
if exist "%BACKEND%\venv\Scripts\python.exe" (
  pushd "%BACKEND%"
  call venv\Scripts\activate.bat
  python "%ROOT%\scripts\backup-user-data.py"
  if errorlevel 1 (
    echo WARNING: Database backup script reported an error. Continuing carefully.
  )
  popd
) else (
  echo WARNING: Python venv not found yet; skipping DB checkpoint/backup helpers.
  if not exist "%ROOT%\data\_db_backups" mkdir "%ROOT%\data\_db_backups" >nul 2>&1
  if exist "%BACKEND%\jmeter_agent.db" (
    for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"
    mkdir "%ROOT%\data\_db_backups\!STAMP!" >nul 2>&1
    copy /Y "%BACKEND%\jmeter_agent.db" "%ROOT%\data\_db_backups\!STAMP!\jmeter_agent.db" >nul
    echo Copied backend\jmeter_agent.db to data\_db_backups\!STAMP!\
  )
)

echo.
echo NOTE: These paths are never deleted by update:
echo   - backend\jmeter_agent.db  ^(SQLite database / test records^)
echo   - data\                   ^(run artifacts, JTLs, archives, DB backups^)
echo   - .env                    ^(local settings^)
echo.

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if not defined BRANCH set "BRANCH=main"

echo Fetching latest changes from origin/%BRANCH% ...
git fetch origin %BRANCH%
if errorlevel 1 (
  echo ERROR: git fetch failed.
  popd
  exit /b 1
)

echo Resetting application code to origin/%BRANCH% ...
git reset --hard origin/%BRANCH%
if errorlevel 1 (
  echo ERROR: git reset failed.
  popd
  exit /b 1
)

rem -fd removes untracked files, but NOT gitignored paths (*.db, data/, .env, venv, node_modules).
rem Extra -e excludes add belt-and-suspenders protection for user data.
echo Cleaning untracked build artifacts ^(user data excluded^) ...
git clean -fd -e "*.db" -e "*.db-wal" -e "*.db-shm" -e "data" -e ".env" -e "venv" -e "backend/venv" -e "frontend/node_modules" -e "frontend/dist" -e "backend/jmeter_agent.db" -e "**/jmeter_agent.db"
if errorlevel 1 (
  echo ERROR: git clean failed.
  popd
  exit /b 1
)

for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do set "HEAD=%%h"
echo Now at commit !HEAD!

if not exist "%BACKEND%\jmeter_agent.db" (
  echo.
  echo WARNING: backend\jmeter_agent.db was not found after update.
  echo If you have a backup under data\_db_backups, restore it before starting the server.
) else (
  echo Database present after update: backend\jmeter_agent.db
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
echo User database and test run artifacts were left untouched.

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
