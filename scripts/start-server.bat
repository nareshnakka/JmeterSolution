@echo off
set ROOT=%~dp0..
cd /d %ROOT%\frontend

if not exist node_modules (
  echo Installing frontend dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Building frontend...
call npm run build
if errorlevel 1 (
  echo ERROR: Frontend build failed.
  exit /b 1
)

cd /d %ROOT%\backend

if not exist venv (
  python -m venv venv
  call venv\Scripts\activate.bat
  pip install -r requirements.txt
) else (
  call venv\Scripts\activate.bat
)

if exist ..\.env (
  copy /Y ..\.env .env >nul 2>&1
)

REM Prevent console click-select from freezing uvicorn (Windows Quick Edit).
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\disable-console-quickedit.ps1" >nul 2>&1

echo Starting JMeter Agent Server on http://localhost:8080
echo Tip: Do not click inside this window while the server runs — use the browser UI instead.
uvicorn app.main:app --host 0.0.0.0 --port 8080 --timeout-keep-alive 75
