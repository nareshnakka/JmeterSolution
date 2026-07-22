@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0.."
set "BACKEND=%ROOT%\backend"
set "FRONTEND=%ROOT%\frontend"
set "SKIP_BUILD=0"
set "SKIP_DB=0"
set "PYTHON_CMD=python"

if /I "%~1"=="--skip-build" set "SKIP_BUILD=1"
if /I "%~1"=="--skip-db" set "SKIP_DB=1"
if /I "%~2"=="--skip-build" set "SKIP_BUILD=1"
if /I "%~2"=="--skip-db" set "SKIP_DB=1"

echo ========================================
echo  JMeter Agent Server - Installation
echo ========================================
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo NOTE: Run as Administrator to auto-install Python and Node.js for all users.
  echo       Without admin rights, installs may fail or install for current user only.
  echo.
)

echo [0/5] Checking / installing prerequisites ...
call :EnsurePython
if errorlevel 1 exit /b 1

call :EnsureNode
if errorlevel 1 exit /b 1

call :RefreshPath

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found after Node.js installation.
  echo        Close this window, open a new Command Prompt, and run install again.
  exit /b 1
)

echo.
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
echo [1/5] Setting up Python virtual environment ...
if not exist "%BACKEND%\venv\Scripts\python.exe" (
  pushd "%BACKEND%"
  %PYTHON_CMD% -m venv venv
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
python -m pip install --upgrade -r requirements.txt
if errorlevel 1 (
  echo ERROR: pip install failed.
  popd
  exit /b 1
)
python -m pip install --upgrade "azure-identity>=1.19.0"
if errorlevel 1 (
  echo ERROR: Failed to install azure-identity.
  popd
  exit /b 1
)
popd

echo.
if "%SKIP_BUILD%"=="1" (
  echo [2/5] Skipping frontend install/build ^(--skip-build^).
) else (
  echo [2/5] Installing frontend dependencies ...
  pushd "%FRONTEND%"
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    popd
    exit /b 1
  )

  echo.
  echo [3/5] Building frontend ...
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
  echo [4/5] Skipping database initialization ^(--skip-db^).
) else (
  echo [4/5] Initializing SQLite database ...
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
echo [5/5] Installation verification ...
%PYTHON_CMD% --version
node --version
npm --version
if not exist "%FRONTEND%\dist\index.html" (
  if "%SKIP_BUILD%"=="0" (
    echo WARNING: frontend\dist\index.html was not created.
  )
)

echo.
echo ========================================
echo  Installation completed successfully
echo ========================================
echo.
echo Installed / verified:
echo   Python : %PYTHON_CMD%
echo   Node.js: installed
echo   SQLite : backend\jmeter_agent.db
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

:EnsurePython
call :ResolvePython
if not errorlevel 1 exit /b 0

echo Python 3.11+ not found. Installing Python ...
where winget >nul 2>&1
if not errorlevel 1 (
  echo Using winget to install Python 3.12 ...
  winget install -e --id Python.Python.3.12 --scope machine --accept-package-agreements --accept-source-agreements --silent
  if not errorlevel 1 (
    call :RefreshPath
    call :ResolvePython
    if not errorlevel 1 (
      echo Python installed successfully.
      exit /b 0
    )
  )
)

echo winget unavailable or failed. Downloading Python installer ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$ver='3.12.7';" ^
  "$url=\"https://www.python.org/ftp/python/$ver/python-$ver-amd64.exe\";" ^
  "$out=\"$env:TEMP\python-$ver-amd64.exe\";" ^
  "Write-Host \"Downloading $url\";" ^
  "Invoke-WebRequest -Uri $url -OutFile $out;" ^
  "Write-Host 'Running Python installer (silent)...';" ^
  "$p=Start-Process -FilePath $out -ArgumentList '/quiet','InstallAllUsers=1','PrependPath=1','Include_test=0' -Wait -PassThru;" ^
  "if ($p.ExitCode -ne 0) { exit $p.ExitCode }"

call :RefreshPath
call :ResolvePython
if not errorlevel 1 (
  echo Python installed successfully.
  exit /b 0
)

echo ERROR: Python installation failed.
echo        Install Python 3.11+ manually from https://www.python.org/downloads/
echo        Enable "Add python.exe to PATH", then run this script again.
exit /b 1

:EnsureNode
where node >nul 2>&1
if not errorlevel 1 (
  echo Node.js found.
  node --version
  exit /b 0
)

echo Node.js not found. Installing Node.js LTS ...
where winget >nul 2>&1
if not errorlevel 1 (
  echo Using winget to install Node.js LTS ...
  winget install -e --id OpenJS.NodeJS.LTS --scope machine --accept-package-agreements --accept-source-agreements --silent
  if not errorlevel 1 (
    call :RefreshPath
    where node >nul 2>&1
    if not errorlevel 1 (
      echo Node.js installed successfully.
      node --version
      exit /b 0
    )
  )
)

echo winget unavailable or failed. Downloading Node.js LTS installer ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$index=Invoke-RestMethod 'https://nodejs.org/dist/index.json';" ^
  "$lts=($index | Where-Object { $_.lts -ne $false } | Select-Object -First 1).version;" ^
  "$ver=$lts.TrimStart('v');" ^
  "$url=\"https://nodejs.org/dist/$lts/node-$lts-x64.msi\";" ^
  "$out=\"$env:TEMP\node-$ver-x64.msi\";" ^
  "Write-Host \"Downloading $url\";" ^
  "Invoke-WebRequest -Uri $url -OutFile $out;" ^
  "Write-Host 'Running Node.js installer (silent)...';" ^
  "$p=Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', $out, '/quiet', '/norestart' -Wait -PassThru;" ^
  "if ($p.ExitCode -ne 0) { exit $p.ExitCode }"

call :RefreshPath
where node >nul 2>&1
if not errorlevel 1 (
  echo Node.js installed successfully.
  node --version
  exit /b 0
)

echo ERROR: Node.js installation failed.
echo        Install Node.js LTS manually from https://nodejs.org/
echo        Then run this script again.
exit /b 1

:ResolvePython
set "PYTHON_CMD=python"
where python >nul 2>&1
if not errorlevel 1 goto :CheckPythonVersion

where py >nul 2>&1
if not errorlevel 1 (
  py -3.12 -c "import sys" >nul 2>&1
  if not errorlevel 1 (
    set "PYTHON_CMD=py -3.12"
    goto :CheckPythonVersion
  )
  py -3.11 -c "import sys" >nul 2>&1
  if not errorlevel 1 (
    set "PYTHON_CMD=py -3.11"
    goto :CheckPythonVersion
  )
  py -3 -c "import sys" >nul 2>&1
  if not errorlevel 1 (
    set "PYTHON_CMD=py -3"
    goto :CheckPythonVersion
  )
)

call :FindPythonExe
if defined PYTHON_EXE (
  set "PYTHON_CMD=!PYTHON_EXE!"
  goto :CheckPythonVersion
)

exit /b 1

:CheckPythonVersion
%PYTHON_CMD% -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python 3.11 or newer is required.
  exit /b 1
)
%PYTHON_CMD% --version
exit /b 0

:FindPythonExe
set "PYTHON_EXE="
for %%P in (
  "%ProgramFiles%\Python312\python.exe"
  "%ProgramFiles%\Python311\python.exe"
  "%LocalAppData%\Programs\Python\Python312\python.exe"
  "%LocalAppData%\Programs\Python\Python311\python.exe"
) do (
  if exist %%P set "PYTHON_EXE=%%~P"
)
exit /b 0

:RefreshPath
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYSPATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USERPATH=%%b"
if defined SYSPATH set "PATH=%SYSPATH%"
if defined USERPATH set "PATH=%PATH%;%USERPATH%"
set "PATH=%PATH%;%ProgramFiles%\Python312;%ProgramFiles%\Python312\Scripts%"
set "PATH=%PATH%;%ProgramFiles%\Python311;%ProgramFiles%\Python311\Scripts%"
set "PATH=%PATH%;%ProgramFiles%\nodejs"
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
